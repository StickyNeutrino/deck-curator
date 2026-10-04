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

/** The photos editor's hidden upload input (the only file input on the page). */
async function uploadInput() {
  await screen.findByTestId("photos-editor");
  return screen.getByTestId("photos-editor").querySelector('input[type="file"]') as HTMLInputElement;
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

  it("keeps a removed photo's blob in the store until the draft is saved", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    // Give the species a stored photo.
    entry.photos.push({
      id: "upload:fix",
      role: "main",
      credit: { observer: "You", license: "all-rights-reserved" },
      fileKey: "dwarf-nettle-main.jpg",
    });
    await saveProject(project);
    const { putFile, getFile } = await import("~/lib/store");
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["jpeg-bytes"]));

    renderSpecies(project.id, entry.id);
    await user.click(await screen.findByRole("button", { name: "remove" }));

    // Not saved yet: the blob must still exist (Cancel must be able to
    // restore the persisted deck exactly as it was).
    expect(await getFile(project.id, "dwarf-nettle-main.jpg")).toBeInstanceOf(Blob);

    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].photos).toHaveLength(0);
      // Only after the save is the blob really gone.
      expect(await getFile(project.id, "dwarf-nettle-main.jpg")).toBeUndefined();
    });
  });

  it("prompts for attribution when a photo is uploaded and stores the credit with the slot", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    renderSpecies(project.id, entry.id);

    const file = new File(["jpeg-bytes"], "coast-oak.jpg", { type: "image/jpeg" });
    await user.upload(await uploadInput(), file);

    // The credit prompt comes first; the "You" placeholder is blanked out.
    const observer = await screen.findByTestId("credit-observer");
    expect(observer).toHaveValue("");
    expect(screen.getByTestId("credit-license")).toHaveValue("all-rights-reserved");
    await user.type(observer, "Ann Memo");
    await user.selectOptions(screen.getByTestId("credit-license"), "cc-by");
    await user.click(screen.getByTestId("credit-save"));

    // The slot lands with the real credit, not the placeholder.
    await screen.findAllByText(/Ann Memo/);
    expect(screen.getAllByText("cc-by").length).toBeGreaterThan(0);
    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].photos).toHaveLength(1);
      expect(loaded.species[0].photos[0].credit).toMatchObject({ observer: "Ann Memo", license: "cc-by" });
      expect(loaded.species[0].photos[0].id).toMatch(/^upload:/);
    });
  });

  it("keeps the upload placeholder when the prompt is saved with a blank name", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    renderSpecies(project.id, entry.id);

    const file = new File(["jpeg-bytes"], "oak.jpg", { type: "image/jpeg" });
    await user.upload(await uploadInput(), file);
    await screen.findByTestId("credit-modal");
    await user.click(screen.getByTestId("credit-save"));

    await screen.findAllByText(/You/);
    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].photos[0].credit).toMatchObject({ observer: "You", license: "all-rights-reserved" });
    });
  });

  it("aborts the upload when the credit prompt is cancelled (no photo, no stored bytes)", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    renderSpecies(project.id, entry.id);

    const file = new File(["jpeg-bytes"], "oak.jpg", { type: "image/jpeg" });
    await user.upload(await uploadInput(), file);
    await screen.findByTestId("credit-modal");
    await user.click(screen.getByTestId("credit-cancel"));

    await waitFor(() => expect(screen.queryByTestId("credit-modal")).not.toBeInTheDocument());
    expect(screen.queryByTestId("photo-main")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].photos).toHaveLength(0);
      // The prompt ran before any bytes were written — nothing orphaned.
      const { listFileKeys } = await import("~/lib/store");
      expect(await listFileKeys(project.id)).toHaveLength(0);
    });
  });

  it("edits an existing photo's credit from the species page", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    entry.photos.push({
      id: "upload:fix",
      role: "main",
      credit: { observer: "You", license: "all-rights-reserved" },
      fileKey: "dwarf-nettle-main.jpg",
    });
    await saveProject(project);
    const { putFile } = await import("~/lib/store");
    await putFile(project.id, "dwarf-nettle-main.jpg", new Blob(["jpeg-bytes"]));

    renderSpecies(project.id, entry.id);
    await user.click(await screen.findByRole("button", { name: "credit" }));

    const modal = await screen.findByTestId("credit-modal");
    expect(modal).toBeInTheDocument();
    // Prefilled with the slot's current values ("You" blanked for retyping).
    expect(screen.getByTestId("credit-observer")).toHaveValue("");
    expect(screen.getByTestId("credit-license")).toHaveValue("all-rights-reserved");
    await user.type(screen.getByTestId("credit-observer"), "Robin Ipsum");
    await user.selectOptions(screen.getByTestId("credit-license"), "cc0");
    await user.click(screen.getByTestId("credit-save"));

    await waitFor(() => expect(screen.queryByTestId("credit-modal")).not.toBeInTheDocument());
    await screen.findAllByText(/Robin Ipsum/);
    expect(screen.getAllByText("cc0").length).toBeGreaterThan(0);
    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      expect(loaded.species[0].photos[0].credit).toMatchObject({ observer: "Robin Ipsum", license: "cc0" });
    });
  });

  it("prompts for credit when an upload replaces a photo on a full card", async () => {
    const user = userEvent.setup();
    const { project, entry } = await makeFixture();
    const keys = ["a.jpg", "b.jpg", "c.jpg"];
    keys.forEach((key, i) =>
      entry.photos.push({
        id: `upload:${i}`,
        role: i === 0 ? "main" : "secondary",
        credit: { observer: "Old", license: "cc0" },
        fileKey: key,
      }),
    );
    await saveProject(project);
    const { putFile } = await import("~/lib/store");
    for (const key of keys) await putFile(project.id, key, new Blob(["x"]));

    renderSpecies(project.id, entry.id);
    const file = new File(["new-bytes"], "new.jpg", { type: "image/jpeg" });
    await user.upload(await uploadInput(), file);

    // Card is full → first pick which slot to replace…
    await screen.findByTestId("replace-picker");
    await user.click(screen.getByTestId("replace-slot-1"));

    // …then the credit prompt for the replacement.
    await screen.findByTestId("credit-modal");
    await user.type(screen.getByTestId("credit-observer"), "New Photographer");
    await user.selectOptions(screen.getByTestId("credit-license"), "cc-by-nc");
    await user.click(screen.getByTestId("credit-save"));

    await screen.findAllByText(/New Photographer/);
    await user.click(screen.getByTestId("save-species"));
    await waitFor(async () => {
      const loaded = (await getProject(project.id))!;
      const replaced = loaded.species[0].photos[1];
      expect(replaced.credit).toMatchObject({ observer: "New Photographer", license: "cc-by-nc" });
      // The untouched slots keep their original credits.
      expect(loaded.species[0].photos[0].credit.observer).toBe("Old");
      expect(loaded.species[0].photos[2].credit.observer).toBe("Old");
    });
  });
});