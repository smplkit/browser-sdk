/**
 * Config inheritance resolution — a faithful mirror of the server
 * TypeScript SDK's `src/config/resolve.ts` (the Go SDK implements the
 * identical algorithm). Child configs override parent configs, and
 * environment-specific values override base values, with deep merging
 * of nested objects at every step.
 */

/** A single entry in a config inheritance chain (child-to-root ordering). */
export interface ChainConfig {
  /** Base key-value pairs (unwrapped values, not the wire item envelope). */
  items: Record<string, unknown>;
  /** Per-environment overrides: `{ envKey: { itemKey: value } }`. */
  environments: Record<string, unknown>;
}

/**
 * Recursively merge two objects, with `override` taking precedence.
 * Arrays are treated as scalars (replaced, never merged).
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve the full configuration for an environment given a config chain.
 *
 * @param chain - Ordered list of config data from child (index 0) to root
 *   ancestor (last).
 * @param environment - The environment key to resolve for, or null when
 *   no environment applies (base values only).
 */
export function resolveChain(
  chain: ChainConfig[],
  environment: string | null,
): Record<string, unknown> {
  let accumulated: Record<string, unknown> = {};

  // Walk from root to child (reverse order — chain is child-to-root)
  for (let i = chain.length - 1; i >= 0; i--) {
    const config = chain[i];
    const baseValues: Record<string, unknown> = config.items ?? {};

    const envEntry = environment === null ? undefined : (config.environments ?? {})[environment];
    const envValues: Record<string, unknown> =
      envEntry !== null &&
      envEntry !== undefined &&
      typeof envEntry === "object" &&
      !Array.isArray(envEntry)
        ? (envEntry as Record<string, unknown>)
        : {};

    // Merge environment overrides on top of base values (env wins)
    const configResolved = deepMerge(baseValues, envValues);

    // Merge this config's resolved values on top of accumulated parent values (child wins)
    accumulated = deepMerge(accumulated, configResolved);
  }

  return accumulated;
}
