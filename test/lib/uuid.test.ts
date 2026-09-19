import { describe, it, expect, afterEach, vi } from "vitest";
import { uuid } from "~/lib/uuid";

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true });
});

describe("uuid", () => {
  it("produces well-formed ids in secure contexts (crypto.randomUUID)", () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toContain("undefined");
  });

  it("falls back to getRandomValues outside secure contexts", () => {
    // crypto.randomUUID is secure-context-only; the curator is often served
    // over plain HTTP (container port forwarding), so this must still work.
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (arr: Uint8Array) => originalCrypto.getRandomValues(arr) },
      configurable: true,
    });
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(uuid());
  });

  it("works even without crypto at all", () => {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    const id = uuid();
    expect(id).toMatch(/^id-[a-z0-9]+-[a-z0-9]+$/);
    expect(id).not.toBe(uuid());
  });
});
