import type { Route } from "./+types/species";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { getProject, saveProject, getFile, putFile, deleteFile } from "~/lib/store";
import type { Project, SpeciesEntry, CardLayout } from "~/lib/types";
import { CardFront, CardBack, type BlobResolver } from "~/components/CardPreview";
import { InatPhotoBrowser } from "~/components/InatPhotoBrowser";
import { slugify, formatAltNames, parseAltNames } from "~/lib/ids";
import { uuid } from "~/lib/uuid";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — species" }];
}

export default function SpeciesPage() {
  const { projectId, speciesId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<SpeciesEntry | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId).then((p) => setProject(p ?? null));
  }, [projectId]);

  const entry = project?.species.find((s) => s.id === speciesId) ?? null;

  // Initialize the local draft once the project has loaded.
  useEffect(() => {
    if (entry && !draft) setDraft(structuredClone(entry));
  }, [entry, draft]);

  const update = useCallback((mutate: (d: SpeciesEntry) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
    setSaved(false);
  }, []);

  const resolve: BlobResolver = useCallback(
    async (fileKey) => getFile(projectId ?? "", fileKey),
    [projectId],
  );

  const persist = useCallback(async (): Promise<Project | null> => {
    if (!draft) return null;
    const next = structuredClone(project!);
    const idx = next.species.findIndex((s) => s.id === draft.id);
    if (idx >= 0) next.species[idx] = structuredClone(draft);
    await saveProject(next);
    setProject(next);
    setSaved(true);
    return next;
  }, [draft, project]);

  if (!project) {
    return (
      <Shell backLabel="Back" backTo="/">
        <p>Loading…</p>
      </Shell>
    );
  }
  if (!entry || !draft) {
    return (
      <Shell backLabel="Back to deck" backTo={`/project/${projectId ?? ""}`}>
        <p>Species not found.</p>
      </Shell>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-4 text-sm">
        <Link to={`/project/${projectId}`} className="underline" style={{ color: "var(--muted)" }}>
          ← {project.deckLabel}
        </Link>
      </nav>

      <div className="grid md:grid-cols-[1fr_360px] gap-8">
        <section data-testid="species-editor">
          <h1 className="text-xl font-bold mb-4">
            {draft.commonName || draft.sciName || "Unnamed species"}
          </h1>

          <Fields draft={draft} project={project} onChange={update} />

          <PhotosEditor species={draft} projectId={projectId ?? ""} onChange={update} />

          <div className="flex gap-2 mt-4">
            <button className="btn-primary" onClick={() => void persist()} data-testid="save-species">
              {saved ? "Saved ✓" : "Save"}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                void persist().then(() => navigate(`/project/${projectId}`));
              }}
            >
              Save &amp; close
            </button>
            <button className="btn-secondary" onClick={() => navigate(`/project/${projectId}`)}>
              Cancel
            </button>
          </div>
        </section>

        <aside className="space-y-6">
          <h2 className="font-semibold mb-2 text-sm uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Preview
          </h2>
          <div className="mb-3">
            <CardFront species={draft} resolve={resolve} />
          </div>
          <CardBack species={draft} />
        </aside>
      </div>

      <InatPhotoBrowser species={draft} projectId={projectId ?? ""} onChange={update} />
    </main>
  );
}

function Shell({ children, backLabel, backTo }: { children: React.ReactNode; backLabel: string; backTo: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link to={backTo} className="underline text-sm" style={{ color: "var(--muted)" }}>
        ← {backLabel}
      </Link>
      <div className="mt-6">{children}</div>
    </main>
  );
}

function Fields({
  draft,
  project,
  onChange,
}: {
  draft: SpeciesEntry;
  project: Project;
  onChange: (f: (d: SpeciesEntry) => void) => void;
}) {
  return (
    <div className="grid sm:grid-cols-2 gap-3 mb-3">
      <label className="text-sm">
        <span className="label">Common name</span>
        <input
          className="field"
          value={draft.commonName}
          onChange={(e) => onChange((d) => { d.commonName = e.target.value; })}
          data-testid="common-name"
        />
      </label>
      <label className="text-sm">
        <span className="label">Scientific name</span>
        <input
          className="field italic"
          value={draft.sciName}
          onChange={(e) => onChange((d) => { d.sciName = e.target.value; })}
          data-testid="sci-name"
        />
      </label>
      <label className="text-sm">
        <span className="label">Alternate common names (; separated)</span>
        <input
          className="field"
          value={formatAltNames(draft.altNames)}
          onChange={(e) => onChange((d) => { d.altNames = parseAltNames(e.target.value); })}
        />
      </label>
      <label className="text-sm">
        <span className="label">Category</span>
        <select
          className="field"
          value={draft.category}
          onChange={(e) => onChange((d) => { d.category = e.target.value; })}
        >
          {project.categories.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="label">Family (common)</span>
        <input
          className="field"
          value={draft.familyCommon ?? ""}
          onChange={(e) => onChange((d) => { d.familyCommon = e.target.value || undefined; })}
        />
      </label>
      <label className="text-sm">
        <span className="label">Family (latin)</span>
        <input
          className="field italic"
          value={draft.familyLatin ?? ""}
          onChange={(e) => onChange((d) => { d.familyLatin = e.target.value || undefined; })}
        />
      </label>
      <label className="text-sm">
        <span className="label">Native status</span>
        <select
          className="field"
          value={draft.native}
          onChange={(e) => onChange((d) => { d.native = e.target.value as SpeciesEntry["native"]; })}
          data-testid="native-status"
        >
          <option value="unknown">Unknown</option>
          <option value="native">Native</option>
          <option value="non-native">Non-native</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="label">Rarity (e.g. CNPS 1B.2)</span>
        <input
          className="field"
          value={draft.rarity ?? ""}
          onChange={(e) => onChange((d) => { d.rarity = e.target.value || undefined; })}
        />
      </label>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={draft.invasive}
            onChange={(e) => onChange((d) => { d.invasive = e.target.checked; })}
            data-testid="invasive-checkbox"
          />
          Invasive
        </label>
        <label className="text-sm">
          Card layout{" "}
          <select
            className="field !w-auto !py-1 inline-block"
            value={draft.layout}
            onChange={(e) => onChange((d) => { d.layout = e.target.value as CardLayout; })}
            data-testid="layout-select"
          >
            <option value="photo-trio">1 main + up to 2 secondary</option>
            <option value="photo-single">1 main photo only</option>
          </select>
        </label>
        {draft.taxonId && (
          <a
            className="text-sm underline"
            style={{ color: "var(--muted)" }}
            href={`https://www.inaturalist.org/taxa/${draft.taxonId}`}
            target="_blank"
            rel="noreferrer"
          >
            iNaturalist taxon {draft.taxonId}
          </a>
        )}
      </div>
    </div>
  );
}

function PhotosEditor({
  species,
  projectId,
  onChange,
}: {
  species: SpeciesEntry;
  projectId: string;
  onChange: (f: (d: SpeciesEntry) => void) => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);

  const removePhoto = async (fileKey: string) => {
    await deleteFile(projectId, fileKey);
    onChange((d) => {
      d.photos = d.photos.filter((p) => p.fileKey !== fileKey);
    });
  };

  const makeMain = (slotId: string) => {
    onChange((d) => {
      const reordered = [
        ...d.photos.filter((p) => p.id === slotId),
        ...d.photos.filter((p) => p.id !== slotId),
      ].map((p, i) => ({ ...p, role: i === 0 ? ("main" as const) : ("secondary" as const) }));
      d.photos = reordered;
    });
  };

  const addUploads = async (files: File[], list: SpeciesEntry) => {
    let index = list.photos.length;
    for (const file of files) {
      const isMain = index === 0;
      const base = slugify(list.commonName || list.sciName || "photo");
      const fileKey = `${base}-${isMain ? "main" : `secondary-${index}`}.jpg`;
      await putFile(projectId, fileKey, file);
      const role = isMain ? "main" : "secondary";
      onChange((d) => {
        d.photos.push({
          id: `upload:${uuid()}`,
          role,
          credit: { observer: "You", license: "all-rights-reserved" },
          fileKey,
          alt: file.name,
        });
      });
      index++;
    }
  };

  return (
    <div className="mb-6" data-testid="photos-editor">
      <span className="label">Photos</span>
      <ul className="flex flex-wrap gap-3 mb-3">
        {species.photos.map((slot) => (
          <li key={slot.id} className="w-36" data-testid={`photo-${slot.role}`}>
            <PhotoThumb fileKey={slot.fileKey} projectId={projectId} />
            <div className="text-xs mt-1 truncate" title={`${slot.credit.observer} · ${slot.credit.license}`}>
              {slot.role === "main" ? "★ " : ""}{slot.credit.observer}
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>{slot.credit.license}</div>
            <div className="flex gap-2 mt-1">
              {slot.role !== "main" && (
                <button className="text-xs underline" onClick={() => makeMain(slot.id)}>
                  make main
                </button>
              )}
              <button
                className="text-xs underline"
                style={{ color: "var(--danger)" }}
                onClick={() => void removePhoto(slot.fileKey)}
              >
                remove
              </button>
            </div>
          </li>
        ))}
        {species.photos.length === 0 && (
          <li className="text-sm w-full" style={{ color: "var(--muted)" }}>
            No photos yet — pick some from iNaturalist below, or upload your own.
          </li>
        )}
      </ul>
      <input
        ref={uploadRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void addUploads(files, species);
        }}
      />
      <button className="btn-secondary text-sm" onClick={() => uploadRef.current?.click()}>
        Upload photos…
      </button>
    </div>
  );
}

function PhotoThumb({ fileKey, projectId }: { fileKey: string; projectId: string }) {
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
  }, [fileKey, projectId]);
  if (!src) return <div className="w-36 rounded bg-[#cfcecb] aspect-[4/3]" />;
  return <img src={src} alt="" className="w-36 rounded object-cover aspect-[4/3]" />;
}
