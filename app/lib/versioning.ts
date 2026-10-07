import type { Project } from "./types";
import { migrateProject, referencedFileKeys } from "./types";
import { blobToArrayBuffer } from "./blobUtils";
import { buildManifest } from "./export";
import { getFile, restoreSnapshot, onFileChange } from "./store";
import { getAuthor } from "./author";
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

/** Move a project's git repository to a new id (deck id rename). Best-effort:
 *  a deck that never committed has no repo to move. In-memory commit caches
 *  are remapped so the next autosave doesn't recommit unchanged photos. */
export async function renameRepo(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return;
  await withProjectLock(oldId, () => renameRepoUnlocked(oldId, newId));
}

async function renameRepoUnlocked(oldId: string, newId: string): Promise<void> {
  const fs = await getFs();
  const from = dirFor(oldId);
  const to = dirFor(newId);
  try {
    await fs.promises.stat(`${from}/.git`);
  } catch {
    return; // no repo yet — nothing to move
  }
  const copyDir = async (src: string, dest: string): Promise<void> => {
    try { await fs.promises.stat(dest); } catch { await fs.promises.mkdir(dest, true); }
    for (const entry of (await fs.promises.readdir(src)) as string[]) {
      const srcFull = `${src}/${entry}`;
      const destFull = `${dest}/${entry}`;
      const stat = await fs.promises.stat(srcFull);
      if ((stat as { isDirectory?: () => boolean }).isDirectory?.()) await copyDir(srcFull, destFull);
      else await fs.promises.writeFile(destFull, await fs.promises.readFile(srcFull));
    }
  };
  await copyDir(from, to);
  await removeDir(from);
  const oldPrefix = `${oldId}/`;
  for (const [key, content] of [...writtenFingerprints]) {
    if (key.startsWith(oldPrefix)) {
      writtenFingerprints.set(`${newId}/${key.slice(oldPrefix.length)}`, content);
      writtenFingerprints.delete(key);
    }
  }
  const fingerprint = lastFingerprints.get(oldId);
  if (fingerprint !== undefined) {
    lastFingerprints.set(newId, fingerprint);
    lastFingerprints.delete(oldId);
  }
}

async function removeDir(path: string): Promise<void> {
  const fs = await getFs();
  for (const entry of (await fs.promises.readdir(path)) as string[]) {
    const full = `${path}/${entry}`;
    const stat = await fs.promises.stat(full);
    if ((stat as { isDirectory?: () => boolean }).isDirectory?.()) await removeDir(full);
    else await fs.promises.unlink(full);
  }
  await fs.promises.rmdir(path);
}

/** Track committed photo content so unchanged blobs aren't rewritten every
 *  commit. Values are content fingerprints — size alone can't tell a
 *  replaced photo (same fileKey, same byte length, different image) from an
 *  unchanged one. */
const writtenFingerprints = new Map<string, string>();

// Photo bytes can change under an existing key — a re-upload, an archive
// re-import, a version restore. Every store write path notifies (see
// store.onFileChange); drop the session's cached fingerprint so the next
// commit re-reads the file instead of trusting stale content. Without this,
// commitAll would skip a photo whose bytes were just replaced.
onFileChange((projectId, fileKey) => {
  if (fileKey === null) {
    const prefix = `${projectId}/`;
    for (const key of [...writtenFingerprints.keys()]) {
      if (key.startsWith(prefix)) writtenFingerprints.delete(key);
    }
  } else {
    writtenFingerprints.delete(`${projectId}/${fileKey}`);
  }
});

/** Cheap content fingerprint: FNV-1a and djb2 over the bytes (64 bits of
 *  mixing, no collision-prone size shortcut). */
function contentFingerprintBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5; // FNV-1a 32-bit
  let h2 = 5381; // djb2
  for (let i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + bytes[i]) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}-${bytes.length}`;
}

async function contentFingerprint(blob: Blob): Promise<string> {
  return contentFingerprintBytes(new Uint8Array(await blobToArrayBuffer(blob)));
}

function fingerprint(project: Project): string {
  // updatedAt changes on every save (including no-op ones), so exclude it:
  // identical edits shouldn't produce identical-content commits.
  const { updatedAt: _ignored, ...rest } = project;
  return JSON.stringify(rest);
}

const lastFingerprints = new Map<string, string>();

/** Git operations on one project's repo must never interleave. An autosave
 *  flush fires when a page unmounts — exactly when the next page mounts and
 *  runs ensureRepo — and the export page commits and restores on its own.
 *  Two concurrent writers on the same LightningFS directory would race the
 *  index and the ref update, so everything repo-touching waits its turn. */
const projectQueues = new Map<string, Promise<unknown>>();

function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const tail = (projectQueues.get(projectId) ?? Promise.resolve()).catch(() => undefined);
  const run = tail.then(fn);
  projectQueues.set(projectId, run.catch(() => undefined));
  return run;
}

/** Create the repo (with an initial commit) if it doesn't exist yet — or if
 *  it exists but was created before any commit ever landed (older sessions
 *  could init a bare repo that never gained history). */
export async function ensureRepo(project: Project, files?: Map<string, Blob>): Promise<void> {
  await withProjectLock(project.id, async () => {
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
  });
}

/** Commit the current project state. `files` are photo blobs if already at
 *  hand (the caller usually has them); missing ones are read from the store.
 *  Returns the new commit's oid, or null when there was nothing to commit.
 *  With `silent` (the default) failures are swallowed — versioning must
 *  never block editing; pass `silent: false` for user-initiated saves that
 *  need honest error reporting. `onError` receives failures even in silent
 *  mode, so autosave can surface them instead of quietly going dead. */
export async function commitDeckVersion(
  project: Project,
  files?: Map<string, Blob>,
  message?: string,
  { silent = true, onError }: { silent?: boolean; onError?: (err: unknown) => void } = {},
): Promise<string | null> {
  try {
    return await withProjectLock(project.id, async () => {
      const fp = fingerprint(project);
      if (lastFingerprints.get(project.id) === fp && !message) {
        // Project JSON is unchanged — but photo BYTES can change under an
        // unchanged key (the session cache is invalidated on every write,
        // see onFileChange above). When every referenced file is verified
        // this session, there is nothing to commit.
        if (await unchangedAndCached(project)) return null;
        // Photo contents changed under unchanged metadata — fall through
        // and commit so the new bytes are actually recorded.
      }
      if (!lastFingerprints.has(project.id) && !message) {
        // A fresh session starts with an empty in-memory fingerprint map —
        // seed it from the repo so "first autosave after reload" doesn't
        // commit byte-identical state. (Named versions always commit.)
        const headFp = await headProjectFingerprint(project.id);
        if (headFp !== null) {
          lastFingerprints.set(project.id, headFp);
          if (headFp === fp && (await unchangedAndCached(project))) return null;
        }
      }
      return await commitAll(project, files, message ?? defaultCommitMessage(project));
    });
  } catch (err) {
    onError?.(err);
    if (!silent) throw err;
    console.warn("Version commit failed (continuing without history):", err);
    return null;
  }
}

/** True when there is nothing to commit for the current state: every
 *  referenced photo already has a session-verified fingerprint (entries are
 *  invalidated on every byte-changing write), or a one-time comparison
 *  against HEAD confirms the live bytes match — seeding the cache so the
 *  next decision is the cheap one. */
async function unchangedAndCached(project: Project): Promise<boolean> {
  const keys = [...referencedFileKeys(project)];
  if (keys.length === 0) return true;
  const missing = keys.filter((k) => !writtenFingerprints.has(`${project.id}/${k}`));
  if (missing.length === 0) return true;
  // A reference with no live bytes (dangling — validation flags it at export
  // time) can never produce a file write, so record it as verified instead
  // of re-deciding on every autosave. The empty marker never collides with
  // a real fingerprint, and a later putFile invalidates it like any write.
  const live = new Map<string, Blob>();
  const verified = new Map<string, string>();
  for (const fileKey of missing) {
    const blob = await getFile(project.id, fileKey);
    if (blob) live.set(fileKey, blob);
    else verified.set(`${project.id}/${fileKey}`, "");
  }
  const checkable = missing.filter((k) => live.has(k));
  if (checkable.length !== 0) {
    const matched = await verifyPhotosAgainstHead(project, checkable, live);
    if (matched === null) return false; // some bytes differ from HEAD → commit
    for (const [key, fp] of matched) verified.set(key, fp);
  }
  for (const [key, fp] of verified) writtenFingerprints.set(key, fp);
  return true;
}

/** Verify the given referenced photos against the commit at HEAD and return
 *  their session fingerprints — or null when any live bytes differ (or the
 *  history is unreadable: assume changed, commit). Git blob oids ARE content
 *  hashes, so the live side is hashed with the same git oid function and
 *  compared against the tree's oids — no committed blobs are read back.
 *  Each live blob is read exactly once, and the returned fingerprints seed
 *  the session cache (they were computed from those very bytes). */
async function verifyPhotosAgainstHead(
  project: Project,
  keys: string[],
  liveBlobs: Map<string, Blob>,
): Promise<Map<string, string> | null> {
  try {
    const fs = await getFs();
    const git = await getGit();
    const dir = dirFor(project.id);
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    let tree: Array<{ type: string; path: string; oid: string }>;
    try {
      tree = (await git.readTree({ fs, dir, oid: head, filepath: "photos" })).tree;
    } catch {
      return keys.length === 0 ? new Map() : null; // no photos committed yet
    }
    const committed = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e.oid]));
    const verified = new Map<string, string>();
    for (const fileKey of keys) {
      const oid = committed.get(fileKey);
      if (!oid) return null; // new file never committed
      const blob = liveBlobs.get(fileKey);
      if (!blob) return null;
      const bytes = new Uint8Array(await blobToArrayBuffer(blob));
      verified.set(`${project.id}/${fileKey}`, contentFingerprintBytes(bytes));
      const { oid: liveOid } = await git.hashBlob({ object: bytes });
      if (liveOid !== oid) return null; // replaced photo — commit the new bytes
    }
    return verified;
  } catch {
    return null; // unreadable history → assume changed, commit
  }
}

/** Leading text of every automatically generated commit message (see
 *  defaultCommitMessage) — the version history uses it to offer hiding
 *  these routine checkpoints from the list. Keep the two beside each
 *  other: a change to the generated message updates both. */
const AUTOSAVE_MESSAGE_PREFIX = "Autosave — ";

/** True when a commit was made automatically (vs. a named version or the
 *  deck's initial commit). Named notes the curator types are never
 *  filtered, so the prefix only ever matches generated messages. */
export function isAutosaveCommit(message: string): boolean {
  return message.startsWith(AUTOSAVE_MESSAGE_PREFIX);
}

export function defaultCommitMessage(project: Project): string {
  const photos = project.species.reduce((n, s) => n + s.photos.length, 0);
  return `${AUTOSAVE_MESSAGE_PREFIX}${project.species.length} species, ${photos} photos`;
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
      for (const fileKey of [photo.fileKey, photo.animation?.fileKey]) {
        if (!fileKey) continue;
        const key = `${project.id}/${fileKey}`;
        // A session fingerprint means these bytes were read and hashed
        // against the committed copy already; every byte-changing path
        // (putFile, restore, rename — see onFileChange) drops the entry, so
        // a replaced photo is always re-read. Caller-supplied files are
        // authoritative — never skip those.
        if (!force && !files?.has(fileKey) && writtenFingerprints.has(key)) continue;
        let blob = files?.get(fileKey);
        if (!blob) blob = await getFile(project.id, fileKey);
        if (!blob) continue;
        const content = await contentFingerprint(blob);
        if (!force && writtenFingerprints.get(key) === content) continue; // unchanged photo
        await writeFile(`photos/${fileKey}`, new Uint8Array(await blobToArrayBuffer(blob)));
        writtenFingerprints.set(key, content);
      }
    }
  }

  // Authorship is read at commit time — a saved curator identity (or the
  // default, see lib/author) stamps every version as it lands.
  const oid = await git.commit({ fs, dir, message, author: getAuthor() });
  lastFingerprints.set(project.id, fingerprint(project));
  return oid;
}

export interface VersionInfo {
  oid: string;
  message: string;
  timestamp: number;
  /** Commit authorship — the curator identity stamped when the version
   *  landed (see lib/author). Optional so plain version lists stay valid. */
  authorName?: string;
  authorEmail?: string;
}

/** Commit history, newest first. */
export async function listVersions(projectId: string, depth = 50): Promise<VersionInfo[]> {
  try {
    const fs = await getFs();
    const git = await getGit();
    const dir = dirFor(projectId);
    const log = await git.log({ fs, dir, depth });
    return log.map((entry: { oid: string; commit: { message: string; author: { name: string; email: string; timestamp: number } } }) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      timestamp: entry.commit.author.timestamp * 1000,
      authorName: entry.commit.author.name,
      authorEmail: entry.commit.author.email,
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

/** Restore a version: reads the commit's project + media straight out of
 *  the object store and swaps them into the live stores atomically (files
 *  and record in one IndexedDB transaction — a partial failure changes
 *  nothing). The working tree and HEAD are never touched: the caller commits
 *  the restored state as a normal commit on top, so every version stays
 *  reachable (checking out would have detached HEAD and orphaned newer
 *  commits).
 *
 *  The restored project keeps the LIVE deck id — history may predate an id
 *  rename, and saving the historical id would recreate the record/file
 *  mismatch the rename migration exists to prevent. */
export async function restoreVersion(
  projectId: string,
  oid: string,
): Promise<{ project: Project } | null> {
  return withProjectLock(projectId, () => restoreVersionUnlocked(projectId, oid));
}

async function restoreVersionUnlocked(
  projectId: string,
  oid: string,
): Promise<{ project: Project } | null> {
  const fs = await getFs();
  const git = await getGit();
  const dir = dirFor(projectId);

  const { blob: projectJson } = await git.readBlob({ fs, dir, oid, filepath: PROJECT_FILE });
  const project = migrateProject(
    JSON.parse(new TextDecoder().decode(projectJson)) as Project,
  );
  project.id = projectId;

  // Read every media file the version references BEFORE touching anything.
  const files = new Map<string, ArrayBuffer>();
  try {
    const { tree } = await git.readTree({ fs, dir, oid, filepath: "photos" });
    for (const entry of tree) {
      if (entry.type !== "blob") continue;
      try {
        const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
        files.set(entry.path, blob.slice().buffer as ArrayBuffer);
      } catch {
        // A corrupt/missing object just means that file restores missing —
        // validation flags dangling references at export time.
      }
    }
  } catch {
    // No photos/ tree — a version before media existed, or an empty deck.
  }

  await restoreSnapshot(projectId, files, referencedFileKeys(project), project);

  // Force the next commit to rewrite the manifest and media (history keeps
  // the full trail as a normal commit on HEAD).
  for (const [mapKey] of [...writtenFingerprints]) {
    if (mapKey.startsWith(`${projectId}/`)) writtenFingerprints.delete(mapKey);
  }
  lastFingerprints.delete(projectId);
  return { project };
}

/** Fingerprint of the project state at the repo's HEAD commit — null when
 *  there is no history. Used to seed the in-memory fingerprint map. */
async function headProjectFingerprint(projectId: string): Promise<string | null> {
  try {
    const fs = await getFs();
    const git = await getGit();
    const dir = dirFor(projectId);
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const { blob } = await git.readBlob({ fs, dir, oid: head, filepath: PROJECT_FILE });
    return fingerprint(JSON.parse(new TextDecoder().decode(blob)) as Project);
  } catch {
    return null; // no commits yet, or unreadable history
  }
}

/** Seed a project's git repository from a `.git/…` path map (deck-archive
 *  import). Best-effort and idempotent-ish: callers should treat a throw as
 *  "import without history". Path keys must live under `.git/` and contain
 *  no traversal segments. */
export async function writeGitDir(projectId: string, files: Map<string, Uint8Array>): Promise<void> {
  const fs = await getFs();
  const dir = dirFor(projectId);
  // LightningFS's mkdir doesn't create intermediates (recursive:true is a
  // no-op flag), so build the path level by level — including the top.
  const mkdirp = async (path: string): Promise<void> => {
    const segments = path.split("/").filter(Boolean);
    let cur = "";
    for (const seg of segments) {
      cur = `${cur}/${seg}`;
      try { await fs.promises.stat(cur); } catch { await fs.promises.mkdir(cur); }
    }
  };
  for (const [relPath, data] of files) {
    if (!relPath.startsWith(".git/") || relPath.split("/").some((seg) => seg === ".." || seg === "")) continue;
    const full = `${dir}/${relPath}`;
    await mkdirp(full.split("/").slice(0, -1).join("/"));
    await fs.promises.writeFile(full, data);
  }
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
