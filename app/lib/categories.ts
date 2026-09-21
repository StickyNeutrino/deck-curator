import type { Project } from "./types";

/**
 * Category helpers for intelligent population: iNat's iconic_taxon_id maps a
 * species onto Plants / Fungi / Animals; these helpers find-or-create those
 * categories so imports file themselves without manual sorting.
 */

import { categoryLabelForIconic } from "./resolve";

/** Find a category by (case-insensitive) label. */
export function categoryByLabel(project: Project, label: string): string | undefined {
  const needle = label.toLowerCase();
  return project.categories.find((c) => c.label.toLowerCase() === needle)?.id;
}

export type StandardCategoryLabel = "Plants" | "Fungi" | "Animals";

/** Display label for a canonical category id. */
export function labelForCategoryId(id: string): string {
  if (id === "plants") return "Plants";
  if (id === "fungi") return "Fungi";
  if (id === "animals") return "Animals";
  return id;
}

/** Find-or-create a standard category ("Plants"/"Fungi"/"Animals"). Mutates
 *  the project — call only on drafts owned by the caller. */
export function ensureCategory(project: Project, label: StandardCategoryLabel): string {
  const existing = categoryByLabel(project, label);
  if (existing) return existing;
  const id = label.toLowerCase();
  if (!project.categories.some((c) => c.id === id)) {
    project.categories.push({ id, label });
  }
  return id;
}

/** Pure: the canonical category id for an iNat iconic taxon. Does not create
 *  anything — pair with ensureCategory inside a state updater. */
export function categoryIdForIconic(project: Project, iconicTaxonId: number | null | undefined): string {
  const label = categoryLabelForIconic(iconicTaxonId);
  return categoryByLabel(project, label) ?? label.toLowerCase();
}
