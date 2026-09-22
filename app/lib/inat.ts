import { getCachedApi, putCachedApi } from "./store";

/**
 * Browser iNaturalist client, ported from the Healthy Canyons generation
 * pipeline (decks/healthy-canyons/generation/lib/inat.ts). Same API surface
 * and license policy; the disk cache becomes an IndexedDB cache, and the
 * circuit breaker keeps iNat's rate limits happy from many browser sessions.
 *
 * iNat's API serves `Access-Control-Allow-Origin: *`, so this works from the
 * static site with no proxy.
 */

const API_BASE = "https://api.inaturalist.org/v1/";

export interface InatTaxon {
  id: number;
  name: string;
  rank: string;
  rank_level: number;
  is_active: boolean;
  preferred_common_name?: string;
  ancestry?: string;
  iconic_taxon_id?: number;
  default_photo?: { license_code: string | null; attribution: string; url: string } | null;
  ancestors?: Array<{ id: number; name: string; rank: string; preferred_common_name?: string }>;
  matched_term?: string;
  current_synonymous_taxon_ids?: number[] | null;
  observations_count?: number;
}

export interface InatPhoto {
  id: string | number;
  license_code: string | null;
  attribution: string;
  url: string;
  /** e.g. "image/jpeg" or "video/mp4" — null on some endpoints. */
  file_content_type?: string | null;
  original_dimensions?: { width: number; height: number };
}

/** iNat serves video media through the same photos array (when present);
 *  detect it by content type or URL shape. */
export function isVideoMedia(
  photo: Pick<InatPhoto, "file_content_type" | "url">,
): boolean {
  const ct = (photo.file_content_type ?? "").toLowerCase();
  if (ct.startsWith("video/")) return true;
  const url = photo.url ?? "";
  return url.includes("/videos/") || url.endsWith(".mp4");
}

export interface InatObservation {
  id: number;
  uri?: string;
  photos?: InatPhoto[];
  quality_grade?: string;
  user?: { login?: string; name?: string };
  cached_votes_total?: number;
  place_ids?: number[];
  geojson?: { coordinates: [number, number] };
  place_guess?: string;
}

export function isAllowedLicense(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.toLowerCase();
  return c === "cc0" || ["cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"].includes(c);
}

/** True while a breaker cool-down is active (shared module state). */
let breakerUntil = 0;
let consecutiveFailures = 0;
const listeners = new Set<(open: boolean) => void>();

export function isBreakerOpen(): boolean {
  return Date.now() < breakerUntil;
}

export function onBreakerChange(fn: (open: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setBreaker(ms: number): void {
  breakerUntil = Math.max(breakerUntil, Date.now() + ms);
  for (const fn of listeners) fn(true);
}

function noteSuccess(): void {
  if (breakerUntil !== 0) {
    breakerUntil = 0;
    for (const fn of listeners) fn(false);
  }
  consecutiveFailures = 0;
}

// Single-flight request pacing: one request in flight at a time, minimum gap
// between request starts (iNat asks for ~1 req/sec; keep a polite margin).
const MIN_GAP_MS = 1100;
let chain: Promise<unknown> = Promise.resolve();

function pace<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => new Promise((r) => setTimeout(r, MIN_GAP_MS)),
    () => new Promise((r) => setTimeout(r, MIN_GAP_MS)),
  );
  return run as Promise<T>;
}

/** iNat API GET with IndexedDB cache, retry and circuit breaker. */
export async function inatGet<T>(endpoint: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const url = new URL(endpoint, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const cacheKey = `inat:${url.pathname.slice(1)}?${url.searchParams.toString()}`;
  const cached = await getCachedApi(cacheKey);
  if (cached !== undefined) return cached as T;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (isBreakerOpen()) {
      throw lastErr ?? new Error("iNaturalist is temporarily unavailable — try again in a minute.");
    }
    try {
      const json = await pace(async () => {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(60_000 * 2 ** consecutiveFailures, 300_000);
          consecutiveFailures++;
          setBreaker(backoff);
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`iNat API error ${res.status}: ${body.slice(0, 200)}`);
        }
        return (await res.json()) as T;
      });
      noteSuccess();
      await putCachedApi(cacheKey, json);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export async function autocompleteTaxon(q: string, signal?: AbortSignal): Promise<InatTaxon[]> {
  // Autocomplete queries bypass the permanent cache (users type as they
  // think); results are still cached via the same store.
  const json = await inatGet<{ results: InatTaxon[] }>("taxa/autocomplete", { q, per_page: 10 });
  return json.results;
}

export async function taxonDetail(id: number): Promise<InatTaxon | undefined> {
  const json = await inatGet<{ results: InatTaxon[] }>(`taxa/${id}`);
  return json.results[0];
}

export interface ObservationQuery {
  taxonId: number;
  /** lat/lng radius search; omit for worldwide. */
  lat?: number;
  lng?: number;
  radius?: number;
  placeId?: number;
  qualityGrade?: "research" | "casual" | "any";
  perPage?: number;
  orderBy?: "votes" | "observed_on";
}

export async function observations(q: ObservationQuery, signal?: AbortSignal): Promise<InatObservation[]> {
  const json = await inatGet<{ results: InatObservation[] }>("observations", {
    taxon_id: q.taxonId,
    photos: true,
    license: "any",
    order_by: q.orderBy ?? "votes",
    per_page: q.perPage ?? 24,
    lat: q.lat,
    lng: q.lng,
    radius: q.radius,
    place_id: q.placeId,
    quality_grade: q.qualityGrade && q.qualityGrade !== "any" ? q.qualityGrade : undefined,
  });
  return json.results;
}

export interface InatPlace {
  id: number;
  name: string;
  admin_level: number;
  bbox_area?: number;
}

export async function placesAutocomplete(q: string): Promise<InatPlace[]> {
  const json = await inatGet<{ results: InatPlace[] }>("places/autocomplete", { q, per_page: 10 });
  return json.results;
}

/** Resolve the original-size photo URL for an iNat photo record. */
export function photoVariants(photo: { url: string }): string[] {
  const url = photo.url ?? "";
  const out: string[] = [];
  for (const size of ["original", "large", "medium"]) {
    const candidate = url.replace(/\/(square|thumb|small|medium|large|original)\./, `/${size}.`);
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}
