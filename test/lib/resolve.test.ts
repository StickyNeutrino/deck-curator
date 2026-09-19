import { describe, it, expect } from "vitest";
import { stripRankMarkers, looksLikeSciName, pickDistinct, chooseTaxon } from "~/lib/resolve";
import type { InatTaxon, InatObservation } from "~/lib/inat";

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