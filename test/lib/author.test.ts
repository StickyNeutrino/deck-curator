import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_AUTHOR,
  getAuthor,
  saveAuthor,
  storedAuthor,
  authorPromptPending,
  markAuthorAsked,
  requestAuthorPrompt,
  consumeAuthorPromptRequest,
} from "~/lib/author";

describe("curator authorship", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("falls back to the default author when nothing is stored", () => {
    expect(storedAuthor()).toBeNull();
    expect(getAuthor()).toEqual(DEFAULT_AUTHOR);
    expect(getAuthor()).toEqual({ name: "Deck Curator", email: "curator@localhost" });
  });

  it("round-trips a saved identity", () => {
    saveAuthor({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(storedAuthor()).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(getAuthor()).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("trims input and fills blank fields from the default", () => {
    expect(saveAuthor({ name: "  Ada  ", email: "   " })).toEqual({
      name: "Ada",
      email: DEFAULT_AUTHOR.email,
    });
    expect(getAuthor().email).toBe(DEFAULT_AUTHOR.email);
  });

  it("treats a blank stored record as no identity", () => {
    window.localStorage.setItem("deck-curator.author.v1", JSON.stringify({ name: "  ", email: "" }));
    expect(storedAuthor()).toBeNull();
    window.localStorage.setItem("deck-curator.author.v1", "not json");
    expect(storedAuthor()).toBeNull();
  });

  it("asks again next session after a skip; a saved identity silences it for good", () => {
    expect(authorPromptPending()).toBe(true);
    markAuthorAsked();
    expect(authorPromptPending()).toBe(false);

    // A skip only lasts the current browser session — the next visit asks
    // again until an identity is actually saved.
    window.sessionStorage.clear();
    expect(authorPromptPending()).toBe(true);

    saveAuthor({ name: "Ada", email: "ada@example.com" });
    expect(authorPromptPending()).toBe(false);
    window.sessionStorage.clear();
    expect(authorPromptPending()).toBe(false);
  });

  it("delivers the deck-creation prompt request exactly once", () => {
    expect(consumeAuthorPromptRequest()).toBe(false);
    requestAuthorPrompt();
    expect(consumeAuthorPromptRequest()).toBe(true);
    // One-shot: a second deck opening in the same session gets nothing.
    expect(consumeAuthorPromptRequest()).toBe(false);
  });
});
