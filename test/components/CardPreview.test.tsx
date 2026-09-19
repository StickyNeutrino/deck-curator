import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CardFront, CardBack } from "~/components/CardPreview";
import { makeSpecies } from "~/lib/types";
import type { PhotoSlot } from "~/lib/types";

const fakeBlob = () => new Blob(["jpg"], { type: "image/jpeg" });

const mainSlot: PhotoSlot = {
  id: "inat:1",
  role: "main",
  fileKey: "main.jpg",
  credit: { observer: "joodles", license: "cc-by-nc" },
};
const secondarySlot: PhotoSlot = {
  id: "inat:2",
  role: "secondary",
  fileKey: "sec.jpg",
  credit: { observer: "leavenworth", license: "cc0" },
};

const resolve = vi.fn(async (key: string) => new Blob([key]));

describe("CardFront", () => {
  it("renders a trio with photo slots and credit lines", async () => {
    const species = makeSpecies({ photos: [mainSlot, secondarySlot, secondarySlot] });
    render(<CardFront species={species} resolve={resolve} />);
    await screen.findByTestId("card-front");
    expect(screen.getByTestId("card-front")).toHaveAttribute("data-layout", "photo-trio");
    // One credit line under each of the three photo slots.
    const credits = Array.from(document.querySelectorAll(".credit")).map((el) => el.textContent);
    expect(credits.filter(Boolean)).toHaveLength(3);
    expect(credits[0]).toContain("joodles");
  });

  it("renders a single-photo layout", async () => {
    const species = makeSpecies({ layout: "photo-single", photos: [mainSlot] });
    const { findByTestId } = render(<CardFront species={species} resolve={resolve} />);
    await findByTestId("card-front");
    expect(document.querySelectorAll(".slot")).toHaveLength(1);
  });
});

describe("CardBack", () => {
  it("shows the full text stack and invasive flag", () => {
    const species = makeSpecies({
      commonName: "Dwarf Nettle",
      sciName: "Urtica urens",
      altNames: ["Burning Nettle"],
      familyCommon: "Nettle Family",
      familyLatin: "Urticaceae",
      native: "non-native",
      invasive: true,
      rarity: "CNPS 2B.3",
    });
    render(<CardBack species={species} />);
    const back = screen.getByTestId("card-back");
    expect(back).toHaveAttribute("data-invasive", "true");
    expect(back.textContent).toContain("Dwarf Nettle");
    expect(back.textContent).toContain("aka Burning Nettle");
    expect(back.textContent).toContain("Urtica urens");
    expect(back.textContent).toContain("Nettle Family");
    expect(back.textContent).toContain("Urticaceae");
    expect(back.textContent).toContain("Non-native (Invasive)");
    expect(back.textContent).toContain("CNPS 2B.3");
  });

  it("omits the status line for unknown natives", () => {
    const species = makeSpecies({ commonName: "Mystery", native: "unknown", invasive: false });
    render(<CardBack species={species} />);
    expect(screen.getByTestId("card-back").textContent).not.toContain("Native");
  });
});