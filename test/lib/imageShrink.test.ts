import { describe, it, expect } from "vitest";
import { computeShrinkDimensions, shrinkPhotoBlob, SHRINK_PRESETS } from "~/lib/imageShrink";

// shrinkPhotoBlob's canvas path needs a real image codec, which the test
// environment (jsdom) doesn't have — there it must decline (null) so callers
// pass the original bytes through. The geometry it relies on is pure and
// tested directly below.

describe("shrink geometry", () => {
  it("caps the long edge and keeps the aspect ratio", () => {
    expect(computeShrinkDimensions(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
    expect(computeShrinkDimensions(1200, 2000, 1000)).toEqual({ width: 600, height: 1000 });
  });

  it("never upscales", () => {
    expect(computeShrinkDimensions(640, 480, 1600)).toEqual({ width: 640, height: 480 });
  });

  it("leaves images already at the cap alone", () => {
    expect(computeShrinkDimensions(400, 400, 400)).toEqual({ width: 400, height: 400 });
  });

  it("rounds without collapsing a dimension to zero", () => {
    expect(computeShrinkDimensions(3, 5, 2)).toEqual({ width: 1, height: 2 });
  });
});

describe("shrinkPhotoBlob", () => {
  it("declines what it can't decode — callers keep the original bytes", async () => {
    const blob = new Blob(["stub-jpeg-bytes"], { type: "image/jpeg" });
    expect(
      await shrinkPhotoBlob(blob, { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, maxEdge: 1024, quality: 0.7 }),
    ).toBeNull();
  });
});

describe("shrink presets", () => {
  it("are ordered by edge cap with sane quality values", () => {
    const edges = Object.values(SHRINK_PRESETS).map((p) => p.maxEdge);
    expect([...edges].sort((a, b) => a - b)).toEqual(edges);
    for (const preset of Object.values(SHRINK_PRESETS)) {
      expect(preset.quality).toBeGreaterThan(0.5);
      expect(preset.quality).toBeLessThanOrEqual(0.95);
    }
  });
});
