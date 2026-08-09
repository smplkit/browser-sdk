/**
 * Transport behaviors: poll scheduling, visibility pause/resume, offline,
 * stream supervision with backoff, the 503 poll directive, conditional
 * requests, and the jittered ping refetch. All timer-driven paths run
 * under fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../src/store.js";
import {
  Transport,
  parseConfigsResponse,
  parseFlagsResponse,
  type TransportOptions,
} from "../src/transport.js";
import {
  CONFIGS_BODY,
  FLAGS_BODY,
  MockEventSource,
  scriptedFetch,
  testEnv,
  type CannedResponse,
} from "./_helpers.js";

const KEY = "sk_public_t";
const POLL_MS = 900_000;
const FALLBACK_MS = 60_000;

function makeTransport(options: {
  routes: Array<{ match: string; respond: (url: string, init?: RequestInit) => CannedResponse }>;
  streaming?: boolean;
  onLine?: boolean;
  random?: () => number;
}) {
  const { fn, calls } = scriptedFetch(options.routes);
  const { env, doc, win, navigatorState } = testEnv({
    fetch: fn,
    streaming: options.streaming,
    onLine: options.onLine,
    random: options.random,
  });
  const store = new Store();
  const opts: TransportOptions = {
    apiKey: KEY,
    flagsUrl: "https://flags.test/api/v1/flags",
    configUrl: "https://config.test/api/v1/configs",
    eventsUrl: "https://app.test/api/v1/events",
    streaming: options.streaming ?? true,
    pollIntervalMs: POLL_MS,
    fallbackPollIntervalMs: FALLBACK_MS,
    env,
  };
  const transport = new Transport(opts, store);
  return { transport, store, calls, doc, win, navigatorState };
}

const okRoutes = [
  {
    match: "flags.test",
    respond: () => ({ body: FLAGS_BODY, etag: 'W/"f1"' }),
  },
  {
    match: "config.test",
    respond: () => ({ body: CONFIGS_BODY, etag: 'W/"c1"' }),
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("initial load and conditional requests", () => {
  it("fetches both endpoints with the key, stores ETags, and marks ready", async () => {
    const { transport, store, calls } = makeTransport({ routes: okRoutes, streaming: false });
    transport.start();
    await flush();
    expect(store.ready).toBe(true);
    expect(store.etags).toEqual({ flags: 'W/"f1"', configs: 'W/"c1"' });
    expect(calls.every((c) => c.url.includes(`api_key=${KEY}`))).toBe(true);
    transport.close();
  });

  it("sends If-None-Match on later fetches and keeps data on 304", async () => {
    let flagsCalls = 0;
    const { transport, store, calls } = makeTransport({
      streaming: false,
      routes: [
        {
          match: "flags.test",
          respond: () => {
            flagsCalls++;
            return flagsCalls === 1 ? { body: FLAGS_BODY, etag: 'W/"f1"' } : { status: 304 };
          },
        },
        okRoutes[1],
      ],
    });
    transport.start();
    await flush();
    await transport.refresh();
    const second = calls.filter((c) => c.url.includes("flags.test"))[1];
    expect((second.init?.headers as Record<string, string>)["If-None-Match"]).toBe('W/"f1"');
    expect(store.flags["dark-mode"]).toBeDefined();
    transport.close();
  });

  it("marks bootstrapped data ready on a double 304", async () => {
    const { transport, store } = makeTransport({
      streaming: false,
      routes: [
        { match: "flags.test", respond: () => ({ status: 304 }) },
        { match: "config.test", respond: () => ({ status: 304 }) },
      ],
    });
    store.etags = { flags: 'W/"f1"', configs: 'W/"c1"' };
    store.flags = parseFlagsResponse(FLAGS_BODY);
    store.configs = parseConfigsResponse(CONFIGS_BODY);
    transport.start();
    await flush();
    expect(store.ready).toBe(true);
    transport.close();
  });

  it("tolerates network failures, non-ok statuses, and bad JSON", async () => {
    let mode = 0;
    const { transport, store } = makeTransport({
      streaming: false,
      routes: [
        {
          match: "flags.test",
          respond: () => {
            if (mode === 0) return { status: 500 };
            return { body: FLAGS_BODY };
          },
        },
        // config.test unrouted → network error
      ],
    });
    transport.start();
    await flush();
    expect(store.ready).toBe(false);
    mode = 1;
    await transport.refresh();
    expect(store.ready).toBe(true);
    transport.close();
  });

  it("shares a single in-flight refresh", async () => {
    const { transport, calls } = makeTransport({ routes: okRoutes, streaming: false });
    transport.start();
    const a = transport.refresh();
    const b = transport.refresh();
    expect(a).toBe(b);
    await flush();
    await a;
    // start() already refreshed; the shared refresh is the second pair.
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBeLessThanOrEqual(2);
    transport.close();
  });
});

describe("polling", () => {
  it("polls at the fallback interval when streaming is off", async () => {
    const { transport, calls } = makeTransport({ routes: okRoutes, streaming: false });
    transport.start();
    await flush();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(FALLBACK_MS + 5);
    expect(calls.length).toBeGreaterThan(before);
    transport.close();
  });

  it("polls slowly while the stream is healthy", async () => {
    const { transport, calls } = makeTransport({ routes: okRoutes });
    transport.start();
    await flush();
    MockEventSource.latest().open();
    await flush();
    const before = calls.filter((c) => c.url.includes("flags.test")).length;
    await vi.advanceTimersByTimeAsync(FALLBACK_MS + 5);
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBe(before);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBeGreaterThan(before);
    transport.close();
  });

  it("pauses when hidden and re-fetches immediately on wake", async () => {
    const { transport, calls, doc } = makeTransport({ routes: okRoutes, streaming: false });
    transport.start();
    await flush();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    const hiddenBaseline = calls.length;
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 3);
    expect(calls.length).toBe(hiddenBaseline);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(calls.length).toBeGreaterThan(hiddenBaseline);
    // Wake refetch busts CDN caches.
    const wakeCall = calls[calls.length - 1];
    expect((wakeCall.init?.headers as Record<string, string>)["Cache-Control"]).toBe("no-cache");
    transport.close();
  });

  it("stops while offline and recovers on reconnect", async () => {
    const { transport, calls, win, navigatorState } = makeTransport({
      routes: okRoutes,
      streaming: false,
    });
    transport.start();
    await flush();
    navigatorState.onLine = false;
    win.dispatchEvent(new Event("offline"));
    const offlineBaseline = calls.length;
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 3);
    expect(calls.length).toBe(offlineBaseline);
    // refresh() while offline is a no-op.
    await transport.refresh();
    expect(calls.length).toBe(offlineBaseline);

    navigatorState.onLine = true;
    win.dispatchEvent(new Event("online"));
    await flush();
    expect(calls.length).toBeGreaterThan(offlineBaseline);
    transport.close();
  });

  it("does not start polls while hidden at schedule time", async () => {
    const { transport, calls, doc } = makeTransport({ routes: okRoutes, streaming: false });
    doc.visibilityState = "hidden";
    transport.start();
    await flush();
    const baseline = calls.length;
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
    expect(calls.length).toBe(baseline);
    transport.close();
  });
});

describe("streaming", () => {
  it("connects, reports status, and never reads data off events", async () => {
    const { transport, store, calls } = makeTransport({ routes: okRoutes, random: () => 0.5 });
    transport.start();
    await flush();
    expect(transport.connectionStatus).toBe("connecting");
    const stream = MockEventSource.latest();
    expect(stream.url).toContain(`api_key=${KEY}`);
    stream.open();
    expect(transport.connectionStatus).toBe("connected");
    expect(transport.streamHealthy).toBe(true);

    const baseline = calls.filter((c) => c.url.includes("flags.test")).length;
    stream.emit("flag_changed", '{"id":"dark-mode"}');
    stream.emit("config_changed", '{"id":"web-app"}'); // debounced into one refetch
    await vi.advanceTimersByTimeAsync(999); // jitter = 0.5 * 2000 = 1000ms
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBe(baseline);
    await vi.advanceTimersByTimeAsync(2);
    await flush();
    const after = calls.filter((c) => c.url.includes("flags.test"));
    expect(after.length).toBe(baseline + 1);
    const pingCall = after[after.length - 1];
    expect((pingCall.init?.headers as Record<string, string>)["Cache-Control"]).toBe("no-cache");
    expect(store.ready).toBe(true);
    transport.close();
  });

  it("ignores unknown events silently", async () => {
    const { transport, calls } = makeTransport({ routes: okRoutes, random: () => 0.5 });
    transport.start();
    await flush();
    const stream = MockEventSource.latest();
    stream.open();
    const baseline = calls.length;
    stream.emit("connected");
    stream.emit("mystery_event", "not json at all");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBeLessThanOrEqual(baseline);
    transport.close();
  });

  it("reconnects with jittered exponential backoff after failures", async () => {
    const routes = [
      ...okRoutes,
      { match: "app.test", respond: () => ({ status: 200 }) }, // probe: healthy
    ];
    const { transport } = makeTransport({ routes, random: () => 1 });
    transport.start();
    await flush();
    const first = MockEventSource.latest();
    first.fail();
    await flush();
    expect(first.closed).toBe(true);
    // attempt 0: base 1000, jitter(random=1) → full base delay.
    expect(MockEventSource.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(MockEventSource.instances.length).toBe(2);

    MockEventSource.latest().fail();
    await flush();
    // attempt 1: base 2000.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockEventSource.instances.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(MockEventSource.instances.length).toBe(3);

    // A successful open resets the ladder and fires a catch-up refetch.
    MockEventSource.latest().open();
    expect(transport.connectionStatus).toBe("connected");
    MockEventSource.latest().fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(MockEventSource.instances.length).toBe(4);
    transport.close();
  });

  it("caps the backoff ladder at 60s", async () => {
    const routes = [...okRoutes, { match: "app.test", respond: () => ({ status: 200 }) }];
    const { transport } = makeTransport({ routes, random: () => 1 });
    transport.start();
    await flush();
    for (let i = 0; i < 8; i++) {
      MockEventSource.latest().fail();
      await flush();
      await vi.advanceTimersByTimeAsync(60_001);
    }
    // 1+2+4+8+16+32+60+60 ladder exhausted without runaway growth.
    expect(MockEventSource.instances.length).toBe(9);
    transport.close();
  });

  it("probe network failure also schedules a reconnect", async () => {
    // No app.test route at all → the probe fetch throws.
    const { transport } = makeTransport({ routes: okRoutes, random: () => 1 });
    transport.start();
    await flush();
    MockEventSource.latest().fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(MockEventSource.instances.length).toBe(2);
    transport.close();
  });

  it("reconnect refetch catches up after a reopen", async () => {
    const routes = [...okRoutes, { match: "app.test", respond: () => ({ status: 200 }) }];
    const { transport, calls } = makeTransport({ routes, random: () => 0.5 });
    transport.start();
    await flush();
    MockEventSource.latest().open();
    MockEventSource.latest().fail();
    await flush();
    await vi.advanceTimersByTimeAsync(501); // backoff(0) with random 0.5 → 750ms? base=1000 → 500+250=750
    await vi.advanceTimersByTimeAsync(250);
    const baseline = calls.filter((c) => c.url.includes("flags.test")).length;
    MockEventSource.latest().open(); // reconnect (everConnected)
    await vi.advanceTimersByTimeAsync(1_001); // jittered catch-up refetch
    const after = calls.filter((c) => c.url.includes("flags.test"));
    expect(after.length).toBe(baseline + 1);
    expect((after[after.length - 1].init?.headers as Record<string, string>)["Cache-Control"]).toBe(
      "no-cache",
    );
    transport.close();
  });

  it("honors a 503 poll directive with Retry-After", async () => {
    let streamProbe = 0;
    const routes = [
      ...okRoutes,
      {
        match: "app.test",
        respond: () => {
          streamProbe++;
          return {
            status: 503,
            body: { poll_interval_seconds: 120 },
            headers: { "Retry-After": "300" },
          };
        },
      },
    ];
    const { transport, calls } = makeTransport({ routes, random: () => 1 });
    transport.start();
    await flush();
    MockEventSource.latest().fail();
    await flush();
    expect(streamProbe).toBe(1);
    expect(transport.connectionStatus).toBe("polling");

    // Directed polling at 120s, not the 60s fallback.
    const baseline = calls.filter((c) => c.url.includes("flags.test")).length;
    await vi.advanceTimersByTimeAsync(60_005);
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBe(baseline);
    await vi.advanceTimersByTimeAsync(60_005);
    expect(calls.filter((c) => c.url.includes("flags.test")).length).toBe(baseline + 1);

    // After Retry-After (300s), the stream is retried.
    expect(MockEventSource.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(300_000 - 120_010 + 10);
    expect(MockEventSource.instances.length).toBe(2);
    transport.close();
  });

  it("uses the default retry-after when the 503 carries none, and tolerates a bad body", async () => {
    const routes = [
      ...okRoutes,
      {
        match: "app.test",
        respond: () => ({ status: 503, body: undefined }),
      },
    ];
    const { transport } = makeTransport({ routes, random: () => 1 });
    transport.start();
    await flush();
    MockEventSource.latest().fail();
    await flush();
    expect(transport.connectionStatus).toBe("polling");
    // Default retry-after is 60s.
    await vi.advanceTimersByTimeAsync(60_010);
    expect(MockEventSource.instances.length).toBe(2);
    transport.close();
  });

  it("goes offline-quiet: stream torn down and no reconnect while offline", async () => {
    const routes = [...okRoutes, { match: "app.test", respond: () => ({ status: 200 }) }];
    const { transport, win, navigatorState } = makeTransport({ routes, random: () => 1 });
    transport.start();
    await flush();
    MockEventSource.latest().open();
    navigatorState.onLine = false;
    win.dispatchEvent(new Event("offline"));
    expect(MockEventSource.latest().closed).toBe(true);
    // While offline, connectStream is a no-op even if attempted.
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
    expect(MockEventSource.instances.length).toBe(1);
    navigatorState.onLine = true;
    win.dispatchEvent(new Event("online"));
    await flush();
    expect(MockEventSource.instances.length).toBe(2);
    transport.close();
  });

  it("streaming disabled or EventSource unavailable → polling status", async () => {
    const { transport } = makeTransport({ routes: okRoutes, streaming: false });
    transport.start();
    await flush();
    expect(transport.connectionStatus).toBe("polling");
    transport.close();
    expect(transport.connectionStatus).toBe("disconnected");
  });

  it("close during classify/reconnect cancels cleanly and start is idempotent", async () => {
    const routes = [...okRoutes, { match: "app.test", respond: () => ({ status: 200 }) }];
    const { transport } = makeTransport({ routes, random: () => 1 });
    transport.start();
    transport.start();
    await flush();
    MockEventSource.latest().fail();
    transport.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockEventSource.instances.length).toBe(1);
    // start() after close stays closed.
    transport.start();
    expect(transport.connectionStatus).toBe("disconnected");
  });
});

describe("wire parsing", () => {
  it("parses flags and unwraps config items", () => {
    const flags = parseFlagsResponse(FLAGS_BODY);
    expect(flags["dark-mode"].default).toBe(false);
    expect(flags["dark-mode"].environments?.production.rules).toHaveLength(1);

    const configs = parseConfigsResponse(CONFIGS_BODY);
    expect(configs["common"].items).toEqual({ timeout: 5 });
    expect(configs["web-app"].parent).toBe("common");
  });

  it("tolerates malformed bodies", () => {
    expect(parseFlagsResponse(null)).toEqual({});
    expect(parseFlagsResponse({ data: "nope" })).toEqual({});
    expect(parseFlagsResponse({ data: [{}, { id: 42 }, null] })).toEqual({});
    expect(parseConfigsResponse(undefined)).toEqual({});
    expect(parseConfigsResponse({ data: [null, { id: 1 }] })).toEqual({});
    expect(
      parseConfigsResponse({ data: [{ id: "c", attributes: { items: { k: null } } }] })["c"].items,
    ).toEqual({ k: null });
    expect(parseFlagsResponse({ data: [{ id: "f" }] })["f"].environments).toEqual({});
  });
});

describe("fetch edge cases", () => {
  it("bad JSON on a 200 is tolerated", async () => {
    const badFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("flags.test")) {
        return new Response("{not-json", { status: 200 });
      }
      return new Response(JSON.stringify(CONFIGS_BODY), { status: 200 });
    });
    const { env } = testEnv({ fetch: badFetch, streaming: false });
    const store = new Store();
    const transport = new Transport(
      {
        apiKey: KEY,
        flagsUrl: "https://flags.test/api/v1/flags",
        configUrl: "https://config.test/api/v1/configs",
        eventsUrl: "https://app.test/api/v1/events",
        streaming: false,
        pollIntervalMs: POLL_MS,
        fallbackPollIntervalMs: FALLBACK_MS,
        env,
      },
      store,
    );
    transport.start();
    await flush();
    // configs ingested, flags skipped
    expect(store.configs["common"]).toBeDefined();
    expect(Object.keys(store.flags)).toHaveLength(0);
    transport.close();
  });

  it("probe with a streaming 200 cancels the body", async () => {
    let cancelled = false;
    const streamBody = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const probeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("app.test")) {
        return new Response(streamBody, { status: 200 });
      }
      return new Response(JSON.stringify(url.includes("flags") ? FLAGS_BODY : CONFIGS_BODY), {
        status: 200,
      });
    });
    const { env } = testEnv({ fetch: probeFetch, random: () => 1 });
    const store = new Store();
    const transport = new Transport(
      {
        apiKey: KEY,
        flagsUrl: "https://flags.test/api/v1/flags",
        configUrl: "https://config.test/api/v1/configs",
        eventsUrl: "https://app.test/api/v1/events",
        streaming: true,
        pollIntervalMs: POLL_MS,
        fallbackPollIntervalMs: FALLBACK_MS,
        env,
      },
      store,
    );
    transport.start();
    await flush();
    MockEventSource.latest().fail();
    await flush();
    expect(cancelled).toBe(true);
    transport.close();
  });
});

describe("probe cancel failure", () => {
  it("a throwing body.cancel() on the probe is ignored", async () => {
    const throwingBody = {
      cancel: () => Promise.reject(new Error("cancel failed")),
    };
    const probeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("app.test")) {
        return {
          status: 200,
          ok: true,
          headers: new Headers(),
          body: throwingBody,
          json: async () => ({}),
        } as unknown as Response;
      }
      return new Response(JSON.stringify(url.includes("flags") ? FLAGS_BODY : CONFIGS_BODY), {
        status: 200,
      });
    });
    const { env } = testEnv({ fetch: probeFetch, random: () => 1 });
    const store = new Store();
    const transport = new Transport(
      {
        apiKey: KEY,
        flagsUrl: "https://flags.test/api/v1/flags",
        configUrl: "https://config.test/api/v1/configs",
        eventsUrl: "https://app.test/api/v1/events",
        streaming: true,
        pollIntervalMs: POLL_MS,
        fallbackPollIntervalMs: FALLBACK_MS,
        env,
      },
      store,
    );
    transport.start();
    await flush();
    MockEventSource.latest().fail();
    await flush();
    // Reconnect still scheduled despite the cancel failure.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(MockEventSource.instances.length).toBe(2);
    transport.close();
  });
});
