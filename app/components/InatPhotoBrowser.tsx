import { useCallback, useEffect, useState } from "react";
import type { PhotoCandidate } from "~/lib/resolve";
import { candidatePhotos, pickDistinct, downloadPhoto, slotFromInatPhoto } from "~/lib/resolve";
import type { SpeciesEntry } from "~/lib/types";
import { putFile } from "~/lib/store";
import { slugify } from "~/lib/ids";

/**
 * iNaturalist photo browser for one species: shows CC-licensed observation
 * photos (most-voted first, scoped to the project's locale when known), and
 * lets the curator pin specific photos onto the card — main or secondary.
 * Auto-pick fills the remaining slots with the best distinct-observer set.
 */

export function InatPhotoBrowser({
  species,
  projectId,
  onChange,
}: {
  species: SpeciesEntry;
  projectId: string;
  onChange: (f: (d: SpeciesEntry) => void) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PhotoCandidate[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const query = species.sciName || species.commonName;

  const load = useCallback(async () => {
    if (!query) return;
    setLoading(true);
    setStatus(null);
    try {
      const { resolveTaxon } = await import("~/lib/resolve");
      const taxon = species.taxonId
        ? { taxonId: species.taxonId }
        : await resolveTaxon(query).then((t) => (t ? { taxonId: t.taxonId } : null));
      if (!taxon) {
        setCandidates([]);
        setStatus(`“${query}” didn't resolve on iNaturalist.`);
        return;
      }
      const found = await candidatePhotos(taxon.taxonId);
      setCandidates(found);
      setPickedIds(new Set());
      setStatus(
        found.length
          ? `${found.length} CC-licensed photos found — click to add, or use Auto-pick.`
          : "No CC-licensed photos found for this species.",
      );
    } catch (err) {
      setStatus(`iNaturalist error: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  }, [query, species.taxonId]);

  useEffect(() => {
    void load();
    // Reload when the species identity changes, not on every keystroke.
  }, [species.taxonId, query]);

  const addPhoto = useCallback(
    async (cand: PhotoCandidate) => {
      const index = species.photos.length;
      const base = slugify(species.commonName || species.sciName || "photo");
      const fileKey = `${base}-${index === 0 ? "main" : `secondary-${index}`}.jpg`;
      try {
        const blob = await downloadPhoto(cand.photo);
        await putFile(projectId, fileKey, blob);
      } catch (err) {
        setStatus(`Could not download photo: ${err instanceof Error ? err.message : err}`);
        return;
      }
      onChange((d) => {
        const role: "main" | "secondary" = d.photos.length === 0 ? "main" : "secondary";
        d.photos.push(slotFromInatPhoto(cand.photo, cand.obs, role, fileKey));
      });
      setPickedIds((prev) => new Set(prev).add(String(cand.photo.id)));
      setStatus("Photo added.");
    },
    [species, projectId, onChange],
  );

  const autoPick = useCallback(async () => {
    const slotsWanted = species.layout === "photo-single" ? 1 : 3;
    const remaining = slotsWanted - species.photos.length;
    if (remaining <= 0) {
      setStatus("Card already has its photos.");
      return;
    }
    const picked = pickDistinct(candidates, remaining);
    let index = species.photos.length;
    for (const cand of picked) {
      const base = slugify(species.commonName || species.sciName || "photo");
      const fileKey = `${base}-${index === 0 && species.photos.length === 0 ? "main" : `secondary-${index}`}.jpg`;
      try {
        const blob = await downloadPhoto(cand.photo);
        await putFile(projectId, fileKey, blob);
        const role = species.photos.length === 0 && index === 0 ? "main" : "secondary";
        onChange((d) => {
          d.photos.push(slotFromInatPhoto(cand.photo, cand.obs, role, fileKey));
        });
        setPickedIds((prev) => new Set(prev).add(String(cand.photo.id)));
        index++;
      } catch {
        // Skip failed downloads.
      }
    }
    setStatus(index ? `Added ${index} photo(s).` : "Could not download any photo.");
  }, [candidates, species, projectId, onChange]);

  return (
    <section className="mt-10 border-t pt-6" data-testid="inat-photo-browser">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-semibold">iNaturalist photos</h2>
        <button className="btn-secondary text-sm" onClick={() => void load()} disabled={loading || !query}>
          {loading ? "Loading…" : "Search"}
        </button>
        <button
          className="btn-secondary text-sm"
          onClick={() => void autoPick()}
          disabled={loading || !candidates.length}
          data-testid="auto-pick"
        >
          Auto-pick
        </button>
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Creative Commons photos only (the app's policy: no ND, no all-rights-reserved). The
        photographer's credit is attached automatically and exported into the deck.
      </p>
      {status && (
        <p className="text-sm mb-2" data-testid="inat-browser-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
      <ul className="flex flex-wrap gap-3" data-testid="inat-photos">
        {candidates.map((cand) => {
          const picked = pickedIds.has(String(cand.photo.id));
          return (
            <li key={String(cand.photo.id)} className="w-44">
              <button
                className={`block w-full rounded overflow-hidden border-2 ${pickedIds.has(String(cand.photo.id)) ? "border-[var(--accent)]" : "border-transparent"}`}
                onClick={() => void addPhoto(cand)}
                title={`Add photo by ${cand.obs.user?.name || cand.obs.user?.login} (${cand.photo.license_code})`}
                data-testid={`inat-photo-${cand.photo.id}`}
              >
                <img src={cand.photo.url.replace(/\/(square|thumb|small|medium)\./, "/medium.")} alt="" loading="lazy" className="aspect-square object-cover w-full" />
              </button>
              <div className="text-xs mt-1 truncate">
                © {cand.obs.user?.name || cand.obs.user?.login || "unknown"}
              </div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {(cand.photo.license_code ?? "").toUpperCase()} · {cand.obs.quality_grade}
              </div>
            </li>
          );
        })}
        {loading && <li className="text-sm" style={{ color: "var(--muted)" }}>Loading photos…</li>}
      </ul>
    </section>
  );
}
