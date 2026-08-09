/** localStorage bootstrap: persist, load, key isolation, opt-out. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadPersisted, parseBootstrapPayload, persist } from "../src/bootstrap.js";
import { SmplClient } from "../src/client.js";
import { CONFIGS_BODY, FLAGS_BODY, scriptedFetch, testEnv } from "./_helpers.js";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get length(): number {
    return this.map.size;
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

let memory: MemoryStorage;

beforeEach(() => {
  memory = new MemoryStorage();
  vi.stubGlobal("localStorage", memory);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("persist/load", () => {
  it("round-trips state keyed by the api key", () => {
    persist("sk_public_a", { f: { default: 1 } }, {}, { flags: 'W/"x"' });
    persist("sk_public_b", { g: { default: 2 } }, {}, {});
    expect(memory.keys()).toEqual(["smplkit:browser:sk_public_a", "smplkit:browser:sk_public_b"]);

    const a = loadPersisted("sk_public_a");
    expect(a?.flags.f.default).toBe(1);
    expect(a?.etags).toEqual({ flags: 'W/"x"' });
    const b = loadPersisted("sk_public_b");
    expect(b?.flags.g.default).toBe(2);
    expect(loadPersisted("sk_public_c")).toBeNull();
  });

  it("rejects unknown versions and corrupt JSON", () => {
    memory.setItem("smplkit:browser:sk_public_a", JSON.stringify({ v: 99 }));
    expect(loadPersisted("sk_public_a")).toBeNull();
    memory.setItem("smplkit:browser:sk_public_a", "{corrupt");
    expect(loadPersisted("sk_public_a")).toBeNull();
  });

  it("persist failures are swallowed", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(() => persist("sk_public_a", {}, {}, {})).not.toThrow();
  });
});

describe("client integration", () => {
  it("boots warm from localStorage and persists on changes", async () => {
    const { fn } = scriptedFetch([
      { match: "flags.", respond: () => ({ body: FLAGS_BODY, etag: 'W/"f2"' }) },
      { match: "config.", respond: () => ({ body: CONFIGS_BODY, etag: 'W/"c2"' }) },
    ]);
    const { env } = testEnv({ fetch: fn, streaming: false });

    // Seed a warm cache with different data than the network returns.
    persist("sk_public_k", { "warm-flag": { default: "warm" } }, {}, { flags: 'W/"old"' });

    const client = new SmplClient({ apiKey: "sk_public_k", streaming: false, _env: env });
    // Warm data is evaluable immediately, before any network.
    expect(client.ready).toBe(true);
    expect(client.flags.stringFlag("warm-flag", "d").get()).toBe("warm");

    await client.waitUntilReady();
    await client.refresh();
    // Background revalidation replaced the store and persisted it.
    const persisted = loadPersisted("sk_public_k");
    expect(persisted?.flags["dark-mode"]).toBeDefined();
    expect(persisted?.etags).toEqual({ flags: 'W/"f2"', configs: 'W/"c2"' });
    client.close();
  });

  it("bootstrap: 'none' skips localStorage entirely", async () => {
    persist("sk_public_k", { "warm-flag": { default: "warm" } }, {}, {});
    const { fn } = scriptedFetch([]);
    const { env } = testEnv({ fetch: fn, streaming: false });
    const client = new SmplClient({
      apiKey: "sk_public_k",
      streaming: false,
      bootstrap: "none",
      _env: env,
    });
    expect(client.ready).toBe(false);
    expect(client.flags.stringFlag("warm-flag", "d").get()).toBe("d");
    client.close();
  });
});

describe("parseBootstrapPayload", () => {
  it("parses provided halves and leaves absent halves undefined", () => {
    const both = parseBootstrapPayload({ flags: FLAGS_BODY, configs: CONFIGS_BODY });
    expect(both.flags?.["dark-mode"]).toBeDefined();
    expect(both.configs?.["common"]).toBeDefined();
    const flagsOnly = parseBootstrapPayload({ flags: FLAGS_BODY });
    expect(flagsOnly.flags).toBeDefined();
    expect(flagsOnly.configs).toBeUndefined();
  });
});
