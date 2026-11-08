import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { resolveHandleParam } from "@/features/profiles/handle";
import { isProfileLive } from "@/features/profiles/live-check";

/**
 * Runs before rendering, the only point where an HTTP status can still be
 * chosen (Next.js streams pages with 200 once rendering starts).
 *
 * 1. Private areas: optimistic gate. Requests without a session cookie are
 *    redirected to /login. The authoritative check (valid, unexpired, not
 *    banned) is `requireUser()` / `requireCapability()` in each page.
 * 2. Public profiles (`/{segment}`): canonical redirects (308) and real 404s.
 *    Malformed handles are rejected without I/O; valid ones get one fast
 *    indexed existence lookup, as Next.js recommends for request-time 404s.
 *    The page repeats the live check and renders only published content.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPrivateArea(pathname, "/dashboard") || isPrivateArea(pathname, "/admin")) return authGate(request);
  return publicProfileGate(request);
}

/** Match an application segment and its descendants, not valid handles that merely share its prefix. */
function isPrivateArea(pathname: string, segment: "/dashboard" | "/admin") {
  return pathname === segment || pathname.startsWith(`${segment}/`);
}

function authGate(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

/** Top-level segments served by real application routes (not profiles). */
const APP_SEGMENTS = new Set([
  "login", "register", "setup", "forgot-password", "reset-password", "verify-email", "dashboard", "admin", "favicon.ico",
]);

async function publicProfileGate(request: NextRequest) {
  let segment: string;
  try {
    segment = decodeURIComponent(request.nextUrl.pathname.slice(1));
  } catch {
    return notFound(request);
  }
  if (APP_SEGMENTS.has(segment)) return NextResponse.next();
  const resolved = resolveHandleParam(segment);
  if (resolved.kind === "redirect") return NextResponse.redirect(new URL(`/${resolved.handle}`, request.url), 308);
  if (resolved.kind === "not_found" || !(await isProfileLive(resolved.handle))) return notFound(request);
  return NextResponse.next();
}

function notFound(request: NextRequest) {
  return NextResponse.rewrite(new URL("/_not-found", request.url), { status: 404 });
}

export const config = {
  // Single-segment paths (public profiles) plus the private areas.
  matcher: ["/:segment", "/dashboard/:path*", "/admin/:path*"],
};
