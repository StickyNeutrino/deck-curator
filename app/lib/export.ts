import { zipSync, type Zippable } from "fflate";
import type { Project, SpeciesEntry } from "./types";
import { creditFromSlot } from "./types";
import { sanitizeFileName } from "./ids";
import { listFiles } from "./store";
import { blobToArrayBuffer } from "./blobUtils";

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

export function buildManifest(project: Project): object {
  const exportNames = cardExportNames(project);
  const categories = project.categories
    .map((cat) => ({
      id: cat.id,
      label: cat.label,
      cards: project.species
        .filter((s) => s.category === cat.id)
        .map((s) => cardFromSpecies(s, exportNames.get(s.id) ?? (s.commonName || s.sciName))),
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
  const names = new Map<string, string>();
  for (const s of project.species) {
    const base = (s.commonName || s.sciName || "Card").trim();
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    names.set(s.id, n === 0 ? base : `${base} (${n + 1})`);
  }
  return names;
}

export function cardFromSpecies(s: SpeciesEntry, exportName?: string): object {
  return {
    name: exportName ?? (s.commonName || s.sciName),
    layout: s.layout,
    photos: s.photos.map((p) => ({
      file: `photos/${p.fileKey}`,
      role: p.role,
      alt: p.alt,
      // Crop window (normalized) when it differs from the default cover; a
      // legacy off-center focal point is kept as-is for older projects.
      crop: p.crop ? roundCrop(p.crop) : undefined,
      focus: !p.crop && p.focus && (Math.abs(p.focus.x - 0.5) > 0.01 || Math.abs(p.focus.y - 0.5) > 0.01)
        ? { x: round2(p.focus.x), y: round2(p.focus.y) }
        : undefined,
      // Moving media: the display image is `file` (the picked still); the
      // clip itself is included so players can offer playback.
      animation: p.animation
        ? { file: `photos/${p.animation.fileKey}`, kind: p.animation.kind, durationSec: p.animation.durationSec }
        : undefined,
      credit: creditFromSlot(p),
    })),
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

export async function exportDeck(project: Project): Promise<ExportResult> {
  const manifest = buildManifest(project);
  const files = await listFiles(project.id);
  const zip: Zippable = {
    "manifest.json": strToU8Json(manifest),
  };
  for (const species of project.species) {
    for (const slot of species.photos) {
      for (const key of [slot.fileKey, slot.animation?.fileKey]) {
        if (!key) continue;
        const blob = files.get(key);
        if (blob) {
          zip[`photos/${key}`] = new Uint8Array(await blobToArrayBuffer(blob));
        }
      }
    }
  }
  // Ship the project's git history inside the archive: unzipping yields a
  // real git repository (drop it into decks/ and history stays intact).
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
  const packed = zipSync(zip, { level: 6 });
  const blob = new Blob([packed as unknown as BlobPart], { type: "application/zip" });
  return { blob, filename: `${sanitizeFileName(project.id)}.zip`, manifest };
}

function strToU8Json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}
