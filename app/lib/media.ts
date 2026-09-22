import type { PhotoSlot } from "./types";
import { putFile } from "./store";
import { downloadPhoto, slotFromInatPhoto } from "./resolve";
import { classifyMediaBlob, extractGifFrame, extractPosterFrame } from "./motion";
import { type InatObservation, type InatPhoto } from "./inat";
import { uuid } from "./uuid";

/**
 * Turn one iNat media candidate into a stored PhotoSlot. Animated GIFs and
 * video clips are stored as their own files with a captured still frame as
 * the display image (the clip rides along in the manifest for playback).
 */

export interface AcquireOptions {
  role: "main" | "secondary";
  /** File-name base, e.g. "dudleya-edulis". */
  base: string;
  /** Whether animated media (GIF/video) may be used; static photos pass regardless. */
  includeAnimated: boolean;
  projectId: string;
}

/** Download + classify + store one candidate. Returns null when the candidate
 *  is moving media the deck opted out of, or when download/decode failed. */
export async function acquireMediaSlot(
  photo: InatPhoto,
  obs: InatObservation,
  opts: AcquireOptions,
): Promise<PhotoSlot | null> {
  let blob: Blob;
  try {
    blob = await downloadPhoto(photo);
  } catch {
    return null;
  }
  const kind = classifyMediaBlob(blob);

  if (kind === "gif" || kind === "video") {
    if (!opts.includeAnimated) return null;
    // Store the clip, then capture the still frame that renders on the card.
    const clipKey = `${opts.base}-anim-${uuid().slice(0, 6)}.${kind === "gif" ? "gif" : "mp4"}`;
    let still: Blob;
    try {
      still = kind === "gif" ? await extractGifFrame(blob, 0) : await extractPosterFrame(blob, 0.1);
    } catch {
      return null; // Undecodable clip — skip rather than ship a blank card.
    }
    const posterKey = `${opts.base}-${uuid().slice(0, 6)}.jpg`;
    await putFile(opts.projectId, posterKey, still);
    await putFile(opts.projectId, clipKey, blob);
    const slot = slotFromInatPhoto(photo, obs, opts.role, posterKey);
    slot.animation = { fileKey: clipKey, kind };
    return slot;
  }

  // Static image: store as-is under a stable, readable name.
  const fileKey = `${opts.base}-${uuid().slice(0, 6)}.jpg`;
  await putFile(opts.projectId, fileKey, blob);
  return slotFromInatPhoto(photo, obs, opts.role, fileKey);
}
