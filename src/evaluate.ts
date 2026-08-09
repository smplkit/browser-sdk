/**
 * Flag evaluation — a faithful mirror of the server TypeScript SDK's
 * `evaluateFlag` (typescript-sdk `src/flags/client.ts`). Resolution
 * semantics must match the server SDKs exactly; the worst possible bug
 * in a feature-flag product is the browser and the server disagreeing
 * about the same flag.
 *
 * Evaluation order:
 * 1. Look up the environment. If missing, return flag-level default.
 * 2. If disabled, return env default (when non-null) else flag default.
 * 3. Iterate rules; first rule whose logic evaluates truthy wins.
 *    Empty-logic rules are skipped; rules that throw are skipped.
 * 4. No match → env default (when non-null) else flag default.
 */

import { apply } from "./vendor/json-logic.js";

/** One targeting rule as served on the wire. */
export interface FlagRule {
  description?: string | null;
  logic: Record<string, unknown>;
  value: unknown;
}

/** Per-environment flag configuration as served on the wire. */
export interface FlagEnvironment {
  enabled?: boolean;
  default?: unknown;
  rules?: FlagRule[];
}

/** A flag definition as held in the local store. */
export interface FlagDefinition {
  name?: string;
  type?: string;
  default: unknown;
  values?: Array<{ name: string; value: unknown }> | null;
  environments?: Record<string, FlagEnvironment>;
}

export function evaluateFlag(
  flagDef: FlagDefinition,
  environment: string | null,
  evalDict: Record<string, unknown>,
): unknown {
  const flagDefault = flagDef.default;
  const environments = flagDef.environments ?? {};

  if (environment === null || !(environment in environments)) {
    return flagDefault;
  }

  const envConfig = environments[environment];
  const envDefault = envConfig.default;
  const fallback = envDefault !== undefined && envDefault !== null ? envDefault : flagDefault;

  if (!envConfig.enabled) {
    return fallback;
  }

  const rules = envConfig.rules ?? [];
  for (const rule of rules) {
    const logic = rule.logic;
    if (!logic || Object.keys(logic).length === 0) {
      continue;
    }
    try {
      const result = apply(logic, evalDict);
      if (result) {
        return rule.value;
      }
    } catch {
      // Skip invalid rules
      continue;
    }
  }

  return fallback;
}
