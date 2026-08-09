/** Direct unit coverage for the vendored evaluator's core mechanics. */
import { describe, expect, it } from "vitest";

import { apply, is_logic, truthy } from "../src/vendor/json-logic.js";

describe("is_logic", () => {
  it("accepts single-key objects only", () => {
    expect(is_logic({ "==": [1, 1] })).toBe(true);
    expect(is_logic({})).toBe(false);
    expect(is_logic({ a: 1, b: 2 })).toBe(false);
    expect(is_logic(null)).toBe(false);
    expect(is_logic([1])).toBe(false);
    expect(is_logic("x")).toBe(false);
  });
});

describe("truthy (jsonlogic.com/truthy)", () => {
  it("empty array is falsy; non-empty is truthy", () => {
    expect(truthy([])).toBe(false);
    expect(truthy([0])).toBe(true);
  });
  it("standard JS coercions otherwise", () => {
    expect(truthy(0)).toBe(false);
    expect(truthy("")).toBe(false);
    expect(truthy("a")).toBe(true);
    expect(truthy(null)).toBe(false);
  });
});

describe("apply", () => {
  it("passes primitives through", () => {
    expect(apply(17)).toBe(17);
    expect(apply("apple")).toBe("apple");
    expect(apply(null)).toBe(null);
  });

  it("maps arrays of logic", () => {
    expect(apply([{ var: "a" }, { var: "b" }], { a: 1, b: 2 })).toEqual([1, 2]);
  });

  it("var descends dotted paths and honors the not-found default", () => {
    const data = { user: { plan: "pro" } };
    expect(apply({ var: "user.plan" }, data)).toBe("pro");
    expect(apply({ var: "user.missing" }, data)).toBe(null);
    expect(apply({ var: ["user.missing", "fallback"] }, data)).toBe("fallback");
    expect(apply({ var: "user.plan.deep" }, data)).toBe(null);
  });

  it("var with empty/null path returns the whole data object", () => {
    const data = { a: 1 };
    expect(apply({ var: "" }, data)).toBe(data);
    expect(apply({ var: null }, data)).toBe(data);
  });

  it("var walks through null links to the default", () => {
    expect(apply({ var: "a.b" }, { a: null })).toBe(null);
    expect(apply({ var: ["a.b", "dflt"] }, { a: null })).toBe("dflt");
  });

  it("between variants of < and <=", () => {
    expect(apply({ "<": [1, 2, 3] })).toBe(true);
    expect(apply({ "<": [1, 4, 3] })).toBe(false);
    expect(apply({ "<=": [1, 1, 3] })).toBe(true);
  });

  it("and returns first falsy or last; or returns first truthy or last", () => {
    expect(apply({ and: [true, "yes"] })).toBe("yes");
    expect(apply({ and: [0, "yes"] })).toBe(0);
    expect(apply({ or: [0, "", "yes"] })).toBe("yes");
    expect(apply({ or: [0, ""] })).toBe("");
  });

  it("and/or evaluate lazily", () => {
    // The second operand would throw if evaluated.
    expect(apply({ or: [true, { unknown_op: [] }] })).toBe(true);
    expect(apply({ and: [false, { unknown_op: [] }] })).toBe(false);
  });

  it("unary sugar: non-array values wrap", () => {
    expect(apply({ var: "a" }, { a: 3 })).toBe(3);
  });

  it("in handles arrays and substrings, and non-indexables are false", () => {
    expect(apply({ in: ["a", ["a", "b"]] })).toBe(true);
    expect(apply({ in: ["Spring", "Springfield"] })).toBe(true);
    expect(apply({ in: ["x", null] })).toBe(false);
    expect(apply({ in: ["x", 42] })).toBe(false);
  });

  it("throws on unrecognized operations", () => {
    expect(() => apply({ substr: ["abc", 1] })).toThrow(/Unrecognized operation substr/);
    expect(() => apply({ "!": [true] })).toThrow(/Unrecognized operation !/);
    expect(() => apply({ if: [true, 1, 2] })).toThrow(/Unrecognized operation if/);
  });
});
