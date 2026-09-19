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
  const categories = project.categories
    .map((cat) => ({
      id: cat.id,
      label: cat.label,
      cards: project.species
        .filter((s) => s.category === cat.id)
        .map((s) => cardFromSpecies(s)),
    }))
    .filter((cat) => cat.cards.length > 0 || project.species.some((s) => s.category === cat.id));

  return {
    id: project.id,
    label: project.deckLabel,
    description: project.description,
    cardFormat: "data",
    generator: { tool: "deck-curator", version: "1.0.0", exportedAt: new Date().toISOString() },
    categories,
  };
}

export function cardFromSpecies(s: SpeciesEntry): object {
  return {
    name: s.commonName || s.sciName,
    layout: s.layout,
    photos: s.photos.map((p) => ({
      file: `photos/${p.fileKey}`,
      role: p.role,
      alt: p.alt,
      credit: creditFromSlot(p),
    })),
    sciName: s.sciName || undefined,
    commonName: s.commonName || undefined,
    altNames: s.altNames.length ? s.altNames : undefined,
    familyCommon: s.familyCommon || undefined,
    familyLatin: s.familyLatin || undefined,
    native: s.native === "unknown" ? undefined : s.native,
    invasive: s.invasive || undefined,
    rarity: s.rarity || null,
    taxonId: s.taxonId,
    credits: s.photos.map((p) => creditFromSlot(p)),
  };
}

export async function exportDeck(project: Project): Promise<ExportResult> {
  const manifest = buildManifest(project);
  const files = await listFiles(project.id);
  const zip: Zippable = {
    "manifest.json": strToU8Json(manifest),
  };
  for (const species of project.species) {
    for (const slot of species.photos) {
      const blob = files.get(slot.fileKey);
      if (blob) {
        zip[`photos/${slot.fileKey}`] = new Uint8Array(await blobToArrayBuffer(blob));
      }
    }
  }
  const packed = zipSync(zip, { level: 6 });
  const blob = new Blob([packed as unknown as BlobPart], { type: "application/zip" });
  return { blob, filename: `${sanitizeFileName(project.id)}.zip`, manifest };
}

function strToU8Json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}
