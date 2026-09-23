import {
  isVideoMedia,
  autocompleteTaxon,
  taxonDetail,
  observations,
  photoVariants,
  isAllowedLicense,
  type InatTaxon,
  type InatObservation,
  type InatPhoto,
} from "./inat";
import type { PhotoCredit, PhotoSlot } from "./types";
import { LICENSE_PREFERENCE, INAT_ALLOWED_LICENSES, type InatSearchSettings, type LicenseCode } from "./types";

/**
 * Species resolution against iNaturalist, ported from the Healthy Canyons
 * pipeline's fetch stage: rank-marker stripping, synonym-aware taxon
 * selection, and CC-photo picking that prefers distinct observers.
 */

/** Rank markers ("ssp.", "var.", "f.") that iNat names omit. */
const RANK_MARKER = /^(ssp|subsp|var|f|forma)\.?$/i;

export function stripRankMarkers(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => !RANK_MARKER.test(w))
    .join(" ");
}

function isInfraspecificQuery(stripped: string): boolean {
  return stripped.split(" ").length > 2;
}

/** Pick the best active taxon for a scientific-name query (pipeline logic). */
export function chooseTaxon(results: InatTaxon[], query: string): InatTaxon | null {
  const q = stripRankMarkers(query);
  const words = q.split(" ");
  const active = results.filter((t) => t.is_active);
  const exact = active.filter(
    (t) =>
      t.name.toLowerCase() === q ||
      (t.matched_term ?? "").toLowerCase().replace(/\s+/g, " ").trim() ===
        query.toLowerCase().replace(/\s+/g, " ").trim(),
  );
  if (exact.length) {
    const desiredLevel = words.length > 2 ? 5 : 10;
    exact.sort((a, b) =>
      Math.abs((a.rank_level ?? 0) - desiredLevel) - Math.abs((b.rank_level ?? 0) - desiredLevel) ||
      (b.observations_count ?? 0) - (a.observations_count ?? 0));
    return exact[0];
  }
  // Infraspecific queries never fall back below the exact taxon.
  if (words.length > 2) return null;
  // Synonym resolution: iNat returns the active replacement
  // (e.g. Dendroica → Setophaga).
  const synonymMatches = active.filter((t) => {
    const parts = t.name.toLowerCase().split(" ");
    return parts[0] === words[0] && parts[1] === words[1];
  });
  if (synonymMatches.length) {
    synonymMatches.sort((a, b) =>
      Math.abs((a.rank_level ?? 0) - 10) - Math.abs((b.rank_level ?? 0) - 10) ||
      (b.observations_count ?? 0) - (a.observations_count ?? 0));
    return synonymMatches[0];
  }
  return null;
}

export interface ResolvedTaxon {
  taxonId: number;
  sciName: string;
  commonName: string | null;
  familyId: number | null;
  familyLatin: string | null;
  familyCommon: string | null;
  /** iNat's native/introduced flags, when present on the taxon record. */
  native: "native" | "non-native" | "unknown";
  /** iNat iconic_taxon_id — classifies the species into Plants/Animals/etc. */
  iconicTaxonId?: number;
}

/** iNat iconic_taxon_id → deck category label (ids verified against the API). */
export const ICONIC_CATEGORY: Record<number, "Plants" | "Fungi" | "Animals"> = {
  47126: "Plants",
  47170: "Fungi",
};

/** Every other iconic group (birds, mammals, insects, …) is an animal. */
export function categoryLabelForIconic(iconicTaxonId: number | null | undefined): "Plants" | "Fungi" | "Animals" {
  if (iconicTaxonId === 47126) return "Plants";
  if (iconicTaxonId === 47170) return "Fungi";
  return "Animals";
}

/** Family + common name + iconic group for a known taxon id (cached by inatGet). */
export async function fetchTaxonDetail(taxonId: number): Promise<{
  commonName: string | null;
  familyLatin: string | null;
  familyCommon: string | null;
  iconicTaxonId: number | null;
} | null> {
  const detail = await taxonDetail(taxonId);
  if (!detail) return null;
  const family = (detail.ancestors ?? []).find((a) => a.rank === "family") ?? null;
  return {
    commonName: detail.preferred_common_name ?? null,
    familyLatin: family?.name ?? null,
    familyCommon: family?.preferred_common_name ?? null,
    iconicTaxonId: detail.iconic_taxon_id ?? null,
  };
}

export async function resolveTaxon(name: string): Promise<ResolvedTaxon | null> {
  const stripped = stripRankMarkers(name);
  const attempts = [stripped];
  if (!isInfraspecificQuery(stripped) && name.trim().split(/\s+/).length > 2) {
    attempts.push(stripped.split(" ").slice(0, 2).join(" "));
  }
  for (const attempt of attempts) {
    const results = await autocompleteTaxon(attempt);
    const chosen = chooseTaxon(results, attempt);
    if (chosen) {
      const detail = await taxonDetail(chosen.id);
      const family = (detail?.ancestors ?? []).find((a) => a.rank === "family") ?? null;
      return {
        taxonId: chosen.id,
        sciName: detail?.name ?? chosen.name,
        commonName: detail?.preferred_common_name ?? chosen.preferred_common_name ?? null,
        familyId: family?.id ?? null,
        familyLatin: family?.name ?? null,
        familyCommon: family?.preferred_common_name ?? null,
        native: "unknown", // iNat's conservation status is place-specific; the curator edits this by hand
        iconicTaxonId: detail?.iconic_taxon_id ?? undefined,
      };
    }
  }
  return null;
}

export interface PhotoCandidate {
  photo: InatPhoto;
  obs: InatObservation;
}

/** True when the string looks like a scientific name ("Quercus agrifolia"). */
export function looksLikeSciName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return (
    words.length >= 2 &&
    /^[A-Z][a-z]+$/.test(words[0]) &&
    /^[a-z][a-z-]+$/.test(words[1])
  );
}

/** Candidate media for a taxon, CC-licensed, most-voted first.
 *  `excludePhotoIds` (raw iNat photo ids) filters out media already used by
 *  other cards of the same species, so variant cards show different images.
 *  Video media is skipped unless `includeVideos` is set. */
export async function candidatePhotos(
  taxonId: number,
  scope?: { lat: number; lng: number; radiusKm: number } | { placeId: number },
  excludePhotoIds?: Set<string>,
  options: {
    includeVideos?: boolean;
    /** Deck search settings: licenses, research grade, ordering. */
    settings?: InatSearchSettings;
  } = {},
): Promise<PhotoCandidate[]> {
  const { includeVideos = false, settings } = options;
  const licenses = settings?.licenses;
  const results = await observations({
    taxonId,
    perPage: 24,
    lat: scope && "lat" in scope ? scope.lat : undefined,
    lng: scope && "lng" in scope ? scope.lng : undefined,
    radius: scope && "lat" in scope ? scope.radiusKm : undefined,
    placeId: scope && "placeId" in scope ? scope.placeId : undefined,
    qualityGrade: settings?.researchGrade ? "research" : undefined,
    // Server-side license filter when the deck restricts licenses: fewer
    // results wasted on photos we'd discard anyway.
    licenses:
      licenses && licenses.length < INAT_ALLOWED_LICENSES.length
        ? licenses.join(",")
        : undefined,
  });
  const out: PhotoCandidate[] = [];
  const seen = new Set<string>();
  for (const obs of results) {
    if (settings?.researchGrade && obs.quality_grade !== "research") continue;
    for (const photo of obs.photos ?? []) {
      if (!isAllowedLicense(photo.license_code)) continue;
      // Belt-and-braces: the API filter should cover this, but cached
      // responses predate it.
      if (licenses && !licenses.includes((photo.license_code ?? "").toLowerCase() as LicenseCode)) continue;
      if (!includeVideos && !settings?.includeMedia && isVideoMedia(photo)) continue;
      const key = String(photo.id);
      if (seen.has(key)) continue;
      if (excludePhotoIds?.has(key)) continue;
      seen.add(key);
      out.push({ photo, obs });
    }
  }
  // Prefer permissive licenses: iNat skews heavily toward CC BY-NC (their
  // signup default), so without this the vote-ordered results surface NC
  // variants first even when BY/CC0 photos exist. Stable sort keeps the
  // vote ordering within each license tier. Opt-out via orderBy: "votes".
  if ((settings?.orderBy ?? "license") === "votes") return out;
  const rank = (c: PhotoCandidate) => {
    const idx = LICENSE_PREFERENCE.indexOf(
      (c.photo.license_code ?? "").toLowerCase() as (typeof LICENSE_PREFERENCE)[number],
    );
    return idx === -1 ? LICENSE_PREFERENCE.length : idx;
  };
  return out
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ c }) => c);
}

/** Download an iNat photo (original, then large/medium) as a Blob. */
export async function downloadPhoto(photo: InatPhoto): Promise<Blob> {
  let lastErr: unknown;
  for (const url of photoVariants(photo)) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 5000) continue;
      return new Blob([buf], { type: "image/jpeg" });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Photo download failed");
}

/**
 * Take up to `max` photos from distinct observations, preferring distinct
 * observers (the pipeline's pickPhotos).
 */
export function pickDistinct<T extends PhotoCandidate>(candidates: T[], max: number): T[] {
  const picked: T[] = [];
  const usedObs = new Set<number>();
  const usedObservers = new Set<string>();
  const remaining = [...candidates];
  const observerOf = (c: PhotoCandidate) => c.obs.user?.name || c.obs.user?.login || "unknown";
  while (picked.length < max && remaining.length) {
    let idx = remaining.findIndex((c) => !usedObs.has(c.obs.id) && !usedObservers.has(observerOf(c)));
    if (idx === -1) idx = remaining.findIndex((c) => !usedObs.has(c.obs.id));
    if (idx === -1) idx = 0;
    const [chosen] = remaining.splice(idx, 1);
    picked.push(chosen);
    usedObs.add(chosen.obs.id);
    usedObservers.add(observerOf(chosen));
  }
  return picked;
}

export function creditForObservation(obs: InatObservation, photo: InatPhoto): PhotoCredit {
  return {
    observer: obs.user?.name || obs.user?.login || "unknown",
    license: (photo.license_code ?? "").toLowerCase(),
    sourceUrl: obs.uri || `https://www.inaturalist.org/observations/${obs.id}`,
    observationId: obs.id,
    placeLabel: obs.place_guess || undefined,
  };
}

/** Build a PhotoSlot from a downloaded iNat photo. */
export function slotFromInatPhoto(
  photo: InatPhoto,
  obs: InatObservation,
  role: "main" | "secondary",
  fileKey: string,
  alt?: string,
): PhotoSlot {
  return {
    id: `inat:${photo.id}`,
    role,
    credit: creditForObservation(obs, photo),
    fileKey,
    alt,
  };
}
