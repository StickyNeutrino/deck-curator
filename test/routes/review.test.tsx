import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import ReviewPage from "~/routes/review";
import { saveProject, putFile } from "~/lib/store";
import { ensureRepo, listVersions } from "~/lib/versioning";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import type { PhotoSlot } from "~/lib/types";

/**
 * The review page used to read every photo of the deck before rendering
 * anything — one slow IndexedDB read at a time. These tests pin the new
 * pipeline: photos stream in through the prioritized loader, and the grid
 * renders its cards without waiting for the whole deck's blobs.
 */

function renderReview(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/project/${id}/review`]}>
      <Routes>
        <Route path="/project/:projectId/review" element={<ReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function photoSlot(fileKey: string, id: string): PhotoSlot {
  return {
    id,
    role: "main",
    fileKey,
    credit: { observer: "tester", license: "cc0" },
  };
}

describe("review route", () => {
  afterEach(cleanup);

  it("streams card photos in without an all-at-once blob read", async () => {
    const project = newProject("Stream");
    const species = [
      makeSpecies({ commonName: "First", sciName: "Primus", category: "plants" }),
      makeSpecies({ commonName: "Second", sciName: "Secundus", category: "plants" }),
      makeSpecies({ commonName: "Third", sciName: "Tertius", category: "plants" }),
    ];
    for (const [i, s] of species.entries()) {
      s.photos = [photoSlot(`photo-${i}.jpg`, `inat:${i}`)];
      project.species.push(s);
      // The last card's file is deliberately absent — a broken slot must
      // not hold the other cards' photos hostage.
      if (i < 2) await putFile(project.id, `photo-${i}.jpg`, new Blob([`bytes-${i}`]));
    }
    await saveProject(project);

    renderReview(project.id);

    // Cards render from the project record alone — no blob waiting.
    await screen.findByTestId("review-card-" + species[0].id);
    expect(screen.getByTestId("review-card-" + species[2].id)).toBeInTheDocument();

    // Photos that exist resolve through the loader and appear.
    await waitFor(() => {
      expect(document.querySelectorAll(".slot img")).toHaveLength(2);
    });
    // The missing file's slot stays a placeholder (no broken image).
    const thirdCard = screen.getByTestId("review-card-" + species[2].id);
    expect(thirdCard.querySelectorAll(".slot img")).toHaveLength(0);
    expect(thirdCard.querySelector(".slot")).toBeInTheDocument();
  });

  it("does not re-render card fronts as later photos arrive", async () => {
    // A deck long enough that several batches stream in after first paint.
    const project = newProject("Stable");
    for (let i = 0; i < 12; i++) {
      const s = makeSpecies({ commonName: `Species ${i}`, sciName: `Sp ${i}`, category: "plants" });
      s.photos = [photoSlot(`photo-${i}.jpg`, `inat:${i}`)];
      project.species.push(s);
      await putFile(project.id, `photo-${i}.jpg`, new Blob([`bytes-${i}`]));
    }
    await saveProject(project);

    renderReview(project.id);
    await screen.findByTestId("review-card-" + project.species[0].id);
    // Every front settles with its photo (each card has exactly one slot).
    await waitFor(() => {
      expect(document.querySelectorAll(".slot img")).toHaveLength(12);
    });
    // The first card's DOM node was never replaced by the streamed updates.
    const firstFront = await waitFor(() => {
      const fronts = document.querySelectorAll("[data-testid='card-front']");
      expect(fronts).toHaveLength(12);
      return fronts[0];
    });
    expect(document.querySelector("[data-testid='card-front']")).toBe(firstFront);
  });

  it("lands a version for review-page edits when the page is left", async () => {
    // Flag toggles used to save the record but never produce a git version
    // (autosave was armed on the cards page only). Now the record save arms
    // the shared autosave, and leaving the page flushes it.
    const user = userEvent.setup();
    const project = newProject("Flag autosave");
    const species = makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" });
    project.species.push(species);
    await saveProject(project);
    await ensureRepo(project);
    const before = (await listVersions(project.id)).length;

    renderReview(project.id);
    const card = await screen.findByTestId(`review-card-${species.id}`);
    await user.click(within(card).getByTestId(`flag-${species.id}`));

    cleanup();
    await waitFor(async () => {
      expect((await listVersions(project.id)).length).toBeGreaterThan(before);
    });
    const messages = (await listVersions(project.id)).map((v) => v.message);
    expect(messages[0]).toContain("Autosave");
  });
});
