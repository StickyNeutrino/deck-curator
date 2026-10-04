import { openDB, type IDBPDatabase } from "idb";
import type { Project } from "./types";
import { migrateProject } from "./types";
import { blobToArrayBuffer } from "./blobUtils";

/**
 * Local persistence for curation projects. Everything lives in IndexedDB so
 * the curator works fully offline and nothing leaves the browser: one record
 * per project, one Blob per photo file, plus a cache of iNat API responses so
 * re-opening a project doesn't re-hit the API.
 *
 * Curation is long-running work, so the UI autosaves after every mutation;
 * portable copies of a deck are the export archive (manifest + photos zip).
 */

const DB_NAME = "deck-curator";
const DB_VERSION = 1;

interface CacheRecord {
  key: string;
  body: unknown;
  fetchedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  deckLabel: string;
  description: string;
  speciesCount: number;
  photoCount: number;
  updatedAt: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("projects")) {
          database.createObjectStore("projects", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("files")) {
          database.createObjectStore("files");
        }
        if (!database.objectStoreNames.contains("cache")) {
          database.createObjectStore("cache");
        }
      },
    });
  }
  return dbPromise;
}

function fileKey(projectId: string, key: string): string {
  return `${projectId}/${key}`;
}

export async function saveProject(project: Project, at?: string): Promise<void> {
  project.updatedAt = at ?? new Date().toISOString();
  const database = await db();
  await database.put("projects", structuredClone(project));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const database = await db();
  const record = (await database.get("projects", id)) as Project | undefined;
  // Older projects used a boolean invasive flag; migrate to border styles.
  return record ? migrateProject(record) : undefined;
}

/** Rename a deck: move every file under the old `${id}/` prefix and swap the
 *  project record — in one transaction, so a failure can't leave the files
 *  under one id and the record under the other. The deck's git repository is
 *  the caller's concern (versioning.renameRepo); the new id must not already
 *  be taken (the callers check). */
export async function renameProject(oldId: string, next: Project): Promise<void> {
  if (oldId === next.id) {
    await saveProject(next);
    return;
  }
  const database = await db();
  const tx = database.transaction(["projects", "files"], "readwrite");
  const projects = tx.objectStore("projects");
  const files = tx.objectStore("files");
  // Enforce uniqueness INSIDE the transaction — a concurrent tab (or a
  // stale caller check) could have created the target id meanwhile, and a
  // bare put would overwrite that deck.
  const clash = await projects.get(next.id);
  if (clash != null) {
    tx.abort();
    await tx.done.catch(() => undefined); // the expected AbortError, not ours to propagate
    throw new Error(`Another deck already uses the id “${next.id}”.`);
  }
  const keys = (await files.getAllKeys()) as string[];
  const moving = keys.filter((k) => k.startsWith(`${oldId}/`));
  const buffers = (await Promise.all(moving.map((k) => files.get(k)))) as Array<ArrayBuffer | undefined>;
  for (let i = 0; i < moving.length; i++) {
    const buffer = buffers[i];
    if (buffer == null) continue;
    files.put(buffer, `${next.id}/${moving[i].slice(oldId.length + 1)}`);
    files.delete(moving[i]);
  }
  projects.delete(oldId);
  projects.put(structuredClone(next));
  await tx.done;
  // Keep any cached blobs warm under the new prefix.
  if (blobCache.size > 0) {
    const moved = new Map<string, Blob>();
    for (const [cachedKey, blob] of blobCache) {
      moved.set(
        cachedKey.startsWith(`${oldId}/`)
          ? `${next.id}/${cachedKey.slice(oldId.length + 1)}`
          : cachedKey,
        blob,
      );
    }
    blobCache.clear();
    for (const [cachedKey, blob] of moved) blobCache.set(cachedKey, blob);
  }
}

/** Atomically replace a project's files and record — used by version
 *  restore so a failure can't leave the record pointing at changed files:
 *  every restored file write, every removal, and the record swap share one
 *  transaction. */
export async function restoreSnapshot(
  projectId: string,
  files: Map<string, ArrayBuffer>,
  keepKeys: Set<string>,
  project: Project,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(["projects", "files"], "readwrite");
  const filesStore = tx.objectStore("files");
  for (const [key, buffer] of files) {
    filesStore.put({ buffer, type: mimeForFileKey(key) }, fileKey(projectId, key));
  }
  const keys = (await filesStore.getAllKeys()) as string[];
  const prefix = `${projectId}/`;
  for (const k of keys) {
    if (k.startsWith(prefix) && !keepKeys.has(k.slice(prefix.length))) {
      filesStore.delete(k);
    }
  }
  tx.objectStore("projects").put(structuredClone(project));
  await tx.done;
  // The restore may have swapped bytes under existing keys — stale cache
  // entries would render the pre-restore photos.
  dropCachedBlobs(`${projectId}/`);
}

export async function deleteProject(id: string): Promise<void> {
  const database = await db();
  const keys = (await database.getAllKeys("files")) as string[];
  await Promise.all([
    database.delete("projects", id),
    ...keys.filter((k) => k.startsWith(`${id}/`)).map((k) => database.delete("files", k)),
  ]);
  dropCachedBlobs(`${id}/`);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const database = await db();
  const projects = (await database.getAll("projects")) as Project[];
  return projects
    .map((p) => ({
      id: p.id,
      name: p.name,
      deckLabel: p.deckLabel,
      description: p.description,
      speciesCount: p.species.length,
      photoCount: p.species.reduce((n, s) => n + s.photos.length, 0),
      updatedAt: p.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Store one photo file for a project. The blob's MIME type rides along so
 *  GIF/video clips and non-jpeg uploads survive the round trip; the bytes
 *  themselves are stored as an ArrayBuffer — structured-clone-safe in every
 *  IndexedDB implementation. */
export async function putFile(projectId: string, key: string, blob: Blob): Promise<void> {
  const database = await db();
  const buffer = await blobToArrayBuffer(blob);
  await database.put("files", { buffer, type: blob.type || "image/jpeg" }, fileKey(projectId, key));
  // A fresh write is by definition not stale: refresh the warm cache so the
  // next preview (e.g. back on the review page) shows the new bytes at once.
  rememberBlob(fileKey(projectId, key), blob);
}

interface StoredFile {
  buffer: ArrayBuffer;
  type: string;
}

/** Re-wrap a stored value as a Blob, tolerating records written before
 *  types were kept (bare ArrayBuffers, assumed jpeg). */
function storedToBlob(value: unknown): Blob | undefined {
  if (value == null) return undefined;
  if (value instanceof ArrayBuffer) return new Blob([value], { type: "image/jpeg" });
  const record = value as StoredFile;
  if (!record.buffer) return undefined;
  return new Blob([record.buffer], { type: record.type || "image/jpeg" });
}

/** Best-effort MIME type for a stored file name — archives and git blobs
 *  carry no content-type, so the extension is all we have. */
export function mimeForFileKey(key: string): string {
  if (/\.png$/i.test(key)) return "image/png";
  if (/\.gif$/i.test(key)) return "image/gif";
  if (/\.webp$/i.test(key)) return "image/webp";
  if (/\.mp4$/i.test(key)) return "video/mp4";
  if (/\.webm$/i.test(key)) return "video/webm";
  if (/\.mov$/i.test(key)) return "video/quicktime";
  return "image/jpeg";
}

export async function getFile(projectId: string, key: string): Promise<Blob | undefined> {
  const database = await db();
  return storedToBlob(await database.get("files", fileKey(projectId, key)));
}

export async function deleteFile(projectId: string, key: string): Promise<void> {
  const database = await db();
  await database.delete("files", fileKey(projectId, key));
  blobCache.delete(fileKey(projectId, key));
}

// ---------- warm session blob cache ----------
// Photo blobs are the slow part of a big deck: every page that shows cards
// re-reads the same bytes from IndexedDB. Keeping recently used blobs in
// memory (bounded, LRU-style) makes the review page open as if the cards
// were just created — and every write path above refreshes or drops entries,
// so a re-import, overwrite, or version restore can never serve stale bytes.

const BLOB_CACHE_LIMIT = 250;
const blobCache = new Map<string, Blob>(); // key: `${projectId}/${fileKey}`

function rememberBlob(cachedKey: string, blob: Blob): void {
  // Re-insert so the entry counts as most recently used for eviction.
  blobCache.delete(cachedKey);
  blobCache.set(cachedKey, blob);
  while (blobCache.size > BLOB_CACHE_LIMIT) {
    blobCache.delete(blobCache.keys().next().value!);
  }
}

function dropCachedBlobs(prefix: string): void {
  for (const cachedKey of Array.from(blobCache.keys())) {
    if (cachedKey.startsWith(prefix)) blobCache.delete(cachedKey);
  }
}

/** Synchronous cache check — a warm photo can render without waiting a tick. */
export function peekCachedFile(projectId: string, key: string): Blob | undefined {
  return blobCache.get(fileKey(projectId, key));
}

/** getFile that prefers the in-memory cache and fills it on a miss. */
export async function cachedGetFile(projectId: string, key: string): Promise<Blob | undefined> {
  const cachedKey = fileKey(projectId, key);
  const hit = blobCache.get(cachedKey);
  if (hit) return hit;
  const blob = await getFile(projectId, key);
  if (blob) rememberBlob(cachedKey, blob);
  return blob;
}

/** All files of a project, keyed by their in-project fileKey. */
export async function listFiles(projectId: string): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  await eachProjectFile(projectId, (key, value) => {
    const blob = storedToBlob(value);
    if (blob) out.set(key, blob);
  });
  return out;
}

/** Read every file record of one project in a single range-scoped
 *  transaction. The old reader did one `get` per photo in a serial loop —
 *  a hundred serial IndexedDB round-trips were why whole-deck previews took
 *  seconds to appear. One bulk scan plus two parallel requests is the
 *  difference between "loading" and "there". */
async function eachProjectFile(
  projectId: string,
  visit: (fileKey: string, value: unknown) => void,
): Promise<void> {
  const database = await db();
  const prefix = `${projectId}/`;
  // Inclusive upper bound one past every real key: string keys sort as
  // UTF-16 code units, and every unit is ≤ \uffff.
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const tx = database.transaction("files", "readonly");
  const store = tx.objectStore("files");
  // getAllKeys and getAll return records in the same (key) order, and the
  // shared transaction guarantees they describe the same snapshot.
  const [keys, values] = (await Promise.all([
    store.getAllKeys(range),
    store.getAll(range),
  ])) as [string[], unknown[]];
  await tx.done;
  for (let i = 0; i < keys.length; i++) {
    visit(keys[i].slice(prefix.length), values[i]);
  }
}

/** Just the fileKeys of a project's files — no blobs read. */
export async function listFileKeys(projectId: string): Promise<Set<string>> {
  const database = await db();
  const prefix = `${projectId}/`;
  const keys = (await database.getAllKeys(
    "files",
    IDBKeyRange.bound(prefix, `${prefix}\uffff`),
  )) as string[];
  return new Set(keys.map((k) => k.slice(prefix.length)));
}

// ---------- iNat API cache ----------

/** iNat responses are stable enough to cache indefinitely within the browser
 *  (the pipeline does the same on disk); deleting site data clears it. */
export async function getCachedApi(key: string): Promise<unknown | undefined> {
  const database = await db();
  const record = (await database.get("cache", key)) as CacheRecord | undefined;
  return record?.body;
}

export async function putCachedApi(key: string, body: unknown): Promise<void> {
  const database = await db();
  await database.put("cache", { key, body, fetchedAt: Date.now() }, key);
}

/** Test helper: drop every cached iNat API response. The cache is shared
 *  module state (one IndexedDB per test file's worker), so suites stubbing
 *  the API clear it up front to stay order-independent. */
export async function clearCachedApi(): Promise<void> {
  const database = await db();
  const keys = (await database.getAllKeys("cache")) as string[];
  for (const key of keys) await database.delete("cache", key);
}
