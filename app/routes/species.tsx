import type { Route } from "./+types/species";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useMemo } from "react";
import { getProject, saveProject, getFile, putFile, deleteFile } from "~/lib/store";
import type { Project, SpeciesEntry, CardLayout, PhotoSlot } from "~/lib/types";
import { CardFront, CardBack, type BlobResolver } from "~/components/CardPreview";
import { InatPhotoBrowser } from "~/components/InatPhotoBrowser";
import { slugify, formatAltNames, parseAltNames } from "~/lib/ids";
import { uuid } from "~/lib/uuid";
import { photoCap, focusStyle, cropStyle, reorderPhotos } from "~/lib/cardGeometry";
import { BORDER_STYLES, searchSettingsOf, type BorderStyle } from "~/lib/types";
import { allTags } from "~/components/TagsManager";
import { CropModal, slotAspectFor } from "~/components/CropModal";
import { FrameModal } from "~/components/FrameModal";
import { classifyMediaBlob, extractGifFrame, extractPosterFrame, isMediaFile } from "~/lib/motion";
import { ReplacePicker } from "~/components/ReplacePicker";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Deck Curator — species" }];
}

export default function SpeciesPage() {
  const { projectId, speciesId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<SpeciesEntry | null>(null);
  const [saved, setSaved] = useState(false);
  const [cropSlot, setCropSlot] = useState<{ slot: SpeciesEntry["photos"][number]; index: number } | null>(null);

  // Where "Save & close" / "Cancel" should return to — e.g. the review page
  // with the "needs fixing" filter active. Falls back to the deck list.
  const location = useLocation();
  const returnTo = useMemo(() => {
    const raw = new URLSearchParams(location.search).get("returnTo");
    if (!raw) return null;
    // Only allow relative project paths (no open redirects).
    return raw.startsWith("review") ? `/project/${projectId}/${raw}` : null;
  }, [location.search, projectId]);
  const closeTarget = returnTo ?? `/project/${projectId}`;

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
      <Shell backLabel="Back" backTo={closeTarget}>
        <p>Loading…</p>
      </Shell>
    );
  }
  if (!entry || !draft) {
    return (
      <Shell backLabel="Back to deck" backTo={closeTarget}>
        <p>Species not found.</p>
      </Shell>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-4 text-sm">
        <Link to={closeTarget} className="underline" style={{ color: "var(--muted)" }}>
          ← {project.deckLabel}
        </Link>
      </nav>

      <div className="grid md:grid-cols-[1fr_360px] gap-8">
        <section data-testid="species-editor">
          <h1 className="text-xl font-bold mb-4">
            {draft.commonName || draft.sciName || "Unnamed species"}
          </h1>

          <Fields draft={draft} project={project} onChange={update} />

          <TagsEditor draft={draft} project={project} onChange={update} />

          <PhotosEditor
            species={draft}
            projectId={projectId ?? ""}
            onChange={update}
            onRequestCrop={(slot, index) => setCropSlot({ slot, index })}
          />

          <div className="flex gap-2 mt-4">
            <button className="btn-primary" onClick={() => void persist()} data-testid="save-species">
              {saved ? "Saved ✓" : "Save"}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                void persist().then(() => navigate(closeTarget));
              }}
            >
              Save &amp; close
            </button>
            <button className="btn-secondary" onClick={() => navigate(closeTarget)}>
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

      <InatPhotoBrowser species={draft} projectId={projectId ?? ""} settings={project ? searchSettingsOf(project) : undefined} onChange={update} />
      {cropSlot && (
        <CropModal
          projectId={projectId ?? ""}
          fileKey={cropSlot.slot.fileKey}
          slotAspect={slotAspectFor(cropSlot.slot.role, cropSlot.index)}
          initialCrop={cropSlot.slot.crop}
          onSave={(crop) => update((d) => {
            const slot = d.photos[cropSlot.index];
            if (slot) slot.crop = crop;
          })}
          onClose={() => setCropSlot(null)}
        />
      )}
    </main>
  );
}

/** Tag editor: comma-separated input with suggestions from existing tags. */
function TagsEditor({
  draft,
  project,
  onChange,
}: {
  draft: SpeciesEntry;
  project: Project;
  onChange: (f: (d: SpeciesEntry) => void) => void;
}) {
  const suggestions = allTags(project)
    .map(({ tag }) => tag)
    .filter((tag) => !(draft.tags ?? []).includes(tag))
    .slice(0, 8);
  return (
    <div className="mb-6" data-testid="tags-editor">
      <span className="label">Tags — e.g. “phase 1”, “class session 3” (comma separated)</span>
      <input
        className="field text-sm"
        value={(draft.tags ?? []).join(", ")}
        placeholder="phase 1, quiz group A"
        aria-label="Tags"
        data-testid="tags-input"
        onChange={(e) =>
          onChange((d) => {
            d.tags = e.target.value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
          })
        }
      />
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="text-xs rounded-full border px-2 py-0.5 hover:bg-[var(--accent-soft)]"
              style={{ borderColor: "var(--border)" }}
              onClick={() => onChange((d) => { d.tags = [...(d.tags ?? []), tag]; })}
              data-testid={`suggest-tag-${tag}`}
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children, backLabel, backTo }: { children: React.ReactNode; backLabel: string; backTo: string }) {  return (
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
        <div className="inline-flex items-center gap-2 text-sm" role="radiogroup" aria-label="Border style">
          <span className="label !mb-0">Border</span>
          {BORDER_STYLES.map((style) => (
            <button
              key={style.id}
              role="radio"
              aria-checked={draft.border === style.id}
              className="inline-flex items-center gap-1.5 rounded-full border-2 px-2.5 py-1 text-xs cursor-pointer"
              style={{
                borderColor: draft.border === style.id ? style.color : "var(--border)",
                fontWeight: draft.border === style.id ? 600 : 400,
              }}
              onClick={() => onChange((d) => { d.border = style.id; })}
              data-testid={`border-${style.id}`}
              title={style.id === "none" ? "No border" : `${style.label} (${style.color})`}
            >
              <span
                aria-hidden
                className="inline-block w-3 h-3 rounded-sm"
                style={{ background: style.color === "transparent" ? "var(--border)" : style.color }}
              />
              {style.label}
            </button>
          ))}
        </div>
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
  onRequestCrop,
}: {
  species: SpeciesEntry;
  projectId: string;
  onChange: (f: (d: SpeciesEntry) => void) => void;
  onRequestCrop: (slot: SpeciesEntry["photos"][number], index: number) => void;
}) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const cap = photoCap(species.layout);
  const full = species.photos.length >= cap;
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [frameSlot, setFrameSlot] = useState<number | null>(null);
  /** Pending uploads waiting for a "replace which photo?" decision. */
  const [pendingReplace, setPendingReplace] = useState<{ files: File[] } | null>(null);

  const removePhoto = async (fileKey: string) => {
    await deleteFile(projectId, fileKey);
    onChange((d) => {
      d.photos = d.photos.filter((p) => p.fileKey !== fileKey);
    });
  };

  /** Move by drag; roles follow position (index 0 = main). */
  const dropAt = (from: number, to: number) => {
    setDragOver(null);
    onChange((d) => {
      d.photos = reorderPhotos(d.photos, from, to).map((p, i) => ({
        ...p,
        role: i === 0 ? ("main" as const) : ("secondary" as const),
      }));
    });
  };

  const makeMain = (slotId: string) => {
    const idx = species.photos.findIndex((p) => p.id === slotId);
    if (idx > 0) dropAt(idx, 0);
  };

  const swap = (slotId: string, dir: -1 | 1) => {
    const idx = species.photos.findIndex((p) => p.id === slotId);
    if (idx >= 0) dropAt(idx, idx + dir);
  };

  const storeUpload = async (file: File, index: number): Promise<PhotoSlotLike> => {
    const isMain = index === 0;
    const base = slugify(species.commonName || species.sciName || "photo");
    const fileKey = `${base}-${isMain ? "main" : `secondary-${index}`}.jpg`;
    await putFile(projectId, fileKey, file);
    return {
      id: `upload:${uuid()}`,
      role: isMain ? "main" : "secondary",
      credit: { observer: "You", license: "all-rights-reserved" },
      fileKey,
      alt: file.name,
    };
  };

  const addUploads = async (files: File[]) => {
    let index = species.photos.length;
    for (const file of files) {
      if (index >= cap) break;
      const mediaKind = isMediaFile(file);
      if (!mediaKind) {
        const slot = await storeUpload(file, index);
        onChange((d) => {
          d.photos.push(slot);
        });
      } else {
        // Moving media: store the clip, capture the first frame as the
        // display still, then let the curator pick a different frame.
        const base = slugify(species.commonName || species.sciName || "photo");
        const clipKey = `${base}-anim-${index}-${Date.now().toString(36)}.${mediaKind === "gif" ? "gif" : ".mp4".slice(1)}`;
        await putFile(projectId, clipKey, file);
        let still: Blob;
        try {
          still =
            mediaKind === "gif" ? await extractGifFrame(file, 0) : await extractPosterFrame(file, 0.1);
        } catch (err) {
          await deleteFile(projectId, clipKey);
          alert(`Couldn't decode ${file.name}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        const posterKey = `${base}-frame-${index}-${Date.now().toString(36)}.jpg`;
        await putFile(projectId, posterKey, still);
        const slot: PhotoSlot = {
          id: `upload:${uuid()}`,
          role: index === 0 ? "main" : "secondary",
          credit: { observer: "You", license: "all-rights-reserved" },
          fileKey: posterKey,
          alt: file.name,
          animation: { fileKey: clipKey, kind: mediaKind },
        };
        onChange((d) => {
          d.photos.push(slot);
        });
      }
      index++;
    }
  };

  /** Uploads with a full card: replace the slot the curator picks. */
  const replaceFirstUpload = async (files: File[], slotIndex: number) => {
    const file = files[0];
    const old = species.photos[slotIndex];
    if (!file || !old) return;
    await putFile(projectId, old.fileKey, file);
    onChange((d) => {
      const slot = d.photos[slotIndex];
      if (slot) {
        slot.id = `upload:${uuid()}`;
        slot.credit = { observer: "You", license: "all-rights-reserved" };
        slot.alt = file.name;
        slot.crop = undefined;
        slot.focus = undefined;
      }
    });
  };

  return (
    <div className="mb-6" data-testid="photos-editor">
      <span className="label">
        Photos ({species.photos.length}/{cap}
        {species.layout === "photo-single" ? " — single layout" : ""}) — drag to rearrange
      </span>
      {full && (
        <p className="text-xs mb-2" data-testid="photos-full-note" style={{ color: "var(--muted)" }}>
          Card is full — adding another photo will replace one you pick.
        </p>
      )}
      <ul className="flex flex-wrap gap-3 mb-3">
        {species.photos.map((slot, i) => (
          <li
            key={slot.id}
            className="w-36"
            data-testid={`photo-${slot.role}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver((cur) => (cur === i ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData("text/plain"));
              if (!Number.isNaN(from)) dropAt(from, i);
            }}
            style={dragOver === i ? { outline: "2px dashed var(--accent)", outlineOffset: 2, borderRadius: 8 } : undefined}
          >
            <div className="relative">
              <PhotoThumb fileKey={slot.fileKey} projectId={projectId} crop={slot.crop} focus={slot.focus} />
              <span className="absolute top-1 left-1 text-xs rounded bg-white/85 px-1 cursor-grab" title="Drag to rearrange" aria-hidden>
                ⠿
              </span>
              {slot.animation && (
                <span
                  className="absolute bottom-1 left-1 text-[10px] bg-white/85 rounded px-1"
                  title={`Animated ${slot.animation.kind} attached`}
                >
                  🎬 {slot.animation.kind === "gif" ? "GIF" : "video"}
                </span>
              )}
              {slot.crop && (
                <span className="absolute bottom-1 right-1 text-[10px] bg-white/85 rounded px-1" title="Custom crop set">
                  crop
                </span>
              )}
            </div>
            <div className="text-xs mt-1 truncate" title={`${slot.credit.observer} · ${slot.credit.license}`}>
              {slot.role === "main" ? "★ " : ""}{slot.credit.observer}
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>{slot.credit.license}</div>
            <div className="flex flex-wrap gap-x-2 mt-1">
              {slot.role !== "main" && i > 0 && (
                <button className="text-xs underline" onClick={() => makeMain(slot.id)} data-testid={`make-main-${slot.id}`}>
                  main
                </button>
              )}
              {slot.animation && (
                <button
                  className="text-xs underline"
                  onClick={() => setFrameSlot(i)}
                  data-testid={`choose-frame-${slot.id}`}
                >
                  choose frame
                </button>
              )}
              <button
                className="text-xs underline"
                onClick={() => onRequestCrop(slot, i)}
                data-testid={`crop-${slot.id}`}
              >
                crop
              </button>
              <button
                className="text-xs underline"
                style={{ color: "var(--danger)" }}
                onClick={() => void removePhoto(slot.fileKey)}
              >
                remove
              </button>
            </div>
            {slot.role === "secondary" && i > 1 && (
              <button className="text-xs underline mr-2" onClick={() => swap(slot.id, -1)} aria-label="Move photo left">
                ←
              </button>
            )}
            {slot.role === "secondary" && i < species.photos.length - 1 && (
              <button className="text-xs underline" onClick={() => swap(slot.id, 1)} aria-label="Move photo right">
                →
              </button>
            )}
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
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!files.length) return;
          if (species.photos.length >= cap) {
            // Full: ask which photo the first upload should replace.
            setPendingReplace({ files });
          } else {
            void addUploads(files);
          }
        }}
      />
      <button
        className="btn-secondary text-sm"
        onClick={() => uploadRef.current?.click()}
        data-testid="upload-photos"
      >
        Upload photos…
      </button>
      <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
        Use “crop” to choose exactly which part of the photo fills its slot — drag the window to
        move it, drag a corner to resize.
      </p>
      {pendingReplace && (
        <ReplacePicker
          projectId={projectId}
          photos={species.photos}
          onPick={(index) => {
            const files = pendingReplace.files;
            setPendingReplace(null);
            void replaceFirstUpload(files, index);
          }}
          onCancel={() => setPendingReplace(null)}
        />
      )}
      {frameSlot != null && species.photos[frameSlot]?.animation && (
        <FrameModal
          projectId={projectId}
          slot={species.photos[frameSlot]}
          onSave={async (still) => {
            const slot = species.photos[frameSlot];
            if (!slot?.animation) return;
            const base = slugify(species.commonName || species.sciName || "still");
            const posterKey = `${base}-frame-${Date.now().toString(36)}.jpg`;
            await putFile(projectId, posterKey, still);
            await deleteFile(projectId, slot.fileKey);
            onChange((d) => {
              const target = d.photos[frameSlot];
              if (target) target.fileKey = posterKey;
            });
          }}
          onClose={() => setFrameSlot(null)}
        />
      )}
    </div>
  );
}

interface PhotoSlotLike {
  id: string;
  role: "main" | "secondary";
  credit: SpeciesEntry["photos"][number]["credit"];
  fileKey: string;
  alt?: string;
}

function PhotoThumb({
  fileKey,
  projectId,
  crop,
  focus,
}: {
  fileKey: string;
  projectId: string;
  crop?: { x: number; y: number; w: number; h: number };
  focus?: { x: number; y: number };
}) {
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
  return (
    <div className="relative w-36 rounded overflow-hidden aspect-[4/3]" data-testid="photo-thumb">
      {/* Show the actual crop when set; otherwise the plain cover view. */}
      <div className="absolute inset-0">
        <img src={src} alt="" style={crop ? cropStyle(crop) : focusStyle(focus)} className={crop ? undefined : "w-full h-full object-cover"} />
      </div>
    </div>
  );
}
