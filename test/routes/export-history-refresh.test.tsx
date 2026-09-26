// Review-only reproducer; copy into test/ to run with the repository's Vitest config.
import { expect, it, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import ExportPage from "~/routes/export";
import { newProject } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { listVersions } from "~/lib/versioning";

vi.mock("~/lib/versioning", () => ({
  ensureRepo: vi.fn(async () => {}),
  listVersions: vi.fn(),
  renameRepo: vi.fn(),
  restoreVersion: vi.fn(),
  commitDeckVersion: vi.fn(),
}));

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
  render(<MemoryRouter initialEntries={[`/project/${p.id}/export`]}><Routes><Route path="/project/:projectId/export" element={<ExportPage />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(calls).toBeGreaterThan(0));
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  cleanup();
  expect(calls).toBeLessThanOrEqual(2);
});
