// Orphan media inspection. Dry run by default; deleting needs both --apply
// and --min-age-hours=N. Usage (from web/):
//   npm run media:gc
//   npm run media:gc -- --min-age-hours=24            (dry run, shows what is old enough)
//   npm run media:gc -- --apply --min-age-hours=24    (deletes orphans/temp files older than 24 h)
// Reads DATABASE_URL and STORAGE_LOCAL_PATH. Never prints absolute paths.
import postgres from "postgres";
import { applyGc, parseArgs, planGc, report, resolveRoot, scanStorage, UsageError } from "./media-gc-core.mjs";

let opts;
let root;
try {
  opts = parseArgs(process.argv.slice(2));
  root = resolveRoot(process.env.STORAGE_LOCAL_PATH, process.env.NODE_ENV);
} catch (err) {
  console.error(`[media:gc] ${err instanceof UsageError ? err.message : "invalid configuration"}`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("[media:gc] DATABASE_URL is not set");
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const scan = await scanStorage(root);
  const rows = await sql`select storage_key from media_assets`;
  const live = new Set(rows.map((r) => r.storage_key));
  const plan = planGc(scan, live, { now: Date.now(), minAgeHours: opts.minAgeHours });
  let applied;
  if (opts.apply) {
    applied = await applyGc(scan, plan.eligible, async (key) => {
      const [row] = await sql`select 1 from media_assets where storage_key = ${key}`;
      return Boolean(row);
    });
  }
  for (const line of report(plan, scan, opts, applied)) console.log(line);
} catch (err) {
  console.error(`[media:gc] failed: ${err?.code ?? err?.name ?? "error"}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
