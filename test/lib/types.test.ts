import { describe, it, expect } from "vitest";
import { DEFAULT_SEARCH_SETTINGS, INAT_ALLOWED_LICENSES, searchSettingsOf, type InatSearchSettings } from "~/lib/types";

describe("default iNat search settings", () => {
  it("defaults to every valid iNat license and research-grade observations", () => {
    // All valid options on by default (ND variants and unlicensed photos are
    // never valid); narrowing to commercial-only is a per-deck choice.
    expect(DEFAULT_SEARCH_SETTINGS.licenses).toEqual([...INAT_ALLOWED_LICENSES]);
    // Community-confirmed identifications only.
    expect(DEFAULT_SEARCH_SETTINGS.researchGrade).toBe(true);
  });

  it("defaults photo order to most-voted first", () => {
    expect(DEFAULT_SEARCH_SETTINGS.orderBy).toBe("votes");
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