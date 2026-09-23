import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PhotoCandidate } from "~/lib/resolve";
import { candidatePhotos, pickDistinct } from "~/lib/resolve";
import { acquireMediaSlot } from "~/lib/media";
import type { InatSearchSettings, SpeciesEntry } from "~/lib/types";
import { deleteFile } from "~/lib/store";
import { slugify } from "~/lib/ids";
import { photoCap } from "~/lib/cardGeometry";
import { ReplacePicker } from "~/components/ReplacePicker";

/**
 * iNaturalist photo browser for one species: shows CC-licensed observation
 * photos (scoped to the deck's search settings — licenses, research grade,
 * ordering — and the project's locale when known), and lets the curator pin
 * specific photos onto the card — main or secondary. Auto-pick fills the
 * remaining slots with the best distinct-observer set.
 */

export function InatPhotoBrowser({
  species,
  projectId,
  settings,
  onChange,
}: {
  species: SpeciesEntry;
  projectId: string;
  /** Deck search constraints (from the project); defaults apply when absent. */
  settings?: InatSearchSettings;
  onChange: (f: (d: SpeciesEntry) => void) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PhotoCandidate[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const query = species.sciName || species.commonName;

  const load = useCallback(async () => {
    if (!query) return;
    setLoading(true);
    setStatus(null);
    try {
      const { resolveTaxon } = await import("~/lib/resolve");
      const taxon = species.taxonId
        ? { taxonId: species.taxonId }
        : await resolveTaxon(query).then((t) => (t ? { taxonId: t.taxonId } : null));
      if (!taxon) {
        setCandidates([]);
        setStatus(`“${query}” didn't resolve on iNaturalist.`);
        return;
      }
      const all = await candidatePhotos(taxon.taxonId, undefined, undefined, {
        includeVideos: settings?.includeMedia,
        settings,
      });
      const found = all;
      setCandidates(found);
      setPickedIds(new Set());
      setStatus(
        found.length
          ? `${found.length} CC-licensed photos found — click to add, or use Auto-pick.`
          : "No CC-licensed photos found for this species.",
      );
    } catch (err) {
      setStatus(`iNaturalist error: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  }, [query, species.taxonId, settings]);

  useEffect(() => {
    void load();
    // Reload when the species identity or search settings change.
  }, [species.taxonId, query, settings]);

  const addPhoto = useCallback(
    async (cand: PhotoCandidate, replaceIndex?: number) => {
      const base = slugify(species.commonName || species.sciName || "photo");
      try {
        const fresh = await acquireMediaSlot(cand.photo, cand.obs, {
          role: "secondary",
          base,
          includeAnimated: settings?.includeMedia ?? false,
          projectId,
        });
        if (!fresh) {
          setStatus("This media couldn't be used (download, decode, or animation policy).");
          return;
        }
        if (replaceIndex !== undefined) {
          // Full card: swap in the new media at the picked slot, keeping its
          // role and clearing any crop tuned to the old image.
          const old = species.photos[replaceIndex];
          if (!old) return;
          await deleteFile(projectId, old.fileKey);
          if (old.animation) await deleteFile(projectId, old.animation.fileKey);
          onChange((d) => {
            const slot = d.photos[replaceIndex];
            if (slot) {
              slot.id = fresh.id;
              slot.credit = fresh.credit;
              slot.alt = fresh.alt;
              slot.fileKey = fresh.fileKey;
              slot.animation = fresh.animation;
              slot.crop = undefined;
              slot.focus = undefined;
            }
          });
          setPickedIds((prev) => new Set(prev).add(String(cand.photo.id)));
          setStatus("Photo replaced.");
          return;
        }
        onChange((d) => {
          const role: "main" | "secondary" = d.photos.length === 0 ? "main" : "secondary";
          fresh.role = role;
          d.photos.push(fresh);
        });
        setPickedIds((prev) => new Set(prev).add(String(cand.photo.id)));
        setStatus(fresh.animation ? "Animated media added — pick the frame to display below." : "Photo added.");
      } catch (err) {
        setStatus(`Could not download media: ${err instanceof Error ? err.message : err}`);
      }
    },
    [species, projectId, onChange, settings],
  );

  const autoPick = useCallback(async () => {
    const slotsWanted = species.layout === "photo-single" ? 1 : 3;
    const remaining = slotsWanted - species.photos.length;
    if (remaining <= 0) {
      setStatus("Card already has its photos.");
      return;
    }
    const picked = pickDistinct(candidates, remaining);
    let added = 0;
    for (const cand of picked) {
      const base = slugify(species.commonName || species.sciName || "photo");
      try {
        const slot = await acquireMediaSlot(cand.photo, cand.obs, {
          role: species.photos.length === 0 ? "main" : "secondary",
          base,
          includeAnimated: settings?.includeMedia ?? false,
          projectId,
        });
        if (!slot) continue;
        onChange((d) => {
          const role: "main" | "secondary" = d.photos.length === 0 ? "main" : "secondary";
          slot.role = role;
          d.photos.push(slot);
        });
        setPickedIds((prev) => new Set(prev).add(String(cand.photo.id)));
        added++;
      } catch {
        // Skip failed downloads.
      }
    }
    setStatus(added ? `Added ${added} media item(s).` : "Could not download any media.");
  }, [candidates, species, projectId, onChange, settings]);

  const cap = photoCap(species.layout);
  const full = species.photos.length >= cap;
  /** Candidate pending a "replace which photo?" decision when the card is full. */
  const [pending, setPending] = useState<PhotoCandidate | null>(null);

  const handlePhotoClick = (cand: PhotoCandidate) => {
    if (full && !pickedIds.has(String(cand.photo.id))) {
      setPending(cand);
    } else {
      void addPhoto(cand);
    }
  };

  return (
    <section className="mt-10 border-t pt-6" data-testid="inat-photo-browser">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-semibold">
          iNaturalist photos{" "}
          <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>
            ({species.photos.length}/{cap})
          </span>
        </h2>
        <button className="btn-secondary text-sm" onClick={() => void load()} disabled={loading || !query}>
          {loading ? "Loading…" : "Search"}
        </button>
        <button
          className="btn-secondary text-sm"
          onClick={() => void autoPick()}
          disabled={loading || !candidates.length || full}
          data-testid="auto-pick"
          title={full ? "Card is full — remove a photo first" : undefined}
        >
          Auto-pick
        </button>
        {full && (
          <span className="text-xs" style={{ color: "var(--muted)" }} data-testid="browser-full-note">
            Card is full — picking a photo will replace one you choose.
          </span>
        )}
      </div>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Photos follow the deck's accepted licenses and filters —{" "}
        <Link to={`/project/${projectId}/info`} className="underline">
          edit them in Deck info
        </Link>. The photographer's credit is attached automatically and exported into the deck.
      </p>
      {status && (
        <p className="text-sm mb-2" data-testid="inat-browser-status" style={{ color: "var(--muted)" }}>
          {status}
        </p>
      )}
      <ul className="flex flex-wrap gap-3" data-testid="inat-photos">
        {candidates.map((cand) => {
          const picked = pickedIds.has(String(cand.photo.id));
          return (
            <li key={String(cand.photo.id)} className="w-44">
              <button
                className={`block w-full rounded overflow-hidden border-2 ${pickedIds.has(String(cand.photo.id)) ? "border-[var(--accent)]" : "border-transparent"}`}
                onClick={() => handlePhotoClick(cand)}
                title={`Add photo by ${cand.obs.user?.name || cand.obs.user?.login} (${cand.photo.license_code})`}
                data-testid={`inat-photo-${cand.photo.id}`}
              >
                <img src={cand.photo.url.replace(/\/(square|thumb|small|medium)\./, "/medium.")} alt="" loading="lazy" className="aspect-square object-cover w-full" />
              </button>
              <div className="text-xs mt-1 truncate">
                © {cand.obs.user?.name || cand.obs.user?.login || "unknown"}
              </div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {(cand.photo.license_code ?? "").toUpperCase()} · {cand.obs.quality_grade}
              </div>
            </li>
          );
        })}
        {loading && <li className="text-sm" style={{ color: "var(--muted)" }}>Loading photos…</li>}
      </ul>
      {pending && (
        <ReplacePicker
          projectId={projectId}
          photos={species.photos}
          onPick={(index) => {
            const cand = pending;
            setPending(null);
            void addPhoto(cand, index);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
