import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectDoc, saveRetry, mutateProject } from "~/lib/useProjectDoc";
import { saveProject, getProject, putFile, getFile, restoreSnapshot, withRecordLock } from "~/lib/store";
import { restoreVersion, ensureRepo, listVersions } from "~/lib/versioning";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import * as store from "~/lib/store";

/**
 * Integrity of the page save path: a page snapshot must never be written
 * back over a record that changed underneath it (a version restore, a
 * direct job write, another tab), a retry must not outlive the page and
 * clobber newer writes, and a vanished deck must not be reported as saved.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("save freshness guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    saveRetry.attempts = 3;
    saveRetry.delayMs = 4_000;
  });

  it("a save queued during a restore does not revert the restored record", async () => {
    const p = newProject("Restore Race");
    p.species.push(
      makeSpecies({
        commonName: "Oak",
        category: "plants",
        photos: [{ id: "p1", role: "main", fileKey: "a.jpg", credit: { observer: "A", license: "cc0" } }],
      }),
    );
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["old-bytes"]));

    const { result } = renderHook(() => useProjectDoc(p.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());

    // Hold the record lock the way restoreVersion does, swap the snapshot
    // inside it (what restoreVersionUnlocked does), and only then let the
    // page save run: the restored record drops the photo, so the pre-restore
    // snapshot would land referencing a file that no longer exists.
    const restored = structuredClone(p);
    restored.description = "restored state";
    restored.species[0].photos = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withRecordLock(p.id, async () => {
      await gate;
      await restoreSnapshot(p.id, new Map(), new Set(), restored);
    });
    await sleep(20); // the holder owns the lock
    expect(holder).toBeInstanceOf(Promise);

    act(() => {
      result.current.update((d) => {
        d.description = "edit made during the restore";
      });
    });
    await sleep(50); // the save effect queues behind the holder
    release();
    await holder;
    await sleep(150);

    // The restored record is intact: the stale page save skipped instead of
    // reverting it and resurrecting a dangling photo reference.
    const stored = await getProject(p.id);
    expect(stored!.description).toBe("restored state");
    expect(stored!.species[0].photos).toHaveLength(0);
    expect(await getFile(p.id, "a.jpg")).toBeUndefined();
    // And the page follows the store instead of pretending the edit landed.
    expect(result.current.saveError).toMatch(/changed on disk/);
    expect(result.current.project!.description).toBe("restored state");
    expect(result.current.project!.species[0].photos).toHaveLength(0);
  });

  it("a retry that outlives the page does not clobber a newer store write", async () => {
    saveRetry.delayMs = 200;
    const p = newProject("Retry Outlives");
    await saveProject(p);
    const realSave = store.saveProject;
    let failures = 1;
    const spy = vi.spyOn(store, "saveProject").mockImplementation(async (proj, at) => {
      if (failures-- > 0) throw new Error("simulated storage failure");
      return realSave(proj, at);
    });

    const { result, unmount } = renderHook(() => useProjectDoc(p.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());
    act(() => {
      result.current.update((d) => {
        d.description = "edit on a page about to close";
      });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); // failed

    // The page goes away; a background job lands its own write directly.
    unmount();
    await mutateProject(p.id, (d) => {
      d.species.push(makeSpecies({ commonName: "Pine", category: "plants" }));
    });

    // The dead page's retry wakes — it must not write its stale snapshot
    // over the job's landed card.
    await sleep(450);
    const stored = await getProject(p.id)!;
    expect(stored!.species.map((s) => s.commonName)).toContain("Pine");
    // The stale snapshot was not written back over the job's work.
    expect(stored!.description).toBe("");
  });

  it("reports an error instead of silent success when the deck vanishes", async () => {
    const p = newProject("Vanished");
    await saveProject(p);
    const { result } = renderHook(() => useProjectDoc(p.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());

    // Another tab deletes the deck while this page edits it.
    const { deleteProject } = await import("~/lib/store");
    await deleteProject(p.id);
    act(() => {
      result.current.update((d) => {
        d.description = "edited into the void";
      });
    });
    await waitFor(() => expect(result.current.saveError).toMatch(/no longer exists/));
    expect(await getProject(p.id)).toBeUndefined();
  });

  it("a job write during a restore lands on the restored record", async () => {
    const p = newProject("Job During Restore");
    p.species.push(makeSpecies({ commonName: "Oak", category: "plants" }));
    p.description = "historical description";
    await saveProject(p);
    await putFile(p.id, "a.jpg", new Blob(["bytes"]));
    await ensureRepo(p);
    const version = (await listVersions(p.id))[0];

    // The live record moves on after the version was committed.
    const live = structuredClone(p);
    live.description = "current description";
    await saveProject(live);

    const { result } = renderHook(() => useProjectDoc(p.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());

    // Gate the restore's snapshot swap so the job write happens while the
    // restore holds the record lock.
    const realSwap = store.restoreSnapshot;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(store, "restoreSnapshot").mockImplementation(async (...args) => {
      await gate;
      return realSwap(...(args as Parameters<typeof realSwap>));
    });

    const restoring = restoreVersion(p.id, version.oid);
    await sleep(30); // the restore owns the record lock and is gated
    // A background job adds a card mid-restore: routed around the live
    // page, it waits on the record lock and re-reads the restored record.
    const job = mutateProject(p.id, (d) => {
      d.species.push(makeSpecies({ commonName: "Pine", category: "plants" }));
    });
    await sleep(30);
    release();
    await restoring;
    await job;
    spy.mockRestore();

    const stored = await getProject(p.id);
    // The restored record survived and the job's card landed on top of it —
    // not the pre-restore snapshot written back over the swap.
    expect(stored!.description).toBe("historical description");
    expect(stored!.species.map((s) => s.commonName)).toEqual(["Oak", "Pine"]);
  });
});
