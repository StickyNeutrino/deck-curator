import type { Route } from "./+types/history";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { Project } from "~/lib/types";
import {
  ensureRepo,
  isAutosaveCommit,
  listVersions,
  restoreVersion,
  commitDeckVersion,
  type VersionInfo,
} from "~/lib/versioning";
import { getAuthor } from "~/lib/author";
import { useAutoVersion, AUTO_VERSION_DEBOUNCE_MS, cancelAutoVersion } from "~/lib/useAutoVersion";
import { AuthorPromptModal } from "~/components/AuthorPromptModal";
import { ProjectTabs } from "~/components/ProjectTabs";
import { useProjectDoc } from "~/lib/useProjectDoc";

/**
 * The deck's version history: every autosave and named version, with
 * restore. Split out of the export page so Export stays about exporting —
 * this page owns the git repository view.
 */

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — history" }];
}

export default function HistoryPage() {
  const { projectId } = useParams();
  const { project, setProject, notFound, loadError, saveError } = useProjectDoc(projectId);
  // Version-history autosave is armed by the record save above, from this
  // tab too — restores and author edits land in git history like any edit.
  const versionError = useAutoVersion(projectId);

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Project not found.</p>
        <Link to="/" className="btn-secondary mt-4 inline-flex">Back to all decks</Link>
      </main>
    );
  }
  if (loadError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p role="alert" style={{ color: "var(--danger)" }}>{loadError}</p>
        <Link to="/" className="btn-secondary mt-4 inline-flex">Back to all decks</Link>
      </main>
    );
  }
  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {saveError && (
        <p className="text-sm mb-3" role="alert" style={{ color: "var(--danger)" }}>
          {saveError}
        </p>
      )}
      {versionError && (
        <p className="text-sm mb-3" role="alert" style={{ color: "var(--danger)" }}>
          {versionError}
        </p>
      )}
      <ProjectTabs projectId={projectId ?? ""} active="history" />
      <VersionHistory project={project} onRestored={setProject} />
    </main>
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
  const [hideAutosaves, setHideAutosaves] = useState(false);
  // The authorship every new version is stamped with — editable right here,
  // since this is where the stamped history is visible.
  const [author, setAuthor] = useState(() => getAuthor());
  const [showAuthorEditor, setShowAuthorEditor] = useState(false);

  // The filter is display-only: autosave commits stay in the repository and
  // remain restorable — they just leave the visible list when hidden.
  const visible = useMemo(() => {
    if (versions === null) return null;
    return hideAutosaves ? versions.filter((v) => !isAutosaveCommit(v.message)) : versions;
  }, [versions, hideAutosaves]);
  const total = versions?.length ?? 0;
  const hidden = hideAutosaves ? total - (visible?.length ?? 0) : 0;

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
      // Drop any pending autosave first: a flush firing mid-restore would
      // commit the pre-restore state alongside the restored photo files —
      // an incoherent version in the history. The checkpoint below commits
      // the current state explicitly, so nothing is lost by cancelling.
      cancelAutoVersion(project.id);
      // Checkpoint the current state first, so the "current changes stay
      // in the history" promise holds even when a pending autosave hasn't
      // landed yet — and abort the restore if that fails.
      await commitDeckVersion(project, undefined, `Before restoring ${oid.slice(0, 8)}`, { silent: false });
      // restoreVersion swaps files + record atomically; the returned project
      // keeps this deck's id even when the commit predates a rename.
      const result = await restoreVersion(project.id, oid);
      if (result) {
        onRestored(result.project);
        // An in-flight flush that started before the cancel can re-add the
        // pre-restore state once its own commit lands — drop it again so
        // the restored state is what history records next.
        cancelAutoVersion(project.id);
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
    <section className="mt-6 mb-6" data-testid="version-history">
      <h1 className="text-2xl font-bold mb-1">Version history</h1>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Every deck is its own git repository in your browser. Changes commit automatically as you
        work — within about {Math.round(AUTO_VERSION_DEBOUNCE_MS / 1000)} seconds after you stop
        editing, on any tab, and when you leave a page; save a named version before big changes. New
        versions are authored as{" "}
        <button
          type="button"
          className="underline"
          onClick={() => setShowAuthorEditor(true)}
          data-testid="version-author"
          title="Change the name and email stamped onto versions"
        >
          {`${author.name} <${author.email}>`}
        </button>
        .
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
        <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={hideAutosaves}
            onChange={(e) => setHideAutosaves(e.target.checked)}
            data-testid="hide-autosaves"
          />
          Hide autosaves
        </label>
      </div>
      {status && (
        <p className="text-sm mb-2" data-testid="version-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
      {visible !== null && hidden > 0 && (
        <p className="text-xs mb-2" data-testid="autosaves-hidden" style={{ color: "var(--muted)" }}>
          Hiding {hidden} autosave {hidden === 1 ? "version" : "versions"}.
        </p>
      )}
      {visible === null ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Loading history…
        </p>
      ) : total === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          No versions yet — the first commit lands shortly after you make a change.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Every version so far is an autosave — untick “Hide autosaves” to see them.
        </p>
      ) : (
        <ul className="rounded-lg border bg-white divide-y" style={{ borderColor: "var(--border)" }}>
          {visible.map((v) => (
            <li key={v.oid} className="flex items-center gap-3 px-4 py-2 text-sm">
              <code className="text-xs" style={{ color: "var(--muted)" }}>
                {v.oid.slice(0, 8)}
              </code>
              <span className="flex-1 truncate" title={v.message}>
                {v.message.split("\n")[0]}
              </span>
              {v.authorName && (
                <span
                  className="text-xs whitespace-nowrap truncate max-w-[10rem]"
                  style={{ color: "var(--muted)" }}
                  title={v.authorEmail ? `${v.authorName} <${v.authorEmail}>` : v.authorName}
                  data-testid={`version-author-${v.oid.slice(0, 8)}`}
                >
                  {v.authorName}
                </span>
              )}
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
      {showAuthorEditor && (
        <AuthorPromptModal
          heading="Version authorship"
          skippable={false}
          onClose={() => {
            setShowAuthorEditor(false);
            setAuthor(getAuthor());
          }}
        />
      )}
    </section>
  );
}
