import type { Project, SpeciesEntry, NativeStatus, DeckLocation } from "./types";
import { taxaStatuses, nearbyPlaces, type InatConservationStatus, type InatEstablishment } from "./inat";

/**
 * Deck tools: batch actions that pull facts from iNaturalist and fill in
 * fields the curator would otherwise set by hand. Two flavors today —
 * "label native / invasive" (place checklists → native status, optionally
 * invasive borders) and "label conservation status" (threatened listings →
 * rarity text, optionally notable borders).
 *
 * Tools are advisory: they only fill empty/unknown fields and never overwrite
 * a value the curator already set — anything they would have changed
 * differently is reported back as a conflict instead.
 */

export interface ToolReport {
  /** Species the tool considered (with an iNat id). */
  considered: number;
  /** Species whose fields were updated. */
  filled: number;
  /** Species where iNat had no data / the field stayed empty. */
  noData: number;
  /** Species with an existing value that differs from iNat's — kept, listed. */
  conflicts: Array<{ species: string; detail: string }>;
  /** Where the numbers come from, e.g. "per iNat — California checklist". */
  sourcePlace?: string;
}

export interface LabelNativeOptions {
  /** Also set the red invasive border on species iNat lists as introduced. */
  invasiveBorder?: boolean;
}

export interface LabelRarityOptions {
  /** Also set the blue notable border on threatened/imperiled species. */
  notableBorder?: boolean;
}

/** Species the tool is applied to: a selection, or everything when unset. */
export type Scope = { ids?: string[] };

/* ------------------------------------------------------------------ */
/* Pure mapping helpers (unit-tested)                                  */
/* ------------------------------------------------------------------ */

/** iNat establishment means → the deck's native status, or null when iNat
 *  doesn't label it (unlisted place, "assumed_present", …). */
export function establishmentToNative(em: InatEstablishment | null | undefined): NativeStatus | null {
  const means = em?.establishment_means;
  if (means === "native" || means === "endemic") return "native";
  if (means === "introduced") return "non-native";
  return null;
}

const IUCN_LABELS: Array<[number, string]> = [
  [70, "extinct"],
  [60, "extinct in the wild"],
  [50, "critically endangered"],
  [40, "endangered"],
  [30, "vulnerable"],
  [20, "near threatened"],
  [10, "least concern"],
  [5, "least concern"],
];

/** Friendly IUCN-equivalent label for a conservation status ("vulnerable" for
 *  iucn ≥ 30), falling back to the raw status code (e.g. "S2S3"). */
export function conservationLabel(cs: InatConservationStatus | null | undefined): string | null {
  if (!cs?.status) return null;
  const iucn = cs.iucn ?? 0;
  if (iucn >= 20) {
    const label = IUCN_LABELS.find(([min]) => iucn >= min)?.[1] ?? cs.status;
    const authority = cs.authority ? ` — ${cs.authority}` : "";
    return `${label}${authority} (${cs.status})`;
  }
  // Not IUCN-rated (e.g. a NatureServe state rank) — show the code + source.
  return cs.authority ? `${cs.status} (${cs.authority})` : cs.status;
}

/** True when a conservation status is bad enough to earn the notable border. */
export function isThreatened(cs: InatConservationStatus | null | undefined): boolean {
  return (cs?.iucn ?? 0) >= 20;
}

function labelOf(s: SpeciesEntry): string {
  return s.commonName || s.sciName || "(unnamed)";
}

/* ------------------------------------------------------------------ */
/* Place resolution                                                    */
/* ------------------------------------------------------------------ */

export interface InatPlaceRef {
  id: number;
  name: string;
}

/**
 * The smallest iNat place containing a coordinate scope — the checklist
 * scope establishment means and conservation statuses are read from. A cached
 * `inatPlace` on the scope wins; otherwise `places/nearby` picks the smallest
 * admin place (countries → states → counties). Community places (user
 * circles, parks) are a fallback — their checklists vary.
 */
export async function resolveInatPlace(
  loc: Pick<DeckLocation, "lat" | "lng" | "radiusKm" | "inatPlace">,
): Promise<InatPlaceRef | null> {
  if (loc.inatPlace?.id) return { id: loc.inatPlace.id, name: loc.inatPlace.name };
  if (loc.lat == null || loc.lng == null) return null;
  const places = await nearbyPlaces({ lat: loc.lat, lng: loc.lng, radiusKm: loc.radiusKm });
  const admin = places
    .filter((p) => (p.admin_level ?? -1) >= 0)
    .sort((a, b) => (a.bbox_area ?? 0) - (b.bbox_area ?? 0) || (b.admin_level ?? 0) - (a.admin_level ?? 0))[0];
  const community = places
    .filter((p) => (p.admin_level ?? -1) < 0)
    .sort((a, b) => (a.bbox_area ?? 0) - (b.bbox_area ?? 0))[0];
  const picked = admin ?? community;
  if (!picked) return null;
  return { id: picked.id, name: picked.display_name || picked.name };
}

/**
 * Same, for the deck's own location — and cached onto it so tool runs don't
 * re-resolve the place every time. Returns null when the deck has no
 * coordinates (tools report that).
 */
export async function resolveDeckInatPlace(
  project: Project,
  onChange?: (f: (d: Project) => void) => void,
): Promise<InatPlaceRef | null> {
  const loc = project.location;
  if (!loc) return null;
  const ref = await resolveInatPlace(loc);
  if (ref && onChange && loc.inatPlace?.id !== ref.id) {
    onChange((d) => {
      d.location = { ...d.location, inatPlace: { id: ref.id, name: ref.name } };
    });
  }
  return ref;
}

/* ------------------------------------------------------------------ */
/* Shared fetch                                                        */
/* ------------------------------------------------------------------ */

interface StatusRow {
  establishment: InatEstablishment | null;
  conservation: InatConservationStatus | null;
}

async function fetchStatuses(
  species: SpeciesEntry[],
  place: InatPlaceRef | null,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, StatusRow>> {
  const out = new Map<number, StatusRow>();
  if (!place) return out;
  const ids = [...new Set(species.map((s) => s.taxonId!).filter((n) => n != null))];
  const rows = await taxaStatuses(ids, place.id);
  onProgress?.(1, 2);
  for (const [id, row] of rows) {
    out.set(id, { establishment: row.establishment_means ?? null, conservation: row.conservation_status ?? null });
  }
  return out;
}

function scopeOf(project: Project, scope: Scope | undefined): SpeciesEntry[] {
  if (!scope?.ids?.length) return project.species;
  const ids = new Set(scope.ids);
  return project.species.filter((s) => ids.has(s.id));
}

function sourceLabel(place: InatPlaceRef | null): string | undefined {
  return place ? `per iNat — ${place.name} checklist` : undefined;
}

/* ------------------------------------------------------------------ */
/* Tool: label native / invasive                                       */
/* ------------------------------------------------------------------ */

export async function labelNativeStatus(
  project: Project,
  scope: Scope | undefined,
  options: LabelNativeOptions = {},
  onProgress?: (done: number, total: number) => void,
  /** Persists the resolved iNat place onto the deck's location. */
  onChange?: (f: (d: Project) => void) => void,
): Promise<{ project: Project; report: ToolReport }> {
  const next = structuredClone(project);
  const targets = scopeOf(next, scope);
  const withTaxon = targets.filter((s) => s.taxonId != null);
  const noTaxon = targets.length - withTaxon.length;
  const place = await resolveDeckInatPlace(project, onChange);
  onProgress?.(0, 2);
  const rows = await fetchStatuses(withTaxon, place, onProgress);

  const report: ToolReport = {
    considered: withTaxon.length,
    filled: 0,
    noData: 0,
    conflicts: [],
    sourcePlace: sourceLabel(place),
  };

  for (const draft of withTaxon) {
    const suggested = establishmentToNative(rows.get(draft.taxonId!)?.establishment);
    if (!suggested) {
      report.noData++;
      continue;
    }
    const before = { native: draft.native, border: draft.border };
    if (draft.native === "unknown") {
      draft.native = suggested;
    } else if (draft.native !== suggested) {
      report.conflicts.push({
        species: labelOf(draft),
        detail: `kept "${draft.native}", iNat says "${suggested}"`,
      });
    }
    // Optional red border: iNat says "introduced" and the curator opted in.
    if (options.invasiveBorder && suggested === "non-native") {
      if (draft.border === "none") {
        draft.border = "invasive";
      } else if (draft.border !== "invasive") {
        report.conflicts.push({
          species: labelOf(draft),
          detail: `border kept as "${draft.border}"`,
        });
      }
    }
    if (draft.native !== before.native || draft.border !== before.border) report.filled++;
  }
  if (noTaxon > 0) {
    report.conflicts.push({
      species: `${noTaxon} species without an iNat id`,
      detail: "run “Fill gaps & re-sort categories” first",
    });
  }
  return { project: next, report };
}

/* ------------------------------------------------------------------ */
/* Tool: label conservation status                                     */
/* ------------------------------------------------------------------ */

export async function labelRarity(
  project: Project,
  scope: Scope | undefined,
  options: LabelRarityOptions = {},
  onProgress?: (done: number, total: number) => void,
  /** Persists the resolved iNat place onto the deck's location. */
  onChange?: (f: (d: Project) => void) => void,
): Promise<{ project: Project; report: ToolReport }> {
  const next = structuredClone(project);
  const targets = scopeOf(next, scope);
  const withTaxon = targets.filter((s) => s.taxonId != null);
  const noTaxon = targets.length - withTaxon.length;
  const place = await resolveDeckInatPlace(project, onChange);
  onProgress?.(0, 2);
  const rows = await fetchStatuses(withTaxon, place, onProgress);

  const report: ToolReport = {
    considered: withTaxon.length,
    filled: 0,
    noData: 0,
    conflicts: [],
    sourcePlace: sourceLabel(place),
  };

  for (const draft of withTaxon) {
    const cs = rows.get(draft.taxonId!)?.conservation ?? null;
    const label = conservationLabel(cs);
    if (!label) {
      report.noData++;
      continue;
    }
    const before = { rarity: draft.rarity, border: draft.border };
    if (!draft.rarity) {
      draft.rarity = label;
    } else if (draft.rarity !== label) {
      report.conflicts.push({
        species: labelOf(draft),
        detail: `rarity kept as "${draft.rarity}", iNat says "${label}"`,
      });
    }
    // Optional blue border for threatened / imperiled species.
    if (options.notableBorder && isThreatened(cs)) {
      if (draft.border === "none") {
        draft.border = "notable";
      } else if (draft.border !== "notable") {
        report.conflicts.push({
          species: labelOf(draft),
          detail: `border kept as "${draft.border}"`,
        });
      }
    }
    if (draft.rarity !== before.rarity || draft.border !== before.border) report.filled++;
  }
  if (noTaxon > 0) {
    report.conflicts.push({
      species: `${noTaxon} species without an iNat id`,
      detail: "run “Fill gaps & re-sort categories” first",
    });
  }
  return { project: next, report };
}
