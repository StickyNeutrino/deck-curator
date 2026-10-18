import { test, expect, type Page } from "@playwright/test";
import { unzipSync, zipSync, strToU8, type Unzipped } from "fflate";
import { readFile } from "node:fs/promises";

/**
 * Deck lifecycle end-to-end: saving (record autosave surviving a reload, and
 * named git versions), restoring (version history), exporting (all three
 * artifacts, inspected down to the zip bytes), and importing (archives back
 * into editable decks, junk rejection, id collisions, and the full
 * export → import round trip). The iNaturalist API is stubbed empty so no
 * test needs the network; import fixtures are built in-process with fflate.
 */

/** A fresh browser session has no curator identity, so the first deck
 *  creation asks who's curating (skippable) before the page is usable. */
async function skipAuthorshipPrompt(page: Page) {
  await page.getByTestId("author-skip").click();
}

/** Create a deck from the home page and return its id (the slug of name). */
async function createDeck(page: Page, name: string, description = ""): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByTestId("new-deck-name").fill(name);
  if (description) await page.getByTestId("new-deck-description").fill(description);
  await page.getByTestId("create-deck").click();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  await page.waitForURL(new RegExp(`/project/${id}$`));
  await skipAuthorshipPrompt(page);
  return id;
}

/** Add species by typing names (iNat lookup off — no enrichment). `total`
 *  counts the rows the deck should show afterwards; defaults to names.length
 *  and should be passed when adding to a deck that already has species. */
async function addSpeciesByList(page: Page, names: string[], total?: number) {
  await page.getByTestId("add-species").click();
  await page.getByRole("tab", { name: "Type or paste names" }).click();
  await page.getByTestId("name-list").fill(names.join("\n"));
  await page.getByRole("checkbox", { name: /look up on inaturalist/i }).uncheck();
  await page.getByTestId("add-list").click();
  await expect(page.getByTestId("list-status")).toContainText(`Added ${names.length} species`);
  await page.getByTestId("add-species-modal").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("species-row")).toHaveCount(total ?? names.length);
}

/** Upload one still photo through the species editor and credit it. */
async function uploadPhoto(page: Page, fileName: string, bytes: Uint8Array) {
  await page.getByTestId("photos-editor").locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "image/jpeg",
    buffer: Buffer.from(bytes),
  });
  await page.getByTestId("credit-observer").fill("e2e uploader");
  await page.getByTestId("credit-save").click();
  await expect(page.getByTestId("photo-main")).toHaveCount(1);
}

/** Open a species from the cards table by its visible name. */
async function openSpecies(page: Page, name: string) {
  await page.getByRole("button", { name }).first().click();
  await page.waitForURL(/\/species\//);
}

/** Jump to the export page and wait until the deck's first commit is listed. */
async function gotoExportPage(page: Page, projectId: string) {
  await page.goto(`/project/${projectId}/export`);
  await page.waitForFunction(
    () => {
      const section = document.querySelector('[data-testid="version-history"]');
      return section !== null && section.querySelectorAll("li").length >= 1;
    },
    undefined,
    { timeout: 20000 },
  );
}

async function openExportTab(page: Page, projectId: string) {
  await page.getByTestId("tab-export").click();
  await page.waitForURL(new RegExp(`/project/${projectId}/export$`));
}

async function openCardsTab(page: Page, projectId: string) {
  await page.getByTestId("tab-cards").click();
  await page.waitForURL(new RegExp(`/project/${projectId}$`));
}

/** Save a named version and wait for the commit to show up in the list. */
async function saveNamedVersion(page: Page, note: string) {
  await page.getByTestId("version-note").fill(note);
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("version-status")).toContainText("Version saved.");
  await expect(page.getByTestId("version-history")).toContainText(note);
}

/** Run one of the three exports and read the produced archive back in Node. */
async function exportAndUnzip(
  page: Page,
  buttonTestId: string,
  filename: RegExp,
): Promise<{ entries: Unzipped; file: string }> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId(buttonTestId).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(filename);
  const file = await download.path();
  const bytes = await readFile(file);
  await expect(page.getByTestId("export-done")).toBeVisible();
  return { entries: unzipSync(bytes), file };
}

function manifestOf(entries: Unzipped): any {
  return JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
}

const PHOTO_BYTES = strToU8("e2e-still-photo-bytes");

/** Input descriptor for a hand-built deck archive in the DECK_FORMAT.md
 *  shape — two cards (one with a cropped, credited photo), a location, and
 *  the metadata the import must map back onto an editable project. */
function deckArchiveInput(): { name: string; mimeType: string; buffer: Buffer } {
  const manifest = {
    id: "imported-canyon",
    label: "🌿 Imported Canyon",
    description: "Imported from a fixture archive",
    location: { name: "Mission Trails", lat: 32.8282, lng: -117.0522, radiusKm: 5 },
    cardFormat: "data",
    categories: [
      {
        id: "plants",
        label: "🌿 Plants",
        cards: [
          {
            name: "Coast Live Oak",
            commonName: "Coast Live Oak",
            layout: "photo-trio",
            photos: [
              {
                file: "photos/oak-main.jpg",
                role: "main",
                alt: "leaf close-up",
                crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
                credit: {
                  observer: "joodles",
                  license: "cc-by-nc",
                  observationUrl: "https://www.inaturalist.org/observations/1",
                  observationId: 1,
                  placeLabel: "San Diego County",
                },
              },
            ],
            sciName: "Quercus agrifolia",
            native: "native",
            border: "caution",
            rarity: "CNPS 1B.1",
            taxonId: 41173,
            tags: ["phase 1"],
          },
          {
            name: "Dudleya edulis",
            sciName: "Dudleya edulis",
            layout: "photo-trio",
            photos: [],
            native: "non-native",
          },
        ],
      },
    ],
  };
  return {
    name: "imported-canyon.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({
        "manifest.json": strToU8(JSON.stringify(manifest)),
        "photos/oak-main.jpg": PHOTO_BYTES,
      }),
    ),
  };
}

test.beforeEach(async ({ page }) => {
  // Stub the iNat API: taxa autocomplete + taxa search return empty; photo
  // requests fail. The curator must degrade gracefully.
  await page.route("**/api.inaturalist.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total_results: 0, results: [] }),
    }),
  );
});

test("edits save automatically and survive a reload", async ({ page }) => {
  const id = await createDeck(page, "Persist Deck", "Original description");
  await addSpeciesByList(page, ["Coast Live Oak", "Dudleya edulis"]);

  // Species edits save explicitly from the editor.
  await openSpecies(page, "Coast Live Oak");
  await page.getByTestId("border-invasive").click();
  await page.getByTestId("native-status").selectOption("non-native");
  await page.getByLabel(/Rarity/).fill("CNPS 1B.1");
  await page.getByTestId("tags-input").fill("phase 1");
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Saved");

  // Deck label and description save as you type on the info tab.
  await page.goto(`/project/${id}/info`);
  await page.getByTestId("deck-label").fill("Persist Deck Renamed");
  await page.getByLabel("Deck description").fill("Updated description");
  await page.waitForTimeout(500); // let the record autosave land before reloading

  await page.reload();
  await expect(page.getByTestId("deck-label")).toHaveValue("Persist Deck Renamed");
  await expect(page.getByLabel("Deck description")).toHaveValue("Updated description");

  // The species edits survived too.
  await openCardsTab(page, id);
  await expect(page.getByTestId("species-row")).toHaveCount(2);
  await expect(page.getByLabel("Border style of Coast Live Oak")).toHaveValue("invasive");

  // The deck list reflects the saved deck.
  await page.goto("/");
  await expect(
    page.getByTestId("project-link").filter({ hasText: "Persist Deck Renamed" }),
  ).toContainText("2 species");
});

test("version history: named saves, no-change save, and hiding autosaves", async ({ page }) => {
  const id = await createDeck(page, "Version Deck");
  await gotoExportPage(page, id);

  await saveNamedVersion(page, "before the big rename");

  // Saving again with nothing changed and no note is an honest no-op.
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("version-status")).toContainText(
    "No changes since the last version",
  );

  // One deck edit → one autosave commit. The pending autosave flushes when
  // the cards page is left, so it lands shortly after this navigation.
  await openCardsTab(page, id);
  await addSpeciesByList(page, ["Coast Live Oak"]);
  await openExportTab(page, id);
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByTestId("version-history")).toContainText(
      "Autosave — 1 species, 0 photos",
    );
  }).toPass({ timeout: 20000 });

  // Hiding autosaves filters the list; named versions and the deck's initial
  // commit stay visible.
  await page.getByTestId("hide-autosaves").check();
  await expect(page.getByTestId("autosaves-hidden")).toContainText("Hiding 1 autosave version");
  await expect(page.getByTestId("version-history").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("version-history")).toContainText("before the big rename");

  await page.getByTestId("hide-autosaves").uncheck();
  await expect(page.getByTestId("version-history")).toContainText("Autosave — 1 species, 0 photos");
});

test("restore an earlier version from the history", async ({ page }) => {
  const id = await createDeck(page, "Restore Deck");
  await gotoExportPage(page, id);

  // Two named checkpoints: one species, then two.
  await openCardsTab(page, id);
  await addSpeciesByList(page, ["Coast Live Oak"]);
  await openExportTab(page, id);
  await saveNamedVersion(page, "one species");

  await openCardsTab(page, id);
  await addSpeciesByList(page, ["Dudleya edulis"], 2);
  await openExportTab(page, id);
  await saveNamedVersion(page, "two species");

  // Restore the "one species" checkpoint. The flow asks for confirmation —
  // the dialog must be accepted, or the restore silently does nothing.
  const target = page.getByTestId("version-history").locator("li", { hasText: "one species" });
  await expect(target).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await target.locator('[data-testid^="restore-"]').click();
  await expect(page.getByTestId("version-status")).toContainText("Restored");

  // The pre-restore state was checkpointed and the restore itself landed as
  // a commit — nothing left the history.
  await expect(page.getByTestId("version-history")).toContainText("Before restoring");
  await expect(page.getByTestId("version-history")).toContainText("Restored version");
  await expect(page.getByTestId("version-history")).toContainText("two species");

  // The deck went back to a single species.
  await openCardsTab(page, id);
  await expect(page.getByTestId("species-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Coast Live Oak" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dudleya edulis" })).toHaveCount(0);
});

test("deck export ships the manifest and photos (no history)", async ({ page }) => {
  const id = await createDeck(page, "Archive Deck", "E2E archive description");
  await addSpeciesByList(page, ["Coast Live Oak", "Dudleya edulis"]);

  await openSpecies(page, "Coast Live Oak");
  await page.getByTestId("border-invasive").click();
  await page.getByTestId("native-status").selectOption("non-native");
  await page.getByLabel(/Rarity/).fill("CNPS 1B.1");
  await page.getByTestId("tags-input").fill("phase 1");
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Saved");

  // A photo on the second species: its bytes must ship inside the archive.
  await page.goto(`/project/${id}`);
  await openSpecies(page, "Dudleya edulis");
  await uploadPhoto(page, "dudleya-photo.jpg", PHOTO_BYTES);
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Saved");

  await gotoExportPage(page, id);
  const { entries } = await exportAndUnzip(page, "export-deck", new RegExp(`${id}\\.deck$`));
  const manifest = manifestOf(entries);

  expect(manifest.id).toBe(id);
  expect(manifest.label).toBe("Archive Deck");
  expect(manifest.description).toBe("E2E archive description");
  expect(manifest.cardFormat).toBe("data");
  expect(manifest.generator.tool).toBe("deck-curator");
  expect(manifest.categories).toHaveLength(1);
  expect(manifest.categories[0].id).toBe("plants");

  const [oak, dudleya] = manifest.categories[0].cards;
  expect(oak.name).toBe("Coast Live Oak");
  expect(oak.commonName).toBe("Coast Live Oak");
  expect(oak.invasive).toBe(true);
  expect(oak.native).toBe("non-native");
  expect(oak.rarity).toBe("CNPS 1B.1");
  expect(oak.tags).toEqual(["phase 1"]);

  expect(dudleya.name).toBe("Dudleya edulis");
  expect(dudleya.sciName).toBe("Dudleya edulis");
  expect(dudleya.photos).toHaveLength(1);
  expect(dudleya.photos[0].file).toMatch(/^photos\/dudleya-edulis-main-.+\.jpg$/);
  expect(dudleya.photos[0].credit.observer).toBe("e2e uploader");
  expect(dudleya.photos[0].credit.license).toBe("all-rights-reserved");

  // The photo's bytes are the ones that were uploaded.
  const photoKeys = Object.keys(entries).filter((k) => k.startsWith("photos/"));
  expect(photoKeys).toHaveLength(1);
  expect(entries[photoKeys[0]]).toEqual(PHOTO_BYTES);

  // The deck file is the playable artifact — no repository inside.
  expect(Object.keys(entries).some((k) => k.startsWith(".git/"))).toBe(false);
});

test("project export (.zip) carries the git history", async ({ page }) => {
  const id = await createDeck(page, "Backup Deck");
  await addSpeciesByList(page, ["Coast Live Oak"]);
  await gotoExportPage(page, id);

  const { entries } = await exportAndUnzip(page, "export-project", new RegExp(`${id}\\.zip$`));
  const manifest = manifestOf(entries);
  expect(manifest.id).toBe(id);
  expect(manifest.label).toBe("Backup Deck");
  // The backup doubles as a real git repository.
  expect(entries[".git/HEAD"]).toBeTruthy();
});

test("light deck exports manifest-only and refuses to re-import", async ({ page }) => {
  const id = await createDeck(page, "Lite Deck");
  await addSpeciesByList(page, ["Coast Live Oak"]);
  await gotoExportPage(page, id);

  const { entries, file } = await exportAndUnzip(
    page,
    "export-lite",
    new RegExp(`${id}\\.deck\\.lite$`),
  );
  // A light deck bundles nothing: just the manifest with remote references.
  expect(Object.keys(entries)).toEqual(["manifest.json"]);
  const manifest = manifestOf(entries);
  expect(manifest.format).toBe("lite");
  expect(manifest.categories[0].cards[0].name).toBe("Coast Live Oak");

  // Light decks can't come back — the importer points at the full artifact.
  await page.goto("/");
  await page.getByTestId("import-file").setInputFiles(file);
  await expect(page.getByTestId("import-error")).toContainText(/light deck/i);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("light deck export refuses decks with bundled photos", async ({ page }) => {
  const id = await createDeck(page, "Lite Refuse");
  await addSpeciesByList(page, ["Coast Live Oak"]);
  await openSpecies(page, "Coast Live Oak");
  await uploadPhoto(page, "oak-photo.jpg", PHOTO_BYTES);
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Saved");

  await gotoExportPage(page, id);
  await page.getByTestId("export-lite").click();
  await expect(page.getByTestId("export-page-error")).toContainText(/light deck/);
  await expect(page.getByTestId("export-done")).toHaveCount(0);
  // The failed run is visible in the Jobs dock, which the export opens.
  await expect(page.getByTestId("jobs-modal")).toBeVisible();
  await expect(
    page.getByTestId("jobs-modal").locator('[data-testid^="job-status-"]').first(),
  ).toContainText("Failed");
});

test("importing a deck archive lands it as an editable project", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("import-file").setInputFiles(deckArchiveInput());
  await page.waitForURL(/\/project\/imported-canyon$/);
  await expect(page.getByTestId("species-row")).toHaveCount(2);

  // Card fields map back to editable species.
  await openSpecies(page, "Coast Live Oak");
  await expect(page.getByTestId("border-caution")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("native-status")).toHaveValue("native");
  await expect(page.getByLabel(/Rarity/)).toHaveValue("CNPS 1B.1");
  await expect(page.getByTestId("tags-input")).toHaveValue("phase 1");
  await expect(page.getByTestId("photo-main")).toHaveCount(1);
  await expect(page.getByTestId("photo-thumb")).toBeVisible();
  await expect(page.getByRole("link", { name: /iNaturalist taxon 41173/ })).toBeVisible();

  // Deck metadata maps onto the info tab, location included.
  await page.goto(`/project/imported-canyon/info`);
  await expect(page.getByTestId("deck-label")).toHaveValue("🌿 Imported Canyon");
  await expect(page.getByLabel("Deck description")).toHaveValue("Imported from a fixture archive");
  await expect(page.getByTestId("location-status")).toContainText("Mission Trails");

  // The deck is listed on the home page.
  await page.goto("/");
  await expect(
    page.getByTestId("project-link").filter({ hasText: "Imported Canyon" }),
  ).toHaveCount(1);
});

test("import rejects files that aren't deck archives with clear errors", async ({ page }) => {
  await page.goto("/");

  // Not a zip at all.
  await page.getByTestId("import-file").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello, not a deck"),
  });
  await expect(page.getByTestId("import-error")).toContainText(/not a readable zip archive/i);
  expect(new URL(page.url()).pathname).toBe("/");

  // A zip, but no manifest.json at the root — not a deck archive.
  await page.getByTestId("import-file").setInputFiles({
    name: "junk.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zipSync({ "readme.txt": strToU8("not a deck") })),
  });
  await expect(page.getByTestId("import-error")).toContainText(/manifest\.json/);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("importing a deck whose id is taken uniquifies instead of clobbering", async ({ page }) => {
  const archive = deckArchiveInput();
  await page.goto("/");
  await page.getByTestId("import-file").setInputFiles(archive);
  await page.waitForURL(/\/project\/imported-canyon$/);
  await expect(page.getByTestId("species-row")).toHaveCount(2);

  // The same archive again: its id is taken, so the import lands beside it.
  await page.goto("/");
  await page.getByTestId("import-file").setInputFiles(archive);
  await page.waitForURL(/\/project\/imported-canyon-2$/);
  await expect(page.getByTestId("species-row")).toHaveCount(2);

  // Both decks are listed, and the first one kept its cards.
  await page.goto("/");
  await expect(page.locator('[data-testid="project-link"][href="/project/imported-canyon"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="project-link"][href="/project/imported-canyon-2"]')).toHaveCount(1);
  await page.locator('[data-testid="project-link"][href="/project/imported-canyon"]').click();
  await page.waitForURL(/\/project\/imported-canyon$/);
  await expect(page.getByTestId("species-row")).toHaveCount(2);
});

test("export → import round trip preserves species and photos", async ({ page }) => {
  const id = await createDeck(page, "Round Trip", "Round trip description");
  await addSpeciesByList(page, ["Coast Live Oak", "Dudleya edulis"]);

  await openSpecies(page, "Coast Live Oak");
  await page.getByTestId("border-invasive").click();
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Saved");

  await page.goto(`/project/${id}`);
  await openSpecies(page, "Dudleya edulis");
  await uploadPhoto(page, "dudleya-photo.jpg", PHOTO_BYTES);
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Saved");

  await gotoExportPage(page, id);
  const { file } = await exportAndUnzip(page, "export-deck", new RegExp(`${id}\\.deck$`));

  // Import the very file that was just downloaded: the id is taken (the
  // original deck still exists), so the copy lands under a uniquified id.
  await page.goto("/");
  await page.getByTestId("import-file").setInputFiles(file);
  await page.waitForURL(/\/project\/round-trip-2$/);
  await expect(page.getByTestId("species-row")).toHaveCount(2);

  await openSpecies(page, "Coast Live Oak");
  await expect(page.getByTestId("border-invasive")).toHaveAttribute("aria-checked", "true");

  await page.goto(`/project/round-trip-2`);
  await openSpecies(page, "Dudleya edulis");
  await expect(page.getByTestId("photo-main")).toHaveCount(1);
  await expect(page.getByTestId("photo-thumb")).toBeVisible();
});