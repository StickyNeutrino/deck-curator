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

  it("renders the species table (metadata lives on the Deck info tab)", async () => {
    const project = await makeFixtureProject();
    renderProject(project.id);
    await screen.findByTestId("empty-species");
    expect(screen.getByTestId("project-tabs")).toBeInTheDocument();
    // Deck info leads the tabs — a deck's settings govern its card work.
    expect(
      Array.from(screen.getByTestId("project-tabs").querySelectorAll("a")).map((a) =>
        a.getAttribute("data-testid"),
      ),
    ).toEqual(["tab-info", "tab-cards", "tab-review", "tab-export"]);
    // The name/description editor moved to the Deck info tab.
    expect(screen.queryByTestId("deck-label")).not.toBeInTheDocument();
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

  it("edits native status and border style inline", async () => {
    const user = userEvent.setup();
    const project = newProject("Inline Test");
    project.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" }));
    await saveProject(project);
    renderProject(project.id);

    await screen.findByTestId("species-row");
    const status = await screen.findByLabelText("Native status of Oak");
    await user.selectOptions(status, "native");
    await user.selectOptions(await screen.findByLabelText("Border style of Oak"), "invasive");

    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].native).toBe("native");
      expect(loaded.species[0].border).toBe("invasive");
    });
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

  it("supports row selection with select-all and a clear button", async () => {
    const user = userEvent.setup();
    const project = newProject("Selection");
    project.species.push(
      makeSpecies({ commonName: "Oak", category: "plants" }),
      makeSpecies({ commonName: "Squirrel", category: "animals" }),
      makeSpecies({ commonName: "Fern", category: "plants" }),
    );
    await saveProject(project);
    renderProject(project.id);

    const rows = await screen.findAllByTestId("species-row");
    expect(rows).toHaveLength(3);

    // Select two rows; the toolbar counts them and offers a clear.
    await user.click(rows[0].querySelector('input[type="checkbox"]')!);
    await user.click(rows[1].querySelector('input[type="checkbox"]')!);
    expect(screen.getByTestId("clear-selection")).toHaveTextContent("2 selected");

    // Select-all checks every visible row.
    const all = screen.getByTestId("select-all");
    await user.click(all);
    expect(screen.getByTestId("clear-selection")).toHaveTextContent("3 selected");
    await user.click(screen.getByTestId("clear-selection"));
    expect(screen.queryByTestId("clear-selection")).not.toBeInTheDocument();
  });

  it("opens the tools menu and reports a missing deck location for place-based tools", async () => {
    const user = userEvent.setup();
    const project = newProject("Tools");
    project.species.push(makeSpecies({ commonName: "Oak", category: "plants" }));
    await saveProject(project);
    renderProject(project.id);

    await screen.findByTestId("species-row");
    await user.click(screen.getByTestId("tools-button"));
    const menu = await screen.findByTestId("tools-menu");
    expect(within(menu).getByTestId("tool-enrich")).toHaveTextContent("Fill gaps & re-sort categories");
    expect(within(menu).getByTestId("tool-native")).toHaveTextContent("Label native / introduced");
    expect(within(menu).getByTestId("tool-rarity")).toHaveTextContent("Label conservation status");

    // No deck location → the place-based tools can't run; they say so.
    await user.click(within(menu).getByTestId("tool-native"));
    expect(await screen.findByTestId("tools-status")).toHaveTextContent(/set the deck's location/i);
  });
});