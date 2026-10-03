// "Hide autosaves" in the version history: the toggle filters the list
// display-only — the underlying commits stay in the repository.
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import ExportPage from "~/routes/export";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { listVersions, type VersionInfo } from "~/lib/versioning";

// Real versioning helpers (isAutosaveCommit is what's under test); only the
// git side effects are stubbed so the test stays hermetic.
vi.mock("~/lib/versioning", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/lib/versioning")>();
  return {
    ...mod,
    ensureRepo: vi.fn(async () => {}),
    renameRepo: vi.fn(async () => {}),
    restoreVersion: vi.fn(),
    commitDeckVersion: vi.fn(async () => null),
    listVersions: vi.fn(),
  };
});

const autosave = (n: number, species = 3): VersionInfo => ({
  oid: `auto${n}0000`,
  message: `Autosave — ${species} species, ${species + 2} photos`,
  timestamp: 1000 + n,
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
  vi.restoreAllMocks();
});

it("hides autosave commits while a named version stays visible", async () => {
  const user = userEvent.setup();
  vi.mocked(listVersions).mockResolvedValue([
    autosave(2),
    { oid: "named0001", message: "before renaming pass", timestamp: 2000 },
    autosave(1),
  ]);
  const p = newProject("Hide Autosaves");
  await saveProject(p);
  renderExport(p.id);

  // Unfiltered: every commit is listed.
  await waitFor(() => expect(screen.getByTestId("version-history").querySelectorAll("li")).toHaveLength(3));
  expect(screen.queryByTestId("autosaves-hidden")).not.toBeInTheDocument();

  // Tick the filter: only the named version remains.
  await user.click(screen.getByTestId("hide-autosaves"));
  const visible = [...screen.getByTestId("version-history").querySelectorAll("li")];
  expect(visible).toHaveLength(1);
  expect(visible[0].textContent).toContain("before renaming pass");
  expect(screen.getByTestId("autosaves-hidden").textContent).toContain("Hiding 2 autosave versions.");

  // Untick: the full list returns (nothing was deleted, display-only).
  await user.click(screen.getByTestId("hide-autosaves"));
  expect(screen.getByTestId("version-history").querySelectorAll("li")).toHaveLength(3);
  expect(screen.queryByTestId("autosaves-hidden")).not.toBeInTheDocument();
});

it("explains when every version is an autosave", async () => {
  const user = userEvent.setup();
  vi.mocked(listVersions).mockResolvedValue([autosave(3), autosave(2), autosave(1)]);
  const p = newProject("All Autosaves");
  await saveProject(p);
  renderExport(p.id);

  await waitFor(() => expect(screen.getByTestId("version-history").querySelectorAll("li")).toHaveLength(3));
  await user.click(screen.getByTestId("hide-autosaves"));
  expect(screen.getByTestId("version-history").querySelectorAll("li")).toHaveLength(0);
  expect(screen.getByTestId("version-history").textContent).toContain("Every version so far is an autosave");
  expect(screen.getByTestId("autosaves-hidden").textContent).toContain("Hiding 3 autosave versions.");
});
