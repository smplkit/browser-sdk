/**
 * The flags runtime surface — typed handles whose `.get()` evaluates
 * against the local store. Method names mirror the server TypeScript
 * SDK (`booleanFlag` / `stringFlag` / `numberFlag` / `jsonFlag`,
 * `refresh`, `onChange`); handle creation is synchronous here because
 * the browser SDK evaluates from its bootstrap/cache immediately —
 * `await`-ing the factory still works and matches server-SDK code.
 */

import type { Context } from "./context.js";
import type { Store, FlagChangeListener } from "./store.js";

/** @internal What a handle needs from the client. */
export interface FlagsHost {
  readonly _store: Store;
  _evalDict(context: Context[] | null): Record<string, unknown>;
  refresh(): Promise<void>;
}

/** Base flag handle. `get()` evaluates synchronously against the cache. */
export class Flag {
  /** The flag key. */
  readonly id: string;
  /** Fallback when no definition, environment override, or rule applies. */
  readonly default: unknown;

  private readonly _host: FlagsHost;

  /** @internal */
  constructor(host: FlagsHost, id: string, defaultValue: unknown) {
    this._host = host;
    this.id = id;
    this.default = defaultValue;
  }

  /**
   * Evaluate this flag and return its current value.
   *
   * @param options.context - Optional list of {@link Context} entities to
   *   evaluate targeting rules against. When omitted, the client's
   *   current context (from `setContext`) is used.
   */
  get(options?: { context?: Context[] }): unknown {
    const evalDict = this._host._evalDict(options?.context ?? null);
    return this._host._store.evaluate(this.id, this.default, evalDict);
  }
}

/** A boolean flag — `.get()` returns boolean. */
export class BooleanFlag extends Flag {
  override get(options?: { context?: Context[] }): boolean {
    const value = super.get(options);
    return typeof value === "boolean" ? value : (this.default as boolean);
  }
}

/** A string flag — `.get()` returns string. */
export class StringFlag extends Flag {
  override get(options?: { context?: Context[] }): string {
    const value = super.get(options);
    return typeof value === "string" ? value : (this.default as string);
  }
}

/** A numeric flag — `.get()` returns number. */
export class NumberFlag extends Flag {
  override get(options?: { context?: Context[] }): number {
    const value = super.get(options);
    return typeof value === "number" && !Number.isNaN(value) ? value : (this.default as number);
  }
}

/** A JSON flag — `.get()` returns object. */
export class JsonFlag extends Flag {
  override get(options?: { context?: Context[] }): Record<string, unknown> {
    const value = super.get(options);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return this.default as Record<string, unknown>;
  }
}

/** The `client.flags` namespace. */
export class FlagsNamespace {
  private readonly _host: FlagsHost;

  /** @internal */
  constructor(host: FlagsHost) {
    this._host = host;
  }

  /** A typed handle for a boolean flag. */
  booleanFlag(id: string, defaultValue: boolean): BooleanFlag {
    return new BooleanFlag(this._host, id, defaultValue);
  }

  /** A typed handle for a string flag. */
  stringFlag(id: string, defaultValue: string): StringFlag {
    return new StringFlag(this._host, id, defaultValue);
  }

  /** A typed handle for a numeric flag. */
  numberFlag(id: string, defaultValue: number): NumberFlag {
    return new NumberFlag(this._host, id, defaultValue);
  }

  /** A typed handle for a JSON flag. */
  jsonFlag(id: string, defaultValue: Record<string, unknown>): JsonFlag {
    return new JsonFlag(this._host, id, defaultValue);
  }

  /** Re-fetch all definitions now. */
  refresh(): Promise<void> {
    return this._host.refresh();
  }

  /**
   * Listen for flag definition changes — `onChange(cb)` for every flag,
   * `onChange(id, cb)` for one flag.
   */
  onChange(callbackOrId: FlagChangeListener | string, callback?: FlagChangeListener): void {
    this._host._store.onFlagChange(callbackOrId, callback);
  }
}
