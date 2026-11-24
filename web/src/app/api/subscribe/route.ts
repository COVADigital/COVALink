import { handleSubscribe } from "@/features/audience/subscribe";

/** Subscribe-block sign-ups (features/audience/subscribe.ts). */
export async function POST(request: Request) {
  return handleSubscribe(request);
}
