import type { Route } from "./+types/info";
import { Link, useNavigate, useParams } from "react-router";
import { useCallback, useState } from "react";
import { ProjectTabs } from "~/components/ProjectTabs";
import { LocationPicker } from "~/components/LocationPicker";
import { CategoriesManager } from "~/components/CategoriesManager";
import { TagsManager } from "~/components/TagsManager";
import { InatSearchSettingsPanel } from "~/components/InatSearchSettingsPanel";
import { searchSettingsOf } from "~/lib/types";
import { useProjectDoc } from "~/lib/useProjectDoc";
import { useAutoVersion } from "~/lib/useAutoVersion";
import { listProjects, renameProject } from "~/lib/store";
import { renameRepo } from "~/lib/versioning";

/**
 * Deck info: everything about the deck itself — name and id, description,
 * its location, category taxonomy, tags, and the iNaturalist search
 * constraints (licenses, research grade) that govern photo picking
 * everywhere — kept off the card-editing screen so the map and metadata
 * don't crowd the species work.
 */

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — deck info" }];
}

export default function InfoPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { project, setProject, notFound, loadError, saveError, update } = useProjectDoc(projectId);
  // Deck-info edits autosave to version history like any other tab.
  const versionError = useAutoVersion(projectId);

  // The deck id is the store key for the record, the photo files, and the
  // git repo — editing it per keystroke would duplicate decks and break
  // every photo. It commits as an explicit, validated rename that migrates
  // everything, and moves the page to the new id.
  const [idDraft, setIdDraft] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const commitId = useCallback(async () => {
    if (!project || idDraft === null) return;
    const newId = idDraft.trim();
    setIdDraft(null);
    setIdentityError(null);
    if (!newId || newId === project.id) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(newId)) {
      setIdentityError("Ids are lowercase letters, numbers, and dashes.");
      return;
    }
    try {
      const taken = (await listProjects()).some((p) => p.id === newId);
      if (taken) {
        setIdentityError(`Another deck already uses the id “${newId}” — pick a different one.`);
        return;
      }
      setRenaming(true);
      const next = { ...project, id: newId };
      await renameProject(project.id, next); // files + record move atomically
      try {
        await renameRepo(project.id, newId); // the git history follows the deck
      } catch {
        setIdentityError("Deck renamed, but its version history could not be moved — new versions start from here.");
      }
      setProject(next);
      navigate(`/project/${newId}/info`, { replace: true });
    } catch (err) {
      setIdentityError(`Rename failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setRenaming(false);
    }
  }, [project, idDraft, navigate, setProject]);

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
    <main className="mx-auto max-w-4xl px-4 py-8">
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
        <label className="block mb-3">
          <span className="label">Deck id (slug)</span>
          <input
            className="field font-mono"
            style={{ maxWidth: 320 }}
            value={idDraft ?? project.id}
            disabled={renaming}
            aria-label="Deck id"
            data-testid="deck-id"
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={() => void commitId()}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void commitId(); } }}
          />
        </label>
        {identityError && (
          <p className="text-sm mb-3" role="alert" style={{ color: "var(--danger)" }} data-testid="identity-error">
            {identityError}
          </p>
        )}
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
          The id tells decks apart in the flashcards app, so it has to be unique. Changing it moves
          the deck's photos and version history with it. It saves when you click away or press
          Enter.
        </p>
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

      <section className="mb-6" data-testid="deck-inat-settings">
        <span className="label">iNaturalist search — licenses and filters for photo picking deck-wide</span>
        <InatSearchSettingsPanel
          settings={searchSettingsOf(project)}
          onChange={(next) => update((d) => { d.inatSearch = next; })}
        />
      </section>

      <CategoriesManager project={project} onChange={update} />
      <TagsManager project={project} onChange={update} />
    </main>
  );
}
