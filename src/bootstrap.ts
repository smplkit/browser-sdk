/**
 * Bootstrap cache: the last-known payload plus its ETags, persisted in
 * `localStorage` so a returning visitor evaluates from cache immediately
 * (0ms first paint) while the SDK revalidates in the background.
 */

import type { FlagDefinition } from "./evaluate.js";
import type { ConfigDefinition } from "./store.js";
import { parseConfigsResponse, parseFlagsResponse } from "./transport.js";

/** A server-rendered bootstrap payload (for SSR hydration). Each half is
 * the raw JSON body of the corresponding public list endpoint. */
export interface BootstrapPayload {
  flags?: unknown;
  configs?: unknown;
}

export type BootstrapOption = "localStorage" | "none" | BootstrapPayload;

interface PersistedState {
  v: 1;
  flags: Record<string, FlagDefinition>;
  configs: Record<string, ConfigDefinition>;
  etags: { flags?: string; configs?: string };
  savedAt: number;
}

/** Storage keyed by the public key itself, so two keys on the same
 * origin never collide. The key is publishable — not a secret. */
function storageKey(apiKey: string): string {
  return `smplkit:browser:${apiKey}`;
}

/* v8 ignore start — environments without localStorage (or with it
   blocked, e.g. some private modes) simply skip persistence. */
function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
/* v8 ignore stop */

/** @internal */
export function loadPersisted(apiKey: string): PersistedState | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(storageKey(apiKey));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** @internal */
export function persist(
  apiKey: string,
  flags: Record<string, FlagDefinition>,
  configs: Record<string, ConfigDefinition>,
  etags: { flags?: string; configs?: string },
): void {
  const store = storage();
  if (store === null) return;
  try {
    const state: PersistedState = { v: 1, flags, configs, etags, savedAt: Date.now() };
    store.setItem(storageKey(apiKey), JSON.stringify(state));
  } catch {
    // Quota exceeded or storage blocked — persistence is best-effort.
  }
}

/** @internal Parse a server-rendered payload into store shapes. */
export function parseBootstrapPayload(payload: BootstrapPayload): {
  flags: Record<string, FlagDefinition> | undefined;
  configs: Record<string, ConfigDefinition> | undefined;
} {
  return {
    flags: payload.flags !== undefined ? parseFlagsResponse(payload.flags) : undefined,
    configs: payload.configs !== undefined ? parseConfigsResponse(payload.configs) : undefined,
  };
}
