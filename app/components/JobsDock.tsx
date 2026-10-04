import { useEffect, useRef, useState } from "react";
import {
  cancelJob,
  clearFinishedJobs,
  getJobDownload,
  markJobsSeen,
  removeJob,
  unseenJobCount,
  useJobs,
  type JobRecord,
} from "~/lib/jobs";

/**
 * The global Jobs dock: a small pill in the bottom-right corner of every
 * page that keeps long-running work visible and controllable. Bulk iNat
 * adds, deck tools, and deck exports run here — closing the Add-species
 * modal or changing pages never hides them.
 *
 * The pill shows live progress while jobs run and a badge when finished
 * results haven't been looked at yet; the panel lists running jobs (progress
 * bar + cancel) above the history of finished runs with their outcome
 * summaries, the tools' "kept as-is" conflict reports, and re-download
 * buttons for files exports produced this session.
 */

/** The Tools menu (and anything else) opens the panel by dispatching this. */
export const OPEN_JOBS_EVENT = "deck-curator:open-jobs";

export function openJobsPanel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_JOBS_EVENT));
}

const STATUS_STYLE: Record<JobRecord["status"], { label: string; color: string }> = {
  running: { label: "Running", color: "var(--accent)" },
  completed: { label: "Completed", color: "var(--accent)" },
  failed: { label: "Failed", color: "var(--danger)" },
  cancelled: { label: "Cancelled", color: "var(--muted)" },
};

function relativeTime(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

function JobProgress({ job }: { job: JobRecord }) {
  const pct = job.total > 0 ? (job.done / job.total) * 100 : 0;
  return (
    <div className="mt-1" data-testid={`job-progress-${job.id}`}>
      <div className="flex justify-between text-xs mb-1" style={{ color: "var(--muted)" }}>
        <span className="truncate mr-2">{job.detail ?? job.label}</span>
        <span>
          {job.done}/{job.total}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "var(--accent)" }}
          role="progressbar"
          aria-valuenow={job.done}
          aria-valuemin={0}
          aria-valuemax={job.total}
        />
      </div>
    </div>
  );
}

/** Re-download a file an export job produced this session. */
function downloadJobResult(id: string): void {
  const file = getJobDownload(id);
  if (!file) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file.blob);
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function JobItem({ job }: { job: JobRecord }) {
  const style = STATUS_STYLE[job.status];
  return (
    <li className="border rounded-md p-3" style={{ borderColor: "var(--border)" }} data-testid={`job-${job.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">{job.label}</p>
          {job.projectName && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {job.projectName} · {relativeTime(job.createdAt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className="text-xs rounded-full border px-2 py-0.5 whitespace-nowrap"
            style={{ borderColor: "var(--border)", color: style.color }}
            data-testid={`job-status-${job.id}`}
          >
            {job.status === "running" && "⏳ "}
            {style.label}
          </span>
          {job.status !== "running" && (
            <button
              className="btn-secondary !px-2 !py-0.5 text-xs"
              onClick={() => removeJob(job.id)}
              aria-label={`Remove ${job.label} from the history`}
              title="Remove from the history"
              data-testid={`job-remove-${job.id}`}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {job.status === "running" && (
        <>
          <JobProgress job={job} />
          <button
            className="btn-secondary !px-2 !py-0.5 text-xs mt-2"
            onClick={() => cancelJob(job.id)}
            data-testid={`job-cancel-${job.id}`}
          >
            Cancel
          </button>
        </>
      )}
      {job.status !== "running" && job.message && (
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }} data-testid={`job-message-${job.id}`}>
          {job.message}
        </p>
      )}
      {job.status === "completed" && job.download && getJobDownload(job.id) && (
        <button
          className="btn-secondary !px-2 !py-0.5 text-xs mt-2"
          onClick={() => downloadJobResult(job.id)}
          title="Save the file again"
          data-testid={`job-download-${job.id}`}
        >
          Download {job.download.filename}
        </button>
      )}
      {job.conflicts && job.conflicts.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer underline" style={{ color: "var(--muted)" }}>
            {job.conflicts.length} kept as-is
          </summary>
          <ul className="mt-1 ml-4 list-disc" style={{ color: "var(--muted)" }}>
            {job.conflicts.map((c, i) => (
              <li key={i}>
                <strong>{c.species}</strong> — {c.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function JobsDock() {
  const jobs = useJobs();
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(unseenJobCount());
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync the "new results" badge whenever the store ticks (jobs finish at
  // any moment; opening the panel clears the set).
  useEffect(() => {
    setUnseen(unseenJobCount());
  });

  // Any component can ask for the panel (the Tools menu links to it).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_JOBS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_JOBS_EVENT, onOpen);
  }, []);

  // Close on outside click / Escape while the panel is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const openPanel = () => {
    setOpen(true);
    markJobsSeen();
  };

  const running = jobs.filter((j) => j.status === "running");
  const finished = jobs.filter((j) => j.status !== "running");

  return (
    <>
      {jobs.length > 0 && (
        <button
          className="btn-primary fixed bottom-4 right-4 z-40 shadow-lg rounded-full !px-4"
          onClick={openPanel}
          data-testid="jobs-dock"
          title="Background jobs — bulk adds, deck tools, and deck exports"
        >
          {running.length > 0 ? (
            <>
              <span aria-hidden>⏳</span> {running.length} running
            </>
          ) : (
            <>
              <span>Jobs</span>
              {unseen > 0 && (
                <span
                  className="inline-flex items-center justify-center rounded-full text-xs font-semibold"
                  style={{ background: "#fff", color: "var(--accent)", minWidth: 18, height: 18, padding: "0 4px" }}
                  data-testid="jobs-badge"
                >
                  {unseen}
                </span>
              )}
            </>
          )}
        </button>
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
          data-testid="jobs-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div ref={panelRef} className="w-full max-w-xl rounded-lg bg-white p-6 mt-16 mb-10" role="dialog" aria-label="Background jobs">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Jobs</h2>
              <button className="btn-secondary" onClick={() => setOpen(false)} aria-label="Close" data-testid="jobs-close">
                ✕
              </button>
            </div>
            <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
              Long-running work — bulk adds from iNaturalist searches, deck tools, deck exports —
              runs here in the background. Closing a dialog or changing pages never stops a job.
            </p>
            {jobs.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No jobs yet.
              </p>
            ) : (
              <div className="space-y-4">
                {running.length > 0 && (
                  <section>
                    <h3 className="label">Running</h3>
                    <ul className="space-y-2">
                      {running.map((job) => (
                        <JobItem key={job.id} job={job} />
                      ))}
                    </ul>
                  </section>
                )}
                {finished.length > 0 && (
                  <section>
                    <div className="flex items-center justify-between">
                      <h3 className="label">History</h3>
                      <button
                        className="text-xs underline"
                        style={{ color: "var(--muted)" }}
                        onClick={() => {
                          clearFinishedJobs();
                          setUnseen(0);
                        }}
                        data-testid="jobs-clear"
                      >
                        clear finished
                      </button>
                    </div>
                    <ul className="space-y-2">
                      {finished.map((job) => (
                        <JobItem key={job.id} job={job} />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
