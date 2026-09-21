import { describe, it, expect, vi, afterEach } from "vitest";
import { chunkTaxaIds, TAXA_BATCH_SIZE } from "~/lib/taxaBatch";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

describe("chunkTaxaIds", () => {
  it("chunks at 30 (iNat's verified 'Too many IDs' limit)", () => {
    expect(TAXA_BATCH_SIZE).toBe(30);
    const ids = Array.from({ length: 75 }, (_, i) => i + 1);
    const chunks = chunkTaxaIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(30);
    expect(chunks[2]).toHaveLength(15);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("handles empty input", () => {
    expect(chunkTaxaIds([])).toEqual([]);
  });
});

describe("resortByTaxonomy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-files auto-managed species by iconic taxon without touching custom categories", async () => {
    // Mock the API layer: capture the requested id chunks (they ride in the
    // endpoint path) and answer with each taxon's group. Asserts the batches
    // never exceed iNat's 30-id limit.
    const requestedChunks: number[][] = [];
    vi.doMock("~/lib/inat", async (importOriginal) => {
      const actual = await importOriginal<typeof import("~/lib/inat")>();
      void actual;
      return {
        inatGet: vi.fn(async (endpoint: string) => {
          const ids = endpoint.split("/")[1].split(",").map(Number);
          requestedChunks.push(ids);
          const iconic: Record<number, number> = { 1: 3, 2: 40151 }; // 1: bird, 2: mammal
          return {
            results: ids.map((id) => ({ id, iconic_taxon_id: iconic[id] ?? null })),
          };
        }),
      };
    });
    vi.resetModules();
    const { resortByTaxonomy } = await import("~/lib/categories");

    const project = newProject("Resort");
    project.granularity = "fine";
    const bird = makeSpecies({ commonName: "Wren", category: "animals", taxonId: 1 });
    const custom = makeSpecies({ commonName: "Special", category: "my-custom", taxonId: 2 });
    project.species.push(bird, custom);

    const sorted = await resortByTaxonomy(project);

    // Bird moves out of Animals into Birds (created); the custom category is
    // never re-filed.
    expect(sorted.species.find((s) => s.commonName === "Wren")!.category).toBe("birds");
    expect(sorted.categories.some((c) => c.id === "birds" && c.label === "Birds")).toBe(true);
    expect(sorted.species.find((s) => s.commonName === "Special")!.category).toBe("my-custom");

    // Every request stayed within iNat's limit.
    for (const chunk of requestedChunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    vi.doUnmock("~/lib/inat");
    vi.resetModules();
  });

  it("batches 75 species into 3 requests of ≤30 (the 422 regression)", async () => {
    const requestedChunks: number[][] = [];
    vi.doMock("~/lib/inat", async (importOriginal) => {
      const actual = await importOriginal<typeof import("~/lib/inat")>();
      void actual;
      return {
        inatGet: vi.fn(async (endpoint: string) => {
          const ids = endpoint.split("/")[1].split(",").map(Number);
          requestedChunks.push(ids);
          return {
            results: ids.map((id) => ({ id, iconic_taxon_id: 3 })), // all birds
          };
        }),
      };
    });
    vi.resetModules();
    const { resortByTaxonomy } = await import("~/lib/categories");

    const project = newProject("Big Resort");
    project.granularity = "fine";
    for (let i = 0; i < 75; i++) {
      project.species.push(
        makeSpecies({ commonName: `Bird ${i}`, category: "animals", taxonId: 1000 + i }),
      );
    }

    const sorted = await resortByTaxonomy(project);
    expect(requestedChunks).toHaveLength(3); // 75 species → 30+30+15
    for (const chunk of requestedChunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(sorted.species.every((s) => s.category === "birds")).toBe(true);
    vi.doUnmock("~/lib/inat");
    vi.resetModules();
  });
});
