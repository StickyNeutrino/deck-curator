import { useEffect, useRef, useState } from "react";
import { clampCrop, defaultCoverCrop } from "~/lib/cardGeometry";
import { getFile } from "~/lib/store";

/**
 * Crop editor: pick the exact bounds of the photo that fill the card slot —
 * a resizable window over the source image, smaller than the image in both
 * dimensions when wanted. Drag inside to move, drag a corner to resize, or
 * Reset to return to the automatic centered cover crop. The crop window is
 * free-form (no locked aspect): the preview card shows precisely what ships.
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Corner = "nw" | "ne" | "sw" | "se";

interface DragState {
  kind: "move" | Corner;
  startX: number;
  startY: number;
  origin: CropRect;
}

export function CropModal({
  projectId,
  fileKey,
  slotAspect,
  initialCrop,
  onSave,
  onClose,
}: {
  projectId: string;
  fileKey: string;
  /** Aspect (w/h) of the slot this photo fills — shown for reference. */
  slotAspect: number;
  initialCrop?: CropRect;
  onSave: (crop: CropRect | undefined) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void getFile(projectId, fileKey).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setImageAspect(img.naturalWidth / img.naturalHeight);
        setUrl(objectUrl);
      };
      img.src = objectUrl;
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, fileKey]);

  // Initialize the crop once the image aspect is known.
  useEffect(() => {
    if (crop === null && imageAspect !== null) {
      setCrop(initialCrop ?? defaultCoverCrop(imageAspect, slotAspect));
    }
  }, [imageAspect, initialCrop, crop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const beginDrag = (kind: "move" | Corner) => (e: React.PointerEvent) => {
    if (!crop) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind, startX: e.clientX, startY: e.clientY, origin: crop };
  };

  const onDragMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!dragRef.current || !crop || !frame) return;
    const rect = frame.getBoundingClientRect();
    const dx = (e.clientX - dragRef.current.startX) / rect.width;
    const dy = (e.clientY - dragRef.current.startY) / rect.height;
    const o = dragRef.current.origin;

    if (dragRef.current.kind === "move") {
      setCrop(clampCrop({ ...o, x: o.x + dx, y: o.y + dy }));
      return;
    }
    // Corner resize: the dragged corner moves, the opposite corner stays.
    const east = dragRef.current.kind === "ne" || dragRef.current.kind === "se";
    const south = dragRef.current.kind === "se" || dragRef.current.kind === "sw";
    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    if (east) x2 = Math.min(1, Math.max(0.05, o.x + o.w + dx));
    else x1 = Math.min(o.x + o.w - 0.05, Math.max(0, o.x + dx));
    if (south) y2 = Math.min(1, Math.max(0.05, o.y + o.h + dy));
    else y1 = Math.min(o.y + o.h - 0.05, Math.max(0, o.y + dy));
    setCrop(clampCrop({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="crop-modal"
    >
      <div className="rounded-lg bg-white p-5 max-w-2xl w-full" role="dialog" aria-label="Crop photo">
        <h2 className="font-semibold mb-1">Crop photo</h2>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
          Drag inside the window to move it; drag a corner to resize. Everything outside the bright
          area is cropped away.
        </p>
        {url && crop ? (
          <div
            ref={frameRef}
            className="relative mx-auto select-none touch-none"
            style={{ maxWidth: 480 }}
            onPointerMove={(e) => onDragMove(e)}
            onPointerUp={endDrag}
          >
            <img src={url} alt="" className="w-full block rounded" draggable={false} />
            {/* dimmed overlay outside the crop window */}
            <div className="absolute inset-0 bg-black/55" style={{ clipPath: cropClipPath(crop) }} />
            <div
              className="absolute border-2 border-white cursor-move"
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.w * 100}%`,
                height: `${crop.h * 100}%`,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0)",
              }}
              data-testid="crop-window"
              onPointerDown={beginDrag("move")}
            >
              {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                <span
                  key={corner}
                  className={`absolute w-4 h-4 rounded-full bg-white border-2 border-[var(--accent)] ${
                    corner === "nw" ? "-left-2 -top-2 cursor-nwse-resize" :
                    corner === "ne" ? "-right-2 -top-2 cursor-nesw-resize" :
                    corner === "sw" ? "-left-2 -bottom-2 cursor-nesw-resize" :
                    "-right-2 -bottom-2 cursor-nwse-resize"
                  }`}
                  onPointerDown={beginDrag(corner)}
                  data-testid={`crop-handle-${corner}`}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-sm" style={{ color: "var(--muted)" }}>
            Loading image…
          </div>
        )}
        <div className="flex gap-2 mt-4">
          <button
            className="btn-primary"
            onClick={() => {
              onSave(crop ?? undefined);
              onClose();
            }}
            data-testid="crop-save"
          >
            Done
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              onSave(undefined);
              onClose();
            }}
            data-testid="crop-reset"
          >
            Reset to automatic
          </button>
          <button className="btn-secondary ml-auto" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Clip-path that hides everything outside the crop window. */
function cropClipPath(crop: CropRect): string {
  const l = crop.x * 100;
  const t = crop.y * 100;
  const r = l + crop.w * 100;
  const b = t + crop.h * 100;
  return `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}% ${t}%, ${l}% ${b}%, ${r}% ${b}%, ${r}% ${t}%, ${l}% ${t}%)`;
}

/** Aspect (w/h) of the slot a photo sits in — used to pre-select the crop. */
export function slotAspectFor(role: "main" | "secondary", index: number): number {
  if (role === "main") return 650 / 604;
  return index === 1 ? 276 / 295 : 324 / 295;
}
