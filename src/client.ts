/**
 * `SmplClient` — the entry point for `@smplkit/browser`.
 *
 * A browser-first, read-only client for Smpl Flags and Smpl Config,
 * authenticated with a publishable `sk_public_` key. The environment is
 * baked into the key — there is no environment option anywhere.
 *
 * Runtime method names mirror the server `@smplkit/sdk`:
 * `flags.booleanFlag/stringFlag/numberFlag/jsonFlag(...).get()`,
 * `config.subscribe/getValue`, `setContext`, `waitUntilReady`, `close`.
 */

import {
  loadPersisted,
  parseBootstrapPayload,
  persist,
  type BootstrapOption,
} from "./bootstrap.js";
import { ConfigNamespace } from "./config.js";
import { Context, contextsToEvalDict } from "./context.js";
import { SmplError, SmplTimeoutError } from "./errors.js";
import { FlagsNamespace } from "./flags.js";
import { Store } from "./store.js";
import {
  Transport,
  defaultTransportEnv,
  type ConnectionStatus,
  type TransportEnv,
} from "./transport.js";

const PUBLIC_KEY_PREFIX = "sk_public_";

/** Configuration options for {@link SmplClient}. */
export interface SmplClientOptions {
  /**
   * The publishable API key (`sk_public_...`). Anything else — in
   * particular a private `sk_api_` key — is rejected at construction:
   * everything this client touches ships to the end user's browser, and
   * a private key there is a credential leak, not a configuration.
   */
  apiKey: string;

  /**
   * Live updates over Server-Sent Events (the default). Disable for
   * environments where long-lived connections don't survive (some
   * corporate proxies); polling then runs at `fallbackPollIntervalMs`.
   * @default true
   */
  streaming?: boolean;

  /**
   * Safety-net poll interval while streaming is healthy — catches
   * dropped events and reconnect gaps.
   * @default 900_000 (15 minutes)
   */
  pollIntervalMs?: number;

  /**
   * Poll interval while the stream is down (or streaming is disabled).
   * @default 60_000
   */
  fallbackPollIntervalMs?: number;

  /**
   * Startup data source: `"localStorage"` (default) evaluates from the
   * last-known payload immediately and revalidates in the background;
   * `"none"` starts empty; an object is a server-rendered payload
   * (`{flags, configs}` — the raw JSON bodies of the two public list
   * endpoints) so SSR hydrates without a flash of default values.
   * @default "localStorage"
   */
  bootstrap?: BootstrapOption;

  /**
   * Base domain for service URLs (flags/config/app subdomains), for
   * local development or self-hosting.
   * @default "smplkit.com"
   */
  baseDomain?: string;

  /**
   * URL scheme for service URLs.
   * @default "https"
   */
  scheme?: string;

  /** @internal Injectable host environment (tests). */
  _env?: TransportEnv;
}

export class SmplClient {
  /** Flags runtime — typed handles, `refresh`, `onChange`. */
  readonly flags: FlagsNamespace;

  /** Config runtime — `subscribe`, `getValue`, `refresh`, `onChange`. */
  readonly config: ConfigNamespace;

  /** @internal */
  readonly _store: Store;

  private readonly _transport: Transport;
  private readonly _apiKey: string;
  private _contexts: Context[] = [];
  private _closed = false;

  constructor(options: SmplClientOptions) {
    const apiKey = options.apiKey;
    if (typeof apiKey !== "string" || !apiKey.startsWith(PUBLIC_KEY_PREFIX)) {
      throw new SmplError(
        "@smplkit/browser requires a publishable key (sk_public_...). " +
          "Anything passed here ships to every visitor's browser, so a " +
          "private key (sk_api_...) must never be used — create a public " +
          "key in the smplkit console (API Keys → Create Public Key) and " +
          "keep private keys on your server.",
      );
    }
    this._apiKey = apiKey;

    const scheme = options.scheme ?? "https";
    const baseDomain = options.baseDomain ?? "smplkit.com";
    const env = options._env ?? defaultTransportEnv();

    this._store = new Store();

    // Bootstrap before any network: evaluate immediately from the best
    // available data.
    const bootstrap = options.bootstrap ?? "localStorage";
    if (bootstrap === "localStorage") {
      const persisted = loadPersisted(apiKey);
      if (persisted !== null) {
        this._store.etags = persisted.etags ?? {};
        this._store.ingest(persisted.flags, persisted.configs, "initial");
      }
    } else if (bootstrap !== "none") {
      const parsed = parseBootstrapPayload(bootstrap);
      if (parsed.flags !== undefined || parsed.configs !== undefined) {
        this._store.ingest(parsed.flags, parsed.configs, "initial");
      }
    }

    if (bootstrap === "localStorage") {
      // Persist every store change so the next visit boots warm.
      this._store.subscribe(() => {
        persist(this._apiKey, this._store.flags, this._store.configs, this._store.etags);
      });
    }

    this._transport = new Transport(
      {
        apiKey,
        flagsUrl: `${scheme}://flags.${baseDomain}/api/v1/flags`,
        configUrl: `${scheme}://config.${baseDomain}/api/v1/configs`,
        eventsUrl: `${scheme}://app.${baseDomain}/api/v1/events`,
        streaming: options.streaming ?? true,
        pollIntervalMs: options.pollIntervalMs ?? 900_000,
        fallbackPollIntervalMs: options.fallbackPollIntervalMs ?? 60_000,
        env,
      },
      this._store,
    );

    const host = {
      _store: this._store,
      _evalDict: (context: Context[] | null) => contextsToEvalDict(context ?? this._contexts),
      refresh: () => this.refresh(),
      waitUntilReady: (opts?: { timeoutMs?: number }) => this.waitUntilReady(opts),
    };
    this.flags = new FlagsNamespace(host);
    this.config = new ConfigNamespace(host);

    this._transport.start();
  }

  // ------------------------------------------------------------------
  // Context
  // ------------------------------------------------------------------

  /**
   * Set the evaluation context for this client — typically once the
   * user is known. Every subsequent `flag.get()` evaluates against it.
   * Unlike the server SDK there is no per-request scoping: a browser
   * serves one user, so the context is sticky until replaced.
   */
  setContext(contexts: Context[]): void {
    this._contexts = [...contexts];
    // Context changes change evaluation results: bump + notify so React
    // subscribers re-read.
    this._store.ingestContextChange();
  }

  /** The currently-set evaluation contexts. */
  getContext(): Context[] {
    return [...this._contexts];
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** True once definitions have loaded from any source (bootstrap counts). */
  get ready(): boolean {
    return this._store.ready;
  }

  /** Transport state: `connected` (streaming), `connecting`, `polling`,
   * or `disconnected` (closed). */
  get connectionStatus(): ConnectionStatus {
    return this._transport.connectionStatus;
  }

  /**
   * Resolve once definitions are available. With warm bootstrap data
   * this resolves immediately; otherwise it waits for the first fetch.
   *
   * @throws SmplTimeoutError when the deadline elapses.
   */
  waitUntilReady(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this._store.ready) return Promise.resolve();
    const timeoutMs = options.timeoutMs ?? 10_000;
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this._store.subscribe(() => {
        if (this._store.ready) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new SmplTimeoutError(`Definitions did not load within ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /** Re-fetch flags and configs now (conditional requests throughout). */
  refresh(): Promise<void> {
    return this._transport.refresh();
  }

  /**
   * Subscribe to every observable change (definitions, context, ready).
   * Returns an unsubscribe function. This pairs with {@link getVersion}
   * as a `useSyncExternalStore`-compatible subscribe/snapshot pair.
   */
  subscribe(listener: () => void): () => void {
    return this._store.subscribe(listener);
  }

  /** Monotonic snapshot version, bumped on every observable change. */
  getVersion(): number {
    return this._store.version;
  }

  /** Release the stream, timers, and listeners held by this client. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._transport.close();
  }
}
