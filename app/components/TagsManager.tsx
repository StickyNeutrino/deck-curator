import { useState } from "react";
import type { Project } from "~/lib/types";

/**
 * User tags — free-form labels (phases, class sessions, units) that ride on
 * cards and are filterable. Categories stay taxonomy-driven; this is where
 * the deck's own groupings live.
 */

export function allTags(project: Project): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of project.species) {
    for (const tag of s.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function TagsManager({
  project,
  onChange,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newTag, setNewTag] = useState("");
  const tags = allTags(project);

  const addTagEverywhere = () => {
    const tag = newTag.trim();
    if (!tag) return;
    onChange((d) => {
      for (const s of d.species) {
        if (!(s.tags ?? []).includes(tag)) s.tags = [...(s.tags ?? []), tag];
      }
    });
    setNewTag("");
    setAdding(false);
  };

  const renameTag = (tag: string) => {
    const next = prompt(`Rename tag “${tag}” to:`, tag)?.trim();
    if (!next || next === tag) return;
    onChange((d) => {
      for (const s of d.species) {
        s.tags = (s.tags ?? []).map((t) => (t === tag ? next : t));
      }
    });
  };

  const removeTag = (tag: string) => {
    if (!confirm(`Remove the tag “${tag}” from all species?`)) return;
    onChange((d) => {
      for (const s of d.species) {
        s.tags = (s.tags ?? []).filter((t) => t !== tag);
      }
    });
  };

  return (
    <section className="mb-6" data-testid="tags-manager">
      <span className="label">Tags — your own groupings (phases, classes, units); filter by them anywhere</span>
      <ul className="flex flex-wrap items-center gap-2">
        {tags.map(({ tag, count }) => (
          <li
            key={tag}
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm bg-white"
            style={{ borderColor: "var(--border)" }}
            data-testid={`tag-${tag}`}
          >
            <button className="underline-offset-2 hover:underline" onClick={() => renameTag(tag)} title="Rename tag">
              {tag}
            </button>
            <span className="text-xs" style={{ color: "var(--muted)" }}>{count}</span>
            <button
              className="text-xs"
              style={{ color: "var(--danger)" }}
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
            >
              ✕
            </button>
          </li>
        ))}
        <li>
          {adding ? (
            <span className="inline-flex items-center gap-1">
              <input
                autoFocus
                className="field !py-0.5 !px-2 !w-36 text-sm"
                placeholder="Tag name"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTagEverywhere();
                  if (e.key === "Escape") setAdding(false);
                }}
                aria-label="New tag name"
                data-testid="new-tag-input"
              />
              <button className="btn-primary !py-0.5 !px-2 text-xs" onClick={addTagEverywhere}>
                Add
              </button>
            </span>
          ) : (
            <button className="btn-secondary !py-0.5 !px-2 text-xs" onClick={() => setAdding(true)} data-testid="add-tag">
              + Tag
            </button>
          )}
        </li>
        {tags.length === 0 && (
          <li className="text-xs" style={{ color: "var(--muted)" }}>
            No tags yet — add one and assign it on each species' page, or add it to everything here.
          </li>
        )}
      </ul>
    </section>
  );
}
