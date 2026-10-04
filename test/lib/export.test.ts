import { describe, it, expect, vi } from "vitest";
import { unzipSync } from "fflate";
import {
  exportProjectFile,
  exportDeckFile,
  exportLightDeck,
  buildManifest,
  cardExportNames,
  cardFromSpecies,
  planCropBakes,
  IDENTITY_CROP,
} from "~/lib/export";
import { collectGitDir } from "~/lib/versioning";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { saveProject, putFile } from "~/lib/store";
import { validateProject } from "~/lib/validate";
import { blobToArrayBuffer } from "~/lib/blobUtils";

// The sample projects have no git repo, and history shipping is only
// observable with one — stub the collector (null = no history) so the
// project/deck file tests can drive it directly.
vi.mock("~/lib/versioning", () => ({
  collectGitDir: vi.fn(async () => null),
}));

// inatGet is stubbed so light-deck tests that DO need to backfill urls never
// touch the network; tests with stored urls make no calls at all.
vi.mock("~/lib/inat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/inat")>()),
  inatGet: vi.fn(async () => {
    throw new Error("HTTP 502");
  }),
}));

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

describe("deck file export", () => {
  it("produces a .deck zip with manifest.json and photo files", async () => {
    const project = sampleProject();
    await saveProject(project);
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["main-jpg-bytes"]));
    await putFile(project.id, "dwarf-nettle-secondary-1.jpg", new Blob(["second-jpg-bytes"]));
    await putFile(project.id, "dwarf-nettle-secondary-2.jpg", new Blob(["third-jpg-bytes"]));

    const { blob, filename } = await exportDeckFile(project);
    expect(filename).toMatch(/^sample-.*\.deck$/);
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
    const { blob } = await exportDeckFile(project);
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

describe("animation export", () => {
  it("exports the clip file and still, and the zip carries both", async () => {
    const project = newProject("Anim");
    const entry = makeSpecies({ commonName: "Oak", category: "plants" });
    entry.photos.push({
      id: "u1",
      role: "main",
      fileKey: "oak-frame.jpg",
      credit: { observer: "A", license: "cc0" },
      animation: { fileKey: "oak-anim.mp4", kind: "video", durationSec: 4.5 },
    });
    project.species.push(entry);
    await saveProject(project);
    await putFile(project.id, "oak-frame.jpg", new Blob(["still"]));
    await putFile(project.id, "oak-anim.mp4", new Blob(["clip"]));

    const { blob } = await exportDeckFile(project);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    expect(Object.keys(files)).toContain("photos/oak-anim.mp4");
    expect(Object.keys(files)).toContain("photos/oak-frame.jpg");

    const card = (buildManifest(project) as any).categories[0].cards[0];
    expect(card.photos[0].file).toBe("photos/oak-frame.jpg");
    expect(card.photos[0].animation).toEqual({
      file: "photos/oak-anim.mp4", kind: "video", durationSec: 4.5,
    });
  });
});

describe("project file vs deck file", () => {
  const history = new Map([[".git/HEAD", new Uint8Array([1, 2, 3])]]);

  it("the project file bundles the git history", async () => {
    vi.mocked(collectGitDir).mockResolvedValue(history);
    const project = sampleProject();
    await saveProject(project);
    const { blob, filename } = await exportProjectFile(project);
    expect(filename).toMatch(/^sample-.*\.zip$/);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    expect(Object.keys(files)).toContain(".git/HEAD");
  });

  it("the deck file never carries history", async () => {
    vi.mocked(collectGitDir).mockResolvedValue(history);
    const project = sampleProject();
    await saveProject(project);
    const { blob } = await exportDeckFile(project);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    expect(Object.keys(files).filter((k) => k.startsWith(".git/"))).toEqual([]);
    expect(Object.keys(files)).toContain("manifest.json");
  });

  it("passes undecodable files through untouched when shrinking (no baked crop)", async () => {
    const project = sampleProject();
    project.species[0].photos[0].crop = { x: 0.1, y: 0.2, w: 0.6, h: 0.8 };
    await saveProject(project);
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["main-jpg-bytes"]));
    await putFile(project.id, "dwarf-nettle-secondary-1.jpg", new Blob(["second-jpg-bytes"]));
    await putFile(project.id, "dwarf-nettle-secondary-2.jpg", new Blob(["third-jpg-bytes"]));

    const { blob } = await exportDeckFile(project, {
      shrink: { maxEdge: 1024, quality: 0.7 },
    });
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    // The bytes aren't decodable stills, so they ship as-is…
    expect(new TextDecoder().decode(files["photos/dwarf-nettle-main.jpg"])).toBe("main-jpg-bytes");
    // …and the manifest keeps the real crop window instead of an identity one.
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest.categories[0].cards[0].photos[0].crop).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.8 });
  });
});

describe("light deck export", () => {
  // Same deck as the full-format sample, but every photo remembers its
  // remote source (what slotFromInatPhoto now records at pick time).
  function sampleLightProject() {
    const project = sampleProject();
    project.species[0].photos.forEach((p, i) => {
      p.url = `https://inaturalist-open-data.s3.amazonaws.com/photos/${100 + i}/original.jpg`;
    });
    return project;
  }

  it("ships a manifest-only zip whose photos reference URLs", async () => {
    const project = sampleLightProject();
    await saveProject(project);
    const { blob, filename, manifest } = await exportLightDeck(project);
    expect(filename).toMatch(/^sample-.*\.deck\.lite$/);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    expect(Object.keys(files)).toEqual(["manifest.json"]);
    const parsed = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(parsed.format).toBe("lite");
    expect(parsed.cardFormat).toBe("data");
    const card = parsed.categories[0].cards[0];
    expect(card.photos[0].url).toBe("https://inaturalist-open-data.s3.amazonaws.com/photos/100/original.jpg");
    expect(card.photos[0].file).toBeUndefined();
    expect(card.invasive).toBe(true);
    expect(card.rarity).toBeNull();
    expect(manifest).toBeTruthy();
  });

  it("refuses decks holding photos with no remote source (uploads)", async () => {
    const project = sampleLightProject();
    project.species[0].photos[1].url = undefined; // simulates an upload slot
    project.species[0].photos[1].id = "upload:abc";
    await saveProject(project);
    await expect(exportLightDeck(project)).rejects.toThrow(/no remote source/);
  });

  it("refuses decks with animated media", async () => {
    const project = sampleLightProject();
    project.species[0].photos[0].animation = { fileKey: "clip.mp4", kind: "video", url: "https://x/y.mp4" };
    await saveProject(project);
    await expect(exportLightDeck(project)).rejects.toThrow(/animated media/);
  });

  it("reports an iNat outage as retryable instead of per-photo noise", async () => {
    // sampleProject's slots have no stored url, so the export must resolve
    // them — and the stubbed inatGet above fails every batch.
    const project = sampleProject();
    await saveProject(project);
    await expect(exportLightDeck(project)).rejects.toThrow(/couldn't be reached.*try again/);
  });
});

describe("export progress & cancellation", () => {
  it("reports photo phases as the deck is built", async () => {
    const project = sampleProject();
    project.species[0].photos[0].crop = { x: 0.1, y: 0, w: 0.5, h: 0.5 };
    await saveProject(project);
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["a"]));
    await putFile(project.id, "dwarf-nettle-secondary-1.jpg", new Blob(["b"]));

    const seen: Array<[number, number, string | undefined]> = [];
    await exportDeckFile(project, {
      shrink: { maxEdge: 1024, quality: 0.7 },
      onProgress: (done, total, detail) => seen.push([done, total, detail]),
    });
    const details = seen.map(([, , d]) => d ?? "");
    expect(details.some((d) => d.startsWith("Reading dwarf-nettle-main"))).toBe(true);
    expect(details.some((d) => d.startsWith("Re-encoding dwarf-nettle-main"))).toBe(true);
    // The undecodable blob still reports a re-encode attempt; packing closes.
    expect(details[details.length - 1]).toBe("Packing…");
    // done counts climb to the number of shipped files, never past it.
    const total = seen[0][1];
    expect(seen.every(([done, tot]) => tot === total && done <= tot)).toBe(true);
  });

  it("stops between photos when the signal aborts", async () => {
    const project = sampleProject();
    await saveProject(project);
    // Three shipped files: aborting during the second must still throw
    // before the third is read.
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["a"]));
    await putFile(project.id, "dwarf-nettle-secondary-1.jpg", new Blob(["b"]));
    await putFile(project.id, "dwarf-nettle-secondary-2.jpg", new Blob(["c"]));

    const controller = new AbortController();
    await expect(
      exportDeckFile(project, {
        onProgress: (done, _total, detail) => {
          // Abort after the first file has been read.
          if (detail?.startsWith("Reading") && done >= 1) controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("baked crops", () => {
  const slotWith = (fileKey: string, crop?: { x: number; y: number; w: number; h: number }) => ({
    id: `p-${fileKey}`,
    role: "main" as const,
    fileKey,
    credit: { observer: "A", license: "cc0" },
    ...(crop ? { crop } : {}),
  });

  it("writes an identity crop (and no focus) for baked stills", () => {
    const s = makeSpecies({ commonName: "Oak", category: "plants" });
    s.photos.push(slotWith("oak.jpg", { x: 0.1, y: 0.15, w: 0.7, h: 0.8 }));

    const plain = cardFromSpecies(s) as any;
    expect(plain.photos[0].crop).toEqual({ x: 0.1, y: 0.15, w: 0.7, h: 0.8 });

    const baked = cardFromSpecies(s, undefined, { bakedCrops: new Set(["oak.jpg"]) }) as any;
    expect(baked.photos[0].crop).toEqual(IDENTITY_CROP);
  });

  it("plans a bake per fileKey and drops shared-file conflicts", () => {
    const project = newProject("Bake plan");
    const shared = makeSpecies({ commonName: "Oak", category: "plants" });
    shared.photos.push(slotWith("a.jpg", { x: 0, y: 0, w: 0.5, h: 0.5 }));
    const clashing = makeSpecies({ commonName: "Ivy", category: "plants" });
    clashing.photos.push(slotWith("a.jpg", { x: 0.2, y: 0, w: 0.5, h: 0.5 }));
    const unshared = makeSpecies({ commonName: "Fern", category: "plants" });
    unshared.photos.push(slotWith("b.jpg", { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }));
    const uncropped = makeSpecies({ commonName: "Moss", category: "plants" });
    uncropped.photos.push(slotWith("c.jpg"));
    project.species.push(shared, clashing, unshared, uncropped);

    const plan = planCropBakes(project);
    expect(plan.has("a.jpg")).toBe(false); // two slots disagree — pass through
    expect(plan.get("b.jpg")).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    expect(plan.has("c.jpg")).toBe(false); // nothing to bake
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

  it("avoids colliding with a card literally named 'Oak (2)'", () => {
    const project = newProject("Collision");
    const literal = makeSpecies({ commonName: "Oak (2)", sciName: "Quercus", category: "plants" });
    const a = makeSpecies({ commonName: "Oak", sciName: "Quercus x", category: "plants" });
    const b = makeSpecies({ commonName: "Oak", sciName: "Quercus y", category: "plants" });
    project.species.push(literal, a, b);

    const names = [...cardExportNames(project).values()];
    // Uniqueness is the manifest's contract — no two cards may share a name.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Oak (2)");
    expect(names).toContain("Oak (3)");
  });
});
