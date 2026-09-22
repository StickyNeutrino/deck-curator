import { useCallback, useMemo, useState } from "react";
import type { Project, SpeciesEntry } from "~/lib/types";
import { makeSpecies } from "~/lib/types";
import { candidatePhotos, pickDistinct, fetchTaxonDetail } from "~/lib/resolve";
import { acquireMediaSlot } from "~/lib/media";
import { isVideoMedia } from "~/lib/inat";
import { categoryIdForIconic, labelForCategoryId } from "~/lib/categories";
import { inatGet, type InatTaxon } from "~/lib/inat";
import { slugify } from "~/lib/ids";
import { putFile } from "~/lib/store";
import { LocationPicker } from "~/components/LocationPicker";
import type { DeckLocation } from "~/lib/types";

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
  const iconicId = t.iconic_taxon_id;
  return (iconicId !== undefined && ICONIC_TAXON_NAMES[iconicId]) || (t as unknown as { iconic_taxon_name?: string }).iconic_taxon_name || "";
}

/**
 * Tab 2: iNaturalist search. A lat/lng radius (or worldwide) + optional taxon
 * filter lists the top species observed in the area (cap adjustable up to
 * 200); "Add all" bulk-adds them with a progress bar, and "cards per species"
 * creates N photo-distinct cards per species for anti-memorization variants.
 * Species are filed into Plants/Fungi/Animals automatically from iNat's
 * taxonomy, and family/scientific details are enriched from the same API.
 */

interface TaxonResult {
  id: number;
  name: string;
  common: string | null;
  count: number;
  iconicTaxonId: number | null;
}

/** iNat photo ids already used by these entries (slot ids look like `inat:123`). */
function photoIdsInDeck(entries: SpeciesEntry[]): Set<string> {
  const out = new Set<string>();
  for (const s of entries) {
    for (const p of s.photos) {
      if (p.id.startsWith("inat:")) out.add(p.id.slice(5));
    }
  }
  return out;
}

const RESULT_LIMITS = [10, 30, 50, 100, 200] as const;

export function InatTab({
  project,
  onChange,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
}) {
  // Scope: a geocoded/picked location (initialized from the deck's own
  // location when it has one) or worldwide when unset.
  const [loc, setLoc] = useState<DeckLocation | undefined>(project.location);
  const [taxonQuery, setTaxonQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TaxonResult[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photosPerCard, setPhotosPerCard] = useState(3);
  const [includeVideos, setIncludeVideos] = useState(false);
  const [resultLimit, setResultLimit] = useState<number>(30);
  const [cardsPerSpecies, setCardsPerSpecies] = useState(1);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number; label: string } | null>(null);

  /** Existing cards per taxon — drives the "in deck" badges and "+ Another". */
  const existing = useMemo(() => {
    const byTaxon = new Map<number, SpeciesEntry[]>();
    const bySci = new Map<string, SpeciesEntry[]>();
    for (const s of project.species) {
      if (s.taxonId != null) {
        const list = byTaxon.get(s.taxonId) ?? [];
        list.push(s);
        byTaxon.set(s.taxonId, list);
      }
      if (s.sciName) {
        const key = s.sciName.toLowerCase();
        const list = bySci.get(key) ?? [];
        list.push(s);
        bySci.set(key, list);
      }
    }
    return { byTaxon, bySci };
  }, [project.species]);

  const cardsFor = useCallback(
    (r: TaxonResult): SpeciesEntry[] =>
      existing.byTaxon.get(r.id) ?? existing.bySci.get(r.name.toLowerCase()) ?? [],
    [existing],
  );

  const search = useCallback(async () => {
    if (!taxonQuery.trim() && !(loc?.lat != null && loc?.lng != null)) {
      setError("Enter coordinates (and/or a taxon filter) to search.");
      return;
    }
    setSearching(true);
    setError(null);
    setStatus("Searching iNaturalist…");
    try {
      // iNat's taxa endpoint can't filter geographically, so aggregate taxa
      // from observations inside the circle. per_page goes up to 200; a second
      // page is fetched when the species cap needs more observations to reach.
      const want = resultLimit;
      const counts = new Map<number, { taxon: InatTaxon; count: number }>();
      const needle = taxonQuery.trim().toLowerCase();
      const maxPages = Math.ceil(want / 40) + 1; // ~40-60 species per 100 observations typically
      for (let page = 1; page <= Math.min(4, maxPages); page++) {
        const json = await inatGet<{
          results: Array<{ taxon?: InatTaxon; id: number }>;
        }>("observations", {
          lat: loc?.lat != null && loc?.lng != null ? loc.lat : undefined,
          lng: loc?.lat != null && loc?.lng != null ? loc.lng : undefined,
          radius: loc?.lat != null && loc?.lng != null ? loc.radiusKm || 10 : undefined,
          per_page: 200,
          page,
          photos: true,
          order_by: "observed_on",
        });
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
        if (counts.size >= want || json.results.length < 200) break;
      }
      const found = [...counts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, want)
        .map(({ taxon, count }) => ({
          id: taxon.id,
          name: taxon.name,
          common: taxon.preferred_common_name ?? null,
          count,
          iconicTaxonId: taxon.iconic_taxon_id ?? null,
        }));
      setResults(found);
      setStatus(
        found.length
          ? `Found ${found.length} species observed in the area — add them individually or all at once.`
          : "No species matched. Try a broader taxon filter or a bigger radius.",
      );
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [loc, taxonQuery, resultLimit]);

  /**
   * Add one search result as a card. When the species is already in the deck
   * this creates an extra card ("variant"); `exclude` keeps its photos
   * distinct from the cards already in the deck. Family/scientific details
   * are enriched from the taxon detail API (cached), and the species is
   * filed into Plants/Fungi/Animals from iNat's taxonomy.
   */
  const addResult = useCallback(
    async (result: TaxonResult, opts: { quiet?: boolean; exclude?: Set<string>; category?: string } = {}): Promise<SpeciesEntry | null> => {
      setBusyName(result.name);
      try {
        const photoScope =
          loc?.lat != null && loc?.lng != null
            ? { lat: loc.lat, lng: loc.lng, radiusKm: loc.radiusKm || 10 }
            : undefined;
        const candidates = await candidatePhotos(result.id, photoScope, opts.exclude, { includeVideos });
        const picked = pickDistinct(candidates, photosPerCard);
        const existingCards = cardsFor(result);

        // Scientific enrichment + category: one cached API call.
        let category = opts.category;
        let familyLatin: string | undefined;
        let familyCommon: string | undefined;
        let iconicTaxonId = result.iconicTaxonId;
        try {
          const detail = await fetchTaxonDetail(result.id);
          if (detail) {
            familyLatin = detail.familyLatin ?? undefined;
            familyCommon = detail.familyCommon ?? undefined;
            iconicTaxonId = detail.iconicTaxonId ?? iconicTaxonId;
          }
        } catch {
          // iNat hiccup — the card still carries name + photos.
        }
        if (!category) {
          category = categoryIdForIconic(project, iconicTaxonId);
        }

        const entry = makeSpecies({
          category,
          sciName: result.name,
          commonName: result.common ?? "",
          taxonId: result.id,
          inatResolved: true,
          familyLatin,
          familyCommon,
          layout: photosPerCard === 1 ? "photo-single" : "photo-trio",
        });
        const base = slugify(result.name);
        for (let i = 0; i < picked.length; i++) {
          const pick = picked[i];
          try {
            const slot = await acquireMediaSlot(pick.photo, pick.obs, {
              role: i === 0 ? "main" : "secondary",
              base,
              includeAnimated: includeVideos,
              projectId: project.id,
            });
            if (slot) entry.photos.push(slot);
          } catch {
            // A failed download just means fewer photos on the card.
          }
        }
        onChange((d) => {
          if (!d.categories.some((c) => c.id === entry.category)) {
            d.categories.push({ id: entry.category, label: labelForCategoryId(entry.category) });
          }
          d.species.push(entry);
        });
        if (!opts.quiet) {
          setStatus(
            existingCards.length
              ? `Added another card for ${result.name}${entry.photos.length ? ` with ${entry.photos.length} new photo(s)` : " (no CC photos found)"}.`
              : `Added ${result.name}${entry.photos.length ? ` with ${entry.photos.length} photo(s)` : " (no CC photos found)"}.`,
          );
        }
        return entry;
      } catch (err) {
        if (!opts.quiet) {
          setStatus(`Could not add ${result.name}: ${err instanceof Error ? err.message : err}`);
        }
        return null;
      } finally {
        setBusyName(null);
      }
    },
    [loc, photosPerCard, includeVideos, project.id, project.categories, cardsFor, onChange],
  );

  /** Add every listed species (cardsPerSpecies cards each, photo-distinct). */
  const addAll = useCallback(async () => {
    const fresh = results.filter((r) => cardsFor(r).length === 0);
    if (!fresh.length) {
      setStatus("Every species in this search is already in the deck.");
      return;
    }
    const total = fresh.length * cardsPerSpecies;
    setBulk({ done: 0, total, label: "" });
    // Track photo usage locally: the loop's project prop is a snapshot, so
    // exclusions for species added earlier in this run are kept here.
    const usedByTaxon = new Map<number, Set<string>>();
    for (const r of results) {
      usedByTaxon.set(r.id, photoIdsInDeck(cardsFor(r)));
    }
    let added = 0;
    let failed = 0;
    let done = 0;
    for (const r of fresh) {
      const used = usedByTaxon.get(r.id)!;
      for (let c = 0; c < cardsPerSpecies; c++) {
        done++;
        setBulk({ done: done - 1, total, label: `${r.common ?? r.name}${cardsPerSpecies > 1 ? ` (card ${c + 1}/${cardsPerSpecies})` : ""}` });
        setStatus(`Adding ${done}/${total}: ${r.common ?? r.name}…`);
        const entry = await addResult(r, { quiet: true, exclude: used });
        if (entry) {
          added++;
          for (const p of entry.photos) {
            if (p.id.startsWith("inat:")) used.add(p.id.slice(5));
          }
        } else {
          failed++;
        }
      }
    }
    setBulk(null);
    setStatus(
      `Added ${added} of ${total} cards${failed ? ` (${failed} failed)` : ""}.` +
        (cardsPerSpecies > 1 ? " Extra cards export as “Name (2)”, “Name (3)”… with different photos." : ""),
    );
    if (failed) console.warn(`${failed} iNat adds failed during Add all`);
  }, [results, cardsFor, addResult, cardsPerSpecies]);

  const freshCount = results.filter((r) => cardsFor(r).length === 0).length;

  return (
    <div data-testid="inat-tab">
      <div className="mb-3">
        <span className="label">Where to search — pick a place, address, or point on the map</span>
        <LocationPicker
          value={loc}
          onChange={(next: DeckLocation | undefined) => {
            setLoc(next);
            // The deck's own location follows the search scope when the user
            // hasn't set one yet — these are almost always the same place.
            if (next && !project.location) {
              onChange((d) => {
                d.location = next;
              });
            }
          }}
          showRadius
        />
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="text-sm">
          <span className="label">Taxon filter (optional)</span>
          <input
            className="field"
            value={taxonQuery}
            onChange={(e) => setTaxonQuery(e.target.value)}
            placeholder="plants, birds, Dudleya…"
            data-testid="inat-taxon-query"
          />
        </label>
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Search lists the most-observed species in the circle, filed automatically into
        Plants / Fungi / Animals from iNaturalist's taxonomy. Only Creative Commons photos (no ND,
        no all-rights-reserved) are offered; every card carries the photographer credit.
      </p>
      <div className="flex gap-2 items-center flex-wrap">
        <button className="btn-primary" onClick={() => void search()} disabled={searching || bulk !== null} data-testid="inat-search">
          {searching ? "Searching…" : "Search"}
        </button>
        {results.length > 0 && (
          <button
            className="btn-secondary"
            onClick={() => void addAll()}
            disabled={bulk !== null || freshCount === 0}
            data-testid="inat-add-all"
          >
            {bulk
              ? `Adding…`
              : freshCount === 0
                ? "All added ✓"
                : `Add all (${freshCount} species${cardsPerSpecies > 1 ? ` → ${freshCount * cardsPerSpecies} cards` : ""})`}
          </button>
        )}
        <label className="text-sm ml-auto">
          Limit{" "}
          <select
            className="field !w-auto !py-1 inline-block"
            value={resultLimit}
            onChange={(e) => setResultLimit(Number(e.target.value))}
            data-testid="inat-limit"
            title="Maximum number of species listed per search"
          >
            {RESULT_LIMITS.map((n) => (
              <option key={n} value={n}>top {n}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Cards per species{" "}
          <select
            className="field !w-auto !py-1 inline-block"
            value={cardsPerSpecies}
            onChange={(e) => setCardsPerSpecies(Number(e.target.value))}
            data-testid="inat-cards-per-species"
            title="Multiple cards per species, each with different photos — harder to memorize"
          >
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
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
        <label
          className="inline-flex items-center gap-2 text-sm cursor-pointer"
          title="Allow animated GIFs and video clips as card media. Cards display a still frame you pick; the clip is stored for playback."
        >
          <input
            type="checkbox"
            checked={includeVideos}
            onChange={(e) => setIncludeVideos(e.target.checked)}
            data-testid="inat-include-videos"
          />
          Include animated GIFs &amp; videos
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
      {bulk && (
        <div className="mt-2" data-testid="bulk-progress">
          <div className="flex justify-between text-xs mb-1" style={{ color: "var(--muted)" }}>
            <span>{bulk.label}</span>
            <span>{bulk.done}/{bulk.total}</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(bulk.done / bulk.total) * 100}%`, background: "var(--accent)" }}
              role="progressbar"
              aria-valuenow={bulk.done}
              aria-valuemin={0}
              aria-valuemax={bulk.total}
            />
          </div>
        </div>
      )}
      <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }} data-testid="inat-results">
        {results.map((r) => {
          const cards = cardsFor(r);
          return (
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
                  {cards.length > 0 && (
                    <span data-testid={`in-deck-${r.id}`}>
                      {" · "}in deck ({cards.length} card{cards.length > 1 ? "s" : ""})
                    </span>
                  )}
                </div>
              </div>
              <button
                className="btn-secondary text-xs"
                onClick={() =>
                  void addResult(r, { exclude: photoIdsInDeck(cards), category: cards[0]?.category })
                }
                disabled={busyName !== null || bulk !== null}
                data-testid={`add-inat-${r.id}`}
              >
                {busyName === r.name ? "Adding…" : cards.length ? "+ Another" : "+ Add"}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
        “+ Another” adds a second card of the same species with different photos — extras export
        as “Name (2)” while the card back keeps the clean name, so the photo can't be memorized.
      </p>
    </div>
  );
}
