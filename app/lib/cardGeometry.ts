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

/** object-position for a photo's legacy focal point (default: centered). */
export function focusStyle(focus?: { x: number; y: number }): React.CSSProperties {
  if (!focus) return {};
  const x = Math.min(1, Math.max(0, focus.x)) * 100;
  const y = Math.min(1, Math.max(0, focus.y)) * 100;
  return { objectPosition: `${x}% ${y}%` };
}

/**
 * Style that maps a crop window (normalized 0..1 source rect) exactly onto a
 * slot: the img is sized so the crop region fills the slot, and the slot's
 * overflow:hidden clips everything outside. Use `objectFit: "fill"` — the
 * editor lets the user pick the bounds freely, so mild distortion is their
 * call (the preview shows exactly what ships).
 */
export function cropStyle(crop: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return {
    position: "absolute",
    width: `${100 / crop.w}%`,
    height: `${100 / crop.h}%`,
    left: `${(-crop.x / crop.w) * 100}%`,
    top: `${(-crop.y / crop.h) * 100}%`,
    objectFit: "fill",
    // Unclamped: the crop window must never be shrunk back to slot size.
    maxWidth: "none",
    maxHeight: "none",
  };
}

/** The implicit centered cover-crop for an image in a slot of the given
 *  aspect (w/h) — the editor starts here when no explicit crop exists. */
export function defaultCoverCrop(imageAspect: number, slotAspect: number): { x: number; y: number; w: number; h: number } {
  if (imageAspect > slotAspect) {
    const w = slotAspect / imageAspect;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = imageAspect / slotAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** Clamp a crop back inside the image after editing. */
export function clampCrop(crop: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const w = Math.min(1, Math.max(0.05, crop.w));
  const h = Math.min(1, Math.max(0.05, crop.h));
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, crop.x)),
    y: Math.min(1 - h, Math.max(0, crop.y)),
  };
}

/** Move a photo within the slot list; index 0 is the main photo. Pure. */
export function reorderPhotos<T>(photos: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= photos.length || to >= photos.length) {
    return photos;
  }
  const next = [...photos];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Max photos a card can hold for its layout (mirrors the renderer's slots). */
export function photoCap(layout: "photo-trio" | "photo-single"): number {
  return layout === "photo-single" ? 1 : 3;
}
