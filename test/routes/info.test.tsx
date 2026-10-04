import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router";
import InfoPage from "~/routes/info";
import { getProject, saveProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

// Stub the batched iconic-taxon lookup (network-free) for the granularity
// re-sort test; hoisted to the top level as vi.mock requires.
vi.mock("~/lib/inat", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/lib/inat")>();
  return {
    ...mod,
    inatGet: vi.fn(async (_e: string, params: Record<string, unknown>) => ({
      results: [{ id: 1, iconic_taxon_id: 3 }],
    })),
  };
});

function renderInfo(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${id}/info`]}>
      <Routes>
        <Route path="/project/:projectId/info" element={<InfoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fixture() {
  const project = newProject("Info Fixture");
  project.location = { name: "Mission Trails", lat: 32.82, lng: -117.05, radiusKm: 12 };
  project.granularity = "fine";
  project.species.push(
    makeSpecies({ commonName: "Oak", category: "plants", tags: ["phase 1"] }),
  );
  await saveProject(project);
  return project;
}

describe("deck info page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("edits the deck name and persists it", async () => {
    const user = userEvent.setup();
    const project = await fixture();
    renderInfo(project.id);

    const label = await screen.findByTestId("deck-label");
    expect(label).toHaveValue("Info Fixture");
    await user.clear(label);
    await user.type(label, "Renamed Deck");
    await user.click(screen.getByTestId("deck-label")); // blur commit via store

    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.deckLabel).toBe("Renamed Deck");
    });
  });

  it("renames the deck id and moves the record with it", async () => {
    const user = userEvent.setup();
    const project = await fixture();
    renderInfo(project.id);

    const idField = await screen.findByTestId("deck-id");
    expect(idField).toHaveValue(project.id);
    await user.clear(idField);
    await user.type(idField, "renamed-id");
    await user.click(screen.getByTestId("deck-label")); // blur commits the rename

    // The page follows the deck to its new id.
    await waitFor(() => {
      expect(screen.getByTestId("deck-id")).toHaveValue("renamed-id");
    });
    await waitFor(async () => {
      expect(await getProject("renamed-id")).not.toBeNull();
      expect(await getProject(project.id)).toBeUndefined();
    });
  });

  it("rejects ids outside the slug alphabet without renaming", async () => {
    const user = userEvent.setup();
    const project = await fixture();
    renderInfo(project.id);

    const idField = await screen.findByTestId("deck-id");
    await user.clear(idField);
    await user.type(idField, "Bad Id!");
    await user.click(screen.getByTestId("deck-label")); // blur commits

    expect(await screen.findByTestId("identity-error")).toHaveTextContent(/lowercase letters/);
    expect(await getProject(project.id)).not.toBeNull();
  });

  it("shows the deck location, categories, and tags managers", async () => {
    const project = await fixture();
    renderInfo(project.id);
    await screen.findByTestId("deck-label");
    expect(screen.getByTestId("deck-location")).toBeInTheDocument();
    expect(screen.getByTestId("location-status")).toHaveTextContent(/Mission Trails/);
    expect(screen.getByTestId("categories-manager")).toBeInTheDocument();
    expect(screen.getByTestId("tags-manager")).toBeInTheDocument();
    // Tags from the project show with counts.
    expect(screen.getByTestId("tag-phase 1").textContent).toContain("1");
  });

  it("re-files species into fine categories when granularity changes", async () => {
    const user = userEvent.setup();
    const project = await fixture();
    // Species currently sits in "plants"; a bird in "animals" should move to
    // "birds" when the user switches to fine granularity.
    const bird = makeSpecies({ commonName: "Wren", sciName: "Thryomanes bewickii", category: "animals", taxonId: 1 });
    const loaded = (await getProject(project.id))!;
    loaded.species.push(bird);
    await saveProject(loaded);

    // The hoisted top-level mock stubs the iconic-taxon lookup.
    renderInfo(project.id);
    await screen.findByTestId("deck-label");
    await user.selectOptions(await screen.findByTestId("granularity-select"), "fine");

    await waitFor(async () => {
      const after = (await getProject(project.id))!;
      const wren = after.species.find((s) => s.commonName === "Wren")!;
      expect(wren.category).toBe("birds");
      expect(after.categories.some((c) => c.id === "birds")).toBe(true);
    });
  });
});
