/**
 * Deck Curator's data model.
 *
 * A Project is the working state of one curated deck. Exporting produces the
 * archive described in docs/DECK_FORMAT.md; every field here maps onto that
 * manifest, plus curation-only extras (notes, ids).
 */

import { uuid } from "./uuid";

/** iNaturalist license_code vocabulary. ND variants and missing licenses are
 *  rejected for iNat photos (same policy as the Healthy Canyons pipeline);
 *  user uploads may also be "all-rights-reserved". */
/** License preference order for iNat photo picking: most permissive first.
 *  CC0 and plain BY over share-alike, and all of those over NC variants
 *  (iNat skews NC-heavy, so without explicit preference the restrictive
 *  licenses dominate top-voted results). */
export const LICENSE_PREFERENCE = [
  "cc0",
  "cc-by",
  "cc-by-sa",
  "cc-by-nc",
  "cc-by-nc-sa",
] as const;

/** ND variants and missing licenses are rejected for iNat photos (same
 *  policy as the Healthy Canyons pipeline). */
export const INAT_ALLOWED_LICENSES = LICENSE_PREFERENCE;

export const UPLOAD_LICENSES = [...INAT_ALLOWED_LICENSES, "cc-by-nd", "cc-by-nc-nd", "all-rights-reserved"] as const;

export type LicenseCode = (typeof UPLOAD_LICENSES)[number];

/** A deck's iNaturalist search constraints — who can use the finished deck
 *  drives which licenses are acceptable, and how strict the observations
 *  filter is. Saved on the Project so a deck remembers its rules. */
export interface InatSearchSettings {
  /** Acceptable iNat license codes (subset of INAT_ALLOWED_LICENSES).
   *  Default: all of them. Excluding NC variants makes a deck sellable. */
  licenses: LicenseCode[];
  /** Only research-grade observations (community-confirmed ID). */
  researchGrade: boolean;
  /** Include animated GIFs / video clips as candidate media. */
  includeMedia: boolean;
  /** Photo ordering: permissive-license-first (default) or raw iNat votes. */
  orderBy: "license" | "votes";
}

export const DEFAULT_SEARCH_SETTINGS: InatSearchSettings = {
  licenses: [...INAT_ALLOWED_LICENSES],
  researchGrade: false,
  includeMedia: false,
  orderBy: "license",
};

/** Fill in any missing fields (older projects, partial JSON). */
export function searchSettingsOf(project: Pick<Project, "inatSearch">): InatSearchSettings {
  return { ...DEFAULT_SEARCH_SETTINGS, ...project.inatSearch };
}

export type NativeStatus = "native" | "non-native" | "unknown";

/** Card border styles — the colored tag the flashcards app draws around a
 *  card. "invasive" is the original red invasive marker; the others are
 *  curator-chosen emphasis colors (exported as manifest `border`). */
export type BorderStyle = "none" | "invasive" | "caution" | "rare" | "notable";

export interface BorderStyleDef {
  id: BorderStyle;
  label: string;
  color: string;
}

export const BORDER_STYLES: BorderStyleDef[] = [
  { id: "none", label: "None", color: "transparent" },
  { id: "invasive", label: "Invasive", color: "#b3261e" },
  { id: "caution", label: "Caution", color: "#b45309" },
  { id: "rare", label: "Rare", color: "#6d28d9" },
  { id: "notable", label: "Notable", color: "#1d4ed8" },
];

export function borderStyleDef(style: BorderStyle | undefined): BorderStyleDef {
  return BORDER_STYLES.find((b) => b.id === style) ?? BORDER_STYLES[0];
}

/** "photo-trio": 1 main + up to 2 secondary photos (the Healthy Canyons look).
 *  "photo-single": one main photo only. */
export type CardLayout = "photo-trio" | "photo-single";

export interface PhotoCredit {
  /** Copyright holder: iNat username or the photographer's name. */
  observer: string;
  /** iNaturalist license_code vocabulary, or "all-rights-reserved" for uploads. */
  license: string;
  /** Where the photo came from (observation page, source site …). */
  sourceUrl?: string;
  /** iNaturalist observation id, when the photo came from iNat. */
  observationId?: number;
  /** Where the observation was made (shown on the credits page). */
  placeLabel?: string;
}

export interface PhotoSlot {
  /** Stable id: `inat:<photoId>` for iNat picks, `upload:<uuid>` for uploads. */
  id: string;
  role: "main" | "secondary";
  credit: PhotoCredit;
  /** Key into the project's file store (the Blob lives in IndexedDB). */
  fileKey: string;
  alt?: string;
  /** Crop window over the source image, normalized 0..1. When absent the
   *  photo is cover-cropped centered. The editor picks the bounds; the
   *  renderer maps exactly this region onto the slot. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Legacy focal point from earlier exports; superseded by crop. */
  focus?: { x: number; y: number };
  /** When the media moves (animated GIF or video clip): the stored clip.
   *  `fileKey` (above) is the still frame the curator picked — that's what
   *  every renderer displays. */
  animation?: { fileKey: string; kind: "gif" | "video"; durationSec?: number };
}

export interface SpeciesEntry {
  id: string;
  category: string;
  commonName: string;
  sciName: string;
  altNames: string[];
  familyCommon?: string;
  familyLatin?: string;
  native: NativeStatus;
  /** Colored card border tag (see BORDER_STYLES); "invasive" is the red one. */
  border: BorderStyle;
  rarity?: string;
  taxonId?: number;
  layout: CardLayout;
  /** Free-form user tags (phases, classes, units) — exported per card and
   *  filterable in the curator. */
  tags: string[];
  /** Curator-only flag for the review page ("go through these again"). */
  needsReview?: boolean;
  /** Main photo first, secondaries after. */
  photos: PhotoSlot[];
  notes?: string;
  /** True once the name has been resolved against iNaturalist. */
  inatResolved?: boolean;
}

export interface ProjectCategory {
  id: string;
  label: string;
}

export interface Project {
  schemaVersion: 1;
  id: string;
  /** Working title inside the curator (not exported). */
  name: string;
  /** Exported deck label (emoji allowed). */
  deckLabel: string;
  description: string;
  /** Where this deck is relevant — exported into the manifest. */
  location?: DeckLocation;
  /** How specific auto-categorization from iNat taxonomy gets:
   *  "standard" = Plants/Fungi/Animals, "fine" = Birds/Mammals/Insects/…. */
  granularity?: "standard" | "fine";
  categories: ProjectCategory[];
  species: SpeciesEntry[];
  /** iNaturalist search constraints (licenses, quality grade, media). */
  inatSearch?: InatSearchSettings;
  createdAt: string;
  updatedAt: string;
}

/** A deck's geographic scope: a name (geocodable) and/or coordinates. */
export interface DeckLocation {
  name?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
}

export function makeCategory(id: string, label: string): ProjectCategory {
  return { id, label };
}

export function makeSpecies(partial: Partial<SpeciesEntry> = {}): SpeciesEntry {
  return {
    id: partial.id ?? uuid(),
    category: partial.category ?? "",
    commonName: partial.commonName ?? "",
    sciName: partial.sciName ?? "",
    altNames: partial.altNames ?? [],
    familyCommon: partial.familyCommon,
    familyLatin: partial.familyLatin,
    native: partial.native ?? "unknown",
    border: partial.border ?? "none",
    rarity: partial.rarity,
    taxonId: partial.taxonId,
    layout: partial.layout ?? "photo-trio",
    tags: partial.tags ?? [],
    photos: partial.photos ?? [],
    notes: partial.notes,
    inatResolved: partial.inatResolved,
  };
}

/** True when a species carries the original red invasive marker. */
export function isInvasive(s: Pick<SpeciesEntry, "border">): boolean {
  return s.border === "invasive";
}

/** Migrate older project records: the boolean `invasive` tag became the
 *  border-style enum. Mutates and returns the given project. */
export function migrateProject(project: Project): Project {
  for (const s of project.species) {
    const legacy = (s as unknown as { invasive?: boolean }).invasive;
    if (legacy === true && (!s.border || s.border === "none")) {
      s.border = "invasive";
    }
    delete (s as unknown as { invasive?: boolean }).invasive;
  }
  return project;
}

/** The credit data exported onto the manifest's flattened `credits` list. */
export function creditFromSlot(slot: PhotoSlot): PhotoCredit & { observationUrl?: string } {
  return {
    observer: slot.credit.observer,
    license: slot.credit.license,
    observationUrl: slot.credit.sourceUrl,
    observationId: slot.credit.observationId,
    placeLabel: slot.credit.placeLabel,
  };
}
