import { describe, it, expect } from "vitest";
import { establishmentToNative, conservationLabel, isThreatened, toolResultMerger } from "~/lib/tools";
import { makeSpecies } from "~/lib/types";
import { newProject } from "~/lib/importSpreadsheet";
import type { Project, SpeciesEntry } from "~/lib/types";
import type { InatEstablishment, InatConservationStatus } from "~/lib/inat";

describe("establishmentToNative", () => {
  it("maps iNat establishment means to the deck's native status", () => {
    expect(establishmentToNative({ establishment_means: "native" })).toBe("native");
    expect(establishmentToNative({ establishment_means: "endemic" })).toBe("native");
    expect(establishmentToNative({ establishment_means: "introduced" })).toBe("non-native");
  });

  it("returns null for unlabeled taxa and unknown means", () => {
    expect(establishmentToNative(null)).toBeNull();
    expect(establishmentToNative(undefined)).toBeNull();
    expect(establishmentToNative({ establishment_means: "assumed_present" })).toBeNull();
  });
});

describe("conservationLabel", () => {
  it("uses the IUCN-equivalent wording for rated statuses", () => {
    const cs: InatConservationStatus = { status: "N2N3N", authority: "NatureServe", iucn: 30 };
    expect(conservationLabel(cs)).toBe("vulnerable — NatureServe (N2N3N)");
  });

  it("falls back to the raw status code when not IUCN-rated", () => {
    const cs: InatConservationStatus = { status: "S2S3", authority: "NatureServe", iucn: 0 };
    expect(conservationLabel(cs)).toBe("S2S3 (NatureServe)");
    expect(conservationLabel({ status: "EX", iucn: 5 })).toBe("EX");
  });

  it("handles the endangered and extinct bands", () => {
    expect(conservationLabel({ status: "S1", iucn: 40, authority: "NatureServe" })).toContain("endangered —");
    expect(conservationLabel({ status: "S1", iucn: 70, authority: "NatureServe" })).toContain("extinct —");
  });

  it("returns null without a status", () => {
    expect(conservationLabel(null)).toBeNull();
    expect(conservationLabel({ status: "" })).toBeNull();
  });
});

describe("isThreatened", () => {
  it("is true from near threatened (iucn ≥ 20) upward", () => {
    expect(isThreatened({ status: "X", iucn: 20 })).toBe(true);
    expect(isThreatened({ status: "X", iucn: 50 })).toBe(true);
  });

  it("is false for secure or unrated statuses", () => {
    expect(isThreatened({ status: "X", iucn: 10 })).toBe(false);
    expect(isThreatened({ status: "X", iucn: 0 })).toBe(false);
    expect(isThreatened(null)).toBe(false);
  });
});

describe("establishment place payload", () => {
  it("carries the place so reports can cite their source", () => {
    const em: InatEstablishment = {
      establishment_means: "introduced",
      place: { id: 829, name: "San Diego", display_name: "San Diego, CA, US" },
    };
    expect(establishmentToNative(em)).toBe("non-native");
    expect(em.place?.display_name).toContain("San Diego");
  });
});

describe("toolResultMerger", () => {
  const makeProject = (species: SpeciesEntry[]): Project => {
    const p = newProject("Merger Fixture");
    p.species = species;
    return p;
  };

  it("applies only the fields the tool changed, keeping concurrent edits", () => {
    const snapshot = makeProject([makeSpecies({ id: "a", commonName: "Oak", native: "unknown" })]);
    const draft = makeProject([makeSpecies({ id: "a", commonName: "Live Oak", native: "unknown" })]);
    const result = makeProject([makeSpecies({ id: "a", commonName: "Oak", native: "native" })]);

    toolResultMerger(snapshot, result)(draft);

    // The tool's native label landed…
    expect(draft.species[0].native).toBe("native");
    // …but the curator's mid-run rename survived.
    expect(draft.species[0].commonName).toBe("Live Oak");
  });

  it("keeps species added and removed during the run", () => {
    const kept = makeSpecies({ id: "a", commonName: "Oak" });
    const snapshot = makeProject([kept]);
    const added = makeSpecies({ id: "new", commonName: "New Guy" });
    const draft = makeProject([kept, added]); // added mid-run
    const result = makeProject([makeSpecies({ id: "a", commonName: "Oak", native: "native" })]);
    toolResultMerger(snapshot, result)(draft);

    expect(draft.species.map((s) => s.id)).toEqual(["a", "new"]);
    expect(draft.species[0].native).toBe("native");
  });

  it("replaces categories only when the tool changed them", () => {
    const entry = makeSpecies({ id: "a", commonName: "Oak", category: "plants" });
    const snapshot = makeProject([entry]);
    const draft = makeProject([entry]);
    toolResultMerger(snapshot, makeProject([entry]))(draft);
    expect(draft.categories).toEqual(snapshot.categories);

    const resorted = makeProject([entry]);
    resorted.categories = [{ id: "trees", label: "Trees" }];
    toolResultMerger(snapshot, resorted)(draft);
    expect(draft.categories).toEqual([{ id: "trees", label: "Trees" }]);
  });
});
