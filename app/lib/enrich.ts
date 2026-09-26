import type { Project, SpeciesEntry } from "./types";
import { resolveTaxon, fetchTaxonDetail } from "./resolve";
import { categoryIdForIconic, labelForCategoryId } from "./categories";
import { fetchIconicTaxa } from "./taxaBatch";

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

/** Auto-managed category ids: the standard groups plus the fine-grained
 *  taxonomy groups. Auto-sorting only re-files species in these (never
 *  overrides a human's custom categories). */
const AUTO_MANAGED = new Set([
  "plants", "fungi", "animals",
  "birds", "mammals", "reptiles", "amphibians", "fish", "insects", "arachnids",
]);

/** Should this species be re-filed by auto-sort? */
function isAutoSortable(s: SpeciesEntry): boolean {
  return s.category === "" || AUTO_MANAGED.has(s.category);
}

export async function enrichProject(
  project: Project,
  onProgress?: (done: number, total: number, label?: string) => void,
  scopeIds?: string[],
): Promise<EnrichResult> {
  const next = structuredClone(project);
  // Optional selection scope: when given, only those species are processed
  // (the deck's other species are carried through untouched).
  const scoped = scopeIds?.length ? new Set(scopeIds) : null;
  const all = scoped ? next.species.filter((s) => scoped.has(s.id)) : next.species;

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
  const iconic = await fetchIconicTaxa(sortables.map((s) => s.taxonId!));
  let sorted = 0;
  for (const s of sortables) {
    const icon = iconic.get(s.taxonId!);
    if (icon === undefined) continue;
    const id = categoryIdForIconic(next, icon);
    if (!next.categories.some((c) => c.id === id)) {
      next.categories.push({ id, label: labelForCategoryId(id) });
    }
    if (s.category !== id) {
      s.category = id;
      sorted++;
    }
  }

  onProgress?.(1, 1);
  return { project: next, resolved, sorted, unresolved };
}
