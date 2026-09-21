import { unzipSync } from "fflate";
import type { Project, SpeciesEntry, PhotoSlot, BorderStyle } from "./types";
import { makeSpecies } from "./types";
import { makeId } from "./ids";
import { putFile } from "./store";
import { blobToArrayBuffer } from "./blobUtils";

/**
 * Import a deck archive (the zip Deck Curator exports, or any manifest.json +
 * photos/ archive in the DECK_FORMAT.md shape) back into a curation project.
 * Photos land in the project's file store; cards map back to editable
 * species, including crop windows and credits.
 */

interface ManifestPhoto {
  file: string;
  role?: string;
  alt?: string;
  crop?: { x: number; y: number; w: number; h: number };
  focus?: { x: number; y: number };
  credit?: {
    observer?: string;
    license?: string;
    sourceUrl?: string;
    observationUrl?: string;
    observationId?: number;
    placeLabel?: string;
  };
}

interface ManifestCard {
  name: string;
  layout?: string;
  photos?: ManifestPhoto[];
  sciName?: string;
  commonName?: string;
  altNames?: string[];
  familyCommon?: string;
  familyLatin?: string;
  native?: string;
  invasive?: boolean;
  border?: string;
  rarity?: string | null;
  taxonId?: number;
}

interface Manifest {
  id?: string;
  label?: string;
  description?: string;
  cardFormat?: string;
  categories?: Array<{ id: string; label: string; cards: ManifestCard[] }>;
}

const BORDER_IDS: BorderStyle[] = ["none", "invasive", "caution", "rare", "notable"];

/** Manifest → species mapping (pure, testable). Photo fileKeys are left
 *  empty — the archive importer fills them when it stores each blob. */
export function speciesFromManifest(manifest: Manifest): {
  species: SpeciesEntry[];
  categories: Array<{ id: string; label: string }>;
} {
  const categories = (manifest.categories ?? []).map((c) => ({ id: c.id, label: c.label }));
  const species: SpeciesEntry[] = [];
  for (const category of manifest.categories ?? []) {
    for (const card of category.cards) {
      const photos: PhotoSlot[] = (card.photos ?? []).map((photo) => {
        const slot: PhotoSlot = {
          id: `import:${photo.file}`,
          role: photo.role === "secondary" ? "secondary" : "main",
          credit: {
            observer: photo.credit?.observer ?? "unknown",
            license: photo.credit?.license ?? "",
            sourceUrl: photo.credit?.observationUrl ?? photo.credit?.sourceUrl,
            observationId: photo.credit?.observationId,
            placeLabel: photo.credit?.placeLabel,
          },
          fileKey: "",
          alt: photo.alt,
        };
        if (photo.crop) slot.crop = { ...photo.crop };
        else if (photo.focus) slot.focus = { ...photo.focus };
        return slot;
      });
      // Variant cards export names like "Name (2)"; the clean species name is
      // the back's commonName when present.
      const cleanName = (card.commonName ?? card.name).replace(/ \(\d+\)$/, "");
      const border: BorderStyle =
        card.border === "invasive" || card.invasive === true
          ? "invasive"
          : BORDER_IDS.includes(card.border as BorderStyle)
            ? (card.border as BorderStyle)
            : "none";
      species.push(
        makeSpecies({
          category: category.id,
          commonName: cleanName,
          sciName: card.sciName ?? "",
          altNames: card.altNames ?? [],
          familyCommon: card.familyCommon,
          familyLatin: card.familyLatin,
          native: card.native === "native" || card.native === "non-native" ? card.native : "unknown",
          border,
          rarity: card.rarity ?? undefined,
          taxonId: card.taxonId,
          layout: card.layout === "photo-single" ? "photo-single" : "photo-trio",
          photos,
          inatResolved: card.taxonId != null,
        }),
      );
    }
  }
  return { species, categories };
}

export async function importDeckArchive(file: File): Promise<Project> {
  const archiveBytes = new Uint8Array(await blobToArrayBuffer(file));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archiveBytes);
  } catch {
    throw new Error(`"${file.name}" is not a readable zip archive.`);
  }
  const manifestEntry = entries["manifest.json"];
  if (!manifestEntry) {
    throw new Error(`"${file.name}" has no manifest.json at the archive root — is it a deck archive?`);
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as Manifest;
  } catch {
    throw new Error(`"${file.name}" has an unreadable manifest.json.`);
  }
  if (!manifest.id || !Array.isArray(manifest.categories)) {
    throw new Error(`"${file.name}" is not a deck archive (manifest is missing id/categories).`);
  }

  const deckId = makeId(manifest.id || file.name.replace(/\.zip$/i, ""));
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: 1,
    id: deckId,
    name: manifest.label ?? deckId,
    deckLabel: manifest.label ?? deckId,
    description: manifest.description ?? "",
    categories: (manifest.categories ?? []).map((c) => ({ id: c.id, label: c.label })),
    species: [],
    createdAt: now,
    updatedAt: now,
  };

  const decode = (name: string): string => {
    try { return decodeURIComponent(name); } catch { return name; }
  };
  const usedFileKeys = new Set<string>();
  const { species } = speciesFromManifest(manifest);

  for (const entry of species) {
    for (const slot of entry.photos) {
      const manifestFile = slot.id.slice("import:".length);
      const raw = entries[manifestFile] ?? entries[decode(manifestFile)];
      const base = manifestFile.split("/").pop() ?? "photo.jpg";
      let fileKey = base;
      for (let i = 2; usedFileKeys.has(fileKey); i++) fileKey = `${i}-${base}`;
      usedFileKeys.add(fileKey);
      slot.fileKey = fileKey;
      if (raw) {
        await putFile(project.id, fileKey, new Blob([raw as BlobPart], { type: "image/jpeg" }));
      }
    }
    project.species.push(entry);
  }

  return project;
}
