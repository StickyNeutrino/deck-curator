import { useCallback, useState } from "react";
import type { Project, SpeciesEntry } from "~/lib/types";
import { makeSpecies } from "~/lib/types";
import { looksLikeSciName, resolveTaxon } from "~/lib/resolve";

/** Tab 1: type or paste species names, one per line, optionally enriched
 *  against iNaturalist (scientific names resolve to common name + family). */

export function ListTab({
  project,
  onChange,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
}) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState(project.categories[0]?.id ?? "");
  const [enrich, setEnrich] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const names = parseNameList(text);

  const add = useCallback(async () => {
    if (!names.length) return;
    setBusy(true);
    const entries: SpeciesEntry[] = names.map((n) =>
      makeSpecies({
        category,
        commonName: looksLikeSciName(n) ? "" : n,
        sciName: looksLikeSciName(n) ? n : "",
      }),
    );
    if (enrich) {
      let done = 0;
      let offline = false;
      for (const entry of entries) {
        const query = entry.sciName || entry.commonName;
        if (!query) continue;
        setStatus(`Resolving ${query}… (${++done}/${entries.length})`);
        try {
          const taxon = await resolveTaxon(query);
          if (taxon) {
            entry.sciName = entry.sciName || taxon.sciName;
            entry.commonName = entry.commonName || taxon.commonName || "";
            entry.familyLatin = entry.familyLatin ?? taxon.familyLatin ?? undefined;
            entry.familyCommon = entry.familyCommon ?? taxon.familyCommon ?? undefined;
            entry.taxonId = taxon.taxonId;
            entry.inatResolved = true;
          }
        } catch {
          offline = true;
          break;
        }
      }
      if (offline) setStatus("iNaturalist unavailable — added names without enrichment.");
    }
    onChange((d) => {
      const existing = new Set(
        d.species.map((s) => (s.sciName || s.commonName).toLowerCase()),
      );
      for (const e of entries) {
        const key = (e.sciName || e.commonName).toLowerCase();
        if (!key || existing.has(key)) continue;
        d.species.push(e);
        existing.add(key);
      }
    });
    setBusy(false);
    if (!entries.some((e) => e.inatResolved)) setStatus(`Added ${entries.length} species.`);
  }, [names, category, enrich, onChange]);

  return (
    <div>
      <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>
        One name per line — scientific names (<em>Quercus agrifolia</em>) get resolved on
        iNaturalist to fill in common name and family.
      </p>
      <textarea
        className="field font-mono"
        rows={8}
        placeholder={"Quercus agrifolia\nDudleya edulis\nSelasphorus rufus"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Species names, one per line"
        data-testid="name-list"
      />
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <label className="text-sm">
          Category{" "}
          <select
            className="field !w-auto !py-1 inline-block"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {project.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
          Look up on iNaturalist
        </label>
        <button
          className="btn-primary ml-auto"
          onClick={() => void add()}
          disabled={busy || !names.length}
          data-testid="add-list"
        >
          {busy ? "Working…" : `Add ${names.length || ""} species`}
        </button>
      </div>
      {status && (
        <p className="text-sm mt-2" data-testid="list-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
    </div>
  );
}

function parseNameList(text: string): string[] {
  return text
    .split(/\r?\n|;/)
    .map((line) => line.replace(/^[\s\d.)-]+/, "").trim())
    .filter(Boolean);
}
