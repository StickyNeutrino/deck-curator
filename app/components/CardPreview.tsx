import { useEffect, useMemo, useState } from "react";
import type { PhotoSlot, SpeciesEntry } from "~/lib/types";
import { creditText, slotsFor, rectStyle, focusStyle, cropStyle, CARD_W, CARD_H } from "~/lib/cardGeometry";

/**
 * Live previews of the exported card. Photo blobs come from a resolver
 * callback (IndexedDB) and are shown as object URLs.
 */

export type BlobResolver = (fileKey: string) => Promise<Blob | undefined>;

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
  useEffect(() => {
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
  }, [fileKey, resolve]);
  if (!src) return null;
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

/** Card back: the text stack, mirroring the Healthy Canyons rendered backs. */
export function CardBack({ species }: { species: SpeciesEntry }) {
  const title = species.commonName || species.sciName;
  const altLine = species.altNames.length ? `aka ${species.altNames.join(" · ")}` : null;
  return (
    <div className="preview-card" data-testid="card-back" data-invasive={species.invasive}>
      <div className="logo-chip" />
      <div className="preview-back">
        <div className="title">{title}</div>
        {altLine && (
          <div
            className="alt-names"
            style={{ position: "absolute", top: "32%", left: "5%", right: "5%" }}
          >
            {altLine}
          </div>
        )}
        {species.sciName && (
          <div
            className="sci-name"
            style={{ position: "absolute", top: altLine ? "38%" : "34%", left: "5%", right: "5%" }}
          >
            {species.sciName}
          </div>
        )}
        {species.familyCommon && (
          <div style={{ position: "absolute", top: "47%", left: "5%", right: "5%" }}>
            {species.familyCommon}
          </div>
        )}
        {species.familyLatin && (
          <div
            className="sci-name"
            style={{ position: "absolute", top: "53%", left: "5%", right: "5%" }}
          >
            {species.familyLatin}
          </div>
        )}
        {(species.native !== "unknown" || species.invasive) && (
          <div style={{ position: "absolute", top: "64%", left: "5%", right: "5%", fontWeight: 600 }}>
            {species.invasive ? "Non-native (Invasive)" : species.native === "native" ? "Native" : "Non-native"}
          </div>
        )}
        {species.rarity && (
          <div style={{ position: "absolute", top: "70%", left: "5%", right: "5%", fontSize: "0.85em" }}>
            {species.rarity}
          </div>
        )}
      </div>
    </div>
  );
}
