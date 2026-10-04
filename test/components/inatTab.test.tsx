import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import ProjectPage from "~/routes/project";
import { JobsDock } from "~/components/JobsDock";
import { getProject, saveProject, clearCachedApi } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { resetJobs, getJobs } from "~/lib/jobs";
import { setRequestGapForTests } from "~/lib/inat";
import type { Project, SpeciesEntry } from "~/lib/types";

/**
 * The iNaturalist search tab against a mocked iNat API: filters (kind,
 * native status), thumbnails, checkbox selection, and — the core of the
 * feature — "Add selected" spawning a cancellable background job that keeps
 * running after the Add-species modal closes.
 */

// Fixture taxa: two natives, one introduced, one bird (for the kind filter),
// and one unlabeled species whose photo download hangs (cancellation test).
const TAXA: Record<number, { name: string; common: string; iconic: number; means: string | null; family: string }> = {
  101: { name: "Dudleya edulis", common: "Mission lettuces", iconic: 47126, means: "native", family: "Crassulaceae" },
  102: { name: "Eichhornia crassipes", common: "Water hyacinth", iconic: 47126, means: "introduced", family: "Pontederiaceae" },
  103: { name: "Pseudognaphalium californicum", common: "California cudweed", iconic: 47126, means: null, family: "Asteraceae" },
  201: { name: "Buteo jamaicensis", common: "Red-tailed hawk", iconic: 3, means: null, family: "Accipitridae" },
  105: { name: "Dudleya variegata", common: "Variegated dudleya", iconic: 47126, means: null, family: "Crassulaceae" },
};
const ALL_IDS = Object.keys(TAXA).map(Number);
/** The one species whose photo download hangs forever (until aborted). */
const HANG_TAXON = 105;
const HANG_PHOTO = 990;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function taxonJson(id: number) {
  const t = TAXA[id];
  return {
    id,
    name: t.name,
    rank: "species",
    rank_level: 10,
    is_active: true,
    preferred_common_name: t.common,
    iconic_taxon_id: t.iconic,
    ancestors: [{ id: 900, name: t.family, rank: "family", preferred_common_name: `${t.family} family` }],
    default_photo: {
      license_code: "cc-by",
      attribution: "(c) Alice",
      url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${id}/medium.jpg`,
    },
  };
}

function candidateObs(taxonId: number) {
  const photoId = taxonId === HANG_TAXON ? HANG_PHOTO : 9000 + taxonId;
  return {
    id: 5000 + taxonId,
    uri: `https://www.inaturalist.org/observations/${5000 + taxonId}`,
    quality_grade: "research",
    user: { name: "Alice" },
    place_guess: "San Diego",
    photos: [
      {
        id: photoId,
        license_code: "cc-by",
        attribution: "(c) Alice, some rights reserved (CC BY)",
        url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${photoId}/medium.jpg`,
        file_content_type: "image/jpeg",
      },
    ],
  };
}

/** The whole iNat surface this tab touches, one mock. */
function inatFetchMock(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (/\/v1\/observations$/.test(url.pathname)) {
      const taxonId = url.searchParams.get("taxon_id");
      if (taxonId) return jsonResponse({ total_results: 1, results: [candidateObs(Number(taxonId))] });
      // Location search: one observation per fixture taxon.
      return jsonResponse({
        total_results: ALL_IDS.length,
        results: ALL_IDS.map((id) => ({ id: 7000 + id, taxon: taxonJson(id) })),
      });
    }
    if (/\/v1\/places\/nearby$/.test(url.pathname)) {
      return jsonResponse({
        total_results: 3,
        results: {
          standard: [
            { id: 1, name: "United States", display_name: "United States", admin_level: 0, bbox_area: 6349.4 },
            { id: 14, name: "California", display_name: "California, US", admin_level: 10, bbox_area: 98.13 },
            { id: 829, name: "San Diego County", display_name: "San Diego County, CA, US", admin_level: 20, bbox_area: 1.494 },
          ],
          community: [],
        },
      });
    }
    const taxaMatch = url.pathname.match(/\/v1\/taxa\/([\d,]+)$/);
    if (taxaMatch) {
      const ids = taxaMatch[1].split(",").map(Number);
      if (ids.length === 1) return jsonResponse({ total_results: 1, results: [taxonJson(ids[0])] });
      // Place-scoped checklist lookup: iNat returns FULL taxon records for
      // batched ids too (the family fields the add flow reads), plus each
      // taxon's place-scoped establishment means.
      return jsonResponse({
        total_results: ids.length,
        results: ids.map((id) => ({
          ...taxonJson(id),
          establishment_means: TAXA[id].means
            ? { establishment_means: TAXA[id].means, place: { id: 829, name: "San Diego County" } }
            : null,
          conservation_status: null,
        })),
      });
    }
    if (url.hostname.includes("inaturalist") && /\/photos\/(\d+)\//.test(url.pathname)) {
      const photoId = Number(url.pathname.match(/\/photos\/(\d+)\//)![1]);
      if (photoId === HANG_PHOTO) {
        // Hangs until the job's abort signal fires (cancellation test).
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return new Response(new Uint8Array(6000), { status: 200, headers: { "content-type": "image/jpeg" } });
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
      {/* Mounted globally by the app root; mounted here to match production. */}
      <JobsDock />
    </>,
  );
}

async function fixtureProject(): Promise<Project> {
  const project = newProject(`Inat Search ${Math.random().toString(36).slice(2, 8)}`);
  project.location = { name: "San Diego", lat: 32.75, lng: -117.05, radiusKm: 10 };
  await saveProject(project);
  return project;
}

function speciesOf(loaded: Project): SpeciesEntry[] {
  return loaded.species;
}

describe("InatTab (mocked iNat API)", () => {
  let fetchSpy: ReturnType<typeof inatFetchMock>;

  beforeEach(async () => {
    resetJobs();
    setRequestGapForTests(0);
    await clearCachedApi(); // the iNat API cache is shared state across this file's tests
    fetchSpy = inatFetchMock();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists results with thumbnails, defaults the selection to fresh species, and adds them in a background job", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    renderProject(project.id);

    await user.click(await screen.findByTestId("add-species"));
    await user.click(screen.getByTestId("inat-search"));
    await screen.findByTestId("inat-result-101");

    // Thumbnails come from the taxon's default photo as a square.
    const thumb = screen.getByTestId("result-thumb-101");
    expect(thumb.getAttribute("src")).toContain("/photos/101/square.jpg");

    // Default selection: everything not already in the deck (all five).
    expect(screen.getByTestId("inat-status")).toHaveTextContent(/Found 5 species/);
    expect(screen.getByTestId("inat-add-selected")).toHaveTextContent("Add selected (5 species");

    // Uncheck one; the count follows.
    await user.click(screen.getByTestId("select-result-105"));
    expect(screen.getByTestId("inat-add-selected")).toHaveTextContent("Add selected (4 species");
    await user.click(screen.getByTestId("inat-add-selected"));

    // The tab hands the work to a background job.
    expect(await screen.findByTestId("inat-status")).toHaveTextContent(/in the background/);
    await waitFor(() => expect(getJobs()[0].status).toBe("completed"));
    expect(getJobs()[0].message).toContain("Added 4 of 4 cards");

    // Close the modal — the job already ran to completion; the outcome lives
    // in the Jobs dock, not in the (closed) dialog.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByTestId("jobs-dock"));
    const panel = screen.getByTestId("jobs-modal");
    expect(await within(panel).findByText("Added 4 of 4 cards.")).toBeInTheDocument();

    // The deck gained the four species, each with a photo and checklist labels.
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species).toHaveLength(4);
    });
    const loaded = (await getProject(project.id))!;
    const bySci = new Map(loaded.species.map((s) => [s.sciName, s]));
    expect(bySci.get("Dudleya edulis")!.native).toBe("native");
    expect(bySci.get("Eichhornia crassipes")!.native).toBe("non-native");
    expect(bySci.get("Buteo jamaicensis")!.native).toBe("unknown");
    expect(bySci.get("Dudleya edulis")!.familyLatin).toBe("Crassulaceae");
    expect(speciesOf(loaded).every((s) => s.photos.length === 1)).toBe(true);
  });

  it("adds several cards per species from one photo search — variants re-pick the cached candidates, photos stay distinct", async () => {
    // Species 101 offers three CC photos; one observations query must serve
    // all three variant cards (iNat's ~1 req/sec pacing makes a per-card
    // search the dominant cost of bulk adds).
    const base = inatFetchMock();
    let photoSearches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (/\/v1\/observations$/.test(url.pathname) && url.searchParams.get("taxon_id") === "101") {
          photoSearches++;
          return jsonResponse({
            total_results: 1,
            results: [{
              id: 5000 + 101,
              uri: `https://www.inaturalist.org/observations/${5000 + 101}`,
              quality_grade: "research",
              user: { name: "Alice" },
              place_guess: "San Diego",
              photos: [9101, 9102, 9103].map((photoId) => ({
                id: photoId,
                license_code: "cc-by",
                attribution: "(c) Alice, some rights reserved (CC BY)",
                url: `https://inaturalist-open-data.s3.amazonaws.com/photos/${photoId}/medium.jpg`,
                file_content_type: "image/jpeg",
              })),
            }],
          });
        }
        return base(input, init);
      }),
    );

    const user = userEvent.setup();
    const project = await fixtureProject();
    renderProject(project.id);

    await user.click(await screen.findByTestId("add-species"));
    await user.click(screen.getByTestId("inat-search"));
    await screen.findByTestId("inat-result-101");

    // Only species 101; three cards, one photo each.
    await user.click(screen.getByTestId("inat-select-all")); // clears the default all-selection
    await user.click(screen.getByTestId("select-result-101"));
    await user.selectOptions(screen.getByTestId("inat-photos-per-card"), "1");
    await user.selectOptions(screen.getByTestId("inat-cards-per-species"), "3");
    await user.click(screen.getByTestId("inat-add-selected"));

    await waitFor(() => expect(getJobs()[0].status).toBe("completed"));
    expect(getJobs()[0].message).toContain("Added 3 of 3 cards");
    // One photo search for the species — the variants picked from the same
    // response instead of refetching it.
    expect(photoSearches).toBe(1);

    // Three cards landed in selection order, each with a different photo.
    const loaded = (await getProject(project.id))!;
    expect(loaded.species).toHaveLength(3);
    expect(loaded.species.map((s) => s.sciName)).toEqual(["Dudleya edulis", "Dudleya edulis", "Dudleya edulis"]);
    expect(loaded.species.map((s) => s.photos[0]!.id)).toEqual(["inat:9101", "inat:9102", "inat:9103"]);
    // Family details still ride along (from the batched checklist response).
    expect(loaded.species.every((s) => s.familyLatin === "Crassulaceae")).toBe(true);
  });

  it("filters by native status (place checklist) and hides unlabeled species", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    renderProject(project.id);

    await user.click(await screen.findByTestId("add-species"));
    await user.selectOptions(screen.getByTestId("inat-establishment"), "native");
    await user.click(screen.getByTestId("inat-search"));

    await screen.findByTestId("inat-result-101");
    // 102 is labeled non-native, 103/105/201 have no checklist data — all hidden.
    expect(screen.queryByTestId("inat-result-102")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inat-result-201")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inat-result-105")).not.toBeInTheDocument();
    expect(screen.getByTestId("native-badge-101")).toHaveTextContent("Native");
    expect(screen.getByTestId("inat-status")).toHaveTextContent(/no native-status data/i);
  });

  it("filters by kind (iconic taxon) client-side", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    renderProject(project.id);

    await user.click(await screen.findByTestId("add-species"));
    await user.selectOptions(screen.getByTestId("inat-kind"), "47126"); // Plants
    await user.click(screen.getByTestId("inat-search"));

    // The mock ignores iNat's iconic_taxa param, so the response still
    // carries the bird — the client-side filter is what drops it.
    await screen.findByTestId("inat-result-101");
    expect(screen.getByTestId("inat-result-102")).toBeInTheDocument();
    expect(screen.queryByTestId("inat-result-201")).not.toBeInTheDocument();
  });

  it("cancels the background job from the dock; the in-flight species never lands", async () => {
    const user = userEvent.setup();
    const project = await fixtureProject();
    renderProject(project.id);

    await user.click(await screen.findByTestId("add-species"));
    await user.click(screen.getByTestId("inat-search"));
    await screen.findByTestId("inat-result-105");

    // Only the hang-forever species.
    await user.click(screen.getByTestId("inat-select-all")); // clears the default all-selection
    await user.click(screen.getByTestId("select-result-105"));
    await user.click(screen.getByTestId("inat-add-selected"));

    // Close the modal — the job keeps running — then cancel it from the dock.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByTestId("jobs-dock"));
    await user.click(await screen.findByTestId(/job-cancel-/));

    await waitFor(() => expect(getJobs()[0].status).toBe("cancelled"));
    expect(getJobs()[0].message).toContain("Cancelled after 0 of 1");
    expect(getJobs()[0].message).toContain("0 of 1");

    // The species whose download was aborted never made it into the deck.
    const loaded = (await getProject(project.id))!;
    expect(loaded.species).toHaveLength(0);
  });
});
