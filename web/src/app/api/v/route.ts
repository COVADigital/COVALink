import { handleViewBeacon } from "@/features/analytics/beacon";

/** Profile-view beacon (features/analytics/beacon.ts). */
export async function POST(request: Request) {
  return handleViewBeacon(request);
}
