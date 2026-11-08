/**
 * Pure request classification for analytics ingestion. Every input
 * here is transient request data: user agents and referrer URLs are inspected
 * and reduced to a few coarse values, and are never stored or logged.
 */

export const DEVICES = ["mobile", "tablet", "desktop", "unknown"] as const;
export type Device = (typeof DEVICES)[number];

export const BROWSER_FAMILIES = ["samsung", "opera", "edge", "firefox", "chrome", "safari", "other"] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

/** Longest user agent considered at all; longer ones are treated as automated. */
export const MAX_USER_AGENT = 512;

/**
 * Device category from the user agent. iPadOS 13+ presents a desktop Safari
 * user agent by default and is therefore counted as desktop.
 */
export function deviceCategory(userAgent: string | null): Device {
  if (!userAgent) return "unknown";
  if (/iPad|Tablet|PlayBook|Silk\/|Kindle|Android(?!.*Mobi)/i.test(userAgent)) return "tablet";
  if (/Mobi|iPhone|iPod|Windows Phone|IEMobile|Opera Mini|BlackBerry|BB10/i.test(userAgent)) return "mobile";
  if (/Windows NT|Macintosh|X11|CrOS|Linux x86_64/i.test(userAgent)) return "desktop";
  return "unknown";
}

export function browserFamily(userAgent: string | null): BrowserFamily {
  if (!userAgent) return "other";
  if (/SamsungBrowser\//.test(userAgent)) return "samsung";
  if (/OPR\/|Opera[ /]|OPiOS\//.test(userAgent)) return "opera";
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "firefox";
  if (/Chrome\/|CriOS\/|Chromium\//.test(userAgent)) return "chrome";
  if (/Version\/[\d.]+.*Safari\//.test(userAgent)) return "safari";
  return "other";
}

/** The coarse user-agent class mixed into the visitor hash: device + browser family. */
export function userAgentClass(userAgent: string | null): string {
  return `${deviceCategory(userAgent)}:${browserFamily(userAgent)}`;
}

/**
 * Known crawlers, link-preview fetchers, monitors, headless browsers and HTTP
 * libraries. Deliberately incomplete: it removes trivial automated traffic,
 * not every bot (a bot sending a browser user agent is counted).
 */
const BOT_PATTERN =
  /bot\b|bot\/|crawl|spider|slurp|archiver|scrap|preview|facebookexternalhit|embedly|quora link|vkshare|w3c_validator|headless|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|statuscake|datadog|newrelic|curl\/|wget\/|httpie|python|aiohttp|go-http-client|okhttp|java\/|apache-httpclient|libwww|node-fetch|undici|axios|got \(|postman|insomnia|feedfetcher|feedburner/i;

export function isBot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.length > MAX_USER_AGENT) return true;
  return BOT_PATTERN.test(userAgent);
}

/** Speculative loads (prefetch, prerender, link previews), which aren't visits. */
export function isPrefetch(headers: Headers): boolean {
  const purpose = `${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`.toLowerCase();
  if (/prefetch|prerender/.test(purpose)) return true;
  if ((headers.get("x-purpose") ?? "").toLowerCase() === "preview") return true;
  return (headers.get("x-moz") ?? "").toLowerCase() === "prefetch";
}

export const MAX_REFERRER_INPUT = 2048;
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * The referring site's hostname: http(s) only, lowercased, no trailing dot,
 * DNS characters only, at most 253 characters. COVALink's own host (internal
 * navigation) and anything unparseable give `null` ("direct or unknown").
 * The rest of the URL (path, query) is discarded here.
 */
export function referrerHost(raw: string | null | undefined, appHost: string): string | null {
  if (!raw || raw.length > MAX_REFERRER_INPUT) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || !HOSTNAME.test(host)) return null;
  return host === appHost.toLowerCase() ? null : host;
}

/** Traffic sources a beacon may report. Anything else is ignored (stored as no source). */
export const SOURCES = ["qr"] as const;
export type Source = (typeof SOURCES)[number];

export function parseSource(raw: unknown): Source | null {
  return typeof raw === "string" && (SOURCES as readonly string[]).includes(raw) ? (raw as Source) : null;
}
