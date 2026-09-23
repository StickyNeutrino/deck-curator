import { describe, it, expect } from "vitest";
import { DEFAULT_SEARCH_SETTINGS, searchSettingsOf, type InatSearchSettings } from "~/lib/types";

describe("default iNat search settings", () => {
  it("defaults to commercially distributable photos and research-grade observations", () => {
    // NC licenses would keep the finished deck from being sold.
    expect(DEFAULT_SEARCH_SETTINGS.licenses).toEqual(["cc0", "cc-by", "cc-by-sa"]);
    expect(DEFAULT_SEARCH_SETTINGS.licenses.some((c) => c.includes("nc"))).toBe(false);
    // Community-confirmed identifications only.
    expect(DEFAULT_SEARCH_SETTINGS.researchGrade).toBe(true);
  });

  it("searchSettingsOf fills older/partial projects with the defaults", () => {
    expect(searchSettingsOf({ inatSearch: undefined })).toEqual(DEFAULT_SEARCH_SETTINGS);
    // Saved settings win over defaults — explicit curator choices survive.
    const saved: InatSearchSettings = {
      licenses: ["cc-by-nc"],
      researchGrade: false,
      includeMedia: true,
      orderBy: "votes",
    };
    expect(searchSettingsOf({ inatSearch: { ...saved } })).toEqual(saved);
  });
});