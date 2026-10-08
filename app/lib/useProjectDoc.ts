import { useCallback, useEffect, useRef, useState } from "react";
import { getProject, saveProject } from "./store";
import { scheduleAutoVersion } from "./useAutoVersion";
import type { Project } from "./types";

/** `update` of each project page currently mounted, by project id. */
const liveUpdaters = new Map<string, (mutate: (draft: Project) => void) => void>();

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
  const current = await getProject(projectId);
  if (!current) return;
  const draft = structuredClone(current);
  mutate(draft);
  scheduleAutoVersion(draft);
  await saveProject(draft);
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
 * Load failures surface as `loadError` instead of a page stuck on
 * "Loading…" forever.
 */
export function useProjectDoc(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setProject(null);
    setNotFound(false);
    setLoadError(null);
    void getProject(projectId)
      .then((p) => {
        if (cancelled) return;
        if (p) setProject(p);
        else setNotFound(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(`Couldn't load the deck: ${err instanceof Error ? err.message : err}`);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const update = useCallback((mutate: (draft: Project) => void) => {
    dirtyRef.current = true;
    setProject((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    liveUpdaters.set(projectId, update);
    return () => {
      if (liveUpdaters.get(projectId) === update) liveUpdaters.delete(projectId);
    };
  }, [projectId, update]);

  useEffect(() => {
    if (!project || !dirtyRef.current) return;
    dirtyRef.current = false;
    // The git version autosave rides on every record save, from any tab:
    // arm (re-arm) the shared debounce with this state. It's armed before
    // the record write resolves on purpose — a version commit is also the
    // safety net when the record save itself fails.
    scheduleAutoVersion(project);
    void (async () => {
      try {
        await saveProject(project);
        setSaveError(null);
      } catch (err) {
        // A console line isn't enough for the curator — a silent autosave
        // failure means their last edits exist only on this screen.
        dirtyRef.current = true; // retry on the next edit
        console.error("Autosave failed:", err);
        setSaveError(`Couldn't save: ${err instanceof Error ? err.message : err}`);
      }
    })();
  }, [project]);

  return { project, setProject, notFound, loadError, saveError, update };
}
