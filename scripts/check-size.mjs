// Size budget, enforced in CI: this code runs in customers' customers'
// browsers, and every kilobyte is somebody's page load. Fail the build on
// breach rather than drifting.
//
// tsup code-splits the ESM build, so an entry's real cost is the entry
// file plus every local chunk it transitively imports. The core budget
// covers dist/index.js and its chunks; the react budget covers only what
// dist/react.js adds beyond those.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const CORE_BUDGET = 12 * 1024;
const REACT_EXTRA_BUDGET = 3 * 1024;

function localImports(source) {
  const found = new Set();
  for (const match of source.matchAll(/from\s*["']\.\/([^"']+)["']/g)) {
    found.add(match[1]);
  }
  for (const match of source.matchAll(/import\s*["']\.\/([^"']+)["']/g)) {
    found.add(match[1]);
  }
  return [...found];
}

function reachable(entry) {
  const files = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(`dist/${file}`, "utf8");
    for (const dep of localImports(source)) {
      queue.push(dep);
    }
  }
  return files;
}

function gzipOf(files) {
  let total = 0;
  for (const file of files) {
    total += gzipSync(readFileSync(`dist/${file}`, "utf8"), { level: 9 }).length;
  }
  return total;
}

const coreFiles = reachable("index.js");
const reactFiles = reachable("react.js");
const reactOnly = [...reactFiles].filter((f) => !coreFiles.has(f));

const coreGz = gzipOf(coreFiles);
const reactGz = gzipOf(reactOnly);

let failed = false;
const report = (label, actual, budget, files) => {
  const line = `${label}: ${actual} gzipped bytes (budget ${budget}) [${[...files].join(", ")}]`;
  if (actual > budget) {
    console.error(`SIZE BUDGET EXCEEDED — ${line}`);
    failed = true;
  } else {
    console.log(`ok — ${line}`);
  }
};

report("core (index.js + chunks)", coreGz, CORE_BUDGET, coreFiles);
report("react additional", reactGz, REACT_EXTRA_BUDGET, reactOnly);

process.exit(failed ? 1 : 0);
