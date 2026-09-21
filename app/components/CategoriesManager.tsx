import { useState } from "react";
import type { Project } from "~/lib/types";

/**
 * Category management: rename, add, and remove categories; removal reassigns
 * its species to the first remaining category. Categories are the deck's
 * study modes in the flashcards app, so a category with species can only be
 * removed after its cards are reassigned (done here automatically).
 */

export function CategoriesManager({
  project,
  onChange,
}: {
  project: Project;
  onChange: (f: (d: Project) => void) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const addCategory = () => {
    const label = newLabel.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `cat-${Date.now().toString(36)}`;
    onChange((d) => {
      if (d.categories.some((c) => c.id === id)) return;
      d.categories.push({ id, label: newLabel.trim() });
    });
    setNewLabel("");
    setAdding(false);
  };

  const removeCategory = (id: string) => {
    const count = project.species.filter((s) => s.category === id).length;
    const fallback = project.categories.find((c) => c.id !== id);
    const noun = project.categories.find((c) => c.id === id)?.label ?? id;
    const verb = count
      ? `Remove “${noun}” and move its ${count} species to “${project.categories.find((c) => c.id !== id)?.label ?? "the first category"}”?`
      : `Remove the empty category “${noun}”?`;
    if (!confirm(verb)) return;
    onChange((d) => {
      const fallback = d.categories.find((c) => c.id !== id)?.id;
      if (!fallback) return; // never leave a deck without categories
      for (const s of d.species) {
        if (s.category === id) s.category = fallback;
      }
      d.categories = d.categories.filter((c) => c.id !== id);
    });
  };

  return (
    <section className="mb-6" data-testid="categories-manager">
      <span className="label">Categories (study modes in the flashcards app)</span>
      <ul className="flex flex-wrap items-center gap-2">
        {project.categories.map((c) => {
          const count = project.species.filter((s) => s.category === c.id).length;
          return (
            <li
              key={c.id}
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm bg-white"
              style={{ borderColor: "var(--border)" }}
              data-testid={`category-${c.id}`}
            >
              {editingId === c.id ? (
                <input
                  autoFocus
                  className="field !py-0.5 !px-2 !w-28 text-sm"
                  defaultValue={c.label}
                  aria-label={`Rename category ${c.label}`}
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    if (label) onChange((d) => { const t = d.categories.find((x) => x.id === c.id); if (t) t.label = label; });
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  className="underline-offset-2 hover:underline"
                  onClick={() => setEditingId(c.id)}
                  title="Rename"
                  data-testid={`rename-${c.id}`}
                >
                  {c.label}
                </button>
              )}
              <span className="text-xs" style={{ color: "var(--muted)" }}>{count}</span>
              {project.categories.length > 1 && (
                <button
                  className="text-xs"
                  style={{ color: "var(--danger)" }}
                  onClick={() => removeCategory(c.id)}
                  aria-label={`Remove category ${c.label}`}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
        <li>
          {adding ? (
            <span className="inline-flex items-center gap-1">
              <input
                autoFocus
                className="field !py-0.5 !px-2 !w-36 text-sm"
                placeholder="Category name"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addCategory();
                  if (e.key === "Escape") setAdding(false);
                }}
                aria-label="New category name"
                data-testid="new-category-input"
              />
              <button className="btn-primary !py-0.5 !px-2 text-xs" onClick={addCategory}>
                Add
              </button>
            </span>
          ) : (
            <button className="btn-secondary !py-0.5 !px-2 text-xs" onClick={() => setAdding(true)} data-testid="add-category">
              + Category
            </button>
          )}
        </li>
      </ul>
    </section>
  );
}
