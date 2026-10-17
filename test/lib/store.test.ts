import { describe, it, expect } from "vitest";
import { saveProject, getProject, listProjects, deleteProject, putFile, getFile, listFiles, deleteFile, renameProject, cachedGetFile, peekCachedFile, restoreSnapshot, withRecordLock, onProjectChange } from "~/lib/store";
import { blobToArrayBuffer } from "~/lib/blobUtils";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

describe("project store", () => {
  it("round-trips a project", async () => {
    const project = newProject("Test Deck");
    project.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
    await saveProject(project);

    const loaded = await getProject(project.id);
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Test Deck");
    expect(loaded!.species).toHaveLength(1);
    expect(loaded!.species[0].commonName).toBe("Oak");
  });

  it("does not mutate the record object it is given", async () => {
    const project = newProject("Immutable");
    const before = project.updatedAt;
    await saveProject(project, "2026-01-01T00:00:00.000Z");
    // Callers pass live React state; stamping the stored copy must not
    // change it without a re-render.
    expect(project.updatedAt).toBe(before);
    expect((await getProject(project.id))!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("lists projects with counts, newest first", async () => {
    const a = newProject("Alpha");
    const b = newProject("Beta");
    a.species.push(makeSpecies({ commonName: "One" }));
    b.species.push(makeSpecies({ commonName: "Two" }), makeSpecies({ commonName: "Three" }));
    b.species[0].photos.push({
      id: "upload:x",
      role: "main",
      credit: { observer: "You", license: "cc0" },
      fileKey: "one-main.jpg",
    });
    await saveProject(a, "2026-01-01T00:00:00.000Z");
    await saveProject(b, "2026-02-01T00:00:00.000Z");

    const summaries = (await listProjects()).filter((p) => [a.id, b.id].includes(p.id));
    expect(summaries).toHaveLength(2);
    // b was saved after a → newest first.
    expect(summaries[0].name).toBe("Beta");
    expect(summaries[0].speciesCount).toBe(2);
    expect(summaries[0].photoCount).toBe(1);
    expect(summaries[1].name).toBe("Alpha");
  });

  it("deletes a project and its files", async () => {
    const project = newProject("Doomed");
    await saveProject(project);
    await putFile(project.id, "x.jpg", new Blob(["hello"]));
    await putFile("other", "y.jpg", new Blob([]));
    expect(await getFile(project.id, "x.jpg")).toBeInstanceOf(Blob);

    await deleteProject(project.id);
    expect(await getProject(project.id)).toBeUndefined();
    expect(await getFile(project.id, "x.jpg")).toBeUndefined();
    // Files of other projects survive.
    expect((await listFiles("other")).size).toBe(1);
  });

  it("deletes individual files", async () => {
    const project = newProject("Files");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["a"]));
    expect((await listFiles(project.id)).get("a.jpg")).toBeInstanceOf(Blob);
    await deleteFile(project.id, "a.jpg");
    expect(await getFile(project.id, "a.jpg")).toBeUndefined();
  });

  it("preserves each blob's MIME type through the store", async () => {
    const project = newProject("Mime");
    await saveProject(project);
    // Clips must keep video/gif types so classification still works after a
    // round trip; typeless blobs fall back to jpeg.
    await putFile(project.id, "clip.mp4", new Blob(["bytes"], { type: "video/mp4" }));
    await putFile(project.id, "pic.png", new Blob(["bytes"], { type: "image/png" }));
    await putFile(project.id, "plain.jpg", new Blob(["bytes"]));
    expect((await getFile(project.id, "clip.mp4"))!.type).toBe("video/mp4");
    expect((await getFile(project.id, "pic.png"))!.type).toBe("image/png");
    expect((await getFile(project.id, "plain.jpg"))!.type).toBe("image/jpeg");
    const listed = await listFiles(project.id);
    expect(listed.get("clip.mp4")!.type).toBe("video/mp4");
  });

  it("renames a project: record and files move to the new id", async () => {
    const project = newProject("Rename Me");
    await saveProject(project);
    await putFile(project.id, "photo-main.jpg", new Blob(["jpeg"]));
    await putFile("other", "keep.jpg", new Blob(["untouched"]));

    await renameProject(project.id, "renamed-deck");

    // The old record and its files are gone; the new ones are in place.
    expect(await getProject(project.id)).toBeUndefined();
    expect(await getFile(project.id, "photo-main.jpg")).toBeUndefined();
    const loaded = await getProject("renamed-deck");
    expect(loaded).toBeDefined();
    expect(loaded!.deckLabel).toBe("Rename Me");
    expect((await getFile("renamed-deck", "photo-main.jpg"))!.size).toBe(4);
    // Other projects' files are untouched.
    expect((await getFile("other", "keep.jpg"))!.size).toBe(9);
  });

  it("refuses to rename onto an id another deck already uses", async () => {
    const a = newProject("Alpha");
    const b = newProject("Beta");
    await saveProject(a);
    await saveProject(b);
    await putFile(a.id, "x.jpg", new Blob(["x"]));

    await expect(renameProject(a.id, b.id)).rejects.toThrow(/already uses/);
    // Nothing moved: both records and files are intact.
    expect(await getProject(a.id)).toBeDefined();
    expect(await getProject(b.id)).toBeDefined();
    expect(await getFile(a.id, "x.jpg")).toBeDefined();
  });

  it("notifies record observers after writes, moves, and deletes", async () => {
    const events: string[] = [];
    const unsubscribe = onProjectChange((id) => events.push(id));
    const project = newProject("Observed");
    await saveProject(project);
    expect(events).toEqual([project.id]);
    await renameProject(project.id, "observed-2");
    expect(events).toEqual([project.id, project.id, "observed-2"]);
    await deleteProject("observed-2");
    expect(events).toEqual([project.id, project.id, "observed-2", "observed-2"]);
    unsubscribe();
    await saveProject({ ...project, id: "observed-3" });
    expect(events).toHaveLength(4);
  });

  it("a record write that overlaps a rename travels with the deck", async () => {
    const project = newProject("Travels");
    await saveProject(project);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // A background job's read-modify-write cycle starts first, then stalls
    // before its write; the rename queues behind it.
    const job = withRecordLock(project.id, async () => {
      const current = await getProject(project.id);
      const draft = structuredClone(current!);
      draft.description = "job was here";
      await gate;
      await saveProject(draft);
    });
    const rename = renameProject(project.id, "travelling-deck");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await job;
    await rename;
    // The job's write landed before the move, so the moved record carries
    // it — and the old id is gone, not resurrected by the job's write.
    const moved = await getProject("travelling-deck");
    expect(moved?.description).toBe("job was here");
    expect(await getProject(project.id)).toBeUndefined();
  });

  it("keeps a warm in-memory cache across reads", async () => {
    const project = newProject("Warm");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["a"]));
    const first = await cachedGetFile(project.id, "a.jpg");
    expect(first).toBeInstanceOf(Blob);
    expect(peekCachedFile(project.id, "a.jpg")).toBe(first);
    // The repeat read returns the SAME blob object — served from memory,
    // not a fresh IndexedDB round-trip (which always yields a new Blob).
    expect(await cachedGetFile(project.id, "a.jpg")).toBe(first);
    // A cold store read also lands in the cache.
    expect(await cachedGetFile(project.id, "missing.jpg")).toBeUndefined();
  });

  it("refreshes the cache when a file is overwritten or removed", async () => {
    const project = newProject("Fresh");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["old-bytes"]));
    expect((await cachedGetFile(project.id, "a.jpg"))!.size).toBe(9);
    // Overwriting the key must never serve the stale bytes.
    await putFile(project.id, "a.jpg", new Blob(["brand-new-bytes"]));
    expect((await cachedGetFile(project.id, "a.jpg"))!.size).toBe(15);
    await deleteFile(project.id, "a.jpg");
    expect(peekCachedFile(project.id, "a.jpg")).toBeUndefined();
    expect(await cachedGetFile(project.id, "a.jpg")).toBeUndefined();
  });

  it("keeps the cache on the newest bytes when a cold read overlaps an overwrite", async () => {
    const project = newProject("Overlap");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["first"]));
    await cachedGetFile(project.id, "a.jpg");
    // Churn the cache past its limit so the next read is a cold fill whose
    // IndexedDB read is still in flight while the overwrite lands.
    for (let i = 0; i < 300; i++) {
      await putFile(project.id, `churn-${i}.jpg`, new Blob([String(i)]));
    }
    const fill = cachedGetFile(project.id, "a.jpg");
    await putFile(project.id, "a.jpg", new Blob(["brand-new-bytes"]));
    // The fill read the pre-overwrite record (the read transaction was
    // issued first) — its stale bytes must not land in the cache over the
    // fresh entry the write remembered.
    expect((await fill)!.size).toBe(5);
    const again = await cachedGetFile(project.id, "a.jpg");
    expect(again!.size).toBe(15);
    expect(again).toBe(peekCachedFile(project.id, "a.jpg"));
  });

  it("drops cached blobs when a version restore rewrites the deck's files", async () => {
    const project = newProject("Restore");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["a"]));
    await cachedGetFile(project.id, "a.jpg");
    const rewritten = await blobToArrayBuffer(new Blob(["rewritten"]));

    await restoreSnapshot(project.id, new Map([["a.jpg", rewritten]]), new Set(["a.jpg"]), project);

    expect(peekCachedFile(project.id, "a.jpg")).toBeUndefined();
    expect((await cachedGetFile(project.id, "a.jpg"))!.size).toBe(9);
  });

  it("evicts the oldest cached blobs once the limit is hit", async () => {
    const project = newProject("Big");
    await saveProject(project);
    for (let i = 0; i < 300; i++) {
      await putFile(project.id, `photo-${i}.jpg`, new Blob([String(i)]));
    }
    // The cache keeps the most recent writes and drops the oldest; the
    // store itself still holds everything.
    expect(peekCachedFile(project.id, "photo-299.jpg")).toBeInstanceOf(Blob);
    expect(peekCachedFile(project.id, "photo-0.jpg")).toBeUndefined();
    expect((await listFiles(project.id)).size).toBe(300);
  });

  it("moves cached blobs with a project rename and drops them on delete", async () => {
    const project = newProject("Mover");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["a"]));
    await cachedGetFile(project.id, "a.jpg");

    await renameProject(project.id, "moved-deck");
    expect(peekCachedFile(project.id, "a.jpg")).toBeUndefined();
    expect(peekCachedFile("moved-deck", "a.jpg")).toBeInstanceOf(Blob);

    await deleteProject("moved-deck");
    expect(peekCachedFile("moved-deck", "a.jpg")).toBeUndefined();
  });
});