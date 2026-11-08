import type { Metadata } from "next";
import type { ProfileDocument } from "./document";

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Metadata for a public profile, derived only from the *published* document
 * (callers must never pass a draft). Canonical URL is the lowercase handle on
 * the configured APP_URL.
 */
export function buildProfileMetadata({
  published,
  handle,
  appUrl,
  siteName,
}: {
  published: ProfileDocument;
  handle: string;
  appUrl: string;
  siteName: string;
}): Metadata {
  const { header, settings } = published;
  const title = settings.seo.title ?? header.displayName;
  const description = settings.seo.description ?? (header.bio ? truncate(header.bio, 160) : `${header.displayName} on ${siteName}`);
  const canonical = new URL(`/${handle}`, appUrl).toString();
  const images = header.avatarUrl ? [{ url: new URL(header.avatarUrl, appUrl).toString(), alt: header.displayName }] : undefined;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    robots: settings.seo.noindex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: { type: "profile", title, description, url: canonical, siteName, images },
    twitter: { card: "summary", title, description, images: images?.map((i) => i.url) },
  };
}
