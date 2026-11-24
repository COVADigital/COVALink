import { handleSubscribeToken } from "@/features/audience/subscribe";

/** Confirms a sign-up with the token from its email (features/audience/subscribe.ts). */
export async function POST(request: Request) {
  return handleSubscribeToken(request, "confirm");
}
