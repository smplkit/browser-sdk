/**
 * evaluateFlag semantics — must match the server SDKs exactly:
 * env lookup → disabled check → rules in order, first truthy wins →
 * env default (non-null) else flag default.
 */
import { describe, expect, it } from "vitest";

import { evaluateFlag, type FlagDefinition } from "../src/evaluate.js";

const base: FlagDefinition = {
  type: "STRING",
  default: "global-default",
  environments: {
    production: {
      enabled: true,
      default: "env-default",
      rules: [
        { logic: { "==": [{ var: "user.plan" }, "pro"] }, value: "pro-value" },
        { logic: { "==": [{ var: "user.plan" }, "free"] }, value: "free-value" },
      ],
    },
  },
};

describe("evaluateFlag", () => {
  it("unknown environment returns the flag default", () => {
    expect(evaluateFlag(base, "staging", {})).toBe("global-default");
    expect(evaluateFlag(base, null, {})).toBe("global-default");
  });

  it("missing environments map returns the flag default", () => {
    expect(evaluateFlag({ default: 1 }, "production", {})).toBe(1);
  });

  it("first matching rule wins, in order", () => {
    expect(evaluateFlag(base, "production", { user: { plan: "pro" } })).toBe("pro-value");
    expect(evaluateFlag(base, "production", { user: { plan: "free" } })).toBe("free-value");
  });

  it("no matching rule falls back to env default", () => {
    expect(evaluateFlag(base, "production", { user: { plan: "trial" } })).toBe("env-default");
  });

  it("null env default falls through to flag default", () => {
    const def: FlagDefinition = {
      default: "global-default",
      environments: { production: { enabled: true, default: null, rules: [] } },
    };
    expect(evaluateFlag(def, "production", {})).toBe("global-default");
  });

  it("disabled environment skips rules and returns env default", () => {
    const def: FlagDefinition = {
      default: "global-default",
      environments: {
        production: {
          enabled: false,
          default: "env-default",
          rules: [{ logic: { "==": [1, 1] }, value: "rule-value" }],
        },
      },
    };
    expect(evaluateFlag(def, "production", {})).toBe("env-default");
  });

  it("disabled environment with null default returns flag default", () => {
    const def: FlagDefinition = {
      default: "global-default",
      environments: { production: { enabled: false, default: null, rules: [] } },
    };
    expect(evaluateFlag(def, "production", {})).toBe("global-default");
  });

  it("empty-logic rules are skipped (not always-match)", () => {
    const def: FlagDefinition = {
      default: "global-default",
      environments: {
        production: {
          enabled: true,
          default: null,
          rules: [
            { logic: {}, value: "empty-wins" },
            { logic: { "==": [1, 1] }, value: "real-rule" },
          ],
        },
      },
    };
    expect(evaluateFlag(def, "production", {})).toBe("real-rule");
  });

  it("rules whose logic throws are skipped", () => {
    const def: FlagDefinition = {
      default: "global-default",
      environments: {
        production: {
          enabled: true,
          default: null,
          rules: [
            { logic: { unknown_operation: [1] }, value: "never" },
            { logic: { "==": [1, 1] }, value: "next-rule" },
          ],
        },
      },
    };
    expect(evaluateFlag(def, "production", {})).toBe("next-rule");
  });

  it("missing rules array falls back", () => {
    const def: FlagDefinition = {
      default: "d",
      environments: { production: { enabled: true } },
    };
    expect(evaluateFlag(def, "production", {})).toBe("d");
  });

  it("loose coercion in rules: '5' == 5", () => {
    const def: FlagDefinition = {
      default: false,
      environments: {
        production: {
          enabled: true,
          rules: [{ logic: { "==": [{ var: "user.seats" }, 5] }, value: true }],
        },
      },
    };
    expect(evaluateFlag(def, "production", { user: { seats: "5" } })).toBe(true);
  });
});
