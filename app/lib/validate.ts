import type { Project } from "./types";

/**
 * Pre-export validation. Issues don't block export — the flashcards app
 * tolerates partial decks — but the curator surfaces them so nobody ships a
 * deck of credit-less cards by accident.
 */

export interface ExportIssue {
  severity: "error" | "warning";
  message: string;
  species?: string;
}

export function validateProject(project: Project): ExportIssue[] {
  const issues: ExportIssue[] = [];
  const names = new Map<string, number>();
  for (const s of project.species) {
    const key = (s.commonName || s.sciName).trim();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  for (const [name, count] of names) {
    if (count > 1 && name) {
      issues.push({
        severity: "error",
        message: `Duplicate card name “${name}” (${count}×) — card names must be unique across the deck.`,
        species: name,
      });
    }
  }
  for (const s of project.species) {
    const label = s.commonName || s.sciName || "(unnamed species)";
    if (!s.commonName && !s.sciName) {
      issues.push({ severity: "error", message: "A species has neither a common nor a scientific name.", species: s.id });
    }
    if (!s.photos.length) {
      issues.push({ severity: "warning", message: `${label}: card has no photos yet.` });
    } else if (s.layout === "photo-trio" && s.photos.length < 3) {
      issues.push({
        severity: "warning",
        message: `${label}: trio layout with ${s.photos.length} photo(s) — empty slots render as blank space.`,
      });
    }
    for (const p of s.photos) {
      if (!p.credit.observer || p.credit.observer === "You") {
        issues.push({
          severity: "warning",
          message: `${label}: photo credit is a placeholder (“${p.credit.observer}”) — set the real photographer name before sharing.`,
          species: label,
        });
      }
      if (!p.credit.license) {
        issues.push({ severity: "error", message: `${label}: a photo has no license — every photo needs one for the credits page.`, species: label });
      }
    }
    if (!s.category || !project.categories.some((c) => c.id === s.category)) {
      issues.push({ severity: "error", message: `${label}: not assigned to a category.`, species: label });
    }
  }
  if (!project.species.length) {
    issues.push({ severity: "error", message: "The deck has no species yet." });
  }
  return issues;
}
