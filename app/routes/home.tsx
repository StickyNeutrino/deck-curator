import type { Route } from "./+types/home";
import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { listProjects, deleteProject, type ProjectSummary } from "~/lib/store";
import { newProject, templateWorkbook } from "~/lib/importSpreadsheet";
import { saveProject } from "~/lib/store";
import { makeId } from "~/lib/ids";

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

  useEffect(() => {
    listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const createProject = useCallback(() => {
    const label = name.trim() || "Untitled deck";
    const project = newProject(label);
    void saveProject(project).then(() => navigate(`/project/${project.id}`));
  }, [name, navigate]);

  const downloadTemplate = useCallback(() => {
    const buf = templateWorkbook();
    const blob = new Blob([buf as unknown as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "deck-curator-template.xlsx";
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

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
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createProject();
            }}
          >
            <input
              autoFocus
              className="field"
              style={{ maxWidth: 320 }}
              placeholder="Deck name — e.g. “Mission Trails Plants”"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Deck name"
            />
            <button type="submit" className="btn-primary">
              Create
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => setCreating(true)}>
              New deck
            </button>
            <button className="btn-secondary" onClick={downloadTemplate}>
              Download spreadsheet template
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-semibold mb-3">Your decks</h2>
        {projects === null ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Loading…
          </p>
        ) : projects.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }} data-testid="no-projects">
            No decks yet. Create one to get started, or download the spreadsheet template above.
          </p>
        ) : (
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
        )}
      </section>
    </main>
  );
}
