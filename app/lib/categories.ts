import type { Project } from "./types";

/**
 * Category helpers for intelligent population: iNat's iconic_taxon_id files a
 * species into a taxonomy group. Two granularities (per project):
 *  - "standard": Plants / Fungi / Animals — the classic three.
 *  - "fine": Birds / Mammals / Reptiles / Amphibians / Fish / Insects /
 *    Arachnids keep their own categories; plants and fungi stay as-is.
 * Categories remain fully user-editable — auto-sorting never re-files a
 * species out of a custom (non-auto-managed) category.
 */

import { categoryLabelForIconic } from "./resolve";

/** Find a category by (case-insensitive) label. */
export function categoryByLabel(
  project: Pick<Project, "categories">,
  label: string,
): string | undefined {
  const needle = label.toLowerCase();
  return project.categories.find((c) => c.label.toLowerCase() === needle)?.id;
}

/** Auto-managed category ids: standard groups plus fine taxonomy groups.
 *  Auto-sorting only re-files species in these (never custom categories). */
export const AUTO_MANAGED_CATEGORIES = new Set([
  "plants", "fungi", "animals",
  "birds", "mammals", "reptiles", "amphibians", "fish", "insects", "arachnids",
]);

export function isAutoManagedCategory(id: string): boolean {
  return AUTO_MANAGED_CATEGORIES.has(id);
}

/** Specific group labels per iNat iconic taxon (used at "fine" granularity). */
const FINE_LABELS: Record<number, string> = {
  3: "Birds",
  40151: "Mammals",
  26036: "Reptiles",
  20978: "Amphibians",
  47178: "Fish",
  47158: "Insects",
  47119: "Arachnids",
};

/** Display label for a canonical category id. */
export function labelForCategoryId(id: string): string {
  const known: Record<string, string> = {
    plants: "Plants",
    fungi: "Fungi",
    animals: "Animals",
    birds: "Birds",
    mammals: "Mammals",
    reptiles: "Reptiles",
    amphibians: "Amphibians",
    fish: "Fish",
    insects: "Insects",
    arachnids: "Arachnids",
  };
  return known[id] ?? id;
}

/** Pure: the category id for an iNat iconic taxon, honoring the project's
 *  granularity ("standard" collapses animal groups into "animals"; "fine"
 *  keeps the specific group). Does not create anything — pair with
 *  ensureCategoryById inside a state updater. */
export function categoryIdForIconic(
  project: Pick<Project, "categories" | "granularity">,
  iconicTaxonId: number | null | undefined,
): string {
  // Fine granularity: the specific taxonomy group wins (unless a category
  // with that exact label already exists). An existing "Animals" category
  // must not swallow Birds at fine granularity.
  if (project.granularity === "fine" && iconicTaxonId != null) {
    const fineLabel = FINE_LABELS[iconicTaxonId];
    if (fineLabel) return categoryByLabel(project, fineLabel) ?? fineLabel.toLowerCase();
  }
  const label = categoryLabelForIconic(iconicTaxonId);
  return categoryByLabel(project, label) ?? label.toLowerCase();
}

/** Find-or-create a category by id on a draft project (mutating). */
export function ensureCategoryById(project: Project, id: string): string {
  if (!project.categories.some((c) => c.id === id)) {
    project.categories.push({ id, label: labelForCategoryId(id) });
  }
  return id;
}