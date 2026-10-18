import { describe, it, expect } from "vitest";
import {
  saveProject,
  getProject,
  putFile,
  getFile,
  deleteProject,
  renameProject,
  withRecordLock,
} from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

/**
 * Deletion must be serialized with the record writers the way rename and
 * restore are: a save cycle that straddles a deletion must either land
 * before it or see the record gone — never resurrect a deck whose files
 * were just removed.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("deletion vs concurrent writers", () => {
  it("a page-style save cycle cannot land after a concurrent deletion", async () => {
    const p = newProject("Delete Race");
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["bytes"]));

    // The save cycle holds the lock first (mirroring useProjectDoc: join
    // the lock, re-check, write); the deletion queues behind it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saveCycle = withRecordLock(p.id, async () => {
      await gate;
      if (await getProject(p.id)) {
        await saveProject({ ...p, description: "last edit" });
      }
    });
    await sleep(20);
    const deletion = deleteProject(p.id);
    release();
    await saveCycle;
    await deletion;

    expect(await getProject(p.id)).toBeUndefined();
    expect(await getFile(p.id, "a.jpg")).toBeUndefined();
  });

  it("a save cycle queued behind a deletion sees the record gone and skips", async () => {
    const p = newProject("Delete Then Save");
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["bytes"]));

    // Hold the lock, start the deletion (queues behind), then queue the
    // page-style save cycle: it runs after the delete and must not
    // resurrect the deck.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withRecordLock(p.id, async () => {
      await gate;
    });
    await sleep(20);
    const deletion = deleteProject(p.id);
    const saveCycle = withRecordLock(p.id, async () => {
      if (await getProject(p.id)) {
        await saveProject({ ...p, description: "resurrected" });
      }
    });
    release();
    await Promise.all([holder, deletion, saveCycle]);

    expect(await getProject(p.id)).toBeUndefined();
    expect(await getFile(p.id, "a.jpg")).toBeUndefined();
    expect(await listAllProjectsHas(p.id)).toBe(false);
  });

  it("deleteProject still removes record and files together", async () => {
    const p = newProject("Plain Delete");
    p.species.push(makeSpecies({ commonName: "Oak" }));
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["a"]));
    await putFile("other", "keep.jpg", new Blob(["keep"]));
    await deleteProject(p.id);
    expect(await getProject(p.id)).toBeUndefined();
    expect(await getFile(p.id, "a.jpg")).toBeUndefined();
    expect(await getFile("other", "keep.jpg")).toBeInstanceOf(Blob);
  });
});

async function listAllProjectsHas(id: string): Promise<boolean> {
  const { listProjects } = await import("~/lib/store");
  return (await listProjects()).some((p) => p.id === id);
}

// renameProject keeps its transactional uniqueness guarantee alongside the
// deletion coverage above.
describe("rename sanity alongside deletion coverage", () => {
  it("rename of a missing deck fails without creating anything", async () => {
    await expect(renameProject("no-such-deck", "anything")).rejects.toThrow(/No deck/);
    expect(await getProject("anything")).toBeUndefined();
  });
});
