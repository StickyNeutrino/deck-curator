import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importDeckArchive, speciesFromManifest } from "~/lib/importDeck";
import { buildManifest } from "~/lib/export";
import { listProjects, getFile } from "~/lib/store";

/**
 * Hostile and hand-edited archives must never crash the importer, never
 * leave a deck that loses cards on re-export, and never manufacture
 * invalid fields (undefined ids, non-finite coordinates).
 */

function archiveOf(manifest: unknown, files: Record<string, string> = {}): File {
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  });
  return new File([zip as unknown as BlobPart], "hostile.zip", { type: "application/zip" });
}

describe("hostile manifest parsing", () => {
  it("rejects a manifest that parses to null with a clear error and stores nothing", async () => {
    const before = (await listProjects()).length;
    const file = archiveOf(null);
    await expect(importDeckArchive(file)).rejects.toThrow(/unreadable manifest/);
    expect(await listProjects()).toHaveLength(before);
  });

  it("rejects a manifest that parses to an array or scalar", async () => {
    await expect(importDeckArchive(archiveOf([1, 2]))).rejects.toThrow(/unreadable manifest/);
    await expect(importDeckArchive(archiveOf("deck"))).rejects.toThrow(/unreadable manifest/);
  });

  it("coerces a non-string label to the deck id", async () => {
    const project = await importDeckArchive(archiveOf({
      id: "label-coerce",
      label: 42,
      categories: [],
    }));
    expect(project.deckLabel).toBe("label-coerce");
    expect(typeof project.description).toBe("string");
  });

  it("drops non-finite or non-numeric location coordinates but keeps the name", async () => {
    const project = await importDeckArchive(archiveOf({
      id: "loc-check",
      categories: [],
      location: { name: "Mission Trails", lat: "32.8", lng: Infinity, radiusKm: null },
    }));
    expect(project.location!.name).toBe("Mission Trails");
    expect(project.location!.lat).toBeUndefined();
    expect(project.location!.lng).toBeUndefined();
    expect(project.location!.radiusKm).toBeUndefined();
  });
});

describe("category integrity on import", () => {
  it("dedupes duplicate category ids and drops unusable entries", async () => {
    const project = await importDeckArchive(archiveOf({
      id: "cat-dedupe",
      categories: [
        { id: "plants", label: "Plants", cards: [{ name: "Oak" }] },
        { id: "plants", label: "Duplicated label", cards: [] },
        "junk-category",
        null,
        { label: "no id at all", cards: [{ name: "Ivy" }] },
      ],
    }));
    const ids = project.categories.map((c) => c.id);
    expect(ids.filter((id) => id === "plants")).toHaveLength(1);
    expect(ids).not.toContain(undefined);
    // Species keep a usable category and are never dropped from categories.
    expect(project.species.map((s) => s.commonName)).toEqual(["Oak", "Ivy"]);
    for (const s of project.species) {
      expect(project.categories.some((c) => c.id === s.category)).toBe(true);
    }
    // Re-export emits each card exactly once.
    const manifest = buildManifest(project) as { categories: Array<{ id: string; cards: unknown[] }> };
    const allCards = manifest.categories.flatMap((c) => c.cards);
    expect(allCards).toHaveLength(project.species.length);
  });

  it("synthesizes a category for species referencing one missing from the list", async () => {
    // A category entry without a usable id leaves its cards referencing "";
    // without synthesis the card would vanish on the next export.
    const { species } = speciesFromManifest({
      id: "x",
      categories: [{ label: "No id", cards: [{ name: "Oak" }] }],
    } as any);
    expect(species[0].category).toBe("");

    const project = await importDeckArchive(archiveOf({
      id: "cat-synth",
      categories: [{ label: "No id", cards: [{ name: "Oak" }] }],
    }));
    expect(project.categories.some((c) => c.id === "")).toBe(true);
    const manifest = buildManifest(project) as { categories: Array<{ id: string; cards: Array<{ name: string }> }> };
    expect(manifest.categories.flatMap((c) => c.cards).map((c) => c.name)).toContain("Oak");
  });
});

describe("partial archives", () => {
  it("imports what it can when a photo file is missing from the zip", async () => {
    const project = await importDeckArchive(archiveOf({
      id: "partial",
      categories: [
        {
          id: "plants",
          label: "Plants",
          cards: [{
            name: "Oak",
            photos: [
              { file: "photos/present.jpg", role: "main", credit: { observer: "a", license: "cc0" } },
              { file: "photos/missing.jpg", role: "secondary", credit: { observer: "a", license: "cc0" } },
            ],
          }],
        },
      ],
    }, { "photos/present.jpg": "present-bytes" }));

    expect(project.species).toHaveLength(1);
    const [main, secondary] = project.species[0].photos;
    expect(await getFile(project.id, main.fileKey)).toBeInstanceOf(Blob);
    // The absent file leaves a dangling reference the review flags at
    // export time — the deck itself loads and stays editable.
    expect(await getFile(project.id, secondary.fileKey)).toBeUndefined();
  });

  it("keeps the animation slot when the clip bytes are missing", async () => {
    const project = await importDeckArchive(archiveOf({
      id: "partial-anim",
      categories: [
        {
          id: "plants",
          label: "Plants",
          cards: [{
            name: "Oak",
            photos: [{
              file: "photos/oak.jpg",
              role: "main",
              credit: { observer: "a", license: "cc0" },
              animation: { file: "photos/absent-clip.mp4", kind: "video", durationSec: 4 },
            }],
          }],
        },
      ],
    }, { "photos/oak.jpg": "still-bytes" }));

    const slot = project.species[0].photos[0];
    expect(slot.animation).toBeDefined();
    expect(slot.animation!.kind).toBe("video");
    expect(slot.animation!.durationSec).toBe(4);
    expect(await getFile(project.id, slot.animation!.fileKey)).toBeUndefined();
    expect(await getFile(project.id, slot.fileKey)).toBeInstanceOf(Blob);
  });
});
