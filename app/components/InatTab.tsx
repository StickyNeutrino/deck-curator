import { useCallback, useState } from "react";
import type { Project } from "~/lib/types";
import { makeSpecies } from "~/lib/types";
import { candidatePhotos, pickDistinct, downloadPhoto, slotFromInatPhoto } from "~/lib/resolve";
import { inatGet, type InatTaxon } from "~/lib/inat";
import { slugify } from "~/lib/ids";
import { putFile } from "~/lib/store";

/** iNat iconic_taxon_id → friendly filter names (ids verified against the
 *  API: 3 Aves, 40151 Mammalia, 26036 Reptilia, 20978 Amphibia, 47178
 *  Actinopterygii, 47158 Insecta, 47119 Arachnida, 47126 Plantae, 47170 Fungi). */
const ICONIC_TAXON_NAMES: Record<number, string> = {
  3: "Birds",
  40151: "Mammals",
  26036: "Reptiles",
  20978: "Amphibians",
  47178: "Fish",
  47158: "Insects",
  47119: "Arachnids",
  47126: "Plants",
  47170: "Fungi",
};

function taxonIconicName(t: InatTaxon): string {
  const iconicId = (t as unknown as { iconic_taxon_id?: number }).iconic_taxon_id;
  return (iconicId !== undefined && ICONIC_TAXON_NAMES[iconicId]) || (t as unknown as { iconic_taxon_name?: string }).iconic_taxon_name || "";
}

/**
 * Tab 2: iNaturalist search. A lat/lng radius (or worldwide) + optional taxon
 * filter lists matching taxa; adding one downloads its best CC photos into
 * the project with full credits. Photos per card sets the card layout.
 */

interface TaxonResult {
  id: number;
  name: string;
  common: string | null;
  count: number;
}

export function InatTab({
  project,
  onChange,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
}) {
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("10");
  const [taxonQuery, setTaxonQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TaxonResult[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photosPerCard, setPhotosPerCard] = useState(3);
  const [addingIds, setAddingIds] = useState<Set<number>>(new Set());

  const search = useCallback(async () => {
    if (!taxonQuery.trim() && !(lat && lng)) {
      setError("Enter coordinates (and/or a taxon filter) to search.");
      return;
    }
    setSearching(true);
    setError(null);
    setStatus("Searching iNaturalist…");
    try {
      // iNat's taxa endpoint can't filter geographically, so aggregate the
      // taxa from observations recorded inside the circle — that's the
      // "what lives here" list curators want.
      const json = await inatGet<{
        results: Array<{
          taxon?: InatTaxon;
          id: number;
        }>;
      }>("observations", {
        lat: lat && lng ? lat : undefined,
        lng: lat && lng ? lng : undefined,
        radius: lat && lng ? radius || "10" : undefined,
        per_page: 100,
        photos: true,
        order_by: "observed_on",
      });
      const counts = new Map<number, { taxon: InatTaxon; count: number }>();
      for (const obs of json.results) {
        const t = obs.taxon;
        if (!t || !t.is_active || t.rank !== "species") continue;
        const needle = taxonQuery.trim().toLowerCase();
        if (
          needle &&
          !t.name.toLowerCase().includes(needle) &&
          !(t.preferred_common_name ?? "").toLowerCase().includes(needle) &&
          !taxonIconicName(t).toLowerCase().includes(needle)
        ) {
          continue;
        }
        const entry = counts.get(t.id);
        if (entry) entry.count++;
        else counts.set(t.id, { taxon: t, count: 1 });
      }
      const found = [...counts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 30)
        .map(({ taxon, count }) => ({
          id: taxon.id,
          name: taxon.name,
          common: taxon.preferred_common_name ?? null,
          count,
        }));
      setResults(found);
      setStatus(
        found.length
          ? `Found ${found.length} species observed in the area — add the ones you want.`
          : "No species matched. Try a broader taxon filter or a bigger radius.",
      );
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [lat, lng, radius, taxonQuery]);

  const addResult = useCallback(
    async (result: TaxonResult) => {
      setStatus(`Fetching photos for ${result.name}…`);
      try {
        const scope =
          lat && lng
            ? { lat: Number(lat), lng: Number(lng), radiusKm: Number(radius) || 10 }
            : undefined;
        const candidates = await candidatePhotos(result.id, scope);
        const picked = pickDistinct(candidates, photosPerCard);
        const entry = makeSpecies({
          category: project.categories[0]?.id ?? "",
          sciName: result.name,
          commonName: result.common ?? "",
          taxonId: result.id,
          inatResolved: true,
          layout: photosPerCard === 1 ? "photo-single" : "photo-trio",
        });
        for (let i = 0; i < picked.length; i++) {
          const pick = picked[i];
          const fileKey = `${slugify(result.name)}-${i === 0 ? "main" : `secondary-${i}`}.jpg`;
          try {
            const blob = await downloadPhoto(pick.photo);
            await putFile(project.id, fileKey, blob);
            entry.photos.push(
              slotFromInatPhoto(pick.photo, pick.obs, i === 0 ? "main" : "secondary", fileKey),
            );
          } catch {
            // A failed download just means fewer photos on the card.
          }
        }
        onChange((d) => {
          d.species.push(entry);
        });
        setStatus(
          `Added ${result.name}${entry.photos.length ? ` with ${entry.photos.length} photo(s)` : " (no CC photos found)"}.`,
        );
      } catch (err) {
        setStatus(`Could not add ${result.name}: ${err instanceof Error ? err.message : err}`);
      }
    },
    [lat, lng, radius, photosPerCard, project.id, project.categories, onChange],
  );

  return (
    <div data-testid="inat-tab">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="text-sm">
          <span className="label">Latitude</span>
          <input
            className="field"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="32.7157"
            inputMode="decimal"
            data-testid="inat-lat"
          />
        </label>
        <label className="text-sm">
          <span className="label">Longitude</span>
          <input
            className="field"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            placeholder="-117.1611"
            inputMode="decimal"
            data-testid="inat-lng"
          />
        </label>
        <label className="text-sm">
          <span className="label">Radius (km)</span>
          <input
            className="field"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            inputMode="decimal"
            data-testid="inat-radius"
          />
        </label>
        <label className="text-sm">
          <span className="label">Taxon filter (optional)</span>
          <input
            className="field"
            value={taxonQuery}
            onChange={(e) => setTaxonQuery(e.target.value)}
            placeholder="plants, Aves, Dudleya…"
            data-testid="inat-taxon-query"
          />
        </label>
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Search lists the most-observed species in the circle. Only Creative Commons photos (no ND,
        no all-rights-reserved) are offered, matching the app's license policy; every card carries
        the photographer credit.
      </p>
      <div className="flex gap-2 items-center">
        <button className="btn-primary" onClick={() => void search()} disabled={searching} data-testid="inat-search">
          {searching ? "Searching…" : "Search"}
        </button>
        <label className="text-sm ml-auto">
          Photos per card{" "}
          <select
            className="field !w-auto !py-1 inline-block"
            value={photosPerCard}
            onChange={(e) => setPhotosPerCard(Number(e.target.value))}
            data-testid="inat-photos-per-card"
          >
            <option value={1}>1 (single)</option>
            <option value={2}>up to 2</option>
            <option value={3}>up to 3 (trio)</option>
          </select>
        </label>
      </div>
      {error && (
        <p className="text-sm mt-2" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {status && (
        <p className="text-sm mt-2" data-testid="inat-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
      <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }} data-testid="inat-results">
        {results.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2">
            <div>
              <span className="font-medium">{r.common ?? r.name}</span>{" "}
              {r.common && (
                <span className="italic text-sm" style={{ color: "var(--muted)" }}>
                  {r.name}
                </span>
              )}
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {r.count.toLocaleString()} observations
              </div>
            </div>
            <button className="btn-secondary text-xs" onClick={() => void addResult(r)} data-testid={`add-inat-${r.id}`}>
              + Add
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
