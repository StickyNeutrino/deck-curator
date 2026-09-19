import "@testing-library/jest-dom";
import { vi } from "vitest";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";

// jsdom lacks URL.createObjectURL (needed for photo previews).
if (typeof URL.createObjectURL !== "function") {
  let counter = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++counter}`);
  URL.revokeObjectURL = vi.fn();
}

// jsdom's crypto lacks randomUUID (used for ids and upload slots).
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}
