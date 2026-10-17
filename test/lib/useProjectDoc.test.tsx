import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectDoc, saveRetry, mutateProject } from "~/lib/useProjectDoc";
import { saveProject, getProject, renameProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import * as store from "~/lib/store";

/**
 * A failed record save used to be retried only on the next edit, so the
 * last edit was lost whenever the curator closed the tab right after a
 * failure. These tests pin the bounded background retry: it lands the edit
 * without further interaction, and it never regresses a newer edit's save.
 */

describe("record save retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    saveRetry.attempts = 3;
    saveRetry.delayMs = 4_000;
  });

  it("retries a failed save in the background and lands the edit", async () => {
    const project = newProject("Retry");
    await saveProject(project);
    saveRetry.delayMs = 10;

    const realSave = store.saveProject;
    let failures = 2;
    const spy = vi.spyOn(store, "saveProject").mockImplementation(async (p, at) => {
      if (failures-- > 0) throw new Error("simulated storage failure");
      return realSave(p, at);
    });

    const { result } = renderHook(() => useProjectDoc(project.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());
    act(() => {
      result.current.update((d) => {
        d.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
      });
    });

    // Three attempts: the edit fails twice, then a background retry lands
    // it — without any further user interaction.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    await waitFor(async () => {
      const stored = await getProject(project.id);
      expect(stored!.species.map((s) => s.commonName)).toContain("Oak");
    });
    expect(result.current.saveError).toBeNull();
  });

  it("stops retrying once a newer edit supersedes the failed state", async () => {
    const project = newProject("Supersede");
    await saveProject(project);
    // The retry pause must outlast the observation window so the supersede
    // lands while the failed state's retry is still pending.
    saveRetry.delayMs = 400;

    const realSave = store.saveProject;
    let failures = 1;
    const spy = vi.spyOn(store, "saveProject").mockImplementation(async (p, at) => {
      if (failures-- > 0) throw new Error("simulated storage failure");
      return realSave(p, at);
    });

    const { result } = renderHook(() => useProjectDoc(project.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());
    act(() => {
      result.current.update((d) => {
        d.species.push(makeSpecies({ commonName: "Oak" }));
      });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // The next edit owns saving from here: its save lands immediately, and
    // the first edit's pending retry must not add a third (stale) write.
    act(() => {
      result.current.update((d) => {
        d.species.push(makeSpecies({ commonName: "Pine" }));
      });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 460)); // past the retry delay

    expect(spy).toHaveBeenCalledTimes(2);
    const stored = await getProject(project.id);
    expect(stored!.species.map((s) => s.commonName)).toEqual(["Oak", "Pine"]);
    expect(result.current.saveError).toBeNull();
  });

  it("does not resurrect a deck whose record was renamed away", async () => {
    const project = newProject("Vanishing");
    await saveProject(project);
    const realSave = store.saveProject;
    const spy = vi.spyOn(store, "saveProject").mockImplementation((p, at) => realSave(p, at));

    const { result } = renderHook(() => useProjectDoc(project.id));
    await waitFor(() => expect(result.current.project).not.toBeNull());

    // Another tab renames the deck while this page sits on the old id.
    await renameProject(project.id, "vanishing-2");

    act(() => {
      result.current.update((d) => {
        d.description = "edited after the rename";
      });
    });
    // The save joins the record lock, re-checks the record, finds it gone,
    // and skips — writing it back would re-create the old id as a duplicate
    // deck. (Before the existence check, the save landed and resurrected
    // the deck under its old id.)
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spy).not.toHaveBeenCalled();
    expect(await getProject(project.id)).toBeUndefined();
    expect(await getProject("vanishing-2")).toBeDefined();
  });
});

describe("job edits that arrive before the record loads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies an edit that lands while the deck is still loading", async () => {
    const project = newProject("Slow load");
    await saveProject(project);
    // Hold the page's load open so a job's edit arrives before any record
    // exists to apply it to.
    const realGet = store.getProject;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "getProject").mockImplementation(async (id) => {
      await gate;
      return realGet(id);
    });

    const { result } = renderHook(() => useProjectDoc(project.id));
    await mutateProject(project.id, (d) => {
      d.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
    });
    release();

    // The queued edit applies to the loaded record — the page shows it and
    // the autosave persists it. (It used to be dropped silently, and the
    // armed dirty flag then rewrote the record without the edit.)
    await waitFor(() => expect(result.current.project).not.toBeNull());
    expect(result.current.project!.species.map((s) => s.commonName)).toContain("Oak");
    await waitFor(async () => {
      const stored = await realGet(project.id);
      expect(stored!.species.map((s) => s.commonName)).toContain("Oak");
    });
  });

  it("lands an edit directly when the deck fails to load", async () => {
    const project = newProject("Broken load");
    await saveProject(project);
    const realGet = store.getProject;
    vi.spyOn(store, "getProject")
      .mockRejectedValueOnce(new Error("storage hiccup"))
      .mockImplementation((id) => realGet(id));

    const { result } = renderHook(() => useProjectDoc(project.id));
    await mutateProject(project.id, (d) => {
      d.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
    });

    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    await waitFor(async () => {
      const stored = await realGet(project.id);
      expect(stored!.species.map((s) => s.commonName)).toContain("Oak");
    });
  });

  it("lands a queued edit when the page unmounts before the load finishes", async () => {
    const project = newProject("Leaving");
    await saveProject(project);
    const realGet = store.getProject;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "getProject").mockImplementation(async (id) => {
      await gate;
      return realGet(id);
    });

    const { unmount } = renderHook(() => useProjectDoc(project.id));
    await mutateProject(project.id, (d) => {
      d.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
    });
    unmount();
    release();

    await waitFor(async () => {
      const stored = await realGet(project.id);
      expect(stored!.species.map((s) => s.commonName)).toContain("Oak");
    });
  });
});
