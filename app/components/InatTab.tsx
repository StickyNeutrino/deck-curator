import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Project, SpeciesEntry, NativeStatus } from "~/lib/types";
import { makeSpecies } from "~/lib/types";
import { candidatePhotos, pickDistinct, fetchTaxonDetail, taxonDetailBatch, type PhotoCandidate, type TaxonDetailFields } from "~/lib/resolve";
import { acquireMediaSlot } from "~/lib/media";
import { taxaRecords, photoSquareUrl, inatGet, type InatTaxon } from "~/lib/inat";
import { categoryIdForIconic, labelForCategoryId } from "~/lib/categories";
import { resolveInatPlace, establishmentToNative } from "~/lib/tools";
import { startJob, useJobs } from "~/lib/jobs";
import { slugify } from "~/lib/ids";
import { LocationPicker } from "~/components/LocationPicker";
import type { DeckLocation } from "~/lib/types";
import { searchSettingsOf } from "~/lib/types";
import { mutateProject } from "~/lib/useProjectDoc";

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

/** The "kind" filter: iNat's iconic taxa. `name` is what the observations
 *  endpoint accepts for its `iconic_taxa` param (best-effort server-side
 *  narrowing); `id` drives the authoritative client-side filter. */
const KINDS: Array<{ id: number; name: string; label: string }> = [
  { id: 47126, name: "Plantae", label: "Plants" },
  { id: 47170, name: "Fungi", label: "Fungi" },
  { id: 3, name: "Aves", label: "Birds" },
  { id: 40151, name: "Mammalia", label: "Mammals" },
  { id: 26036, name: "Reptilia", label: "Reptiles" },
  { id: 20978, name: "Amphibia", label: "Amphibians" },
  { id: 47178, name: "Actinopterygii", label: "Fish" },
  { id: 47158, name: "Insecta", label: "Insects" },
  { id: 47119, name: "Arachnida", label: "Arachnids" },
];

type EstablishmentFilter = "any" | "native" | "non-native";

/** Shared per-run caches for a bulk add (see fetchCard). */
interface RunCaches {
  /** Photo candidates by taxon id — variant cards re-pick from the same
   *  observations response instead of refetching it. */
  candidates: Map<number, PhotoCandidate[]>;
  /** Batched scientific details for species the search couldn't pre-fill
   *  (worldwide searches skip the place-checklist batch). */
  details?: Map<number, TaxonDetailFields>;
}

/** Photo downloads run through a small gate: originals can be several MB,
 *  and a 200-species bulk add must not pile hundreds of in-flight blobs
 *  into memory. Downloads are S3 fetches (outside iNat's paced API chain),
 *  so the gate only caps memory — downloads still overlap the next card's
 *  API call up to this limit. */
const DOWNLOAD_CONCURRENCY = 6;

interface DownloadPool {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** A tiny counting gate: at most `limit` tasks in flight. Aborting the
 *  signal releases queued tasks so their fetches observe the abort and
 *  settle instead of stalling the job's final await. */
function createDownloadPool(limit: number, signal?: AbortSignal): DownloadPool {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  signal?.addEventListener("abort", () => {
    while (queue.length) {
      active++;
      queue.shift()!();
    }
  }, { once: true });
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          task().then(resolve, reject).finally(release);
        };
        if (active < limit && !signal?.aborted) {
          active++;
          start();
        } else {
          queue.push(start);
        }
      });
    },
  };
}

/**
 * The iNaturalist search tab. A location (or worldwide scope) + a kind,
 * native-status, and name filter lists the top species observed in the area;
 * the curator ticks checkboxes and "Add selected" spawns a cancellable
 * background job that fetches CC photos for each card — the job keeps
 * running (and stays monitorable in the Jobs dock) even after this modal
 * closes. "Cards per species" creates N photo-distinct cards per species for
 * anti-memorization variants. Species are filed into Plants/Fungi/Animals
 * automatically from iNat's taxonomy, and family/scientific details are
 * enriched from the same API.
 */

interface TaxonResult {
  id: number;
  name: string;
  common: string | null;
  count: number;
  iconicTaxonId: number | null;
  /** Square thumbnail from iNat's default photo, when the taxon has one. */
  thumb?: string;
  /** iNat place-checklist label (native / non-native), when the search
   *  location resolved to an iNat place. Best-effort — may stay null. */
  native: NativeStatus | null;
  nativeSource?: string;
  /** Family from the same place-checklist batch that labels native status
   *  (iNat's batched taxa records carry ancestors) — bulk adds then need no
   *  per-card taxon-detail call. Undefined for worldwide searches, where the
   *  job prefetches details in one batched call instead. */
  familyLatin?: string;
  familyCommon?: string;
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

/** Append a finished card to a deck draft (category row first, if new). */
function addEntryTo(d: Project, entry: SpeciesEntry): void {
  if (!d.categories.some((c) => c.id === entry.category)) {
    d.categories.push({ id: entry.category, label: labelForCategoryId(entry.category) });
  }
  d.species.push(entry);
}

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
  const [nameQuery, setNameQuery] = useState("");
  const [kind, setKind] = useState(0); // 0 = any kind
  const [establishment, setEstablishment] = useState<EstablishmentFilter>("any");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TaxonResult[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photosPerCard, setPhotosPerCard] = useState(3);
  // Deck-wide iNat constraints live on the project (edited in Deck info);
  // this tab and the photo browser both read them.
  const searchSettings = useMemo(() => searchSettingsOf(project), [project.inatSearch]);
  const [resultLimit, setResultLimit] = useState<number>(30);
  const [cardsPerSpecies, setCardsPerSpecies] = useState(1);
  const [busyName, setBusyName] = useState<string | null>(null);

  // Live job list: a running bulk-add for this deck disables further adds
  // (the job itself is watched — and cancellable — in the Jobs dock).
  const jobs = useJobs();
  const bulkRunning = jobs.some(
    (j) => j.kind === "inat-add" && j.projectId === project.id && j.status === "running",
  );

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
    const hasCoords = loc?.lat != null && loc?.lng != null;
    if (!nameQuery.trim() && kind === 0 && !hasCoords) {
      setError("Enter a location (and/or a kind or name filter) to search.");
      return;
    }
    if (establishment !== "any" && !hasCoords) {
      setError("Filtering by native status needs a search location — pick one above.");
      return;
    }
    setSearching(true);
    setError(null);
    setStatus("Searching iNaturalist…");
    try {
      // iNat's taxa endpoint can't filter geographically, so aggregate taxa
      // from observations inside the circle. per_page goes up to 200; more
      // pages are fetched when the species cap needs more observations.
      const want = resultLimit;
      const counts = new Map<number, { taxon: InatTaxon; count: number }>();
      const needle = nameQuery.trim().toLowerCase();
      const kindDef = kind ? KINDS.find((k) => k.id === kind) : undefined;
      const maxPages = Math.ceil(want / 40) + 1; // ~40-60 species per 100 observations typically
      for (let page = 1; page <= Math.min(4, maxPages); page++) {
        const json = await inatGet<{
          results: Array<{ taxon?: InatTaxon; id: number }>;
        }>("observations", {
          lat: hasCoords ? loc!.lat : undefined,
          lng: hasCoords ? loc!.lng : undefined,
          radius: hasCoords ? loc!.radiusKm || 10 : undefined,
          per_page: 200,
          page,
          photos: true,
          quality_grade: searchSettings.researchGrade ? "research" : undefined,
          order_by: "observed_on",
          // Best-effort server-side narrowing; the client-side check below
          // is authoritative (the param may be ignored by the API).
          iconic_taxa: kindDef?.name,
        });
        for (const obs of json.results) {
          const t = obs.taxon;
          if (!t || !t.is_active || t.rank !== "species") continue;
          if (kindDef && t.iconic_taxon_id !== kindDef.id) continue;
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
          thumb: photoSquareUrl(taxon.default_photo),
          native: null as NativeStatus | null,
          nativeSource: undefined as string | undefined,
          familyLatin: undefined as string | undefined,
          familyCommon: undefined as string | undefined,
        }));
      // Best-effort pre-labeling: iNat's place checklist says which species
      // are native / introduced in the search area (one cached batch call —
      // and the labels ride along on cards added from the results). The same
      // batched response carries each taxon's family, which the cards'
      // scientific details read — no per-card detail call needed later.
      if (hasCoords && found.length) {
        const place = await resolveInatPlace(loc!);
        if (place) {
          const rows = await taxaRecords(found.map((r) => r.id), place.id);
          for (const r of found) {
            const row = rows.get(r.id);
            const native = establishmentToNative(row?.establishment_means);
            if (native) {
              r.native = native;
              r.nativeSource = place.name;
            }
            const family = row?.ancestors?.find((a) => a.rank === "family");
            if (family) {
              r.familyLatin = family.name;
              r.familyCommon = family.preferred_common_name;
            }
          }
        }
      }
      // Native-status filter: keep only species iNat labels as requested.
      let filtered = found;
      let filterNote: string | null = null;
      if (establishment !== "any") {
        let unlabeled = 0;
        filtered = found.filter((r) => {
          if (!r.native) {
            unlabeled++;
            return false;
          }
          return r.native === establishment;
        });
        if (unlabeled > 0 && filtered.length) {
          filterNote = `Found ${found.length} species — ${unlabeled} had no native-status data and are hidden.`;
        }
      }
      setResults(filtered);
      // Default selection: everything not already in the deck.
      setSelected(new Set(filtered.filter((r) => !cardsFor(r).length).map((r) => r.id)));
      setStatus(
        filterNote ??
          (filtered.length
            ? `Found ${filtered.length} species observed in the area — tick the ones to add, then “Add selected”.`
            : "No species matched. Try a broader filter or a bigger radius."),
      );
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [loc, nameQuery, kind, establishment, resultLimit, searchSettings, cardsFor]);

  /**
   * Fetch phase of adding one card: photo candidates (cached per run, so
   * variant cards re-pick the same observations response instead of
   * refetching it), the distinct picks filtered against `exclude`, scientific
   * enrichment (from the search's checklist response or the run's batched
   * details when available; the per-taxon detail call is the direct "+ Add"
   * path's fallback), and the assembled entry whose photos are still
   * downloads-in-waiting. All rate-limited iNat API traffic happens here.
   * Throws on failure; callers decide what a null/failure means.
   */
  const fetchCard = useCallback(
    async (
      result: TaxonResult,
      opts: { exclude?: Set<string>; category?: string; signal?: AbortSignal; run?: RunCaches },
    ): Promise<{ entry: SpeciesEntry; picks: PhotoCandidate[]; base: string }> => {
      const photoScope =
        loc?.lat != null && loc?.lng != null
          ? { lat: loc.lat, lng: loc.lng, radiusKm: loc.radiusKm || 10 }
          : undefined;
      // Photo candidates: one API call per species per run — N variant cards
      // re-pick the same response (it already holds the alternatives), each
      // excluding the photos earlier picks claimed.
      let candidates = opts.run?.candidates.get(result.id);
      if (!candidates) {
        candidates = await candidatePhotos(result.id, photoScope, undefined, {
          includeVideos: searchSettings.includeMedia,
          settings: searchSettings,
          signal: opts.signal,
        });
        opts.run?.candidates.set(result.id, candidates);
      }
      // Cancelled while fetching: don't build a half-photo card.
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const picked = pickDistinct(
        candidates.filter((c) => !opts.exclude?.has(String(c.photo.id))),
        photosPerCard,
      );

      // Scientific enrichment + category: the search's checklist response
      // (place-scoped searches fetch it anyway), then the run's batched
      // detail prefetch, then one cached per-taxon call (direct "+ Add").
      let category = opts.category;
      let familyLatin = result.familyLatin;
      let familyCommon = result.familyCommon;
      let iconicTaxonId = result.iconicTaxonId;
      if (familyLatin == null && familyCommon == null) {
        const batched = opts.run?.details?.get(result.id);
        if (batched) {
          familyLatin = batched.familyLatin ?? undefined;
          familyCommon = batched.familyCommon ?? undefined;
          iconicTaxonId = batched.iconicTaxonId ?? iconicTaxonId;
        } else {
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
        }
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
        native: result.native ?? "unknown",
        layout: photosPerCard === 1 ? "photo-single" : "photo-trio",
      });
      return { entry, picks: picked, base: slugify(result.name) };
    },
    [loc, photosPerCard, searchSettings, project.id, project.categories, onChange],
  );

  /**
   * Download a card's picked photos through the run's gate and fill
   * `entry.photos` in pick order (main photo first). Photos come straight
   * from iNat's S3 bucket — outside the paced API chain — so they overlap
   * the next card's API call. A failed download just means fewer photos.
   * Never throws; cancellation is the caller's signal check before writing.
   */
  const downloadCardPhotos = useCallback(
    (
      entry: SpeciesEntry,
      picks: PhotoCandidate[],
      opts: { base: string; signal?: AbortSignal; pool: DownloadPool },
    ): Promise<void> =>
      Promise.all(
        picks.map(async (pick, i) => {
          try {
            return await opts.pool.run(() =>
              acquireMediaSlot(pick.photo, pick.obs, {
                role: i === 0 ? "main" : "secondary",
                base: opts.base,
                includeAnimated: searchSettings.includeMedia,
                projectId: project.id,
                signal: opts.signal,
              }),
            );
          } catch {
            return null; // A failed download just means fewer photos.
          }
        }),
      ).then((slots) => {
        if (opts.signal?.aborted) return;
        for (const slot of slots) if (slot) entry.photos.push(slot);
      }),
    [searchSettings.includeMedia, project.id],
  );

  /** Land a finished card in the deck (category row first, if new). */
  const writeEntry = useCallback(
    (entry: SpeciesEntry) => {
      onChange((d) => addEntryTo(d, entry));
    },
    [onChange],
  );

  /**
   * Add one search result as a card. When the species is already in the deck
   * this creates an extra card ("variant"); `exclude` keeps its photos
   * distinct from the cards already in the deck. `signal` aborts in-flight
   * fetches when a background job is cancelled.
   */
  const addResult = useCallback(
    async (result: TaxonResult, opts: { quiet?: boolean; exclude?: Set<string>; category?: string; signal?: AbortSignal } = {}): Promise<SpeciesEntry | null> => {
      if (!opts.quiet) setBusyName(result.name);
      try {
        const card = await fetchCard(result, opts);
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const existingCards = cardsFor(result);
        await downloadCardPhotos(card.entry, card.picks, {
          base: card.base,
          signal: opts.signal,
          pool: createDownloadPool(DOWNLOAD_CONCURRENCY, opts.signal),
        });
        // Cancelled mid-download: abandon the card entirely rather than
        // land a photo-less one.
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        writeEntry(card.entry);
        if (!opts.quiet) {
          setStatus(
            existingCards.length
              ? `Added another card for ${result.name}${card.entry.photos.length ? ` with ${card.entry.photos.length} new photo(s)` : " (no CC photos found)"}.`
              : `Added ${result.name}${card.entry.photos.length ? ` with ${card.entry.photos.length} photo(s)` : " (no CC photos found)"}.`,
          );
        }
        return card.entry;
      } catch (err) {
        if (!opts.quiet) {
          setStatus(`Could not add ${result.name}: ${err instanceof Error ? err.message : err}`);
        }
        return null;
      } finally {
        if (!opts.quiet) setBusyName(null);
      }
    },
    [fetchCard, downloadCardPhotos, writeEntry, cardsFor],
  );

  /**
   * Spawn a background job that adds every checked species (cardsPerSpecies
   * cards each, photo-distinct). The job keeps running when this modal
   * closes; progress and cancellation live in the Jobs dock.
   *
   * Throughput comes from three batchings, all within iNat's ~1 req/sec
   * politeness limit (the pacing chain spaces API calls; bursting would trip
   * the 429 circuit breaker): photo candidates are fetched once per species
   * and re-picked for variants, scientific details are prefetched in one
   * batched call per 30 species, and each card's S3 photo downloads overlap
   * the next card's API phase through a bounded gate — while doc writes stay
   * in selection order.
   */
  const addSelected = useCallback(() => {
    const chosen = results.filter((r) => selected.has(r.id));
    if (!chosen.length) return;
    const total = chosen.length * cardsPerSpecies;
    // Track photo usage locally: the loop's project prop is a snapshot, so
    // exclusions for species added earlier in this run are kept here.
    const usedByTaxon = new Map<number, Set<string>>();
    for (const r of results) {
      usedByTaxon.set(r.id, photoIdsInDeck(cardsFor(r)));
    }
    // Per-run caches shared by every card in the job (see fetchCard).
    const run: RunCaches = { candidates: new Map() };
    // Species the search couldn't pre-fill with family data (worldwide
    // searches skip the checklist batch) get one batched detail prefetch.
    const needDetails = chosen.filter((r) => r.familyLatin == null && r.familyCommon == null);
    void startJob(
      {
        kind: "inat-add",
        label: `Adding ${total} card${total === 1 ? "" : "s"} from iNaturalist`,
        projectId: project.id,
        projectName: project.name,
      },
      async (h) => {
        if (needDetails.length) {
          h.progress(0, total, "Resolving species details…");
          run.details = await taxonDetailBatch(
            needDetails.map((r) => r.id),
            h.signal,
          ).catch(() => undefined);
        }
        let added = 0;
        let failed = 0;
        let done = 0;
        // Ordered pipeline: the paced API phase of card N+1 runs while card
        // N's photo downloads are still in flight, but doc writes stay in
        // selection order (each write awaits the previous one).
        const pool = createDownloadPool(DOWNLOAD_CONCURRENCY, h.signal);
        let writes: Promise<void> = Promise.resolve();
        for (const r of chosen) {
          const used = usedByTaxon.get(r.id)!;
          for (let c = 0; c < cardsPerSpecies; c++) {
            if (h.signal.aborted) throw new DOMException("Aborted", "AbortError");
            h.progress(done, total, `${r.common ?? r.name}${cardsPerSpecies > 1 ? ` — card ${c + 1}/${cardsPerSpecies}` : ""}`);
            const card = await fetchCard(r, { exclude: used, signal: h.signal, run }).catch(() => null);
            // Cancelled mid-item: don't count the half-done card.
            if (h.signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (!card) {
              failed++;
              done++;
              h.progress(done, total, r.common ?? r.name);
              continue;
            }
            // Exclusions apply at pick time: picks are decided in fetch
            // order, so variant cards fetched back-to-back can't reuse each
            // other's photos even though their writes complete later. (A
            // photo that later fails to download stays excluded — variants
            // err on the side of distinctness.)
            for (const p of card.picks) used.add(String(p.photo.id));
            const download = downloadCardPhotos(card.entry, card.picks, {
              base: card.base,
              signal: h.signal,
              pool,
            });
            writes = writes.then(async () => {
              await download;
              if (h.signal.aborted) return; // cancelled — never land this card
              await mutateProject(project.id, (d) => addEntryTo(d, card.entry));
              done++;
              added++;
              h.progress(done, total, r.common ?? r.name);
            });
          }
        }
        await writes;
        if (h.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return (
          `Added ${added} of ${total} card${total === 1 ? "" : "s"}${failed ? ` — ${failed} failed` : ""}.` +
          (cardsPerSpecies > 1 ? " Extras export as “Name (2)”, “Name (3)”… with different photos." : "")
        );
      },
    );
    setSelected(new Set());
    setStatus(
      `Adding ${total} card${total === 1 ? "" : "s"} in the background — watch (and cancel) it in Jobs.`,
    );
  }, [results, selected, cardsPerSpecies, cardsFor, fetchCard, downloadCardPhotos, project.id, project.name]);

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = results.length > 0 && results.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(results.map((r) => r.id)));
  };

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
      <div className="grid grid-cols-3 gap-3 mb-3">
        <label className="text-sm">
          <span className="label">Kind</span>
          <select
            className="field !py-1"
            value={kind}
            onChange={(e) => setKind(Number(e.target.value))}
            data-testid="inat-kind"
            title="Limit the search to one group of organisms"
          >
            <option value={0}>Any kind</option>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="label">Native status</span>
          <select
            className="field !py-1"
            value={establishment}
            onChange={(e) => setEstablishment(e.target.value as EstablishmentFilter)}
            data-testid="inat-establishment"
            title="Filter by iNat's place checklist — needs a search location"
          >
            <option value="any">Native &amp; non-native</option>
            <option value="native">Native only</option>
            <option value="non-native">Non-native only</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="label">Name contains (optional)</span>
          <input
            className="field !py-1"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="Dudleya…"
            data-testid="inat-taxon-query"
          />
        </label>
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Search lists the most-observed species in the circle, filed automatically into
        Plants / Fungi / Animals from iNaturalist's taxonomy. Only photos under the deck's
        accepted licenses are offered; every card carries the photographer credit.{" "}
        <Link to={`/project/${project.id}/info`} className="underline">
          Edit licenses &amp; filters in Deck info.
        </Link>
      </p>
      <div className="flex gap-2 items-center flex-wrap">
        <button className="btn-primary" onClick={() => void search()} disabled={searching} data-testid="inat-search">
          {searching ? "Searching…" : "Search"}
        </button>
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
      {results.length > 0 && (
        <div className="flex items-center gap-2 mt-3 text-sm">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = !allSelected && selected.size > 0;
            }}
            onChange={toggleAll}
            aria-label="Select all results"
            data-testid="inat-select-all"
          />
          <span style={{ color: "var(--muted)" }}>
            {selected.size} of {results.length} selected
          </span>
          <button
            className="btn-primary ml-auto"
            onClick={addSelected}
            disabled={bulkRunning || selected.size === 0}
            data-testid="inat-add-selected"
            title="Adds the selected species as cards in a background job you can watch and cancel in Jobs"
          >
            {bulkRunning
              ? "Adding…"
              : `Add selected (${selected.size} species${cardsPerSpecies > 1 ? ` → ${selected.size * cardsPerSpecies} cards` : ""})`}
          </button>
        </div>
      )}
      <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }} data-testid="inat-results">
        {results.map((r) => {
          const cards = cardsFor(r);
          return (
            <li key={r.id} className="flex items-center gap-3 py-2" data-testid={`inat-result-${r.id}`}>
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                onChange={() => toggleSelected(r.id)}
                aria-label={`Select ${r.common ?? r.name}`}
                data-testid={`select-result-${r.id}`}
              />
              {r.thumb ? (
                <img
                  src={r.thumb}
                  alt=""
                  loading="lazy"
                  className="w-10 h-10 rounded object-cover flex-shrink-0"
                  style={{ background: "var(--border)" }}
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                  data-testid={`result-thumb-${r.id}`}
                />
              ) : (
                <span className="w-10 h-10 rounded flex-shrink-0" style={{ background: "var(--border)" }} aria-hidden />
              )}
              <div className="flex-1 min-w-0">
                <span className="font-medium">{r.common ?? r.name}</span>{" "}
                {r.common && (
                  <span className="italic text-sm" style={{ color: "var(--muted)" }}>
                    {r.name}
                  </span>
                )}
                <div className="text-xs" style={{ color: "var(--muted)" }}>
                  {r.count.toLocaleString()} observations
                  {r.native && (
                    <span
                      className="ml-2 rounded-full border px-2 py-0.5"
                      style={{
                        borderColor: r.native === "non-native" ? "#b3261e" : "var(--border)",
                        color: r.native === "non-native" ? "#b3261e" : undefined,
                      }}
                      title={
                        r.nativeSource
                          ? `per iNat — ${r.nativeSource} checklist`
                          : undefined
                      }
                      data-testid={`native-badge-${r.id}`}
                    >
                      {r.native === "non-native" ? "Non-native" : "Native"}
                    </span>
                  )}
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
                disabled={busyName !== null || bulkRunning || searching}
                data-testid={`add-inat-${r.id}`}
              >
                {busyName === r.name ? "Adding…" : cards.length ? "+ Another" : "+ Add"}
              </button>
            </li>
          );
        })}
      </ul>
      {results.length > 0 && (
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          Tick species and “Add selected” to fetch photos in a background job — it keeps
          running (with progress and a cancel button in the Jobs dock) even if you close
          this dialog. “+ Another” adds a second card of one species with different
          photos — extras export as “Name (2)” while the card back keeps the clean name,
          so the photo can't be memorized.
        </p>
      )}
    </div>
  );
}
