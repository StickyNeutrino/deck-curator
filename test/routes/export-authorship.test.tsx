// Version authorship on the export page: each version shows who committed
// it, and the header names the current identity with an editor one click
// away.
import { expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import ExportPage from "~/routes/export";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { listVersions, type VersionInfo } from "~/lib/versioning";
import { getAuthor } from "~/lib/author";

// Real versioning helpers; only the git side effects are stubbed so the
// test stays hermetic.
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
  window.localStorage.clear();
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
  renderExport(p.id);

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
  renderExport(p.id);

  const list = await screen.findByTestId("version-history");
  await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(1));
  expect(list.textContent).not.toContain("undefined");
  expect(screen.queryByTestId("version-author-legacy000")).not.toBeInTheDocument();
});
