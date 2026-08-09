/**
 * The config runtime surface — mirrors the server TypeScript SDK's
 * runtime method names (`subscribe`, `getValue`, `refresh`, `onChange`).
 * Values are resolved locally: the public read returns the whole
 * account's configs with `parent` links, and the inheritance chain plus
 * environment overrides are applied in the browser (see resolve.ts).
 */

import { SmplNotFoundError } from "./errors.js";
import type { ConfigChangeListener, Store } from "./store.js";

/** @internal What the namespace needs from the client. */
export interface ConfigHost {
  readonly _store: Store;
  refresh(): Promise<void>;
  waitUntilReady(options?: { timeoutMs?: number }): Promise<void>;
}

/** Sentinel distinguishing `getValue(id, key)` from `getValue(id, key, default)`. */
const MISSING = Symbol("missing");

/**
 * A live, dict-like, read-only view of a config's resolved values.
 * Always reflects the latest pushed state — every read sees current
 * values. Mirrors the server SDK's `LiveConfigProxy`.
 */
export class LiveConfigProxy {
  /** @internal */
  private readonly _store!: Store;
  /** @internal */
  private readonly _key!: string;

  // Index signature so `proxy["anything"]` type-checks.
  [item: string]: unknown;

  /** @internal */
  constructor(store: Store, key: string) {
    Object.defineProperty(this, "_store", { value: store, enumerable: false });
    Object.defineProperty(this, "_key", { value: key, enumerable: false });

    const ownMethods = new Set(["keys", "values", "items", "get", "onChange", "_currentValues"]);

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol" || prop === "constructor" || prop === "toJSON") {
          return Reflect.get(target, prop, receiver);
        }
        if (ownMethods.has(prop as string) || (prop as string).startsWith("_")) {
          return Reflect.get(target, prop, receiver);
        }
        return target._currentValues()[prop as string];
      },
      has(target, prop) {
        if (typeof prop === "symbol") return Reflect.has(target, prop);
        return prop in target._currentValues();
      },
      ownKeys(target) {
        return Object.keys(target._currentValues());
      },
      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === "symbol") return Reflect.getOwnPropertyDescriptor(target, prop);
        const values = target._currentValues();
        if (prop in values) {
          return { value: values[prop as string], enumerable: true, configurable: true };
        }
        return undefined;
      },
      set() {
        throw new TypeError("LiveConfigProxy is read-only");
      },
      deleteProperty() {
        throw new TypeError("LiveConfigProxy is read-only");
      },
    });
  }

  /** @internal */
  _currentValues(): Record<string, unknown> {
    return this._store.resolvedConfig(this._key) ?? {};
  }

  /** The resolved item keys. */
  keys(): string[] {
    return Object.keys(this._currentValues());
  }

  /** The resolved values. */
  values(): unknown[] {
    return Object.values(this._currentValues());
  }

  /** `[key, value]` pairs of the resolved values. */
  items(): Array<[string, unknown]> {
    return Object.entries(this._currentValues());
  }

  /** A single resolved value, with an optional default. */
  get(key: string, defaultValue?: unknown): unknown {
    const values = this._currentValues();
    return key in values ? values[key] : defaultValue;
  }

  /** Listen for changes — `onChange(cb)` or `onChange(itemKey, cb)`. */
  onChange(
    callbackOrItemKey: ConfigChangeListener | string,
    callback?: ConfigChangeListener,
  ): void {
    if (typeof callbackOrItemKey === "function") {
      this._store.onConfigChange(this._key, null, callbackOrItemKey);
      return;
    }
    if (!callback) {
      throw new TypeError("onChange(itemKey, callback) requires a callback function.");
    }
    this._store.onConfigChange(this._key, callbackOrItemKey, callback);
  }
}

/** The `client.config` namespace. */
export class ConfigNamespace {
  private readonly _host: ConfigHost;

  /** @internal */
  constructor(host: ConfigHost) {
    this._host = host;
  }

  /**
   * A live view of a config's resolved values. Waits for the first load,
   * then throws {@link SmplNotFoundError} when the config does not exist.
   */
  async subscribe(id: string): Promise<LiveConfigProxy> {
    await this._host.waitUntilReady();
    if (this._host._store.resolvedConfig(id) === undefined) {
      throw new SmplNotFoundError(`Config not found: ${id}`);
    }
    return new LiveConfigProxy(this._host._store, id);
  }

  /** A single resolved value. Without a default, throws on a missing
   * config or item; with one, returns the default instead. */
  async getValue(id: string, key: string): Promise<unknown>;
  async getValue<V>(id: string, key: string, defaultValue: V): Promise<V | unknown>;
  async getValue(id: string, key: string, defaultValue: unknown = MISSING): Promise<unknown> {
    await this._host.waitUntilReady();
    const values = this._host._store.resolvedConfig(id);
    if (values === undefined || !(key in values)) {
      if (defaultValue === MISSING) {
        throw new SmplNotFoundError(`Config value not found: ${id}.${key}`);
      }
      return defaultValue;
    }
    return values[key];
  }

  /** Re-fetch all definitions now. */
  refresh(): Promise<void> {
    return this._host.refresh();
  }

  /**
   * Listen for resolved-value changes — `onChange(cb)` for everything,
   * `onChange(configId, cb)` for one config, `onChange(configId,
   * itemKey, cb)` for one item.
   */
  onChange(cb: ConfigChangeListener): void;
  onChange(configId: string, cb: ConfigChangeListener): void;
  onChange(configId: string, itemKey: string, cb: ConfigChangeListener): void;
  onChange(
    a: ConfigChangeListener | string,
    b?: ConfigChangeListener | string,
    c?: ConfigChangeListener,
  ): void {
    if (typeof a === "function") {
      this._host._store.onConfigChange(null, null, a);
      return;
    }
    if (typeof b === "function") {
      this._host._store.onConfigChange(a, null, b);
      return;
    }
    if (typeof b === "string" && typeof c === "function") {
      this._host._store.onConfigChange(a, b, c);
      return;
    }
    throw new TypeError("onChange requires a callback function.");
  }
}
