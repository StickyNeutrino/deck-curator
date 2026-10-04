// Export options: history ships by default, shrinking is opt-in, and the
// export button forwards the toggles to exportDeck.
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import ExportPage from "~/routes/export";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";

const captured = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("~/lib/versioning", () => ({
  ensureRepo: vi.fn(async () => {}),
  listVersions: vi.fn(async () => []),
  renameRepo: vi.fn(async () => {}),
  restoreVersion: vi.fn(),
  commitDeckVersion: vi.fn(async () => null),
}));

vi.mock("~/lib/export", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/lib/export")>();
  return {
    ...mod,
    exportDeck: vi.fn(async (_project: unknown, options?: unknown) => {
      captured.calls.push(options);
      return { blob: new Blob(), filename: "options-deck.zip", manifest: {} };
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
});

it("defaults to history included and no shrinking", async () => {
  const p = newProject("Options Defaults");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("include-history")).toBeChecked());
  expect(screen.getByTestId("shrink-photos")).not.toBeChecked();
  expect(screen.queryByTestId("shrink-preset")).not.toBeInTheDocument();

  await waitFor(() => expect(screen.getByTestId("export-deck")).toBeEnabled());
  const user = userEvent.setup();
  await user.click(screen.getByTestId("export-deck"));
  await waitFor(() => expect(captured.calls).toHaveLength(1));
  expect(captured.calls[0]).toEqual({ includeHistory: true, shrink: null });
});

it("forwards the toggles: lean archive + shrunk at the chosen preset", async () => {
  const p = newProject("Options Toggles");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("include-history")).toBeEnabled());
  const user = userEvent.setup();
  await user.click(screen.getByTestId("include-history"));
  await user.click(screen.getByTestId("shrink-photos"));
  expect(screen.getByTestId("shrink-preset")).toHaveValue("medium");
  await user.selectOptions(screen.getByTestId("shrink-preset"), "large");
  await user.click(screen.getByTestId("export-deck"));

  await waitFor(() => expect(captured.calls).toHaveLength(1));
  expect(captured.calls[0]).toEqual({
    includeHistory: false,
    shrink: { maxEdge: 2400, quality: 0.85 },
  });
});
