import { describe, it, expect } from "vitest";
import { makeId, uniqueId, slugify, sanitizeFileName } from "~/lib/ids";

describe("makeId", () => {
  it("slugifies labels into lowercase ids", () => {
    expect(makeId("Mission Trails Plants")).toBe("mission-trails-plants");
  });

  it("falls back to a time-based id for unsluggable labels", () => {
    expect(makeId("???")).toMatch(/^deck-/);
  });
});

describe("uniqueId", () => {
  it("returns the base when it is free", () => {
    expect(uniqueId("oak", ["elm", "fir"])).toBe("oak");
  });

  it("appends -2, -3… when the base and its suffixes are taken", () => {
    expect(uniqueId("oak", ["oak"])).toBe("oak-2");
    expect(uniqueId("oak", ["oak", "oak-2"])).toBe("oak-3");
  });

  it("treats an empty taken list as free", () => {
    expect(uniqueId("oak", [])).toBe("oak");
  });
});

describe("slugify / sanitizeFileName", () => {
  it("slugifies to filename-safe lowercase dashes", () => {
    expect(slugify("Dudleya edulis!")).toBe("dudleya-edulis");
  });

  it("strips zip-path separators from export names", () => {
    expect(sanitizeFileName("a/b:c")).toBe("a-b-c");
  });
});
