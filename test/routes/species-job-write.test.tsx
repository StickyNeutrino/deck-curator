// The species editor saves the whole record from its own snapshot. A
// background job (fill missing photos, enrich) keeps writing the deck while
// the editor sits open — its record change and freshly stored photos must
// survive the editor's Save instead of being clobbered and cleaned up.
import { expect, it, vi } from "vitest";
import { render, cleanup, waitFor, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import SpeciesPage from "~/routes/species";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies, type Project } from "~/lib/types";
import * as store from "~/lib/store";
import { mutateProject } from "~/lib/useProjectDoc";

vi.mock("~/components/InatPhotoBrowser", () => ({ InatPhotoBrowser: () => null }));

const CREDIT = { observer: "A", license: "cc0" } as const;

function deck(): Project {
  const p = newProject(`Job Write ${crypto.randomUUID().slice(0, 6)}`);
  p.species = [
    makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }),
    makeSpecies({ commonName: "Elm", sciName: "Ulmus", category: "plants" }),
  ];
  return p;
}

function renderEditor(project: Project) {
  render(
    <MemoryRouter initialEntries={[`/project/${project.id}/species/${project.species[0].id}`]}>
      <Routes>
        <Route path="/project/:projectId/species/:speciesId" element={<SpeciesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function saveAndWaitForSaved() {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("save-species"));
  await waitFor(() => expect(screen.getByTestId("save-species")).toHaveTextContent("Saved"));
}

it("keeps a background job's record change and photos when the editor saves", async () => {
  const p = deck();
  await store.saveProject(p);
  renderEditor(p);
  // The editor holds its pre-job snapshot from here on.
  await screen.findByTestId("save-species");

  // The job stores bytes, then lands its record change while the editor
  // sits open — exactly the fill-missing-photos flow.
  await store.putFile(p.id, "job-photo.jpg", new Blob(["job-bytes"]));
  await mutateProject(p.id, (d) => {
    d.species[1].photos.push({
      id: "job",
      role: "main",
      credit: CREDIT,
      fileKey: "job-photo.jpg",
    });
  });

  await saveAndWaitForSaved();

  const persisted = await store.getProject(p.id);
  expect(persisted!.species[1].photos.map((x) => x.fileKey)).toContain("job-photo.jpg");
  expect(await store.getFile(p.id, "job-photo.jpg")).toBeDefined();
  cleanup();
});

it("spares a freshly stored file whose record change hasn't landed yet", async () => {
  const p = deck();
  await store.saveProject(p);
  renderEditor(p);
  await screen.findByTestId("save-species");

  // Mid-download: the job's bytes are in the store but its record write is
  // still pending — nothing references the file yet. Cleanup must not treat
  // it as an orphan.
  await store.putFile(p.id, "in-flight.jpg", new Blob(["in-flight-bytes"]));

  await saveAndWaitForSaved();

  expect(await store.getFile(p.id, "in-flight.jpg")).toBeDefined();
  cleanup();
});

it("cleans up pre-existing orphans but spares files that appeared while the editor was open", async () => {
  const p = deck();
  p.species[0].photos.push({ id: "gone", role: "main", credit: CREDIT, fileKey: "removed.jpg" });
  await store.saveProject(p);
  // Present before the editor opens — a settled file cleanup may delete.
  await store.putFile(p.id, "removed.jpg", new Blob(["removed-bytes"]));

  renderEditor(p);
  await screen.findByTestId("save-species");

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "remove" }));
  // A new file with no reference yet — possibly a job's in-flight upload.
  await store.putFile(p.id, "fresh-orphan.jpg", new Blob(["fresh-orphan"]));

  await saveAndWaitForSaved();

  expect(await store.getFile(p.id, "removed.jpg")).toBeUndefined();
  expect(await store.getFile(p.id, "fresh-orphan.jpg")).toBeDefined();
  cleanup();
});
