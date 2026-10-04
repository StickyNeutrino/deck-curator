import type { PhotoSlot } from "./types";

/**
 * Export-time photo compression (the "Compress photos" export option): decode a
 * stored still with the browser's own image codec, bake the slot's crop
 * window into the pixels, cap the long edge, and re-encode as JPEG. Pure
 * browser capability — canvas, no server, no wasm — guarded so a failed or
 * unhelpful attempt never makes the archive bigger.
 */

export type CropWindow = NonNullable<PhotoSlot["crop"]>;

export interface ShrinkSettings {
  /** Cap on the image's long edge, in pixels (never upscales). */
  maxEdge: number;
  /** JPEG quality, 0..1. */
  quality: number;
}

/** The export page's presets: study-card sizes, lean → generous. */
export const SHRINK_PRESETS = {
  small: { maxEdge: 1024, quality: 0.72 },
  medium: { maxEdge: 1600, quality: 0.8 },
  large: { maxEdge: 2400, quality: 0.85 },
} satisfies Record<string, ShrinkSettings>;

export type ShrinkPreset = keyof typeof SHRINK_PRESETS;

/** Target size for a source region under the long-edge cap. Never upscales.
 *  Pure so the geometry is unit-testable without a canvas. */
export function computeShrinkDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > maxEdge)) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Decode → crop → cap → re-encode. The crop window (normalized 0..1) is
 *  baked into the pixels, so the result renders as the whole image and the
 *  manifest can carry an identity crop instead (see export.ts).
 *
 *  Returns null — meaning "ship the original bytes, keep the manifest as-is"
 *  — when the blob isn't a decodable still, the canvas can't encode, or the
 *  attempt didn't actually shrink the file. */
export async function shrinkPhotoBlob(
  blob: Blob,
  opts: { crop?: CropWindow } & ShrinkSettings,
): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null; // Not a decodable still (stub bytes, exotic format) — pass through.
  }
  try {
    // Source region in pixels: the crop window, clamped inside the bitmap.
    // Without a crop the full image is the region (downscale-only path).
    const x = Math.min(bitmap.width, Math.max(0, Math.round((opts.crop?.x ?? 0) * bitmap.width)));
    const y = Math.min(bitmap.height, Math.max(0, Math.round((opts.crop?.y ?? 0) * bitmap.height)));
    const right = Math.min(
      bitmap.width,
      Math.max(x, Math.round(((opts.crop?.x ?? 0) + (opts.crop?.w ?? 1)) * bitmap.width)),
    );
    const bottom = Math.min(
      bitmap.height,
      Math.max(y, Math.round(((opts.crop?.y ?? 0) + (opts.crop?.h ?? 1)) * bitmap.height)),
    );
    const srcW = Math.max(1, right - x);
    const srcH = Math.max(1, bottom - y);
    const { width, height } = computeShrinkDimensions(srcW, srcH, opts.maxEdge);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // JPEG has no alpha: fill first so a transparent PNG lands on white
    // instead of black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, x, y, srcW, srcH, 0, 0, width, height);
    const out = await canvasToJpeg(canvas, opts.quality);
    // Only trade bytes for quality when there are bytes to save.
    if (!out || out.size >= blob.size) return null;
    return out;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b && b.type === "image/jpeg" ? b : null), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}
