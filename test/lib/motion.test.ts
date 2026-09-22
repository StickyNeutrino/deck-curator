import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyMediaBlob, isMediaFile } from "~/lib/motion";
import { isVideoMedia } from "~/lib/inat";
import { candidatePhotos } from "~/lib/resolve";

describe("classifyMediaBlob", () => {
  it("classifies by real content type", () => {
    expect(classifyMediaBlob(new Blob([new Uint8Array(1)], { type: "image/gif" }))).toBe("gif");
    expect(classifyMediaBlob(new Blob([new Uint8Array(1)], { type: "video/mp4" }))).toBe("video");
    expect(classifyMediaBlob(new Blob([new Uint8Array(1)], { type: "image/jpeg" }))).toBe("static");
    expect(classifyMediaBlob(new Blob([new Uint8Array(1)]))).toBe("static");
  });
});

describe("isMediaFile (uploads)", () => {
  it("detects gif/video by type or extension", () => {
    expect(isMediaFile(new File([new Uint8Array(1)], "clip.mp4", { type: "video/mp4" }))).toBe("video");
    expect(isMediaFile(new File([new Uint8Array(1)], "anim.gif", { type: "image/gif" }))).toBe("gif");
    // Extension fallback (some browsers give empty type for gifs)
    expect(isMediaFile(new File([new Uint8Array(1)], "anim.gif"))).toBe("gif");
    expect(isMediaFile(new File([new Uint8Array(1)], "photo.jpg", { type: "image/jpeg" }))).toBeNull();
  });
});

describe("isVideoMedia (iNat candidates)", () => {
  it("detects video content types and URL shapes", () => {
    expect(isVideoMedia({ file_content_type: "video/mp4", url: "https://x/v.mp4" })).toBe(true);
    expect(isVideoMedia({ file_content_type: null, url: "https://x/videos/1/media.mp4" })).toBe(true);
    expect(isVideoMedia({ file_content_type: null, url: "https://x/photos/1/square.jpg" })).toBe(false);
  });
});

describe("candidatePhotos video filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips moving media unless includeVideos is set", async () => {
    const mod = await import("~/lib/inat");
    vi.spyOn(mod, "observations").mockResolvedValue([
      {
        id: 1,
        user: { login: "a" },
        photos: [
          { id: 11, license_code: "cc0", attribution: "", url: "https://x/photos/11/square.jpg", file_content_type: "image/jpeg" },
          { id: 12, license_code: "cc0", attribution: "", url: "https://x/videos/12/media.mp4", file_content_type: "video/mp4" },
        ],
      } as never,
    ]);
    const both = await candidatePhotos(1, undefined, undefined, { includeVideos: true });
    expect(both.map((c) => c.photo.id)).toEqual([11, 12]);
    const stills = await candidatePhotos(1, undefined, undefined, { includeVideos: false });
    expect(stills.map((c) => c.photo.id)).toEqual([11]);
  });
});
