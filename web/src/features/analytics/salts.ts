import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { analyticsSalts } from "@/db/schema";
import { newSalt } from "./visitor";

const UTC_TODAY = sql`(now() at time zone 'utc')::date`;

/**
 * The current UTC day's salt, created on first use. Concurrent first
 * events race on the primary key: `ON CONFLICT DO NOTHING` waits for the
 * winner, and the separate read (a new snapshot under READ COMMITTED) sees
 * its row, so every caller gets the same single salt. The second attempt
 * covers the read landing just after midnight. The salt is never logged or
 * returned to a client.
 */
export async function currentSalt(): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await db.insert(analyticsSalts).values({ day: UTC_TODAY, salt: newSalt() }).onConflictDoNothing();
    const [row] = await db.select({ salt: analyticsSalts.salt }).from(analyticsSalts).where(eq(analyticsSalts.day, UTC_TODAY));
    if (row) return row.salt;
  }
  throw new Error("analytics salt unavailable");
}
