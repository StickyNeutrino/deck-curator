import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobsDock, openJobsPanel } from "~/components/JobsDock";
import { resetJobs, startJob, getJobs, type JobHandle } from "~/lib/jobs";

/** A run that blocks until its signal aborts (cancellation fixture). */
function untilAborted(h: JobHandle): Promise<never> {
  return new Promise((_, reject) => {
    h.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

describe("JobsDock", () => {
  beforeEach(() => resetJobs());
  afterEach(() => {
    cleanup();
  });

  it("is invisible until any job exists", async () => {
    render(<JobsDock />);
    expect(screen.queryByTestId("jobs-dock")).not.toBeInTheDocument();
    await act(async () => {
      await startJob({ kind: "inat-add", label: "Adding 2 cards" }, async () => "Added 2 of 2 cards.");
    });
    expect(screen.getByTestId("jobs-dock")).toBeInTheDocument();
  });

  it("shows running jobs with progress and cancels them from the panel", async () => {
    const user = userEvent.setup();
    const settled = startJob(
      { kind: "inat-add", label: "Adding 3 cards", projectName: "Canyon" },
      (h) => {
        h.progress(1, 3, "Dudleya edulis");
        return untilAborted(h);
      },
    );
    render(<JobsDock />);

    const dock = await screen.findByTestId("jobs-dock");
    expect(dock).toHaveTextContent("1 running");

    await user.click(dock);
    const modal = screen.getByTestId("jobs-modal");
    expect(within(modal).getByText("Adding 3 cards")).toBeInTheDocument();
    expect(within(modal).getByText(/Canyon/)).toBeInTheDocument();
    expect(within(modal).getByText("Dudleya edulis")).toBeInTheDocument();
    expect(within(modal).getByText("1/3")).toBeInTheDocument();

    await user.click(within(modal).getByTestId(/job-cancel-/));
    const record = await settled;
    expect(record.status).toBe("cancelled");
    expect(await screen.findByTestId(/job-message-/)).toHaveTextContent("Cancelled after 1 of 3.");
  });

  it("marks finished jobs' outcome and removes them from the history", async () => {
    const user = userEvent.setup();
    const record = await startJob({ kind: "tool-enrich", label: "Fill gaps (all 3 species)" }, async () => "enriched 2 species");
    render(<JobsDock />);

    // Finished, unseen results raise the badge.
    expect(screen.getByTestId("jobs-badge")).toHaveTextContent("1");
    await user.click(screen.getByTestId("jobs-dock"));
    const modal = screen.getByTestId("jobs-modal");
    expect(within(modal).getByText("Completed")).toBeInTheDocument();
    expect(within(modal).getByTestId(`job-message-${record.id}`)).toHaveTextContent("enriched 2 species");

    // Per-job remove drops it; the dock hides again when history is empty.
    await user.click(within(modal).getByTestId(`job-remove-${record.id}`));
    expect(screen.queryByTestId("jobs-modal")).toBeInTheDocument(); // panel still open
    expect(within(screen.getByTestId("jobs-modal")).getByText("No jobs yet.")).toBeInTheDocument();
    expect(getJobs()).toHaveLength(0);
  });

  it("shows tool conflicts in an expandable list", async () => {
    const user = userEvent.setup();
    await startJob({ kind: "tool-native", label: "Label native / introduced" }, async () => ({
      message: "checked 2 · labeled 1 · 1 kept as-is",
      conflicts: [{ species: "Oak", detail: 'kept "native", iNat says "non-native"' }],
    }));
    render(<JobsDock />);
    await user.click(screen.getByTestId("jobs-dock"));
    const summary = screen.getByText("1 kept as-is");
    await user.click(summary);
    expect(screen.getByText("Oak")).toBeInTheDocument();
    expect(screen.getByText(/kept "native", iNat says "non-native"/)).toBeInTheDocument();
  });

  it("clears the whole finished history at once", async () => {
    const user = userEvent.setup();
    await startJob({ kind: "inat-add", label: "One" }, async () => "done");
    await startJob({ kind: "inat-add", label: "Two" }, async () => "done");
    render(<JobsDock />);
    await user.click(screen.getByTestId("jobs-dock"));
    await user.click(screen.getByTestId("jobs-clear"));
    expect(within(screen.getByTestId("jobs-modal")).getByText("No jobs yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("jobs-dock")).not.toBeInTheDocument(); // hidden again
  });

  it("opens the panel when another component dispatches the open event", async () => {
    const user = userEvent.setup();
    await act(async () => {
      await startJob({ kind: "inat-add", label: "One" }, async () => "done");
    });
    render(<JobsDock />);
    act(() => {
      openJobsPanel();
    });
    expect(await screen.findByTestId("jobs-modal")).toBeInTheDocument();
  });
});
