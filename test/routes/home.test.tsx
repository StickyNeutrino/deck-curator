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
    expect(screen.getByRole("button", { name: /template/i })).toBeInTheDocument();
  });

  it("creates a project and persists it", async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(await screen.findByRole("button", { name: "New deck" }));
    await user.type(screen.getByLabelText("Deck name"), "Mission Trails");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(async () => {
      const projects = await listProjects();
      expect(projects.some((p) => p.name === "Mission Trails")).toBe(true);
    });
    const created = (await listProjects()).find((p) => p.name === "Mission Trails")!;
    expect((await getProject(created.id))!.deckLabel).toBe("Mission Trails");
  });

  it("downloads the spreadsheet template as an anchor click", async () => {
    renderHome();
    const origCreate = document.createElement.bind(document);
    const click = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tag: string, ...rest: any[]) => {
      const el = origCreate(tag, ...rest);
      if (tag === "a") Object.defineProperty(el, "click", { value: click });
      return el;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /template/i }));
    expect(click).toHaveBeenCalled();
  });
});