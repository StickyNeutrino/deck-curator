import { useEffect, useRef, useState } from "react";
import type { Project } from "./types";
import { commitDeckVersion } from "./versioning";

/**
 * Git version autosave, shared by every page that edits a deck.
 *
 * Saving has two layers: the record save (IndexedDB, see useProjectDoc)
 * after every edit, and the version commit (git history) after a short idle
 * pause. Scheduling lives here — not on one page — so an edit made on any
 * tab (cards, deck info, review, the species editor) lands in the version
 * history. Previously only the cards page armed a timer, and its cleanup
 * cancelled the pending commit on navigation, so edits made elsewhere (or
 * followed quickly by leaving the page) never produced a version.
 *
 * A pending autosave is flushed when the page is left or hidden, so the
 * debounce delay never costs the last moments of work. Nothing is scheduled
 * by merely viewing a page, and committing unchanged state is a cheap no-op
 * (commitDeckVersion skips it), so flushes are safe to request liberally.
 */

/** How long after the last saved edit a version commit is attempted. */
export const AUTO_VERSION_DEBOUNCE_MS = 12_000;

/** Latest saved state per project, awaiting its commit. */
const pending = new Map<string, Project>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export type AutoVersionEvent =
  | { type: "settled"; projectId: string }
  | { type: "saved"; projectId: string; oid: string | null }
  | { type: "failed"; projectId: string; error: unknown };

const listeners = new Set<(event: AutoVersionEvent) => void>();

/** Subscribe to autosave outcomes — used for the author prompt (settled)
 *  and for surfacing failures that used to vanish into console.warn.
 *  Returns an unsubscribe function. */
export function subscribeAutoVersion(listener: (event: AutoVersionEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: AutoVersionEvent): void {
  for (const listener of listeners) listener(event);
}

/** Arm (or re-arm) the autosave debounce for a project with its latest
 *  saved state. Called after a record save lands, so every editing tab
 *  participates; repeated calls collapse into one commit after the pause. */
export function scheduleAutoVersion(project: Project, delayMs = AUTO_VERSION_DEBOUNCE_MS): void {
  pending.set(project.id, project);
  const prev = timers.get(project.id);
  if (prev) clearTimeout(prev);
  timers.set(project.id, setTimeout(() => {
    timers.delete(project.id);
    emit({ type: "settled", projectId: project.id });
    void flushAutoVersion(project.id);
  }, delayMs));
}

/** Commit any pending autosave now — used when a page is left or hidden.
 *  A no-op for projects with nothing pending. */
export async function flushAutoVersion(projectId?: string): Promise<void> {
  const ids = projectId ? [projectId] : [...pending.keys()];
  await Promise.allSettled(ids.map(async (id) => {
    const project = pending.get(id);
    if (!project) return;
    pending.delete(id);
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    let failed = false;
    try {
      const oid = await commitDeckVersion(project, undefined, undefined, {
        onError: (err) => {
          failed = true;
          emit({ type: "failed", projectId: id, error: err });
        },
      });
      // A failed silent commit reports oid null too — only emit "saved"
      // when nothing failed, or the banner would flash and clear itself.
      if (!failed) emit({ type: "saved", projectId: id, oid });
    } catch (err) {
      // Unreachable for silent commits; keep failures visible regardless.
      emit({ type: "failed", projectId: id, error: err });
    }
  }));
}

/** Wire autosave into a page: surfaces autosave failures as a banner string,
 *  runs `onSettle` when the debounce fires (e.g. to show the author prompt
 *  once the first autosave settles), and flushes pending commits when the
 *  page is left or the tab hidden/closed. */
export function useAutoVersion(
  projectId: string | undefined,
  opts?: { onSettle?: () => void },
): string | null {
  const [versionError, setVersionError] = useState<string | null>(null);
  const onSettleRef = useRef(opts?.onSettle);
  useEffect(() => {
    onSettleRef.current = opts?.onSettle;
  });

  useEffect(() => {
    if (!projectId) return;
    return subscribeAutoVersion((event) => {
      if (event.projectId !== projectId) return;
      if (event.type === "failed") {
        const detail = event.error instanceof Error ? event.error.message : String(event.error);
        setVersionError(`Version autosave failed: ${detail}`);
      } else if (event.type === "saved") {
        setVersionError(null);
      } else {
        onSettleRef.current?.();
      }
    });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const flush = (): void => {
      void flushAutoVersion(projectId);
    };
    // pagehide covers tab close and backgrounding; the cleanup covers
    // navigating to another page within the app.
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      void flushAutoVersion(projectId);
    };
  }, [projectId]);

  return versionError;
}