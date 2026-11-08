import "server-only";
import { count } from "drizzle-orm";
import { db, pgClient } from "@/db";
import { users } from "@/db/schema";
import { getBootstrapInfo } from "@/features/setup/service";
import { mediaStorage } from "@/features/media/storage";
import { getSetting } from "@/features/settings/service";
import { probeDatabase } from "@/lib/health/db-probe";
import { runProbe, type ProbeOutcome } from "@/lib/health/readiness";
import { probeStorage } from "@/lib/health/storage-probe";
import { smtpConfigured } from "@/lib/env";
import { requireActor } from "./actor";
import { versionLabel, type SystemStatus } from "./status-format";

/**
 * Installation status for administrators (`admin.access`). Reuses the
 * bounded readiness probes (2 s each, fixed outcome vocabulary). It reads no
 * environment value except the non-secret build identifier, and returns no
 * URL, path, hostname or error text. A page can't authenticate while
 * PostgreSQL is down, so database outages are observed through `/api/ready`;
 * this page reports storage outages and the other facts.
 */

export interface StatusDeps {
  storageProbe: () => Promise<ProbeOutcome>;
}

const defaultStorageProbe = async (): Promise<ProbeOutcome> => {
  try {
    return await probeStorage(mediaStorage());
  } catch {
    return "unavailable"; // misconfigured root; the message (a setting name) stays in the server log
  }
};

/** Account count and setup time (kept from the original setup page), for `admin.access`. */
export async function getInstallationSummary(actorId: string): Promise<{ accounts: number; setUpAt: Date | null }> {
  await requireActor(actorId, "admin.access");
  const [[{ accounts }], bootstrap] = await Promise.all([db.select({ accounts: count() }).from(users), getBootstrapInfo()]);
  return { accounts, setUpAt: bootstrap?.completedAt ?? null };
}

export async function getSystemStatus(actorId: string, deps: Partial<StatusDeps> = {}): Promise<SystemStatus> {
  await requireActor(actorId, "admin.access");
  let migrations: number | null = null;
  const [database, storage, migrationOutcome, retentionDays] = await Promise.all([
    probeDatabase(pgClient),
    (deps.storageProbe ?? defaultStorageProbe)(),
    runProbe(async () => {
      const [row] = await pgClient`select count(*)::int as n from drizzle.__drizzle_migrations`;
      migrations = Number(row?.n);
    }),
    getSetting("analytics.retentionDays"),
  ]);
  return {
    version: versionLabel(process.env.COVALINK_GIT_SHA),
    database,
    storage,
    emailConfigured: smtpConfigured(),
    migrations: migrationOutcome === "ok" && Number.isInteger(migrations) ? migrations : null,
    retentionDays,
  };
}
