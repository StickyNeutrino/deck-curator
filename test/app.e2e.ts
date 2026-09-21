import { test, expect } from "@playwright/test";

/**
 * Happy path: create a deck, add species by typing names (iNat blocked),
 * open a species, export the archive. Verifies the core loop end-to-end
 * against the real dev server with the iNaturalist API stubbed.
 */

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

test("create → edit → export a deck", async ({ page }) => {
  await page.goto("/");

  // Home → create.
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByTestId("new-deck-name").fill("E2E Canyon");
  await page.getByTestId("new-deck-description").fill("E2E description");
  await page.getByTestId("create-deck").click();
  await page.waitForURL(/\/project\/e2e-canyon/);
  // Name/description editing lives on the Deck info tab.
  await page.getByTestId("tab-info").click();
  await page.waitForURL(/\/info/);
  await expect(page.getByTestId("deck-label")).toHaveValue("E2E Canyon");
  await expect(page.locator('[aria-label="Deck description"]')).toHaveValue("E2E description");
  await page.getByTestId("tab-cards").click();
  await page.waitForURL(/\/project\/e2e-canyon$/);

  // Add species via the list tab.
  await page.getByTestId("add-species").click();
  await page.getByTestId("name-list").fill("Quercus agrifolia\nDudleya edulis");
  await page.getByRole("checkbox", { name: /look up on inaturalist/i }).uncheck();
  await page.getByTestId("add-list").click();
  await expect(page.getByTestId("list-status")).toContainText(/Added 2 species/);
  await page.getByRole("button", { name: "Close" }).click();

  // Rows are visible.
  await expect(page.getByTestId("species-row")).toHaveCount(2);

  // Open the first species, set the invasive border, save.
  await page.getByRole("button", { name: /Quercus/ }).first().click();
  await page.waitForURL(/\/species\//);
  await page.getByTestId("border-invasive").click();
  await page.getByTestId("save-species").click();
  await expect(page.getByTestId("save-species")).toContainText("Save");

  // Export page: identity + validation, then download the zip.
  await page.goto(`/project/e2e-canyon/export`);
  await expect(page.getByTestId("validation-report")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-deck").click();
  expect((await download).suggestedFilename()).toMatch(/e2e-canyon.*\.zip$/);
  await expect(page.getByTestId("export-done")).toBeVisible();
});
test("review screen: flag cards, filter, and jump to edit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByTestId("new-deck-name").fill("Review Screen");
  await page.getByTestId("create-deck").click();
  await page.waitForURL(/\/project\/review-screen/);

  await page.getByTestId("add-species").click();
  await page.getByTestId("name-list").fill("Quercus agrifolia\nDudleya edulis");
  await page.getByRole("checkbox", { name: /look up on inaturalist/i }).uncheck();
  await page.getByTestId("add-list").click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("species-row")).toHaveCount(2);

  await page.getByTestId("tab-review").click();
  await page.waitForURL(/\/review/);
  await expect(page.getByTestId("review-grid")).toBeVisible();

  // Flag the first card, then filter down to flagged.
  const firstFlag = page.locator('[data-testid^="flag-"]').first();
  await firstFlag.click();
  await page.getByTestId("filter-flagged").click();
  await expect(page.locator('[data-testid^="review-card-"]')).toHaveCount(1);

  // Click the card to jump into its editor.
  await page.locator('[data-testid^="edit-card-"]').first().click();
  await page.waitForURL(/\/species\//);
  await expect(page.getByTestId("common-name")).toBeVisible();
});

test("location picker sets the deck location and the iNat scope", async ({ page }) => {
  // Stub Nominatim so the test needs no network.
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { display_name: "Mission Trails Regional Park, San Diego, California", lat: "32.8282", lon: "-117.0522" },
      ]),
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByTestId("new-deck-name").fill("Geo Deck");
  await page.getByTestId("create-deck").click();
  await page.waitForURL(/\/project\/geo-deck/);

  await page.getByTestId("tab-info").click();
  await page.waitForURL(/\/info/);
  await page.getByTestId("location-search").fill("Mission Trails");
  await page.getByTestId("location-results").getByRole("button").first().click();
  await expect(page.getByTestId("location-status")).toContainText("Mission Trails");

  // The deck's own location is exported into the manifest.
  await page.getByTestId("tab-export").click();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-deck").click();
  expect((await download).suggestedFilename()).toMatch(/geo-deck.*\.zip$/);
});

test("version history: auto-commits once per change and lists versions", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "New deck" }).click();
  await page.getByTestId("new-deck-name").fill("VC Check");
  await page.getByTestId("create-deck").click();
  await page.waitForURL(/\/project\/vc-check/);

  // The initial commit lands on open (ensureRepo), shortly after load.
  await page.goto("/project/vc-check/export");
  await page.waitForFunction(() => {
    const section = document.querySelector('[data-testid="version-history"]');
    return section && section.querySelectorAll("li").length >= 1;
  }, undefined, { timeout: 20000 });
  const initialCount = await page.evaluate(
    () => document.querySelectorAll('[data-testid="version-history"] li').length,
  );

  // One edit → exactly one more commit after the debounce settles (not a
  // commit per keystroke, and nothing extra while idle).
  await page.getByTestId("tab-cards").click();
  await page.getByTestId("add-species").click();
  await page.getByTestId("name-list").fill("Quercus agrifolia");
  await page.getByRole("checkbox", { name: /look up on inaturalist/i }).uncheck();
  await page.getByTestId("add-list").click();
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(15000);

  await page.goto("/project/vc-check/export");
  await page.waitForFunction((before: number) => {
    const section = document.querySelector('[data-testid="version-history"]');
    return section && section.querySelectorAll("li").length > before;
  }, initialCount, { timeout: 20000 });
  const afterEdit = await page.evaluate(
    () => document.querySelectorAll('[data-testid="version-history"] li').length,
  );
  // Exactly one commit for the change set.
  expect(afterEdit).toBe(initialCount + 1);

  // Idle beyond the debounce → no further commits.
  await page.waitForTimeout(13000);
  await page.goto("/project/vc-check/export");
  await page.waitForTimeout(2000);
  const afterIdle = await page.evaluate(
    () => document.querySelectorAll('[data-testid="version-history"] li').length,
  );
  expect(afterIdle).toBe(afterEdit);
});
