import { cachedGetFile, peekCachedFile } from "./store";

/**
 * Prioritized progressive photo loading for the whole-deck review page.
 *
 * The page used to read every photo of the deck up front — serially — and
 * only revealed the grid once the LAST blob had arrived. Now card photos
 * resolve through this loader:
 *
 *  - reads are capped at a few in flight, so a hundred cards don't hit
 *    IndexedDB in the same instant and starve the ones on screen;
 *  - the page pins the first cards' fileKeys to the head of the queue, so
 *    the top of the grid populates first;
 *  - blobs ride the store's warm session cache, so coming back from the
 *    editor (or re-opening the page in the same session) is instant.
 */

/** Parallel reads — enough to keep IndexedDB busy without one slow photo
 *  holding up the queue any longer than it must. */
const PARALLEL_READS = 5;

export interface BlobLoader {
  /** The blob for a fileKey, settling as soon as it's in memory (undefined
   *  if the file doesn't exist). */
  resolve(fileKey: string): Promise<Blob | undefined>;
  /** Load these keys first, in display order — the head of the page. */
  prioritize(fileKeys: string[]): void;
}

export function createBlobLoader(projectId: string): BlobLoader {
  /** Scheduled but not yet started, in load order. */
  let queue: string[] = [];
  const started = new Set<string>();
  const waiting = new Map<string, Array<(blob: Blob | undefined) => void>>();
  let inFlight = 0;

  function settle(fileKey: string, blob: Blob | undefined): void {
    const resolvers = waiting.get(fileKey);
    waiting.delete(fileKey);
    for (const done of resolvers ?? []) done(blob);
  }

  function pump(): void {
    while (inFlight < PARALLEL_READS && queue.length > 0) {
      const fileKey = queue.shift()!;
      started.add(fileKey);
      inFlight++;
      void cachedGetFile(projectId, fileKey)
        .then((blob) => settle(fileKey, blob))
        .catch(() => settle(fileKey, undefined))
        .finally(() => {
          started.delete(fileKey);
          inFlight--;
          pump();
        });
    }
  }

  function enqueue(fileKey: string): void {
    if (started.has(fileKey) || queue.includes(fileKey)) return;
    queue.push(fileKey);
  }

  function resolve(fileKey: string): Promise<Blob | undefined> {
    const warm = peekCachedFile(projectId, fileKey);
    if (warm) return Promise.resolve(warm);
    // A key nobody prioritized (e.g. scrolled into view, or added to the
    // deck while the page is open) still loads — just behind the head.
    enqueue(fileKey);
    pump();
    return new Promise((done) => {
      const resolvers = waiting.get(fileKey) ?? [];
      resolvers.push(done);
      waiting.set(fileKey, resolvers);
    });
  }

  function prioritize(fileKeys: string[]): void {
    // Display order of the first cards goes to the head; anything already
    // pending that isn't in the list stays behind it. In-flight reads are
    // left alone — reordering them can't help.
    const head: string[] = [];
    for (const fileKey of fileKeys) {
      if (peekCachedFile(projectId, fileKey) || started.has(fileKey)) continue;
      if (!head.includes(fileKey)) head.push(fileKey);
    }
    if (head.length === 0) return;
    const headSet = new Set(head);
    queue = [...head, ...queue.filter((key) => !headSet.has(key))];
    pump();
  }

  return { resolve, prioritize };
}
