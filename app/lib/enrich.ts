import type { Project, SpeciesEntry } from "./types";
import { resolveTaxon, fetchTaxonDetail } from "./resolve";
import { categoryIdForIconic } from "./categories";
import { inatGet } from "./inat";

/**
 * "Fill gaps from iNaturalist": resolve species that are missing scientific
 * names/families, and file every species into Plants / Fungi / Animals using
 * iNat's iconic-taxon classification — the no-AI way to pre-populate the
 * deck's science fields and categories. Progress is reported per species so
 * the UI can show a real bar; every API response is cached by inatGet.
 */

export interface EnrichResult {
  project: Project;
  /** Species whose sci/common name or family was filled in. */
  resolved: number;
  /** Species moved into a Plants/Fungi/Animals category. */
  sorted: number;
  /** Names that iNat couldn't resolve. */
  unresolved: string[];
}

const STANDARD_CATEGORIES = new Set(["plants", "fungi", "animals"]);

/** Should this species be re-filed by auto-sort? (Never overrides custom categories.) */
function isAutoSortable(s: SpeciesEntry): boolean {
  return s.category === "" || STANDARD_CATEGORIES.has(s.category);
}

export async function enrichProject(
  project: Project,
  onProgress?: (done: number, total: number, label?: string) => void,
): Promise<EnrichResult> {
  const next = structuredClone(project);
  const all = next.species;

  // Phase 1: resolve names/families for species missing scientific info or
  // sitting in a category that doesn't exist.
  const phase1 = all.filter(
    (s) => !s.sciName || !s.familyLatin || s.category === "" || !next.categories.some((c) => c.id === s.category),
  );
  const unresolved: string[] = [];
  let resolved = 0;
  for (let i = 0; i < phase1.length; i++) {
    const draft = phase1[i];
    onProgress?.(i, phase1.length, draft.commonName || draft.sciName || "(unnamed)");
    const query = draft.sciName || draft.commonName;
    if (!query) continue;
    try {
      const taxon = await resolveTaxon(query);
      if (taxon) {
        draft.sciName = draft.sciName || taxon.sciName;
        draft.commonName = draft.commonName || taxon.commonName || "";
        draft.familyLatin = draft.familyLatin ?? taxon.familyLatin ?? undefined;
        draft.familyCommon = draft.familyCommon ?? taxon.familyCommon ?? undefined;
        draft.taxonId = draft.taxonId ?? taxon.taxonId;
        draft.inatResolved = true;
        if (isAutoSortable(draft)) {
          draft.category = categoryIdForIconic(next, taxon.iconicTaxonId);
        }
        resolved++;
      } else {
        unresolved.push(query);
      }
    } catch {
      // iNat down or rate-limited: keep what we have so far; a later run
      // finishes the rest (everything is cached).
    }
  }

  // Phase 2: species with a taxonId but missing family details (one cached
  // detail fetch each; usually only older decks need this).
  const needFamily = all.filter((s) => s.taxonId != null && (!s.familyLatin || !s.familyCommon));
  for (let i = 0; i < needFamily.length; i++) {
    const draft = needFamily[i];
    onProgress?.(phase1.length + i, phase1.length + needFamily.length, draft.commonName || draft.sciName);
    if (draft.familyLatin && draft.familyCommon) continue;
    try {
      const detail = await fetchTaxonDetail(draft.taxonId!);
      if (detail) {
        draft.familyLatin = draft.familyLatin ?? detail.familyLatin ?? undefined;
        draft.familyCommon = draft.familyCommon ?? detail.familyCommon ?? undefined;
      }
    } catch {
      // Families can be filled on a later run.
    }
  }

  // Phase 3: iconic-taxon classification for everything auto-sortable, in
  // batches of 50 (one cached request per batch).
  const sortables = all.filter((s) => s.taxonId != null && isAutoSortable(s));
  const iconic = new Map<number, number | null>();
  for (let i = 0; i < sortables.length; i += 50) {
    const chunk = sortables.slice(i, i + 50);
    try {
      const json = await inatGet<{ results: Array<{ id: number; iconic_taxon_id?: number }> }>(
        `taxa/${chunk.map((s) => s.taxonId).join(",")}`,
      );
      for (const t of json.results) {
        iconic.set(t.id, t.iconic_taxon_id ?? null);
      }
    } catch {
      // Leave this batch unclassified.
    }
  }
  let sorted = 0;
  for (const s of sortables) {
    const icon = iconic.get(s.taxonId!);
    if (icon === undefined) continue;
    const id = categoryIdForIconic(next, icon);
    if (!next.categories.some((c) => c.id === id)) {
      next.categories.push({ id, label: titleCase(id) });
    }
    if (s.category !== id) {
      s.category = id;
      sorted++;
    }
  }

  onProgress?.(1, 1);
  return { project: next, resolved, sorted, unresolved };
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
