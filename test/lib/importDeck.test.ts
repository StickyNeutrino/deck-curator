import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importDeckArchive, speciesFromManifest } from "~/lib/importDeck";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject, getFile } from "~/lib/store";
import { buildManifest } from "~/lib/export";

const manifest = {
  id: "round-trip",
  label: "🌿 Round Trip",
  description: "imported deck",
  cardFormat: "data",
  categories: [
    {
      id: "plants",
      label: "🌿 Plants",
      cards: [
        {
          name: "Dudleya edulis (2)", // variant card
          commonName: "Dudleya edulis",
          layout: "photo-trio",
          photos: [
            {
              file: "photos/dudleya-main.jpg",
              role: "main",
              alt: "close-up",
              crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
              credit: { observer: "joodles", license: "cc-by-nc", observationUrl: "https://www.inaturalist.org/observations/1", observationId: 1, placeLabel: "San Diego County" },
            },
            { file: "photos/dudleya-sec-1.jpg", role: "secondary", credit: { observer: "susanbar", license: "cc0" } },
          ],
          sciName: "Dudleya edulis",
          native: "non-native",
          border: "caution",
          rarity: "CNPS 1B.1",
          taxonId: 41173,
        },
      ],
    },
  ],
};

function archive(): File {
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "photos/dudleya-main.jpg": strToU8("main-jpeg-bytes"),
    "photos/dudleya-sec-1.jpg": strToU8("sec-jpeg-bytes"),
  });
  return new File([zip as unknown as BlobPart], "round-trip.zip", { type: "application/zip" });
}

describe("deck archive import", () => {
  it("maps manifest cards to editable species", () => {
    const { species, categories } = speciesFromManifest(manifest as any);
    expect(categories).toEqual([{ id: "plants", label: "🌿 Plants" }]);
    const [entry] = species;
    // Variant suffix is stripped from the working name; fields round-trip.
    expect(entry.commonName).toBe("Dudleya edulis");
    expect(entry.sciName).toBe("Dudleya edulis");
    expect(entry.border).toBe("caution");
    expect(entry.native).toBe("non-native");
    expect(entry.rarity).toBe("CNPS 1B.1");
    expect(entry.layout).toBe("photo-trio");
    expect(entry.photos).toHaveLength(2);
    expect(entry.photos[0].crop).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.5 });
    expect(entry.photos[0].credit.observer).toBe("joodles");
    expect(entry.photos[1].role).toBe("secondary");
  });

  it("imports the archive: photos stored, project saved, re-export round-trips", async () => {
    const project = await importDeckArchive(archive());
    expect(project.id).toBe("round-trip");
    expect(project.deckLabel).toBe("🌿 Round Trip");
    expect(project.species).toHaveLength(1);

    // Photos landed in the file store.
    expect(await getFile(project.id, "dudleya-main.jpg")).toBeInstanceOf(Blob);
    expect(await getFile(project.id, "dudleya-sec-1.jpg")).toBeInstanceOf(Blob);

    // Re-exporting produces the same manifest content (crop intact).
    await saveProject(project);
    const manifest2 = buildManifest(project) as any;
    const card = manifest2.categories[0].cards[0];
    // Single card of the species → plain export name; the "(2)" suffix only
    // reappears when a second card of the same species is added.
    expect(card.name).toBe("Dudleya edulis");
    expect(card.commonName).toBe("Dudleya edulis");
    expect(card.photos[0].crop).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.5 });
    expect(card.border).toBe("caution");
    expect(card.invasive).toBeUndefined();
  });

  it("rejects non-deck zips with a clear error", async () => {
    const zip = new File([zipSync({ "readme.txt": strToU8("not a deck") }) as unknown as BlobPart], "junk.zip", { type: "application/zip" });
    await expect(importDeckArchive(zip)).rejects.toThrow(/manifest\.json/);
  });

  it("treats legacy invasive:true as the red border", () => {
    const legacy = {
      id: "legacy",
      categories: [{ id: "plants", label: "Plants", cards: [{ name: "Oak", invasive: true }] }],
    };
    const { species } = speciesFromManifest(legacy as any);
    expect(species[0].border).toBe("invasive");
  });
});
