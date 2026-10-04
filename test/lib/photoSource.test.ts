// Light-deck enabler: backfilling remote photo URLs for slots that predate
// URL tracking. Observations are batched (≤30 ids per call); slots with a
// stored url (or uploads) never hit the network.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { backfillPhotoUrls } from "~/lib/photoSource";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

vi.mock("~/lib/inat", () => ({
  inatGet: vi.fn(),
  photoVariants: (photo: { url: string }) => [
    photo.url.replace(/\/(square|thumb|small|medium|large)\./, "/original."),
  ],
}));

import { inatGet } from "~/lib/inat";

const obs = (id: number, photos: Array<{ id: number; url: string }>) => ({ id, photos });
const obsResponse = (results: ReturnType<typeof obs>[]) => ({ results });

function slot(id: string, obsId?: number, url?: string) {
  return {
    id,
    role: "main" as const,
    fileKey: `${id}.jpg`,
    credit: { observer: "A", license: "cc0", observationId: obsId },
    ...(url ? { url } : {}),
  };
}

beforeEach(() => {
  vi.mocked(inatGet).mockReset();
});

describe("backfillPhotoUrls", () => {
  it("resolves missing urls from the observation API, batching ids per call", async () => {
    vi.mocked(inatGet).mockImplementation(async (endpoint: string, params?: Record<string, string | number | boolean | undefined>) => {
      expect(endpoint).toBe("observations");
      const ids = String(params?.id ?? "").split(",").map(Number);
      return obsResponse(
        ids.map((n) =>
          obs(n, [
            { id: n * 10, url: `https://inat/${n * 10}/medium.jpg` },
            { id: n * 10 + 10, url: `https://inat/${n * 10 + 10}/medium.jpg` },
          ]),
        ),
      );
    });

    const project = newProject("Backfill");
    const a = makeSpecies({ commonName: "Oak", category: "plants" });
    // Two photos from observation 11; the trio slot has a stored url already.
    a.photos.push(
      slot("inat:110", 11),
      slot("inat:120", 11),
      slot("inat:100", 11, "https://inat/100/original.jpg"),
    );
    const b = makeSpecies({ commonName: "Fern", category: "plants" });
    b.photos.push(slot("inat:220", 22));
    project.species.push(a, b);

    const { urls, unresolved, apiFailed } = await backfillPhotoUrls(project);
    // One batched call for both observations, none for the stored-url slot.
    expect(inatGet).toHaveBeenCalledTimes(1);
    expect(inatGet).toHaveBeenCalledWith("observations", { id: "11,22", per_page: 2 }, undefined);
    expect(urls.get("inat:110")).toBe("https://inat/110/original.jpg");
    expect(urls.get("inat:120")).toBe("https://inat/120/original.jpg");
    expect(urls.get("inat:220")).toBe("https://inat/220/original.jpg");
    expect(urls.has("inat:100")).toBe(false); // stored url — nothing to backfill
    expect(unresolved).toEqual([]);
    expect(apiFailed).toBe(false);
  });

  it("splits large decks into chunks of at most 30 ids", async () => {
    const ids = Array.from({ length: 75 }, (_, i) => i + 1);
    vi.mocked(inatGet).mockImplementation(async (_endpoint: string, params?: Record<string, string | number | boolean | undefined>) => {
      const batch = String(params?.id ?? "").split(",").map(Number);
      return obsResponse(batch.map((n) => obs(n, [{ id: n, url: `https://inat/${n}/original.jpg` }])));
    });

    const project = newProject("Chunks");
    const s = makeSpecies({ commonName: "Oak", category: "plants" });
    for (const n of ids) s.photos.push(slot(`inat:${n}`, n));
    project.species.push(s);

    const { unresolved, apiFailed } = await backfillPhotoUrls(project);
    const calls = vi.mocked(inatGet).mock.calls as unknown as Array<[string, { id: string }]>;
    expect(calls.map(([, p]) => p.id.split(",").length)).toEqual([30, 30, 15]);
    expect(unresolved).toEqual([]);
    expect(apiFailed).toBe(false);
  });

  it("reports slots it cannot resolve (uploads, missing observation)", async () => {
    const project = newProject("Unresolved");
    const a = makeSpecies({ commonName: "Oak", category: "plants" });
    a.photos.push(
      slot("upload:abc"), // uploads have no remote source
      slot("inat:555"), // iNat pick with no observation id to query
    );
    project.species.push(a);

    const { urls, unresolved, apiFailed } = await backfillPhotoUrls(project);
    expect(inatGet).not.toHaveBeenCalled();
    expect(urls.size).toBe(0);
    expect(unresolved).toEqual(["inat:555"]); // uploads aren't iNat photos
    expect(apiFailed).toBe(false);
  });

  it("keeps slots unresolved when a lookup misses the photo", async () => {
    vi.mocked(inatGet).mockResolvedValue(
      obsResponse([obs(32, [{ id: 999, url: "https://inat/999/original.jpg" }])]), // not our photo
    );
    const project = newProject("Missed");
    const a = makeSpecies({ commonName: "Oak", category: "plants" });
    a.photos.push(slot("inat:888", 32));
    project.species.push(a);

    const { urls, unresolved, apiFailed } = await backfillPhotoUrls(project);
    expect(urls.size).toBe(0);
    expect(unresolved).toEqual(["inat:888"]);
    expect(apiFailed).toBe(false); // the API answered — the photo just wasn't there
  });

  it("flags api failure separately so callers can ask for a retry", async () => {
    vi.mocked(inatGet).mockRejectedValue(new Error("HTTP 502"));
    const project = newProject("Down");
    const a = makeSpecies({ commonName: "Oak", category: "plants" });
    a.photos.push(slot("inat:777", 31), slot("inat:888", 32));
    project.species.push(a);

    const { urls, unresolved, apiFailed } = await backfillPhotoUrls(project);
    expect(urls.size).toBe(0);
    expect(unresolved.sort()).toEqual(["inat:777", "inat:888"]);
    expect(apiFailed).toBe(true);
  });

  it("reports progress as batches land", async () => {
    vi.mocked(inatGet).mockImplementation(async (_e: string, params?: Record<string, string | number | boolean | undefined>) => {
      const batch = String(params?.id ?? "").split(",").map(Number);
      return obsResponse(batch.map((n) => obs(n, [{ id: n, url: `https://inat/${n}/original.jpg` }])));
    });
    const project = newProject("Progress");
    const s = makeSpecies({ commonName: "Oak", category: "plants" });
    for (const n of [1, 2]) s.photos.push(slot(`inat:${n}`, n));
    project.species.push(s);

    const seen: Array<[number, number]> = [];
    await backfillPhotoUrls(project, { onProgress: (r, rem) => seen.push([r, rem]) });
    expect(seen).toEqual([[2, 0]]);
  });

  it("aborts between batches (cancellation, not an outage)", async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.mocked(inatGet).mockImplementation(async () => {
      calls++;
      const res = obsResponse([obs(1, [{ id: 1, url: "https://inat/1/original.jpg" }])]);
      if (calls === 1) controller.abort(); // cancel while the first batch lands
      return res;
    });
    const project = newProject("Abort");
    const s = makeSpecies({ commonName: "Oak", category: "plants" });
    for (let n = 1; n <= 35; n++) s.photos.push(slot(`inat:${n}`, n)); // two batches
    project.species.push(s);

    await expect(backfillPhotoUrls(project, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toBe(1); // the second batch never started
    expect((vi.mocked(inatGet).mock.calls[0] as unknown[])[2]).toBe(controller.signal);
  });
});
