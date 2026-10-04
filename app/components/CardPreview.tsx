import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PhotoSlot, SpeciesEntry } from "~/lib/types";
import { isInvasive, borderStyleDef } from "~/lib/types";
import { creditText, slotsFor, rectStyle, focusStyle, cropStyle, CARD_W, CARD_H } from "~/lib/cardGeometry";

/**
 * Live previews of the exported card. Photo blobs come from a resolver
 * callback (IndexedDB) and are shown as object URLs.
 */

export type BlobResolver = (fileKey: string) => Promise<Blob | undefined>;

/** Once a slot is within half a viewport of being scrolled into view, start
 *  loading its photo. The review grid can run hundreds of cards deep —
 *  without this gate, every photo on the page loads at once and even the
 *  first cards sit behind the queue. Falls back to loading immediately
 *  where IntersectionObserver is unavailable (tests, old browsers). */
function useNearViewport(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver !== "function");
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

function PhotoImage({
  fileKey,
  resolve,
  alt,
  focus,
  crop,
}: {
  fileKey: string;
  resolve: BlobResolver;
  alt?: string;
  focus?: { x: number; y: number };
  crop?: { x: number; y: number; w: number; h: number };
}) {
  const [src, setSrc] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(slotRef);
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let url: string | null = null;
    resolve(fileKey)
      .then((blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => setSrc(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fileKey, resolve, near]);
  if (!src) {
    // Placeholder keeps the slot's fixed geometry (the .slot div is sized by
    // the layout) while the blob loads or waits for the viewport.
    return <div ref={slotRef} style={{ width: "100%", height: "100%" }} aria-hidden="true" />;
  }
  // Explicit crop wins; legacy focus keeps working; otherwise centered cover.
  const style = crop ? cropStyle(crop) : focus ? focusStyle(focus) : undefined;
  return <img src={src} alt={alt ?? ""} loading="lazy" style={style} />;
}

/** Card front: photos in the layout slots with credit lines beneath. */
export function CardFront({
  species,
  resolve,
}: {
  species: SpeciesEntry;
  resolve: BlobResolver;
}) {
  const slots = useMemo(
    () => slotsFor(species.layout, species.photos.length),
    [species.layout, species.photos.length],
  );
  return (
    <div className="preview-card" data-testid="card-front" data-layout={species.layout}>
      {slots.map(({ rect, index }) => {
        const slot: PhotoSlot | undefined = species.photos[index];
        if (!slot) return null;
        return (
          <div key={slot.id + index}>
            <div className="slot" style={rectStyle(rect)}>
              <PhotoImage fileKey={slot.fileKey} resolve={resolve} alt={slot.alt} focus={slot.focus} crop={slot.crop} />
            </div>
            <div
              className="credit"
              style={{
                left: `${(rect.left / CARD_W) * 100}%`,
                top: `${((rect.top + rect.height + 6) / CARD_H) * 100}%`,
                width: `${(rect.width / CARD_W) * 100}%`,
              }}
            >
              {creditText(slot)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Title sizing mirrors the app's DataCard back: 72px design max, shrunk to
 *  fit — without this, long names overlap the sci-name line below (most
 *  visible on the review grid where many previews stack up). */
const TITLE_MAX_EM = 6;
const TITLE_MIN_EM = 2.5;
const TITLE_STEP_EM = 0.25;

/** Card back: the text stack, mirroring the flashcards app's data-back-stack
 *  (same line classes, sizes, and spacing — see app.css .preview-back). */
export function CardBack({ species }: { species: SpeciesEntry }) {
  const titleRef = useRef<HTMLDivElement | null>(null);
  const title = species.commonName || species.sciName;
  const altLine = species.altNames.length ? `aka ${species.altNames.join(", ")}` : null;
  const invasive = isInvasive(species);
  const border = borderStyleDef(species.border);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    let size = TITLE_MAX_EM;
    el.style.fontSize = `${size}em`;
    while (size > TITLE_MIN_EM && el.scrollWidth > el.clientWidth + 1) {
      size -= TITLE_STEP_EM;
      el.style.fontSize = `${size}em`;
    }
  }, [title]);

  return (
    <div
      className="preview-card"
      data-testid="card-back"
      data-invasive={invasive}
      data-border={species.border}
      style={border.id !== "none" ? { border: `6px solid ${border.color}` } : undefined}
    >
      <div className="preview-back">
        <div className="logo-chip" />
        <div className="title" ref={titleRef} data-testid="card-back-title">{title}</div>
        {altLine && <div className="alt-names">{altLine}</div>}
        {species.sciName && <div className="sci-name">{species.sciName}</div>}
        {species.familyCommon && <div className="family">{species.familyCommon}</div>}
        {species.familyLatin && <div className="family-latin">{species.familyLatin}</div>}
        {(species.native !== "unknown" || invasive) && (
          <div className="native">
            {invasive ? "Non-native (Invasive)" : species.native === "native" ? "Native" : "Non-native"}
          </div>
        )}
        {species.rarity && <div className="rarity">{species.rarity}</div>}
      </div>
    </div>
  );
}
