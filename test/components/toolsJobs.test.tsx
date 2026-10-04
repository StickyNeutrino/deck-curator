import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import ProjectPage from "~/routes/project";
import { JobsDock } from "~/components/JobsDock";
import { getProject, saveProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { resetJobs, getJobs } from "~/lib/jobs";
import { setRequestGapForTests } from "~/lib/inat";
import type { Project } from "~/lib/types";

/**
 * Deck tools run as background jobs: the menu closes immediately, nothing is
 * reported under the Tools button, and the Jobs dock carries the progress
 * and the outcome (including the tools' "kept as-is" conflict reports).
 */

const PLACES = [
  { id: 1, name: "United States", display_name: "United States", admin_level: 0, bbox_area: 6349.4 },
  { id: 14, name: "California", display_name: "California, US", admin_level: 10, bbox_area: 98.13 },
  { id: 829, name: "San Diego County", display_name: "San Diego County, CA, US", admin_level: 20, bbox_area: 1.494 },
];

const MEANS: Record<number, string> = { 68205: "native", 46017: "introduced", 6930: "native" };

const JPEG_BYTES = new Uint8Array(6000); // > downloadPhoto's 5000-byte floor

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function inatFetchMock(): (input: RequestInfo | URL) => Promise<Response> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (/\/v1\/places\/nearby$/.test(url.pathname)) {
      return jsonResponse({ total_results: 3, results: { standard: PLACES, community: [] } });
    }
    if (/\/v1\/observations$/.test(url.pathname)) {
      // One CC-licensed research-grade photo for the photo-filling tool.
      const taxonId = Number(url.searchParams.get("taxon_id"));
      const results = taxonId === 68205
        ? [{
            id: 55,
            uri: "https://www.inaturalist.org/observations/55",
            quality_grade: "research",
            user: { name: "Oak Watcher" },
            photos: [{
              id: 777,
              license_code: "cc-by",
              attribution: "Oak Watcher, some rights reserved (CC BY)",
              url: "https://inaturalist-open-data.s3.amazonaws.com/photos/777/square.jpg",
              file_content_type: "image/jpeg",
            }],
          }]
        : [];
      return jsonResponse({ total_results: results.length, results });
    }
    if (/\/photos\/\d+\/(original|large|medium)\./.test(url.pathname)) {
      return new Response(JPEG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (/\/v1\/taxa\/autocomplete$/.test(url.pathname)) {
      return jsonResponse({
        total_results: 1,
        results: [{
          id: 68205,
          name: "Quercus agrifolia",
          matched_term: url.searchParams.get("q"),
          rank: "species",
          rank_level: 10,
          is_active: true,
          preferred_common_name: "Coast Live Oak",
        }],
      });
    }
    const taxaMatch = url.pathname.match(/\/v1\/taxa\/([\d,]+)$/);
    if (taxaMatch) {
      const ids = taxaMatch[1].split(",").map(Number);
      if (ids.length === 1) {
        const id = ids[0];
        return jsonResponse({
          total_results: 1,
          results: [{
            id,
            name: id === 68205 ? "Quercus agrifolia" : `Taxon ${id}`,
            rank: "species",
            rank_level: 10,
            is_active: true,
            preferred_common_name: id === 68205 ? "Coast Live Oak" : undefined,
            iconic_taxon_id: 47126,
            ancestors: [{ id: 900, name: "Fagaceae", rank: "family", preferred_common_name: "Oak family" }],
          }],
        });
      }
      return jsonResponse({
        total_results: ids.length,
        results: ids.map((id) => ({
          id,
          establishment_means: MEANS[id]
            ? { establishment_means: MEANS[id], place: { id: 829, name: "San Diego County" } }
            : null,
          conservation_status: null,
        })),
      });
    }
    return new Response(JSON.stringify({ error: "unmocked " + url.pathname }), { status: 404 });
  });
}

function renderProject(id: string) {
  return render(
    <>
      <MemoryRouter initialEntries={[`/project/${id}`]}>
        <Routes>
          <Route path="/project/:projectId" element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>
      <JobsDock />
    </>,
  );
}

async function fixtureProject(): Promise<Project> {
  const project = newProject(`Tools Jobs ${Math.random().toString(36).slice(2, 8)}`);
  project.location = { name: "San Diego", lat: 32.75, lng: -117.05, radiusKm: 10 };
  await saveProject(project);
  return project;
}

describe("deck tools as background jobs", () => {
  beforeEach(() => {
    resetJobs();
    setRequestGapForTests(0);
    vi.stubGlobal("fetch", inatFetchMock());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("labels native status in a job; conflicts and outcome live in the dock", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    project.species = [
      makeSpecies({ commonName: "Laurel Sumac", taxonId: 68205 }),
      makeSpecies({ commonName: "Gray Squirrel", taxonId: 46017 }),
      makeSpecies({ commonName: "Mallard", taxonId: 6930, native: "native" }),
      makeSpecies({ commonName: "Mislabeled", taxonId: 6930, native: "non-native" }),
    ];
    await saveProject(project);
    renderProject(project.id);

    await screen.findAllByTestId("species-row");
    await user.click(screen.getByTestId("tools-button"));
    await user.click(within(screen.getByTestId("tools-menu")).getByTestId("tool-native"));

    // The menu closed; nothing is reported under the button any more.
    expect(screen.queryByTestId("tools-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tools-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tools-progress")).not.toBeInTheDocument();

    // The job finished with the tool's report as its outcome.
    await act(async () => {
      await waitFor(() => expect(getJobs()[0].status).toBe("completed"));
    });
    expect(getJobs()[0].label).toBe("Label native / introduced (all 4 species)");
    expect(getJobs()[0].message).toContain("checked 4");
    expect(getJobs()[0].message).toContain("labeled 2");
    expect(getJobs()[0].message).toContain("1 kept as-is");
    expect(getJobs()[0].conflicts).toEqual([
      { species: "Mislabeled", detail: 'kept "non-native", iNat says "native"' },
    ]);

    // The deck was updated through the merger.
    const loaded = (await getProject(project.id))!;
    const byName = new Map(loaded.species.map((s) => [s.commonName, s]));
    expect(byName.get("Laurel Sumac")!.native).toBe("native");
    expect(byName.get("Gray Squirrel")!.native).toBe("non-native");
    expect(byName.get("Gray Squirrel")!.border).toBe("invasive");
    expect(byName.get("Mallard")!.native).toBe("native");
    expect(byName.get("Mislabeled")!.native).toBe("non-native");

    // The dock surfaces it: badge → panel → completed chip + conflicts.
    await user.click(await screen.findByTestId("jobs-dock"));
    const panel = screen.getByTestId("jobs-modal");
    const item = within(panel).getByText("Label native / introduced (all 4 species)").closest("li")!;
    expect(within(item).getByText("Completed")).toBeInTheDocument();
    await user.click(within(item).getByText("1 kept as-is"));
    expect(within(item).getByText(/kept "non-native", iNat says "native"/)).toBeInTheDocument();
  });

  it("fills gaps in a job and reports the summary in the dock", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    project.species = [makeSpecies({ commonName: "Coast Live Oak", sciName: "Quercus agrifolia", category: "plants", taxonId: 68205 })];
    await saveProject(project);
    renderProject(project.id);

    await screen.findByTestId("species-row");
    await user.click(screen.getByTestId("tools-button"));
    await user.click(within(screen.getByTestId("tools-menu")).getByTestId("tool-enrich"));

    await act(async () => {
      await waitFor(() => expect(getJobs()[0].status).toBe("completed"));
    });
    expect(getJobs()[0].message).toContain("enriched 1 species");

    const loaded = (await getProject(project.id))!;
    expect(loaded.species[0].familyLatin).toBe("Fagaceae");
    expect(loaded.species[0].familyCommon).toBe("Oak family");
  });

  it("fills missing photos in a job and lands the photos in the deck", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    project.species = [makeSpecies({ commonName: "Coast Live Oak", sciName: "Quercus agrifolia", category: "plants", taxonId: 68205 })];
    await saveProject(project);
    renderProject(project.id);

    await screen.findByTestId("species-row");
    await user.click(screen.getByTestId("tools-button"));
    const menu = screen.getByTestId("tools-menu");
    // The menu advertises what it would work on.
    expect(within(menu).getByTestId("tool-photos")).toHaveTextContent("(1 to fill)");
    await user.click(within(menu).getByTestId("tool-photos"));
    expect(screen.queryByTestId("tools-menu")).not.toBeInTheDocument();

    await act(async () => {
      await waitFor(() => expect(getJobs()[0].status).toBe("completed"));
    });
    expect(getJobs()[0].label).toBe("Fill missing photos (all 1 species)");
    expect(getJobs()[0].message).toContain("added photos to 1 of 1 cards");

    // The deck gained the auto-picked photo, credit and all.
    const loaded = (await getProject(project.id))!;
    expect(loaded.species[0].photos).toHaveLength(1);
    expect(loaded.species[0].photos[0].id).toBe("inat:777");
    expect(loaded.species[0].photos[0].role).toBe("main");
    expect(loaded.species[0].photos[0].credit).toMatchObject({ observer: "Oak Watcher", license: "cc-by" });

    // The dock surfaces the outcome too.
    await user.click(await screen.findByTestId("jobs-dock"));
    const panel = screen.getByTestId("jobs-modal");
    const item = within(panel).getByText("Fill missing photos (all 1 species)").closest("li")!;
    expect(within(item).getByText("Completed")).toBeInTheDocument();
  });
});
