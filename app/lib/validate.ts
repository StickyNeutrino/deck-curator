import type { Project } from "./types";
import { listFileKeys } from "./store";

/**
 * Pre-export validation. Nothing blocks export — but the severity says what
 * an issue does to the finished deck: red ("error") can keep the flashcards
 * app from importing or displaying it, amber ("warning") exports fine but is
 * worth fixing before sharing, gray ("info") is just context.
 */

export interface ExportIssue {
  severity: "error" | "warning" | "info";
  message: string;
  species?: string;
  /** id of the affected species, when the issue is card-specific */
  speciesId?: string;
}

export function validateProject(project: Project): ExportIssue[] {
  const issues: ExportIssue[] = [];
  const names = new Map<string, number>();
  for (const s of project.species) {
    const key = (s.commonName || s.sciName).trim();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  // Multiple cards per species are intentional (same species, different
  // photos, so the photo can't be memorized); export names them "Name (2)".
  const variantSpecies = [...names.entries()].filter(([, n]) => n > 1);
  if (variantSpecies.length) {
    const cards = variantSpecies.reduce((n, [, c]) => n + c, 0);
    issues.push({
      severity: "info",
      message: `${variantSpecies.length} species appear on ${cards} cards — extras export as “Name (2)”, “Name (3)”… so each card stays uniquely addressable. Give the variants distinct photo sets for the best studying experience.`,
    });
  }
  for (const s of project.species) {
    const label = s.commonName || s.sciName || "(unnamed species)";
    if (!s.commonName && !s.sciName) {
      issues.push({ severity: "error", message: "A species has neither a common nor a scientific name.", species: s.id });
    }
    if (!s.photos.length) {
      issues.push({
        severity: "error",
        message: `${label}: card has no photos yet — the flashcards app can't display it, so the deck may not import. Add at least one photo.`,
        species: label,
        speciesId: s.id,
      });
    } else if (s.layout === "photo-trio" && s.photos.length < 3) {
      issues.push({
        severity: "warning",
        message: `${label}: trio layout with ${s.photos.length} photo(s) — empty slots render as blank space.`,
        speciesId: s.id,
      });
    }
    for (const p of s.photos) {
      if (!p.credit.observer || p.credit.observer === "You") {
        issues.push({
          severity: "warning",
          message: `${label}: photo credit is a placeholder (“${p.credit.observer}”) — set the real photographer name before sharing.`,
          species: label,
          speciesId: s.id,
        });
      }
      if (!p.credit.license) {
        issues.push({ severity: "error", message: `${label}: a photo has no license — every photo needs one for the credits page.`, species: label, speciesId: s.id });
      }
    }
    if (!s.category || !project.categories.some((c) => c.id === s.category)) {
      issues.push({ severity: "error", message: `${label}: not assigned to a category.`, species: label, speciesId: s.id });
    }
  }
  if (!project.species.length) {
    issues.push({ severity: "error", message: "The deck has no species yet." });
  }
  return issues;
}

/** Photos whose blobs are missing from the deck's storage — the manifest
 *  would reference files the zip doesn't contain. Async because it needs the
 *  store; the export page merges these into the sync report. */
export async function missingPhotoIssues(project: Project): Promise<ExportIssue[]> {
  const present = await listFileKeys(project.id);
  const issues: ExportIssue[] = [];
  for (const s of project.species) {
    const label = s.commonName || s.sciName || "(unnamed species)";
    for (const p of s.photos) {
      for (const key of [p.fileKey, p.animation?.fileKey]) {
        if (key && !present.has(key)) {
          issues.push({
            severity: "error",
            message: `${label}: photo file “${key}” is missing from the deck's storage — remove the photo (and save) before exporting.`,
            species: label,
            speciesId: s.id,
          });
        }
      }
    }
  }
  return issues;
}
