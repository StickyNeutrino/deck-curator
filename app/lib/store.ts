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

export async function deleteProject(id: string): Promise<void> {
  const database = await db();
  const keys = (await database.getAllKeys("files")) as string[];
  await Promise.all([
    database.delete("projects", id),
    ...keys.filter((k) => k.startsWith(`${id}/`)).map((k) => database.delete("files", k)),
  ]);
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

/** Store one photo file for a project. Blobs are stored as ArrayBuffers —
 *  structured-clone-safe in every IndexedDB implementation. */
export async function putFile(projectId: string, key: string, blob: Blob): Promise<void> {
  const database = await db();
  const buffer = await blobToArrayBuffer(blob);
  await database.put("files", buffer, fileKey(projectId, key));
}

export async function getFile(projectId: string, key: string): Promise<Blob | undefined> {
  const database = await db();
  const buffer = (await database.get("files", fileKey(projectId, key))) as ArrayBuffer | undefined;
  return buffer ? new Blob([buffer], { type: "image/jpeg" }) : undefined;
}

export async function deleteFile(projectId: string, key: string): Promise<void> {
  const database = await db();
  await database.delete("files", fileKey(projectId, key));
}

/** All files of a project, keyed by their in-project fileKey. */
export async function listFiles(projectId: string): Promise<Map<string, Blob>> {
  const database = await db();
  const keys = (await database.getAllKeys("files")) as string[];
  const prefix = `${projectId}/`;
  const out = new Map<string, Blob>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const buffer = (await database.get("files", key)) as ArrayBuffer;
    out.set(key.slice(prefix.length), new Blob([buffer], { type: "image/jpeg" }));
  }
  return out;
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
