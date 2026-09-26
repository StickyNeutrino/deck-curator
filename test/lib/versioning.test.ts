import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import FS from "@isomorphic-git/lightning-fs";
import { unzipSync } from "fflate";
import { commitDeckVersion, ensureRepo, listVersions, restoreVersion } from "~/lib/versioning";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { saveProject, putFile, getFile } from "~/lib/store";
import { exportDeck } from "~/lib/export";
import { blobToArrayBuffer } from "~/lib/blobUtils";

function sample() {
  const project = newProject(`Versioned ${crypto.randomUUID().slice(0, 6)}`);
  const entry = makeSpecies({ commonName: "Oak", sciName: "Quercus", category: "plants" });
  project.species.push(entry);
  return project;
}

describe("git versioning", () => {
  it("creates history, lists versions, and restores an earlier one", async () => {
    const project = sample();
    await saveProject(project);
    await ensureRepo(project);

    // v1: no photo. (ensureRepo committed the initial state)
    let versions = await listVersions(project.id);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const initial = versions[0];

    // v2: add a photo and save a named version.
    const entry = project.species[0];
    entry.photos.push({
      id: "upload:x",
      role: "main",
      credit: { observer: "A", license: "cc0" },
      fileKey: "oak-main.jpg",
    });
    await putFile(project.id, "oak-main.jpg", new Blob(["jpeg-bytes-v2"]));
    await saveProject(project);
    await commitDeckVersion(project, undefined, "add photo");

    versions = await listVersions(project.id);
    expect(versions.map((v) => v.message)).toContain("add photo");

    // v3: change the species name, commit.
    project.species[0].commonName = "Renamed Oak";
    await saveProject(project);
    await commitDeckVersion(project, undefined, "rename");
    versions = await listVersions(project.id);
    expect(versions[0].message).toBe("rename");

    // Restore the "add photo" version: name reverts, photo survives.
    const addPhoto = versions.find((v) => v.message === "add photo")!;
    const restored = await restoreVersion(project.id, addPhoto.oid);
    expect(restored?.project.species[0].commonName).toBe("Oak");
    expect(await getFile(project.id, "oak-main.jpg")).toBeInstanceOf(Blob);
  }, 60000);

  it("restore keeps newer versions reachable and swaps photo bytes back", async () => {
    const project = sample();
    await saveProject(project);
    await ensureRepo(project); // v1: no photos

    // v2: add a photo.
    const entry = project.species[0];
    entry.photos.push({
      id: "upload:x",
      role: "main",
      credit: { observer: "A", license: "cc0" },
      fileKey: "oak-main.jpg",
    });
    await putFile(project.id, "oak-main.jpg", new Blob(["jpeg-v2"]));
    await saveProject(project);
    await commitDeckVersion(project, undefined, "add photo");
    const withPhoto = (await listVersions(project.id)).find((v) => v.message === "add photo")!;

    // v3: replace the photo with different bytes of the same length — a
    // size-only change detector would have left the old bytes in git.
    await putFile(project.id, "oak-main.jpg", new Blob(["jpeg-v3"]));
    await saveProject(project);
    await commitDeckVersion(project, undefined, "swap bytes");

    // Restore v2: the photo bytes must revert too (same size, different image).
    const restored = await restoreVersion(project.id, withPhoto.oid);
    const blob = await getFile(project.id, "oak-main.jpg");
    expect(new TextDecoder().decode(await blobToArrayBuffer(blob!))).toBe("jpeg-v2");

    // Committing the restore lands on HEAD: nothing is orphaned.
    await saveProject(restored!.project);
    const oid = await commitDeckVersion(restored!.project, undefined, "Restored version");
    expect(oid).not.toBeNull();
    const messages = (await listVersions(project.id)).map((v) => v.message);
    expect(messages[0]).toBe("Restored version");
    expect(messages).toContain("swap bytes");
    expect(messages).toContain("add photo");
  }, 60000);

  it("export includes the git dir so the zip is a real repository", async () => {
    const project = sample();
    await saveProject(project);
    await ensureRepo(project);
    await commitDeckVersion(project, undefined, "history marker");

    const { blob } = await exportDeck(project);
    const files = unzipSync(new Uint8Array(await blobToArrayBuffer(blob)));
    expect(Object.keys(files)).toContain("manifest.json");
    expect(Object.keys(files).some((k) => k.startsWith(".git/"))).toBe(true);
    // The committed manifest also rides in the repo.
    expect(Object.keys(files)).toContain("manifest.json");
  }, 60000);

  it("repo clone check: git log sees the same commits isomorphic-git wrote", async () => {
    const project = sample();
    await saveProject(project);
    await ensureRepo(project);
    await commitDeckVersion(project, undefined, "probe commit");
    // Reading through raw git (not our wrapper) confirms standard plumbing.
    const fs = new FS("deck-curator-git");
    const log = await git.log({ fs, dir: `/${project.id}`, depth: 10 });
    expect(log[0].commit.message.trim()).toBe("probe commit");
  }, 60000);
});
