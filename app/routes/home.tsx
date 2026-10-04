import type { Route } from "./+types/home";
import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { listProjects, saveProject, type ProjectSummary } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { uniqueId } from "~/lib/ids";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Deck Curator" },
    { name: "description", content: "Build and curate species flashcard decks" },
  ];
}

export default function Home() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => {
        // Distinguish "no decks" from "can't read the store" — the latter
        // must not claim the decks are gone.
        setProjects(null);
        setListError(`Couldn't load your decks: ${err instanceof Error ? err.message : err}`);
      });
  }, []);

  const createProject = useCallback(async () => {
    const label = name.trim() || "Untitled deck";
    const project = newProject(label);
    project.description = description.trim();
    try {
      // The id is the store key: a reused deck name must uniquify instead of
      // overwriting an existing deck.
      project.id = uniqueId(project.id, (await listProjects()).map((p) => p.id));
      await saveProject(project);
      navigate(`/project/${project.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  }, [name, description, navigate]);

  const importArchive = useCallback(async (file: File) => {
    setImporting(true);
    setImportError(null);
    try {
      const { importDeckArchive } = await import("~/lib/importDeck");
      // Importing an archive whose id matches an existing deck must not
      // overwrite it — the importer uniquifies when told what's taken.
      const existingIds = (await listProjects()).map((p) => p.id);
      const project = await importDeckArchive(file, { existingIds });
      await saveProject(project);
      navigate(`/project/${project.id}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [navigate]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <img src="/icon.svg" alt="" width={40} height={40} />
          <h1 className="text-2xl font-bold">Deck Curator</h1>
        </div>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Build species flashcard decks — from a spreadsheet, an iNaturalist search, or a typed
          list — and export them for the{" "}
          <a
            href="https://cards.unimpossy.com"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Flashcards app
          </a>
          . Everything stays in your browser.
        </p>
      </header>

      <section className="mb-10 rounded-lg border p-5 bg-white" style={{ borderColor: "var(--border)" }}>
        <h2 className="font-semibold mb-3">Start a new deck</h2>
        {creating ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              createProject();
            }}
          >
            <label className="block">
              <span className="label">Deck name — shown in the flashcards app menu</span>
              <input
                autoFocus
                className="field"
                style={{ maxWidth: 420 }}
                placeholder="e.g. “Mission Trails Plants”"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Deck name"
                data-testid="new-deck-name"
              />
            </label>
            <label className="block">
              <span className="label">Description — what the deck covers (optional, editable later)</span>
              <textarea
                className="field"
                rows={2}
                style={{ maxWidth: 420 }}
                placeholder="e.g. Common plants of the Mission Trails Regional Park canyons"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="Deck description"
                data-testid="new-deck-description"
              />
            </label>
            <div className="flex gap-2">
              <button type="submit" className="btn-primary" data-testid="create-deck">
                Create deck
              </button>
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
            {createError && (
              <p className="text-sm" role="alert" style={{ color: "var(--danger)" }} data-testid="create-error">
                {createError}
              </p>
            )}
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => setCreating(true)}>
              New deck
            </button>
            <input
              ref={archiveInputRef}
              type="file"
              accept=".zip,.deck,.deck.lite"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importArchive(file);
                e.target.value = "";
              }}
            />
            <button
              className="btn-secondary"
              onClick={() => archiveInputRef.current?.click()}
              disabled={importing}
              data-testid="import-deck"
              title="Open a deck exported from Deck Curator (or the flashcards app) and keep editing it"
            >
              {importing ? "Importing…" : "Import deck (.zip / .deck)…"}
            </button>
          </div>
        )}
        {importError && (
          <p className="text-sm mt-3" role="alert" style={{ color: "var(--danger)" }} data-testid="import-error">
            {importError}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-semibold mb-3">Your decks</h2>
        {listError && (
          <p className="text-sm" role="alert" style={{ color: "var(--danger)" }}>
            {listError}
          </p>
        )}
        {projects === null && !listError ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Loading…
          </p>
        ) : projects !== null && projects.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }} data-testid="no-projects">
            No decks yet. Create one to get started.
          </p>
        ) : projects !== null ? (
          <ul className="divide-y rounded-lg border bg-white" style={{ borderColor: "var(--border)" }}>
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/project/${p.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-[var(--accent-soft)]"
                  data-testid="project-link"
                >
                  <div>
                    <div className="font-medium">{p.deckLabel || p.name}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>
                      {p.speciesCount} species · {p.photoCount} photos · edited{" "}
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span aria-hidden>→</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
