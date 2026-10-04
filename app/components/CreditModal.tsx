import { useEffect, useState } from "react";
import type { PhotoCredit } from "~/lib/types";
import { UPLOAD_LICENSES } from "~/lib/types";
import { cachedGetFile } from "~/lib/store";

/**
 * Photo credit editor — the attribution and copyright info that ships with
 * every photo: the copyright holder (photographer), the license, and an
 * optional source link. Used two ways: as the prompt when files are uploaded
 * (uploads would otherwise land with the "You" placeholder credit), and
 * behind each photo's "credit" button on the species page.
 */

const LICENSE_LABELS: Record<string, string> = {
  "cc0": "CC0 (public domain)",
  "cc-by": "CC BY",
  "cc-by-sa": "CC BY-SA",
  "cc-by-nc": "CC BY-NC (non-commercial)",
  "cc-by-nc-sa": "CC BY-NC-SA (non-commercial)",
  "cc-by-nd": "CC BY-ND",
  "cc-by-nc-nd": "CC BY-NC-ND (non-commercial)",
  "all-rights-reserved": "All rights reserved",
};

/** What an upload carries when the curator skips the credit prompt. */
export const UPLOAD_DEFAULT_CREDIT: PhotoCredit = { observer: "You", license: "all-rights-reserved" };

export function CreditModal({
  heading,
  note,
  initial,
  projectId,
  fileKey,
  saveLabel = "Save",
  onSave,
  onClose,
}: {
  heading: string;
  note?: string;
  /** Starting values: the slot's current credit, or the upload default. */
  initial: PhotoCredit;
  /** Photo preview, so the dialog shows which photo is being credited. */
  projectId?: string;
  fileKey?: string;
  saveLabel?: string;
  onSave: (credit: PhotoCredit) => void;
  onClose: () => void;
}) {
  const placeholderObserver = !initial.observer || initial.observer === "You";
  const [observer, setObserver] = useState(placeholderObserver ? "" : initial.observer);
  const [license, setLicense] = useState(initial.license || "all-rights-reserved");
  const [sourceUrl, setSourceUrl] = useState(initial.sourceUrl ?? "");
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !fileKey) return;
    let url: string | null = null;
    let cancelled = false;
    void cachedGetFile(projectId, fileKey).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setSrc(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, fileKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    // Blank name keeps the previous value (the "You" placeholder for fresh
    // uploads) — export validation flags it until the real name is set.
    // iNat-only fields (observation id, place) ride along untouched.
    onSave({
      ...initial,
      observer: observer.trim() || initial.observer || "You",
      license,
      sourceUrl: sourceUrl.trim() || undefined,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="credit-modal"
    >
      <div className="rounded-lg bg-white p-5 max-w-md w-full" role="dialog" aria-label={heading}>
        <h2 className="font-semibold mb-1">{heading}</h2>
        {note && (
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
            {note}
          </p>
        )}
        {src && <img src={src} alt="" className="block w-24 rounded mb-3" data-testid="credit-modal-thumb" />}
        <label className="block text-sm mb-3">
          <span className="label">Photographer / copyright holder</span>
          <input
            className="field"
            value={observer}
            placeholder="e.g. your name"
            autoFocus
            onChange={(e) => setObserver(e.target.value)}
            data-testid="credit-observer"
          />
        </label>
        <label className="block text-sm mb-3">
          <span className="label">License</span>
          <select
            className="field"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            data-testid="credit-license"
          >
            {UPLOAD_LICENSES.map((code) => (
              <option key={code} value={code}>{LICENSE_LABELS[code] ?? code}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm mb-3">
          <span className="label">Source link (optional)</span>
          <input
            className="field"
            value={sourceUrl}
            placeholder="https://…"
            onChange={(e) => setSourceUrl(e.target.value)}
            data-testid="credit-source-url"
          />
        </label>
        <div className="flex gap-2 mt-4">
          <button className="btn-primary" onClick={save} data-testid="credit-save">
            {saveLabel}
          </button>
          <button className="btn-secondary ml-auto" onClick={onClose} data-testid="credit-cancel">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}