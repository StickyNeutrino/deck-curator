import { describe, it, expect, vi, afterEach } from "vitest";
import { isStorageFullError } from "~/lib/browserStorage";

/**
 * Pin the translation of the browser's storage failures into the edit pages'
 * actionable banner copy. The one that matters most is Firefox's post-quota
 * "cleanup" transaction error — after the origin exceeds its storage quota,
 * Firefox converts the next readwrite transaction into a purge-only mode and
 * every write in it throws "A mutation operation was attempted on a database
 * that did not allow mutations.", a raw text that names neither quota nor
 * storage and reads like an application bug.
 */

const quotaError = (message: string, name = "QuotaExceededError"): DOMException =>
  new DOMException(message, name);

describe("isStorageFullError", () => {
  it("recognizes a direct QuotaExceededError regardless of wording", () => {
    expect(isStorageFullError(quotaError("Anything the engine likes"))).toBe(true);
  });

  it("recognizes Firefox's quota-transaction wording", () => {
    expect(
      isStorageFullError(quotaError("The current transaction exceeded its quota limitations.")),
    ).toBe(true);
  });

  it("recognizes Firefox's post-quota cleanup wording", () => {
    expect(
      isStorageFullError(
        quotaError(
          "A mutation operation was attempted on a database that did not allow mutations.",
          "InvalidStateError",
        ),
      ),
    ).toBe(true);
  });

  it("recognizes plain-string rejections", () => {
    expect(isStorageFullError("The current transaction exceeded its quota limitations.")).toBe(
      true,
    );
  });

  it("leaves unrelated errors alone", () => {
    expect(isStorageFullError(new Error("boom"))).toBe(false);
    expect(
      isStorageFullError(quotaError("A request was aborted, for example through a call to IDBTransaction.abort.", "AbortError")),
    ).toBe(false);
    expect(isStorageFullError(undefined)).toBe(false);
    expect(isStorageFullError(null)).toBe(false);
  });
});

describe("requestPersistentStorage", () => {
  afterEach(() => {
    vi.resetModules();
    delete (navigator as { storage?: unknown }).storage;
  });

  /** Fresh module instance per test — the request-once guard is module state. */
  const fresh = async () => (await vi.importActual<typeof import("~/lib/browserStorage")>("~/lib/browserStorage"));

  it("asks the browser once per session when the API exists", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "storage", {
      value: { persist },
      configurable: true,
    });
    const { requestPersistentStorage } = await fresh();
    requestPersistentStorage();
    requestPersistentStorage();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("tolerates the request being refused", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "storage", {
      value: { persist },
      configurable: true,
    });
    const { requestPersistentStorage } = await fresh();
    expect(() => requestPersistentStorage()).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does nothing where the API is missing", async () => {
    Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
    const { requestPersistentStorage } = await fresh();
    expect(() => requestPersistentStorage()).not.toThrow();
  });
});