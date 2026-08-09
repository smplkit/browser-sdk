import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __SMPLKIT_BROWSER_SDK_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: { lines: 100 },
    },
  },
});
