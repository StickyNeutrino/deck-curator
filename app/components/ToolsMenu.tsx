import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Project } from "~/lib/types";
import { enrichProject } from "~/lib/enrich";
import { labelNativeStatus, labelRarity, type ToolReport } from "~/lib/tools";

/**
 * Deck tools dropdown: batch actions over the deck (or the current selection)
 * that pull facts from iNaturalist — filling missing names/families and
 * re-sorting categories, labeling native vs. introduced, and labeling
 * conservation status. Tools only fill empty fields and report any conflict
 * with values the curator set by hand.
 */

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
];

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
  const [busy, setBusy] = useState<{ label: string; done: number; total: number } | null>(null);
  const [status, setStatus] = useState<ReactNode | null>(null);
  const [invasiveBorder, setInvasiveBorder] = useState(true);
  const [notableBorder, setNotableBorder] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const scope = scopeIds.length ? scopeIds : project.species.map((s) => s.id);
  const scopeLabel = scopeIds.length ? `${scopeIds.length} selected` : `all ${project.species.length} species`;

  const applyResult = (result: Project) => {
    onChange((d) => {
      d.categories = result.categories;
      d.species = result.species;
    });
  };

  const runEnrich = async () => {
    setBusy({ label: "Enriching", done: 0, total: scope.length });
    setStatus(null);
    try {
      const result = await enrichProject(project, (done, total) => setBusy({ label: "Enriching", done, total }), scope);
      applyResult(result.project);
      const parts = [`enriched ${result.resolved} species`];
      if (result.sorted) parts.push(`sorted ${result.sorted} into categories`);
      if (result.unresolved.length) parts.push(`couldn't resolve: ${result.unresolved.slice(0, 3).join(", ")}`);
      setStatus(parts.join(" · "));
    } catch (err) {
      setStatus(`Enrichment failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const needsPlace = (): boolean => {
    if (project.location?.lat != null || project.location?.inatPlace?.id) return true;
    setStatus("Native status is place-specific — set the deck's location in Deck info first.");
    return false;
  };

  const renderReport = (report: ToolReport): ReactNode => {
    const parts = [`checked ${report.considered}`, `labeled ${report.filled}`];
    if (report.noData) parts.push(`no iNat data for ${report.noData}`);
    if (report.conflicts.length) parts.push(`${report.conflicts.length} kept as-is`);
    return (
      <>
        {parts.join(" · ")}
        {report.sourcePlace && <> — {report.sourcePlace}</>}
        {report.conflicts.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer underline">conflicts</summary>
            <ul className="mt-1 ml-4 list-disc">
              {report.conflicts.map((c, i) => (
                <li key={i}>
                  <strong>{c.species}</strong> — {c.detail}
                </li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  };

  const runNative = async () => {
    if (!needsPlace()) return;
    setBusy({ label: "Labeling", done: 0, total: scope.length });
    setStatus(null);
    try {
      const { project: next, report } = await labelNativeStatus(
        project,
        { ids: scope },
        { invasiveBorder },
        (done, total) => setBusy({ label: "Labeling", done, total }),
        onChange,
      );
      applyResult(next);
      setStatus(renderReport(report));
    } catch (err) {
      setStatus(`Labeling failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const runRarity = async () => {
    if (!needsPlace()) return;
    setBusy({ label: "Labeling", done: 0, total: scope.length });
    setStatus(null);
    try {
      const { project: next, report } = await labelRarity(
        project,
        { ids: scope },
        { notableBorder },
        (done, total) => setBusy({ label: "Labeling", done, total }),
        onChange,
      );
      applyResult(next);
      setStatus(renderReport(report));
    } catch (err) {
      setStatus(`Labeling failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  const run = (id: string) => {
    setOpen(false);
    if (id === "enrich") void runEnrich();
    else if (id === "native") void runNative();
    else if (id === "rarity") void runRarity();
  };

  const disabled = busy !== null || project.species.length === 0;

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
        🛠 Tools {busy ? "…" : "▾"}
      </button>
      {open && !busy && (
        <div
          className="absolute z-30 top-full mt-1 w-80 rounded-md border bg-white shadow-lg p-2 space-y-1"
          style={{ borderColor: "var(--border)" }}
          role="menu"
          data-testid="tools-menu"
        >
          <p className="text-xs px-2 py-1" style={{ color: "var(--muted)" }}>
            Applies to {scopeLabel}.
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
            </div>
          ))}
        </div>
      )}
      {busy && (
        <span className="text-xs mt-1" style={{ color: "var(--muted)" }} data-testid="tools-progress">
          {busy.label} {busy.done}/{busy.total}…
        </span>
      )}
      {status && (
        <span className="text-xs mt-1 max-w-xl" style={{ color: "var(--muted)" }} data-testid="tools-status">
          {status}
        </span>
      )}
    </div>
  );
}
