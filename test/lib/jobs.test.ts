import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cancelJob,
  clearFinishedJobs,
  getJobs,
  markJobsSeen,
  removeJob,
  resetJobs,
  startJob,
  unseenJobCount,
} from "~/lib/jobs";

const aborted = () => new DOMException("Aborted", "AbortError");

/** A run that blocks forever until its signal aborts (cancellation fixture). */
function untilAborted(h: { signal: AbortSignal }): Promise<never> {
  return new Promise((_, reject) => {
    h.signal.addEventListener("abort", () => reject(aborted()), { once: true });
  });
}

describe("job manager", () => {
  beforeEach(() => {
    resetJobs();
  });

  it("runs a job to completion and records its outcome", async () => {
    const settled = startJob(
      { kind: "inat-add", label: "Adding 2 cards", projectId: "deck-1", projectName: "Canyon" },
      async (h) => {
        h.progress(0, 2, "first");
        h.progress(1, 2, "second");
        return "Added 2 of 2 cards.";
      },
    );
    // Visible as running immediately.
    expect(getJobs()).toHaveLength(1);
    expect(getJobs()[0].status).toBe("running");
    expect(getJobs()[0].label).toBe("Adding 2 cards");

    const record = await settled;
    expect(record.status).toBe("completed");
    expect(record.message).toBe("Added 2 of 2 cards.");
    expect(record.done).toBe(1);
    expect(record.total).toBe(2);
    expect(record.detail).toBe("second");
    expect(record.finishedAt).toBeTruthy();
  });

  it("reports failures with the error message", async () => {
    const settled = startJob({ kind: "tool-enrich", label: "Fill gaps" }, async () => {
      throw new Error("iNat is down");
    });
    const record = await settled;
    expect(record.status).toBe("failed");
    expect(record.message).toBe("iNat is down");
  });

  it("marks aborted runs cancelled and keeps the progress made", async () => {
    const settled = startJob({ kind: "inat-add", label: "Adding 5 cards" }, (h) => {
      h.progress(3, 5, "mid");
      return untilAborted(h);
    });
    cancelJob(getJobs()[0].id);
    const record = await settled;
    expect(record.status).toBe("cancelled");
    expect(record.message).toBe("Cancelled after 3 of 5.");
    expect(record.finishedAt).toBeTruthy();
  });

  it("stores structured outcomes (tool conflicts)", async () => {
    await startJob({ kind: "tool-native", label: "Label native" }, async () => ({
      message: "checked 2 · labeled 1 · 1 kept as-is",
      conflicts: [{ species: "Oak", detail: 'kept "native", iNat says "non-native"' }],
    }));
    const [record] = getJobs();
    expect(record.status).toBe("completed");
    expect(record.message).toContain("checked 2");
    expect(record.conflicts).toEqual([
      { species: "Oak", detail: 'kept "native", iNat says "non-native"' },
    ]);
  });

  it("persists finished jobs to localStorage but never running ones", async () => {
    await startJob({ kind: "inat-add", label: "Finished" }, async () => "done");
    startJob({ kind: "inat-add", label: "Still running" }, () => new Promise(() => undefined));

    const persisted = JSON.parse(window.localStorage.getItem("deck-curator.jobs.v1") ?? "[]");
    expect(persisted.map((j: { label: string }) => j.label)).toEqual(["Finished"]);
    expect(persisted[0].message).toBe("done");
  });

  it("restores history from localStorage on load (running records are dropped)", async () => {
    window.localStorage.setItem(
      "deck-curator.jobs.v1",
      JSON.stringify([
        {
          id: "old-1",
          kind: "inat-add",
          label: "Old run",
          status: "completed",
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          done: 4,
          total: 4,
          message: "Added 4 of 4 cards.",
        },
        {
          id: "old-2",
          kind: "inat-add",
          label: "Zombie run",
          status: "running",
          createdAt: new Date().toISOString(),
          done: 1,
          total: 9,
        },
      ]),
    );
    // Fresh module instance re-hydrates from storage.
    vi.resetModules();
    const mod = await import("~/lib/jobs");
    expect(mod.getJobs().map((j) => j.id)).toEqual(["old-1"]);
  });

  it("counts unseen results and clears them when marked seen", async () => {
    expect(unseenJobCount()).toBe(0);
    await startJob({ kind: "inat-add", label: "A" }, async () => "done");
    await startJob({ kind: "tool-rarity", label: "B" }, async () => "done");
    expect(unseenJobCount()).toBe(2);
    markJobsSeen();
    expect(unseenJobCount()).toBe(0);
  });

  it("removes individual jobs and clears finished ones (running survive)", async () => {
    const first = await startJob({ kind: "tool-enrich", label: "A" }, async () => "a");
    const secondSettled = startJob({ kind: "tool-rarity", label: "B" }, untilAborted);

    removeJob(first.id);
    expect(getJobs().map((j) => j.label)).toEqual(["B"]);

    // Clear finished leaves the still-running job alone.
    await startJob({ kind: "inat-add", label: "C" }, async () => "c");
    clearFinishedJobs();
    expect(getJobs().map((j) => j.label)).toEqual(["B"]);

    cancelJob(getJobs()[0].id);
    const record = await secondSettled;
    expect(record.status).toBe("cancelled");
    expect(getJobs().map((j) => j.label)).toEqual(["B"]);
  });

  it("drops removed jobs from localStorage too", async () => {
    const record = await startJob({ kind: "inat-add", label: "Doomed" }, async () => "done");
    expect(JSON.parse(window.localStorage.getItem("deck-curator.jobs.v1")!)).toHaveLength(1);
    removeJob(record.id);
    expect(JSON.parse(window.localStorage.getItem("deck-curator.jobs.v1")!)).toHaveLength(0);
  });
});
