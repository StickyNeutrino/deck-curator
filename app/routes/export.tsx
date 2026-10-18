import type { Route } from "./+types/export";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { getProject, onProjectChange } from "~/lib/store";
import type { Project } from "~/lib/types";
import { exportProjectFile, exportDeckFile, exportLightDeck } from "~/lib/export";
import { SHRINK_PRESETS, type ShrinkPreset } from "~/lib/imageShrink";
import { validateProject, missingPhotoIssues, type ExportIssue } from "~/lib/validate";
import { listVersions, type VersionInfo } from "~/lib/versioning";
import { useAutoVersion } from "~/lib/useAutoVersion";
import { startJob, registerJobDownload } from "~/lib/jobs";
import { openJobsPanel } from "~/components/JobsDock";
import { ProjectTabs } from "~/components/ProjectTabs";

/**
 * Export: the three artifacts (project file, deck file, light deck), each
 * run as a background job — the Jobs dock tracks progress (reading and
 * re-encoding photos, resolving remote sources) and offers the produced
 * file again if the browser's download didn't land. The review and the
 * version history appear as one-line summaries linking to their own pages
 * (Review, History); deck identity (id, label) is edited on the Deck info
 * tab.
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
  // Autosave failures from any tab surface here too — this page is where a
  // curator notices missing versions, so a dead autosave must be visible.
  const versionError = useAutoVersion(projectId);
  // Compressing is a deck-file option (smaller photos, crops baked in).
  // Project files always ship original bytes — they carry the history.
  const [shrinkPreset, setShrinkPreset] = useState<ShrinkPreset | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = () => {
      void getProject(projectId)
        .then((p) => {
          // A deck that vanished (deleted, renamed in another tab) leaves
          // the loaded snapshot in place rather than blanking the page;
          // exports from it are the curator's call.
          if (!cancelled && p) setProject(p);
        })
        .catch((err) => {
          if (!cancelled) setSaveError(`Couldn't load the deck: ${err instanceof Error ? err.message : err}`);
        });
    };
    load();
    // Background jobs keep writing the deck while this page sits open, and
    // the page registers no live updater of its own — follow the store's
    // record writes so the validation report, the exports, and the
    // "Before restoring" checkpoint describe the deck as it is now, not as
    // it was when the page opened.
    const unsubscribe = onProjectChange((id) => {
      if (id === projectId) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
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
      {versionError && (
        <p className="text-sm mb-4" role="alert" style={{ color: "var(--danger)" }}>
          {versionError}
        </p>
      )}

      <ReviewSummary issues={issues} projectId={projectId ?? ""} />

      <HistorySummary project={project} />

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

/** One-line review summary: the issue totals, with the full report a link
 *  away on the Review page (pre-filtered to the cards that need fixing). */
function ReviewSummary({ issues, projectId }: { issues: ExportIssue[]; projectId: string }) {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;
  const parts: Array<{ count: number; label: string; color?: string }> = [
    { count: errors, label: "error", color: "var(--danger)" },
    { count: warnings, label: "warning", color: "var(--ink)" },
    { count: infos, label: "note", color: "var(--muted)" },
  ];
  const shown = parts.filter((p) => p.count > 0);
  return (
    <section className="mb-6" data-testid="review-summary">
      <h2 className="font-semibold mb-2">Review</h2>
      <p className="text-sm">
        {shown.length === 0 ? (
          "No issues 🎉 — "
        ) : (
          <>
            {shown.map((p, i) => (
              <span key={p.label}>
                {i > 0 && ", "}
                <span style={{ color: p.color }} data-testid={`issues-${p.label}s`}>
                  {p.count} {p.label}
                  {p.count === 1 ? "" : "s"}
                </span>
              </span>
            ))}{" — "}
          </>
        )}
        <Link to={`/project/${projectId}/review${issues.length ? "?filter=issues" : ""}`} className="underline">
          see the full review
        </Link>.
      </p>
      <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
        <span style={{ color: "var(--danger)" }}>Red</span> issues can keep the flashcards app from
        importing the deck. <span style={{ color: "var(--ink)" }}>Amber</span> ones export fine but
        are worth fixing before you share. Export isn't blocked either way.
      </p>
    </section>
  );
}

/** How many versions the deck has and when the last one landed — the full
 *  list (with restore) lives on the History page. */
function HistorySummary({ project }: { project: Project }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  // Re-read when the deck changes (a background autosave may have landed a
  // version while this page sat open) and via the deck's updatedAt.
  useEffect(() => {
    let cancelled = false;
    void listVersions(project.id)
      .then((list) => { if (!cancelled) setVersions(list); })
      .catch(() => { if (!cancelled) setVersions(null); });
    return () => { cancelled = true; };
  }, [project.id, project.updatedAt]);

  const latest = versions !== null && versions.length > 0 ? versions[0] : null;
  return (
    <section className="mb-6" data-testid="history-summary">
      <h2 className="font-semibold mb-2">Version history</h2>
      <p className="text-sm">
        {versions === null ? (
          "Loading history… — "
        ) : latest ? (
          <>
            {versions!.length} version{versions!.length === 1 ? "" : "s"} — last saved{" "}
            {relativeTime(latest.timestamp)} ({new Date(latest.timestamp).toLocaleString()}).{" "}
          </>
        ) : (
          "No versions yet — changes save automatically as you work. "
        )}
        <Link to={`/project/${project.id}/history`} className="underline">
          see the version history
        </Link>.
      </p>
    </section>
  );
}

/** Coarse age for the summary line; the History page has exact timestamps. */
function relativeTime(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
