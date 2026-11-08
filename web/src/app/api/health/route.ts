import { connection } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/health/readiness";

/**
 * Liveness: 200 whenever the process can serve requests. Deliberately does not
 * touch PostgreSQL; dependency checks belong to /api/ready.
 */
export async function GET() {
  await connection(); // evaluate per request, never prerendered at build time
  return Response.json({ status: "ok" }, { headers: NO_STORE_HEADERS });
}
