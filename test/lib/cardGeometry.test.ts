import { describe, it, expect } from "vitest";
import { slotsFor, creditText } from "~/lib/cardGeometry";
import type { PhotoSlot } from "~/lib/types";

describe("slotsFor", () => {
  it("trio layout uses main + two secondaries", () => {
    const slots = slotsFor("photo-trio", 3);
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.rect.width)).toEqual([650, 276, 324]);
  });

  it("single layout uses only the main slot", () => {
    expect(slotsFor("photo-single", 3)).toHaveLength(1);
  });

  it("two photos = main + first secondary", () => {
    expect(slotsFor("photo-trio", 2)).toHaveLength(2);
  });

  it("one photo = main only", () => {
    expect(slotsFor("photo-trio", 1)).toHaveLength(1);
  });
});

describe("creditText", () => {
  const slot = (over: Partial<PhotoSlot>): PhotoSlot => ({
    id: "x",
    role: "main",
    fileKey: "f.jpg",
    credit: { observer: "joodles", license: "cc-by-nc" },
    ...over,
  });

  it("formats iNat-style credits", () => {
    expect(creditText(slot({}))).toBe("© joodles · CC BY-NC");
    expect(creditText(slot({ credit: { observer: "A", license: "cc0" } }))).toBe("© A · CC0");
    expect(creditText(slot({ credit: { observer: "A", license: "cc-by" } }))).toBe("© A · CC BY");
    expect(creditText(slot({ credit: { observer: "A", license: "" } }))).toBe("© A");
    // © alone already asserts all rights reserved.
    expect(creditText(slot({ credit: { observer: "A", license: "all-rights-reserved" } }))).toBe("© A");
  });
});
