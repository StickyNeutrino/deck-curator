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

  it("orders permissive licenses first when the deck opts in, keeping vote order within a tier", async () => {
    const mod = await import("~/lib/inat");
    vi.spyOn(mod, "observations").mockResolvedValue([
      {
        id: 1,
        user: { login: "a" },
        // Vote order: NC photos are top-voted, permissive ones further down.
        photos: [
          { id: 1, license_code: "cc-by-nc", attribution: "", url: "https://x/photos/1/square.jpg", file_content_type: "image/jpeg" },
          { id: 2, license_code: "cc-by-nc-sa", attribution: "", url: "https://x/photos/2/square.jpg", file_content_type: "image/jpeg" },
          { id: 3, license_code: "cc-by", attribution: "", url: "https://x/photos/3/square.jpg", file_content_type: "image/jpeg" },
          { id: 4, license_code: "cc0", attribution: "", url: "https://x/photos/4/square.jpg", file_content_type: "image/jpeg" },
          { id: 5, license_code: "cc-by-sa", attribution: "", url: "https://x/photos/5/square.jpg", file_content_type: "image/jpeg" },
          { id: 6, license_code: "cc-by-nc", attribution: "", url: "https://x/photos/6/square.jpg", file_content_type: "image/jpeg" },
        ],
      } as never,
    ]);
    // Default (no settings): iNat's own vote order — the permissive-first
    // tiering is an opt-in now that the default is most-voted.
    const defaults = await candidatePhotos(1);
    expect(defaults.map((c) => c.photo.id)).toEqual([1, 2, 3, 4, 5, 6]);
    const all = await candidatePhotos(1, undefined, undefined, {
      settings: { licenses: ["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"], researchGrade: false, includeMedia: false, orderBy: "license" },
    });
    expect(all.map((c) => c.photo.id)).toEqual([4, 3, 5, 1, 6, 2]);
  });

  it("honors deck search settings: license subset, research grade, vote order", async () => {
    const mod = await import("~/lib/inat");
    const spy = vi.spyOn(mod, "observations").mockResolvedValue([
      {
        id: 1,
        quality_grade: "casual",
        user: { login: "a" },
        photos: [
          { id: 1, license_code: "cc-by-nc", attribution: "", url: "https://x/photos/1/square.jpg", file_content_type: "image/jpeg" },
          { id: 2, license_code: "cc-by", attribution: "", url: "https://x/photos/2/square.jpg", file_content_type: "image/jpeg" },
        ],
      },
      {
        id: 2,
        quality_grade: "research",
        user: { login: "b" },
        photos: [
          { id: 3, license_code: "cc0", attribution: "", url: "https://x/photos/3/square.jpg", file_content_type: "image/jpeg" },
        ],
      },
    ] as never);

    // Commercial deck: CC0/BY only. NC photo is dropped, and the server-side
    // license filter is passed through to the API call.
    const commercial = await candidatePhotos(1, undefined, undefined, {
      settings: { licenses: ["cc0", "cc-by"], researchGrade: false, includeMedia: false, orderBy: "license" },
    });
    expect(commercial.map((c) => c.photo.id)).toEqual([3, 2]);
    expect(spy.mock.calls[0][0].licenses).toBe("cc0,cc-by");

    // Research-grade-only deck: casual observations are dropped client-side.
    const research = await candidatePhotos(1, undefined, undefined, {
      settings: { licenses: ["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"], researchGrade: true, includeMedia: false, orderBy: "license" },
    });
    expect(research.map((c) => c.photo.id)).toEqual([3]);

    // orderBy "votes" skips the permissiveness sort.
    const voteOrder = await candidatePhotos(1, undefined, undefined, {
      settings: { licenses: ["cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa"], researchGrade: false, includeMedia: false, orderBy: "votes" },
    });
    expect(voteOrder.map((c) => c.photo.id)).toEqual([1, 2, 3]);
  });
});
