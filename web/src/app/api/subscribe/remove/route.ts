import { handleSubscribeToken } from "@/features/audience/subscribe";

/** Removes a contact with the token from its email (features/audience/subscribe.ts). */
export async function POST(request: Request) {
  return handleSubscribeToken(request, "remove");
}
