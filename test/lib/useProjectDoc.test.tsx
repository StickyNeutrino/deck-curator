import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectDoc, saveRetry } from "~/lib/useProjectDoc";
import { saveProject, getProject } from "~/lib/store";
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
});
