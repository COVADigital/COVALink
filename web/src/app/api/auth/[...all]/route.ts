import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";
import { isBlockedAuthRequest } from "@/lib/auth/blocked-paths";

const handlers = toNextJsHandler(auth);

/**
 * Endpoints COVALink only uses internally, and a reset token in a query string,
 * answer 404 like an unknown route.
 */
function guard(handler: (request: Request) => Promise<Response>) {
  return (request: Request) => (isBlockedAuthRequest(request) ? Promise.resolve(new Response("Not Found", { status: 404 })) : handler(request));
}

export const GET = guard(handlers.GET);
export const POST = guard(handlers.POST);
