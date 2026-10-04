import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      border: "invasive",
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
    const species = makeSpecies({ commonName: "Mystery", native: "unknown", border: "none" });
    render(<CardBack species={species} />);
    expect(screen.getByTestId("card-back").textContent).not.toContain("Native");
  });
});

describe("PhotoImage viewport gating", () => {
  // jsdom has no IntersectionObserver (so other tests here load at once —
  // the immediate fallback); these tests install a controllable stub.
  class IntersectionObserverStub {
    static instances: IntersectionObserverStub[] = [];
    callback: IntersectionObserverCallback;
    observed: Element[] = [];
    disconnected = false;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      IntersectionObserverStub.instances.push(this);
    }
    observe = (el: Element): void => {
      this.observed.push(el);
    };
    disconnect = (): void => {
      this.disconnected = true;
    };
    unobserve = (): void => undefined;
  }
  let globalScope = globalThis as unknown as { IntersectionObserver?: unknown };

  beforeEach(() => {
    IntersectionObserverStub.instances = [];
    globalScope.IntersectionObserver = IntersectionObserverStub as unknown as never;
  });

  afterEach(() => {
    delete globalScope.IntersectionObserver;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("falls back to loading at once where IntersectionObserver is unavailable", async () => {
    delete globalScope.IntersectionObserver;
    const resolve = vi.fn(async (key: string) => new Blob([key]));
    render(<CardFront species={makeSpecies({ photos: [mainSlot] })} resolve={resolve} />);
    await screen.findByTestId("card-front");
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("main.jpg"));
    await waitFor(() => expect(document.querySelector(".slot img")).toBeTruthy());
  });

  it("waits for the slot to approach the viewport before resolving", async () => {
    const resolve = vi.fn(async (key: string) => new Blob([key]));
    render(<CardFront species={makeSpecies({ photos: [mainSlot] })} resolve={resolve} />);
    await screen.findByTestId("card-front");

    // Not yet: the slot is below the fold and no intersection fired.
    await tick();
    expect(resolve).not.toHaveBeenCalled();
    expect(document.querySelector(".slot img")).toBeNull();
    // The placeholder (not the img) is what the observer watches.
    const observer = IntersectionObserverStub.instances[0];
    expect(observer.observed).toHaveLength(1);

    // Scroll it in: the resolver runs and the image appears.
    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("main.jpg"));
    await waitFor(() => expect(document.querySelector(".slot img")).toBeTruthy());
    expect(observer.disconnected).toBe(true);
  });

  it("keeps waiting when the intersection report says not visible", async () => {
    const resolve = vi.fn(async (key: string) => new Blob([key]));
    render(<CardFront species={makeSpecies({ photos: [mainSlot] })} resolve={resolve} />);
    await screen.findByTestId("card-front");
    IntersectionObserverStub.instances[0].callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      IntersectionObserverStub.instances[0] as unknown as IntersectionObserver,
    );
    await tick();
    expect(resolve).not.toHaveBeenCalled();
  });
});