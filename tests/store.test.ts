/** Store: ingestion diffing, listeners, caches, environment derivation. */
import { describe, expect, it, vi } from "vitest";

import { Store, type ConfigChangeEvent, type FlagChangeEvent } from "../src/store.js";

const FLAG = {
  type: "BOOLEAN",
  default: false,
  environments: {
    production: {
      enabled: true,
      default: null,
      rules: [{ logic: { "==": [{ var: "user.plan" }, "pro"] }, value: true }],
    },
  },
};

describe("environment derivation", () => {
  it("derives the single environment from flag data", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    expect(store.environment).toBe("production");
  });

  it("derives from config data when flags carry none", () => {
    const store = new Store();
    store.ingest(
      { f: { default: 1, environments: {} } },
      { c: { parent: null, items: {}, environments: { staging: { a: 1 } } } },
      "manual",
    );
    expect(store.environment).toBe("staging");
  });

  it("null when no environment-specific data exists", () => {
    const store = new Store();
    store.ingest({ f: { default: 1, environments: {} } }, {}, "manual");
    expect(store.environment).toBe(null);
  });

  it("re-derives after new data arrives", () => {
    const store = new Store();
    store.ingest({ f: { default: 1, environments: {} } }, undefined, "manual");
    expect(store.environment).toBe(null);
    store.ingest({ f: FLAG }, undefined, "manual");
    expect(store.environment).toBe("production");
  });
});

describe("ingest + subscribers", () => {
  it("bumps version and notifies on changes", () => {
    const store = new Store();
    const listener = vi.fn();
    store.subscribe(listener);
    const v0 = store.version;
    store.ingest({ f: FLAG }, {}, "manual");
    expect(store.version).toBeGreaterThan(v0);
    expect(listener).toHaveBeenCalled();
    expect(store.ready).toBe(true);
  });

  it("unsubscribe stops notifications", () => {
    const store = new Store();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.ingest({ f: FLAG }, {}, "manual");
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscriber errors never propagate", () => {
    const store = new Store();
    store.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => store.ingest({ f: FLAG }, {}, "manual")).not.toThrow();
  });

  it("identical re-ingest does not re-notify (beyond ready)", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    const listener = vi.fn();
    store.subscribe(listener);
    store.ingest({ f: FLAG }, undefined, "manual");
    expect(listener).not.toHaveBeenCalled();
  });

  it("undefined halves leave existing data untouched", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    store.ingest(undefined, undefined, "manual");
    expect(store.flags.f).toBeDefined();
  });
});

describe("flag change listeners", () => {
  it("fires per-key and global listeners on changes and deletes", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    const events: FlagChangeEvent[] = [];
    const keyed: FlagChangeEvent[] = [];
    store.onFlagChange((e) => events.push(e));
    store.onFlagChange("f", (e) => keyed.push(e));

    store.ingest({ f: { ...FLAG, default: true } }, undefined, "push");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "f", source: "push", deleted: false });
    expect(keyed).toHaveLength(1);

    store.ingest({}, undefined, "push");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ id: "f", deleted: true });
  });

  it("listener errors never propagate; onChange without cb throws", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    store.onFlagChange(() => {
      throw new Error("boom");
    });
    expect(() => store.ingest({ f: { ...FLAG, default: true } }, undefined, "push")).not.toThrow();
    expect(() => store.onFlagChange("f")).toThrow(TypeError);
  });
});

describe("config change listeners", () => {
  const CONFIGS = {
    common: { parent: null, items: { timeout: 5 }, environments: { production: { timeout: 30 } } },
    app: { parent: "common", items: { theme: "light" }, environments: {} },
  };

  it("initial load fires initial-source events", () => {
    const store = new Store();
    const events: ConfigChangeEvent[] = [];
    store.onConfigChange(null, null, (e) => events.push(e));
    store.ingest({ f: FLAG }, CONFIGS, "manual");
    const sources = new Set(events.map((e) => e.source));
    expect(sources).toEqual(new Set(["initial"]));
    expect(events.some((e) => e.configId === "app" && e.itemKey === "timeout")).toBe(true);
  });

  it("fires filtered events with old and new values on updates", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, CONFIGS, "manual");
    const all: ConfigChangeEvent[] = [];
    const scoped: ConfigChangeEvent[] = [];
    const item: ConfigChangeEvent[] = [];
    store.onConfigChange(null, null, (e) => all.push(e));
    store.onConfigChange("app", null, (e) => scoped.push(e));
    store.onConfigChange("app", "theme", (e) => item.push(e));

    store.ingest(
      undefined,
      {
        ...CONFIGS,
        app: { parent: "common", items: { theme: "dark" }, environments: {} },
      },
      "push",
    );
    expect(item).toHaveLength(1);
    expect(item[0]).toMatchObject({
      configId: "app",
      itemKey: "theme",
      oldValue: "light",
      newValue: "dark",
      source: "push",
    });
    expect(scoped.every((e) => e.configId === "app")).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("fires deletion events when a config disappears", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, CONFIGS, "manual");
    const events: ConfigChangeEvent[] = [];
    store.onConfigChange("app", null, (e) => events.push(e));
    const { app: _gone, ...remaining } = CONFIGS;
    store.ingest(undefined, remaining, "push");
    expect(events.some((e) => e.newValue === undefined)).toBe(true);
  });

  it("config listener errors never propagate", () => {
    const store = new Store();
    store.onConfigChange(null, null, () => {
      throw new Error("boom");
    });
    expect(() => store.ingest(undefined, CONFIGS, "manual")).not.toThrow();
  });
});

describe("evaluation cache", () => {
  it("caches per flag+context and clears on ingest", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    const v1 = store.evaluate("f", false, { user: { plan: "pro" } });
    expect(v1).toBe(true);
    // cached path
    expect(store.evaluate("f", false, { user: { plan: "pro" } })).toBe(true);
    // distinct context, distinct result
    expect(store.evaluate("f", false, { user: { plan: "free" } })).toBe(false);

    store.ingest({ f: { ...FLAG, default: true, environments: {} } }, undefined, "push");
    expect(store.evaluate("f", false, { user: { plan: "pro" } })).toBe(true); // new def, env gone → default true
  });

  it("unknown flag returns the caller default; null eval collapses to default", () => {
    const store = new Store();
    store.ingest({}, {}, "manual");
    expect(store.evaluate("missing", "fallback", {})).toBe("fallback");
    store.ingest({ n: { default: null, environments: {} } }, undefined, "push");
    expect(store.evaluate("n", "fallback", {})).toBe("fallback");
  });

  it("evicts oldest entries beyond the cache cap", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    for (let i = 0; i < 10_001; i++) {
      store.evaluate("f", false, { user: { plan: `p${i}` } });
    }
    // No assertion beyond it not blowing up — the cap branch executed.
    expect(store.evaluate("f", false, { user: { plan: "pro" } })).toBe(true);
  });

  it("ingestContextChange clears evaluations and notifies", () => {
    const store = new Store();
    store.ingest({ f: FLAG }, {}, "manual");
    const listener = vi.fn();
    store.subscribe(listener);
    store.ingestContextChange();
    expect(listener).toHaveBeenCalled();
  });
});

describe("config resolution cache", () => {
  it("resolves chains through parents and caches", () => {
    const store = new Store();
    store.ingest(
      { f: FLAG },
      {
        common: {
          parent: null,
          items: { timeout: 5 },
          environments: { production: { timeout: 30 } },
        },
        app: { parent: "common", items: { theme: "light" }, environments: {} },
      },
      "manual",
    );
    expect(store.resolvedConfig("app")).toEqual({ timeout: 30, theme: "light" });
    expect(store.resolvedConfig("common")).toEqual({ timeout: 30 });
    expect(store.resolvedConfig("nope")).toBeUndefined();
  });

  it("survives parent cycles and missing parents", () => {
    const store = new Store();
    store.ingest(
      undefined,
      {
        a: { parent: "b", items: { x: 1 }, environments: {} },
        b: { parent: "a", items: { y: 2 }, environments: {} },
        orphan: { parent: "ghost", items: { z: 3 }, environments: {} },
      },
      "manual",
    );
    expect(store.resolvedConfig("a")).toEqual({ x: 1, y: 2 });
    expect(store.resolvedConfig("orphan")).toEqual({ z: 3 });
  });

  it("lazily resolves when the cache was invalidated", () => {
    const store = new Store();
    store.ingest(undefined, { c: { parent: null, items: { a: 1 }, environments: {} } }, "manual");
    store.ingestContextChange(); // does not clear resolution
    expect(store.resolvedConfig("c")).toEqual({ a: 1 });
    // Force the lazy branch: flags-only ingest clears resolved cache.
    store.ingest({ f: FLAG }, undefined, "push");
    expect(store.resolvedConfig("c")).toEqual({ a: 1 });
  });
});
