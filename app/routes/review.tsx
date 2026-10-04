import type { Route } from "./+types/review";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { Project, SpeciesEntry } from "~/lib/types";
import { validateProject } from "~/lib/validate";
import { CardFront, CardBack, type BlobResolver } from "~/components/CardPreview";
import { allTags } from "~/components/TagsManager";
import { ProjectTabs } from "~/components/ProjectTabs";
import { useProjectDoc } from "~/lib/useProjectDoc";
import { createBlobLoader } from "~/lib/blobLoader";

/**
 * Whole-deck review: every card laid out front and back in one long grid so
 * a curator can scan for typos, bad crops, missing credits, and layout
 * issues without flipping through the study view.
 */

/** How many photos' worth of fileKeys the page pins to the head of the load
 *  queue — the first screen of cards, so they never wait behind the deck. */
const HEAD_WARM_KEYS = 12;

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — review" }];
}

export default function ReviewPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { project, notFound, loadError, saveError, update } = useProjectDoc(projectId);
  // Photos load through a prioritized queue instead of one big all-or-nothing
  // read: the first cards land first, the rest fill in as they scroll close
  // to the viewport, and warm blobs (e.g. after a round trip to the editor)
  // render immediately from memory.
  const blobLoader = useMemo(() => createBlobLoader(projectId ?? ""), [projectId]);
  const [filter, setFilter] = useState<"all" | "flagged" | "issues" | "tag">("all");
  const [tagFilter, setTagFilter] = useState<string>("");

  // Restore the active filter when coming back from the editor via ?filter=.
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const urlFilter = params.get("filter");
  const urlTag = params.get("tag") ?? "";
  useEffect(() => {
    if (urlFilter === "flagged" || urlFilter === "issues") {
      setFilter(urlFilter);
    } else if (urlFilter === "tag" && urlTag) {
      setTagFilter(urlTag);
      setFilter("tag");
    }
    // Run once per mount (i.e. once per navigation back from the editor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const resolve: BlobResolver = useCallback(
    (fileKey) => blobLoader.resolve(fileKey),
    [blobLoader],
  );

  // Toggle the curator-only "needs review" flag; autosaves like any edit.
  const toggleFlag = useCallback(
    (speciesId: string) => {
      update((next) => {
        const target = next.species.find((s) => s.id === speciesId);
        if (!target) return;
        target.needsReview = !target.needsReview;
      });
    },
    [update],
  );

  // All hooks run on every render — the early return below must not change
  // the hook count (that crashed the page whenever the project loaded late).
  // Whole-deck validation (missing photos, credits, licenses…) — the same
  // report the export page shows, so problems can be fixed before exporting.
  const issues = useMemo(() => (project ? validateProject(project) : []), [project]);
  const issueCountBySpecies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      if (issue.speciesId) counts.set(issue.speciesId, (counts.get(issue.speciesId) ?? 0) + 1);
    }
    return counts;
  }, [issues]);

  const grouped = useMemo(() => {
    if (!project) return [];
    const matches = (s: SpeciesEntry): boolean => {
      if (filter === "flagged") return Boolean(s.needsReview);
      if (filter === "issues") return issueCountBySpecies.has(s.id);
      if (filter === "tag") return (s.tags ?? []).includes(tagFilter);
      return true;
    };
    return project.categories
      .map((category) => ({
        category,
        species: project.species.filter((s) => s.category === category.id && matches(s)),
      }))
      .filter((group) => group.species.length > 0);
  }, [project, filter, tagFilter, issueCountBySpecies]);

  const flaggedCount = project?.species.filter((s) => s.needsReview).length ?? 0;
  const issueCards = issueCountBySpecies.size;

  // The first screen of cards, in display order, pinned to the head of the
  // load queue so they start downloading before any scroll observation or
  // filter change can reshuffle things. (Photos further down load on demand
  // via CardPreview's viewport gate.)
  const headFileKeys = useMemo(() => {
    const keys: string[] = [];
    for (const { species } of grouped) {
      for (const s of species) {
        for (const p of s.photos) {
          if (p.fileKey) keys.push(p.fileKey);
          if (keys.length >= HEAD_WARM_KEYS) return keys;
        }
      }
    }
    return keys;
  }, [grouped]);
  useEffect(() => {
    blobLoader.prioritize(headFileKeys);
  }, [blobLoader, headFileKeys]);

  // Where the editor should send the user back to: the review page with the
  // current filter intact, or the deck list when arriving from elsewhere.
  const reviewReturnTo = useMemo(
    () =>
      filter === "all"
        ? undefined
        : filter === "tag"
          ? `review?filter=tag&tag=${encodeURIComponent(tagFilter)}`
          : `review?filter=${filter}`,
    [filter, tagFilter],
  );
  const speciesEditUrl = useCallback(
    (speciesId: string) => {
      const back = reviewReturnTo ? `?returnTo=${encodeURIComponent(reviewReturnTo)}` : "";
      return `/project/${projectId}/species/${speciesId}${back}`;
    },
    [projectId, reviewReturnTo],
  );
  const totalCount = project?.species.length ?? 0;
  const tags = useMemo(() => (project ? allTags(project) : []), [project]);

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
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      {saveError && (
        <p className="text-sm mb-3" role="alert" style={{ color: "var(--danger)" }}>
          {saveError}
        </p>
      )}
      <ProjectTabs projectId={projectId ?? ""} active="review" />
      <header className="mt-6 mb-6">
        <h1 className="text-2xl font-bold">{project?.deckLabel ?? "Loading…"}</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }} data-testid="review-summary">
          {totalCount} cards — front above, back below. Click a card to edit it; flag
          cards that need another pass with the ⚑ button, and use ⚠ Needs fixing to
          find cards with missing photos, credits, or licenses.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3" data-testid="review-filters">
          <button
            className={`btn text-sm ${filter === "all" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setFilter("all")}
            data-testid="filter-all"
          >
            All ({totalCount})
          </button>
          <button
            className={`btn text-sm ${filter === "issues" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setFilter("issues")}
            data-testid="filter-issues"
            title="Cards with missing photos, credits, licenses, or categories"
          >
            ⚠ Needs fixing ({issueCards})
          </button>
          <button
            className={`btn text-sm ${filter === "flagged" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setFilter("flagged")}
            data-testid="filter-flagged"
          >
            ⚑ Needs review ({flaggedCount})
          </button>
          {tags.length > 0 && (
            <select
              className="field !w-auto text-xs"
              value={filter === "tag" ? tagFilter : ""}
              onChange={(e) => {
                setTagFilter(e.target.value);
                setFilter(e.target.value ? "tag" : "all");
              }}
              aria-label="Filter by tag"
              data-testid="review-tag-filter"
            >
              <option value="">Filter by tag…</option>
              {tags.map(({ tag, count }) => (
                <option key={tag} value={tag}>
                  {tag} ({count})
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {grouped.map(({ category, species }) => (
        <section key={category.id} className="mb-12" data-testid={`review-category-${category.id}`}>
          <h2 className="font-semibold mb-4">{category.label}</h2>
          <div
            className="grid gap-6"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
            data-testid="review-grid"
          >
            {species.map((s) => (
              <figure key={s.id} data-testid={`review-card-${s.id}`} className="space-y-2">
                <div className="relative">
                  <button
                    className="absolute top-2 right-2 z-10 rounded-full bg-white/90 border px-2 py-1 text-xs cursor-pointer shadow"
                    style={{
                      borderColor: s.needsReview ? "var(--accent)" : "var(--border)",
                      color: s.needsReview ? "var(--accent)" : "var(--muted)",
                      fontWeight: s.needsReview ? 700 : 400,
                    }}
                    onClick={() => toggleFlag(s.id)}
                    title={s.needsReview ? "Unflag: looks good" : "Flag for review"}
                    data-testid={`flag-${s.id}`}
                  >
                    ⚑
                  </button>
                  <button
                    className="block w-full text-left cursor-zoom-in"
                    onClick={() => navigate(speciesEditUrl(s.id))}
                    title="Edit this card"
                    data-testid={`edit-card-${s.id}`}
                  >
                    <CardFront species={s} resolve={resolve} />
                    <div className="mt-2">
                      <CardBack species={s} />
                    </div>
                  </button>
                </div>
                <figcaption className="text-xs text-center" style={{ color: "var(--muted)" }}>
                  {s.commonName || s.sciName}
                  {s.needsReview && (
                    <span className="ml-1 font-semibold" style={{ color: "var(--accent)" }}>
                      ⚑ needs review
                    </span>
                  )}
                  {issueCountBySpecies.has(s.id) && (
                    <button
                      className="ml-1 font-semibold cursor-pointer underline"
                      style={{ color: "var(--danger)" }}
                      onClick={() => navigate(speciesEditUrl(s.id))}
                      title={issues
                        .filter((i) => i.speciesId === s.id)
                        .map((i) => i.message)
                        .join("\n")}
                      data-testid={`issues-${s.id}`}
                    >
                      ⚠ {issueCountBySpecies.get(s.id)} issue{issueCountBySpecies.get(s.id)! > 1 ? "s" : ""}
                    </button>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
      {project != null && project.species.length === 0 && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          This deck has no species yet.
        </p>
      )}
      {project != null && project.species.length > 0 && grouped.length === 0 && (
        <p className="text-sm" style={{ color: "var(--muted)" }} data-testid="review-empty-filter">
          Nothing matches this filter.
        </p>
      )}
    </main>
  );
}
