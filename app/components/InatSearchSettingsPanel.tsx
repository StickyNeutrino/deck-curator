import { useState } from "react";
import { Link } from "react-router";
import type { InatSearchSettings } from "~/lib/types";

/**
 * The iNaturalist search filters — what one search offers. The checkbox ties
 * the search to the deck's accepted licenses (its deck-wide copyright limits,
 * edited on the Deck info tab); unticked, the search offers everything iNat
 * allows (ND variants and unlicensed photos are still never offered) and the
 * review page flags cards that drift outside the deck's policy. Advanced
 * options (media types, ordering) collapse under a disclosure.
 */
export function InatSearchSettingsPanel({
  settings,
  onChange,
  /** Link to the deck's accepted licenses — shown where the license list
   *  itself isn't visible (the search UIs; the Deck info tab has it above). */
  licensesHref,
}: {
  settings: InatSearchSettings;
  onChange: (next: InatSearchSettings) => void;
  licensesHref?: string;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Rebuild explicitly rather than spreading: callers may hand us a search
  // scope (settings + licenses), and a stale licenses key must never leak
  // back into the record's search settings.
  const change = (patch: Partial<InatSearchSettings>): InatSearchSettings => ({
    useDeckLicenses: settings.useDeckLicenses,
    researchGrade: settings.researchGrade,
    includeMedia: settings.includeMedia,
    orderBy: settings.orderBy,
    ...patch,
  });

  return (
    <div className="mb-3 text-sm" data-testid="inat-search-settings">
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.useDeckLicenses}
          onChange={(e) => onChange(change({ useDeckLicenses: e.target.checked }))}
          data-testid="inat-use-deck-licenses"
        />
        Only offer photos under the deck's accepted licenses
        {licensesHref && (
          <>
            {" — "}
            <Link to={licensesHref} className="underline">
              edit them in Deck info
            </Link>
          </>
        )}
      </label>
      <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
        {settings.useDeckLicenses
          ? "The search stays inside the deck's copyright limits."
          : "Browsing every license iNat allows — cards with photos outside the deck's accepted licenses are flagged on the review page."}
      </p>
      <label className="inline-flex items-center gap-2 cursor-pointer mt-2">
        <input
          type="checkbox"
          checked={settings.researchGrade}
          onChange={(e) => onChange(change({ researchGrade: e.target.checked }))}
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
                onChange={(e) => onChange(change({ includeMedia: e.target.checked }))}
                data-testid="inat-include-media"
              />
              Include animated GIFs & video clips
            </label>
            <label className="inline-flex items-center gap-2">
              Photo order{" "}
              <select
                className="field !w-auto !py-1 inline-block"
                value={settings.orderBy}
                onChange={(e) => onChange(change({ orderBy: e.target.value as InatSearchSettings["orderBy"] }))}
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
