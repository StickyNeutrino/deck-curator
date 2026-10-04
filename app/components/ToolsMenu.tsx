import { useEffect, useRef, useState } from "react";
import type { Project } from "~/lib/types";
import { enrichProject } from "~/lib/enrich";
import { photoCap } from "~/lib/cardGeometry";
import { fillMissingPhotos, labelNativeStatus, labelRarity, toolResultMerger, type ToolReport } from "~/lib/tools";
import { startJob, useJobs } from "~/lib/jobs";
import { openJobsPanel } from "~/components/JobsDock";

interface Tool {
  id: string;
  label: string;
  hint: string;
}

const TOOLS: Tool[] = [
  {
    id: "enrich",
    label: "Fill gaps & re-sort categories",
    hint: "Resolve missing scientific names/families from iNat and file species into Plants/Fungi/Animals (or Birds/Mammals/…)",
  },
  {
    id: "native",
    label: "Label native / introduced",
    hint: "Read iNat's place checklist to set Native / Non-native, and optionally flag introduced species with the red invasive border",
  },
  {
    id: "rarity",
    label: "Label conservation status",
    hint: "Read iNat's conservation listings (NatureServe, IUCN, state lists) to fill rarity, and optionally flag threatened species with the blue notable border",
  },
  {
    id: "photos",
    label: "Fill missing photos",
    hint: "Search iNat worldwide (this deck's licenses & filters) and auto-pick CC photos into empty photo slots — the species-page photo search, batched",
  },
];

/**
 * Deck tools dropdown: batch actions over the deck (or the current selection)
 * that pull facts from iNaturalist — filling missing names/families and
 * re-sorting categories, labeling native vs. introduced, labeling
 * conservation status, and auto-picking photos into empty photo slots. Tools
 * only fill empty fields and report any conflict with values the curator set
 * by hand.
 *
 * Each run is a background job: the menu closes immediately, the deck stays
 * editable, and progress/outcomes (including conflict lists) live in the
 * Jobs dock — nothing is reported under this button any more.
 */

export function ToolsMenu({
  project,
  onChange,
  scopeIds,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
  /** Selected species ids — empty means the tool applies to the whole deck. */
  scopeIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [invasiveBorder, setInvasiveBorder] = useState(true);
  const [notableBorder, setNotableBorder] = useState(false);
  /** Restrict photo filling to completely photo-less cards (default: top up
   *  every card with empty slots, like the species-page Auto-pick). */
  const [onlyEmptyPhotos, setOnlyEmptyPhotos] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Live job list — the menu shows how many tool runs are in flight; the
  // dock does the actual monitoring.
  const jobs = useJobs();
  const runningToolJobs = jobs.filter(
    (j) => j.projectId === project.id && j.kind !== "inat-add" && j.status === "running",
  ).length;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pendingCount = project.species.filter(
    (s) =>
      !s.sciName ||
      !s.familyLatin ||
      s.category === "" ||
      !project.categories.some((c) => c.id === s.category),
  ).length;

  // Cards with empty photo slots — what "Fill missing photos" would work on.
  const pendingPhotos = project.species.filter((s) => s.photos.length < photoCap(s.layout)).length;

  const scope = scopeIds.length ? scopeIds : project.species.map((s) => s.id);
  const scopeLabel = scopeIds.length ? `${scopeIds.length} selected` : `all ${project.species.length} species`;

  /** Merge, don't clobber: only fields the tool changed vs the snapshot are
   *  applied, so edits made during the run survive. */
  const applyResult = (snapshot: Project, result: Project) => {
    onChange(toolResultMerger(snapshot, result));
  };

  const summaryOf = (report: ToolReport): string => {
    const parts = [`checked ${report.considered}`, `labeled ${report.filled}`];
    if (report.noData) parts.push(`no iNat data for ${report.noData}`);
    if (report.conflicts.length) parts.push(`${report.conflicts.length} kept as-is`);
    return parts.join(" · ") + (report.sourcePlace ? ` — ${report.sourcePlace}` : "");
  };

  const runEnrich = () => {
    const snapshot = project;
    setOpen(false);
    void startJob(
      {
        kind: "tool-enrich",
        label: `Fill gaps & re-sort categories (${scopeLabel})`,
        projectId: project.id,
        projectName: project.name,
      },
      async (h) => {
        const result = await enrichProject(
          snapshot,
          (done, total, label) => h.progress(done, total, label),
          scope,
        );
        applyResult(snapshot, result.project);
        const parts = [`enriched ${result.resolved} species`];
        if (result.sorted) parts.push(`sorted ${result.sorted} into categories`);
        if (result.unresolved.length) parts.push(`couldn't resolve: ${result.unresolved.slice(0, 3).join(", ")}`);
        return parts.join(" · ");
      },
    );
  };

  const needsPlace = (): boolean => {
    if (project.location?.lat != null || project.location?.inatPlace?.id) return true;
    setNote("Native status is place-specific — set the deck's location in Deck info first.");
    return false;
  };

  const runNative = () => {
    if (!needsPlace()) return;
    const snapshot = project;
    setOpen(false);
    void startJob(
      {
        kind: "tool-native",
        label: `Label native / introduced (${scopeLabel})`,
        projectId: project.id,
        projectName: project.name,
      },
      async (h) => {
        const { project: next, report } = await labelNativeStatus(
          snapshot,
          { ids: scope },
          { invasiveBorder },
          (done, total) => h.progress(done, total),
          onChange,
        );
        applyResult(snapshot, next);
        return { message: summaryOf(report), conflicts: report.conflicts };
      },
    );
  };

  const runRarity = () => {
    if (!needsPlace()) return;
    const snapshot = project;
    setOpen(false);
    void startJob(
      {
        kind: "tool-rarity",
        label: `Label conservation status (${scopeLabel})`,
        projectId: project.id,
        projectName: project.name,
      },
      async (h) => {
        const { project: next, report } = await labelRarity(
          snapshot,
          { ids: scope },
          { notableBorder },
          (done, total) => h.progress(done, total),
          onChange,
        );
        applyResult(snapshot, next);
        return { message: summaryOf(report), conflicts: report.conflicts };
      },
    );
  };

  const runPhotos = () => {
    const snapshot = project;
    setOpen(false);
    void startJob(
      {
        kind: "tool-photos",
        label: `Fill missing photos (${scopeLabel})`,
        projectId: project.id,
        projectName: project.name,
      },
      async (h) => {
        const { project: next, report } = await fillMissingPhotos(
          snapshot,
          { ids: scope },
          { topUp: !onlyEmptyPhotos },
          (done, total, label) => h.progress(done, total, label),
          h.signal,
        );
        applyResult(snapshot, next);
        if (!report.considered) return "No cards are missing photos.";
        const parts = [`added photos to ${report.filled} of ${report.considered} cards`];
        if (report.noData) parts.push(`no CC photos found for ${report.noData}`);
        if (report.conflicts.length) parts.push(`${report.conflicts.length} skipped`);
        return { message: parts.join(" · "), conflicts: report.conflicts };
      },
    );
  };

  const run = (id: string) => {
    setNote(null);
    if (id === "enrich") runEnrich();
    else if (id === "native") runNative();
    else if (id === "rarity") runRarity();
    else if (id === "photos") runPhotos();
  };

  const disabled = project.species.length === 0;

  return (
    <div ref={rootRef} className="relative inline-flex flex-col items-start">
      <button
        className="btn-secondary"
        data-testid="tools-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Batch tools for the deck or the current selection"
      >
        🛠 Tools {runningToolJobs > 0 ? `⏳${runningToolJobs}` : "▾"}
      </button>
      {open && (
        <div
          className="absolute z-30 top-full mt-1 w-80 rounded-md border bg-white shadow-lg p-2 space-y-1"
          style={{ borderColor: "var(--border)" }}
          role="menu"
          data-testid="tools-menu"
        >
          <p className="text-xs px-2 py-1" style={{ color: "var(--muted)" }}>
            Applies to {scopeLabel}. Runs in the background — progress and results land in{" "}
            <button type="button" className="underline" onClick={openJobsPanel}>
              Jobs
            </button>
            .
          </p>
          {TOOLS.map((tool) => (
            <div key={tool.id}>
              <button
                type="button"
                role="menuitem"
                className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--accent-soft)] text-sm font-medium"
                onClick={() => run(tool.id)}
                disabled={disabled}
                data-testid={`tool-${tool.id}`}
              >
                {tool.label}
                {tool.id === "enrich" && pendingCount > 0 && (
                  <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                    ({pendingCount} to fill)
                  </span>
                )}
                {tool.id === "photos" && pendingPhotos > 0 && (
                  <span className="ml-1 text-xs" style={{ color: "var(--muted)" }}>
                    ({pendingPhotos} to fill)
                  </span>
                )}
              </button>
              <p className="text-xs px-2 pb-1" style={{ color: "var(--muted)" }}>
                {tool.hint}
              </p>
              {tool.id === "native" && (
                <label className="text-xs px-2 pb-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={invasiveBorder}
                    onChange={(e) => setInvasiveBorder(e.target.checked)}
                    data-testid="tool-native-invasive-border"
                  />
                  Mark introduced species as invasive (red border)
                </label>
              )}
              {tool.id === "rarity" && (
                <label className="text-xs px-2 pb-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={notableBorder}
                    onChange={(e) => setNotableBorder(e.target.checked)}
                    data-testid="tool-rarity-notable-border"
                  />
                  Mark threatened species with the notable border
                </label>
              )}
              {tool.id === "photos" && (
                <label className="text-xs px-2 pb-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={onlyEmptyPhotos}
                    onChange={(e) => setOnlyEmptyPhotos(e.target.checked)}
                    data-testid="tool-photos-only-empty"
                  />
                  Only fill cards with no photos at all
                </label>
              )}
            </div>
          ))}
          {note && (
            <p className="text-xs px-2 py-1" role="alert" style={{ color: "var(--danger)" }} data-testid="tools-note">
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
