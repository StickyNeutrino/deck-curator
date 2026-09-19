import type { Project } from "./types";
import { listFiles, putFile } from "./store";

/**
 * Portable project files (.deckcurator.json): the full project state with all
 * photos embedded as data URLs. Curators can hand these to each other or move
 * between machines; IndexedDB remains the autosave working copy.
 */

export interface ProjectFile {
  format: "deck-curator";
  version: 1;
  savedAt: string;
  project: Project;
  files: Record<string, string>; // fileKey → data URL
}

export async function serializeProjectFile(project: Project): Promise<string> {
  const files = await listFiles(project.id);
  const entries: Record<string, string> = {};
  for (const [key, blob] of files) {
    entries[key] = await blobToDataUrl(blob);
  }
  const doc: ProjectFile = {
    format: "deck-curator",
    version: 1,
    savedAt: new Date().toISOString(),
    project: structuredClone(project),
    files: entries,
  };
  return JSON.stringify(doc, null, 2);
}

export async function parseProjectFile(json: string): Promise<Project> {
  const doc = JSON.parse(json) as ProjectFile;
  if (doc.format !== "deck-curator" || !doc.project) {
    throw new Error("This file is not a Deck Curator project file.");
  }
  const project = doc.project;
  // Regenerate ids if importing a duplicate of an existing project.
  if (await projectExists(project.id)) {
    project.id = `${project.id}-${Date.now().toString(36)}`;
    project.name = `${project.name} (imported)`;
  }
  for (const [key, dataUrl] of Object.entries(doc.files ?? {})) {
    await putFile(project.id, key, await dataUrlToBlob(dataUrl));
  }
  return project;
}

async function projectExists(id: string): Promise<boolean> {
  const { getProject } = await import("./store");
  return Boolean(await getProject(id));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}
