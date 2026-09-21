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
export const INAT_ALLOWED_LICENSES = [
  "cc0",
  "cc-by",
  "cc-by-sa",
  "cc-by-nc",
  "cc-by-nc-sa",
] as const;

export const UPLOAD_LICENSES = [...INAT_ALLOWED_LICENSES, "cc-by-nd", "cc-by-nc-nd", "all-rights-reserved"] as const;

export type LicenseCode = (typeof UPLOAD_LICENSES)[number];

export type NativeStatus = "native" | "non-native" | "unknown";

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
  invasive: boolean;
  rarity?: string;
  taxonId?: number;
  layout: CardLayout;
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
  categories: ProjectCategory[];
  species: SpeciesEntry[];
  createdAt: string;
  updatedAt: string;
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
    invasive: partial.invasive ?? false,
    rarity: partial.rarity,
    taxonId: partial.taxonId,
    layout: partial.layout ?? "photo-trio",
    photos: partial.photos ?? [],
    notes: partial.notes,
    inatResolved: partial.inatResolved,
  };
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
