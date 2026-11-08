import { connection } from "next/server";
import { handleClick } from "@/features/analytics/click";

/**
 * Tracked redirect for published link blocks (features/analytics/click.ts).
 * HEAD is declared explicitly (instead of Next.js answering it through GET)
 * and shares the handler: same validation and redirect, never recorded.
 */
async function go(request: Request, { params }: RouteContext<"/go/[profileId]/[blockId]">) {
  await connection();
  const { profileId, blockId } = await params;
  return handleClick(request, profileId, blockId);
}

export const GET = go;
export const HEAD = go;
