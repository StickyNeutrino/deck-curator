import { useCallback, useEffect, useRef, useState } from "react";
import { getProject, saveProject } from "./store";
import type { Project } from "./types";

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
    if (!project || !dirtyRef.current) return;
    dirtyRef.current = false;
    void saveProject(project).catch((err) => {
      // Retry on the next edit; keep the console signal for diagnosis.
      dirtyRef.current = true;
      console.error("Autosave failed:", err);
    });
  }, [project]);

  return { project, setProject, notFound, loadError, update };
}
