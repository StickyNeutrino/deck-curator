import type { Project } from "./types";
import { inatGet, photoVariants, type InatObservation } from "./inat";

/**
 * Remote photo sources.
 *
 * Slots picked from iNat remember their photo's URL (`PhotoSlot.url`), which
 * is what makes light decks possible: the manifest references the remote
 * image instead of shipping its bytes. Slots picked before URL tracking
 * (and clips picked before `animation.url`) have no stored URL — this module
 * backfills them from the iNat observation API, which every slot can reach
 * through its `credit.observationId` + `inat:<photoId>` id.
 *
 * Backfill batches observations ≤30 ids per request (the API's "too many
 * ids" limit, same as taxa batching): a 300-photo deck from 150 distinct
 * observations is 5 calls, not 150 — at iNat's polite ~1 req/sec pacing that
 * is the difference between seconds and minutes.
 */

/** iNat rejects id lists longer than this ("Too many IDs" error). */
const IDS_PER_CALL = 30;

export interface BackfillResult {
  /** slot id → original-size URL, for slots whose `url` was missing and got
   *  resolved from the iNat API. For animated-media slots the record under
   *  the slot id IS the clip, so this is the clip's URL (the display still
   *  is captured locally and has no remote source). */
  urls: Map<string, string>;
  /** Slot ids that reference iNat photos but could not be resolved —
   *  no observation id to query from, or the lookup missed the photo. */
  unresolved: string[];
  /** True when at least one batch lookup failed (network, rate limit, API
   *  error) after retries — the caller should tell the user to retry rather
   *  than report every photo as sourceless. */
  apiFailed: boolean;
}

/** Fill in missing remote URLs for a project's photo slots. Observations are
 *  fetched in batches (≤30 ids per call), cached by `inatGet`, so repeat
 *  exports cost nothing. Pure: the resolved URLs are returned, not written
 *  back to the project. `onProgress` reports (resolved, remaining) as
 *  batches land; `signal` cancels between batches and inside fetches. */
export async function backfillPhotoUrls(
  project: Pick<Project, "species">,
  opts: {
    onProgress?: (resolved: number, remaining: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<BackfillResult> {
  // Collect what needs resolving, grouped for batched lookups: the distinct
  // observation ids to fetch, and which slot ids hang off each photo id.
  const obsIds = new Set<number>();
  const slotsByPhotoId = new Map<number, Set<string>>();
  const unresolved = new Set<string>();
  for (const species of project.species) {
    for (const slot of species.photos) {
      if (slot.url) continue;
      if (!slot.id.startsWith("inat:")) continue;
      unresolved.add(slot.id);
      const obsId = slot.credit.observationId;
      const photoId = Number(slot.id.slice("inat:".length));
      if (!obsId || !Number.isFinite(photoId)) continue;
      obsIds.add(obsId);
      if (!slotsByPhotoId.has(photoId)) slotsByPhotoId.set(photoId, new Set());
      slotsByPhotoId.get(photoId)!.add(slot.id);
    }
  }

  const urls = new Map<string, string>();
  const batches = chunks([...obsIds], IDS_PER_CALL);
  let apiFailed = false;
  for (const batch of batches) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const json = await inatGet<{ results: InatObservation[] }>(
        "observations",
        { id: batch.join(","), per_page: batch.length },
        opts.signal,
      );
      for (const obs of json.results ?? []) {
        for (const photo of obs.photos ?? []) {
          const slots = slotsByPhotoId.get(Number(photo.id));
          if (!slots) continue;
          const url = photoVariants(photo)[0];
          if (!url) continue;
          for (const slotId of slots) {
            urls.set(slotId, url);
            unresolved.delete(slotId);
          }
        }
      }
    } catch (err) {
      // A cancelled backfill must surface as cancellation, not as an outage.
      if (opts.signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
      // After inatGet's retries: network down, rate-limited, or API error.
      // Leave this batch's slots unresolved, remember why, keep going so
      // one bad batch doesn't sink the rest.
      apiFailed = true;
    }
    opts.onProgress?.(urls.size, unresolved.size);
  }
  return { urls, unresolved: [...unresolved], apiFailed };
}

/** Split a list into fixed-size chunks (last one may be shorter). */
function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
