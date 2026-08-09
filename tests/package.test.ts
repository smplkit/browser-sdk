/** Package-level invariants. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  it("has zero runtime dependencies — every dependency here is supply-chain surface in end users' browsers", () => {
    expect(pkg.dependencies).toBeUndefined();
  });

  it("react is an optional peer dependency (>=18 for useSyncExternalStore)", () => {
    expect(pkg.peerDependencies).toEqual({ react: ">=18" });
    expect(pkg.peerDependenciesMeta).toEqual({ react: { optional: true } });
  });

  it("supports node >= 18 for SSR and edge workers", () => {
    expect(pkg.engines).toEqual({ node: ">=18" });
  });
});
