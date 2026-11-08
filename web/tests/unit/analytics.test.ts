import { getIPFromHeader } from "@better-auth/core/utils/ip";
import jsQR from "jsqr";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import {
  browserFamily,
  deviceCategory,
  isBot,
  isPrefetch,
  parseSource,
  referrerHost,
  userAgentClass,
} from "@/features/analytics/classify";
import { clickThroughRate, fillDaily, formatRate, totals, visitorAvailability } from "@/features/analytics/metrics";
import { qrFileName, qrSvg, qrTargetUrl } from "@/features/analytics/qr";
import { parseDay, presetRange, rangeDays, resolveRange } from "@/features/analytics/range";
import { newSalt, visitorHash } from "@/features/analytics/visitor";
import { createDefaultDocument } from "@/features/profiles/document";
import { TRUSTED_IP_HEADERS, trustedClientAddress } from "@/lib/security/client-address";
import { parseArgs, resolveRetention, RETENTION_MAX, RETENTION_MIN, UsageError } from "../../scripts/analytics-purge-core.mjs";

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:139.0) Gecko/20100101 Firefox/139.0",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  safariIpad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  androidPhone: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
};

describe("trusted client address (C1)", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("reads nothing unless TRUST_PROXY is on, and never falls back to a placeholder", () => {
    expect(trustedClientAddress(h({ "x-forwarded-for": "203.0.113.7" }), false)).toBeNull();
    expect(trustedClientAddress(h({}), true)).toBeNull();
    expect(trustedClientAddress(h({}), false)).toBeNull();
  });

  it("uses the same headers as Better Auth's rate limiter, in order", () => {
    expect([...TRUSTED_IP_HEADERS]).toEqual(["x-forwarded-for", "x-real-ip"]);
    expect(trustedClientAddress(h({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.1" }), true)).toBe("203.0.113.7");
    expect(trustedClientAddress(h({ "x-forwarded-for": "not-an-ip", "x-real-ip": "198.51.100.1" }), true)).toBe("198.51.100.1");
  });

  it("matches Better Auth's getIPFromHeader for single values, lists, IPv6 and mapped addresses", () => {
    const corpus = [
      "203.0.113.7",
      " 203.0.113.7 ",
      "203.0.113.7, 10.0.0.1",
      "203.0.113.7,",
      "",
      "999.1.1.1",
      "2001:db8:abcd:12:3456:789a:bcde:f012",
      "2001:DB8::1",
      "::1",
      "::",
      "::ffff:192.0.2.128",
      "0:0:0:0:0:ffff:c000:280",
      "fe80::1%eth0",
      "2001:db8::192.0.2.1",
      "1.2.3",
      "unknown",
    ];
    for (const value of corpus) {
      expect(trustedClientAddress(h({ "x-forwarded-for": value }), true), value).toBe(getIPFromHeader(value));
    }
  });
});

describe("visitor hash and salts (C2)", () => {
  const base = { salt: newSalt(), address: "203.0.113.7", uaClass: "desktop:chrome", profileId: "00000000-0000-4000-8000-000000000001" };

  it("is a canonical SHA-256 hex digest, stable for the same inputs", () => {
    expect(visitorHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(visitorHash(base)).toBe(visitorHash({ ...base }));
  });

  it("changes with each input (salt, address, user-agent class, profile)", () => {
    const h0 = visitorHash(base);
    for (const change of [{ salt: newSalt() }, { address: "203.0.113.8" }, { uaClass: "mobile:chrome" }, { profileId: "00000000-0000-4000-8000-000000000002" }]) {
      expect(visitorHash({ ...base, ...change })).not.toBe(h0);
    }
  });

  it("separates inputs so neighbouring values can't run together", () => {
    expect(visitorHash({ ...base, address: "1.2.3.4", uaClass: "5:x" })).not.toBe(visitorHash({ ...base, address: "1.2.3.45", uaClass: ":x" }));
  });

  it("salts are 32 random bytes, base64url, matching the database check", () => {
    const salts = new Set(Array.from({ length: 50 }, newSalt));
    expect(salts.size).toBe(50);
    for (const s of salts) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("request classification (C5, C7)", () => {
  it("classifies devices coarsely", () => {
    expect(deviceCategory(UA.chromeWin)).toBe("desktop");
    expect(deviceCategory(UA.firefoxMac)).toBe("desktop");
    expect(deviceCategory(UA.safariIphone)).toBe("mobile");
    expect(deviceCategory(UA.androidPhone)).toBe("mobile");
    expect(deviceCategory(UA.safariIpad)).toBe("tablet");
    expect(deviceCategory(UA.androidTablet)).toBe("tablet");
    expect(deviceCategory("SomethingElse/1.0")).toBe("unknown");
    expect(deviceCategory(null)).toBe("unknown");
  });

  it("classifies browser families, and the hash class combines both", () => {
    expect(browserFamily(UA.chromeWin)).toBe("chrome");
    expect(browserFamily(UA.edgeWin)).toBe("edge");
    expect(browserFamily(UA.firefoxMac)).toBe("firefox");
    expect(browserFamily(UA.safariIphone)).toBe("safari");
    expect(browserFamily(UA.samsung)).toBe("samsung");
    expect(browserFamily("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 OPR/120.0")).toBe("opera");
    expect(userAgentClass(UA.safariIphone)).toBe("mobile:safari");
  });

  it("treats missing, oversized and known automated user agents as bots", () => {
    for (const ua of [
      null,
      "",
      "x".repeat(513),
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "facebookexternalhit/1.1",
      "Slackbot-LinkExpanding 1.0",
      "curl/8.9.1",
      "Wget/1.24",
      "python-requests/2.32",
      "Go-http-client/2.0",
      "node-fetch",
      "undici",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0) Chrome-Lighthouse",
    ]) {
      expect(isBot(ua), String(ua).slice(0, 40)).toBe(true);
    }
    for (const ua of Object.values(UA)) expect(isBot(ua), ua).toBe(false);
  });

  it("detects prefetch and prerender requests", () => {
    const cases: Record<string, string>[] = [{ "sec-purpose": "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { purpose: "prefetch" }, { "x-purpose": "preview" }, { "x-moz": "prefetch" }];
    for (const init of cases) {
      expect(isPrefetch(new Headers(init)), JSON.stringify(init)).toBe(true);
    }
    expect(isPrefetch(new Headers({ "sec-fetch-mode": "navigate" }))).toBe(false);
  });

  it("keeps only a normalized, bounded referrer hostname", () => {
    expect(referrerHost("https://www.Example.com/path?q=secret#x", "links.test")).toBe("www.example.com");
    expect(referrerHost("http://news.example.org.", "links.test")).toBe("news.example.org");
    expect(referrerHost("https://xn--bcher-kva.example/", "links.test")).toBe("xn--bcher-kva.example");
    expect(referrerHost("https://bücher.example/", "links.test")).toBe("xn--bcher-kva.example");
    expect(referrerHost("https://links.test/alice", "links.test")).toBeNull(); // internal
    for (const bad of [undefined, null, "", "not a url", "javascript:alert(1)", "data:text/html,x", "ftp://files.example.com/", "https://[2001:db8::1]/", `https://${"a".repeat(250)}.com/`, `https://e.com/${"x".repeat(2100)}`]) {
      expect(referrerHost(bad, "links.test"), String(bad).slice(0, 30)).toBeNull();
    }
  });

  it("accepts only allowlisted sources", () => {
    expect(parseSource("qr")).toBe("qr");
    for (const bad of ["QR", "qr ", "email", "", null, 1, { s: "qr" }]) expect(parseSource(bad)).toBeNull();
  });
});

describe("metrics", () => {
  it("CTR is clicks ÷ views, undefined with no views", () => {
    expect(clickThroughRate(3, 12)).toBe(0.25);
    expect(clickThroughRate(5, 0)).toBeNull();
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0.25)).toBe("25.0%");
    expect(formatRate(1.5)).toBe("150.0%");
  });

  it("labels visitor availability from hashed and unhashed views", () => {
    expect(visitorAvailability(0, 0)).toBe("none");
    expect(visitorAvailability(10, 0)).toBe("approximate");
    expect(visitorAvailability(10, 3)).toBe("partial");
    expect(visitorAvailability(10, 10)).toBe("unavailable");
  });

  it("fills every day and sums daily visitors", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03"];
    const daily = fillDaily(days, [
      { day: "2026-11-01", views: 4, clicks: 1, visitors: 2, viewsWithoutHash: 0 },
      { day: "2026-11-03", views: 2, clicks: 3, visitors: 2, viewsWithoutHash: 1 },
    ]);
    expect(daily.map((d) => d.day)).toEqual(days);
    expect(daily[1]).toEqual({ day: "2026-11-02", views: 0, clicks: 0, visitors: 0, viewsWithoutHash: 0 });
    expect(totals(daily)).toEqual({ views: 6, clicks: 4, ctr: 4 / 6, visitors: 4, viewsWithoutHash: 1, visitorAvailability: "partial" });
  });
});

describe("ranges (C8)", () => {
  const now = new Date("2026-11-02T23:59:59.999Z");
  const ctx = { now, retentionDays: 395 };

  it("presets cover today and the N − 1 days before, as [start, end)", () => {
    const r = presetRange(7, ctx);
    expect([r.from, r.to, r.days]).toEqual(["2026-10-27", "2026-11-02", 7]);
    expect(r.start.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(rangeDays(r)).toHaveLength(7);
    expect(resolveRange({}, ctx)).toMatchObject({ ok: true, range: { days: 30, preset: 30 } });
    expect(resolveRange({ range: "90" }, ctx)).toMatchObject({ ok: true, range: { days: 90, from: "2026-08-05" } });
  });

  it("caps presets at the retention period", () => {
    expect(resolveRange({ range: "90" }, { now, retentionDays: 30 })).toMatchObject({ ok: true, range: { days: 30, capped: true, preset: 90 } });
  });

  it("validates custom ranges and falls back to 30 days with a message", () => {
    expect(resolveRange({ from: "2026-10-01", to: "2026-10-01" }, ctx)).toMatchObject({ ok: true, range: { days: 1, preset: null } });
    for (const input of [
      { range: "14" },
      { range: "7.0" },
      { from: "2026-10-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-10-05", to: "2026-10-01" },
      { from: "2026-10-01", to: "2026-11-03" },
      { from: "2025-10-01", to: "2025-10-02" },
      { from: "01/10/2026", to: "2026-10-02" },
    ]) {
      const r = resolveRange(input, ctx);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      expect(r.range.days).toBe(30);
    }
    // The oldest retained day (today − 394 for 395 days) is allowed; the day before isn't.
    expect(resolveRange({ from: "2025-10-04", to: "2025-10-05" }, ctx).ok).toBe(true);
    expect(resolveRange({ from: "2025-10-03", to: "2025-10-05" }, ctx).ok).toBe(false);
    expect(resolveRange({ from: "2025-09-30", to: "2026-11-02" }, { now, retentionDays: 3650 })).toMatchObject({ ok: true, range: { days: 399 } });
    expect(resolveRange({ from: "2025-09-28", to: "2026-11-02" }, { now, retentionDays: 3650 })).toMatchObject({ ok: false, error: "Choose at most 400 days." });
  });

  it("parses only real calendar dates", () => {
    expect(parseDay("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    for (const bad of ["2026-02-29", "2026-13-01", "2026-1-01", "", undefined]) expect(parseDay(bad)).toBeNull();
  });
});

describe("QR code", () => {
  it("targets APP_URL/{handle}?src=qr and refuses invalid handles", () => {
    expect(qrTargetUrl("https://links.example.com", "alice")).toBe("https://links.example.com/alice?src=qr");
    expect(qrTargetUrl("https://links.example.com/", "a_b-1")).toBe("https://links.example.com/a_b-1?src=qr");
    expect(() => qrTargetUrl("https://links.example.com", "admin")).toThrow();
    expect(() => qrTargetUrl("https://links.example.com", "../x")).toThrow();
    expect(qrFileName("alice")).toBe("covalink-alice-qr.svg");
  });

  it("is a plain SVG that an independent decoder (jsQR) reads back exactly", async () => {
    const target = qrTargetUrl("https://links.example.com", "alice");
    const svg = qrSvg(target);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toMatch(/<script|on\w+=|href=|<foreignObject|<style/i);
    const { data, info } = await sharp(Buffer.from(svg)).resize(480, 480, { kernel: "nearest" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
    expect(decoded?.data).toBe(target);
  });
});

describe("public link rendering", () => {
  const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const PROFILE = "11111111-1111-4111-8111-111111111111";
  const doc = (newTab = false): ViewDocument => {
    const d = createDefaultDocument("Alice");
    return {
      ...d,
      settings: { ...d.settings, openLinksInNewTab: newTab },
      blocks: [
        { id: ID(1), type: "link", version: 2, visible: true, config: { title: "Shop", url: "https://shop.example.com/" } },
        { id: ID(2), type: "text", version: 1, visible: true, config: { markdown: "[ok](https://ok.example.com)", align: "inherit" } },
      ],
    } as ViewDocument;
  };
  const render = (props: Partial<Parameters<typeof ProfileView>[0]>) =>
    renderToStaticMarkup(createElement(ProfileView, { document: doc(), verified: false, mode: "public", ...props }));

  it("routes published link blocks through /go, keeping rel and target", () => {
    expect(render({ clickTrackingProfileId: PROFILE })).toContain(`<a class="pp-btn" href="/go/${PROFILE}/${ID(1)}" rel="noopener nofollow ugc">`);
    expect(renderToStaticMarkup(createElement(ProfileView, { document: doc(true), verified: false, mode: "public", clickTrackingProfileId: PROFILE }))).toContain(
      `href="/go/${PROFILE}/${ID(1)}" target="_blank" rel="noopener noreferrer nofollow ugc"`,
    );
  });

  it("keeps Markdown links and the editor preview direct", () => {
    const pub = render({ clickTrackingProfileId: PROFILE });
    expect(pub).toContain('<a href="https://ok.example.com/" rel="noopener nofollow ugc">ok</a>');
    const preview = render({ mode: "preview", clickTrackingProfileId: PROFILE });
    expect(preview).toContain('href="https://shop.example.com/"');
    expect(preview).not.toContain("/go/");
  });
});

describe("analytics:purge configuration", () => {
  it("uses the stored setting when valid, then ANALYTICS_RETENTION_DAYS, then 395", () => {
    expect(resolveRetention(30, "90")).toEqual({ days: 30, from: "setting" });
    expect(resolveRetention(0, "90")).toEqual({ days: 90, from: "ANALYTICS_RETENTION_DAYS" });
    expect(resolveRetention("30", undefined)).toEqual({ days: 395, from: "default" });
    expect(resolveRetention(undefined, "")).toEqual({ days: 395, from: "default" });
    for (const bad of ["0", "3651", "1e3", "-5", "12.5", "abc"]) expect(() => resolveRetention(undefined, bad), bad).toThrow(UsageError);
  });

  it("has the same bounds as the analytics.retentionDays setting and the environment schema", async () => {
    const { envSchema } = await import("@/lib/env");
    const shape = envSchema.shape.ANALYTICS_RETENTION_DAYS;
    expect(shape.safeParse(String(RETENTION_MIN)).success).toBe(true);
    expect(shape.safeParse(String(RETENTION_MAX)).success).toBe(true);
    expect(shape.safeParse(String(RETENTION_MAX + 1)).success).toBe(false);
    expect(shape.safeParse("0").success).toBe(false);
  });

  it("accepts only --dry-run", () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(() => parseArgs(["--all"])).toThrow(UsageError);
  });
});
