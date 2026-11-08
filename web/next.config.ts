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

const nextConfig: NextConfig = {
  // Self-contained server for the production image (web/Dockerfile).
  output: "standalone",
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
