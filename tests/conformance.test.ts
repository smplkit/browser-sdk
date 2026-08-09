/**
 * Conformance: the vendored, gutted evaluator must agree with upstream
 * json-logic-js (the library every server SDK evaluates with) on every
 * fixture case that uses only the supported operators — the official
 * jsonlogic.com/tests.json suite (vendored) filtered to that operator
 * set, plus hand-written cases for smplkit's `contains` semantics
 * (json-logic `in` with reversed operands, per ADR-033). Any
 * disagreement fails the build.
 */
import { describe, expect, it } from "vitest";
import upstream from "json-logic-js";

import { apply } from "../src/vendor/json-logic.js";
import fixture from "./fixtures/jsonlogic-tests.json";

const SUPPORTED = new Set(["==", "!=", ">", ">=", "<", "<=", "in", "and", "or", "var"]);

function operatorsUsed(logic: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(logic)) {
    for (const entry of logic) operatorsUsed(entry, found);
    return found;
  }
  if (typeof logic === "object" && logic !== null) {
    const keys = Object.keys(logic);
    if (keys.length === 1) {
      found.add(keys[0]);
    }
    for (const value of Object.values(logic)) operatorsUsed(value, found);
  }
  return found;
}

type FixtureCase = [unknown, unknown, unknown];

const cases: FixtureCase[] = [];
let currentSection = "";
const sectionOf: string[] = [];
for (const entry of fixture as Array<string | FixtureCase>) {
  if (typeof entry === "string") {
    currentSection = entry;
    continue;
  }
  cases.push(entry);
  sectionOf.push(currentSection);
}

const supportedCases: Array<{ section: string; logic: unknown; data: unknown; expected: unknown }> =
  [];
let filteredOut = 0;
cases.forEach((entry, index) => {
  const [logic, data, expected] = entry;
  const used = operatorsUsed(logic, new Set());
  const unsupported = [...used].filter((op) => !SUPPORTED.has(op));
  if (unsupported.length > 0) {
    filteredOut++;
    return;
  }
  supportedCases.push({ section: sectionOf[index], logic, data, expected });
});

describe("official json-logic fixture (filtered to supported operators)", () => {
  it("keeps a meaningful share of the suite", () => {
    // The gutted operator set covers a substantial slice of the official
    // suite; if this collapses, the filter (or the fixture) broke.
    expect(supportedCases.length).toBeGreaterThan(80);
    expect(supportedCases.length + filteredOut).toBe(cases.length);
  });

  it.each(supportedCases.map((c, i) => [i, c] as const))(
    "case %i agrees with upstream: %j",
    (_index, testCase) => {
      const vendored = apply(testCase.logic, testCase.data);
      const reference = upstream.apply(testCase.logic as never, testCase.data);
      expect(vendored).toEqual(reference);
      expect(vendored).toEqual(testCase.expected);
    },
  );
});

describe("smplkit contains semantics (in with reversed operands, ADR-033)", () => {
  // The rule builders compile `contains` to `{"in": [value, {"var": x}]}`
  // at build time, so these are the frames the browser actually sees.
  // The upstream suite does not cover the alias — these cases are ours.
  const containsCases: Array<[unknown, unknown, unknown]> = [
    // value contained in an array-valued attribute
    [{ in: ["beta", { var: "user.groups" }] }, { user: { groups: ["beta", "alpha"] } }, true],
    [{ in: ["gamma", { var: "user.groups" }] }, { user: { groups: ["beta", "alpha"] } }, false],
    // substring containment in a string-valued attribute
    [{ in: ["corp", { var: "user.email" }] }, { user: { email: "a@corp.example" } }, true],
    [{ in: ["corp", { var: "user.email" }] }, { user: { email: "a@home.example" } }, false],
    // loose coercion parity: number needle in string array
    [{ in: [5, { var: "user.ids" }] }, { user: { ids: ["5", "6"] } }, false],
    [{ in: [5, { var: "user.ids" }] }, { user: { ids: [5, 6] } }, true],
    // missing attribute: var yields null, in(null) is false
    [{ in: ["x", { var: "user.missing" }] }, { user: {} }, false],
    // non-indexable haystack
    [{ in: ["x", { var: "user.count" }] }, { user: { count: 42 } }, false],
    // empty needle is "contained" in any string (indexOf semantics)
    [{ in: ["", { var: "user.email" }] }, { user: { email: "a@b" } }, true],
  ];

  it.each(containsCases.map((c, i) => [i, c] as const))(
    "contains case %i agrees with upstream",
    (_index, [logic, data, expected]) => {
      const vendored = apply(logic, data);
      const reference = upstream.apply(logic as never, data);
      expect(vendored).toEqual(reference);
      expect(vendored).toEqual(expected);
    },
  );

  it("a literal 'contains' operation throws in both evaluators (rule gets skipped)", () => {
    const logic = { contains: [{ var: "user.email" }, "corp"] };
    expect(() => apply(logic, { user: { email: "x@corp" } })).toThrow(/Unrecognized operation/);
    expect(() => upstream.apply(logic as never, { user: { email: "x@corp" } })).toThrow();
  });
});

describe("loose-equality parity spot checks", () => {
  it('"5" == 5 is true in both', () => {
    const logic = { "==": [{ var: "user.plan" }, 5] };
    expect(apply(logic, { user: { plan: "5" } })).toBe(true);
    expect(upstream.apply(logic as never, { user: { plan: "5" } })).toBe(true);
  });
});
