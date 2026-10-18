/**
 * Browser storage helpers.
 *
 * Decks, photos, and version history all live in IndexedDB, and the version
 * history grows with every edit (each commit keeps its photo blobs). When the
 * origin runs out of the browser's storage quota, the failures are confusing:
 * Firefox first rejects a write with QuotaExceededError, then marks the
 * connection and converts the NEXT readwrite transaction into a "cleanup"
 * transaction — a special mode that exists only to purge data — whose every
 * put throws `InvalidStateError: A mutation operation was attempted on a
 * database that did not allow mutations.` That raw text names neither quota
 * nor storage, so the edit pages translate it (see isStorageFullError) into
 * what actually happened and what to do about it.
 */

/** True when an error is (or stems from) the browser running out of storage:
 *  a direct QuotaExceededError, one of the engine-specific quota wordings
 *  ("The current transaction exceeded its quota limitations.", "…not enough
 *  space…"), or Firefox's post-quota cleanup-transaction error quoted above.
 *  Anything else returns false — callers keep their own fallback text. */
export function isStorageFullError(err: unknown): boolean {
  if (err == null) return false;
  const record = err as { name?: unknown; message?: unknown };
  const name = typeof record.name === "string" ? record.name : "";
  // DOMException carries a message and a name but may not be an Error in
  // every engine, so read the fields off the object instead of instanceof.
  const message = typeof record.message === "string" ? record.message : "";
  const text = message || String(err);
  if (name === "QuotaExceededError") return true;
  return (
    /\bquota\b/i.test(text) ||
    /not enough .*(space|storage)/i.test(text) ||
    /mutation operation was attempted on a database that did not allow mutations/i.test(text)
  );
}

let persistenceRequested = false;

/** Ask the browser to keep this site's databases instead of evicting them
 *  under storage pressure. Browsers grant this automatically to sites in
 *  regular use — no prompt — and quietly refuse elsewhere; either outcome is
 *  acceptable, so the result is ignored. Called once per session. */
export function requestPersistentStorage(): void {
  if (persistenceRequested) return;
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  persistenceRequested = true;
  void navigator.storage.persist().catch(() => undefined);
}