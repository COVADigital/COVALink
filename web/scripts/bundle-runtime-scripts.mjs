// Image build step (web/Dockerfile): copies the operational scripts and the
// exact files they load into the standalone output, so the runtime image can
// run them without a full node_modules. Usage (from web/, after next build):
//   node scripts/bundle-runtime-scripts.mjs
// Dependencies are traced with the @vercel/nft copy that Next.js ships (the
// same tracer Next uses for server.js), not hand-maintained lists.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");

const ENTRY_POINTS = ["scripts/migrate.mjs", "scripts/media-gc.mjs", "scripts/analytics-purge.mjs", "scripts/healthcheck.mjs"];
const base = process.cwd();
const outDir = path.join(base, ".next", "standalone");

const { fileList, warnings } = await nodeFileTrace(ENTRY_POINTS, { base });
const problems = [...warnings].filter((w) => !/^Failed to resolve dependency "node:/.test(String(w?.message ?? w)));
if (problems.length) {
  for (const w of problems) console.error(`[bundle-scripts] ${w?.message ?? w}`);
  process.exit(1);
}

const files = [...fileList].sort();
for (const rel of files) {
  if (path.isAbsolute(rel) || rel.startsWith("..")) {
    console.error(`[bundle-scripts] refusing a file outside the project: ${rel}`);
    process.exit(1);
  }
  const dest = path.join(outDir, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(base, rel), dest);
}
console.log(`[bundle-scripts] copied ${files.length} files for ${ENTRY_POINTS.join(", ")}`);
