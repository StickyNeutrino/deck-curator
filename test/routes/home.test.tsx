import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import Home from "~/routes/home";
import { listProjects, getProject } from "~/lib/store";

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

describe("home route", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the empty state", async () => {
    renderHome();
    await screen.findByTestId("no-projects");
    expect(screen.getByRole("heading", { name: "Deck Curator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New deck" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /template/i })).not.toBeInTheDocument();
  });

  it("creates a project and persists it", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(await screen.findByRole("button", { name: "New deck" }));
    await user.type(screen.getByTestId("new-deck-name"), "Mission Trails");
    await user.click(screen.getByTestId("create-deck"));

    await waitFor(async () => {
      const projects = await listProjects();
      expect(projects.some((p) => p.name === "Mission Trails")).toBe(true);
    });
    const created = (await listProjects()).find((p) => p.name === "Mission Trails")!;
    expect((await getProject(created.id))!.deckLabel).toBe("Mission Trails");
  });
});