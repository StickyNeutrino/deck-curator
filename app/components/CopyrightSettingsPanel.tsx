import { INAT_ALLOWED_LICENSES, type LicenseCode } from "~/lib/types";

const LICENSE_LABELS: Record<string, string> = {
  "cc0": "CC0 (public domain)",
  "cc-by": "CC BY",
  "cc-by-sa": "CC BY-SA",
  "cc-by-nc": "CC BY-NC (non-commercial)",
  "cc-by-nc-sa": "CC BY-NC-SA (non-commercial)",
};

/**
 * The deck's accepted photo licenses — its deck-wide copyright limits.
 * These govern everything that lands on a card: iNaturalist picks (when the
 * search follows the deck's limits), uploads, and the review-page checks.
 * Deliberately separate from the iNaturalist search filters, which only
 * decide what a search offers.
 */
export function CopyrightSettingsPanel({
  licenses,
  onChange,
}: {
  licenses: LicenseCode[];
  onChange: (next: LicenseCode[]) => void;
}) {
  const toggleLicense = (code: LicenseCode) => {
    const set = new Set(licenses);
    if (set.has(code)) {
      // Never allow removing the last license — an empty policy helps nobody.
      if (set.size === 1) return;
      set.delete(code);
    } else {
      set.add(code);
    }
    onChange(INAT_ALLOWED_LICENSES.filter((c) => set.has(c)));
  };
  const commercialOk = !licenses.some((c) => c.includes("nc"));

  return (
    <div className="mb-3 text-sm" data-testid="copyright-settings">
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-1">
        {INAT_ALLOWED_LICENSES.map((code) => (
          <label key={code} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={licenses.includes(code)}
              onChange={() => toggleLicense(code)}
              data-testid={`deck-license-${code}`}
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
    </div>
  );
}
