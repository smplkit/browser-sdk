/**
 * Evaluation contexts — the browser-side mirror of the server SDK's
 * `Context` class, reduced to what flag evaluation needs. The server
 * SDK also registers context instances with the platform; a browser
 * holds a read-only public key, so no registration happens here.
 */

export class Context {
  readonly type: string;
  readonly key: string;
  readonly attributes: Record<string, unknown>;

  constructor(type: string, key: string, attributes: Record<string, unknown> = {}) {
    if (typeof type !== "string" || type === "") {
      throw new TypeError("Context type must be a non-empty string");
    }
    if (typeof key !== "string" || key === "") {
      throw new TypeError("Context key must be a non-empty string");
    }
    this.type = type;
    this.key = key;
    this.attributes = attributes;
  }

  /** Stable identity, `"type:key"` — mirrors the server SDK. */
  get id(): string {
    return `${this.type}:${this.key}`;
  }
}

/**
 * Convert a list of Contexts to the nested evaluation dict:
 * `{ [type]: { key, ...attributes } }` — identical to the server SDKs,
 * so `{"var": "user.plan"}` addresses the same value everywhere.
 * @internal
 */
export function contextsToEvalDict(contexts: Context[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const ctx of contexts) {
    result[ctx.type] = { key: ctx.key, ...ctx.attributes };
  }
  return result;
}

/**
 * Deterministic JSON with key-sorted objects, for context hashing.
 * Identical to the server TypeScript SDK's `sortedStringify`.
 * @internal
 */
function sortedStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(sortedStringify).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + sortedStringify((obj as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Stable hash of a context evaluation dict — the resolution-cache key
 * component. Identical to the server TypeScript SDK's `hashContext`.
 * @internal
 */
export function hashContext(evalDict: Record<string, unknown>): string {
  const serialized = sortedStringify(evalDict);
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    const chr = serialized.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash.toString(36);
}
