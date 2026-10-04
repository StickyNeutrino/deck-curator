import { zipSync, type Zippable } from "fflate";
import type { Project, SpeciesEntry } from "./types";
import { creditFromSlot } from "./types";
import { sanitizeFileName } from "./ids";
import { listFiles } from "./store";
import { blobToArrayBuffer } from "./blobUtils";
import { shrinkPhotoBlob, type CropWindow } from "./imageShrink";

/**
 * Export a Project to the deck archive described in docs/DECK_FORMAT.md:
 * a zip with manifest.json + photos/<slug>-{main,secondary-N}.jpg.
 * The manifest is written in the data-card format the flashcard app renders.
 */

export interface ExportResult {
  blob: Blob;
  filename: string;
  manifest: unknown;
}

/** Options for exportDeck; every field defaults to the historical behavior. */
export interface ExportOptions {
  /** Bundle the deck's git history (the .git/ directory) so the archive
   *  doubles as a restorable repository. Default true — it's what makes an
   *  export → import round trip keep every version, but it also ships every
   *  past photo, which can dwarf the deck itself; lean shares turn it off. */
  includeHistory?: boolean;
  /** Re-encode stills to smaller JPEGs (crop baked in, long edge capped).
   *  Animation clips pass through unchanged. Default off. */
  shrink?: { maxEdge: number; quality: number } | null;
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
  return {
    name: exportName ?? (s.commonName || s.sciName),
    layout: s.layout,
    photos: s.photos.map((p) => {
      // The crop is baked into the shipped pixels for these stills, so the
      // manifest describes the file itself as the crop region.
      const baked = opts.bakedCrops?.has(p.fileKey) ?? false;
      return {
        file: `photos/${p.fileKey}`,
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
        // Moving media: the display image is `file` (the picked still); the
        // clip itself is included so players can offer playback.
        animation: p.animation
          ? { file: `photos/${p.animation.fileKey}`, kind: p.animation.kind, durationSec: p.animation.durationSec }
          : undefined,
        credit: creditFromSlot(p),
      };
    }),
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

export async function exportDeck(project: Project, options: ExportOptions = {}): Promise<ExportResult> {
  const includeHistory = options.includeHistory ?? true;
  const shrink = options.shrink ?? null;
  const files = await listFiles(project.id);

  // One crop window per still fileKey. A file shared by two slots must not
  // carry two different crops; on conflict the key is dropped and that photo
  // ships untouched with its per-slot crop metadata intact (normalized crops
  // stay valid over re-encoded full images, just not over baked ones).
  const cropByKey = shrink ? planCropBakes(project) : new Map<string, CropWindow>();
  const bakedCrops = new Set<string>();

  const zip: Zippable = {};
  const bytesByKey = new Map<string, Uint8Array>();
  for (const species of project.species) {
    for (const slot of species.photos) {
      for (const key of [slot.fileKey, slot.animation?.fileKey]) {
        if (!key) continue;
        if (!bytesByKey.has(key)) {
          const blob = files.get(key);
          if (!blob) continue; // Missing from the store — skip, as before.
          // Animation clips (GIF/MP4) always pass through: a browser can't
          // re-encode them, and their display stills are separate JPEGs.
          const isClip = key === slot.animation?.fileKey;
          let out: Blob | null = null;
          if (shrink && !isClip) {
            out = await shrinkPhotoBlob(blob, {
              crop: cropByKey.get(key),
              maxEdge: shrink.maxEdge,
              quality: shrink.quality,
            });
          }
          if (out) {
            if (cropByKey.get(key)) bakedCrops.add(key);
            bytesByKey.set(key, new Uint8Array(await blobToArrayBuffer(out)));
          } else {
            bytesByKey.set(key, new Uint8Array(await blobToArrayBuffer(blob)));
          }
        }
        const bytes = bytesByKey.get(key);
        if (bytes) zip[`photos/${key}`] = bytes;
      }
    }
  }

  const manifest = buildManifest(project, shrink ? { bakedCrops } : {});
  zip["manifest.json"] = strToU8Json(manifest);
  // Ship the project's git history inside the archive: unzipping yields a
  // real git repository (drop it into decks/ and history stays intact).
  // Optional because the history holds every past photo too — often the
  // biggest part of the archive. When included, the history keeps the
  // original photos even for a shrunk export.
  if (includeHistory) {
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
  }
  const packed = zipSync(zip, { level: 6 });
  const blob = new Blob([packed as unknown as BlobPart], { type: "application/zip" });
  return { blob, filename: `${sanitizeFileName(project.id)}.zip`, manifest };
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
