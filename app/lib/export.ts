import { zipSync, type Zippable } from "fflate";
import type { PhotoSlot, Project, SpeciesEntry } from "./types";
import { creditFromSlot } from "./types";
import { sanitizeFileName } from "./ids";
import { listFiles } from "./store";
import { blobToArrayBuffer } from "./blobUtils";
import { shrinkPhotoBlob, type CropWindow } from "./imageShrink";
import { backfillPhotoUrls } from "./photoSource";

/**
 * The three export artifacts (docs/DECK_FORMAT.md):
 *
 *  - Project file (.zip): everything — manifest, photos, and the git
 *    history. Unzipping yields a restorable repository; this is the backup.
 *  - Deck file (.deck): the playable deck — manifest + photos, no history.
 *  - Light deck (.deck.lite): manifest only. Photos are referenced by their
 *    remote source and fetched + cropped on the user's device, so the file
 *    is microscopic. Only decks whose every photo has a remote source can
 *    ship light (no uploads, no animated media).
 */

export interface ExportResult {
  blob: Blob;
  filename: string;
  manifest: unknown;
}

/** Re-encode stills to smaller JPEGs (crop baked in, long edge capped).
 *  Animation clips pass through unchanged. */
export interface ShrinkOptions {
  maxEdge: number;
  quality: number;
}

/** Long-export plumbing: `onProgress` reports (done, total, what) as photos
 *  are gathered and re-encoded — the same shape the Jobs dock renders — and
 *  `signal` cancels between photos. */
export interface ExportRunnerOptions {
  onProgress?: (done: number, total: number, detail?: string) => void;
  signal?: AbortSignal;
}

export interface DeckExportOptions extends ExportRunnerOptions {
  /** Deck-file-only option: compress the shipped photos. Project files always
   *  ship original bytes — they carry the history those bytes belong to. */
  shrink?: ShrinkOptions | null;
}

/** The crop written to the manifest when the crop window is already baked
 *  into the shipped pixels: "the whole file is the crop region". The
 *  renderer maps exactly that region onto the slot (docs/DECK_FORMAT.md),
 *  so a pre-cropped photo renders identically to crop metadata over the
 *  full original — with fewer bytes shipped. */
export const IDENTITY_CROP = { x: 0, y: 0, w: 1, h: 1 };

export interface ManifestOptions {
  /** Stills whose crop window was baked into the exported pixels; their
   *  manifest entries carry IDENTITY_CROP (and never a legacy focus point)
   *  so the flashcard app renders them unchanged. */
  bakedCrops?: Set<string>;
  /** Light decks: slot id → original-size URL. Photo entries reference
   *  `url` instead of shipping a `file`. */
  remoteUrls?: Map<string, string>;
}

export function buildManifest(project: Project, opts: ManifestOptions = {}): object {
  const exportNames = cardExportNames(project);
  const categories = project.categories
    .map((cat) => ({
      id: cat.id,
      label: cat.label,
      cards: project.species
        .filter((s) => s.category === cat.id)
        .map((s) => cardFromSpecies(s, exportNames.get(s.id) ?? (s.commonName || s.sciName), opts)),
    }))
    .filter((cat) => cat.cards.length > 0 || project.species.some((s) => s.category === cat.id));

  return {
    id: project.id,
    label: project.deckLabel,
    description: project.description,
    // Where this deck is relevant (name and/or coordinates).
    location: project.location
      ? {
          name: project.location.name || undefined,
          lat: project.location.lat,
          lng: project.location.lng,
          radiusKm: project.location.radiusKm,
        }
      : undefined,
    cardFormat: "data",
    generator: { tool: "deck-curator", version: "1.0.0", exportedAt: new Date().toISOString() },
    categories,
  };
}

/**
 * Unique card names across the whole deck — the flashcards app keys the study
 * queue and card lookup by `name`, so duplicates are impossible in a manifest.
 * Intentional multi-card species (same species, different photos, to defeat
 * photo memorization) get "Name (2)", "Name (3)"… in project order; the card
 * back keeps showing the clean common name.
 */
export function cardExportNames(project: Project): Map<string, string> {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const s of project.species) {
    const base = (s.commonName || s.sciName || "Card").trim();
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    let name = n === 0 ? base : `${base} (${n + 1})`;
    // A literal "Oak (2)" card can collide with the generated suffix;
    // deck-wide uniqueness is the manifest's contract, so keep incrementing.
    while (used.has(name.toLowerCase())) {
      const next = (seen.get(key) ?? 1) + 1;
      seen.set(key, next);
      name = `${base} (${next})`;
    }
    used.add(name.toLowerCase());
    names.set(s.id, name);
  }
  return names;
}

export function cardFromSpecies(
  s: SpeciesEntry,
  exportName?: string,
  opts: ManifestOptions = {},
): object {
  // Light decks reference remote sources; full decks ship bytes. They never
  // mix — exportLightDeck resolves every URL before building the manifest.
  const light = opts.remoteUrls !== undefined;
  const photoEntry = (p: PhotoSlot): object => {
    const baked = opts.bakedCrops?.has(p.fileKey) ?? false;
    const media = light
      ? { url: opts.remoteUrls!.get(p.id) }
      : { file: `photos/${p.fileKey}` };
    return {
      ...media,
      role: p.role,
      alt: p.alt,
      crop: baked ? IDENTITY_CROP : p.crop ? roundCrop(p.crop) : undefined,
      // A legacy off-center focal point is kept as-is for older projects;
      // it never rides along with a baked crop (there is no crop left to
      // be off-center of).
      focus:
        !baked && !p.crop && p.focus && (Math.abs(p.focus.x - 0.5) > 0.01 || Math.abs(p.focus.y - 0.5) > 0.01)
          ? { x: round2(p.focus.x), y: round2(p.focus.y) }
          : undefined,
      // Moving media: the display image is the still (`url`/`file` above);
      // the clip rides along so users can play it back.
      animation: p.animation
        ? light
          ? { url: p.animation.url, kind: p.animation.kind, durationSec: p.animation.durationSec }
          : { file: `photos/${p.animation.fileKey}`, kind: p.animation.kind, durationSec: p.animation.durationSec }
        : undefined,
      credit: creditFromSlot(p),
    };
  };
  return {
    name: exportName ?? (s.commonName || s.sciName),
    layout: s.layout,
    photos: s.photos.map(photoEntry),
    sciName: s.sciName || undefined,
    commonName: s.commonName || undefined,
    altNames: s.altNames.length ? s.altNames : undefined,
    familyCommon: s.familyCommon || undefined,
    familyLatin: s.familyLatin || undefined,
    native: s.native === "unknown" ? undefined : s.native,
    // Border tag: the original red invasive marker stays as `invasive: true`
    // for backwards compatibility; other styles ride on `border`.
    invasive: s.border === "invasive" || undefined,
    border: s.border && s.border !== "none" && s.border !== "invasive" ? s.border : undefined,
    tags: s.tags && s.tags.length > 0 ? s.tags : undefined,
    rarity: s.rarity || null,
    taxonId: s.taxonId,
    credits: s.photos.map((p) => creditFromSlot(p)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundCrop(c: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  return { x: round2(c.x), y: round2(c.y), w: round2(c.w), h: round2(c.h) };
}

/** Manifest + photo bytes (compress optional) — what a playable deck ships,
 *  without history. Shared by the project and deck file exports. Photos are
 *  read (and, with `shrink`, re-encoded) one unique file at a time so a
 *  background job can report progress and cancel between files. */
async function buildPhotoZip(
  project: Project,
  shrink: ShrinkOptions | null,
  run: ExportRunnerOptions = {},
): Promise<{ zip: Zippable; manifest: object }> {
  const files = await listFiles(project.id);

  // One crop window per still fileKey. A file shared by two slots must not
  // carry two different crops; on conflict the key is dropped and that photo
  // ships untouched with its per-slot crop metadata intact (normalized crops
  // stay valid over re-encoded full images, just not over baked ones).
  const cropByKey = shrink ? planCropBakes(project) : new Map<string, CropWindow>();
  const bakedCrops = new Set<string>();

  // Pre-pass: the unique files this deck ships, in manifest order — moving
  // media clips never get re-encoded (a browser can't re-encode GIF/MP4, and
  // their display stills are separate JPEGs).
  const order: string[] = [];
  const seen = new Set<string>();
  const clips = new Set<string>();
  for (const species of project.species) {
    for (const slot of species.photos) {
      if (slot.animation?.fileKey) clips.add(slot.animation.fileKey);
      for (const key of [slot.fileKey, slot.animation?.fileKey]) {
        if (!key || seen.has(key) || !files.has(key)) continue;
        seen.add(key);
        order.push(key);
      }
    }
  }

  const bytesByKey = new Map<string, Uint8Array>();
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    throwIfAborted(run.signal);
    const blob = files.get(key)!;
    run.onProgress?.(i, order.length, `Reading ${key}`);
    let bytes = new Uint8Array(await blobToArrayBuffer(blob));
    if (shrink && !clips.has(key)) {
      run.onProgress?.(i, order.length, `Re-encoding ${key}`);
      const out = await shrinkPhotoBlob(blob, {
        crop: cropByKey.get(key),
        maxEdge: shrink.maxEdge,
        quality: shrink.quality,
      });
      if (out) {
        if (cropByKey.get(key)) bakedCrops.add(key);
        bytes = new Uint8Array(await blobToArrayBuffer(out));
      }
    }
    bytesByKey.set(key, bytes);
  }

  const zip: Zippable = {};
  for (const species of project.species) {
    for (const slot of species.photos) {
      for (const key of [slot.fileKey, slot.animation?.fileKey]) {
        const bytes = key ? bytesByKey.get(key) : undefined;
        if (bytes) zip[`photos/${key}`] = bytes;
      }
    }
  }

  run.onProgress?.(order.length, order.length, "Packing…");
  const manifest = buildManifest(project, shrink ? { bakedCrops } : {});
  zip["manifest.json"] = strToU8Json(manifest);
  return { zip, manifest };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** The full backup: manifest, photos, and the project's git history.
 *  Unzipping yields a real git repository (drop it into decks/ and history
 *  stays intact). The history holds every past photo too — often the biggest
 *  part of the archive — which is exactly why this and the deck file are
 *  separate artifacts. */
export async function exportProjectFile(
  project: Project,
  run: ExportRunnerOptions = {},
): Promise<ExportResult> {
  const { zip, manifest } = await buildPhotoZip(project, null, run);
  try {
    const { collectGitDir } = await import("./versioning");
    const gitDir = await collectGitDir(project.id);
    if (gitDir) {
      for (const [path, data] of gitDir) {
        zip[path] = data;
      }
    }
  } catch {
    // No history available (versioning disabled) — export without .git.
  }
  return pack(zip, manifest, `${sanitizeFileName(project.id)}.zip`);
}

/** The playable deck: manifest + photos, no history. A zip wearing the
 *  `.deck` extension — same layout, minus the repository. */
export async function exportDeckFile(
  project: Project,
  options: DeckExportOptions = {},
): Promise<ExportResult> {
  const { zip, manifest } = await buildPhotoZip(project, options.shrink ?? null, options);
  return pack(zip, manifest, `${sanitizeFileName(project.id)}.deck`);
}

/** The microscopic deck: manifest only, photos referenced by URL and fetched
 *  + cropped on the user's device. Throws (with a per-photo list) when the
 *  deck contains anything a light deck can't ship: photos with no remote
 *  source (uploads, unresolvable iNat picks) or animated media. Resolving
 *  sources for older decks hits the iNat API — progress and cancellation ride
 *  on `run` like every other export. */
export async function exportLightDeck(
  project: Project,
  run: ExportRunnerOptions = {},
): Promise<ExportResult> {
  const { urls, unresolved, apiFailed } = await backfillPhotoUrls(project, {
    onProgress: (resolved, remaining) =>
      run.onProgress?.(resolved, resolved + remaining, "Resolving photo sources"),
    signal: run.signal,
  });
  throwIfAborted(run.signal);
  if (apiFailed) {
    throw new Error(
      `iNaturalist couldn't be reached while resolving photo sources ` +
        `(${unresolved.length} photo${unresolved.length === 1 ? "" : "s"} still unknown) — ` +
        `try again in a minute.`,
    );
  }
  const issues: string[] = [];
  for (const species of project.species) {
    const card = species.commonName || species.sciName || "card";
    for (const slot of species.photos) {
      if (slot.animation) {
        issues.push(`${card}: animated media can't ship in a light deck (the display still is captured locally)`);
        continue;
      }
      if (!slot.url && !urls.has(slot.id)) {
        issues.push(`${card}: the ${slot.role} photo has no remote source to fetch at runtime`);
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(
      `This deck can't export as a light deck yet:\n${issues.map((i) => `• ${i}`).join("\n")}`,
    );
  }

  const remoteUrls = new Map<string, string>();
  for (const species of project.species) {
    for (const slot of species.photos) {
      remoteUrls.set(slot.id, slot.url ?? urls.get(slot.id)!);
    }
  }
  // `format: "lite"` marks the deck as remote-media: consumers can detect it
  // without inspecting photo entries (whose `url` replaces `file`).
  const manifest = { ...buildManifest(project, { remoteUrls }), format: "lite" };
  const zip: Zippable = { "manifest.json": strToU8Json(manifest) };
  return pack(zip, manifest, `${sanitizeFileName(project.id)}.deck.lite`);
}

function pack(zip: Zippable, manifest: object, filename: string): ExportResult {
  const packed = zipSync(zip, { level: 6 });
  const blob = new Blob([packed as unknown as BlobPart], { type: "application/zip" });
  return { blob, filename, manifest };
}

/** The crop window carried by each still's fileKey, for baking at export.
 *  Keys with no crop, and keys whose sharers disagree on the crop, are
 *  absent (pass through untouched, metadata unchanged). Exported for tests. */
export function planCropBakes(project: Project): Map<string, CropWindow> {
  const out = new Map<string, CropWindow>();
  for (const species of project.species) {
    for (const slot of species.photos) {
      if (!slot.crop) continue;
      const existing = out.get(slot.fileKey);
      if (existing === undefined) {
        out.set(slot.fileKey, slot.crop);
      } else if (!sameCrop(existing, slot.crop)) {
        out.delete(slot.fileKey);
      }
    }
  }
  return out;
}

function sameCrop(a?: CropWindow, b?: CropWindow): boolean {
  if (!a || !b) return false;
  const eps = 1e-4;
  return (
    Math.abs(a.x - b.x) < eps &&
    Math.abs(a.y - b.y) < eps &&
    Math.abs(a.w - b.w) < eps &&
    Math.abs(a.h - b.h) < eps
  );
}

function strToU8Json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}
