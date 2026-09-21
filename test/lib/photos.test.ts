import { describe, it, expect } from "vitest";
import { focusStyle, photoCap } from "~/lib/cardGeometry";
import { buildManifest } from "~/lib/export";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { categoryIdForIconic, labelForCategoryId } from "~/lib/categories";

describe("photo caps", () => {
  it("trio holds 3, single holds 1", () => {
    expect(photoCap("photo-trio")).toBe(3);
    expect(photoCap("photo-single")).toBe(1);
  });
});

describe("focal point (crop)", () => {
  it("renders object-position from the focus field", () => {
    expect(focusStyle({ x: 0.5, y: 0.2 })).toEqual({ objectPosition: "50% 20%" });
    expect(focusStyle({ x: 0.25, y: 1 })).toEqual({ objectPosition: "25% 100%" });
    expect(focusStyle(undefined)).toEqual({});
  });

  it("clamps out-of-range values", () => {
    expect(focusStyle({ x: -1, y: 5 })).toEqual({ objectPosition: "0% 100%" });
  });

  it("exports focus only when off-center", async () => {
    const project = newProject("Focus");
    const entry = makeSpecies({ commonName: "Oak", category: "plants" });
    entry.photos.push({
      id: "u1",
      role: "main",
      fileKey: "oak-main.jpg",
      credit: { observer: "A", license: "cc0" },
      focus: { x: 0.5, y: 0.15 },
    });
    const centered = makeSpecies({ commonName: "Pine", category: "plants" });
    centered.photos.push({
      id: "u2",
      role: "main",
      fileKey: "pine-main.jpg",
      credit: { observer: "B", license: "cc0" },
    });
    project.species.push(entry, centered);

    const manifest = buildManifest(project) as any;
    const [oak, pine] = manifest.categories[0].cards;
    expect(oak.photos[0].focus).toEqual({ x: 0.5, y: 0.15 });
    expect(pine.photos[0].focus).toBeUndefined(); // center is the default, omitted
  });
});

describe("categories", () => {
  it("maps iNat iconic taxa onto standard categories", () => {
    const project = newProject("Cats");
    expect(categoryIdForIconic(project, 47126)).toBe("plants");
    expect(categoryIdForIconic(project, 47170)).toBe("fungi");
    // Everything else is an animal — including unknown/none.
    expect(categoryIdForIconic(project, 3)).toBe("animals");
    expect(categoryIdForIconic(project, null)).toBe("animals");
  });

  it("matches existing categories case-insensitively before canonicalizing", () => {
    const project = newProject("Cats2");
    project.categories = [{ id: "plants", label: "botany" }];
    // "Plants" label doesn't exist ("botany" instead) → canonical id wins,
    // which already exists by id.
    expect(categoryIdForIconic(project, 47126)).toBe("plants");
  });

  it("labelForCategoryId names the standard groups", () => {
    expect(labelForCategoryId("plants")).toBe("Plants");
    expect(labelForCategoryId("fungi")).toBe("Fungi");
    expect(labelForCategoryId("animals")).toBe("Animals");
  });
});
