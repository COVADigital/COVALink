import { hasControlChars } from "./contact-points";

/**
 * The single source of video and music provider rules. One
 * function maps a pasted link to a provider's canonical URL and player
 * attributes, or to nothing. Only values checked here reach an iframe `src`,
 * never the raw input, and no HTML is ever parsed. The URL's shape is matched
 * on the raw string, not through `new URL`, which would quietly accept a `:443`
 * port, `..` segments and percent-encoded hosts. Pure and isomorphic.
 */
export type EmbedProvider = "youtube" | "vimeo" | "spotify" | "soundcloud";
export type EmbedKind = "video" | "music";

export interface EmbedInfo {
  provider: EmbedProvider;
  kind: EmbedKind;
  /** What is stored and what the Open link points at. */
  canonicalUrl: string;
  frameSrc: string;
  /** The `allow` attribute; empty when nothing is delegated. Autoplay never is. */
  allow: string;
  /** The player box: 16:9, or a fixed height in px. */
  box: "16:9" | 152 | 166 | 300 | 352;
  /** The provider's name, for "Open on {label}" and the notice. */
  label: string;
  /** The accessible name when the owner gave no title. */
  defaultTitle: string;
}

/** The public route's `frame-src`. Every generated `frameSrc` starts with one of these. */
export const EMBED_FRAME_SOURCES = [
  "https://www.youtube-nocookie.com/embed/",
  "https://player.vimeo.com/video/",
  "https://open.spotify.com/embed/",
  "https://w.soundcloud.com/player/",
] as const;

/** `allow-top-navigation` in any form is never granted. */
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
export const EMBED_REFERRER_POLICY = "strict-origin-when-cross-origin";

export const EMBED_URL_MAX_LENGTH = 2048;

const URL_SHAPE = /^https:\/\/([a-z0-9.-]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;

type Parts = { host: string; path: string; query: string };

/** Refuses control characters before trimming, backslashes, credentials and ports. */
function urlParts(raw: string): Parts | null {
  if (raw.length > EMBED_URL_MAX_LENGTH || hasControlChars(raw) || raw.includes("\\")) return null;
  const m = URL_SHAPE.exec(raw.trim());
  return m ? { host: m[1].toLowerCase(), path: m[2] ?? "/", query: m[3] ?? "" } : null;
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** `v` must appear exactly once, and literally: an encoded form is refused like an encoded path. */
function youtubeWatchId(query: string): string | null {
  const values = new URLSearchParams(query).getAll("v");
  return values.length === 1 && query.split("&").includes(`v=${values[0]}`) ? values[0] : null;
}

function youtube({ host, path, query }: Parts): EmbedInfo | null {
  let id: string | null | undefined = null;
  if (host === "youtu.be") id = path.slice(1);
  else if (YOUTUBE_HOSTS.has(host)) id = path === "/watch" ? youtubeWatchId(query) : /^\/(?:embed|shorts|live)\/([^/]+)$/.exec(path)?.[1];
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return {
    provider: "youtube",
    kind: "video",
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    frameSrc: `https://www.youtube-nocookie.com/embed/${id}`,
    allow: "encrypted-media; fullscreen",
    box: "16:9",
    label: "YouTube",
    defaultTitle: "YouTube video",
  };
}

const VIMEO_ID = "[0-9]{6,12}";
const VIMEO_PAGE_PATH = new RegExp(`^/(${VIMEO_ID})$`);
const VIMEO_PLAYER_PATH = new RegExp(`^/video/(${VIMEO_ID})$`);

/** An unlisted video's `h` can't be kept (out of scope), and dropping it would build a broken player. */
function vimeo({ host, path, query }: Parts): EmbedInfo | null {
  if (new URLSearchParams(query).has("h")) return null;
  const pattern = host === "vimeo.com" || host === "www.vimeo.com" ? VIMEO_PAGE_PATH : host === "player.vimeo.com" ? VIMEO_PLAYER_PATH : null;
  const id = pattern?.exec(path)?.[1];
  if (!id) return null;
  return {
    provider: "vimeo",
    kind: "video",
    canonicalUrl: `https://vimeo.com/${id}`,
    frameSrc: `https://player.vimeo.com/video/${id}?dnt=1`,
    allow: "encrypted-media; fullscreen",
    box: "16:9",
    label: "Vimeo",
    defaultTitle: "Vimeo video",
  };
}

const SPOTIFY_PATH = /^\/(?:intl-[a-z]{2,3}(?:-[a-z]{2,4})?\/)?(?:embed\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})$/;

function spotify({ host, path }: Parts): EmbedInfo | null {
  if (host !== "open.spotify.com") return null;
  const m = SPOTIFY_PATH.exec(path);
  if (!m) return null;
  const [, kind, id] = m;
  return {
    provider: "spotify",
    kind: "music",
    canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
    frameSrc: `https://open.spotify.com/embed/${kind}/${id}`,
    allow: "encrypted-media",
    box: kind === "track" || kind === "episode" ? 152 : 352,
    label: "Spotify",
    defaultTitle: "Spotify player",
  };
}

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);
const SOUNDCLOUD_SEGMENT = "[A-Za-z0-9_-]{1,100}";
const SOUNDCLOUD_PATH = new RegExp(`^/(${SOUNDCLOUD_SEGMENT})/(?:(sets)/)?(${SOUNDCLOUD_SEGMENT})$`);
/** Tabs of a user's page, which share the `/{user}/{track}` shape but aren't tracks. */
const SOUNDCLOUD_USER_TABS = new Set(["sets", "tracks", "albums", "popular-tracks", "reposts", "likes", "followers", "following", "comments", "spotlight"]);

function soundcloud({ host, path }: Parts): EmbedInfo | null {
  if (!SOUNDCLOUD_HOSTS.has(host)) return null;
  const m = SOUNDCLOUD_PATH.exec(path);
  if (!m) return null;
  const [, user, sets, name] = m;
  if (!sets && SOUNDCLOUD_USER_TABS.has(name)) return null;
  const canonicalUrl = `https://soundcloud.com/${user}/${sets ? "sets/" : ""}${name}`;
  return {
    provider: "soundcloud",
    kind: "music",
    canonicalUrl,
    frameSrc: `https://w.soundcloud.com/player/?url=${encodeURIComponent(canonicalUrl)}&auto_play=false&visual=false&show_comments=false`,
    allow: "",
    box: sets ? 300 : 166,
    label: "SoundCloud",
    defaultTitle: "SoundCloud player",
  };
}

function parseAnyEmbed(raw: string): EmbedInfo | null {
  const parts = urlParts(raw);
  return parts && (youtube(parts) ?? vimeo(parts) ?? spotify(parts) ?? soundcloud(parts));
}

/** The provider details of a link, or null unless it's an accepted link of this block kind. */
export function parseEmbed(raw: string, kind: EmbedKind): EmbedInfo | null {
  const embed = parseAnyEmbed(raw);
  return embed?.kind === kind ? embed : null;
}

const SHORTENER_HOSTS = new Set(["on.soundcloud.com", "spotify.link", "spoti.fi", "soundcloud.app.goo.gl", "goo.gl"]);
const ACCEPTED: Record<EmbedKind, string> = {
  video: "Paste a YouTube or Vimeo link that starts with https://, like https://youtu.be/… or https://vimeo.com/…",
  music: "Paste a Spotify or SoundCloud link that starts with https://, like https://open.spotify.com/track/… or https://soundcloud.com/artist/track",
};

/** Why a link was refused, in the owner's terms. */
export function embedUrlProblem(raw: string, kind: EmbedKind): string {
  if (raw.includes("<")) return "Paste the link itself, not embed code. Copy the address from your browser.";
  const other = parseAnyEmbed(raw);
  if (other && other.kind !== kind) return `That's a ${other.label} link. Use a ${other.kind === "video" ? "Video" : "Music"} block for it.`;
  const parts = urlParts(raw);
  if (parts) {
    if (SHORTENER_HOSTS.has(parts.host)) return "Short links can't be used. Open the link, then paste the full address.";
    if (parts.host.endsWith("vimeo.com") && (new URLSearchParams(parts.query).has("h") || /^\/[0-9]+\/[^/]+$/.test(parts.path))) {
      return "Unlisted Vimeo videos can't be embedded. Use a public video link.";
    }
    if (SOUNDCLOUD_HOSTS.has(parts.host) && /\/s-[^/]+$/.test(parts.path)) return "Private SoundCloud links can't be embedded. Use a public link.";
  }
  return ACCEPTED[kind];
}

/** The iframe's attributes; the caller adds its title. */
export function embedFrameAttributes(embed: EmbedInfo) {
  return { src: embed.frameSrc, allow: embed.allow || undefined, sandbox: EMBED_SANDBOX, referrerPolicy: EMBED_REFERRER_POLICY } as const;
}
