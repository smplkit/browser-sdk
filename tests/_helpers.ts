/**
 * Shared test doubles: a scripted fetch, a controllable EventSource, and
 * an injectable transport environment.
 */
import { vi } from "vitest";

import type { TransportEnv } from "../src/transport.js";

export interface CannedResponse {
  status?: number;
  body?: unknown;
  etag?: string;
  headers?: Record<string, string>;
}

export function makeResponse(canned: CannedResponse): Response {
  const headers = new Headers(canned.headers ?? {});
  if (canned.etag) headers.set("ETag", canned.etag);
  const status = canned.status ?? 200;
  const body = canned.body === undefined ? null : JSON.stringify(canned.body);
  return new Response(status === 304 || status === 204 ? null : body, { status, headers });
}

/** A fetch stub that routes by URL substring, recording every call. */
export function scriptedFetch(
  routes: Array<{ match: string; respond: (url: string, init?: RequestInit) => CannedResponse }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    for (const route of routes) {
      if (url.includes(route.match)) {
        return makeResponse(route.respond(url, init));
      }
    }
    throw new TypeError(`network error (no route for ${url})`);
  });
  return { fn, calls };
}

type Listener = (event: MessageEvent) => void;

/** A controllable EventSource double. */
export class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(name: string, cb: Listener): void {
    const list = this.listeners.get(name) ?? [];
    list.push(cb);
    this.listeners.set(name, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  // -- test controls --
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  fail(): void {
    this.readyState = 2;
    this.onerror?.();
  }

  emit(name: string, data = "{}"): void {
    for (const cb of this.listeners.get(name) ?? []) {
      cb({ data } as MessageEvent);
    }
  }

  static reset(): void {
    MockEventSource.instances = [];
  }

  static latest(): MockEventSource {
    const instance = MockEventSource.instances[MockEventSource.instances.length - 1];
    if (!instance) throw new Error("no MockEventSource constructed yet");
    return instance;
  }
}

export class FakeVisibilityDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
}

export class FakeWindow extends EventTarget {}

export interface TestEnvOptions {
  fetch: TransportEnv["fetch"];
  streaming?: boolean;
  onLine?: boolean;
  random?: () => number;
}

export function testEnv(options: TestEnvOptions): {
  env: TransportEnv;
  doc: FakeVisibilityDocument;
  win: FakeWindow;
  navigatorState: { onLine: boolean };
} {
  const doc = new FakeVisibilityDocument();
  const win = new FakeWindow();
  const navigatorState = { onLine: options.onLine ?? true };
  const env: TransportEnv = {
    fetch: options.fetch,
    EventSourceImpl:
      options.streaming === false
        ? undefined
        : (MockEventSource as unknown as new (url: string) => EventSource),
    document: doc as unknown as TransportEnv["document"],
    window: win as unknown as TransportEnv["window"],
    navigator: navigatorState,
    random: options.random ?? (() => 0.5),
  };
  return { env, doc, win, navigatorState };
}

export const FLAGS_BODY = {
  data: [
    {
      id: "dark-mode",
      type: "flag",
      attributes: {
        name: "Dark Mode",
        description: null,
        type: "BOOLEAN",
        default: false,
        values: null,
        environments: {
          production: {
            enabled: true,
            default: null,
            rules: [
              {
                description: null,
                logic: { "==": [{ var: "user.plan" }, "pro"] },
                value: true,
              },
            ],
          },
        },
        managed: true,
        sources: null,
        created_at: null,
        updated_at: null,
      },
    },
  ],
  meta: { pagination: { page: 1, size: 1 } },
};

export const CONFIGS_BODY = {
  data: [
    {
      id: "common",
      type: "config",
      attributes: {
        name: "Common",
        description: null,
        parent: null,
        items: { timeout: { value: 5, type: "NUMBER", description: null } },
        environments: { production: { timeout: 30 } },
        managed: true,
        created_at: null,
        updated_at: null,
      },
    },
    {
      id: "web-app",
      type: "config",
      attributes: {
        name: "Web App",
        description: null,
        parent: "common",
        items: { theme: { value: "light", type: "STRING", description: null } },
        environments: {},
        managed: true,
        created_at: null,
        updated_at: null,
      },
    },
  ],
  meta: { pagination: { page: 1, size: 2 } },
};
