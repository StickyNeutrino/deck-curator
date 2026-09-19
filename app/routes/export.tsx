import type { Route } from "./+types/export";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { getProject, saveProject } from "~/lib/store";
import type { Project } from "~/lib/types";
import { exportDeck } from "~/lib/export";
import { validateProject, type ExportIssue } from "~/lib/validate";

/**
 * Pre-export review: deck identity, a validation report (names, photos,
 * credits, licensing), and the archive build.
 */

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — export" }];
}

export default function ExportPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId).then((p) => setProject(p ?? null));
  }, [projectId]);

  const issues = useMemo(() => (project ? validateProject(project) : []), [project]);

  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <nav className="mb-6 text-sm">
        <Link to={`/project/${projectId}`} className="underline" style={{ color: "var(--muted)" }}>
          ← {project.deckLabel}
        </Link>
      </nav>
      <h1 className="text-2xl font-bold mb-2">Export deck</h1>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
        Produces a zip with manifest.json plus the photo files. Upload it in the flashcards app's
        menu to study it.
      </p>

      <section className="mb-6">
        <h2 className="font-semibold mb-2">Deck identity</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="label">Deck id (slug)</span>
            <input
              className="field font-mono"
              value={project.id}
              onChange={(e) => {
                const next = { ...project, id: e.target.value.trim() };
                setProject(next);
                void saveProject(next);
              }}
              data-testid="deck-id"
            />
          </label>
          <label className="text-sm">
            <span className="label">Deck label</span>
            <input
              className="field"
              value={project.deckLabel}
              onChange={(e) => {
                const next = { ...project, deckLabel: e.target.value };
                setProject(next);
                void saveProject(next);
              }}
            />
          </label>
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          The id is the deck's unique key in the flashcards app; the label is what players see in
          the menu (emoji welcome).
        </p>
      </section>

      <ValidationReport issues={issues} />

      <div className="mt-6 flex gap-2">
        <button
          className="btn-primary"
          data-testid="export-deck"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            try {
              const { blob, filename } = await exportDeck(project);
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = filename;
              a.click();
              URL.revokeObjectURL(a.href);
              setDone(filename);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "Building zip…" : "Export deck (.zip)"}
        </button>
        {done && (
          <span className="text-sm self-center" data-testid="export-done" style={{ color: "var(--accent)" }}>
            Saved {done} — check your downloads.
          </span>
        )}
      </div>
    </main>
  );
}

function ValidationReport({ issues }: { issues: ExportIssue[] }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");
  const clean = errors.length === 0 && warnings.length === 0;
  return (
    <section data-testid="validation-report">
      <h2 className="font-semibold mb-2">
        Review {clean && infos.length === 0 && "— no issues 🎉"}
      </h2>
      {issues.length > 0 && (
        <ul className="rounded-lg border bg-white divide-y" style={{ borderColor: "var(--border)" }}>
          {issues.map((issue, i) => (
            <li
              key={i}
              className="px-4 py-2 text-sm"
              style={{
                color:
                  issue.severity === "error"
                    ? "var(--danger)"
                    : issue.severity === "info"
                      ? "var(--muted)"
                      : "var(--ink)",
              }}
              data-testid={`issue-${issue.severity}`}
            >
              {issue.severity === "error" ? "✕ " : issue.severity === "info" ? "ℹ " : "⚠ "}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
        Warnings don't block export, but credits and names ship exactly as shown — fix them here
        before sharing the deck.
      </p>
    </section>
  );
}
