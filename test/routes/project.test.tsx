import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import ProjectPage from "~/routes/project";
import { listProjects, getProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { saveProject } from "~/lib/store";

function renderProject(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${id}`]}>
      <Routes>
        <Route path="/project/:projectId" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function makeFixtureProject() {
  const project = newProject("Editor Test");
  await saveProject(project);
  return project;
}

describe("project route", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the deck header and empty species table", async () => {
    const project = await makeFixtureProject();
    renderProject(project.id);
    expect(await screen.findByTestId("deck-label")).toHaveValue("Editor Test");
    await screen.findByTestId("empty-species");
  });

  it("adds species from the typed-list tab (no iNat)", async () => {
    const user = userEvent.setup();
    const project = await makeFixtureProject();
    renderProject(project.id);

    await user.click(await screen.findByTestId("add-species"));
    await user.type(screen.getByTestId("name-list"), "Quercus agrifolia\nDudleya edulis");
    // Uncheck the iNat enrichment so the test needs no network.
    await user.click(screen.getByRole("checkbox", { name: /look up on inaturalist/i }));
    await user.click(screen.getByTestId("add-list"));

    await screen.findByTestId("list-status");
    await waitFor(async () => {
      const updated = (await getProject(project.id))!;
      expect(updated.species).toHaveLength(2);
    });
    const loaded = (await getProject(project.id))!;
    expect(loaded.species.map((s) => s.sciName)).toEqual(["Quercus agrifolia", "Dudleya edulis"]);
  });

  it("edits native status and invasive flags inline", async () => {
    const user = userEvent.setup();
    const project = newProject("Inline Test");
    project.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }));
    await saveProject(project);
    renderProject(project.id);

    const row = (await screen.findByTestId("species-row")) as HTMLElement;
    const status = await screen.findByLabelText("Native status of Oak");
    await user.selectOptions(status, "native");
    await user.click(screen.getByLabelText("Invasive: Oak"));

    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].native).toBe("native");
      expect(loaded.species[0].invasive).toBe(true);
    });
    row && void row; // keep the element reference meaningful
  });

  it("removes a species after confirm", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const project = newProject("Removal");
    project.species.push(makeSpecies({ commonName: "Gone", category: "plants" }));
    await saveProject(project);
    renderProject(project.id);

    const row = await screen.findByTestId("species-row");
    await user.click(within(row).getByRole("button", { name: "remove" }));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species).toHaveLength(0);
    });
  });
});