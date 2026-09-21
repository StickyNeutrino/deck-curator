import { Buffer } from "buffer";

/**
 * Browser polyfills for isomorphic-git: its code reads the global `Buffer`
 * (and occasionally `process`), which exist in Node — so unit tests pass —
 * but not in browser bundles. Load this module before any isomorphic-git
 * call (versioning.ts imports it first thing).
 *
 * No-ops in environments where the globals already exist.
 */

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

if (typeof globalThis.process === "undefined") {
  (globalThis as unknown as { process: unknown }).process = {
    env: {},
    browser: true,
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      setTimeout(() => fn(...args), 0),
  };
}
