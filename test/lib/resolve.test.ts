import { describe, it, expect, vi, afterEach } from "vitest";
import { stripRankMarkers, looksLikeSciName, pickDistinct, chooseTaxon, downloadPhoto, taxonDetailBatch, fetchTaxonDetail } from "~/lib/resolve";
import { setRequestGapForTests } from "~/lib/inat";
import type { InatTaxon, InatObservation, InatPhoto } from "~/lib/inat";

describe("stripRankMarkers", () => {
  it("removes ssp./var./f. markers for iNat queries", () => {
    expect(stripRankMarkers("Prunus ilicifolia ssp. lyonii")).toBe("prunus ilicifolia lyonii");
    expect(stripRankMarkers("Quercus agrifolia var. agrifolia")).toBe("quercus agrifolia agrifolia");
    expect(stripRankMarkers("Quercus agrifolia")).toBe("quercus agrifolia");
  });
});

describe("looksLikeSciName", () => {
  it("detects binomial scientific names", () => {
    expect(looksLikeSciName("Quercus agrifolia")).toBe(true);
    expect(looksLikeSciName("Dudleya edulis")).toBe(true);
    expect(looksLikeSciName("Coast Live Oak")).toBe(false);
    expect(looksLikeSciName("Oak")).toBe(false);
    expect(looksLikeSciName("quercus agrifolia")).toBe(false); // capitals matter
  });
});

describe("chooseTaxon", () => {
  const taxon = (over: Partial<InatTaxon>): InatTaxon => ({
    id: 1,
    name: "Species example",
    rank: "species",
    rank_level: 10,
    is_active: true,
    ...over,
  });

  it("prefers exact species-rank matches", () => {
    const complex = taxon({ id: 2, name: "Quercus agrifolia complex", rank_level: 5 });
    const exact = taxon({ id: 3, name: "Quercus agrifolia" });
    expect(chooseTaxon([complex, exact], "Quercus agrifolia")!.id).toBe(3);
  });

  it("matches synonyms to the active replacement (Dendroica → Setophaga)", () => {
    const active = taxon({ id: 7, name: "Setophaga petechia" });
    const results = [
      { ...active, matched_term: "Dendroica petechia" },
    ] as InatTaxon[];
    expect(chooseTaxon(results, "Dendroica petechia")!.id).toBe(7);
  });

  it("ignores inactive taxa", () => {
    const inactive = taxon({ is_active: false });
    expect(chooseTaxon([inactive], "Species example")).toBeNull();
  });

  it("returns null for infraspecific queries without an exact match", () => {
    const species = taxon({ id: 4, name: "Dudleya edulis" });
    expect(chooseTaxon([species], "Dudleya edulis ssp. sessilis")).toBeNull();
  });
});

describe("pickDistinct", () => {
  const obs = (id: number, user: string): InatObservation => ({
    id,
    user: { login: user },
    photos: [],
  });

  it("prefers distinct observations and observers", () => {
    const candidates = [
      { photo: {} as any, obs: obs(1, "alice") },
      { photo: {} as any, obs: obs(2, "bob") },
      { photo: {} as any, obs: obs(3, "alice") },
      { photo: {} as any, obs: obs(4, "carol") },
    ];
    const picked = pickDistinct(candidates, 3);
    // alice, bob, carol — alice's second observation is skipped first.
    expect(picked.map((p) => p.obs.id)).toEqual([1, 2, 4]);
  });

  it("falls back to reusing observers when needed", () => {
    const candidates = [
      { photo: {} as any, obs: obs(1, "alice") },
      { photo: {} as any, obs: obs(2, "alice") },
    ];
    expect(pickDistinct(candidates, 2).map((p) => p.obs.id)).toEqual([1, 2]);
  });
});

describe("downloadPhoto", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const photo = (over: Partial<InatPhoto> = {}): InatPhoto =>
    ({ id: 1, license_code: "cc-by", url: "https://inaturalist.org/x/medium.jpg", ...over }) as InatPhoto;

  function stubFetch(bodies: Array<{ type: string; bytes: number }>) {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call++;
      return {
        ok: true,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? body.type : null) },
        arrayBuffer: async () => new ArrayBuffer(body.bytes),
      };
    }));
  }

  it("keeps the response's content type so clips classify correctly", async () => {
    stubFetch([{ type: "video/mp4", bytes: 10000 }]);
    const blob = await downloadPhoto(photo());
    expect(blob.type).toBe("video/mp4");
  });

  it("falls back to jpeg when the server sends no content type", async () => {
    stubFetch([{ type: "", bytes: 10000 }]);
    const blob = await downloadPhoto(photo());
    expect(blob.type).toBe("image/jpeg");
  });

  it("skips tiny responses and tries the next variant", async () => {
    stubFetch([
      { type: "image/jpeg", bytes: 100 }, // too small — a thumbnail or error page
      { type: "image/jpeg", bytes: 10000 },
    ]);
    const blob = await downloadPhoto(photo());
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(10000);
  });
});

describe("taxonDetailBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps batched taxon records onto the family/category fields, ≤30 ids per request", async () => {
    setRequestGapForTests(0);
    const requested: number[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const m = url.pathname.match(/\/v1\/taxa\/([\d,]+)$/);
      const ids = m![1].split(",").map(Number);
      requested.push(ids);
      return new Response(JSON.stringify({
        total_results: ids.length,
        results: ids.map((id) => ({
          id,
          name: `Species ${id}`,
          rank: "species",
          rank_level: 10,
          is_active: true,
          preferred_common_name: `Common ${id}`,
          iconic_taxon_id: 47126,
          ancestors: [{ id: 900, name: "Crassulaceae", rank: "family", preferred_common_name: "Stonecrop family" }],
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const ids = Array.from({ length: 35 }, (_, i) => i + 1);
    const details = await taxonDetailBatch(ids);

    // 35 ids → two batched requests, each within iNat's "Too many IDs" limit.
    expect(requested).toHaveLength(2);
    for (const chunk of requested) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(details.size).toBe(35);
    expect(details.get(1)).toEqual({
      commonName: "Common 1",
      familyLatin: "Crassulaceae",
      familyCommon: "Stonecrop family",
      iconicTaxonId: 47126,
    });
  });

  it("falls back to a single-taxon fetch for one id", async () => {
    setRequestGapForTests(0);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const m = url.pathname.match(/\/v1\/taxa\/([\d,]+)$/);
      const ids = m![1].split(",").map(Number);
      return new Response(JSON.stringify({
        total_results: ids.length,
        results: ids.map((id) => ({
          id,
          name: "Dudleya edulis",
          rank: "species",
          rank_level: 10,
          is_active: true,
          iconic_taxon_id: 47126,
          ancestors: [{ id: 900, name: "Crassulaceae", rank: "family" }],
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const detail = await fetchTaxonDetail(42);
    expect(detail).toEqual({
      commonName: null,
      familyLatin: "Crassulaceae",
      familyCommon: null,
      iconicTaxonId: 47126,
    });
  });
});