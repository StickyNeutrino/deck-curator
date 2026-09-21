import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import SpeciesPage from "~/routes/species";
import { saveProject, getProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

function renderSpecies(projectId: string, speciesId: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${projectId}/species/${speciesId}`]}>
      <Routes>
        <Route path="/project/:projectId/species/:speciesId" element={<SpeciesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function makeFixture() {
  const project = newProject("Species Fixture");
  const entry = makeSpecies({
    commonName: "Dwarf Nettle",
    sciName: "Urtica urens",
    category: "plants",
  });
  project.species.push(entry);
  await saveProject(project);
  return { project, entry };
}

describe("species route", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the editor with live preview", async () => {
    const { project, entry } = await makeFixture();
    renderSpecies(project.id, entry.id);
    expect(await screen.findByTestId("common-name")).toHaveValue("Dwarf Nettle");
    expect(await screen.findByTestId("sci-name")).toHaveValue("Urtica urens");
    // Preview renders both sides.
    await screen.findByTestId("card-front");
    await screen.findByTestId("card-back");
  });

  it("saves edited fields", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    renderSpecies(project.id, entry.id);

    const commonName = await screen.findByTestId("common-name");
    await user.clear(commonName);
    await user.type(commonName, "Burning Nettle");
    await user.click(screen.getByTestId("border-invasive"));
    await user.selectOptions(await screen.findByTestId("native-status"), "non-native");
    await user.click(screen.getByTestId("save-species"));

    await waitFor(async () => {
      const { getProject } = await import("~/lib/store");
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].commonName).toBe("Burning Nettle");
      expect(loaded.species[0].border).toBe("invasive");
      expect(loaded.species[0].native).toBe("non-native");
    });
  });

  it("switches the card layout", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    renderSpecies(project.id, entry.id);
    await user.selectOptions(await screen.findByTestId("layout-select"), "photo-single");
    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].layout).toBe("photo-single");
    });
  });

  it("shows a missing-species message for a bad id", async () => {
    const { project } = await makeFixture();
    renderSpecies(project.id, "no-such-id");
    await screen.findByText("Species not found.");
  });
});