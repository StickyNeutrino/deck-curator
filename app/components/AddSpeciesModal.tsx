import { useEffect, useState } from "react";
import { ListTab } from "~/components/ListTab";
import { InatTab } from "~/components/InatTab";
import { FileTab } from "~/components/FileTab";
import type { Project } from "~/lib/types";

/**
 * The ways species enter a deck. The iNaturalist search leads — it's the
 * most powerful path (location + kind + native-status filters, thumbnails,
 * checkbox selection) and the default tab; typed/pasted names and the
 * spreadsheet are one click away.
 */

export type Tab = "inat" | "list" | "file";

export function AddSpeciesModal({
  project,
  onChange,
  onClose,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("inat");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      data-testid="add-species-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 mt-10 mb-10" role="dialog" aria-label="Add species">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Add species</h2>
          <button className="btn-secondary" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex gap-2 mb-5" role="tablist">
          {(
            [
              ["inat", "iNaturalist search"],
              ["list", "Type or paste names"],
              ["file", "Spreadsheet"],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`btn text-sm ${tab === id ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "inat" && <InatTab project={project} onChange={onChange} />}
        {tab === "list" && <ListTab project={project} onChange={onChange} />}
        {tab === "file" && <FileTab onChange={onChange} />}
      </div>
    </div>
  );
}
