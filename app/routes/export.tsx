import type { Route } from "./+types/export";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { getProject } from "~/lib/store";
import type { Project } from "~/lib/types";
import { exportProjectFile, exportDeckFile, exportLightDeck } from "~/lib/export";
import { SHRINK_PRESETS, type ShrinkPreset } from "~/lib/imageShrink";
import { validateProject, missingPhotoIssues, type ExportIssue } from "~/lib/validate";
import { ensureRepo, isAutosaveCommit, listVersions, restoreVersion, commitDeckVersion, type VersionInfo } from "~/lib/versioning";
import { startJob, registerJobDownload } from "~/lib/jobs";
import { openJobsPanel } from "~/components/JobsDock";
import { ProjectTabs } from "~/components/ProjectTabs";

/**
 * Pre-export review: a validation report (names, photos, credits, licensing),
 * the git version history with restore, and the three export artifacts
 * (project file, deck file, light deck). Each export runs as a background
 * job — the Jobs dock tracks progress (reading and re-encoding photos,
 * resolving remote sources) and offers the produced file again if the
 * browser's download didn't land. Deck identity (id, label) is edited on
 * the Deck info tab.
 */

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — export" }];
}

type ExportKind = "project" | "deck" | "lite";

const EXPORT_JOBS: Record<ExportKind, { kind: "export-project" | "export-deck" | "export-lite"; label: string }> = {
  project: { kind: "export-project", label: "Exporting project file (.zip)" },
  deck: { kind: "export-deck", label: "Exporting deck file (.deck)" },
  lite: { kind: "export-lite", label: "Exporting light deck (.deck.lite)" },
};

/** Hand a produced file to the browser's download flow. */
function saveFile(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function ExportPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [missing, setMissing] = useState<ExportIssue[]>([]);
  // Compressing is a deck-file option (smaller photos, crops baked in).
  // Project files always ship original bytes — they carry the history.
  const [shrinkPreset, setShrinkPreset] = useState<ShrinkPreset | null>(null);

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

  // Run one of the three artifacts as a background job: the Jobs dock shows
  // live progress (photo reading/re-encoding, source resolution) and the
  // finished run carries a re-download button. The file is also handed to
  // the browser's download flow as soon as the job completes, so the usual
  // "it just saved" behavior stays. The light deck can refuse (decks with
  // uploads/animations) — that surfaces as a failed job, here and in the dock.
  const runExport = useCallback(
    (kind: ExportKind) => {
      if (!project || exporting !== null) return;
      const { kind: jobKind, label } = EXPORT_JOBS[kind];
      setExporting(kind);
      setSaveError(null);
      openJobsPanel();
      void startJob(
        { kind: jobKind, label, projectId: project.id, projectName: project.name },
        async (h) => {
          const progress = (done: number, total: number, detail?: string) => h.progress(done, total, detail);
          const result =
            kind === "project"
              ? await exportProjectFile(project, { onProgress: progress, signal: h.signal })
              : kind === "deck"
                ? await exportDeckFile(project, {
                    shrink: shrinkPreset ? SHRINK_PRESETS[shrinkPreset] : null,
                    onProgress: progress,
                    signal: h.signal,
                  })
                : await exportLightDeck(project, { onProgress: progress, signal: h.signal });
          if (h.signal.aborted) throw new DOMException("Aborted", "AbortError");
          registerJobDownload(h.id, result.blob, result.filename);
          saveFile(result.blob, result.filename);
          return `Saved ${result.filename} to your downloads.`;
        },
      )
        .then((record) => {
          if (record.status === "completed") setDone(record.download?.filename ?? null);
          else if (record.status === "failed") setSaveError(`Export failed: ${record.message ?? "unknown error"}`);
        })
        .finally(() => setExporting(null));
    },
    [project, exporting, shrinkPreset],
  );

  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        {saveError ? (
          <p role="alert" style={{ color: "var(--danger)" }}>{saveError}</p>
        ) : (
          <p>Loading…</p>
        )}
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

      <ValidationReport issues={issues} />

      <VersionHistory project={project} onRestored={setProject} />

      <section className="mb-6" data-testid="export-options">
        <h2 className="font-semibold mb-2">Export</h2>
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border bg-white p-4" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-sm">Project file (.zip)</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  Stores the complete project: manifest, photos, version history, cards marked for
                  review, and other curation details.
                </div>
              </div>
              <button
                className="btn-primary whitespace-nowrap"
                data-testid="export-project"
                disabled={exporting !== null}
                onClick={() => runExport("project")}
              >
                {exporting === "project" ? "Building…" : "Export"}
              </button>
            </div>
          </div>

          <div className="rounded-lg border bg-white p-4" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-sm">Deck file (.deck)</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  Deck optimized for distribution: manifest and photos, no version history.
                </div>
              </div>
              <button
                className="btn-primary whitespace-nowrap"
                data-testid="export-deck"
                disabled={exporting !== null}
                onClick={() => runExport("deck")}
              >
                {exporting === "deck" ? "Building…" : "Export"}
              </button>
            </div>
            <label className="inline-flex items-start gap-2 cursor-pointer mt-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={shrinkPreset !== null}
                onChange={(e) => setShrinkPreset(e.target.checked ? "medium" : null)}
                data-testid="shrink-photos"
              />
              <span>
                Compress photos
                <span className="block text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  Rewrites stills as smaller JPEGs in your browser, with your crop already applied.
                  GIFs and video clips are left alone. Anything that can't be re-encoded ships
                  as-is.
                </span>
              </span>
            </label>
            {shrinkPreset !== null && (
              <label className="text-sm ml-6 mt-2 flex items-center gap-2">
                <span>Size</span>
                <select
                  className="field text-sm"
                  style={{ maxWidth: 240 }}
                  value={shrinkPreset}
                  onChange={(e) => setShrinkPreset(e.target.value as ShrinkPreset)}
                  data-testid="shrink-preset"
                >
                  <option value="small">Small — 1024px long edge</option>
                  <option value="medium">Medium — 1600px long edge</option>
                  <option value="large">Large — 2400px long edge</option>
                </select>
              </label>
            )}
          </div>

          <div className="rounded-lg border bg-white p-4" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-sm">
                  Light deck (.deck.lite){" "}
                  <span
                    className="text-xs font-normal px-1.5 py-0.5 rounded"
                    style={{ color: "var(--accent)", border: "1px solid var(--border)" }}
                  >
                    experimental
                  </span>
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  Only the manifest (names, rarity, crops, credits) and no photos; those are
                  downloaded from iNaturalist when the deck is opened. The first export looks up
                  each photo's URL, which takes a few seconds; after that it's cached. Decks with
                  uploaded photos or animations can't go light.
                </div>
              </div>
              <button
                className="btn-primary whitespace-nowrap"
                data-testid="export-lite"
                disabled={exporting !== null}
                onClick={() => runExport("lite")}
              >
                {exporting === "lite" ? "Building…" : "Export"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {done && (
        <p className="text-sm mb-4" data-testid="export-done" style={{ color: "var(--accent)" }}>
          Saved {done} to your downloads.
        </p>
      )}
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
        <span style={{ color: "var(--danger)" }}>Red</span> issues can keep the flashcards app from
        importing the deck. <span style={{ color: "var(--ink)" }}>Amber</span> ones export fine but
        are worth fixing before you share. Export isn't blocked either way.
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
  const [hideAutosaves, setHideAutosaves] = useState(false);

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
