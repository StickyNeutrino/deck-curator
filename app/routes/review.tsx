import type { Route } from "./+types/review";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { getProject, listFiles } from "~/lib/store";
import type { Project } from "~/lib/types";
import { CardFront, CardBack, type BlobResolver } from "~/components/CardPreview";

/**
 * Whole-deck review: every card laid out front and back in one long grid so
 * a curator can scan for typos, bad crops, missing credits, and layout
 * issues without flipping through the study view.
 */

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — review" }];
}

export default function ReviewPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [blobMap, setBlobMap] = useState<Map<string, Blob>>(new Map());

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId).then((p) => setProject(p ?? null));
    void listFilesThenSet(projectId, setBlobMap);
  }, [projectId]);

  const resolve: BlobResolver = useCallback(
    async (fileKey) => blobMap.get(fileKey),
    [blobMap],
  );

  if (!project) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <p>Loading…</p>
      </main>
    );
  }

  const grouped = project.categories
    .map((category) => ({
      category,
      species: project.species.filter((s) => s.category === category.id),
    }))
    .filter((group) => group.species.length > 0);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8">
      <nav className="mb-6 text-sm">
        <Link to={`/project/${projectId}`} className="underline" style={{ color: "var(--muted)" }}>
          ← {project.deckLabel}
        </Link>
      </nav>
      <header className="mb-8">
        <h1 className="text-2xl font-bold">{project.deckLabel}</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }} data-testid="review-summary">
          {project.species.length} cards · {blobMap.size} photo file{blobMap.size === 1 ? "" : "s"} —
          front above, back below. Scan for typos, missing photos, and bad crops.
        </p>
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
              <figure key={s.id} data-testid={`review-card-${s.id}`} className="space-y-3">
                <CardFront species={s} resolve={resolve} />
                <CardBack species={s} />
                <figcaption className="text-xs text-center" style={{ color: "var(--muted)" }}>
                  {s.commonName || s.sciName}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
      {project.species.length === 0 && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          This deck has no species yet.
        </p>
      )}
    </main>
  );
}

async function listFilesThenSet(
  projectId: string,
  set: (files: Map<string, Blob>) => void,
): Promise<void> {
  const { listFiles } = await import("~/lib/store");
  set(await listFiles(projectId));
}
