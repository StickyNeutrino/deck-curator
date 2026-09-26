import { useRef, useState } from "react";
import type { Project } from "~/lib/types";
import { parseSpreadsheet, templateWorkbook } from "~/lib/importSpreadsheet";

/** Tab 3: import a spreadsheet (the official template or any survey-style
 *  workbook with recognizable columns). */

export function FileTab({
  onChange,
}: {
  onChange: (f: (d: Project) => void) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setStatus("Reading spreadsheet…");
    try {
      const result = parseSpreadsheet(await file.arrayBuffer(), file.name);
      onChange((d) => {
        const existing = new Set(
          d.species.map((s) => (s.sciName || s.commonName).toLowerCase()),
        );
        for (const cat of result.categories) {
          if (!d.categories.some((c) => c.id === cat.id)) d.categories.push(cat);
        }
        for (const s of result.species) {
          const key = (s.sciName || s.commonName).toLowerCase();
          if (key && existing.has(key)) continue;
          d.species.push(s);
          if (key) existing.add(key);
        }
      });
      setStatus(
        `Imported ${result.species.length} species from ${file.name}` +
          (result.warnings.length ? ` — ${result.warnings.length} sheet(s) skipped, see console` : ""),
      );
      for (const w of result.warnings) console.warn(w);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div data-testid="file-tab">
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
      />
      <button className="btn-primary" onClick={() => inputRef.current?.click()} data-testid="choose-spreadsheet">
        Choose .xlsx / .csv file…
      </button>{" "}
      <button
        className="btn-secondary"
        data-testid="download-template"
        onClick={() => {
          const buf = templateWorkbook();
          const blob = new Blob([buf as unknown as BlobPart], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "deck-curator-template.xlsx";
          a.click();
          URL.revokeObjectURL(a.href);
        }}
      >
        Download spreadsheet template
      </button>
      <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>
        Expected columns: <em>Common Name, Scientific Name, Alternate Common Names, Family
        (Common), Family (Latin), Category, Native Status, Invasive, Rarity, Notes</em>. Category
        falls back to the sheet name for multi-sheet workbooks; unknown columns are ignored.
      </p>
      {status && (
        <p className="text-sm mt-2" data-testid="file-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
      {error && (
        <p className="text-sm mt-2" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
