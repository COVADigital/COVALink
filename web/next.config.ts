import type { NextConfig } from "next";
import {
  mediaResponseHeaders,
  PAGE_HEADERS_SOURCE,
  PROFILE_HEADERS_SOURCE,
  profileSecurityHeaders,
  securityHeaders,
  TOKEN_PAGE_HEADERS_SOURCE,
  tokenPageHeaders,
  VCARD_HEADERS_SOURCE,
  vcardSecurityHeaders,
} from "./src/lib/security/headers";

// Release builds pass the full commit SHA (web/Dockerfile, COVALINK_BUILD_ID), so
// two builds of one commit get the same build ID. Any other value, such as a
// local tag, keeps Next.js's default random ID.
const buildId = process.env.COVALINK_BUILD_ID ?? "";
const releaseBuildId = /^[0-9a-f]{40}$/.test(buildId) ? buildId : null;

// A Server Actions key supplied for a release build (a BuildKit secret, never a
// build argument) must be a valid AES-256 key: base64 of exactly 32 bytes. The
// key itself is never printed.
const actionsKey = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
if (actionsKey !== undefined && actionsKey !== "") {
  const bytes = Buffer.from(actionsKey, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== actionsKey) {
    throw new Error("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY must be the base64 encoding of exactly 32 bytes");
  }
}

const nextConfig: NextConfig = {
  // Self-contained server for the production image (web/Dockerfile).
  output: "standalone",
  generateBuildId: async () => releaseBuildId,
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [
      // Everything except uploaded media, the QR download (which sets its own), the token pages, the exact vCard route and public profiles gets the page headers.
      { source: PAGE_HEADERS_SOURCE, headers: securityHeaders({ isDev: process.env.NODE_ENV === "development" }) },
      // Public profile paths: the page headers with the provider players' frame-src.
      { source: PROFILE_HEADERS_SOURCE, headers: profileSecurityHeaders({ isDev: process.env.NODE_ENV === "development" }) },
      // Reset and verification pages: the page headers with no-referrer, no-store and noindex.
      { source: TOKEN_PAGE_HEADERS_SOURCE, headers: tokenPageHeaders({ isDev: process.env.NODE_ENV === "development" }) },
      // Uploaded media gets the media headers (also set by the route itself).
      { source: "/media/:path*", headers: Object.entries(mediaResponseHeaders()).map(([key, value]) => ({ key, value })) },
      // Exactly /api/vcard/{profileId}/{blockId}: the vCard security headers, also on responses Next.js generates there.
      { source: VCARD_HEADERS_SOURCE, headers: Object.entries(vcardSecurityHeaders()).map(([key, value]) => ({ key, value })) },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
