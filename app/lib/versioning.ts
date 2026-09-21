import type { Project } from "./types";
import { blobToArrayBuffer } from "./blobUtils";
import { buildManifest } from "./export";
import { getFile, putFile, deleteFile } from "./store";
import "./polyfills";

/**
 * Automatic git versioning for curation projects.
 *
 * Each project gets its own git repository, stored in IndexedDB via
 * LightningFS (isomorphic-git — real git objects, no server). Every save
 * commits `project.deckcurator.json` (the full working state), the built
 * `manifest.json`, and any changed `photos/*` — so the deck's history is a
 * real git history: the export page lists versions and can restore any of
 * them, and deck repos later stay diffable in git tooling.
 *
 * All failures are non-fatal by design: versioning problems must never
 * block editing or exporting.
 */

const AUTHOR = { name: "Deck Curator", email: "curator@localhost" };
const PROJECT_FILE = "project.deckcurator.json";
const MANIFEST_FILE = "manifest.json";

type Fs = any;
let fsInstance: Fs | null = null;

async function getFs(): Promise<Fs> {
  if (!fsInstance) {
    const { default: FS } = await import("@isomorphic-git/lightning-fs");
    fsInstance = new FS("deck-curator-git");
  }
  return fsInstance;
}

async function getGit() {
  const { default: git } = await import("isomorphic-git");
  return git;
}

export const dirFor = (projectId: string): string => `/${projectId}`;

/** Track photo sizes so unchanged blobs aren't rewritten every commit. */
const writtenSizes = new Map<string, number>();

function fingerprint(project: Project): string {
  // updatedAt changes on every save (including no-op ones), so exclude it:
  // identical edits shouldn't produce identical-content commits.
  const { updatedAt: _ignored, ...rest } = project;
  return JSON.stringify(rest);
}

const lastFingerprints = new Map<string, string>();

/** Create the repo (with an initial commit) if it doesn't exist yet — or if
 *  it exists but was created before any commit ever landed (older sessions
 *  could init a bare repo that never gained history). */
export async function ensureRepo(project: Project, files?: Map<string, Blob>): Promise<void> {
  const fs = await getFs();
  const git = await getGit();
  const dir = dirFor(project.id);
  let hasRepo = false;
  try {
    await fs.promises.stat(`${dir}/.git`);
    hasRepo = true;
  } catch {
    // No repo yet — fall through to init.
  }
  if (!hasRepo) {
    await git.init({ fs, dir });
  }
  try {
    const versions = await listVersions(project.id, 1);
    if (versions.length === 0) {
      await commitAll(project, files, `Created deck “${project.name}”`, { force: true });
    }
  } catch {
    // History unreadable — autosave will retry on the next change.
  }
}

/** Commit the current project state. `files` are photo blobs if already at
 *  hand (the caller usually has them); missing ones are read from the store. */
export async function commitDeckVersion(
  project: Project,
  files?: Map<string, Blob>,
  message?: string,
): Promise<string | null> {
  try {
    const fp = fingerprint(project);
    if (lastFingerprints.get(project.id) === fp && !message) {
      return null; // nothing new since the last commit
    }
    return await commitAll(project, files, message ?? defaultCommitMessage(project));
  } catch (err) {
    console.warn("Version commit failed (continuing without history):", err);
    return null;
  }
}

export function defaultCommitMessage(project: Project): string {
  const photos = project.species.reduce((n, s) => n + s.photos.length, 0);
  return `Autosave — ${project.species.length} species, ${photos} photos`;
}

async function commitAll(
  project: Project,
  files: Map<string, Blob> | undefined,
  message: string,
  { force = false }: { force?: boolean } = {},
): Promise<string | null> {
  const fs = await getFs();
  const git = await getGit();
  const dir = dirFor(project.id);

  if (!force) {
    try {
      await fs.promises.stat(`${dir}/.git`);
    } catch {
      await git.init({ fs, dir });
    }
  }

  const writeFile = async (path: string, data: Uint8Array | string): Promise<void> => {
    const full = `${dir}/${path}`;
    const parent = full.split("/").slice(0, -1).join("/");
    if (parent && parent !== dir) {
      try { await fs.promises.stat(parent); } catch { await fs.promises.mkdir(parent, true); }
    }
    await fs.promises.writeFile(full, data);
    await git.add({ fs, dir, filepath: path });
  };

  await writeFile(PROJECT_FILE, JSON.stringify(project, null, 2));
  await writeFile(MANIFEST_FILE, JSON.stringify(buildManifest(project), null, 2));

  for (const species of project.species) {
    for (const photo of species.photos) {
      const key = `${project.id}/${photo.fileKey}`;
      let blob = files?.get(photo.fileKey);
      if (!blob) blob = await getFile(project.id, photo.fileKey);
      if (!blob) continue;
      const size = blob.size;
      if (!force && writtenSizes.get(key) === size) continue; // unchanged photo
      await writeFile(`photos/${photo.fileKey}`, new Uint8Array(await blobToArrayBuffer(blob)));
      writtenSizes.set(key, size);
    }
  }

  const oid = await git.commit({ fs, dir, message, author: AUTHOR });
  lastFingerprints.set(project.id, fingerprint(project));
  return oid;
}

export interface VersionInfo {
  oid: string;
  message: string;
  timestamp: number;
}

/** Commit history, newest first. */
export async function listVersions(projectId: string, depth = 50): Promise<VersionInfo[]> {
  try {
    const fs = await getFs();
    const git = await getGit();
    const dir = dirFor(projectId);
    const log = await git.log({ fs, dir, depth });
    return log.map((entry: { oid: string; commit: { message: string; author: { timestamp: number } } }) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      timestamp: entry.commit.author.timestamp * 1000,
    }));
  } catch (err) {
    // A repo with no commits yet is normal (fresh init, first commit in
    // flight) — stay quiet; real failures still warn.
    const name = String((err as { name?: string })?.name ?? "");
    if (name === "NotFoundError" || name === "RepositoryNotFoundError") return [];
    console.warn("Version history unavailable:", err);
    return [];
  }
}

/** Restore a version: reads the commit's project + photos back into the
 *  live stores. The caller saves them and re-renders. */
export async function restoreVersion(
  projectId: string,
  oid: string,
): Promise<{ project: Project } | null> {
  const fs = await getFs();
  const git = await getGit();
  const dir = dirFor(projectId);
  await git.checkout({ fs, dir, ref: oid, force: true });
  const json = await fs.promises.readFile(`${dir}/${PROJECT_FILE}`, "utf8");
  const project = JSON.parse(json as string) as Project;

  // Replace the live photo store with the restored version's photos: import
  // the commit's photos and delete any current photos the version lacks.
  const collectKeys = new Set<string>();
  for (const s of project.species) for (const p of s.photos) collectKeys.add(p.fileKey);
  const { listFiles } = await import("./store");
  for (const [key] of await listFiles(projectId)) {
    if (!collectKeys.has(key)) await deleteFile(projectId, key);
  }
  for (const key of collectKeys) {
    try {
      const data = (await fs.promises.readFile(`${dir}/photos/${key}`)) as Uint8Array;
      await putFile(projectId, key, new Blob([data as BlobPart], { type: "image/jpeg" }));
    } catch {
      // A photo missing from that version simply stays missing.
    }
  }

  // The next autosave commits the restore (history keeps the full trail).
  for (const [mapKey] of [...writtenSizes]) {
    if (mapKey.startsWith(`${projectId}/`)) writtenSizes.delete(mapKey);
  }
  lastFingerprints.delete(projectId);
  return { project };
}

/** Export the git directory itself so the zip doubles as a real git repo. */
export async function collectGitDir(projectId: string): Promise<Map<string, Uint8Array> | null> {
  try {
    const fs = await getFs();
    const dir = `${dirFor(projectId)}/.git`;
    const out = new Map<string, Uint8Array>();
    const walk = async (path: string): Promise<void> => {
      const entries = (await fs.promises.readdir(path)) as string[];
      for (const entry of entries) {
        const full = path ? `${path}/${entry}` : entry;
        let stat: unknown;
        try { stat = await fs.promises.stat(full); } catch { continue; }
        if ((stat as { isDirectory?: () => boolean }).isDirectory?.()) {
          await walk(full);
        } else {
          const data = (await fs.promises.readFile(full)) as Uint8Array;
          out.set(full.replace(`${dirFor(projectId)}/`, ""), data);
        }
      }
    };
    await walk(dir);
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}
