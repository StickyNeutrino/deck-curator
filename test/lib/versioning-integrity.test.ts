// Review-only reproducer; copy into test/ to run with the repository's Vitest config.
import { expect, it, vi } from "vitest";
import git from "isomorphic-git";
import FS from "@isomorphic-git/lightning-fs";
import { newProject } from "~/lib/importSpreadsheet";
import { makeSpecies } from "~/lib/types";
import { toolResultMerger } from "~/lib/tools";
import { saveProject, getProject, putFile, getFile, renameProject } from "~/lib/store";
import { ensureRepo, commitDeckVersion, listVersions, restoreVersion, renameRepo } from "~/lib/versioning";
import { exportProjectFile } from "~/lib/export";
import { importDeckArchive } from "~/lib/importDeck";
import * as store from "~/lib/store";
import { blobToArrayBuffer } from "~/lib/blobUtils";

const fixture = () => {
  const p = newProject(`Review ${crypto.randomUUID()}`);
  p.species = [makeSpecies({ commonName: "Oak", category: "plants" })];
  return p;
};

it("retains the active deck id when restoring a commit made before a rename", async () => {
  const p = fixture();
  await saveProject(p);
  await ensureRepo(p);
  const version = (await listVersions(p.id))[0];
  const renamed = { ...p, id: `${p.id}-new` };
  await renameProject(p.id, renamed);
  await renameRepo(p.id, renamed.id);
  const restored = await restoreVersion(renamed.id, version.oid);
  expect(restored!.project.id).toBe(renamed.id);
});

it("does not overwrite a curator's same-field edit made during a tool run", () => {
  const snapshot = fixture();
  const result = structuredClone(snapshot);
  result.species[0].native = "native";
  const live = structuredClone(snapshot);
  live.species[0].native = "non-native";
  toolResultMerger(snapshot, result)(live);
  expect(live.species[0].native).toBe("non-native");
});

it("retains live categories added during a taxonomy tool run", () => {
  const snapshot = fixture();
  const result = structuredClone(snapshot);
  result.categories.push({ id: "trees", label: "Trees" });
  const live = structuredClone(snapshot);
  live.categories.push({ id: "custom", label: "Custom" });
  live.species.push(makeSpecies({ commonName: "New", category: "custom" }));
  toolResultMerger(snapshot, result)(live);
  expect(live.categories.some(c => c.id === "custom")).toBe(true);
});

it("keeps an animation file when restoring its own version", async () => {
  const p = fixture();
  p.species[0].photos.push({ id: "p", role: "main", fileKey: "still.jpg", credit: { observer: "A", license: "cc0" }, animation: { fileKey: "clip.mp4", kind: "video" } });
  await putFile(p.id, "still.jpg", new Blob(["still"]));
  await putFile(p.id, "clip.mp4", new Blob(["video"], { type: "video/mp4" }));
  await saveProject(p);
  await ensureRepo(p);
  const version = (await listVersions(p.id))[0];
  await restoreVersion(p.id, version.oid);
  expect(await getFile(p.id, "clip.mp4")).toBeDefined();
});

it("records a changed photo even when project metadata has not changed", async () => {
  const p = fixture();
  p.species[0].photos.push({ id: "p", role: "main", fileKey: "still.jpg", credit: { observer: "A", license: "cc0" } });
  await putFile(p.id, "still.jpg", new Blob(["old"]));
  await ensureRepo(p);
  await putFile(p.id, "still.jpg", new Blob(["new"]));
  expect(await commitDeckVersion(p)).not.toBeNull();
});

it("restoring through the UI flow preserves previously uncommitted edits", async () => {
  const p = fixture();
  await saveProject(p);
  await ensureRepo(p);
  const version = (await listVersions(p.id))[0];
  p.species[0].commonName = "Uncommitted change";
  await saveProject(p);
  // The export page checkpoints the current state before restoring, so the
  // promise holds even when a pending autosave hasn't landed yet — and the
  // named checkpoint commits regardless of the autosave dedupe.
  await commitDeckVersion(p, undefined, "Before restoring abc12345", { silent: false });
  const restored = await restoreVersion(p.id, version.oid);
  await commitDeckVersion(restored!.project, undefined, "Restored version");
  const fs = new FS("deck-curator-git");
  const names = [];
  for (const v of await listVersions(p.id)) {
    const { blob } = await git.readBlob({ fs, dir: `/${p.id}`, oid: v.oid, filepath: "project.deckcurator.json" });
    names.push(JSON.parse(new TextDecoder().decode(blob)).species[0].commonName);
  }
  expect(names).toContain("Uncommitted change");
  expect(names).toContain("Oak");
});

it("preserves history through an exported archive imported as a new deck", async () => {
  const p = fixture();
  await saveProject(p);
  await ensureRepo(p);
  await commitDeckVersion(p, undefined, "Named historical version");
  const { blob } = await exportProjectFile(p);
  const imported = await importDeckArchive(new File([blob], "deck.zip"), { existingIds: [p.id] });
  await saveProject(imported);
  await ensureRepo(imported);
  expect((await listVersions(imported.id)).some(v => v.message === "Named historical version")).toBe(true);
});

it("serializes concurrent git operations so both commits land", async () => {
  const p = fixture();
  await saveProject(p);
  await ensureRepo(p);
  const before = (await listVersions(p.id)).length;
  // A navigation flush commit races the next page's ensureRepo in real
  // sessions; two writers on one LightningFS dir would corrupt the index,
  // so repo-touching operations queue per project.
  await Promise.all([
    commitDeckVersion({ ...p, name: `${p.name} A` }, undefined, "concurrent one"),
    commitDeckVersion({ ...p, name: `${p.name} B` }, undefined, "concurrent two"),
  ]);
  const messages = (await listVersions(p.id)).map((v) => v.message);
  expect(messages).toContain("concurrent one");
  expect(messages).toContain("concurrent two");
  expect(messages.length).toBe(before + 2);
});

it("does not recommit unchanged state on repeated autosave attempts", async () => {
  const p = fixture();
  await saveProject(p);
  await ensureRepo(p);
  const before = await listVersions(p.id);
  expect(await commitDeckVersion(p)).toBeNull();
  expect(await commitDeckVersion(p)).toBeNull();
  expect(await listVersions(p.id)).toHaveLength(before.length);
});

it("commits photo bytes replaced under an existing key when metadata changes in the same session", async () => {
  // Guards the session fingerprint cache in commitAll: entries are trusted
  // (no live re-read) until a byte-changing write invalidates them, so a
  // replaced photo must never be skipped because of a stale fingerprint.
  const p = fixture();
  p.species[0].photos.push({ id: "p", role: "main", fileKey: "still.jpg", credit: { observer: "A", license: "cc0" } });
  await putFile(p.id, "still.jpg", new Blob(["old"]));
  await ensureRepo(p); // commits "old" and caches its fingerprint
  await putFile(p.id, "still.jpg", new Blob(["new"])); // same key, new bytes
  p.species[0].commonName = "Renamed";
  await saveProject(p);
  expect(await commitDeckVersion(p)).not.toBeNull();
  const fs = new FS("deck-curator-git");
  const head = await git.resolveRef({ fs, dir: `/${p.id}`, ref: "HEAD" });
  const { blob } = await git.readBlob({ fs, dir: `/${p.id}`, oid: head, filepath: "photos/still.jpg" });
  expect(new TextDecoder().decode(blob)).toBe("new");
});

it("leaves live state untouched when the restore swap fails", async () => {
  const p = fixture();
  p.species[0].photos = ["a.jpg", "b.jpg"].map((key, i) => ({ id: key, fileKey: key, role: i ? "secondary" : "main", credit: { observer: "A", license: "cc0" } }));
  for (const key of ["a.jpg", "b.jpg"]) await putFile(p.id, key, new Blob(["old"]));
  await saveProject(p);
  await ensureRepo(p);
  const version = (await listVersions(p.id))[0];
  for (const key of ["a.jpg", "b.jpg"]) await putFile(p.id, key, new Blob(["new"]));

  // A failing swap must abort the whole operation: restoreVersion touches
  // nothing until the atomic store swap succeeds.
  const real = store.restoreSnapshot;
  const spy = vi.spyOn(store, "restoreSnapshot").mockRejectedValue(new Error("Simulated storage failure"));
  await expect(restoreVersion(p.id, version.oid)).rejects.toThrow("Simulated storage failure");
  spy.mockRestore();
  void real;

  const live = await getFile(p.id, "a.jpg");
  expect(new TextDecoder().decode(await blobToArrayBuffer(live!))).toBe("new");
  expect((await store.getProject(p.id))!.species[0].commonName).toBe("Oak");
  // And the restore can simply be retried.
  const restored = await restoreVersion(p.id, version.oid);
  expect(restored!.project.species[0].commonName).toBe("Oak");
});
