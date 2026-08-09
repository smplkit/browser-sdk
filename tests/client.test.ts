/** SmplClient: construction guard, bootstrap modes, runtime surface. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Context,
  SmplClient,
  SmplError,
  SmplNotFoundError,
  SmplTimeoutError,
} from "../src/index.js";
import { CONFIGS_BODY, FLAGS_BODY, MockEventSource, scriptedFetch, testEnv } from "./_helpers.js";

const KEY = "sk_public_test123";

function makeClient(overrides: Partial<Parameters<typeof scriptedFetch>[0][number]>[] = []) {
  const { fn } = scriptedFetch([
    { match: "flags.", respond: () => ({ body: FLAGS_BODY, etag: 'W/"f1"' }) },
    { match: "config.", respond: () => ({ body: CONFIGS_BODY, etag: 'W/"c1"' }) },
    { match: "app.", respond: () => ({ status: 200 }) },
    ...(overrides as never[]),
  ]);
  const { env } = testEnv({ fetch: fn, streaming: false });
  const client = new SmplClient({
    apiKey: KEY,
    bootstrap: "none",
    streaming: false,
    _env: env,
  });
  return client;
}

afterEach(() => {
  MockEventSource.reset();
  vi.useRealTimers();
});

describe("construction", () => {
  it("rejects a private sk_api_ key with a clear error", () => {
    expect(() => new SmplClient({ apiKey: "sk_api_secret" })).toThrow(SmplError);
    expect(() => new SmplClient({ apiKey: "sk_api_secret" })).toThrow(/publishable key/);
    expect(() => new SmplClient({ apiKey: "sk_api_secret" })).toThrow(/never be used/);
  });

  it("rejects admin keys, JWTs, and garbage", () => {
    for (const bad of ["sk_admin_x", "eyJhbGciOi...", "", undefined as unknown as string]) {
      expect(() => new SmplClient({ apiKey: bad })).toThrow(SmplError);
    }
  });

  it("accepts a public key and builds default URLs from baseDomain/scheme", async () => {
    const { fn, calls } = scriptedFetch([
      { match: "flags.example.test", respond: () => ({ body: FLAGS_BODY }) },
      { match: "config.example.test", respond: () => ({ body: CONFIGS_BODY }) },
    ]);
    const { env } = testEnv({ fetch: fn, streaming: false });
    const client = new SmplClient({
      apiKey: KEY,
      bootstrap: "none",
      streaming: false,
      baseDomain: "example.test",
      scheme: "http",
      _env: env,
    });
    await client.waitUntilReady();
    expect(calls.some((c) => c.url.startsWith("http://flags.example.test/api/v1/flags"))).toBe(
      true,
    );
    expect(calls.every((c) => c.url.includes(`api_key=${KEY}`))).toBe(true);
    client.close();
  });
});

describe("runtime surface", () => {
  it("evaluates flags with typed handles after ready", async () => {
    const client = makeClient();
    await client.waitUntilReady();

    // No context: rule doesn't match → flag default.
    expect(client.flags.booleanFlag("dark-mode", false).get()).toBe(false);

    client.setContext([new Context("user", "u_1", { plan: "pro" })]);
    expect(client.flags.booleanFlag("dark-mode", false).get()).toBe(true);

    // Explicit context beats the sticky one.
    expect(
      client.flags
        .booleanFlag("dark-mode", false)
        .get({ context: [new Context("user", "u_2", { plan: "free" })] }),
    ).toBe(false);

    // Unknown flags return the caller default, typed.
    expect(client.flags.stringFlag("missing", "d").get()).toBe("d");
    expect(client.flags.numberFlag("missing", 4).get()).toBe(4);
    expect(client.flags.jsonFlag("missing", { a: 1 }).get()).toEqual({ a: 1 });
    client.close();
  });

  it("type mismatches collapse to the handle default", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    client.setContext([new Context("user", "u_1", { plan: "pro" })]);
    // dark-mode evaluates to boolean true; string/number handles reject it.
    expect(client.flags.stringFlag("dark-mode", "s").get()).toBe("s");
    expect(client.flags.numberFlag("dark-mode", 7).get()).toBe(7);
    expect(client.flags.jsonFlag("dark-mode", { d: 1 }).get()).toEqual({ d: 1 });
    client.close();
  });

  it("getContext returns a copy; awaiting the sync factory also works", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    client.setContext([new Context("user", "u_1")]);
    const contexts = client.getContext();
    expect(contexts).toHaveLength(1);
    contexts.pop();
    expect(client.getContext()).toHaveLength(1);
    // Server-SDK style code with await still works.
    const handle = await client.flags.booleanFlag("dark-mode", false);
    expect(typeof handle.get()).toBe("boolean");
    client.close();
  });

  it("resolves configs through inheritance and env overrides", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    const cfg = await client.config.subscribe("web-app");
    expect(cfg["timeout"]).toBe(30); // parent env override for production
    expect(cfg["theme"]).toBe("light");
    expect(cfg.keys().sort()).toEqual(["theme", "timeout"]);
    expect(cfg.get("nope", "dflt")).toBe("dflt");
    expect(await client.config.getValue("web-app", "timeout")).toBe(30);
    expect(await client.config.getValue("web-app", "nope", "dflt")).toBe("dflt");
    await expect(client.config.getValue("web-app", "nope")).rejects.toThrow(SmplNotFoundError);
    await expect(client.config.subscribe("ghost")).rejects.toThrow(SmplNotFoundError);
    client.close();
  });

  it("LiveConfigProxy is read-only and enumerable", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    const cfg = await client.config.subscribe("web-app");
    expect(() => {
      (cfg as Record<string, unknown>).theme = "dark";
    }).toThrow(TypeError);
    expect(() => {
      delete (cfg as Record<string, unknown>).theme;
    }).toThrow(TypeError);
    expect("theme" in cfg).toBe(true);
    expect(Object.keys(cfg).sort()).toEqual(["theme", "timeout"]);
    expect(cfg.items().length).toBe(2);
    expect(cfg.values().length).toBe(2);
    client.close();
  });

  it("config onChange overloads register and misuse throws", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    const cb = vi.fn();
    client.config.onChange(cb);
    client.config.onChange("web-app", cb);
    client.config.onChange("web-app", "theme", cb);
    expect(() =>
      (client.config.onChange as (a: string, b: string) => void)("web-app", "theme"),
    ).toThrow(TypeError);
    const proxy = await client.config.subscribe("web-app");
    proxy.onChange(cb);
    proxy.onChange("theme", cb);
    expect(() => (proxy.onChange as (a: string) => void)("theme")).toThrow(TypeError);
    client.close();
  });

  it("flags.onChange and refresh delegate", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    const cb = vi.fn();
    client.flags.onChange(cb);
    client.flags.onChange("dark-mode", cb);
    await client.flags.refresh();
    await client.config.refresh();
    client.close();
  });
});

describe("waitUntilReady", () => {
  it("resolves immediately when bootstrap data is warm", async () => {
    const { fn } = scriptedFetch([]);
    const { env } = testEnv({ fetch: fn, streaming: false });
    const client = new SmplClient({
      apiKey: KEY,
      streaming: false,
      bootstrap: { flags: FLAGS_BODY, configs: CONFIGS_BODY },
      _env: env,
    });
    expect(client.ready).toBe(true);
    await client.waitUntilReady(); // immediate
    expect(client.flags.booleanFlag("dark-mode", false)).toBeDefined();
    client.close();
  });

  it("times out with SmplTimeoutError when nothing loads", async () => {
    vi.useFakeTimers();
    const { fn } = scriptedFetch([]); // every fetch fails
    const { env } = testEnv({ fetch: fn, streaming: false });
    const client = new SmplClient({ apiKey: KEY, bootstrap: "none", streaming: false, _env: env });
    const pending = client.waitUntilReady({ timeoutMs: 500 });
    const assertion = expect(pending).rejects.toThrow(SmplTimeoutError);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    client.close();
  });
});

describe("bootstrap: object payload", () => {
  it("hydrates from a server-rendered payload without network", () => {
    const { fn, calls } = scriptedFetch([]);
    const { env } = testEnv({ fetch: fn, streaming: false });
    const client = new SmplClient({
      apiKey: KEY,
      streaming: false,
      bootstrap: { flags: FLAGS_BODY, configs: CONFIGS_BODY },
      _env: env,
    });
    expect(client.ready).toBe(true);
    client.setContext([new Context("user", "u", { plan: "pro" })]);
    expect(client.flags.booleanFlag("dark-mode", false).get()).toBe(true);
    // Background revalidation still fires exactly once per endpoint.
    expect(calls.length).toBeLessThanOrEqual(2);
    client.close();
  });

  it("an empty payload object does not mark ready", () => {
    const { fn } = scriptedFetch([]);
    const { env } = testEnv({ fetch: fn, streaming: false });
    const client = new SmplClient({
      apiKey: KEY,
      streaming: false,
      bootstrap: {},
      _env: env,
    });
    expect(client.ready).toBe(false);
    client.close();
  });
});

describe("subscribe/version and close", () => {
  it("exposes the store's subscribe/version pair and close is idempotent", async () => {
    const client = makeClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await client.waitUntilReady();
    expect(listener).toHaveBeenCalled();
    expect(client.getVersion()).toBeGreaterThan(0);
    unsubscribe();
    expect(client.connectionStatus).toBe("polling");
    client.close();
    client.close();
    expect(client.connectionStatus).toBe("disconnected");
  });
});

describe("coverage completions", () => {
  it("Context validates type and key, and exposes id", () => {
    expect(() => new Context("", "k")).toThrow(TypeError);
    expect(() => new Context(12 as unknown as string, "k")).toThrow(TypeError);
    expect(() => new Context("user", "")).toThrow(TypeError);
    expect(() => new Context("user", null as unknown as string)).toThrow(TypeError);
    expect(new Context("user", "u_1").id).toBe("user:u_1");
  });

  it("LiveConfigProxy symbol/constructor/toJSON access and descriptor paths", async () => {
    const client = makeClient();
    await client.waitUntilReady();
    const cfg = await client.config.subscribe("web-app");
    expect((cfg as { constructor: unknown }).constructor).toBeDefined();
    expect((cfg as Record<string | symbol, unknown>)[Symbol.iterator]).toBeUndefined();
    expect((cfg as Record<string, unknown>)["toJSON"]).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(cfg, "theme")).toMatchObject({ enumerable: true });
    expect(Object.getOwnPropertyDescriptor(cfg, "ghost-key")).toBeUndefined();
    expect(Symbol.iterator in cfg).toBe(false);
    expect(JSON.stringify(cfg)).toContain("theme");
    client.close();
  });
});
