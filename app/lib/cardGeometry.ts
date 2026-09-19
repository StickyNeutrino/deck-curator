import type { CardLayout, PhotoSlot } from "./types";

/**
 * Card preview geometry — a faithful HTML port of the Healthy Canyons card
 * renderer (750×1050 canvas, photo slots and credit lines at the same
 * coordinates), so what a curator previews is what the flashcard app renders
 * from the exported manifest. docs/DECK_FORMAT.md is the contract.
 */

export const CARD_W = 750;
export const CARD_H = 1050;

const MAIN = { left: 50, top: 48, width: 650, height: 604 };
const SECONDARY_LEFT = { left: 50, top: 702, width: 276, height: 295 };
const SECONDARY_RIGHT = { left: 375, top: 702, width: 324, height: 295 };

/** Slots used for a given layout + photo count (matches the renderer). */
export function slotsFor(layout: CardLayout, photoCount: number): Array<{ rect: Rect; index: number }> {
  const useTrio = layout === "photo-trio";
  const secondaryCount = useTrio ? Math.max(0, photoCount - 1) : 0;
  const out = [{ rect: MAIN, index: 0 }];
  if (secondaryCount >= 1) out.push({ rect: SECONDARY_RIGHT, index: 1 });
  if (secondaryCount >= 2) out.push({ rect: SECONDARY_LEFT, index: 2 });
  // Keep left-to-right visual order for the two secondaries.
  if (secondaryCount >= 2) {
    out[1] = { rect: SECONDARY_LEFT, index: 1 };
    out[2] = { rect: SECONDARY_RIGHT, index: 2 };
  }
  return out;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function creditText(slot: PhotoSlot): string {
  const license = slot.credit.license;
  const display = !license || license === "all-rights-reserved"
    ? "" // © alone already asserts all rights reserved
    : license.toLowerCase() === "cc0"
      ? "CC0"
      : license.replace(/^cc-/, "CC ").toUpperCase();
  return `© ${slot.credit.observer}${display ? ` · ${display}` : ""}`;
}

/** Percent-based style so the preview scales to any width. */
export function rectStyle(rect: Rect): React.CSSProperties {
  return {
    left: `${(rect.left / CARD_W) * 100}%`,
    top: `${(rect.top / CARD_H) * 100}%`,
    width: `${(rect.width / CARD_W) * 100}%`,
    height: `${(rect.height / CARD_H) * 100}%`,
  };
}
