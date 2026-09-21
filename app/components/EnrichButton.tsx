import { useState } from "react";
import type { Project } from "~/lib/types";
import { enrichProject } from "~/lib/enrich";
import { saveProject } from "~/lib/store";

/** Toolbar button: fill missing scientific names/families from iNaturalist
 *  and file species into Plants / Fungi / Animals (no AI — iNat's taxonomy). */

export function EnrichButton({
  project,
  onChange,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
}) {
  const [busy, setBusy] = useState<{ done: number; total: number; label?: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const pendingCount = project.species.filter(
    (s) =>
      !s.sciName ||
      !s.familyLatin ||
      s.category === "" ||
      !project.categories.some((c) => c.id === s.category),
  ).length;

  const run = async () => {
    setStatus(null);
    try {
      const result = await enrichProject(project, (done, total, label) =>
        setBusy({ done, total, label }),
      );
      await saveProject(result.project);
      onChange((d) => {
        d.categories = result.project.categories;
        d.species = result.project.species;
      });
      const parts = [`enriched ${result.resolved} species`];
      if (result.sorted) parts.push(`sorted ${result.sorted} into Plants/Fungi/Animals`);
      if (result.unresolved.length) parts.push(`couldn't resolve: ${result.unresolved.slice(0, 3).join(", ")}`);
      setStatus(parts.join(" · "));
    } catch (err) {
      setStatus(`Enrichment failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="inline-flex items-center gap-2">
      <button
        className="btn-secondary"
        onClick={() => void run()}
        disabled={busy !== null || project.species.length === 0}
        data-testid="enrich-button"
        title="Fill missing scientific names/families from iNaturalist and file species into Plants/Fungi/Animals"
      >
        {busy ? `Enriching ${busy.done + 1}/${busy.total}…` : pendingCount > 0 ? `Fill gaps from iNaturalist (${pendingCount})` : "Re-sort categories from iNaturalist"}
      </button>
      {status && (
        <span className="text-xs" style={{ color: "var(--muted)" }} data-testid="enrich-status">
          {status}
        </span>
      )}
    </div>
  );
}
