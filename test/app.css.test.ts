import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * jsdom unit tests assert behavior, not paint, so app.css is otherwise
 * untested. These pin the declarations that keep *native* form controls
 * (select popups, checkboxes, autofill) looking the same in every browser:
 * the deck dropdown was unreadable in Chrome while fine in Firefox, because
 * a dark color-scheme makes Chromium draw the option list dark with the
 * control's dark text on it.
 */

const css = readFileSync(join(process.cwd(), "app", "app.css"), "utf8");

describe("app.css native-control consistency", () => {
  it("pins a light color scheme so native widgets match the light palette in every browser", () => {
    // The palette is fixed light; a dark color-scheme must never come back.
    expect(css).toMatch(/html\s*{[^}]*color-scheme:\s*light/);
    expect(css).not.toContain("color-scheme: dark");
  });

  it("colors checkboxes and radios with the brand accent instead of each engine's default", () => {
    expect(css).toMatch(/accent-color:\s*var\(--accent\)/);
  });

  it("contains Leaflet's pane z-indexes so the map paints below app overlays", () => {
    // Leaflet's panes use z-index 100–1000 internally, and Leaflet's own JS
    // pins the map container to position:relative without a z-index — no
    // stacking context, so the pane values escaped the map and painted it on
    // top of the location dropdown (z-20), the jobs pill (z-40), and modals
    // (z-50). The container must establish a stacking context.
    expect(css).toMatch(/\.leaflet-container\s*{[^}]*z-index:\s*0[^}]*}/);
  });
});