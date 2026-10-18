import { describe, it, expect } from "vitest";
import { zipSync, strToU8, unzipSync } from "fflate";
import { exportProjectFile, buildManifest } from "~/lib/export";
import { importDeckArchive } from "~/lib/importDeck";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies, type Project } from "~/lib/types";
import { saveProject } from "~/lib/store";
import { blobToArrayBuffer } from "~/lib/blobUtils";

/**
 * The export → import round trip is the deck's backup path: whatever the
 * manifest writes, the importer must bring back, and nothing the curator
 * built may silently vanish or arrive invalid.
 */

function richProject(): Project {
  const p = newProject("Rich Deck");
  p.deckLabel = "🌿 Rich Deck";
  p.description = "round trip fixture";
  p.location = { name: "Mission Trails", lat: 32.8282, lng: -117.0522, radiusKm: 10 };
  p.categories = [
    { id: "plants", label: "🌿 Plants" },
    { id: "birds", label: "🐦 Birds" },
  ];
  p.species = [
    makeSpecies({
      category: "plants",
      commonName: "Dudleya edulis",
      sciName: "Dudleya edulis",
      altNames: ["Burning Nettle"],
      familyCommon: "Stonecrop Family",
      familyLatin: "Crassulaceae",
      native: "native",
      border: "rare",
      rarity: "CNPS 1B.1",
      taxonId: 41173,
      layout: "photo-trio",
      tags: ["phase 1", "cliff"],
      photos: [
        {
          id: "inat:149532901",
          role: "main",
          fileKey: "main.jpg",
          alt: "close-up",
          crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
          credit: {
            observer: "joodles",
            license: "cc-by-nc",
            sourceUrl: "https://www.inaturalist.org/observations/38238174",
            observationId: 38238174,
            placeLabel: "San Diego County",
          },
          animation: { fileKey: "clip.mp4", kind: "video", durationSec: 2.5 },
        },
        {
          id: "upload:abc-123",
          role: "secondary",
          fileKey: "second.png",
          credit: { observer: "susan", license: "all-rights-reserved" },
        },
      ],
    }),
    makeSpecies({
      category: "birds",
      commonName: "Wrentit",
      sciName: "Chamaea fasciata",
      native: "non-native",
      border: "invasive",
      layout: "photo-single",
      photos: [
        {
          id: "inat:2",
          role: "main",
          fileKey: "bird.jpg",
          credit: { observer: "b", license: "cc0" },
        },
      ],
    }),
  ];
  return p;
}

describe("export → import round trip", () => {
  it("preserves the editable deck across a full archive round trip", async () => {
    const original = richProject();
    await saveProject(original);
    const { blob } = await exportProjectFile(original);

    const imported = await importDeckArchive(new File([blob], "rich.zip"), { existingIds: [original.id] });
    expect(imported.id).not.toBe(original.id); // uniquified, original untouched
    expect(imported.deckLabel).toBe("🌿 Rich Deck");
    expect(imported.description).toBe("round trip fixture");
    expect(imported.location).toEqual(original.location);
    expect(imported.categories).toEqual(original.categories);
    expect(imported.species).toHaveLength(2);

    const [dudleya, wrentit] = imported.species;
    expect(dudleya.commonName).toBe("Dudleya edulis");
    expect(dudleya.sciName).toBe("Dudleya edulis");
    expect(dudleya.altNames).toEqual(["Burning Nettle"]);
    expect(dudleya.familyCommon).toBe("Stonecrop Family");
    expect(dudleya.familyLatin).toBe("Crassulaceae");
    expect(dudleya.native).toBe("native");
    expect(dudleya.border).toBe("rare");
    expect(dudleya.rarity).toBe("CNPS 1B.1");
    expect(dudleya.taxonId).toBe(41173);
    expect(dudleya.layout).toBe("photo-trio");
    expect(dudleya.tags).toEqual(["phase 1", "cliff"]);
    expect(dudleya.photos).toHaveLength(2);

    const [main, secondary] = dudleya.photos;
    expect(main.role).toBe("main");
    expect(main.alt).toBe("close-up");
    expect(main.crop).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.5 });
    expect(main.credit.observer).toBe("joodles");
    expect(main.credit.license).toBe("cc-by-nc");
    expect(main.credit.observationId).toBe(38238174);
    expect(main.credit.sourceUrl).toBe("https://www.inaturalist.org/observations/38238174");
    expect(main.credit.placeLabel).toBe("San Diego County");
    expect(main.animation!.kind).toBe("video");
    expect(main.animation!.durationSec).toBe(2.5);
    expect(secondary.role).toBe("secondary");
    expect(secondary.credit.license).toBe("all-rights-reserved");

    expect(wrentit.border).toBe("invasive");
    expect(wrentit.layout).toBe("photo-single");
  });

  it("keeps stable slot ids so a re-imported deck can still export light", async () => {
    // backfillPhotoUrls only resolves slots whose id starts with "inat:" —
    // losing the id on a round trip would permanently break light export.
    const original = richProject();
    const { blob } = await exportProjectFile(original);
    const imported = await importDeckArchive(new File([blob], "ids.zip"));
    const [dudleya, wrentit] = imported.species;
    expect(dudleya.photos.map((p) => p.id)).toContain("inat:149532901");
    expect(dudleya.photos.map((p) => p.id)).toContain("upload:abc-123");
    expect(wrentit.photos[0].id).toBe("inat:2");
  });

  it("never ships an invalid crop window at the rounding boundary", async () => {
    // A valid window rounded to two decimals could exceed 1 (x=0.996 → 1.0
    // with w=0.005 → 0.01) or collapse to zero width — and the importer
    // would silently drop the crop. The shipped window must stay valid.
    const p = richProject();
    p.species[0].photos[0].crop = { x: 0.996, y: 0, w: 0.005, h: 1 };
    const { blob } = await exportProjectFile(p);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"] as Uint8Array)) as {
      categories: Array<{ cards: Array<{ photos: Array<{ crop?: { x: number; y: number; w: number; h: number } }> }> }>;
    };
    const crop = manifest.categories[0].cards[0].photos[0].crop!;
    expect(crop.w).toBeGreaterThan(0);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1 + 1e-9);

    const imported = await importDeckArchive(new File([blob], "edge.zip"));
    // The crop survives the round trip instead of being dropped.
    expect(imported.species[0].photos[0].crop).toBeDefined();
  });

  it("keeps every photo's bytes reachable in the imported deck", async () => {
    const original = richProject();
    await saveProject(original);
    for (const key of ["main.jpg", "clip.mp4", "second.png", "bird.jpg"]) {
      // Store bytes for every referenced key (the fixture only names them).
      const { putFile } = await import("~/lib/store");
      await putFile(original.id, key, new Blob([`bytes-${key}`], { type: "image/jpeg" }));
    }
    const { blob } = await exportProjectFile(original);
    const imported = await importDeckArchive(new File([blob], "bytes.zip"));
    await saveProject(imported);
    for (const species of imported.species) {
      for (const slot of species.photos) {
        expect(await import("~/lib/store").then((m) => m.getFile(imported.id, slot.fileKey))).toBeInstanceOf(Blob);
        if (slot.animation) {
          expect(await import("~/lib/store").then((m) => m.getFile(imported.id, slot.animation!.fileKey))).toBeInstanceOf(Blob);
        }
      }
    }
  });

  it("round-trips a manifest built directly from the imported project unchanged", async () => {
    const original = richProject();
    const first = buildManifest(original);
    const { blob } = await exportProjectFile(original);
    const imported = await importDeckArchive(new File([blob], "stable.zip"));
    const second = buildManifest(imported);
    // generator.exportedAt differs by construction; everything else matches.
    const { generator: _a, ...restFirst } = first as Record<string, unknown>;
    const { generator: _b, ...restSecond } = second as Record<string, unknown>;
    expect(restSecond).toEqual(restFirst);
  });
});
