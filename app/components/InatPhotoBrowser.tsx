import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { PhotoCandidate } from "~/lib/resolve";
import { candidatePhotos, pickDistinct } from "~/lib/resolve";
import { acquireMediaSlot } from "~/lib/media";
import type { InatSearchScope, Project, SpeciesEntry } from "~/lib/types";
import { slugify } from "~/lib/ids";
import { photoCap } from "~/lib/cardGeometry";
import { ReplacePicker } from "~/components/ReplacePicker";
import { InatSearchSettingsPanel } from "~/components/InatSearchSettingsPanel";

/**
 * iNaturalist photo browser for one species: shows CC-licensed observation
 * photos (scoped to the deck's search settings — licenses, research grade,
 * ordering — and the project's locale when known), and lets the curator pin
 * specific photos onto the card — main or secondary. Auto-pick fills the
 * remaining slots with the best distinct-observer set. The search settings
 * collapse behind a disclosure; edits land on the project record so the
 * bulk-add search stays in step.
 */

export function InatPhotoBrowser({
  species,
  projectId,
  scope,
  onChange,
  onScopeChange,
}: {
  species: SpeciesEntry;
  projectId: string;
  /** The deck's search scope (from the project); defaults apply when absent. */
  scope?: InatSearchScope;
  onChange: (f: (d: SpeciesEntry) => void) => void;
  /** Edits the deck's search settings on the project record — provided
   *  when the embedding page can persist them. */
  onScopeChange?: (f: (d: Project) => void) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PhotoCandidate[]>([]);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  // The deck's search filters collapse behind a disclosure — the defaults
  // work for most searches.
  const [showSettings, setShowSettings] = useState(false);
  const query = species.sciName || species.commonName;

  /** Reload the candidate list. `isCurrent` lets a superseded run (species or
   *  settings changed again while this one was in flight) drop its results
   *  instead of overwriting the newer state. */
  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!query) return;
    setLoading(true);
    setStatus(null);
    try {
      const { resolveTaxon } = await import("~/lib/resolve");
      const taxon = species.taxonId
        ? { taxonId: species.taxonId }
        : await resolveTaxon(query).then((t) => (t ? { taxonId: t.taxonId } : null));
      if (!isCurrent()) return;
      if (!taxon) {
        setCandidates([]);
        setStatus(`“${query}” didn't resolve on iNaturalist.`);
        return;
      }
      const all = await candidatePhotos(taxon.taxonId, undefined, undefined, {
        includeVideos: scope?.includeMedia,
        settings: scope,
      });
      if (!isCurrent()) return;
      const found = all;
      setCandidates(found);
      setPickedIds(new Set());
      setStatus(
        found.length
          ? `${found.length} CC-licensed photos found — click to add, or use Auto-pick.`
          : "No CC-licensed photos found for this species.",
      );
    } catch (err) {
      if (!isCurrent()) return;
      setStatus(`iNaturalist error: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [query, species.taxonId, scope]);

  useEffect(() => {
    // Reload when the species identity or search settings change; the
    // cancellation flag stops a slower older response from clobbering a
    // newer one's results.
    let cancelled = false;
    void load(() => !cancelled);
    return () => { cancelled = true; };
  }, [species.taxonId, query, scope, load]);

  const addPhoto = useCallback(
    async (cand: PhotoCandidate, replaceIndex?: number) => {
      const base = slugify(species.commonName || species.sciName || "photo");
      try {
        const fresh = await acquireMediaSlot(cand.photo, cand.obs, {
          role: "secondary",
          base,
          includeAnimated: scope?.includeMedia ?? false,
          projectId,
        });
        if (!fresh) {
          setStatus("This media couldn't be used (download, decode, or animation policy).");
          return;
        }
        if (replaceIndex !== undefined) {
          // Full card: swap in the new media at the picked slot, keeping its
          // role and clearing any crop tuned to the old image. The old
          // files are garbage-collected when the draft is saved.
          const old = species.photos[replaceIndex];
          if (!old) return;
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
    [species, projectId, onChange, scope],
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
          includeAnimated: scope?.includeMedia ?? false,
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
  }, [candidates, species, projectId, onChange, scope]);

  const cap = photoCap(species.layout);
  const full = species.photos.length >= cap;
  /** Candidate pending a "replace which photo?" decision when the card is full. */
  const [pending, setPending] = useState<PhotoCandidate | null>(null);

  const handlePhotoClick = (cand: PhotoCandidate) => {
    // A photo already on the card is never re-added: re-picking it would
    // push a duplicate slot (and re-download the image under a fresh key),
    // and while the card is full it would push straight past the cap
    // instead of offering the replace flow.
    if (pickedIds.has(String(cand.photo.id))) {
      setStatus("That photo is already on the card.");
      return;
    }
    if (full) {
      setPending(cand);
      return;
    }
    void addPhoto(cand);
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
        {scope && !scope.useDeckLicenses
          ? "Offering every license iNat allows — cards with photos outside the deck's accepted licenses are flagged on the review page. "
          : "Photos follow the deck's accepted licenses — "}
        <Link to={`/project/${projectId}/info`} className="underline">
          the deck's copyright limits live in Deck info
        </Link>
        . The photographer's credit is attached automatically and exported into the deck.
      </p>
      {onScopeChange && scope && (
        <div className="mb-3">
          <button
            type="button"
            className="text-xs underline"
            style={{ color: "var(--muted)" }}
            onClick={() => setShowSettings((v) => !v)}
            data-testid="browser-settings-toggle"
          >
            {showSettings ? "− Hide search settings" : "+ Search settings"}
          </button>
          {showSettings && (
            <div className="mt-2">
              <InatSearchSettingsPanel
                settings={scope}
                onChange={(next) => onScopeChange((d) => { d.inatSearch = next; })}
                licensesHref={`/project/${projectId}/info`}
              />
            </div>
          )}
        </div>
      )}
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
