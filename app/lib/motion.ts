/**
 * Moving media (animated GIFs & video clips): capture the still frame that
 * every card renderer displays, with the clip itself riding along in the
 * manifest for future playback.
 */

/** What kind of media a blob is, classified by its real content type (never
 *  trust the extension — iNat serves GIFs with .jpg URL variants). */
export function classifyMediaBlob(blob: Blob): "static" | "gif" | "video" {
  const type = (blob.type || "").toLowerCase();
  if (type === "image/gif") return "gif";
  if (type.startsWith("video/")) return "video";
  return "static";
}

/** Grab a JPEG frame from a video blob at `atSec`. Browser-only (canvas). */
export async function extractPosterFrame(videoBlob: Blob, atSec = 0.1): Promise<Blob> {
  const url = URL.createObjectURL(videoBlob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("This video couldn't be decoded in the browser."));
      setTimeout(() => reject(new Error("Video load timed out.")), 15_000);
    });
    if (atSec > 0 && atSec < video.duration) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = atSec;
        setTimeout(resolve, 3000); // seek safety net
      });
    }
    return canvasToJpeg(drawToCanvas(video, video.videoWidth || 640, video.videoHeight || 480));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Capture a still from an animated GIF. Uses WebCodecs ImageDecoder when
 *  available (frame-accurate); falls back to the first frame via <img>. */
export async function extractGifFrame(gifBlob: Blob, frameIndex = 0): Promise<Blob> {
  if ("ImageDecoder" in globalThis) {
    try {
      const decoder = new (globalThis as any).ImageDecoder({
        data: await gifBlob.arrayBuffer(),
        type: "image/gif",
      });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const index = Math.max(0, Math.min(frameIndex, track.frameCount - 1));
      const { image } = await decoder.decode({ frameIndex: index });
      const canvas = drawToCanvas(image, image.displayWidth, image.displayHeight);
      image.close?.();
      return canvasToJpeg(canvas);
    } catch {
      // Fall through to the <img> fallback (first frame).
    }
  }
  const url = URL.createObjectURL(gifBlob);
  try {
    const img = document.createElement("img");
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("GIF couldn't be decoded."));
    });
    return canvasToJpeg(drawToCanvas(img, img.naturalWidth || 640, img.naturalHeight || 480));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawToCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Frame capture failed."))), "image/jpeg", 0.9),
  );
}

/** True when a file the user picked is moving media (GIF or video). */
export function isMediaFile(file: File): "gif" | "video" | null {
  if (file.type === "image/gif") return "gif";
  if (file.type.startsWith("video/")) return "video";
  const name = file.name.toLowerCase();
  if (name.endsWith(".gif")) return "gif";
  if (/\.(mp4|mov|webm|m4v)$/.test(name)) return "video";
  return null;
}
