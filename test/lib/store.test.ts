import { describe, it, expect } from "vitest";
import { saveProject, getProject, listProjects, deleteProject, putFile, getFile, listFiles, deleteFile } from "~/lib/store";
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
});