import { connection } from "next/server";
import { serveMedia } from "@/features/media/serve";

/** Uploaded images by capability URL, `/media/{uuid}.webp` (features/media/serve.ts). */
export async function GET(_request: Request, { params }: RouteContext<"/media/[key]">) {
  await connection();
  const { key } = await params;
  return serveMedia(key);
}
