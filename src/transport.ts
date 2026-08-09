/**
 * Transport: how definitions reach the store, and how they stay fresh.
 *
 * Streaming is the default — a native `EventSource` against the app
 * service's SSE endpoint, with the public key as a query parameter
 * (`EventSource` cannot set headers). The stream is a change *signal*
 * only: no data is ever read off it. On any known event the client
 * waits a random 0–2s (so a change does not produce a synchronized
 * stampede) and re-fetches flags and config with `Cache-Control:
 * no-cache` to force CDN revalidation.
 *
 * Polling is an automatic safety net, not a mode: slow while the stream
 * is healthy (default 15 min, catching dropped events), tightened
 * (default 60s) while the stream is down, and directed by the server
 * when the stream endpoint returns a 503 with `poll_interval_seconds`.
 * Polling pauses entirely while the document is hidden and while the
 * browser is offline; both resume with an immediate re-fetch.
 */

import type { FlagDefinition } from "./evaluate.js";
import type { ConfigDefinition, Store } from "./store.js";

/** Event names that signal flag/config changes on the stream. */
const CHANGE_EVENTS = [
  "flag_changed",
  "flag_deleted",
  "flags_changed",
  "config_changed",
  "config_deleted",
  "configs_changed",
] as const;

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const PING_JITTER_MS = 2_000;
const DEFAULT_STREAM_RETRY_AFTER_S = 60;

/** Injectable host environment, so transport behavior is fully testable. */
export interface TransportEnv {
  fetch: typeof globalThis.fetch;
  EventSourceImpl: (new (url: string) => EventSource) | undefined;
  document:
    Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | undefined;
  window: Pick<Window, "addEventListener" | "removeEventListener"> | undefined;
  navigator: Pick<Navigator, "onLine"> | undefined;
  random: () => number;
}

/* v8 ignore start — trivially-glue default environment; every branch is
   exercised indirectly through the real browser/Node globals. */
export function defaultTransportEnv(): TransportEnv {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    EventSourceImpl: typeof EventSource !== "undefined" ? EventSource : undefined,
    document: typeof document !== "undefined" ? document : undefined,
    window: typeof window !== "undefined" ? window : undefined,
    navigator: typeof navigator !== "undefined" ? navigator : undefined,
    random: Math.random,
  };
}
/* v8 ignore stop */

export interface TransportOptions {
  apiKey: string;
  flagsUrl: string;
  configUrl: string;
  eventsUrl: string;
  streaming: boolean;
  pollIntervalMs: number;
  fallbackPollIntervalMs: number;
  env: TransportEnv;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "polling";

interface WireResource {
  id?: string;
  attributes?: Record<string, unknown>;
}

/** @internal Parse a flags list response body into store definitions. */
export function parseFlagsResponse(body: unknown): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {};
  const data = (body as { data?: WireResource[] })?.data;
  if (!Array.isArray(data)) return flags;
  for (const resource of data) {
    if (!resource || typeof resource.id !== "string") continue;
    const attrs = resource.attributes ?? {};
    flags[resource.id] = {
      name: attrs.name as string | undefined,
      type: attrs.type as string | undefined,
      default: attrs.default,
      values: (attrs.values as FlagDefinition["values"]) ?? null,
      environments: (attrs.environments as FlagDefinition["environments"]) ?? {},
    };
  }
  return flags;
}

/** @internal Parse a configs list response body into store definitions. */
export function parseConfigsResponse(body: unknown): Record<string, ConfigDefinition> {
  const configs: Record<string, ConfigDefinition> = {};
  const data = (body as { data?: WireResource[] })?.data;
  if (!Array.isArray(data)) return configs;
  for (const resource of data) {
    if (!resource || typeof resource.id !== "string") continue;
    const attrs = resource.attributes ?? {};
    const rawItems = (attrs.items ?? {}) as Record<string, { value?: unknown } | null>;
    const items: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(rawItems)) {
      // The wire item is `{value, type, description}`; resolution wants
      // the raw value map (mirrors the server SDK's items getter).
      items[key] = item && typeof item === "object" && "value" in item ? item.value : item;
    }
    configs[resource.id] = {
      name: attrs.name as string | undefined,
      parent: (attrs.parent as string | null) ?? null,
      items,
      environments: (attrs.environments as Record<string, unknown>) ?? {},
    };
  }
  return configs;
}

/** @internal */
export class Transport {
  private readonly _opts: TransportOptions;
  private readonly _store: Store;
  private readonly _env: TransportEnv;

  private _closed = false;
  private _started = false;
  private _stream: EventSource | null = null;
  private _streamHealthy = false;
  private _everConnected = false;
  private _backoffAttempt = 0;
  private _status: ConnectionStatus = "disconnected";

  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer: ReturnType<typeof setTimeout> | null = null;
  private _retryStreamTimer: ReturnType<typeof setTimeout> | null = null;

  /** Server-directed poll interval (ms) from a 503, or null. */
  private _directedPollMs: number | null = null;

  private _refreshInFlight: Promise<void> | null = null;

  private _onVisibility = (): void => {
    if (this._env.document?.visibilityState === "hidden") {
      this._clearPollTimer();
    } else {
      void this.refresh({ noCache: true });
      this._schedulePoll();
    }
  };

  private _onOnline = (): void => {
    void this.refresh({ noCache: true });
    this._schedulePoll();
    if (this._shouldStream() && this._stream === null) {
      this._connectStream();
    }
  };

  private _onOffline = (): void => {
    this._clearPollTimer();
    this._teardownStream();
  };

  constructor(opts: TransportOptions, store: Store) {
    this._opts = opts;
    this._store = store;
    this._env = opts.env;
  }

  get connectionStatus(): ConnectionStatus {
    return this._status;
  }

  get streamHealthy(): boolean {
    return this._streamHealthy;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  start(): void {
    if (this._started || this._closed) return;
    this._started = true;

    this._env.document?.addEventListener("visibilitychange", this._onVisibility);
    this._env.window?.addEventListener("online", this._onOnline);
    this._env.window?.addEventListener("offline", this._onOffline);

    void this.refresh();
    if (this._shouldStream()) {
      this._connectStream();
    } else {
      this._status = "polling";
    }
    this._schedulePoll();
  }

  close(): void {
    this._closed = true;
    this._status = "disconnected";
    this._clearPollTimer();
    if (this._reconnectTimer !== null) clearTimeout(this._reconnectTimer);
    if (this._pingTimer !== null) clearTimeout(this._pingTimer);
    if (this._retryStreamTimer !== null) clearTimeout(this._retryStreamTimer);
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._retryStreamTimer = null;
    this._teardownStream();
    this._env.document?.removeEventListener("visibilitychange", this._onVisibility);
    this._env.window?.removeEventListener("online", this._onOnline);
    this._env.window?.removeEventListener("offline", this._onOffline);
  }

  // ------------------------------------------------------------------
  // Fetching
  // ------------------------------------------------------------------

  /**
   * Fetch flags and configs (conditionally, via If-None-Match) and
   * ingest the result. Concurrent calls share one in-flight refresh.
   */
  refresh(options: { noCache?: boolean; source?: string } = {}): Promise<void> {
    if (this._refreshInFlight !== null) return this._refreshInFlight;
    const run = this._doRefresh(options).finally(() => {
      this._refreshInFlight = null;
    });
    this._refreshInFlight = run;
    return run;
  }

  private async _doRefresh(options: { noCache?: boolean; source?: string }): Promise<void> {
    if (this._closed) return;
    if (this._env.navigator && this._env.navigator.onLine === false) return;

    const source = options.source ?? "manual";
    const [flags, configs] = await Promise.all([
      this._fetchResource<Record<string, FlagDefinition>>(
        this._opts.flagsUrl,
        this._store.etags.flags,
        options.noCache,
        parseFlagsResponse,
        (etag) => {
          this._store.etags.flags = etag;
        },
      ),
      this._fetchResource<Record<string, ConfigDefinition>>(
        this._opts.configUrl,
        this._store.etags.configs,
        options.noCache,
        parseConfigsResponse,
        (etag) => {
          this._store.etags.configs = etag;
        },
      ),
    ]);
    if (this._closed) return;
    if (flags !== undefined || configs !== undefined) {
      this._store.ingest(flags, configs, source);
    } else if (!this._store.ready && (this._store.etags.flags || this._store.etags.configs)) {
      // Bootstrapped data revalidated as current (double 304): mark ready.
      this._store.markReady();
    }
  }

  private async _fetchResource<T>(
    url: string,
    etag: string | undefined,
    noCache: boolean | undefined,
    parse: (body: unknown) => T,
    saveEtag: (etag: string | undefined) => void,
  ): Promise<T | undefined> {
    const headers: Record<string, string> = {};
    if (etag) headers["If-None-Match"] = etag;
    if (noCache) headers["Cache-Control"] = "no-cache";
    let response: Response;
    try {
      response = await this._env.fetch(this._withKey(url), { headers });
    } catch {
      return undefined; // network failure — keep current data
    }
    if (response.status === 304) return undefined;
    if (!response.ok) return undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    saveEtag(response.headers.get("ETag") ?? undefined);
    return parse(body);
  }

  private _withKey(url: string): string {
    return `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(this._opts.apiKey)}`;
  }

  // ------------------------------------------------------------------
  // Polling
  // ------------------------------------------------------------------

  private _pollInterval(): number {
    if (this._directedPollMs !== null) return this._directedPollMs;
    return this._streamHealthy ? this._opts.pollIntervalMs : this._opts.fallbackPollIntervalMs;
  }

  private _schedulePoll(): void {
    if (this._closed) return;
    this._clearPollTimer();
    if (this._env.document?.visibilityState === "hidden") return;
    if (this._env.navigator && this._env.navigator.onLine === false) return;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      void this.refresh({ source: "manual" }).finally(() => this._schedulePoll());
    }, this._pollInterval());
  }

  private _clearPollTimer(): void {
    if (this._pollTimer !== null) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // Streaming
  // ------------------------------------------------------------------

  private _shouldStream(): boolean {
    return this._opts.streaming && this._env.EventSourceImpl !== undefined;
  }

  private _connectStream(): void {
    if (this._closed || !this._shouldStream()) return;
    if (this._env.navigator && this._env.navigator.onLine === false) return;
    this._status = "connecting";
    const EventSourceImpl = this._env.EventSourceImpl!;
    const stream = new EventSourceImpl(this._withKey(this._opts.eventsUrl));
    this._stream = stream;

    stream.onopen = () => {
      if (this._closed || this._stream !== stream) return;
      const isReconnect = this._everConnected;
      this._everConnected = true;
      this._streamHealthy = true;
      this._backoffAttempt = 0;
      this._directedPollMs = null;
      this._status = "connected";
      this._schedulePoll();
      if (isReconnect) {
        // Changes may have happened while the stream was down — the
        // jittered no-cache refetch catches up past the CDN.
        this._schedulePingRefetch();
      }
    };

    stream.onerror = () => {
      if (this._closed || this._stream !== stream) return;
      // Fully managed reconnection: close the native EventSource (its
      // auto-retry would race our backoff and cannot see 503 bodies)
      // and classify the failure with a probe.
      this._teardownStream();
      this._status = "connecting";
      this._schedulePoll();
      void this._classifyStreamFailure();
    };

    for (const eventName of CHANGE_EVENTS) {
      stream.addEventListener(eventName, () => {
        if (this._closed || this._stream !== stream) return;
        // Never read data off the stream — any known event is only a
        // signal to re-fetch.
        this._schedulePingRefetch();
      });
    }
    // Unknown or malformed events are ignored silently (no handler).
  }

  private _teardownStream(): void {
    if (this._stream !== null) {
      this._stream.onopen = null;
      this._stream.onerror = null;
      this._stream.close();
      this._stream = null;
    }
    this._streamHealthy = false;
  }

  /**
   * EventSource exposes no response status or headers, so a failed
   * stream is classified with one plain fetch: a 503 carries the
   * server's poll directive (`{"poll_interval_seconds": N}` +
   * `Retry-After`); anything else means "retry with backoff".
   */
  private async _classifyStreamFailure(): Promise<void> {
    let response: Response | null = null;
    try {
      response = await this._env.fetch(this._withKey(this._opts.eventsUrl), {
        headers: { Accept: "text/event-stream" },
      });
    } catch {
      response = null; // network-level failure
    }
    if (this._closed) {
      return;
    }
    if (response !== null && response.status === 503) {
      let pollSeconds: number | null = null;
      try {
        const body = (await response.json()) as { poll_interval_seconds?: number };
        if (typeof body.poll_interval_seconds === "number" && body.poll_interval_seconds > 0) {
          pollSeconds = body.poll_interval_seconds;
        }
      } catch {
        pollSeconds = null;
      }
      const retryAfterRaw = response.headers.get("Retry-After");
      const retryAfterSeconds =
        retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw)
          ? Number(retryAfterRaw)
          : DEFAULT_STREAM_RETRY_AFTER_S;
      if (pollSeconds !== null) {
        this._directedPollMs = pollSeconds * 1000;
      }
      this._status = "polling";
      this._schedulePoll();
      this._retryStreamTimer = setTimeout(() => {
        this._retryStreamTimer = null;
        this._directedPollMs = null;
        if (this._stream === null) this._connectStream();
      }, retryAfterSeconds * 1000);
      return;
    }
    // Cancel a successful probe's body — the probe is a classifier, not
    // a second stream.
    if (response !== null) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
    }
    this._scheduleStreamReconnect();
  }

  private _scheduleStreamReconnect(): void {
    if (this._closed || this._reconnectTimer !== null) return;
    const base = Math.min(BASE_BACKOFF_MS * 2 ** this._backoffAttempt, MAX_BACKOFF_MS);
    this._backoffAttempt++;
    // Equal jitter on the server SDK's 1s·2^n (cap 60s) ladder.
    const delay = base / 2 + this._env.random() * (base / 2);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._stream === null) this._connectStream();
    }, delay);
  }

  /** Jittered (0–2s), debounced, cache-busting refetch after a ping. */
  private _schedulePingRefetch(): void {
    if (this._closed || this._pingTimer !== null) return;
    this._pingTimer = setTimeout(() => {
      this._pingTimer = null;
      void this.refresh({ noCache: true, source: "push" });
    }, this._env.random() * PING_JITTER_MS);
  }
}
