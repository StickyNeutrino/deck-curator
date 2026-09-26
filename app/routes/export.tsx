import type { Route } from "./+types/export";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { getProject, listProjects, renameProject, saveProject } from "~/lib/store";
import type { Project } from "~/lib/types";
import { exportDeck } from "~/lib/export";
import { validateProject, missingPhotoIssues, type ExportIssue } from "~/lib/validate";
import { ensureRepo, listVersions, renameRepo, restoreVersion, commitDeckVersion, type VersionInfo } from "~/lib/versioning";
import { ProjectTabs } from "~/components/ProjectTabs";

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
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [missing, setMissing] = useState<ExportIssue[]>([]);

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId)
      .then((p) => setProject(p ?? null))
      .catch((err) => setSaveError(`Couldn't load the deck: ${err instanceof Error ? err.message : err}`));
  }, [projectId]);

  const issues = useMemo(
    () => [...(project ? validateProject(project) : []), ...missing],
    [project, missing],
  );

  // Manifest entries referencing blobs that aren't in the store (removed
  // before a save, legacy damage) would export as broken cards.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void missingPhotoIssues(project)
      .then((found) => { if (!cancelled) setMissing(found); })
      .catch(() => { if (!cancelled) setMissing([]); });
    return () => { cancelled = true; };
  }, [project]);

  // The deck id is the store key for the record, the photo files, and the git
  // repo — editing it per keystroke duplicated decks and broke every photo.
  // It now commits as an explicit, validated rename that migrates everything.
  const [idDraft, setIdDraft] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const commitLabel = useCallback(async () => {
    if (!project || labelDraft === null) return;
    const value = labelDraft;
    setLabelDraft(null);
    if (value === project.deckLabel) return;
    const next = { ...project, deckLabel: value };
    try {
      await saveProject(next);
      setProject(next);
      setSaveError(null);
    } catch (err) {
      setSaveError(`Couldn't save the label: ${err instanceof Error ? err.message : err}`);
    }
  }, [project, labelDraft]);

  const commitId = useCallback(async () => {
    if (!project || idDraft === null) return;
    const newId = idDraft.trim();
    setIdDraft(null);
    setIdentityError(null);
    if (!newId || newId === project.id) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(newId)) {
      setIdentityError("Ids are lowercase letters, numbers, and dashes.");
      return;
    }
    try {
      const taken = (await listProjects()).some((p) => p.id === newId);
      if (taken) {
        setIdentityError(`Another deck already uses the id “${newId}” — pick a different one.`);
        return;
      }
      setRenaming(true);
      const next = { ...project, id: newId };
      await renameProject(project.id, next); // files + record move atomically
      try {
        await renameRepo(project.id, newId); // the git history follows the deck
      } catch {
        setIdentityError("Deck renamed, but its version history could not be moved — new versions start from here.");
      }
      setProject(next);
      navigate(`/project/${newId}/export`, { replace: true });
    } catch (err) {
      setIdentityError(`Rename failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setRenaming(false);
    }
  }, [project, idDraft, navigate]);

  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <ProjectTabs projectId={projectId ?? ""} active="export" />
      <h1 className="text-2xl font-bold mt-6 mb-2">Export deck</h1>
      {saveError && (
        <p className="text-sm mb-4" role="alert" style={{ color: "var(--danger)" }} data-testid="export-page-error">
          {saveError}
        </p>
      )}
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
              value={idDraft ?? project.id}
              disabled={renaming}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={() => void commitId()}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitId(); } }}
              data-testid="deck-id"
            />
          </label>
          <label className="text-sm">
            <span className="label">Deck label</span>
            <input
              className="field"
              value={labelDraft ?? project.deckLabel}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={() => void commitLabel()}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitLabel(); } }}
            />
          </label>
        </div>
        {identityError && (
          <p className="text-sm mt-2" role="alert" style={{ color: "var(--danger)" }} data-testid="identity-error">
            {identityError}
          </p>
        )}
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          The id is the deck's unique key in the flashcards app; the label is what players see in
          the menu (emoji welcome). Changing the id moves the deck's photos and version history
          with it. Both fields commit when you click away or press Enter.
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
              setSaveError(null);
            } catch (err) {
              setSaveError(`Export failed: ${err instanceof Error ? err.message : err}`);
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

  // Refresh on deck changes and via the Refresh button. Deliberately NOT
  // keyed on `versions`: refresh() writes versions, and an effect that both
  // writes and depends on its own output re-runs forever.
  useEffect(() => {
    void refresh();
  }, [refresh, project.updatedAt]);

  // Poll only while the list is empty, so a freshly created deck's first
  // commit (ensureRepo, running moments after open) appears without
  // requiring another edit. The guard reads state; it never re-arms the
  // effect from its own result.
  const historyEmpty = versions !== null && versions.length === 0;
  useEffect(() => {
    if (!historyEmpty) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [historyEmpty, refresh]);

  // The project page kicks off the initial commit, but this page can be the
  // first (or only) place a deck is opened — make sure history exists here
  // too. ensureRepo is a no-op when the repo already has commits.
  useEffect(() => {
    void ensureRepo(project).catch(() => undefined);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveVersion = async () => {
    setBusy("save");
    try {
      const oid = await commitDeckVersion(project, undefined, message.trim() || undefined, { silent: false });
      setMessage("");
      await refresh();
      setStatus(oid ? "Version saved." : "No changes since the last version — nothing to save.");
    } catch (err) {
      setStatus(`Saving the version failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (oid: string) => {
    if (!confirm("Restore this version? Current changes stay in the history.")) return;
    setBusy(oid);
    try {
      // Make the promise true: autosave only runs on the cards page, so
      // edits made elsewhere may never have been committed. Checkpoint the
      // current state first — and abort the restore if that fails.
      await commitDeckVersion(project, undefined, `Before restoring ${oid.slice(0, 8)}`, { silent: false });
      // restoreVersion swaps files + record atomically; the returned project
      // keeps this deck's id even when the commit predates a rename.
      const result = await restoreVersion(project.id, oid);
      if (result) {
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
