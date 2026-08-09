/**
 * Config resolution — mirrors the server TypeScript/Go SDKs: child
 * overrides parent, environment overrides base, deep merge of nested
 * objects, arrays replaced wholesale.
 */
import { describe, expect, it } from "vitest";

import { deepMerge, resolveChain } from "../src/resolve.js";

describe("deepMerge", () => {
  it("override wins for scalars", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("nested objects merge recursively", () => {
    expect(deepMerge({ db: { host: "x", port: 5 } }, { db: { host: "y" } })).toEqual({
      db: { host: "y", port: 5 },
    });
  });

  it("arrays are treated as scalars", () => {
    expect(deepMerge({ tags: ["a", "b"] }, { tags: ["c"] })).toEqual({ tags: ["c"] });
  });

  it("object replaces scalar and vice versa", () => {
    expect(deepMerge({ v: 1 }, { v: { nested: true } })).toEqual({ v: { nested: true } });
    expect(deepMerge({ v: { nested: true } }, { v: 1 })).toEqual({ v: 1 });
  });

  it("null override wins", () => {
    expect(deepMerge({ v: { nested: true } }, { v: null })).toEqual({ v: null });
  });
});

describe("resolveChain", () => {
  const parent = {
    items: { timeout: 5, retries: 3, nested: { a: 1, b: 2 } },
    environments: { production: { timeout: 30 } },
  };
  const child = {
    items: { retries: 7, nested: { b: 9 } },
    environments: { production: { retries: 11 } },
  };

  it("child overrides parent; env overrides base; both compose", () => {
    // chain is child-to-root
    expect(resolveChain([child, parent], "production")).toEqual({
      timeout: 30, // parent env override
      retries: 11, // child env override beats child base beats parent
      nested: { a: 1, b: 9 }, // deep-merged across the chain
    });
  });

  it("environment without overrides resolves base values", () => {
    expect(resolveChain([child, parent], "staging")).toEqual({
      timeout: 5,
      retries: 7,
      nested: { a: 1, b: 9 },
    });
  });

  it("null environment resolves base values only", () => {
    expect(resolveChain([parent], null)).toEqual({
      timeout: 5,
      retries: 3,
      nested: { a: 1, b: 2 },
    });
  });

  it("empty chain resolves to an empty object", () => {
    expect(resolveChain([], "production")).toEqual({});
  });

  it("non-object environment entries are ignored", () => {
    const weird = {
      items: { a: 1 },
      environments: { production: "not-an-object" },
    };
    expect(resolveChain([weird], "production")).toEqual({ a: 1 });
  });

  it("missing items resolves from environments alone", () => {
    const envOnly = {
      items: undefined as unknown as Record<string, unknown>,
      environments: { production: { only: true } },
    };
    expect(resolveChain([envOnly], "production")).toEqual({ only: true });
  });
});
