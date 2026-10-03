import { defineConfig } from "@playwright/test";

// E2E runs against the dev server by default (fast iteration). Set
// E2E_PROD=1 (after `npm run build`) to serve the built SPA instead — the
// production bundle is where bundler-dependent bugs actually show, e.g. the
// Leaflet marker icons whose URLs Leaflet detects at runtime. Prod uses its
// own port so it can't collide with a dev server already on 5173.
const prod = !!process.env.E2E_PROD;
const port = prod ? 4173 : 5173;

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: prod ? `npx serve ./build/client --single --listen ${port}` : "npm run dev",
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
