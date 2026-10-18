import { describe, it, expect } from "vitest";
import {
  DEFAULT_COPYRIGHT,
  DEFAULT_SEARCH_SETTINGS,
  INAT_ALLOWED_LICENSES,
  copyrightOf,
  migrateProject,
  searchScopeOf,
  searchSettingsOf,
  type InatSearchSettings,
  type Project,
} from "~/lib/types";

describe("default iNat search settings", () => {
  it("follows the deck's accepted licenses and research-grade observations", () => {
    // The search starts inside the deck's copyright limits; narrowing those
    // to commercial-only is a per-deck choice on the Deck info tab.
    expect(DEFAULT_SEARCH_SETTINGS.useDeckLicenses).toBe(true);
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
      useDeckLicenses: false,
      researchGrade: false,
      includeMedia: true,
      orderBy: "votes",
    };
    expect(searchSettingsOf({ inatSearch: { ...saved } })).toEqual(saved);
  });
});

describe("deck copyright settings", () => {
  it("defaults to every valid iNat license", () => {
    // All valid options on by default (ND variants and unlicensed photos are
    // never valid); narrowing to commercial-only is a per-deck choice.
    expect(DEFAULT_COPYRIGHT.licenses).toEqual([...INAT_ALLOWED_LICENSES]);
    expect(copyrightOf({ licenses: undefined })).toEqual(DEFAULT_COPYRIGHT);
  });

  it("copyrightOf keeps the deck's explicit choice", () => {
    expect(copyrightOf({ licenses: ["cc0"] }).licenses).toEqual(["cc0"]);
  });
});

describe("searchScopeOf", () => {
  it("uses the deck's accepted licenses while useDeckLicenses is on", () => {
    const scope = searchScopeOf({ licenses: ["cc0", "cc-by"], inatSearch: undefined });
    expect(scope.licenses).toEqual(["cc0", "cc-by"]);
    expect(scope.researchGrade).toBe(true);
  });

  it("offers every iNat license when the search leaves the deck's limits", () => {
    const scope = searchScopeOf({
      licenses: ["cc0", "cc-by"],
      inatSearch: { useDeckLicenses: false, researchGrade: true, includeMedia: false, orderBy: "votes" },
    });
    expect(scope.licenses).toEqual([...INAT_ALLOWED_LICENSES]);
    // The deck's limits themselves are untouched by browsing wider.
    expect(scope.useDeckLicenses).toBe(false);
  });
});

describe("migrateProject", () => {
  it("moves the legacy inatSearch.licenses list into the copyright setting", () => {
    const project = {
      schemaVersion: 1,
      id: "legacy",
      name: "legacy",
      deckLabel: "legacy",
      description: "",
      categories: [],
      species: [],
      licenses: undefined,
      inatSearch: {
        useDeckLicenses: true,
        researchGrade: true,
        includeMedia: false,
        orderBy: "votes",
        // The old field, as an older record would carry it.
        licenses: ["cc0", "cc-by"],
      },
    } as unknown as Project;
    const migrated = migrateProject(project);
    expect(migrated.licenses).toEqual(["cc0", "cc-by"]);
    expect((migrated.inatSearch as { licenses?: unknown }).licenses).toBeUndefined();
    // The search settings themselves stay.
    expect(migrated.inatSearch?.researchGrade).toBe(true);
  });

  it("never overwrites an existing copyright list with the legacy one", () => {
    const project = {
      schemaVersion: 1,
      id: "legacy",
      name: "legacy",
      deckLabel: "legacy",
      description: "",
      categories: [],
      species: [],
      licenses: ["cc0"],
      inatSearch: {
        useDeckLicenses: true,
        researchGrade: true,
        includeMedia: false,
        orderBy: "votes",
        licenses: ["cc-by-nc"],
      },
    } as unknown as Project;
    expect(migrateProject(project).licenses).toEqual(["cc0"]);
  });
});
