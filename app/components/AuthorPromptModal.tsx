import { useEffect, useState } from "react";
import { DEFAULT_AUTHOR, saveAuthor, storedAuthor } from "~/lib/author";

/**
 * Ask the curator who to stamp onto version commits — a git-style name and
 * email pair kept per browser (like git config). Answering is optional: the
 * fields start from the saved identity or the default, blank fields fall
 * back to the default on save, and skipping changes nothing.
 */
export function AuthorPromptModal({
  heading = "Who's making these changes?",
  blurb = "Every saved version is stamped with this name and email. Using a real identity — your GitHub name and email, for instance — keeps the version history correlatable with your account later.",
  skippable = true,
  onClose,
}: {
  heading?: string;
  blurb?: string;
  skippable?: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => storedAuthor()?.name ?? DEFAULT_AUTHOR.name);
  const [email, setEmail] = useState(() => storedAuthor()?.email ?? DEFAULT_AUTHOR.email);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    saveAuthor({ name, email });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      data-testid="author-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 mt-24" role="dialog" aria-label="Version authorship">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">{heading}</h2>
          <button className="btn-secondary" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
          {blurb}
        </p>
        <label className="block mb-3 text-sm">
          <span className="label">Name</span>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Author name"
            data-testid="author-name"
            placeholder={DEFAULT_AUTHOR.name}
          />
        </label>
        <label className="block mb-2 text-sm">
          <span className="label">Email</span>
          <input
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Author email"
            data-testid="author-email"
            placeholder={DEFAULT_AUTHOR.email}
          />
        </label>
        <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
          Optional — left blank (or skipped), versions keep the default author.
        </p>
        <div className="flex gap-2 justify-end">
          {skippable && (
            <button className="btn-secondary" onClick={onClose} data-testid="author-skip">
              Not now
            </button>
          )}
          <button className="btn-primary" onClick={save} data-testid="author-save">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
