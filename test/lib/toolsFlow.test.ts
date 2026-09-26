import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { labelNativeStatus, labelRarity, resolveInatPlace } from "~/lib/tools";
import type { Project } from "~/lib/types";
import { makeSpecies } from "~/lib/types";

/**
 * Integration test for the deck tools, against a mocked iNat API:
 * `places/nearby` resolves the deck's checklist place (smallest admin place
 * containing the point), and the batched `taxa/{ids}?place_id=` request
 * supplies establishment means / conservation statuses.
 */

const PLACES = [
  { id: 97394, name: "North America", display_name: "North America", admin_level: -10, bbox_area: 28171.4 },
  { id: 1, name: "United States", display_name: "United States", admin_level: 0, bbox_area: 6349.4 },
  { id: 14, name: "California", display_name: "California, US", admin_level: 10, bbox_area: 98.13 },
  { id: 829, name: "San Diego", display_name: "San Diego County, CA, US", admin_level: 20, bbox_area: 1.494 },
];

// taxonId → (iNat establishment means, conservation status)
const TAXA: Record<number, { means?: string; status?: { status: string; authority: string; iucn: number } }> = {
  68205: { means: "native" },
  46017: { means: "introduced" },
  6930: { means: "native" },
  48662: {
    means: "native",
    status: { status: "N2N3N", authority: "NatureServe", iucn: 30 },
  },
  47126: {},
};
// 45 extra unique taxa so the batch-chunking test exercises >30 ids.
for (let id = 90001; id <= 90045; id++) {
  TAXA[id] = { means: id % 3 === 0 ? "introduced" : "native" };
}

function projectWith(): Project {
  const project = {
    schemaVersion: 1 as const,
    id: "tools-test",
    name: "Tools Test",
    deckLabel: "Tools Test",
    description: "",
    location: { name: "San Diego", lat: 32.75, lng: -117.05, radiusKm: 10 },
    categories: [
      { id: "plants", label: "Plants" },
      { id: "animals", label: "Animals" },
    ],
    species: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return project;
}

function fetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/places/nearby")) {
      return new Response(JSON.stringify({ total_results: 4, results: { standard: PLACES, community: [] } }), {
        status: 200,
      });
    }
    const taxaMatch = url.pathname.match(/\/v1\/taxa\/([\d,]+)$/);
    if (taxaMatch) {
      // iNat rejects batches over 30 ids with "Too many IDs" (422) — mirror it.
      const ids = taxaMatch[1].split(",").map(Number);
      if (ids.length > 30) {
        return new Response(JSON.stringify({ error: "Too many IDs", status: 422 }), { status: 422 });
      }
      expect(url.searchParams.get("place_id")).toBe("829"); // the resolved place
      const results = ids.map((id) => ({
        id,
        establishment_means: TAXA[id]?.means
          ? {
              establishment_means: TAXA[id].means,
              place: { id: 829, name: "San Diego", display_name: "San Diego County, CA, US" },
            }
          : null,
        conservation_status: TAXA[id]?.status
          ? { status: TAXA[id].status!.status, authority: TAXA[id].status!.authority, iucn: TAXA[id].status!.iucn }
          : null,
      }));
      return new Response(JSON.stringify({ total_results: results.length, results }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unmocked " + url.pathname }), { status: 404 });
  });
}

describe("deck tools (mocked iNat API)", () => {
  let fetchSpy: ReturnType<typeof fetchMock>;

  beforeEach(() => {
    fetchSpy = fetchMock();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves the smallest containing admin place", async () => {
    const place = await resolveInatPlace({ lat: 32.75, lng: -117.05, radiusKm: 10 });
    expect(place).toEqual({ id: 829, name: "San Diego County, CA, US" });
  });

  it("labels native/introduced from the place checklist and reports conflicts", async () => {
    const project = projectWith();
    project.species = [
      makeSpecies({ commonName: "Laurel Sumac", taxonId: 68205 }), // native → fills
      makeSpecies({ commonName: "Gray Squirrel", taxonId: 46017 }), // introduced → fills
      makeSpecies({ commonName: "Mallard", taxonId: 6930, native: "native" }), // agrees
      makeSpecies({ commonName: "Mislabeled", taxonId: 6930, native: "non-native" }), // conflict
    ];
    const { project: next, report } = await labelNativeStatus(project, undefined);
    const byName = new Map(next.species.map((s) => [s.commonName, s]));
    expect(byName.get("Laurel Sumac")!.native).toBe("native");
    expect(byName.get("Gray Squirrel")!.native).toBe("non-native");
    expect(byName.get("Mallard")!.native).toBe("native"); // untouched
    expect(byName.get("Mislabeled")!.native).toBe("non-native"); // kept
    expect(report.filled).toBe(2);
    expect(report.sourcePlace).toContain("San Diego County");
    expect(report.conflicts).toEqual([
      { species: "Mislabeled", detail: 'kept "non-native", iNat says "native"' },
    ]);
  });

  it("marks introduced species with the invasive border only when opted in", async () => {
    const project = projectWith();
    project.species = [
      makeSpecies({ commonName: "Gray Squirrel", taxonId: 46017 }),
      makeSpecies({ commonName: "Fancy Squirrel", taxonId: 46017, border: "notable" }),
    ];
    const withOption = await labelNativeStatus(project, undefined, { invasiveBorder: true });
    const byName = new Map(withOption.project.species.map((s) => [s.commonName, s]));
    expect(byName.get("Gray Squirrel")!.border).toBe("invasive");
    expect(byName.get("Fancy Squirrel")!.border).toBe("notable"); // kept
    expect(withOption.report.conflicts).toEqual([
      { species: "Fancy Squirrel", detail: 'border kept as "notable"' },
    ]);

    // Without the option, borders stay alone.
    const without = await labelNativeStatus(project, undefined);
    expect(without.project.species.find((s) => s.commonName === "Gray Squirrel")!.border).toBe("none");
  });

  it("labels conservation status and applies the notable border on request", async () => {
    const project = projectWith();
    project.species = [
      makeSpecies({ commonName: "Monarch", taxonId: 48662 }), // vulnerable
      makeSpecies({ commonName: "Laurel Sumac", taxonId: 68205 }), // no status
      makeSpecies({ commonName: "Named", taxonId: 48662, rarity: "hand-written" }), // conflict
    ];
    const { project: next, report } = await labelRarity(project, undefined, { notableBorder: true });
    const byName = new Map(next.species.map((s) => [s.commonName, s]));
    expect(byName.get("Monarch")!.rarity).toBe("vulnerable — NatureServe (N2N3N)");
    expect(byName.get("Monarch")!.border).toBe("notable");
    expect(byName.get("Laurel Sumac")!.rarity).toBeUndefined();
    expect(byName.get("Named")!.rarity).toBe("hand-written");
    expect(report.filled).toBe(2); // Monarch rarity + border
    expect(report.noData).toBe(1);
    expect(report.conflicts).toEqual([
      { species: "Named", detail: 'rarity kept as "hand-written", iNat says "vulnerable — NatureServe (N2N3N)"' },
    ]);
  });

  it("restricts to the selected species when scoped", async () => {
    const project = projectWith();
    const a = makeSpecies({ commonName: "Gray Squirrel", taxonId: 46017 });
    const b = makeSpecies({ commonName: "Laurel Sumac", taxonId: 68205 });
    project.species = [a, b];
    const { project: next, report } = await labelNativeStatus(project, { ids: [a.id] });
    expect(next.species.find((s) => s.id === a.id)!.native).toBe("non-native");
    expect(next.species.find((s) => s.id === b.id)!.native).toBe("unknown");
    expect(report.considered).toBe(1);
  });

  it("chunks large decks into batches of ≤30 ids (iNat's 'Too many IDs' limit)", async () => {
    const project = projectWith();
    // 45 unique taxa → two batches (30 + 15).
    project.species = Array.from({ length: 45 }, (_, i) =>
      makeSpecies({ commonName: `Species ${i}`, taxonId: 90001 + i }),
    );
    const { project: next, report } = await labelNativeStatus(project, undefined);
    expect(report.considered).toBe(45);
    expect(next.species.every((s) => s.native !== "unknown")).toBe(true);
    // 2 taxa requests + 1 place resolution, and no batch exceeded 30 ids.
    const taxaCalls = fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => /\/v1\/taxa\//.test(u));
    expect(taxaCalls).toHaveLength(2);
    for (const u of taxaCalls) {
      expect(u.split("?")[0].split("/").pop()!.split(",").length).toBeLessThanOrEqual(30);
    }
  });
});
