import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
  },
  format: ["esm", "cjs"],
  dts: { compilerOptions: { stripInternal: true } },
  clean: true,
  sourcemap: true,
  external: ["react"],
  define: {
    __SMPLKIT_BROWSER_SDK_VERSION__: JSON.stringify(pkg.version),
  },
})
