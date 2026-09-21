import { useEffect, useState } from "react";
import type { PhotoSlot } from "~/lib/types";
import { getFile } from "~/lib/store";

/**
 * "Which photo should this replace?" — shown when the card is already at its
 * photo cap and the curator picks a new one. Choosing a slot swaps that
 * photo out; Cancel aborts the add.
 */

export function ReplacePicker({
  projectId,
  photos,
  onPick,
  onCancel,
}: {
  projectId: string;
  photos: PhotoSlot[];
  onPick: (index: number) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      data-testid="replace-picker"
    >
      <div className="rounded-lg bg-white p-5 max-w-lg w-full" role="dialog" aria-label="Choose a photo to replace">
        <h2 className="font-semibold mb-1">Card is full</h2>
        <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
          Which photo should the new one replace?
        </p>
        <ul className="flex gap-3 mb-4">
          {photos.map((slot, i) => (
            <li key={slot.id}>
              <button
                className="block rounded overflow-hidden border-2 border-transparent hover:border-[var(--accent)]"
                onClick={() => onPick(i)}
                data-testid={`replace-slot-${i}`}
                title={`Replace this photo (© ${slot.credit.observer})`}
              >
                <ReplaceThumb projectId={projectId} fileKey={slot.fileKey} />
                <span className="block text-xs py-1">
                  {slot.role === "main" ? "Main" : `Secondary ${i}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ReplaceThumb({ projectId, fileKey }: { projectId: string; fileKey: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void getFile(projectId, fileKey).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setSrc(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, fileKey]);
  if (!src) return <span className="block w-20 h-15 bg-[#cfcecb]" style={{ height: 60, width: 80 }} />;
  return <img src={src} alt="" className="object-cover" style={{ height: 60, width: 80 }} />;
}
