import type { Route } from "./+types/export";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { getProject, saveProject } from "~/lib/store";
import type { Project } from "~/lib/types";
import { exportDeck } from "~/lib/export";
import { validateProject, type ExportIssue } from "~/lib/validate";
import { listVersions, restoreVersion, commitDeckVersion, type VersionInfo } from "~/lib/versioning";

/**
 * Pre-export review: deck identity, a validation report (names, photos,
 * credits, licensing), the git version history with restore, and the
 * archive build.
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

      <VersionHistory project={project} onRestored={setProject} />

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
    <section className="mb-6" data-testid="validation-report">
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

function VersionHistory({
  project,
  onRestored,
}: {
  project: Project;
  onRestored: (p: Project) => void;
}) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await listVersions(project.id);
    setVersions(list);
  }, [project.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, project.updatedAt]);

  const saveVersion = async () => {
    setBusy("save");
    await commitDeckVersion(project, undefined, message.trim() || undefined);
    setMessage("");
    await refresh();
    setBusy(null);
    setStatus("Version saved.");
  };

  const restore = async (oid: string) => {
    if (!confirm("Restore this version? Current changes stay in the history.")) return;
    setBusy(oid);
    try {
      const result = await restoreVersion(project.id, oid);
      if (result) {
        await saveProject(result.project);
        onRestored(result.project);
        await commitDeckVersion(result.project, undefined, `Restored version ${oid.slice(0, 8)}`);
        await refresh();
        setStatus(`Restored ${oid.slice(0, 8)}.`);
      }
    } catch (err) {
      setStatus(`Restore failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-6" data-testid="version-history">
      <h2 className="font-semibold mb-1">Version history</h2>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Every deck is its own git repository in your browser. Changes commit automatically as you
        work (a few seconds after you stop typing); save a named version before big changes.
      </p>
      <div className="flex gap-2 mb-3">
        <input
          className="field text-sm"
          style={{ maxWidth: 260 }}
          placeholder="Version note (optional) — e.g. “before renaming pass”"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label="Version note"
          data-testid="version-note"
        />
        <button
          className="btn-secondary"
          onClick={() => void saveVersion()}
          disabled={busy !== null}
          data-testid="save-version"
        >
          {busy === "save" ? "Saving…" : "Save a version"}
        </button>
        <button className="btn-secondary" onClick={() => void refresh()} disabled={busy !== null}>
          Refresh
        </button>
      </div>
      {status && (
        <p className="text-sm mb-2" data-testid="version-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
      {versions === null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Loading history…
        </p>
      ) : versions.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          No versions yet — the first commit lands shortly after you make a change.
        </p>
      ) : (
        <ul className="rounded-lg border bg-white divide-y" style={{ borderColor: "var(--border)" }}>
          {versions.map((v) => (
            <li key={v.oid} className="flex items-center gap-3 px-4 py-2 text-sm">
              <code className="text-xs" style={{ color: "var(--muted)" }}>
                {v.oid.slice(0, 8)}
              </code>
              <span className="flex-1 truncate" title={v.message}>
                {v.message.split("\n")[0]}
              </span>
              <span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>
                {new Date(v.timestamp).toLocaleString()}
              </span>
              <button
                className="btn-secondary !py-1 !px-2 text-xs"
                onClick={() => void restore(v.oid)}
                disabled={busy !== null}
                data-testid={`restore-${v.oid.slice(0, 8)}`}
              >
                {busy === v.oid ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
