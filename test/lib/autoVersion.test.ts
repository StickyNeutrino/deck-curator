import { describe, it, expect, vi, afterEach } from "vitest";
import {
  scheduleAutoVersion,
  flushAutoVersion,
  subscribeAutoVersion,
  type AutoVersionEvent,
} from "~/lib/useAutoVersion";
import { isAutosaveCommit, listVersions } from "~/lib/versioning";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { saveProject, putFile, getFile } from "~/lib/store";
import * as store from "~/lib/store";

/**
 * The version autosave used to be armed only on the cards page (and its
 * cleanup cancelled the pending commit on navigation), which is why edits
 * made on other tabs never produced a version. These tests pin the shared
 * scheduler: armed by any tab's record save, collapsed while the curator
 * keeps typing, flushed on navigation, and — importantly — loud about
 * failures that used to vanish into console.warn.
 */

function fixture(name = "Autosave") {
  const project = newProject(`${name} ${crypto.randomUUID().slice(0, 6)}`);
  project.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }));
  return project;
}

/** Drain real macrotasks (and a little real time) until `check` holds —
 *  the commit chain runs across IndexedDB transactions that each need a
 *  scheduling hop, and a short debounce needs wall-clock time to elapse. */
async function untilSettled(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await wait(5);
  }
  throw new Error("Condition never became true while draining macrotasks");
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const autoVersions = async (projectId: string) =>
  (await listVersions(projectId)).filter((v) => isAutosaveCommit(v.message));

async function headProjectFile(projectId: string): Promise<string> {
  const git = (await import("isomorphic-git")).default;
  const FS = (await import("@isomorphic-git/lightning-fs")).default;
  const fs = new FS("deck-curator-git");
  const head = await git.resolveRef({ fs, dir: `/${projectId}`, ref: "HEAD" });
  const { blob } = await git.readBlob({
    fs,
    dir: `/${projectId}`,
    oid: head,
    filepath: "project.deckcurator.json",
  });
  return new TextDecoder().decode(blob);
}

describe("version autosave scheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("commits the pending autosave after the idle delay", async () => {
    // Short delay instead of fake timers: the git machinery's process
    // polyfill schedules work with real setTimeout, so faking the clock
    // would stall the commit mid-flight.
    const project = fixture();
    await saveProject(project);
    scheduleAutoVersion(project, 50);

    await wait(20);
    expect(await autoVersions(project.id)).toHaveLength(0); // not yet

    await untilSettled(async () => (await autoVersions(project.id)).length === 1);
  }, 30_000);

  it("collapses a burst of edits into a single commit", async () => {
    const project = fixture();
    await saveProject(project);
    scheduleAutoVersion(project, 200);
    await wait(50); // the first arm hasn't fired yet

    // More edits land before the delay elapses: the debounce re-arms and
    // only the latest state is committed, once.
    const edited = structuredClone(project);
    edited.species[0].commonName = "Renamed";
    await saveProject(edited);
    scheduleAutoVersion(edited, 200);

    await untilSettled(async () => (await autoVersions(project.id)).length === 1);
    expect(await headProjectFile(project.id)).toContain("Renamed");
  }, 30_000);

  it("flush commits pending state immediately (page left before the delay)", async () => {
    const project = fixture();
    await saveProject(project);
    scheduleAutoVersion(project); // timer armed, nowhere near elapsed
    await flushAutoVersion(project.id);

    expect(await autoVersions(project.id)).toHaveLength(1);
  }, 30_000);

  it("flush is a no-op when nothing is pending", async () => {
    // Attribute by project id: earlier tests' in-flight commits can still
    // emit their own events while this one runs.
    const events: AutoVersionEvent[] = [];
    const unsub = subscribeAutoVersion((e) => events.push(e));
    await flushAutoVersion("no-such-project");
    unsub();
    expect(events.filter((e) => e.projectId === "no-such-project")).toHaveLength(0);
  });

  it("commits the latest saved state, not an older snapshot", async () => {
    const project = fixture();
    await saveProject(project);
    scheduleAutoVersion(project);
    const edited = structuredClone(project);
    edited.species[0].commonName = "Latest";
    await saveProject(edited);
    scheduleAutoVersion(edited); // supersedes the earlier arm

    await flushAutoVersion(project.id);
    expect(await headProjectFile(project.id)).toContain("Latest");
  }, 30_000);

  it("surfaces commit failures through the subscription", async () => {
    const project = fixture();
    project.species[0].photos.push({
      id: "p",
      role: "main",
      fileKey: "oak.jpg",
      credit: { observer: "A", license: "cc0" },
    });
    await putFile(project.id, "oak.jpg", new Blob(["bytes"]));
    await saveProject(project);
    scheduleAutoVersion(project);

    const spy = vi.spyOn(store, "getFile").mockRejectedValue(new Error("simulated store failure"));
    const events: AutoVersionEvent[] = [];
    const unsub = subscribeAutoVersion((e) => events.push(e));
    await flushAutoVersion(project.id);
    unsub();

    expect(spy).toHaveBeenCalled();
    const failure = events.find((e) => e.type === "failed");
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ projectId: project.id, error: expect.anything() });
    // A failed commit must not also emit "saved" — the banner would clear itself.
    expect(events.some((e) => e.type === "saved")).toBe(false);
  }, 30_000);

  it("reports a landed commit as saved", async () => {
    const project = fixture();
    await saveProject(project);
    scheduleAutoVersion(project);
    const events: AutoVersionEvent[] = [];
    const unsub = subscribeAutoVersion((e) => events.push(e));
    await flushAutoVersion(project.id);
    unsub();

    const saved = events.find((e) => e.type === "saved");
    expect(saved).toBeDefined();
    expect(saved).toMatchObject({ projectId: project.id, oid: expect.any(String) });
  }, 30_000);
});