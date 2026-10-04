/**
 * Curator identity for version authorship.
 *
 * Every commit in a deck's git history is stamped with a name/email pair.
 * The identity is optional and global — one per browser, like git config —
 * and a neutral default fills in whenever nothing was set, so commits always
 * carry an author. Encouraging a real name/email (e.g. the GitHub ones)
 * keeps versions correlatable with accounts later.
 */

export interface Author {
  name: string;
  email: string;
}

export const DEFAULT_AUTHOR: Author = { name: "Deck Curator", email: "curator@localhost" };

const AUTHOR_KEY = "deck-curator.author.v1";
const ASKED_KEY = "deck-curator.author.asked.v1";

function readStored(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupt or unavailable storage — fall back to defaults
  }
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The saved identity, or null when none was stored (blank or unreadable
 *  records count as none — the default fills in either way). */
export function storedAuthor(): Author | null {
  const record = readStored(AUTHOR_KEY) as Partial<Author> | null;
  const name = cleanText(record?.name);
  const email = cleanText(record?.email);
  if (!name && !email) return null;
  return { name: name || DEFAULT_AUTHOR.name, email: email || DEFAULT_AUTHOR.email };
}

/** The author stamped onto commits: the saved identity or the default. */
export function getAuthor(): Author {
  return storedAuthor() ?? DEFAULT_AUTHOR;
}

/** Persist the identity (trimmed); blank fields fall back to the default's.
 *  Returns the effective author now in force. */
export function saveAuthor(input: { name?: string; email?: string }): Author {
  const author = {
    name: cleanText(input.name) || DEFAULT_AUTHOR.name,
    email: cleanText(input.email) || DEFAULT_AUTHOR.email,
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(AUTHOR_KEY, JSON.stringify(author));
    } catch {
      // Storage unavailable (private mode, quota) — the default still applies.
    }
  }
  return author;
}

/** Whether the first-autosave prompt is still due: whenever no identity is
 *  on file and it hasn't been answered this session. A skip is remembered
 *  only for the current browser session (sessionStorage) — the next visit
 *  asks again, so saving an identity is the only way to silence it for
 *  good. */
export function authorPromptPending(): boolean {
  if (typeof window === "undefined") return false;
  if (storedAuthor()) return false;
  try {
    return window.sessionStorage.getItem(ASKED_KEY) !== "1";
  } catch {
    return false; // can't persist the answer either — don't nag
  }
}

/** Record that the prompt was answered (or skipped) — quiet for the rest of
 *  this session; a skipped ask returns on the next visit. */
export function markAuthorAsked(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ASKED_KEY, "1");
  } catch {
    // Unavailable storage only means the prompt may reappear — harmless.
  }
}

// ---------- deck-creation prompt signal ----------
// The home page arms this when a deck is created, so the project page can
// ask who's curating immediately — before any editing happens. In-memory
// module state is exactly right: it must survive the client-side navigation
// to the project page, and nothing else.

let creationPromptArmed = false;

export function requestAuthorPrompt(): void {
  creationPromptArmed = true;
}

/** One-shot: true only for the first check after requestAuthorPrompt(). */
export function consumeAuthorPromptRequest(): boolean {
  if (!creationPromptArmed) return false;
  creationPromptArmed = false;
  return true;
}
