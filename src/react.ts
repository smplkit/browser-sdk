/**
 * React bindings for `@smplkit/browser` — `@smplkit/browser/react`.
 *
 * Built on `useSyncExternalStore`, which handles tearing and SSR
 * hydration correctly; the core client exposes the subscribe/snapshot
 * pair it needs. React is an optional peer dependency (>= 18).
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { SmplClient, type SmplClientOptions } from "./client.js";
import type { Context } from "./context.js";

const SmplReactContext = createContext<SmplClient | null>(null);

export interface SmplProviderProps {
  /** An already-constructed client. Takes precedence over `options`. */
  client?: SmplClient;
  /** Options to construct (and own) a client — closed on unmount. */
  options?: SmplClientOptions;
  children?: ReactNode;
}

/** Provides a {@link SmplClient} to the hooks below. */
export function SmplProvider(props: SmplProviderProps): ReactNode {
  const { client, options, children } = props;
  if (client === undefined && options === undefined) {
    throw new TypeError("SmplProvider requires either a client or options.");
  }
  const ownedRef = useRef<SmplClient | null>(null);
  const value = useMemo(() => {
    if (client !== undefined) return client;
    if (ownedRef.current === null) {
      ownedRef.current = new SmplClient(options!);
    }
    return ownedRef.current;
  }, [client, options]);

  useEffect(() => {
    return () => {
      // Only close a client this provider constructed.
      if (ownedRef.current !== null) {
        ownedRef.current.close();
        ownedRef.current = null;
      }
    };
  }, []);

  return createElement(SmplReactContext.Provider, { value }, children);
}

/** The provided client — for `setContext()` on login, `close()`, etc. */
export function useSmpl(): SmplClient {
  const client = useContext(SmplReactContext);
  if (client === null) {
    throw new Error("useSmpl must be used within a <SmplProvider>.");
  }
  return client;
}

function useSmplSnapshot<T>(compute: (client: SmplClient) => T): T {
  const client = useSmpl();
  const subscribe = useMemo(() => (cb: () => void) => client.subscribe(cb), [client]);
  const getSnapshot = () => compute(client);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Evaluate a boolean flag; re-renders when its value changes. */
export function useBooleanFlag(
  key: string,
  defaultValue: boolean,
  options?: { context?: Context[] },
): boolean {
  return useSmplSnapshot((client) => client.flags.booleanFlag(key, defaultValue).get(options));
}

/** Evaluate a string flag; re-renders when its value changes. */
export function useStringFlag(
  key: string,
  defaultValue: string,
  options?: { context?: Context[] },
): string {
  return useSmplSnapshot((client) => client.flags.stringFlag(key, defaultValue).get(options));
}

/** Evaluate a numeric flag; re-renders when its value changes. */
export function useNumberFlag(
  key: string,
  defaultValue: number,
  options?: { context?: Context[] },
): number {
  return useSmplSnapshot((client) => client.flags.numberFlag(key, defaultValue).get(options));
}

/**
 * Evaluate a JSON flag; re-renders when its value changes.
 *
 * Pass a stable `defaultValue` (memoized or module-level) — a fresh
 * object literal per render defeats snapshot stability when the flag is
 * missing.
 */
export function useJsonFlag(
  key: string,
  defaultValue: Record<string, unknown>,
  options?: { context?: Context[] },
): Record<string, unknown> {
  return useSmplSnapshot((client) => client.flags.jsonFlag(key, defaultValue).get(options));
}

const EMPTY_CONFIG: Record<string, unknown> = Object.freeze({});

/**
 * A config's resolved values (inheritance and environment overrides
 * applied); re-renders when any of them change. Returns an empty object
 * until definitions load or when the config does not exist.
 */
export function useConfig(key: string): Record<string, unknown> {
  return useSmplSnapshot((client) => client._store.resolvedConfig(key) ?? EMPTY_CONFIG);
}

/**
 * True once definitions have loaded from any source (a warm bootstrap
 * counts). Render a loading state instead of defaults while false, if
 * flashing defaults matters to you.
 */
export function useSmplReady(): boolean {
  return useSmplSnapshot((client) => client.ready);
}
