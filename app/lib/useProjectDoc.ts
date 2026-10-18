import { useCallback, useEffect, useRef, useState } from "react";
import { getProject, saveProject, withRecordLock } from "./store";
import { scheduleAutoVersion } from "./useAutoVersion";
import { isStorageFullError } from "./browserStorage";
import type { Project } from "./types";

/** `update` of each project page currently mounted, by project id. */
const liveUpdaters = new Map<string, (mutate: (draft: Project) => void) => void>();

/** Re-exported so existing import sites keep working; the lock lives in
 *  store.ts now so version restore can join it (see withRecordLock there). */
export { withRecordLock };

/** Background retry pacing for a failed record save. Mutable config so the
 *  tests can shorten the waits (they run on real timers — fake clocks stall
 *  the IndexedDB queue). */
export const saveRetry = { attempts: 3, delayMs: 4_000 };

/**
 * Edit a deck from outside the page that owns it (background jobs). While the
 * deck is open, the edit goes through its page so the page state and autosave
 * stay in sync; otherwise the stored record is edited directly, so a job keeps
 * landing its work after the curator navigates away.
 */
export async function mutateProject(projectId: string, mutate: (draft: Project) => void): Promise<void> {
  const live = liveUpdaters.get(projectId);
  if (live) {
    live(mutate);
    return;
  }
  await mutateStored(projectId, mutate);
}

/** Direct read-modify-write of the stored record, under the record lock —
 *  the path a job takes when no page has the deck open (or the page's load
 *  failed, see useProjectDoc). A missing record is a no-op: deleted decks
 *  must not resurrect. */
async function mutateStored(projectId: string, mutate: (draft: Project) => void): Promise<void> {
  await withRecordLock(projectId, async () => {
    const current = await getProject(projectId);
    if (!current) return;
    const draft = structuredClone(current);
    mutate(draft);
    scheduleAutoVersion(draft);
    await saveProject(draft);
  });
}

/**
 * Load a project by id and persist edits as they happen.
 *
 * Edits go through `update`, which clones the current state and runs the
 * mutation inside a state updater. The save itself happens in an effect,
 * *outside* the updater: updaters must be pure (React may invoke them
 * twice, e.g. under StrictMode), and a `saveProject` inside one fires
 * double-writes and re-runs on discarded renders.
 *
 * `dirtyRef` gates the save so the initial load doesn't rewrite the record
 * (which would churn `updatedAt` and reorder the home page list).
 * Edits that arrive before the record loads (a background job finishing
 * while the page mounts) queue and apply to the record the moment it lands;
 * if the load fails or the page unmounts mid-load, they flush to the store
 * directly instead of being dropped.
 * Load failures surface as `loadError` instead of a page stuck on
 * "Loading…" forever.
 */
export function useProjectDoc(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const latestRef = useRef<Project | null>(null);
  // Edits can arrive before the record loads (a background job finishing
  // while the page mounts). They queue here and apply to the record the
  // moment it lands — applying through `update` before then would silently
  // drop the edit (the updater bails on null state) while still arming the
  // dirty flag, so the load's save effect would rewrite the record without
  // the mutation.
  const loadedRef = useRef(false);
  const queuedRef = useRef<Array<(draft: Project) => void>>([]);

  /** Apply one mutation through page state — only valid once loaded. */
  const applyUpdate = useCallback((mutate: (draft: Project) => void) => {
    dirtyRef.current = true;
    setProject((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  /** Flush queued edits straight to the store — used when the page cannot
   *  take them (load failed, or it's unmounting mid-load). Best-effort: each
   *  edit lands on its own, mirroring the no-page-open path. */
  const flushQueuedToStore = useCallback(async (id: string) => {
    const queued = queuedRef.current;
    queuedRef.current = [];
    for (const mutate of queued) {
      try {
        await mutateStored(id, mutate);
      } catch (err) {
        console.warn("A queued deck edit could not be saved:", err);
      }
    }
  }, []);

  const update = useCallback((mutate: (draft: Project) => void) => {
    if (!loadedRef.current) {
      queuedRef.current.push(mutate);
      return;
    }
    applyUpdate(mutate);
  }, [applyUpdate]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    loadedRef.current = false;
    queuedRef.current = [];
    setProject(null);
    setNotFound(false);
    setLoadError(null);
    void getProject(projectId)
      .then((p) => {
        if (cancelled) return;
        loadedRef.current = true;
        const queued = queuedRef.current;
        queuedRef.current = [];
        if (p) {
          if (queued.length > 0) {
            // Apply the edits that arrived during the load to the record as
            // loaded, in arrival order — the save effect then persists them
            // like any page edit.
            dirtyRef.current = true;
            setProject(() => {
              let draft = p;
              for (const mutate of queued) {
                draft = structuredClone(draft);
                mutate(draft);
              }
              return draft;
            });
          } else {
            setProject(p);
          }
        } else {
          // The deck is gone (deleted, or renamed away). Queued edits have
          // nothing to land on — the direct path skips missing decks too —
          // and this page must stop claiming live ownership, or later job
          // edits would queue behind a record that never arrives.
          setNotFound(true);
          if (liveUpdaters.get(projectId) === update) liveUpdaters.delete(projectId);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(`Couldn't load the deck: ${err instanceof Error ? err.message : err}`);
        // The page can't take edits without the record: release ownership
        // and land anything already queued directly, exactly as if no page
        // had the deck open.
        if (liveUpdaters.get(projectId) === update) liveUpdaters.delete(projectId);
        loadedRef.current = true;
        void flushQueuedToStore(projectId);
      });
    return () => {
      cancelled = true;
      // Edits queued before the record loaded must still land when the page
      // goes away mid-load — flush them to the store instead of dropping.
      void flushQueuedToStore(projectId);
    };
  }, [projectId, update, flushQueuedToStore]);

  useEffect(() => {
    if (!projectId) return;
    liveUpdaters.set(projectId, update);
    return () => {
      if (liveUpdaters.get(projectId) === update) liveUpdaters.delete(projectId);
    };
  }, [projectId, update]);

  useEffect(() => {
    if (!project) return;
    latestRef.current = project;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    // The git version autosave rides on every record save, from any tab:
    // arm (re-arm) the shared debounce with this state. It's armed before
    // the record write resolves on purpose — a version commit is also the
    // safety net when the record save itself fails.
    scheduleAutoVersion(project);
    void (async () => {
      // A failed save must not drop the last edit just because the curator
      // closes the tab before editing again, so it is retried after a short
      // pause, a bounded number of times. A retry stops the moment a newer
      // edit exists — that edit's own effect run owns saving from there —
      // and can never regress the store: IndexedDB serializes overlapping
      // writes in issuance order, and the newest state is always issued
      // before an older retry's.
      for (let attempt = 1; ; attempt++) {
        try {
          // The save joins the record lock and re-checks the record's
          // existence first: a rename that completed while this state sat
          // unsaved has moved the record — writing it back under the old id
          // would resurrect it as a duplicate deck. (A deletion is skipped
          // the same way.)
          let landed = true;
          await withRecordLock(project.id, async () => {
            if (!(await getProject(project.id))) {
              landed = false;
              return;
            }
            await saveProject(project);
          });
          if (landed) setSaveError(null);
          return;
        } catch (err) {
          // A console line isn't enough for the curator — a silent autosave
          // failure means their last edits exist only on this screen.
          dirtyRef.current = true; // retry, or the next edit
          console.error("Autosave failed:", err);
          // Storage-full failures read like a bug in their raw form — name
          // the real cause and be honest that unsaved edits are at risk.
          setSaveError(
            isStorageFullError(err)
              ? "Couldn't save: browser storage is full. Free up disk space; until a save lands, your latest edits exist only on this screen."
              : `Couldn't save: ${err instanceof Error ? err.message : err}`,
          );
        }
        if (attempt >= saveRetry.attempts || latestRef.current !== project) return;
        await new Promise((resolve) => setTimeout(resolve, saveRetry.delayMs));
        if (latestRef.current !== project) return;
      }
    })();
  }, [project]);

  return { project, setProject, notFound, loadError, saveError, update };
}
