// Version history on its own page: the autosave filter is display-only,
// authorship is visible per version with an editor one click away, and a
// populated history doesn't refresh in a loop.
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import HistoryPage from "~/routes/history";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { listVersions, type VersionInfo } from "~/lib/versioning";
import { getAuthor } from "~/lib/author";

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

function renderHistory(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${id}/history`]}>
      <Routes>
        <Route path="/project/:projectId/history" element={<HistoryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
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
  renderHistory(p.id);

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
  renderHistory(p.id);

  await waitFor(() => expect(screen.getByTestId("version-history").querySelectorAll("li")).toHaveLength(3));
  await user.click(screen.getByTestId("hide-autosaves"));
  expect(screen.getByTestId("version-history").querySelectorAll("li")).toHaveLength(0);
  expect(screen.getByTestId("version-history").textContent).toContain("Every version so far is an autosave");
  expect(screen.getByTestId("autosaves-hidden").textContent).toContain("Hiding 3 autosave versions.");
});

it("shows each version's author and offers an editor", async () => {
  vi.mocked(listVersions).mockResolvedValue([
    {
      oid: "ada00001",
      message: "Autosave — 3 species, 5 photos",
      timestamp: 3000,
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
    },
    {
      oid: "init0001",
      message: "Created deck “Authorship Display”",
      timestamp: 1000,
      authorName: "Deck Curator",
      authorEmail: "curator@localhost",
    },
  ] satisfies VersionInfo[]);
  const p = newProject("Authorship Display");
  await saveProject(p);
  renderHistory(p.id);

  const list = await screen.findByTestId("version-history");
  await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(2));
  expect(screen.getByTestId("version-author-ada00001").textContent).toBe("Ada Lovelace");
  // The email rides along as the tooltip — how GitHub correlation happens.
  expect(screen.getByTestId("version-author-ada00001")).toHaveAttribute(
    "title",
    "Ada Lovelace <ada@example.com>",
  );

  // The header names the current identity and opens the editor.
  expect(screen.getByTestId("version-author").textContent).toContain(getAuthor().name);
  const user = userEvent.setup();
  await user.click(screen.getByTestId("version-author"));
  expect(screen.getByTestId("author-modal")).toBeInTheDocument();
  // The editor has no "Not now" — closing is the only alternative to saving.
  expect(screen.queryByTestId("author-skip")).not.toBeInTheDocument();

  await user.clear(screen.getByTestId("author-name"));
  await user.type(screen.getByTestId("author-name"), "Grace Hopper");
  await user.click(screen.getByTestId("author-save"));
  expect(screen.queryByTestId("author-modal")).not.toBeInTheDocument();
  expect(getAuthor()).toEqual({ name: "Grace Hopper", email: "curator@localhost" });
  // The header reflects the new identity without a page reload.
  expect(screen.getByTestId("version-author").textContent).toContain("Grace Hopper");
});

it("renders versions without authorship (older histories) without noise", async () => {
  vi.mocked(listVersions).mockResolvedValue([
    { oid: "legacy000", message: "Created deck", timestamp: 1000 },
  ]);
  const p = newProject("Authorship Legacy");
  await saveProject(p);
  renderHistory(p.id);

  const list = await screen.findByTestId("version-history");
  await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(1));
  expect(list.textContent).not.toContain("undefined");
  expect(screen.queryByTestId("version-author-legacy000")).not.toBeInTheDocument();
});

it("does not continuously refresh a populated version history", async () => {
  let calls = 0;
  vi.mocked(listVersions).mockImplementation(async () => {
    calls++;
    // Bound the reproducer so an infinite effect cannot hang the test run.
    if (calls > 12) return new Promise(() => {});
    return [{ oid: "abcdef", message: "Created", timestamp: 1 }];
  });
  const p = newProject("Loop Repro");
  await saveProject(p);
  renderHistory(p.id);
  await waitFor(() => expect(calls).toBeGreaterThan(0));
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  cleanup();
  expect(calls).toBeLessThanOrEqual(2);
});
