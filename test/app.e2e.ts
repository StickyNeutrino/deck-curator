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
  await expect(page.getByTestId("deck-label")).toHaveValue("E2E Canyon");

  // Add species via the list tab.
  await page.getByTestId("add-species").click();
  await page.getByTestId("name-list").fill("Quercus agrifolia\nDudleya edulis");
  await page.getByRole("checkbox", { name: /look up on inaturalist/i }).uncheck();
  await page.getByTestId("add-list").click();
  await expect(page.getByTestId("list-status")).toContainText(/Added 2 species/);
  await page.getByRole("button", { name: "Close" }).click();

  // Rows are visible; the description captured at creation shows on the header.
  await expect(page.getByTestId("species-row")).toHaveCount(2);
  await expect(page.locator('[aria-label="Deck description"]')).toHaveValue("E2E description");

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