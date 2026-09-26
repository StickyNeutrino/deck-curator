import { describe, it, expect, vi, afterEach } from "vitest";
import { stripRankMarkers, looksLikeSciName, pickDistinct, chooseTaxon, downloadPhoto } from "~/lib/resolve";
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