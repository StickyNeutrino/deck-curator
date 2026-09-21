import { describe, it, expect } from "vitest";
import { focusStyle, photoCap, cropStyle, defaultCoverCrop, clampCrop, reorderPhotos } from "~/lib/cardGeometry";
import { buildManifest } from "~/lib/export";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { categoryIdForIconic, labelForCategoryId } from "~/lib/categories";

describe("crop windows", () => {
  it("maps a crop rect onto the slot (img sized 1/w × 1/h, offset by the origin)", () => {
    expect(cropStyle({ x: 0.25, y: 0.1, w: 0.5, h: 0.5 })).toEqual({
      position: "absolute",
      width: "200%",
      height: "200%",
      left: "-50%",
      top: "-20%",
      objectFit: "fill",
    });
    expect(cropStyle({ x: 0, y: 0, w: 1, h: 1 })).toEqual({
      position: "absolute",
      width: "100%",
      height: "100%",
      left: "0%",
      top: "0%",
      objectFit: "fill",
    });
  });

  it("defaultCoverCrop centers the implicit cover window", () => {
    // Landscape image in a square slot: full height, centered horizontal band.
    expect(defaultCoverCrop(2, 1)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    // Portrait image in a square slot: full width, centered vertical band.
    expect(defaultCoverCrop(0.5, 1)).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
  });

  it("clampCrop keeps the window inside the image with a minimum size", () => {
    // Oversized width clamps to 1; y=0.9 already fits (0.9 + 0.05 ≤ 1).
    expect(clampCrop({ x: -0.2, y: 0.9, w: 2, h: 0.05 })).toEqual({ x: 0, y: 0.9, w: 1, h: 0.05 });
    // Bottom-right corner pushed past the edge pulls back inside.
    expect(clampCrop({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 })).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
  });
});

describe("photo reordering", () => {
  const slots = (ids: string[]) =>
    ids.map((id, i) => ({
      id,
      role: i === 0 ? ("main" as const) : ("secondary" as const),
      credit: { observer: "x", license: "cc0" },
      fileKey: `${id}.jpg`,
    }));

  it("moves a photo and reports the new order", () => {
    expect(reorderPhotos([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(reorderPhotos([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  });

  it("is a no-op for out-of-range or same-index moves", () => {
    const list = [1, 2, 3];
    expect(reorderPhotos(list, 1, 1)).toBe(list);
    expect(reorderPhotos(list, 1, 9)).toBe(list);
    expect(reorderPhotos(list, -1, 0)).toBe(list);
  });
});

describe("crop export", () => {
  it("exports the crop window and drops legacy focus when a crop exists", () => {
    const project = newProject("CropExport");
    const entry = makeSpecies({ commonName: "Oak", category: "plants" });
    entry.photos.push({
      id: "u1",
      role: "main",
      fileKey: "oak-main.jpg",
      credit: { observer: "A", license: "cc0" },
      crop: { x: 0.12345, y: 0, w: 0.5, h: 0.75 },
      focus: { x: 0.9, y: 0.9 },
    });
    project.species.push(entry);

    const manifest = buildManifest(project) as any;
    const photo = manifest.categories[0].cards[0].photos[0];
    expect(photo.crop).toEqual({ x: 0.12, y: 0, w: 0.5, h: 0.75 });
    expect(photo.focus).toBeUndefined();
  });

  it("still exports a legacy off-center focus when there is no crop", () => {
    const project = newProject("FocusExport");
    const entry = makeSpecies({ commonName: "Pine", category: "plants" });
    entry.photos.push({
      id: "u2",
      role: "main",
      fileKey: "pine-main.jpg",
      credit: { observer: "B", license: "cc0" },
      focus: { x: 0.5, y: 0.2 },
    });
    project.species.push(entry);
    const photo = (buildManifest(project) as any).categories[0].cards[0].photos[0];
    expect(photo.crop).toBeUndefined();
    expect(photo.focus).toEqual({ x: 0.5, y: 0.2 });
  });
});

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
