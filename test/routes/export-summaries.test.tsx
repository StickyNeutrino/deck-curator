// Export stays about exporting: the review and the version history appear
// only as one-line summaries linking to their own pages.
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import ExportPage from "~/routes/export";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { makeSpecies } from "~/lib/types";
import { listVersions } from "~/lib/versioning";

vi.mock("~/lib/versioning", () => ({
  ensureRepo: vi.fn(async () => {}),
  listVersions: vi.fn(),
  renameRepo: vi.fn(),
  restoreVersion: vi.fn(),
  commitDeckVersion: vi.fn(),
  isAutosaveCommit: (message: string) => message.startsWith("Autosave — "),
}));

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
  vi.restoreAllMocks();
});

it("summarizes the review as issue counts, linking to the full report", async () => {
  const p = newProject("Summary Deck");
  // A photo-less card is one red issue on its own.
  p.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }));
  await saveProject(p);
  vi.mocked(listVersions).mockResolvedValue([]);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("export-project")).toBeEnabled());
  const summary = screen.getByTestId("review-summary");
  expect(summary.textContent).toContain("1 error");
  expect(summary.textContent).not.toContain("no photos yet"); // the list lives on Review
  const link = summary.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/project/" + p.id + "/review?filter=issues");

  // The full version list is gone from this page too.
  expect(screen.queryByTestId("version-history")).not.toBeInTheDocument();
});

it("summarizes the version history: total and when the last one landed", async () => {
  const p = newProject("History Summary");
  await saveProject(p);
  vi.mocked(listVersions).mockResolvedValue([
    { oid: "fresh0001", message: "Autosave — 1 species, 1 photo", timestamp: Date.now() - 60_000 },
    { oid: "older0002", message: "Created deck", timestamp: Date.now() - 3_600_000 },
  ]);
  renderExport(p.id);

  const summary = await screen.findByTestId("history-summary");
  await waitFor(() => expect(summary.textContent).toContain("2 versions"));
  expect(summary.textContent).toContain("last saved 1 minute ago");
  expect(summary.textContent).not.toContain("Autosave —"); // details live on History
  expect(summary.querySelector("a")?.getAttribute("href")).toBe("/project/" + p.id + "/history");
});

it("says so when a deck has no versions yet", async () => {
  const p = newProject("Fresh Deck");
  await saveProject(p);
  vi.mocked(listVersions).mockResolvedValue([]);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("export-project")).toBeEnabled());
  await waitFor(() => expect(screen.getByTestId("history-summary").textContent).toContain("No versions yet"));
});
