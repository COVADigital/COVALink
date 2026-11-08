import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  var __covalinkSql: postgres.Sql | undefined;
}

function createClient() {
  return postgres(env().DATABASE_URL, { max: 10, idle_timeout: 30, connect_timeout: 10, prepare: true });
}

// Reuse the pool across hot reloads in development.
const sql = globalThis.__covalinkSql ?? createClient();
if (process.env.NODE_ENV !== "production") globalThis.__covalinkSql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { sql as pgClient };
