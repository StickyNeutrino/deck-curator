import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  autocompleteTaxon,
  taxonDetail,
  observations,
  placesAutocomplete,
  nearbyPlaces,
  taxaRecords,
  setRequestGapForTests,
} from "~/lib/inat";
import { clearCachedApi } from "~/lib/store";

// iNat answers with `{ results: [...] }`; a 2xx body that isn't shaped that
// way (a proxy interstitial, a truncated or future API response) must read
// as "nothing found" — not crash a search or a tool job with a TypeError
// deep inside a loop over `json.results`.

function serve(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  })));
}

describe("inat response shapes", () => {
  beforeEach(async () => {
    setRequestGapForTests(0);
    // The response cache is shared module state across the worker — clear it
    // so each test drives its own fetch (see store.clearCachedApi).
    await clearCachedApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a body with no results array as an empty search", async () => {
    serve({ total_results: 0 });
    await expect(autocompleteTaxon("oak")).resolves.toEqual([]);
    await expect(observations({ taxonId: 1 })).resolves.toEqual([]);
    await expect(placesAutocomplete("san diego")).resolves.toEqual([]);
    await expect(taxaRecords([1])).resolves.toEqual(new Map());
    await expect(taxonDetail(1)).resolves.toBeUndefined();
    await expect(nearbyPlaces({ lat: 0, lng: 0 })).resolves.toEqual([]);
  });

  it("survives a null body", async () => {
    serve(null);
    await expect(autocompleteTaxon("oak")).resolves.toEqual([]);
    await expect(taxonDetail(2)).resolves.toBeUndefined();
    await expect(nearbyPlaces({ lat: 0, lng: 0 })).resolves.toEqual([]);
  });

  it("ignores non-array place lists inside a results object", async () => {
    serve({ results: { standard: "junk", community: 7 } });
    await expect(nearbyPlaces({ lat: 0, lng: 0 })).resolves.toEqual([]);
  });

  it("still parses well-formed responses", async () => {
    serve({ results: [{ id: 42, name: "Quercus", rank: "genus", rank_level: 20, is_active: true }] });
    const taxa = await autocompleteTaxon("oak");
    expect(taxa).toHaveLength(1);
    expect(taxa[0].id).toBe(42);
    const detail = await taxonDetail(43);
    expect(detail?.name).toBe("Quercus");
    const records = await taxaRecords([42]);
    expect(records.get(42)?.name).toBe("Quercus");
  });
});