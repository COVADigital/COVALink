// Analytics retention. Deletes analytics events older than the
// retention period and visitor-hash salts older than yesterday (UTC).
// Usage (from web/):
//   npm run analytics:purge                (deletes)
//   npm run analytics:purge -- --dry-run   (counts only)
// Production image: node scripts/analytics-purge.mjs (see DEPLOYMENT.md).
// Reads DATABASE_URL, and ANALYTICS_RETENTION_DAYS as the fallback when no
// valid `analytics.retentionDays` setting is stored.
//
// Boundaries use the database clock in UTC:
//   events: occurred_at < start of UTC day (today - (retentionDays - 1))
//   salts:  day < UTC yesterday (today's and yesterday's salts are kept)
// so the dashboard's longest range (retentionDays UTC days including today)
// is fully retained. Batched deletes run under a session advisory lock: a
// second purge started concurrently waits, then finds nothing left (rerun and
// concurrency are safe). Prints counts and the boundary only, never event
// data, hashes, salts or user information. Nothing in COVALink schedules this.
import postgres from "postgres";
import { BATCH_SIZE, parseArgs, resolveRetention, UsageError } from "./analytics-purge-core.mjs";
import { databaseUrlSecrets, describeError } from "./error-summary.mjs";

const PURGE_LOCK_ID = 727_003;

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`[analytics:purge] ${err instanceof UsageError ? err.message : "invalid arguments"}`);
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[analytics:purge] DATABASE_URL is not set");
  process.exit(2);
}
const secrets = databaseUrlSecrets(url);

const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15 });
try {
  await sql`select pg_advisory_lock(${PURGE_LOCK_ID})`;
  const [setting] = await sql`select value from system_settings where key = 'analytics.retentionDays'`;
  const retention = resolveRetention(setting?.value, process.env.ANALYTICS_RETENTION_DAYS);
  const [{ boundary, saltBoundary }] = await sql`
    select (date_trunc('day', now() at time zone 'utc') - make_interval(days => ${retention.days - 1}::int)) at time zone 'utc' as boundary,
           ((now() at time zone 'utc')::date - 1)::text as "saltBoundary"`;
  let events = 0;
  let salts = 0;
  if (opts.dryRun) {
    [{ events }] = await sql`select count(*)::int as events from analytics_events where occurred_at < ${boundary}`;
    [{ salts }] = await sql`select count(*)::int as salts from analytics_salts where day < ${saltBoundary}::date`;
  } else {
    for (;;) {
      const r = await sql`
        delete from analytics_events where id in (
          select id from analytics_events where occurred_at < ${boundary} order by occurred_at limit ${BATCH_SIZE})`;
      events += r.count;
      if (r.count < BATCH_SIZE) break;
    }
    salts = (await sql`delete from analytics_salts where day < ${saltBoundary}::date`).count;
  }
  const verb = opts.dryRun ? "would delete" : "deleted";
  console.log(`[analytics:purge] retention ${retention.days} days (${retention.from}); events before ${boundary.toISOString()}, salts before ${saltBoundary}`);
  console.log(`[analytics:purge] ${verb} ${events} events and ${salts} salts`);
} catch (err) {
  console.error(`[analytics:purge] failed: ${err instanceof UsageError ? err.message : describeError(err, secrets)}`);
  process.exitCode = 1;
} finally {
  await sql`select pg_advisory_unlock(${PURGE_LOCK_ID})`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
}
