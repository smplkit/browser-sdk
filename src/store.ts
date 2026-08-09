/**
 * The client's local data store: flag and config definitions, the
 * evaluation/resolution caches over them, and change notification.
 *
 * Everything a browser evaluates comes out of this store; the transport
 * layer writes into it and the store diffs, invalidates caches, bumps
 * its version, and notifies subscribers (including React's
 * `useSyncExternalStore`).
 */

import { evaluateFlag, type FlagDefinition } from "./evaluate.js";
import { resolveChain, type ChainConfig } from "./resolve.js";
import { hashContext } from "./context.js";

/** A config definition as held in the local store. */
export interface ConfigDefinition {
  name?: string;
  parent: string | null;
  /** Unwrapped base values: `{ itemKey: value }`. */
  items: Record<string, unknown>;
  /** Per-environment overrides: `{ envKey: { itemKey: value } }`. */
  environments: Record<string, unknown>;
}

/** Describes a flag definition change. */
export interface FlagChangeEvent {
  /** The flag id that changed. */
  readonly id: string;
  /** How the change was delivered (`"push"` or `"manual"`). */
  readonly source: string;
  /** True when the flag was deleted. */
  readonly deleted: boolean;
}

/** Describes a resolved config item change. */
export interface ConfigChangeEvent {
  readonly configId: string;
  readonly itemKey: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  /** How the change was delivered (`"push"`, `"manual"`, or `"initial"`). */
  readonly source: string;
}

export type FlagChangeListener = (event: FlagChangeEvent) => void;
export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

const EVAL_CACHE_MAX = 10_000;

/** @internal */
export class Store {
  flags: Record<string, FlagDefinition> = {};
  configs: Record<string, ConfigDefinition> = {};
  etags: { flags?: string; configs?: string } = {};

  /** Monotonic snapshot version — bumped on every observable change. */
  version = 0;
  /** True once data has been loaded from any source (bootstrap counts). */
  ready = false;

  private _subscribers = new Set<() => void>();
  private _flagListeners = new Map<string, FlagChangeListener[]>();
  private _globalFlagListeners: FlagChangeListener[] = [];
  private _configListeners: Array<{
    configId: string | null;
    itemKey: string | null;
    cb: ConfigChangeListener;
  }> = [];

  private _evalCache = new Map<string, unknown>();
  private _resolvedConfigs: Map<string, Record<string, unknown>> | null = null;
  private _environment: string | null | undefined;

  // ------------------------------------------------------------------
  // Subscription (React / useSyncExternalStore)
  // ------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this._subscribers.add(listener);
    return () => {
      this._subscribers.delete(listener);
    };
  }

  private _notify(): void {
    this.version++;
    for (const listener of [...this._subscribers]) {
      try {
        listener();
      } catch {
        // subscriber errors never propagate
      }
    }
  }

  // ------------------------------------------------------------------
  // Environment derivation
  // ------------------------------------------------------------------

  /**
   * The environment baked into the public key, derived from the data:
   * the scrub-on-read guarantees every `environments` map carries at
   * most the key's single environment, so the first environment key
   * found anywhere is the one. Null when no environment-specific data
   * exists (evaluation then falls back to flag/base defaults, which is
   * correct).
   */
  get environment(): string | null {
    if (this._environment !== undefined) return this._environment;
    for (const flag of Object.values(this.flags)) {
      for (const envKey of Object.keys(flag.environments ?? {})) {
        this._environment = envKey;
        return envKey;
      }
    }
    for (const config of Object.values(this.configs)) {
      for (const envKey of Object.keys(config.environments ?? {})) {
        this._environment = envKey;
        return envKey;
      }
    }
    this._environment = null;
    return null;
  }

  // ------------------------------------------------------------------
  // Data ingestion
  // ------------------------------------------------------------------

  /**
   * Replace the stored definitions with freshly-fetched ones, diff, and
   * fire listeners. Either argument may be undefined (e.g. a 304 on one
   * endpoint) to leave that half untouched.
   */
  ingest(
    flags: Record<string, FlagDefinition> | undefined,
    configs: Record<string, ConfigDefinition> | undefined,
    source: string,
  ): void {
    let changed = false;
    const flagEvents: FlagChangeEvent[] = [];
    const configEvents: ConfigChangeEvent[] = [];

    if (flags !== undefined) {
      const before = this.flags;
      const beforeJson = new Map(Object.entries(before).map(([k, v]) => [k, JSON.stringify(v)]));
      for (const [key, def] of Object.entries(flags)) {
        if (beforeJson.get(key) !== JSON.stringify(def)) {
          flagEvents.push({ id: key, source, deleted: false });
        }
      }
      for (const key of Object.keys(before)) {
        if (!(key in flags)) {
          flagEvents.push({ id: key, source, deleted: true });
        }
      }
      if (flagEvents.length > 0 || Object.keys(flags).length !== Object.keys(before).length) {
        changed = true;
      }
      this.flags = flags;
    }

    if (configs !== undefined) {
      const oldResolved = this._resolvedConfigs ?? this._resolveAll(this.configs);
      this.configs = configs;
      this._environment = undefined;
      const newResolved = this._resolveAll(configs);
      this._resolvedConfigs = newResolved;
      const initial = !this.ready;
      for (const [configId, values] of newResolved) {
        const old = oldResolved.get(configId) ?? {};
        for (const itemKey of new Set([...Object.keys(values), ...Object.keys(old)])) {
          const oldValue = initial ? undefined : old[itemKey];
          const newValue = values[itemKey];
          if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
            configEvents.push({
              configId,
              itemKey,
              oldValue,
              newValue,
              source: initial ? "initial" : source,
            });
          }
        }
      }
      for (const [configId, old] of oldResolved) {
        if (!newResolved.has(configId)) {
          for (const itemKey of Object.keys(old)) {
            configEvents.push({
              configId,
              itemKey,
              oldValue: old[itemKey],
              newValue: undefined,
              source,
            });
          }
        }
      }
      if (configEvents.length > 0) changed = true;
    }

    const becameReady = !this.ready && (flags !== undefined || configs !== undefined);
    if (becameReady) this.ready = true;

    if (changed || becameReady) {
      this._environment = undefined;
      this._evalCache.clear();
      if (configs === undefined) this._resolvedConfigs = null;
      this._notify();
    }

    for (const event of flagEvents) this._fireFlagListeners(event);
    // "initial" resolution events mirror the server SDK's first-load
    // behavior: listeners registered before ready hear the first values.
    for (const event of configEvents) this._fireConfigListeners(event);
  }

  /**
   * The evaluation context changed: results may differ, definitions did
   * not. Invalidate evaluations and notify subscribers.
   */
  ingestContextChange(): void {
    this._evalCache.clear();
    this._notify();
  }

  /**
   * Mark bootstrapped data as current without new payloads — the
   * double-304 revalidation path.
   */
  markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this._notify();
  }

  // ------------------------------------------------------------------
  // Flag evaluation (cached)
  // ------------------------------------------------------------------

  evaluate(flagId: string, defaultValue: unknown, evalDict: Record<string, unknown>): unknown {
    const cacheKey = `${flagId}:${hashContext(evalDict)}`;
    if (this._evalCache.has(cacheKey)) {
      // LRU touch
      const cached = this._evalCache.get(cacheKey);
      this._evalCache.delete(cacheKey);
      this._evalCache.set(cacheKey, cached);
      return cached;
    }

    const flagDef = this.flags[flagId];
    let value: unknown;
    if (flagDef === undefined) {
      value = defaultValue;
    } else {
      value = evaluateFlag(flagDef, this.environment, evalDict);
      if (value === null || value === undefined) {
        value = defaultValue;
      }
    }

    if (this._evalCache.size >= EVAL_CACHE_MAX) {
      const oldest = this._evalCache.keys().next().value as string;
      this._evalCache.delete(oldest);
    }
    this._evalCache.set(cacheKey, value);
    return value;
  }

  // ------------------------------------------------------------------
  // Config resolution (cached)
  // ------------------------------------------------------------------

  resolvedConfig(configId: string): Record<string, unknown> | undefined {
    if (this._resolvedConfigs === null) {
      this._resolvedConfigs = this._resolveAll(this.configs);
    }
    return this._resolvedConfigs.get(configId);
  }

  private _resolveAll(
    configs: Record<string, ConfigDefinition>,
  ): Map<string, Record<string, unknown>> {
    const resolved = new Map<string, Record<string, unknown>>();
    for (const configId of Object.keys(configs)) {
      resolved.set(configId, resolveChain(this._buildChain(configId, configs), this.environment));
    }
    return resolved;
  }

  /** Walk `parent` links child-to-root; cycles and missing parents stop the walk. */
  private _buildChain(configId: string, configs: Record<string, ConfigDefinition>): ChainConfig[] {
    const chain: ChainConfig[] = [];
    const seen = new Set<string>();
    let current: string | null = configId;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const def: ConfigDefinition | undefined = configs[current];
      if (def === undefined) break;
      chain.push({ items: def.items ?? {}, environments: def.environments ?? {} });
      current = def.parent;
    }
    return chain;
  }

  // ------------------------------------------------------------------
  // Change listeners (flags.onChange / config.onChange)
  // ------------------------------------------------------------------

  onFlagChange(callbackOrId: FlagChangeListener | string, callback?: FlagChangeListener): void {
    if (typeof callbackOrId === "function") {
      this._globalFlagListeners.push(callbackOrId);
      return;
    }
    if (!callback) {
      throw new TypeError("onChange(id, callback) requires a callback function.");
    }
    const listeners = this._flagListeners.get(callbackOrId) ?? [];
    listeners.push(callback);
    this._flagListeners.set(callbackOrId, listeners);
  }

  onConfigChange(configId: string | null, itemKey: string | null, cb: ConfigChangeListener): void {
    this._configListeners.push({ configId, itemKey, cb });
  }

  private _fireFlagListeners(event: FlagChangeEvent): void {
    for (const cb of [...(this._flagListeners.get(event.id) ?? []), ...this._globalFlagListeners]) {
      try {
        cb(event);
      } catch {
        // listener errors never propagate
      }
    }
  }

  private _fireConfigListeners(event: ConfigChangeEvent): void {
    for (const entry of [...this._configListeners]) {
      if (entry.configId !== null && entry.configId !== event.configId) continue;
      if (entry.itemKey !== null && entry.itemKey !== event.itemKey) continue;
      try {
        entry.cb(event);
      } catch {
        // listener errors never propagate
      }
    }
  }
}
