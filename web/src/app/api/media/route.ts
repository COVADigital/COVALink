import { handleMediaUpload } from "@/features/media/upload";

/** Image upload: one raw file body, `?kind=avatar|background` (features/media/upload.ts). */
export async function POST(request: Request) {
  return handleMediaUpload(request);
}
