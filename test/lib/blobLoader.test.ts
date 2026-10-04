import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBlobLoader } from "~/lib/blobLoader";
import type { BlobLoader } from "~/lib/blobLoader";

/**
 * The loader's reads go through the store module; mocking `cachedGetFile`
 * (whose reads never settle on their own) and `peekCachedFile` (never warm)
 * makes load ordering fully deterministic: a key has loaded exactly when the
 * test settles its deferred.
 */

vi.mock("~/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/store")>();
  return {
    ...actual,
    cachedGetFile: vi.fn(() => new Promise<Blob>(() => undefined)),
    peekCachedFile: vi.fn(() => undefined),
  };
});

import { cachedGetFile } from "~/lib/store";
const cachedGetFileMock = vi.mocked(cachedGetFile);

/** One deferred per requested key, keyed by the fileKey argument. */
const deferreds = new Map<string, (blob: Blob) => void>();
const settled = new Map<string, Blob>();

function blobOf(text: string): Blob {
  return new Blob([text], { type: "image/jpeg" });
}

/** Simulate the store finishing a read for this key. */
function settle(key: string): void {
  const blob = blobOf(key);
  settled.set(key, blob);
  deferreds.get(key)!(blob);
}

/** The keys the loader has asked the store for, in request order. */
function requested(): string[] {
  return cachedGetFileMock.mock.calls.map(([, key]) => key as string);
}

/** Let the loader's promise plumbing run to a stable point. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const PROJECT = "loader-test";

describe("blobLoader", () => {
  let loader: BlobLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    deferreds.clear();
    settled.clear();
    cachedGetFileMock.mockImplementation(
      (_projectId: string, key: string) =>
        new Promise<Blob>((resolveBlob) => deferreds.set(key, resolveBlob)),
    );
    loader = createBlobLoader(PROJECT);
  });

  afterEach(() => {
    // Un-settled deferreds must not surface as unhandled rejections.
    for (const key of deferreds.keys()) if (!settled.has(key)) settle(key);
  });

  it("caps parallel reads and tops the queue back up as loads finish", async () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const waits = keys.map((key) => loader.resolve(key));
    await tick();
    // Exactly the first PARALLEL_READS (5) start; the rest wait in line.
    expect(requested()).toEqual(["a", "b", "c", "d", "e"]);

    settle("a");
    await tick();
    expect(requested()).toEqual(["a", "b", "c", "d", "e", "f"]);

    for (const key of ["b", "c", "d", "e"]) settle(key);
    await tick();
    expect(requested()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);

    for (const key of ["f", "g", "h"]) settle(key);
    const blobs = await Promise.all(waits);
    for (let i = 0; i < keys.length; i++) expect(blobs[i]).toBe(settled.get(keys[i]));
  });

  it("pins the prioritized keys to the head of the queue", async () => {
    // A backlog first: the page scrolled, six keys queued, five started.
    const backlog = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const backlogWaits = backlog.map((key) => loader.resolve(key));
    await tick();
    expect(requested()).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    // Then the project loads and the page pins the first cards' keys.
    loader.prioritize(["h1", "h2", "h3", "s3"]);
    await tick();
    // All five read slots are busy, so nothing new can start yet — but the
    // queue is re-ordered (s3 was already started, so it's skipped).
    expect(requested()).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    // As reads finish, the head keys start first, then the backlog.
    settle("s1");
    await tick();
    expect(requested()).toEqual(["s1", "s2", "s3", "s4", "s5", "h1"]);
    settle("s2");
    await tick();
    expect(requested()).toEqual(["s1", "s2", "s3", "s4", "s5", "h1", "h2"]);
    settle("s3");
    await tick();
    expect(requested()).toEqual(["s1", "s2", "s3", "s4", "s5", "h1", "h2", "h3"]);
    settle("s4");
    settle("s5");
    await tick();
    expect(requested()).toEqual([
      "s1", "s2", "s3", "s4", "s5", "h1", "h2", "h3", "s6",
    ]);

    settle("h1");
    settle("h2");
    settle("h3");
    settle("s6");
    const blobs = await Promise.all(backlogWaits);
    for (let i = 0; i < backlog.length; i++) expect(blobs[i]).toBe(settled.get(backlog[i]));
  });

  it("prioritizing an already-started key does not restart it", async () => {
    const wait = loader.resolve("one");
    await tick();
    loader.prioritize(["one", "two"]);
    await tick();
    // "one" is in flight — only "two" is requested now.
    expect(requested()).toEqual(["one", "two"]);
    settle("one");
    settle("two");
    expect(await wait).toBe(settled.get("one"));
  });

  it("shares one load between every caller of the same key", async () => {
    const a = loader.resolve("shared");
    const b = loader.resolve("shared");
    await tick();
    expect(requested()).toEqual(["shared"]);
    settle("shared");
    expect(await a).toBe(settled.get("shared"));
    expect(await b).toBe(settled.get("shared"));
  });

  it("resolves undefined when the store read rejects (file gone)", async () => {
    cachedGetFileMock.mockImplementationOnce(() => Promise.reject(new Error("gone")));
    await expect(loader.resolve("vanished.jpg")).resolves.toBeUndefined();
  });
});
