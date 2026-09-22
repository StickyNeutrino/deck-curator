import { useEffect, useRef, useState } from "react";
import type { PhotoSlot } from "~/lib/types";
import { getFile } from "~/lib/store";
import { extractGifFrame, extractPosterFrame } from "~/lib/motion";

/**
 * Frame picker for moving media (video clips and animated GIFs): the deck
 * creator scrubs/picks the still frame that the card displays when it isn't
 * playing the clip. Saves a JPEG captured from the chosen moment.
 */

interface Frame {
  index: number;
  blob: Blob;
}

export function FrameModal({
  projectId,
  slot,
  onSave,
  onClose,
}: {
  projectId: string;
  slot: PhotoSlot;
  onSave: (still: Blob) => void;
  onClose: () => void;
}) {
  const kind = slot.animation?.kind ?? "video";
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(kind === "video" ? 0.2 : 0);
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void getFile(projectId, slot.animation!.fileKey).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, slot.animation?.fileKey]);

  // GIFs: decode all frames up front (WebCodecs ImageDecoder) so the picker
  // can step through them.
  useEffect(() => {
    if (kind !== "gif" || !url) return;
    let cancelled = false;
    void (async () => {
      if (!("ImageDecoder" in globalThis)) return; // first-frame fallback only
      setBusy("Decoding frames…");
      try {
        const blob = await getFile(projectId, slot.animation!.fileKey);
        if (!blob || cancelled) return;
        const decoder = new (globalThis as any).ImageDecoder({
          data: await blob.arrayBuffer(),
          type: "image/gif",
        });
        await decoder.tracks.ready;
        const count = Math.min(decoder.tracks.selectedTrack.frameCount, 40);
        const list: Frame[] = [];
        for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 12))) {
          const { image } = await decoder.decode({ frameIndex: i });
          const canvas = document.createElement("canvas");
          canvas.width = image.displayWidth;
          canvas.height = image.displayHeight;
          canvas.getContext("2d")!.drawImage(image, 0, 0);
          image.close?.();
          const frameBlob = await new Promise<Blob>((resolve) =>
            canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9),
          );
          list.push({ index: i, blob: frameBlob });
          if (cancelled) return;
        }
        setFrames(list);
      } catch {
        setError("Frame stepping isn't available here — “Use first frame” still works.");
      } finally {
        setBusy(null);
      }
    })();
    return () => { cancelled = true; };
  }, [kind, url, projectId, slot.animation?.fileKey]);

  const saveFrame = async () => {
    setBusy("Capturing…");
    try {
      const blob = await getFile(projectId, slot.animation!.fileKey);
      if (!blob) throw new Error("Clip file missing.");
      let still: Blob;
      if (kind === "video") {
        still = await extractPosterFrame(blob, time);
      } else if (frames && frames.length) {
        const chosen = frames.reduce((best, f) =>
          Math.abs(f.index - Math.round((time || 0) * 10)) < Math.abs(best.index - Math.round((time || 0) * 10)) ? f : best,
        frames[0]);
        still = chosen.blob;
      } else {
        still = await extractGifFrame(blob, 0);
      }
      onSave(still);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  // Show the chosen moment on the preview canvas (video) / decoded frame (gif).
  const updatePreview = async () => {
    if (kind !== "video" || !videoRef.current || !previewRef.current) return;
    const video = videoRef.current;
    const ctx = previewRef.current.getContext("2d")!;
    previewRef.current.width = video.videoWidth || 640;
    previewRef.current.height = video.videoHeight || 480;
    ctx.drawImage(video, 0, 0, previewRef.current.width, previewRef.current.height);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="frame-modal"
    >
      <div className="rounded-lg bg-white p-5 max-w-2xl w-full" role="dialog" aria-label="Choose display frame">
        <h2 className="font-semibold mb-1">Choose the display frame</h2>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
          Cards show this still frame; the {kind === "gif" ? "GIF" : "video"} is stored with the
          deck for playback.
        </p>

        {url && kind === "video" && (
          <div className="space-y-2">
            <video
              ref={videoRef}
              src={url}
              className="w-full max-h-80 rounded bg-black"
              muted
              playsInline
              onLoadedData={updatePreview}
              onTimeUpdate={updatePreview}
              data-testid="frame-video"
            />
            <input
              type="range"
              className="w-full"
              min={0}
              max={0.999}
              step={0.001}
              value={time}
              onChange={(e) => {
                const t = Number(e.target.value);
                setTime(t);
                if (videoRef.current && videoRef.current.duration) {
                  videoRef.current.currentTime = t * videoRef.current.duration;
                }
              }}
              aria-label="Frame position"
              data-testid="frame-scrubber"
            />
          </div>
        )}

        {url && kind === "gif" && (
          <div className="space-y-2">
            <img src={url} alt="" className="w-full max-h-80 rounded" data-testid="frame-gif" />
            {frames && (
              <div className="flex flex-wrap gap-2" data-testid="frame-list">
                {frames.map((f) => (
                  <button
                    key={f.index}
                    className={`rounded border-2 overflow-hidden cursor-pointer ${Math.abs(f.index - Math.round((time || 0) * 10)) < 5 ? "border-[var(--accent)]" : "border-transparent"}`}
                    onClick={() => setTime(Math.round((time || 0) * 10) === f.index ? time : f.index / 10)}
                    title={`Frame ${f.index}`}
                    data-testid={`frame-${f.index}`}
                  >
                    <img src={URL.createObjectURL(f.blob)} alt="" className="h-16" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!url && <div className="h-40 flex items-center justify-center text-sm" style={{ color: "var(--muted)" }}>Loading clip…</div>}
        {busy && <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>{busy}</p>}
        {error && <p className="text-sm mt-2" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}

        <div className="flex gap-2 mt-4">
          <button className="btn-primary" onClick={() => void saveFrame()} disabled={busy !== null} data-testid="frame-save">
            Use this frame
          </button>
          <button className="btn-secondary ml-auto" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
