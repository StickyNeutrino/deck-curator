// Review-only reproducer; copy into test/ to run with the repository's Vitest config.
import { expect, it, vi } from "vitest";
import { render, cleanup, waitFor, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import SpeciesPage from "~/routes/species";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import * as store from "~/lib/store";

vi.mock("~/components/InatPhotoBrowser", () => ({ InatPhotoBrowser: () => null }));

it("does not delete a photo queued for removal after the save snapshot was taken", async () => {
  const p = newProject("Photo Save Race");
  p.species = [makeSpecies({ commonName: "Oak", category: "plants", photos: [{ id: "p", role: "main", fileKey: "a.jpg", credit: { observer: "A", license: "cc0" } }] })];
  await store.saveProject(p);
  await store.putFile(p.id, "a.jpg", new Blob(["jpeg"]));
  const realSave = store.saveProject;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const save = vi.spyOn(store, "saveProject").mockImplementation(async project => {
    await gate;
    await realSave(project);
  });
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/project/${p.id}/species/${p.species[0].id}`]}><Routes><Route path="/project/:projectId/species/:speciesId" element={<SpeciesPage />} /></Routes></MemoryRouter>);
  await user.click(await screen.findByTestId("save-species"));
  await user.click(screen.getByRole("button", { name: "remove" }));
  await act(async () => { release(); await gate; });
  await waitFor(() => expect(screen.getByTestId("save-species")).toHaveTextContent("Saved"));
  const persisted = await store.getProject(p.id);
  const file = await store.getFile(p.id, "a.jpg");
  cleanup();
  save.mockRestore();
  expect(persisted!.species[0].photos).toHaveLength(1);
  expect(file).toBeDefined();
});
