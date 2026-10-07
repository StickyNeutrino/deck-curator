import type { Route } from "./+types/project";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AddSpeciesModal } from "~/components/AddSpeciesModal";
import { AuthorPromptModal } from "~/components/AuthorPromptModal";
import { ToolsMenu } from "~/components/ToolsMenu";
import { ProjectTabs } from "~/components/ProjectTabs";
import { BORDER_STYLES, borderStyleDef, type Project, type SpeciesEntry } from "~/lib/types";
import { useProjectDoc } from "~/lib/useProjectDoc";
import { useAutoVersion } from "~/lib/useAutoVersion";
import { ensureRepo } from "~/lib/versioning";
import { authorPromptPending, consumeAuthorPromptRequest, markAuthorAsked } from "~/lib/author";
import { allTags } from "~/components/TagsManager";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: "Deck Curator — project" }];
}

export default function ProjectPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { project, notFound, loadError, saveError, update } = useProjectDoc(projectId);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Authorship prompt: shown once per browser, when the first autosave fires
  // after a real edit. Purely opt-in — the commit always proceeds, and a
  // default author fills in when this is skipped (see lib/author).
  const [showAuthorPrompt, setShowAuthorPrompt] = useState(false);
  const everEditedRef = useRef(false);
  const handleUpdate = useCallback(
    (f: (d: Project) => void) => {
      everEditedRef.current = true;
      update(f);
    },
    [update],
  );

  // Make sure the git history exists from the moment a project opens —
  // once per project id, not on every edit.
  const repoInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project || repoInitRef.current === project.id) return;
    repoInitRef.current = project.id;
    void ensureRepo(project).catch(() => undefined);
  }, [project]);

  // A freshly created deck (the home page armed this) asks who's curating
  // right away, before any editing happens — once per opened deck.
  const creationPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!project || creationPromptRef.current === project.id) return;
    creationPromptRef.current = project.id;
    if (consumeAuthorPromptRequest() && authorPromptPending()) setShowAuthorPrompt(true);
  }, [project]);

  // Version-history autosave lives in lib/useAutoVersion: every tab's record
  // save arms the shared debounce, and leaving a page flushes what's pending.
  // This page only adds the settle hook-up — the fallback moment to ask (for
  // this session) who to stamp onto versions, for decks opened without going
  // through deck creation.
  const versionError = useAutoVersion(projectId, {
    onSettle: () => {
      if (everEditedRef.current && authorPromptPending()) setShowAuthorPrompt(true);
    },
  });

  // Selection that survives table edits: dropped ids fall out via the
  // intersection with project.species (see scopeIds below).
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p>Project not found.</p>
        <Link to="/" className="btn-secondary mt-4 inline-flex">Back to all decks</Link>
      </main>
    );
  }
  if (loadError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p role="alert" style={{ color: "var(--danger)" }}>{loadError}</p>
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
      {saveError && (
        <p className="text-sm mb-3" role="alert" style={{ color: "var(--danger)" }}>
          {saveError}
        </p>
      )}
      {versionError && (
        <p className="text-sm mb-3" role="alert" style={{ color: "var(--danger)" }}>
          {versionError}
        </p>
      )}
      <nav className="mb-4 text-sm">
        <Link to="/" className="underline" style={{ color: "var(--muted)" }}>
          ← All decks
        </Link>
      </nav>
      <ProjectTabs projectId={project.id} active="cards" />
      <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
        Editing <strong>{project.deckLabel}</strong> — deck-wide settings (name, description,
        location, categories, tags) live in the{" "}
        <Link to={`/project/${project.id}/info`} className="underline">
          Deck info
        </Link>{" "}
        tab.
      </p>
      <SpeciesTable
        project={project}
        selected={selected}
        onToggleSelected={toggleSelected}
        onSelectAll={setSelected}
        onAdd={() => setShowAdd(true)}
        onEdit={(id) => navigate(`/project/${project.id}/species/${id}`)}
        onChange={handleUpdate}
        onDownloadTemplate={() => void downloadTemplate()}
      />
      {showAdd && (
        <AddSpeciesModal
          project={project}
          onChange={handleUpdate}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showAuthorPrompt && (
        <AuthorPromptModal
          onClose={() => {
            markAuthorAsked();
            setShowAuthorPrompt(false);
          }}
        />
      )}
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

function SpeciesTable({
  project,
  selected,
  onToggleSelected,
  onSelectAll,
  onAdd,
  onEdit,
  onChange,
  onDownloadTemplate,
}: {
  project: Project;
  selected: Set<string>;
  onToggleSelected: (id: string) => void;
  onSelectAll: (ids: Set<string>) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onChange: (f: (d: Project) => void) => void;
  onDownloadTemplate: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const catLabel = useMemo(() => {
    const m = new Map(project.categories.map((c) => [c.id, c.label]));
    return (id: string) => m.get(id) ?? id;
  }, [project.categories]);
  const tags = useMemo(() => allTags(project), [project]);

  const visible = project.species.filter((s) => {
    const nameMatch =
      !filter ||
      s.commonName.toLowerCase().includes(filter.toLowerCase()) ||
      s.sciName.toLowerCase().includes(filter.toLowerCase());
    const tagMatch = tagFilter === "all" || (s.tags ?? []).includes(tagFilter);
    return nameMatch && tagMatch;
  });

  const visibleIds = useMemo(() => visible.map((s) => s.id), [visible]);
  const selectedCount = useMemo(
    () => project.species.filter((s) => selected.has(s.id)).length,
    [project.species, selected],
  );
  const visibleSelected = visibleIds.filter((id) => selected.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  const someVisibleSelected = visibleSelected > 0 && !allVisibleSelected;

  // Tools act on the selection (species still in the deck), or everything.
  const scopeIds = useMemo(
    () => [...selected].filter((id) => project.species.some((s) => s.id === id)),
    [selected, project.species],
  );

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className="btn-primary" data-testid="add-species" onClick={onAdd}>
          + Add species
        </button>
        <ToolsMenu project={project} onChange={onChange} scopeIds={scopeIds} />
        <input
          className="field"
          style={{ maxWidth: 220 }}
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter species"
        />
        <select
          className="field !w-auto text-xs"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          aria-label="Filter by tag"
          data-testid="tag-filter"
        >
          <option value="all">All tags</option>
          {tags.map(({ tag, count }) => (
            <option key={tag} value={tag}>
              {tag} ({count})
            </option>
          ))}
        </select>
        {selectedCount > 0 && (
          <>
            <button
              className="text-xs underline"
              style={{ color: "var(--muted)" }}
              onClick={() => onSelectAll(new Set())}
              data-testid="clear-selection"
              title="Clear the selection — tools then apply to the whole deck"
            >
              {selectedCount} selected · clear
            </button>
            <button
              className="text-xs underline"
              style={{ color: "var(--danger)" }}
              onClick={() => {
                if (!confirm(`Remove ${selectedCount} selected species?`)) return;
                onChange((d) => {
                  d.species = d.species.filter((s) => !selected.has(s.id));
                });
                onSelectAll(new Set());
              }}
              data-testid="remove-selected"
              title="Remove all selected species from the deck"
            >
              remove selected
            </button>
          </>
        )}
        <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>
          {visible.length}/{project.species.length} species
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-white" style={{ borderColor: "var(--border)" }}>
        <table className="w-full text-sm" data-testid="species-table">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  checked={allVisibleSelected}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) for (const id of visibleIds) next.add(id);
                    else for (const id of visibleIds) next.delete(id);
                    onSelectAll(next);
                  }}
                  aria-label="Select all filtered species"
                  data-testid="select-all"
                  title="Select all filtered species"
                />
              </th>
              <th className="px-3 py-2">Photos</th>
              <th className="px-3 py-2">Common name</th>
              <th className="px-3 py-2">Scientific name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Border</th>
              <th className="px-3 py-2">Tags</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y" style={{ borderColor: "var(--border)" }}>
            {visible.map((s) => (
              <tr key={s.id} className="hover:bg-[var(--accent-soft)]" data-testid="species-row">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => onToggleSelected(s.id)}
                    aria-label={`Select ${s.commonName || s.sciName || "unnamed"}`}
                    data-testid={`select-${s.id}`}
                  />
                </td>
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
                </td>
                <td className="px-3 py-2">
                  <select
                    className="field !py-1 !px-2 !w-auto text-xs"
                    value={s.border}
                    onChange={(e) => onChange((d) => {
                      const target = d.species.find((x) => x.id === s.id);
                      if (target) target.border = e.target.value as SpeciesEntry["border"];
                    })}
                    aria-label={`Border style of ${s.commonName}`}
                    data-testid={`border-select-${s.id}`}
                    style={s.border !== "none" ? { color: borderStyleDef(s.border).color } : undefined}
                  >
                    {BORDER_STYLES.map((style) => (
                      <option key={style.id} value={style.id}>
                        {style.id === "none" ? "no border" : style.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(s.tags ?? []).map((tag) => (
                      <span key={tag} className="text-xs rounded-full border px-2 py-0.5" style={{ borderColor: "var(--border)" }} data-testid={`row-tag-${tag}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    className="text-xs underline mr-3"
                    onClick={() => onEdit(s.id)}
                    data-testid={`edit-${s.id}`}
                  >
                    Edit
                  </button>
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
                <td colSpan={9} className="px-3 py-8 text-center" style={{ color: "var(--muted)" }}>
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
