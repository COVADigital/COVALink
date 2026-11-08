import { parseLinkUrl } from "@/lib/validation/url";

/**
 * Social platforms offered in the Social Links block. Independently compiled
 * list; labels are nominative references only (no brand artwork is bundled).
 * `hosts` restricts which URLs are accepted for each platform; an empty list
 * means any https URL (federated networks such as Mastodon).
 */
export interface SocialPlatform {
  id: string;
  label: string;
  /** 1–2 character monogram rendered inside the badge. */
  mark: string;
  hosts: string[];
  placeholder: string;
}

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  { id: "instagram", label: "Instagram", mark: "Ig", hosts: ["instagram.com"], placeholder: "https://instagram.com/you" },
  { id: "x", label: "X", mark: "X", hosts: ["x.com", "twitter.com"], placeholder: "https://x.com/you" },
  { id: "threads", label: "Threads", mark: "Th", hosts: ["threads.net", "threads.com"], placeholder: "https://threads.net/@you" },
  { id: "bluesky", label: "Bluesky", mark: "Bs", hosts: ["bsky.app"], placeholder: "https://bsky.app/profile/you.bsky.social" },
  { id: "mastodon", label: "Mastodon", mark: "Ma", hosts: [], placeholder: "https://mastodon.social/@you" },
  { id: "facebook", label: "Facebook", mark: "Fb", hosts: ["facebook.com", "fb.com"], placeholder: "https://facebook.com/you" },
  { id: "tiktok", label: "TikTok", mark: "Tt", hosts: ["tiktok.com"], placeholder: "https://tiktok.com/@you" },
  { id: "youtube", label: "YouTube", mark: "Yt", hosts: ["youtube.com", "youtu.be"], placeholder: "https://youtube.com/@you" },
  { id: "twitch", label: "Twitch", mark: "Tw", hosts: ["twitch.tv"], placeholder: "https://twitch.tv/you" },
  { id: "linkedin", label: "LinkedIn", mark: "in", hosts: ["linkedin.com"], placeholder: "https://linkedin.com/in/you" },
  { id: "github", label: "GitHub", mark: "Gh", hosts: ["github.com"], placeholder: "https://github.com/you" },
  { id: "discord", label: "Discord", mark: "Dc", hosts: ["discord.gg", "discord.com"], placeholder: "https://discord.gg/invite" },
  { id: "reddit", label: "Reddit", mark: "Rd", hosts: ["reddit.com"], placeholder: "https://reddit.com/user/you" },
  { id: "pinterest", label: "Pinterest", mark: "Pi", hosts: ["pinterest.com"], placeholder: "https://pinterest.com/you" },
  { id: "snapchat", label: "Snapchat", mark: "Sc", hosts: ["snapchat.com"], placeholder: "https://snapchat.com/add/you" },
  { id: "telegram", label: "Telegram", mark: "Tg", hosts: ["t.me", "telegram.me"], placeholder: "https://t.me/you" },
  { id: "whatsapp", label: "WhatsApp", mark: "Wa", hosts: ["wa.me", "whatsapp.com"], placeholder: "https://wa.me/15551234567" },
  { id: "spotify", label: "Spotify", mark: "Sp", hosts: ["spotify.com"], placeholder: "https://open.spotify.com/artist/…" },
  { id: "soundcloud", label: "SoundCloud", mark: "So", hosts: ["soundcloud.com"], placeholder: "https://soundcloud.com/you" },
  { id: "behance", label: "Behance", mark: "Be", hosts: ["behance.net"], placeholder: "https://behance.net/you" },
  { id: "dribbble", label: "Dribbble", mark: "Dr", hosts: ["dribbble.com"], placeholder: "https://dribbble.com/you" },
  { id: "website", label: "Website", mark: "W", hosts: [], placeholder: "https://example.com" },
];

export const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id) as [string, ...string[]];

const byId = new Map(SOCIAL_PLATFORMS.map((p) => [p.id, p]));
export function getSocialPlatform(id: string): SocialPlatform | undefined {
  return byId.get(id);
}

export function hostMatches(hostname: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const h = hostname.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

/**
 * The destination of a social item, or null. One rule for the block
 * schema, the renderer and the `/go` redirect: the link-destination syntax
 * (`parseLinkUrl`; a missing scheme becomes https), exactly `https:`, no
 * credentials, and a host on the platform's allow-list. Only an intentionally
 * empty list (Mastodon, Website) accepts any valid https host.
 */
export function socialDestination(platformId: string, raw: string): URL | null {
  const platform = getSocialPlatform(platformId);
  if (!platform) return null;
  const url = parseLinkUrl(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password) return null;
  return hostMatches(url.hostname, platform.hosts) ? url : null;
}

/** The link's accessible name: "Instagram profile", or just "Website". */
export function socialLinkName(platform: SocialPlatform): string {
  return platform.id === "website" ? platform.label : `${platform.label} profile`;
}
