import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { exportDeck, buildManifest, cardExportNames } from "~/lib/export";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { saveProject, putFile } from "~/lib/store";
import { validateProject } from "~/lib/validate";
import { blobToArrayBuffer } from "~/lib/blobUtils";

function sampleProject() {
  const project = newProject(`Sample ${crypto.randomUUID().slice(0, 8)}`);
  project.description = "A test deck";
  const species = makeSpecies({
    commonName: "Dwarf Nettle",
    sciName: "Urtica urens",
    category: "plants",
    native: "non-native",
    border: "invasive",
    taxonId: 53315,
  });
  species.photos.push(
    {
      id: "inat:1",
      role: "main",
      fileKey: "dwarf-nettle-main.jpg",
      credit: {
        observer: "joodles",
        license: "cc-by-nc",
        observationId: 38238174,
        sourceUrl: "https://www.inaturalist.org/observations/38238174",
        placeLabel: "San Diego County",
      },
    },
    {
      id: "inat:2",
      role: "secondary",
      fileKey: "dwarf-nettle-secondary-1.jpg",
      credit: { observer: "leavenworth", license: "cc-by-nc", observationId: 2, sourceUrl: "https://www.inaturalist.org/observations/2" },
    },
    {
      id: "inat:3",
      role: "secondary",
      fileKey: "dwarf-nettle-secondary-2.jpg",
      credit: { observer: "susanbar", license: "cc-by-nc", observationId: 3, sourceUrl: "https://www.inaturalist.org/observations/3" },
    },
  );
  project.species.push(species);
  return project;
}

describe("manifest builder", () => {
  it("emits the data-card format per DECK_FORMAT.md", () => {
    const manifest = buildManifest(sampleProject()) as any;
    expect(manifest.cardFormat).toBe("data");
    expect(manifest.id).toMatch(/^sample-/);
    expect(manifest.label).toMatch(/^Sample/);
    expect(manifest.categories).toHaveLength(1);
    const cat = manifest.categories[0];
    expect(cat.id).toBe("plants");
    const card = cat.cards[0];
    expect(card.name).toBe("Dwarf Nettle");
    expect(card.layout).toBe("photo-trio");
    expect(card.photos).toHaveLength(3);
    expect(card.photos[0].file).toBe("photos/dwarf-nettle-main.jpg");
    expect(card.photos[0].role).toBe("main");
    expect(card.photos[0].credit.observer).toBe("joodles");
    expect(card.photos[0].credit.observationUrl).toContain("38238174");
    expect(card.native).toBe("non-native");
    expect(card.invasive).toBe(true);
    expect(card.sciName).toBe("Urtica urens");
    // Flattened credits for the credits page.
    expect(card.credits[0].license).toBe("cc-by-nc");
    expect(card.credits[0].placeLabel).toBe("San Diego County");
  });

  it("omits unknown native status from the manifest", () => {
    const project = newProject("X");
    project.species.push(makeSpecies({ commonName: "Mystery", category: "plants", native: "unknown" }));
    const manifest = buildManifest(project) as any;
    const card = manifest.categories[0].cards[0];
    expect(card.native).toBeUndefined();
  });
});

describe("deck export", () => {
  it("produces a zip with manifest.json and photo files", async () => {
    const project = sampleProject();
    await saveProject(project);
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["main-jpg-bytes"]));
    await putFile(project.id, "dwarf-nettle-secondary-1.jpg", new Blob(["second-jpg-bytes"]));
    await putFile(project.id, "dwarf-nettle-secondary-2.jpg", new Blob(["third-jpg-bytes"]));

    const { blob, filename } = await exportDeck(project);
    expect(filename).toMatch(/^sample-.*\.zip$/);
    const bytes = new Uint8Array(await blobToArrayBuffer(blob));
    const files = unzipSync(bytes);

    expect(Object.keys(files).sort()).toEqual([
      "manifest.json",
      "photos/dwarf-nettle-main.jpg",
      "photos/dwarf-nettle-secondary-1.jpg",
      "photos/dwarf-nettle-secondary-2.jpg",
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest.cardFormat).toBe("data");
    expect(manifest.categories[0].cards[0].photos[0].file).toBe("photos/dwarf-nettle-main.jpg");
    expect(new TextDecoder().decode(files["photos/dwarf-nettle-main.jpg"])).toBe("main-jpg-bytes");
  });

  it("exports without missing photo blobs (deleted while editing)", async () => {
    const project = sampleProject();
    await saveProject(project);
    const { blob } = await exportDeck(project);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    expect(Object.keys(files)).toEqual(["manifest.json"]);
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest.categories[0].cards[0].photos).toHaveLength(3); // manifest still lists them
  });
});

describe("validation", () => {
  it("flags missing licenses and unassigned categories", () => {
    const project = newProject("Broken");
    const a = makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" });
    const b = makeSpecies({ commonName: "Oak", sciName: "Quercus x", category: "plants" });
    b.photos.push({ id: "u1", role: "main", fileKey: "x.jpg", credit: { observer: "You", license: "" } });
    const orphan = makeSpecies({ commonName: "Orphan", category: "nope" });
    project.species.push(a, b, orphan);

    const issues = validateProject(project);
    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("no license"))).toBe(true);
    expect(messages.some((m) => m.includes("not assigned to a category"))).toBe(true);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
    // Two "Oak" cards are intentional variants, not an error.
    expect(messages.some((m) => m.includes("Duplicate card name"))).toBe(false);
  });

  it("notes multi-card species as info", () => {
    const project = newProject("Variants");
    project.species.push(
      makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }),
      makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }),
    );
    const issues = validateProject(project);
    const info = issues.find((i) => i.severity === "info");
    expect(info?.message).toContain("appear on 2 cards");
  });

  it("passes a clean deck", () => {
    expect(validateProject(sampleProject())).toEqual([]);
  });
});

describe("variant card naming", () => {
  it("dedupes export names deck-wide: first card plain, extras 'Name (2)'", () => {
    const project = newProject("Variants");
    const first = makeSpecies({ commonName: "Dudleya edulis", sciName: "Dudleya edulis", category: "plants" });
    const second = makeSpecies({ commonName: "Dudleya edulis", sciName: "Dudleya edulis", category: "plants" });
    const other = makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" });
    project.species.push(first, other, second);

    const names = cardExportNames(project);
    expect(names.get(first.id)).toBe("Dudleya edulis");
    expect(names.get(second.id)).toBe("Dudleya edulis (2)");
    expect(names.get(other.id)).toBe("Oak");

    const manifest = buildManifest(project) as any;
    const cardNames = manifest.categories[0].cards.map((c: any) => c.name);
    expect(cardNames).toEqual(["Dudleya edulis", "Oak", "Dudleya edulis (2)"]);
    // The back still shows the clean common name on both variant cards.
    expect(manifest.categories[0].cards[0].commonName).toBe("Dudleya edulis");
    expect(manifest.categories[0].cards[2].commonName).toBe("Dudleya edulis");
  });
});
