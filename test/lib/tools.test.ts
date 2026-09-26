import { describe, it, expect } from "vitest";
import { establishmentToNative, conservationLabel, isThreatened } from "~/lib/tools";
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
