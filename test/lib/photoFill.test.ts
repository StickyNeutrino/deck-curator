import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fillMissingPhotos } from "~/lib/tools";
import type { Project } from "~/lib/types";
import { makeSpecies } from "~/lib/types";
import { getFile } from "~/lib/store";
import { setRequestGapForTests } from "~/lib/inat";

/**
 * Integration test for "Fill missing photos", against a mocked iNat API.
 * The tool searches observations worldwide (no lat/lng/place params — that's
 * the point: cards added from a place search can end up photo-less while the
 * worldwide species-page browser finds plenty), then downloads and stores the
 * picked photos into the deck's file store (fake-indexeddb here).
 *
 * Every test uses its own taxon ids — inatGet caches API responses in the
 * (fake) IndexedDB cache, which outlives individual tests in this file.
 */

const JPEG_BYTES = new Uint8Array(6000); // > downloadPhoto's 5000-byte floor

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** taxonId → observations, each with one CC-licensed research-grade photo.
 *  `"none"` marks a taxon with no observations at all. */
let OBSERVATIONS: Record<number, Array<{ obsId: number; photoId: number; user: string }> | "none">;

function taxonObservations(taxonId: number) {
  const rows = OBSERVATIONS[taxonId];
  if (!rows || rows === "none") return [];
  return rows.map((row) => ({
    id: row.obsId,
    uri: `https://www.inaturalist.org/observations/${row.obsId}`,
    quality_grade: "research",
    user: { name: row.user },
    photos: [
      {
        id: row.photoId,
        license_code: "cc-by",
        attribution: `${row.user}, some rights reserved (CC BY)`,
        url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${row.photoId}/square.jpg`,
        file_content_type: "image/jpeg",
      },
    ],
  }));
}

function fetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/v1/observations")) {
      const taxonId = Number(url.searchParams.get("taxon_id"));
      return jsonResponse({ total_results: 1, results: taxonObservations(taxonId) });
    }
    if (url.pathname.endsWith("/v1/taxa/autocomplete")) {
      const q = url.searchParams.get("q") ?? "";
      const hit = q === "quercus agrifolia";
      return jsonResponse({
        total_results: hit ? 1 : 0,
        results: hit
          ? [{ id: 99001, name: "Quercus agrifolia", rank: "species", rank_level: 10, is_active: true }]
          : [],
      });
    }
    const taxaMatch = url.pathname.match(/\/v1\/taxa\/([\d,]+)$/);
    if (taxaMatch) {
      // taxonDetail (name resolution) — minimal active species records.
      const ids = taxaMatch[1].split(",").map(Number);
      return jsonResponse({
        total_results: ids.length,
        results: ids.map((id) => ({ id, name: `Taxon ${id}`, rank: "species", rank_level: 10, is_active: true })),
      });
    }
    // Photo download (original/large/medium variants served from the CDN).
    if (url.pathname.match(/\/photos\/\d+\/(original|large|medium)\./)) {
      return new Response(JPEG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response(JSON.stringify({ error: "unmocked " + url.pathname }), { status: 404 });
  });
}

function projectWith(species: ReturnType<typeof makeSpecies>[]): Project {
  return {
    schemaVersion: 1,
    id: "photo-fill-test",
    name: "Photo Fill Test",
    deckLabel: "Photo Fill Test",
    description: "",
    location: { name: "San Diego", lat: 32.75, lng: -117.05, radiusKm: 10 },
    categories: [{ id: "plants", label: "Plants" }],
    species,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("fillMissingPhotos (mocked iNat API)", () => {
  let fetchSpy: ReturnType<typeof fetchMock>;

  beforeEach(() => {
    setRequestGapForTests(0);
    OBSERVATIONS = {};
    fetchSpy = fetchMock();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fills empty trio cards from the worldwide search, roles and credits attached", async () => {
    OBSERVATIONS[68205] = [
      { obsId: 1, photoId: 101, user: "Ann" },
      { obsId: 2, photoId: 102, user: "Bob" },
      { obsId: 3, photoId: 103, user: "Cara" },
      { obsId: 4, photoId: 104, user: "Dan" }, // trio cap is 3 — never downloaded
    ];
    const project = projectWith([makeSpecies({ commonName: "Coast Live Oak", taxonId: 68205 })]);

    const { project: next, report } = await fillMissingPhotos(project, undefined);

    const oak = next.species[0];
    expect(oak.photos).toHaveLength(3);
    expect(oak.photos.map((p) => p.id)).toEqual(["inat:101", "inat:102", "inat:103"]);
    expect(oak.photos.map((p) => p.role)).toEqual(["main", "secondary", "secondary"]);
    expect(oak.photos[0].credit).toMatchObject({ observer: "Ann", license: "cc-by" });
    // The blobs landed in the deck's file store (what export zips up).
    for (const slot of oak.photos) {
      expect(await getFile(project.id, slot.fileKey)).toBeDefined();
    }
    expect(report).toMatchObject({ considered: 1, filled: 1, noData: 0, conflicts: [] });
    // Worldwide: no lat/lng/radius on the search the add flow would scope.
    const obsUrl = fetchSpy.mock.calls
      .map((c) => new URL(String(c[0])))
      .find((u) => u.pathname.endsWith("/v1/observations"))!;
    expect(obsUrl.searchParams.get("lat")).toBeNull();
    expect(obsUrl.searchParams.get("place_id")).toBeNull();
  });

  it("tops up partially-filled cards by default but only photo-less ones on request", async () => {
    OBSERVATIONS[68206] = [
      { obsId: 10, photoId: 201, user: "Ann" },
      { obsId: 11, photoId: 202, user: "Bob" },
    ];
    OBSERVATIONS[68207] = [{ obsId: 1, photoId: 101, user: "Cara" }];
    const pine = makeSpecies({ commonName: "Pine", taxonId: 68206 });
    pine.photos.push({ id: "upload:1", role: "main", fileKey: "pine-1.jpg", credit: { observer: "Me", license: "cc0" } });
    const oak = makeSpecies({ commonName: "Oak", taxonId: 68207 });
    const project = projectWith([pine, oak]);

    const toppedUp = await fillMissingPhotos(project, undefined);
    const pineAfter = toppedUp.project.species.find((s) => s.commonName === "Pine")!;
    expect(pineAfter.photos).toHaveLength(3); // kept its own photo, gained two
    expect(pineAfter.photos[0]).toMatchObject({ id: "upload:1", role: "main" });
    expect(pineAfter.photos[1].role).toBe("secondary");
    expect(toppedUp.report).toMatchObject({ considered: 2, filled: 2 });

    const onlyEmpty = await fillMissingPhotos(project, undefined, { topUp: false });
    const pineKept = onlyEmpty.project.species.find((s) => s.commonName === "Pine")!;
    expect(pineKept.photos).toHaveLength(1); // untouched
    expect(onlyEmpty.project.species.find((s) => s.commonName === "Oak")!.photos).toHaveLength(1);
    expect(onlyEmpty.report).toMatchObject({ considered: 1, filled: 1 });
  });

  it("never re-picks a photo another card in the deck already uses", async () => {
    OBSERVATIONS[68208] = [
      { obsId: 20, photoId: 401, user: "Ann" }, // already on the variant card
      { obsId: 21, photoId: 402, user: "Bob" },
      { obsId: 22, photoId: 403, user: "Cara" },
    ];
    const variant = makeSpecies({ commonName: "Sage (2)", taxonId: 68208 });
    // Full card (3/3) so the tool doesn't try to top it up.
    variant.photos.push(
      { id: "inat:401", role: "main", fileKey: "sage-1.jpg", credit: { observer: "Ann", license: "cc-by" } },
      { id: "upload:1", role: "secondary", fileKey: "sage-2.jpg", credit: { observer: "Me", license: "cc0" } },
      { id: "upload:2", role: "secondary", fileKey: "sage-3.jpg", credit: { observer: "Me", license: "cc0" } },
    );
    const base = makeSpecies({ commonName: "Sage", taxonId: 68208 });
    const project = projectWith([variant, base]);

    const { project: next, report } = await fillMissingPhotos(project, undefined);
    const sage = next.species.find((s) => s.commonName === "Sage")!;
    // 401 belongs to the variant card, so only 402/403 were available.
    expect(sage.photos.map((p) => p.id)).toEqual(["inat:402", "inat:403"]);
    expect(next.species.find((s) => s.commonName === "Sage (2)")!.photos).toHaveLength(3); // untouched
    expect(report.filled).toBe(1);
  });

  it("resolves missing taxon ids by name and reports names iNat can't resolve", async () => {
    OBSERVATIONS[99001] = [{ obsId: 1, photoId: 101, user: "Ann" }];
    const project = projectWith([
      makeSpecies({ commonName: "Coast Live Oak", sciName: "Quercus agrifolia" }),
      makeSpecies({ commonName: "Mystery Plant", sciName: "Notus arealus" }),
    ]);

    const { project: next, report } = await fillMissingPhotos(project, undefined);

    const oak = next.species.find((s) => s.sciName === "Quercus agrifolia")!;
    expect(oak.taxonId).toBe(99001); // filled for future runs
    expect(oak.photos).toHaveLength(1);

    const mystery = next.species.find((s) => s.sciName === "Notus arealus")!;
    expect(mystery.photos).toHaveLength(0);
    expect(mystery.taxonId).toBeUndefined();
    expect(report).toMatchObject({ considered: 2, filled: 1, noData: 0 });
    expect(report.conflicts).toEqual([
      { species: "Mystery Plant", detail: "“Notus arealus” didn't resolve on iNat — run “Fill gaps & re-sort categories” first" },
    ]);
  });

  it("reports species iNat has no CC photos for, and honors the selection scope", async () => {
    OBSERVATIONS[68210] = "none";
    OBSERVATIONS[68211] = [{ obsId: 30, photoId: 501, user: "Ann" }];
    const empty = makeSpecies({ commonName: "Rare Thing", taxonId: 68210 });
    const fillable = makeSpecies({ commonName: "Common Thing", taxonId: 68211 });
    const full = makeSpecies({ commonName: "Full Card", taxonId: 68211 });
    full.photos.push({ id: "upload:9", role: "main", fileKey: "full.jpg", credit: { observer: "Me", license: "cc0" } });
    const project = projectWith([empty, fillable, full]);

    const { project: next, report } = await fillMissingPhotos(project, { ids: [empty.id, fillable.id] });

    expect(next.species.find((s) => s.id === full.id)!.photos).toHaveLength(1); // out of scope
    expect(report).toMatchObject({ considered: 2, filled: 1, noData: 1, conflicts: [] });
  });
});