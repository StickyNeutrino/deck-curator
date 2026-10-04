import { useSyncExternalStore } from "react";
import { uuid } from "./uuid";

/**
 * Background jobs for long-running curation work: bulk-adding species from an
 * iNaturalist search, and the deck tools (fill gaps, label native /
 * conservation status).
 *
 * Jobs outlive the UI that started them — closing the Add-species modal or
 * navigating between pages never interrupts a run. The Jobs dock (bottom
 * right on every page) monitors progress, cancels runs, and keeps a history
 * of outcomes, including the "kept as-is" conflict lists the tools report.
 *
 * State is in-memory module state; finished jobs are mirrored to localStorage
 * so the history survives a reload. Running jobs are not persisted — a reload
 * kills them by definition (they live in this page's JS context).
 */

export type JobKind = "inat-add" | "tool-enrich" | "tool-native" | "tool-rarity";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

/** A tool's "kept as-is" row — which species, and what differed. */
export interface JobConflict {
  species: string;
  detail: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  /** One-line description, e.g. "Adding 12 cards from iNaturalist". */
  label: string;
  projectId?: string;
  projectName?: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  /** Progress: done items out of total (total can grow early in a run). */
  done: number;
  total: number;
  /** What the job is working on right now ("Dudleya edulis — card 2/3"). */
  detail?: string;
  /** Outcome summary, set when the job finishes. */
  message?: string;
  /** Tool conflicts: values the curator set that differ from iNat's. */
  conflicts?: JobConflict[];
}

/** What a run hands back when it completes: a summary line and/or
 *  structured conflicts for the jobs panel to expand. */
export interface JobOutcome {
  message?: string;
  conflicts?: JobConflict[];
}

export interface JobHandle {
  id: string;
  /** Aborts when the user cancels the job — pass it to fetches and check it
   *  between work items so cancellation lands quickly. */
  signal: AbortSignal;
  progress: (done: number, total: number, detail?: string) => void;
}

export interface StartJobOptions {
  kind: JobKind;
  label: string;
  projectId?: string;
  projectName?: string;
}

type Runner = (handle: JobHandle) => Promise<string | JobOutcome | void>;

interface JobsState {
  /** Newest first. */
  jobs: JobRecord[];
}

const STORAGE_KEY = "deck-curator.jobs.v1";
const HISTORY_LIMIT = 50;

function loadPersisted(): JobRecord[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as JobRecord[];
    if (!Array.isArray(parsed)) return [];
    // Running jobs can't survive a reload — drop anything unfinished.
    return parsed.filter((j) => j && j.id && j.status !== "running");
  } catch {
    return [];
  }
}

let jobs: JobRecord[] = loadPersisted();
const unseen = new Set<string>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function snapshot(): JobRecord[] {
  return jobs;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook: the live job list (newest first). */
export function useJobs(): JobRecord[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Non-React accessor (tests, imperative checks). */
export function getJobs(): JobRecord[] {
  return jobs;
}

/** Count of finished-but-not-yet-seen results (drives the dock's badge). */
export function unseenJobCount(): number {
  return unseen.size;
}

/** Clear the "new result" badge — the dock calls this when its panel opens. */
export function markJobsSeen(): void {
  if (unseen.size === 0) return;
  unseen.clear();
  emit();
}

function emit(): void {
  for (const fn of listeners) fn();
}

function persist(): void {
  try {
    if (typeof window === "undefined") return;
    const finished = jobs.filter((j) => j.status !== "running").slice(0, HISTORY_LIMIT);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(finished));
  } catch {
    // Private mode / quota — the history is best-effort.
  }
}

function update(id: string, patch: (record: JobRecord) => void): void {
  jobs = jobs.map((j) => {
    if (j.id !== id) return j;
    const next = { ...j };
    patch(next);
    return next;
  });
  emit();
}

function applyOutcome(record: JobRecord, result: string | JobOutcome | void): void {
  if (typeof result === "string") {
    record.message = result;
  } else if (result && typeof result === "object") {
    if (result.message) record.message = result.message;
    if (result.conflicts?.length) record.conflicts = result.conflicts;
  }
}

/**
 * Start a background job. Returns a promise that resolves with the final
 * record when the job settles (completed, failed, or cancelled) — callers
 * fire-and-forget; the Jobs dock does the watching.
 */
export function startJob(options: StartJobOptions, run: Runner): Promise<JobRecord> {
  const id = uuid();
  const controller = new AbortController();
  controllers.set(id, controller);
  const record: JobRecord = {
    id,
    kind: options.kind,
    label: options.label,
    projectId: options.projectId,
    projectName: options.projectName,
    status: "running",
    createdAt: new Date().toISOString(),
    done: 0,
    total: 0,
  };
  jobs = [record, ...jobs];
  emit();

  const handle: JobHandle = {
    id,
    signal: controller.signal,
    progress: (done, total, detail) =>
      update(id, (r) => {
        r.done = done;
        r.total = total;
        r.detail = detail;
      }),
  };

  const settle = async (): Promise<JobRecord> => {
    try {
      const result = await run(handle);
      update(id, (r) => {
        r.status = "completed";
        r.finishedAt = new Date().toISOString();
        applyOutcome(r, result);
      });
    } catch (err) {
      update(id, (r) => {
        r.finishedAt = new Date().toISOString();
        if (controller.signal.aborted) {
          r.status = "cancelled";
          r.message = `Cancelled after ${r.done} of ${r.total}.`;
        } else {
          r.status = "failed";
          r.message = err instanceof Error ? err.message : String(err);
        }
      });
    } finally {
      controllers.delete(id);
      unseen.add(id);
      persist();
    }
    return jobs.find((j) => j.id === id)!;
  };

  return settle();
}

/** Cancel a running job. Its signal aborts; the run's loops and fetches wind
 *  down and the record becomes "cancelled" with whatever was already done. */
export function cancelJob(id: string): void {
  controllers.get(id)?.abort();
}

/** Drop one finished job from the history. */
export function removeJob(id: string): void {
  jobs = jobs.filter((j) => j.id !== id);
  unseen.delete(id);
  emit();
  persist();
}

/** Drop every finished job from the history (running ones keep going). */
export function clearFinishedJobs(): void {
  jobs = jobs.filter((j) => j.status === "running");
  unseen.clear();
  emit();
  persist();
}

/** Wipe everything, running jobs included — test seeding only. */
export function resetJobs(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  jobs = [];
  unseen.clear();
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}
