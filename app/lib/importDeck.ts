import { unzipSync } from "fflate";
import type { Project, SpeciesEntry, PhotoSlot, BorderStyle } from "./types";
import { makeSpecies } from "./types";
import { makeId, uniqueId } from "./ids";
import { putFile, mimeForFileKey } from "./store";
import { blobToArrayBuffer } from "./blobUtils";

/**
 * Import a deck archive (the zip Deck Curator exports, or any manifest.json +
 * photos/ archive in the DECK_FORMAT.md shape) back into a curation project.
 * Photos land in the project's file store; cards map back to editable
 * species, including crop windows and credits.
 */

interface ManifestPhoto {
  id?: string;
  file: string;
  role?: string;
  alt?: string;
  crop?: { x: number; y: number; w: number; h: number };
  focus?: { x: number; y: number };
  animation?: { file: string; kind: string; durationSec?: number };
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
  tags?: string[];
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

interface ManifestLocation {
  name?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}

interface Manifest {
  id?: string;
  label?: string;
  description?: string;
  location?: ManifestLocation;
  cardFormat?: string;
  /** "lite" = light deck: photos referenced remotely, nothing bundled. */
  format?: string;
  categories?: Array<{ id: string; label: string; cards: ManifestCard[] }>;
}

const BORDER_IDS: BorderStyle[] = ["none", "invasive", "caution", "rare", "notable"];

/** True for a JSON object — manifest entries come from outside (a
 *  third-party archive, a hand-edited file) and must never crash the
 *  importer mid-loop. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Crop windows are normalized 0..1 rects, and cardGeometry divides their
 *  width/height into CSS sizes — a malformed one (w: 0, a NaN coordinate,
 *  out-of-bounds) would render Infinity/NaN sizes in the editor and preview.
 *  Anything not a sane window drops the crop; the photo renders whole
 *  instead of shipping garbage. */
function cropFromManifest(value: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, w, h } = value;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) return undefined;
  if (w <= 0 || h <= 0) return undefined;
  const eps = 1e-6;
  if (x < -eps || y < -eps || x + w > 1 + eps || y + h > 1 + eps) return undefined;
  return { x, y, w, h };
}

/** Manifest photo → slot; null when the entry is unusable (not an object,
 *  or no file path to store bytes under). A manifest-provided stable slot
 *  id (`id`) is kept when unique — it preserves the iNat link that the
 *  light-deck exporter maps by slot id across an archive round trip. */
function slotFromManifest(
  photo: ManifestPhoto,
  uniqueSlotId: (file: string) => string,
  slotFiles: Map<string, string>,
): PhotoSlot | null {
  if (typeof photo.file !== "string" || photo.file === "") return null;
  let slotId: string;
  if (typeof photo.id === "string" && photo.id !== "" && !slotFiles.has(photo.id)) {
    slotId = photo.id;
  } else {
    slotId = uniqueSlotId(photo.file);
  }
  slotFiles.set(slotId, photo.file);
  const slot: PhotoSlot = {
    id: slotId,
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
  const crop = cropFromManifest(photo.crop);
  if (crop) slot.crop = crop;
  else if (isRecord(photo.focus) && Number.isFinite(photo.focus.x) && Number.isFinite(photo.focus.y)) {
    slot.focus = { x: photo.focus.x, y: photo.focus.y };
  }
  // The clip rides along; the archive importer resolves its fileKey
  // when it stores the bytes (the marker form keeps it findable).
  if (isRecord(photo.animation) && typeof photo.animation.file === "string") {
    slot.animation = {
      fileKey: `import:${photo.animation.file}`,
      kind: photo.animation.kind === "gif" ? "gif" : "video",
      durationSec: photo.animation.durationSec,
    };
  }
  return slot;
}

/** The deck's categories, rebuilt from a manifest: entries that aren't
 *  objects or have no usable id are dropped (the importer must never
 *  manufacture `undefined` keys), duplicate ids keep their first label —
 *  duplicates would otherwise emit the same species list under each copy
 *  on re-export, breaking the manifest's deck-wide unique-name contract. */
function categoriesFromManifest(value: unknown): Array<{ id: string; label: string }> {
  const list = Array.isArray(value) ? value : [];
  const out = new Map<string, string>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const { id, label } = entry as { id?: unknown; label?: unknown };
    if (typeof id !== "string" || id === "") continue;
    if (!out.has(id)) out.set(id, typeof label === "string" ? label : id);
  }
  return [...out].map(([id, label]) => ({ id, label }));
}

/** Manifest → species mapping (pure, testable). Photo fileKeys are left
 *  empty — the archive importer fills them when it stores each blob. Slot
 *  ids carry the manifest file (the archive importer parses it back out)
 *  plus a `#n` suffix when one card repeats a file — React keys slot lists
 *  by id, and the light-deck exporter maps remote URLs by id, so duplicates
 *  would merge distinct slots. Malformed entries — non-object photos or
 *  cards, unusable crop windows — are skipped, so a hand-edited archive
 *  imports what it can instead of dying halfway through. */
export function speciesFromManifest(manifest: Manifest): {
  species: SpeciesEntry[];
  categories: Array<{ id: string; label: string }>;
  slotFiles: Map<string, string>;
} {
  const categoriesIn = Array.isArray(manifest.categories) ? manifest.categories : [];
  const categories = categoriesFromManifest(categoriesIn);
  const species: SpeciesEntry[] = [];
  const slotFiles = new Map<string, string>();
  const usedSlotIds = new Set<string>();
  const uniqueSlotId = (manifestFile: string): string => {
    let id = `import:${manifestFile}`;
    for (let n = 2; usedSlotIds.has(id); n++) id = `import:${manifestFile}#${n}`;
    usedSlotIds.add(id);
    return id;
  };
  for (const category of categoriesIn) {
    if (!isRecord(category)) continue;
    const cat = category as unknown as { id: string; label: string; cards: ManifestCard[] };
    // A category without a usable id can't key its cards — they land in the
    // importer's catch-all "" group instead of carrying an undefined id
    // that would never match a category on re-export.
    const categoryId = typeof cat.id === "string" ? cat.id : "";
    const cards = Array.isArray(cat.cards) ? cat.cards : [];
    for (const card of cards) {
      if (!isRecord(card)) continue;
      const c = card as unknown as ManifestCard;
      const photos: PhotoSlot[] = (Array.isArray(c.photos) ? c.photos : [])
        .filter((p): p is ManifestPhoto => isRecord(p))
        .flatMap((p) => {
          const slot = slotFromManifest(p, uniqueSlotId, slotFiles);
          return slot ? [slot] : [];
        });
      // Variant cards export names like "Name (2)"; the clean species name is
      // the back's commonName when present.
      const rawName = c.commonName ?? c.name;
      const cleanName = (typeof rawName === "string" ? rawName : String(rawName ?? "")).replace(/ \(\d+\)$/, "");
      const border: BorderStyle =
        c.border === "invasive" || c.invasive === true
          ? "invasive"
          : BORDER_IDS.includes(c.border as BorderStyle)
            ? (c.border as BorderStyle)
            : "none";
      species.push(
        makeSpecies({
          category: categoryId,
          commonName: cleanName,
          sciName: c.sciName ?? "",
          altNames: Array.isArray(c.altNames) ? c.altNames : [],
          familyCommon: c.familyCommon,
          familyLatin: c.familyLatin,
          native: c.native === "native" || c.native === "non-native" ? c.native : "unknown",
          border,
          rarity: c.rarity ?? undefined,
          taxonId: c.taxonId,
          layout: c.layout === "photo-single" ? "photo-single" : "photo-trio",
          tags: Array.isArray(c.tags) ? c.tags : [],
          photos,
          inatResolved: c.taxonId != null,
        }),
      );
    }
  }
  return { species, categories, slotFiles };
}

export async function importDeckArchive(
  file: File,
  opts: { existingIds?: Iterable<string> } = {},
): Promise<Project> {
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
  // JSON.parse accepts scalars: a manifest of `null` would crash the
  // field checks below with a raw TypeError instead of a useful message.
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`"${file.name}" has an unreadable manifest.json.`);
  }
  if (!manifest.id || !Array.isArray(manifest.categories)) {
    throw new Error(`"${file.name}" is not a deck archive (manifest is missing id/categories).`);
  }
  // Light decks reference their photos by URL — importing one here would
  // produce cards with no image data and no way to re-fetch the exact
  // photos. Send people to the full artifact instead.
  if (manifest.format === "lite") {
    throw new Error(
      `"${file.name}" is a light deck (photos fetched at runtime, not bundled) — ` +
        `import the full .deck or .zip file instead.`,
    );
  }

  // The manifest's id is the deck's store key — never clobber an existing
  // deck that already uses it; uniquify instead.
  const deckId = uniqueId(
    makeId(manifest.id || file.name.replace(/\.(zip|deck(?:\.lite)?)$/i, "")),
    opts.existingIds ?? [],
  );
  const now = new Date().toISOString();
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const loc = isRecord(manifest.location) ? manifest.location : undefined;
  const label = isStr(manifest.label) && manifest.label.trim() ? manifest.label : deckId;
  const project: Project = {
    schemaVersion: 1,
    id: deckId,
    name: label,
    deckLabel: label,
    description: isStr(manifest.description) ? manifest.description : "",
    location: loc
      ? {
          name: isStr(loc.name) && loc.name.trim() ? loc.name : undefined,
          lat: isNum(loc.lat) ? loc.lat : undefined,
          lng: isNum(loc.lng) ? loc.lng : undefined,
          radiusKm: isNum(loc.radiusKm) ? loc.radiusKm : undefined,
        }
      : undefined,
    categories: categoriesFromManifest(manifest.categories),
    species: [],
    createdAt: now,
    updatedAt: now,
  };

  const decode = (name: string): string => {
    try { return decodeURIComponent(name); } catch { return name; }
  };
  const usedFileKeys = new Set<string>();
  const { species, slotFiles } = speciesFromManifest(manifest);

  for (const entry of species) {
    for (const slot of entry.photos) {
      // Slot ids carrying a manifest-provided id are mapped explicitly; the
      // `import:<file>` scheme (with optional `#n` dedupe suffix) is parsed
      // back out for legacy slots.
      const manifestFile = slotFiles.get(slot.id) ?? slot.id.slice("import:".length).replace(/#\d+$/, "");
      const raw = entries[manifestFile] ?? entries[decode(manifestFile)];
      const base = manifestFile.split("/").pop() ?? "photo.jpg";
      let fileKey = base;
      for (let i = 2; usedFileKeys.has(fileKey); i++) fileKey = `${i}-${base}`;
      usedFileKeys.add(fileKey);
      slot.fileKey = fileKey;
      if (raw) {
        await putFile(project.id, fileKey, new Blob([raw as BlobPart], { type: mimeForFileKey(fileKey) }));
      }
      // The slot's animation clip: store its bytes too (import/export are
      // symmetric — the manifest carries `animation`), or the re-imported
      // deck silently loses every clip.
      if (slot.animation) {
        const animManifest = slot.animation.fileKey.slice("import:".length);
        const animRaw = entries[animManifest] ?? entries[decode(animManifest)];
        const animBase = animManifest.split("/").pop() ?? "clip.mp4";
        let animKey = animBase;
        for (let i = 2; usedFileKeys.has(animKey); i++) animKey = `${i}-${animBase}`;
        usedFileKeys.add(animKey);
        if (animRaw) {
          await putFile(project.id, animKey, new Blob([animRaw as BlobPart], { type: mimeForFileKey(animKey) }));
        }
        slot.animation.fileKey = animKey;
      }
    }
    project.species.push(entry);
  }

  // Every category id referenced by the imported cards must exist in the
  // project's category list: buildManifest filters species by category id,
  // so a dangling reference would silently drop the card on re-export.
  const referencedCats = new Set(project.species.map((s) => s.category));
  for (const cid of referencedCats) {
    if (!project.categories.some((c) => c.id === cid)) {
      project.categories.push({ id: cid, label: cid || "Uncategorized" });
    }
  }

  // The archive doubles as a git repository (export ships .git/) — restore
  // its history under the (possibly uniquified) deck id so named versions
  // survive an export → import round trip. Best-effort: an archive without
  // .git (third-party deck) simply has no history.
  const gitEntries = Object.keys(entries).filter((k) => k.startsWith(".git/") && entries[k].length > 0);
  if (gitEntries.length > 0) {
    try {
      const { writeGitDir } = await import("./versioning");
      await writeGitDir(
        deckId,
        new Map(gitEntries.map((path) => [path, entries[path]])),
      );
    } catch (err) {
      console.warn("Deck history could not be restored from the archive:", err);
    }
  }

  return project;
}
