import type { Route } from "./+types/project";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { getProject, saveProject } from "~/lib/store";
import type { Project, SpeciesEntry } from "~/lib/types";
import { AddSpeciesModal } from "~/components/AddSpeciesModal";
import { serializeProjectFile, parseProjectFile } from "~/lib/projectFile";
import { makeId } from "~/lib/ids";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: "Deck Curator — project" }];
}

export default function ProjectPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId).then((p) => {
      if (p) setProject(p);
      else setNotFound(true);
    });
  }, [projectId]);

  // Autosave on every project change (store sets updatedAt).
  const update = useCallback(
    (mutate: (draft: Project) => void) => {
      setProject((current) => {
        if (!current) return current;
        const draft = structuredClone(current);
        mutate(draft);
        void saveProject(draft);
        return draft;
      });
    },
    [],
  );

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Project not found.</p>
        <Link to="/" className="btn-secondary mt-4 inline-flex">Back to all decks</Link>
      </main>
    );
  }
  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-6 text-sm">
        <Link to="/" className="underline" style={{ color: "var(--muted)" }}>
          ← All decks
        </Link>
      </nav>
      <ProjectHeader project={project} onChange={update} />
      <SpeciesTable
        project={project}
        onAdd={() => setShowAdd(true)}
        onEdit={(id) => navigate(`/project/${project.id}/species/${id}`)}
        onChange={update}
        onDownloadTemplate={() => void downloadTemplate()}
      />
      {showAdd && (
        <AddSpeciesModal
          project={project}
          onChange={update}
          onClose={() => setShowAdd(false)}
        />
      )}
      <div className="mt-8 flex flex-wrap gap-2 border-t pt-6" style={{ borderColor: "var(--border)" }}>
        <button
          className="btn-primary"
          data-testid="go-export"
          onClick={() => navigate(`/project/${project.id}/export`)}
        >
          Review &amp; export deck…
        </button>
        <button
          className="btn-secondary"
          onClick={async () => {
            const json = await serializeProjectFile(project);
            const blob = new Blob([json], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${makeId(project.name)}.deckcurator.json`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Save project file
        </button>
        <LoadProjectButton
          onLoaded={(loaded) => navigate(`/project/${loaded.id}`)}
        />
      </div>
    </main>
  );
}

export async function downloadTemplate() {
  const { templateWorkbook } = await import("~/lib/importSpreadsheet");
  const buf = templateWorkbook();
  const blob = new Blob([buf as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deck-curator-template.xlsx";
  a.click();
  URL.revokeObjectURL(a.href);
}

export function LoadProjectButton({ onLoaded }: { onLoaded: (p: Project) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".json,.deckcurator,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const project = await parseProjectFile(await file.text());
            await saveProject(project);
            onLoaded(project);
          } catch (err) {
            alert(`Could not open project file: ${err instanceof Error ? err.message : err}`);
          }
          e.target.value = "";
        }}
      />
      <button className="btn-secondary" onClick={() => ref.current?.click()}>
        Open project file…
      </button>
    </>
  );
}

function ProjectHeader({ project, onChange }: { project: Project; onChange: (f: (d: Project) => void) => void }) {
  return (
    <header className="mb-6">
      <input
        className="w-full text-2xl font-bold bg-transparent border-b focus:outline-none py-1"
        style={{ borderColor: "var(--border)" }}
        value={project.deckLabel}
        aria-label="Deck label"
        data-testid="deck-label"
        onChange={(e) => onChange((d) => { d.deckLabel = e.target.value; })}
      />
      <textarea
        className="w-full text-sm bg-transparent border rounded mt-2 p-2"
        rows={2}
        placeholder="Description shown in the flashcards app…"
        value={project.description}
        aria-label="Deck description"
        onChange={(e) => onChange((d) => { d.description = e.target.value; })}
      />
    </header>
  );
}

function SpeciesTable({
  project,
  onAdd,
  onEdit,
  onChange,
  onDownloadTemplate,
}: {
  project: Project;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onChange: (f: (d: Project) => void) => void;
  onDownloadTemplate: () => void;
}) {
  const [filter, setFilter] = useState("");
  const catLabel = useMemo(() => {
    const m = new Map(project.categories.map((c) => [c.id, c.label]));
    return (id: string) => m.get(id) ?? id;
  }, [project.categories]);

  const visible = project.species.filter((s) =>
    !filter ||
    s.commonName.toLowerCase().includes(filter.toLowerCase()) ||
    s.sciName.toLowerCase().includes(filter.toLowerCase()));

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className="btn-primary" data-testid="add-species" onClick={onAdd}>
          + Add species
        </button>
        <input
          className="field"
          style={{ maxWidth: 220 }}
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter species"
        />
        <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>
          {project.species.length} species
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-white" style={{ borderColor: "var(--border)" }}>
        <table className="w-full text-sm" data-testid="species-table">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              <th className="px-3 py-2">Photos</th>
              <th className="px-3 py-2">Common name</th>
              <th className="px-3 py-2">Scientific name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ borderColor: "var(--border)" }}>
            {visible.map((s) => (
              <tr key={s.id} className="hover:bg-[var(--accent-soft)]" data-testid="species-row">
                <td className="px-3 py-2">
                  <PhotoThumbs species={s} />
                </td>
                <td className="px-3 py-2">
                  <button className="font-medium underline-offset-2 hover:underline" onClick={() => onEdit(s.id)} data-testid={`edit-${s.id}`}>
                    {s.commonName || s.sciName || <em>(unnamed)</em>}
                  </button>
                </td>
                <td className="px-3 py-2 italic">{s.sciName}</td>
                <td className="px-3 py-2">{catLabel(s.category)}</td>
                <td className="px-3 py-2">
                  <select
                    className="field !py-1 !px-2 !w-auto text-xs"
                    value={s.native}
                    onChange={(e) => onChange((d) => {
                      const target = d.species.find((x) => x.id === s.id);
                      if (target) target.native = e.target.value as SpeciesEntry["native"];
                    })}
                    aria-label={`Native status of ${s.commonName}`}
                  >
                    <option value="unknown">—</option>
                    <option value="native">Native</option>
                    <option value="non-native">Non-native</option>
                  </select>
                  <label className="ml-2 inline-flex items-center gap-1 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.invasive}
                      onChange={(e) => onChange((d) => {
                        const target = d.species.find((x) => x.id === s.id);
                        if (target) target.invasive = e.target.checked;
                      })}
                      aria-label={`Invasive: ${s.commonName}`}
                    />
                    invasive
                  </label>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    className="text-xs underline"
                    style={{ color: "var(--danger)" }}
                    onClick={() => {
                      if (confirm(`Remove ${s.commonName || s.sciName || "this species"}?`)) {
                        onChange((d) => {
                          const idx = d.species.findIndex((x) => x.id === s.id);
                          if (idx >= 0) d.species.splice(idx, 1);
                        });
                      }
                    }}
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center" style={{ color: "var(--muted)" }}>
                  {project.species.length === 0 ? (
                    <span data-testid="empty-species">
                      No species yet —{" "}
                      <button className="underline" onClick={onAdd}>add some</button>, or{" "}
                      <button className="underline" onClick={onDownloadTemplate}>get the spreadsheet template</button>.
                    </span>
                  ) : (
                    "No matches."
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PhotoThumbs({ species }: { species: SpeciesEntry }) {
  return (
    <span className="text-xs" style={{ color: "var(--muted)" }} title={`${species.photos.length} photo(s), ${species.layout}`}>
      {species.inatResolved ? "✓ " : ""}{species.photos.length} 📷
    </span>
  );
}
