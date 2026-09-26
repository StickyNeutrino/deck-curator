import { describe, it, expect } from "vitest";
import { saveProject, getProject, listProjects, deleteProject, putFile, getFile, listFiles, deleteFile, renameProject } from "~/lib/store";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";

describe("project store", () => {
  it("round-trips a project", async () => {
    const project = newProject("Test Deck");
    project.species.push(makeSpecies({ commonName: "Oak", sciName: "Quercus" }));
    await saveProject(project);

    const loaded = await getProject(project.id);
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Test Deck");
    expect(loaded!.species).toHaveLength(1);
    expect(loaded!.species[0].commonName).toBe("Oak");
  });

  it("lists projects with counts, newest first", async () => {
    const a = newProject("Alpha");
    const b = newProject("Beta");
    a.species.push(makeSpecies({ commonName: "One" }));
    b.species.push(makeSpecies({ commonName: "Two" }), makeSpecies({ commonName: "Three" }));
    b.species[0].photos.push({
      id: "upload:x",
      role: "main",
      credit: { observer: "You", license: "cc0" },
      fileKey: "one-main.jpg",
    });
    await saveProject(a, "2026-01-01T00:00:00.000Z");
    await saveProject(b, "2026-02-01T00:00:00.000Z");

    const summaries = (await listProjects()).filter((p) => [a.id, b.id].includes(p.id));
    expect(summaries).toHaveLength(2);
    // b was saved after a → newest first.
    expect(summaries[0].name).toBe("Beta");
    expect(summaries[0].speciesCount).toBe(2);
    expect(summaries[0].photoCount).toBe(1);
    expect(summaries[1].name).toBe("Alpha");
  });

  it("deletes a project and its files", async () => {
    const project = newProject("Doomed");
    await saveProject(project);
    await putFile(project.id, "x.jpg", new Blob(["hello"]));
    await putFile("other", "y.jpg", new Blob([]));
    expect(await getFile(project.id, "x.jpg")).toBeInstanceOf(Blob);

    await deleteProject(project.id);
    expect(await getProject(project.id)).toBeUndefined();
    expect(await getFile(project.id, "x.jpg")).toBeUndefined();
    // Files of other projects survive.
    expect((await listFiles("other")).size).toBe(1);
  });

  it("deletes individual files", async () => {
    const project = newProject("Files");
    await saveProject(project);
    await putFile(project.id, "a.jpg", new Blob(["a"]));
    expect((await listFiles(project.id)).get("a.jpg")).toBeInstanceOf(Blob);
    await deleteFile(project.id, "a.jpg");
    expect(await getFile(project.id, "a.jpg")).toBeUndefined();
  });

  it("preserves each blob's MIME type through the store", async () => {
    const project = newProject("Mime");
    await saveProject(project);
    // Clips must keep video/gif types so classification still works after a
    // round trip; typeless blobs fall back to jpeg.
    await putFile(project.id, "clip.mp4", new Blob(["bytes"], { type: "video/mp4" }));
    await putFile(project.id, "pic.png", new Blob(["bytes"], { type: "image/png" }));
    await putFile(project.id, "plain.jpg", new Blob(["bytes"]));
    expect((await getFile(project.id, "clip.mp4"))!.type).toBe("video/mp4");
    expect((await getFile(project.id, "pic.png"))!.type).toBe("image/png");
    expect((await getFile(project.id, "plain.jpg"))!.type).toBe("image/jpeg");
    const listed = await listFiles(project.id);
    expect(listed.get("clip.mp4")!.type).toBe("video/mp4");
  });

  it("renames a project: record and files move to the new id", async () => {
    const project = newProject("Rename Me");
    await saveProject(project);
    await putFile(project.id, "photo-main.jpg", new Blob(["jpeg"]));
    await putFile("other", "keep.jpg", new Blob(["untouched"]));

    const next = { ...structuredClone(project), id: "renamed-deck" };
    await renameProject(project.id, next);

    // The old record and its files are gone; the new ones are in place.
    expect(await getProject(project.id)).toBeUndefined();
    expect(await getFile(project.id, "photo-main.jpg")).toBeUndefined();
    const loaded = await getProject("renamed-deck");
    expect(loaded).toBeDefined();
    expect(loaded!.deckLabel).toBe("Rename Me");
    expect((await getFile("renamed-deck", "photo-main.jpg"))!.size).toBe(4);
    // Other projects' files are untouched.
    expect((await getFile("other", "keep.jpg"))!.size).toBe(9);
  });
});