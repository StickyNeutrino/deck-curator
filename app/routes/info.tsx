import type { Route } from "./+types/info";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { getProject, saveProject } from "~/lib/store";
import type { Project } from "~/lib/types";
import { ProjectTabs } from "~/components/ProjectTabs";
import { LocationPicker } from "~/components/LocationPicker";
import { CategoriesManager } from "~/components/CategoriesManager";
import { TagsManager } from "~/components/TagsManager";

/**
 * Deck info: everything about the deck itself — name, description, its
 * location, category taxonomy, and tags — kept off the card-editing screen
 * so the map and metadata don't crowd the species work.
 */

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — deck info" }];
}

export default function InfoPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId).then((p) => {
      if (p) setProject(p);
      else setNotFound(true);
    });
  }, [projectId]);

  // Autosave on every change (store sets updatedAt).
  const update = (mutate: (draft: Project) => void) => {
    setProject((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      mutate(draft);
      void saveProject(draft);
      return draft;
    });
  };

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
    <main className="mx-auto max-w-4xl px-4 py-8">
      <nav className="mb-4 text-sm">
        <Link to="/" className="underline" style={{ color: "var(--muted)" }}>
          ← All decks
        </Link>
      </nav>
      <ProjectTabs projectId={project.id} active="info" />

      <header className="mt-6 mb-6">
        <label className="block mb-3">
          <span className="label">Deck name — shown in the flashcards app menu</span>
          <input
            className="field text-lg font-semibold"
            value={project.deckLabel}
            aria-label="Deck label"
            data-testid="deck-label"
            onChange={(e) => update((d) => { d.deckLabel = e.target.value; })}
          />
        </label>
        <label className="block">
          <span className="label">Description — shown on the credits page</span>
          <textarea
            className="field text-sm"
            rows={2}
            placeholder="What does this deck cover?"
            value={project.description}
            aria-label="Deck description"
            onChange={(e) => update((d) => { d.description = e.target.value; })}
          />
        </label>
      </header>

      <section className="mb-6" data-testid="deck-location">
        <span className="label">Deck location — where this deck is relevant (shown with the deck)</span>
        <div style={{ maxWidth: 520 }}>
          <LocationPicker
            value={project.location}
            onChange={(loc) => update((d) => { d.location = loc; })}
          />
        </div>
      </section>

      <CategoriesManager project={project} onChange={update} />
      <TagsManager project={project} onChange={update} />
    </main>
  );
}
