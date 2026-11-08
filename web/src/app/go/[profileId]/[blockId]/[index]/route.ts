import { connection } from "next/server";
import { handleSocialClick } from "@/features/analytics/click";

/**
 * Tracked redirect for one item of a published social block
 * (features/analytics/click.ts). HEAD shares the handler: same
 * validation and redirect, never recorded.
 */
async function go(request: Request, { params }: RouteContext<"/go/[profileId]/[blockId]/[index]">) {
  await connection();
  const { profileId, blockId, index } = await params;
  return handleSocialClick(request, profileId, blockId, index);
}

export const GET = go;
export const HEAD = go;
