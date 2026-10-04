// The three export artifacts run as background jobs: project file (.zip, with
// history), deck file (.deck, optional compress), and light deck (.deck.lite).
// The buttons start a job each; the job's runner forwards to the export
// functions with progress/cancellation hooks.
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import ExportPage from "~/routes/export";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { getJobs, resetJobs } from "~/lib/jobs";

const captured = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; options: unknown }> }));

vi.mock("~/lib/versioning", () => ({
  ensureRepo: vi.fn(async () => {}),
  listVersions: vi.fn(async () => []),
  renameRepo: vi.fn(async () => {}),
  restoreVersion: vi.fn(),
  commitDeckVersion: vi.fn(async () => null),
  isAutosaveCommit: (message: string) => message.startsWith("Autosave — "),
}));

vi.mock("~/lib/export", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/lib/export")>();
  return {
    ...mod,
    exportProjectFile: vi.fn(async (_project: unknown, options?: unknown) => {
      captured.calls.push({ kind: "project", options });
      return { blob: new Blob(), filename: "deck.zip", manifest: {} };
    }),
    exportDeckFile: vi.fn(async (_project: unknown, options?: unknown) => {
      captured.calls.push({ kind: "deck", options });
      return { blob: new Blob(), filename: "deck.deck", manifest: {} };
    }),
    exportLightDeck: vi.fn(async (_project: unknown, options?: unknown) => {
      captured.calls.push({ kind: "lite", options });
      return { blob: new Blob(), filename: "deck.deck.lite", manifest: {} };
    }),
  };
});

function renderExport(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${id}/export`]}>
      <Routes>
        <Route path="/project/:projectId/export" element={<ExportPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  captured.calls.length = 0;
  resetJobs();
});

it("starts a background job per artifact; compress defaults off", async () => {
  const p = newProject("Buttons");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("export-project")).toBeEnabled());
  expect(screen.getByTestId("export-deck")).toBeEnabled();
  expect(screen.getByTestId("export-lite")).toBeEnabled();
  expect(screen.getByTestId("shrink-photos")).not.toBeChecked();
  expect(screen.queryByTestId("shrink-preset")).not.toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByTestId("export-project"));
  await waitFor(() => expect(getJobs().some((j) => j.kind === "export-project" && j.status === "completed")).toBe(true));
});

it("exports the project file unchanged (original bytes, history included)", async () => {
  const p = newProject("Project Export");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("export-project")).toBeEnabled());
  const user = userEvent.setup();
  await user.click(screen.getByTestId("export-project"));
  await waitFor(() => expect(captured.calls).toHaveLength(1));
  expect(captured.calls[0]).toEqual({
    kind: "project",
    options: { onProgress: expect.any(Function), signal: expect.anything() },
  });
});

it("forwards the deck file's compress option at the chosen preset", async () => {
  const p = newProject("Deck Export");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("export-deck")).toBeEnabled());
  const user = userEvent.setup();
  await user.click(screen.getByTestId("shrink-photos"));
  expect(screen.getByTestId("shrink-preset")).toHaveValue("medium");
  await user.selectOptions(screen.getByTestId("shrink-preset"), "large");
  await user.click(screen.getByTestId("export-deck"));
  await waitFor(() => expect(captured.calls).toHaveLength(1));
  expect(captured.calls[0]).toEqual({
    kind: "deck",
    options: {
      shrink: { maxEdge: 2400, quality: 0.85 },
      onProgress: expect.any(Function),
      signal: expect.anything(),
    },
  });
});

it("exports the light deck", async () => {
  const p = newProject("Lite Export");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("export-lite")).toBeEnabled());
  const user = userEvent.setup();
  await user.click(screen.getByTestId("export-lite"));
  await waitFor(() => expect(captured.calls).toHaveLength(1));
  expect(captured.calls[0].kind).toBe("lite");
});
