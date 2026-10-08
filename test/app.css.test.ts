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
});