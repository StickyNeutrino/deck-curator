import { useState } from "react";
import {
  INAT_ALLOWED_LICENSES,
  type InatSearchSettings,
} from "~/lib/types";

const LICENSE_LABELS: Record<string, string> = {
  "cc0": "CC0 (public domain)",
  "cc-by": "CC BY",
  "cc-by-sa": "CC BY-SA",
  "cc-by-nc": "CC BY-NC (non-commercial)",
  "cc-by-nc-sa": "CC BY-NC-SA (non-commercial)",
};

/**
 * Shared iNaturalist search constraints: which licenses the deck accepts
 * (exclude NC variants for a commercially sellable deck) and whether to
 * require research-grade observations. Advanced options (media types,
 * ordering) collapse under a disclosure.
 */
export function InatSearchSettingsPanel({
  settings,
  onChange,
}: {
  settings: InatSearchSettings;
  onChange: (next: InatSearchSettings) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const toggleLicense = (code: string) => {
    const set = new Set(settings.licenses);
    if (set.has(code as never)) {
      // Never allow removing the last license — an empty search helps nobody.
      if (set.size === 1) return;
      set.delete(code as never);
    } else {
      set.add(code as never);
    }
    onChange({ ...settings, licenses: INAT_ALLOWED_LICENSES.filter((c) => set.has(c)) });
  };
  const commercialOk = !settings.licenses.some((c) => c.includes("nc"));

  return (
    <div className="mb-3 text-sm" data-testid="inat-search-settings">
      <span className="label">Accepted photo licenses</span>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1">
        {INAT_ALLOWED_LICENSES.map((code) => (
          <label key={code} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.licenses.includes(code)}
              onChange={() => toggleLicense(code)}
              data-testid={`inat-license-${code}`}
            />
            {LICENSE_LABELS[code] ?? code}
          </label>
        ))}
      </div>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {commercialOk
          ? "Non-commercial licenses excluded — the deck could be sold commercially."
          : "Includes non-commercial (NC) licenses — the deck is for personal/educational use only."}
      </p>
      <label className="inline-flex items-center gap-2 cursor-pointer mt-2">
        <input
          type="checkbox"
          checked={settings.researchGrade}
          onChange={(e) => onChange({ ...settings, researchGrade: e.target.checked })}
          data-testid="inat-research-grade"
        />
        Research-grade observations only
      </label>
      <div className="mt-1">
        <button
          type="button"
          className="text-xs underline"
          style={{ color: "var(--muted)" }}
          onClick={() => setShowAdvanced((v) => !v)}
          data-testid="inat-advanced-toggle"
        >
          {showAdvanced ? "− Hide advanced" : "+ Advanced search options"}
        </button>
        {showAdvanced && (
          <div className="mt-2 flex flex-col gap-2 pl-4 border-l-2" style={{ borderColor: "var(--border)" }}>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.includeMedia}
                onChange={(e) => onChange({ ...settings, includeMedia: e.target.checked })}
                data-testid="inat-include-media"
              />
              Include animated GIFs &amp; video clips
            </label>
            <label className="inline-flex items-center gap-2">
              Photo order{" "}
              <select
                className="field !w-auto !py-1 inline-block"
                value={settings.orderBy}
                onChange={(e) => onChange({ ...settings, orderBy: e.target.value as InatSearchSettings["orderBy"] })}
                data-testid="inat-order-by"
              >
                <option value="license">Permissive licenses first</option>
                <option value="votes">Most-voted first</option>
              </select>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
