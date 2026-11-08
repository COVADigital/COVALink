import { readdirSync } from "node:fs";
import path from "node:path";
// @ts-expect-error -- Next.js ships this compiled package without types.
import { pathToRegexp as untypedPathToRegexp } from "next/dist/compiled/path-to-regexp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createItem, itemLabel, toEditorItems, toViewBlocks, validateItem, type EditableItem } from "@/components/editor/block-items";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import { parseBlock, type Block } from "@/features/blocks/block";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS } from "@/features/blocks/definitions";
import { EMBED_FRAME_SOURCES, EMBED_SANDBOX, embedFrameAttributes, embedUrlProblem, parseEmbed, type EmbedInfo, type EmbedKind } from "@/features/blocks/embeds";
import { assessStoredBlocks, resolveBlockList } from "@/features/blocks/input";
import { createDefaultDocument } from "@/features/profiles/document";
import { isValidHandle, RESERVED_HANDLES } from "@/features/profiles/handle";
import { themeContrastIssues } from "@/features/themes/contrast";
import { THEME_PRESETS } from "@/features/themes/presets";
import { contentSecurityPolicy, PAGE_HEADERS_SOURCE, PROFILE_HEADERS_SOURCE, profileSecurityHeaders, securityHeaders, TOKEN_PAGE_HEADERS_SOURCE, VCARD_HEADERS_SOURCE } from "@/lib/security/headers";

/**
 * Video and music embeds: the exact provider allowlists,
 * adversarial refusals, block contract v2 and legacy v1 reads, the shared
 * click-to-load renderer, the CSP split and the route inventory.
 */

const pathToRegexp = untypedPathToRegexp as (path: string, keys?: unknown[], options?: object) => RegExp;
// Compiled the way Next.js compiles `headers()` sources (lib/build-custom-route.js).
const NEXT_SOURCE_OPTIONS = { strict: true, sensitive: false, delimiter: "/" };
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const YT = "dQw4w9WgXcQ";
const SP = "4uLU6hMCjMI75M1A2tKUQC";
const VIDEO_YT = `https://www.youtube.com/watch?v=${YT}`;
const MUSIC_SP = `https://open.spotify.com/track/${SP}`;
const CONTROLS = [0x0d, 0x0a, 0x09, 0x00, 0x7f, 0x85, 0x1b, 0x2028, 0x2029].map((c) => String.fromCharCode(c));

describe("provider allowlists", () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT}`],
    [`https://youtube.com/watch?v=${YT}`],
    [`https://m.youtube.com/watch?v=${YT}`],
    [`https://www.youtube.com/watch?v=${YT}&t=30s&list=PL123#frag`],
    [`https://www.youtube.com/watch?list=PL123&v=${YT}`],
    [`https://youtu.be/${YT}`],
    [`https://youtu.be/${YT}?si=abc`],
    [`https://www.youtube.com/embed/${YT}`],
    [`https://www.youtube.com/shorts/${YT}`],
    [`https://www.youtube.com/live/${YT}`],
    [`https://youtube-nocookie.com/embed/${YT}`],
    [`https://www.youtube-nocookie.com/embed/${YT}`],
    [`HTTPS://WWW.YOUTUBE.COM/watch?v=${YT}`],
    [`  https://youtu.be/${YT}  `],
  ])("YouTube accepts %s and canonicalizes it", (url) => {
    expect(parseEmbed(url, "video")).toEqual({
      provider: "youtube",
      kind: "video",
      canonicalUrl: VIDEO_YT,
      frameSrc: `https://www.youtube-nocookie.com/embed/${YT}`,
      allow: "encrypted-media; fullscreen",
      box: "16:9",
      label: "YouTube",
      defaultTitle: "YouTube video",
    });
  });

  it.each([["https://vimeo.com/76979871"], ["https://www.vimeo.com/76979871"], ["https://player.vimeo.com/video/76979871"], ["https://player.vimeo.com/video/76979871?dnt=1#t=5"], ["https://vimeo.com/76979871?share=copy"]])(
    "Vimeo accepts %s and canonicalizes it",
    (url) => {
      expect(parseEmbed(url, "video")).toEqual({
        provider: "vimeo",
        kind: "video",
        canonicalUrl: "https://vimeo.com/76979871",
        frameSrc: "https://player.vimeo.com/video/76979871?dnt=1",
        allow: "encrypted-media; fullscreen",
        box: "16:9",
        label: "Vimeo",
        defaultTitle: "Vimeo video",
      });
    },
  );

  it.each([
    [`https://open.spotify.com/track/${SP}`, "track", 152],
    [`https://open.spotify.com/track/${SP}?si=abc`, "track", 152],
    [`https://open.spotify.com/embed/track/${SP}`, "track", 152],
    [`https://open.spotify.com/intl-de/track/${SP}`, "track", 152],
    [`https://open.spotify.com/intl-pt-BR/embed/track/${SP}`.replace("pt-BR", "pt-br"), "track", 152],
    [`https://open.spotify.com/episode/${SP}`, "episode", 152],
    [`https://open.spotify.com/album/${SP}`, "album", 352],
    [`https://open.spotify.com/playlist/${SP}`, "playlist", 352],
    [`https://open.spotify.com/artist/${SP}`, "artist", 352],
    [`https://open.spotify.com/show/${SP}`, "show", 352],
  ] as const)("Spotify accepts %s", (url, kind, box) => {
    expect(parseEmbed(url, "music")).toEqual({
      provider: "spotify",
      kind: "music",
      canonicalUrl: `https://open.spotify.com/${kind}/${SP}`,
      frameSrc: `https://open.spotify.com/embed/${kind}/${SP}`,
      allow: "encrypted-media",
      box,
      label: "Spotify",
      defaultTitle: "Spotify player",
    });
  });

  it.each([
    ["https://soundcloud.com/forss/flickermood", "forss/flickermood", 166],
    ["https://www.soundcloud.com/forss/flickermood", "forss/flickermood", 166],
    ["https://m.soundcloud.com/forss/flickermood?utm_source=x", "forss/flickermood", 166],
    ["https://soundcloud.com/forss/sets/soulhack", "forss/sets/soulhack", 300],
  ] as const)("SoundCloud accepts %s", (url, canonical, box) => {
    const canonicalUrl = `https://soundcloud.com/${canonical}`;
    expect(parseEmbed(url, "music")).toEqual({
      provider: "soundcloud",
      kind: "music",
      canonicalUrl,
      frameSrc: `https://w.soundcloud.com/player/?url=${encodeURIComponent(canonicalUrl)}&auto_play=false&visual=false&show_comments=false`,
      allow: "",
      box,
      label: "SoundCloud",
      defaultTitle: "SoundCloud player",
    });
  });

  const REFUSED: [string, EmbedKind, string][] = [
    ["host suffix", "video", `https://youtube.com.evil.example/watch?v=${YT}`],
    ["host in the path", "video", `https://evil.example/youtube.com/watch?v=${YT}`],
    ["host in the query", "video", `https://evil.example/?u=https://youtube.com/watch?v=${YT}`],
    ["other subdomain", "video", `https://music.youtube.com/watch?v=${YT}`],
    ["trailing-dot host", "video", `https://youtube.com./watch?v=${YT}`],
    ["credentials", "video", `https://user:pw@youtube.com/watch?v=${YT}`],
    ["username only", "video", `https://youtube.com@evil.example/watch?v=${YT}`],
    ["port", "video", `https://youtube.com:8443/watch?v=${YT}`],
    ["default port", "video", `https://youtube.com:443/watch?v=${YT}`],
    ["http", "video", `http://www.youtube.com/watch?v=${YT}`],
    ["no scheme", "video", `www.youtube.com/watch?v=${YT}`],
    ["protocol-relative", "video", `//www.youtube.com/watch?v=${YT}`],
    ["scheme without slashes", "video", `https:www.youtube.com/watch?v=${YT}`],
    ["one slash", "video", `https:/www.youtube.com/watch?v=${YT}`],
    ["javascript:", "video", "javascript:alert(1)"],
    ["data:", "video", "data:text/html,<script>alert(1)</script>"],
    ["backslash host", "video", `https:\\\\www.youtube.com/watch?v=${YT}`],
    ["backslash path", "video", `https://youtube.com\\watch?v=${YT}`],
    ["encoded host", "video", `https://%79outube.com/watch?v=${YT}`],
    ["encoded ID", "video", `https://youtu.be/%64Qw4w9WgXcQ`],
    ["encoded ID in v", "video", `https://www.youtube.com/watch?v=%64Qw4w9WgXcQ`],
    ["encoded v key", "video", `https://www.youtube.com/watch?%76=${YT}`],
    ["encoded path", "video", `https://www.youtube.com/%65mbed/${YT}`],
    ["dot segments", "video", `https://www.youtube.com/x/../embed/${YT}`],
    ["repeated v", "video", `https://www.youtube.com/watch?v=${YT}&v=aaaaaaaaaaa`],
    ["no v", "video", "https://www.youtube.com/watch?list=PL123"],
    ["extra segment", "video", `https://www.youtube.com/embed/${YT}/extra`],
    ["trailing slash", "video", `https://youtu.be/${YT}/`],
    ["short ID", "video", "https://youtu.be/dQw4w9WgXc"],
    ["long ID", "video", "https://youtu.be/dQw4w9WgXcQQ"],
    ["bad ID character", "video", "https://youtu.be/dQw4w9WgXc!"],
    ["playlist page", "video", "https://www.youtube.com/playlist?list=PL123"],
    ["channel page", "video", "https://www.youtube.com/@creator"],
    ["bare ID on youtube.com", "video", `https://www.youtube.com/${YT}`],
    ["pasted iframe", "video", `<iframe src="https://www.youtube.com/embed/${YT}"></iframe>`],
    ["Vimeo short ID", "video", "https://vimeo.com/12345"],
    ["Vimeo long ID", "video", "https://vimeo.com/1234567890123"],
    ["Vimeo unlisted path", "video", "https://vimeo.com/76979871/abcdef1234"],
    ["Vimeo unlisted h", "video", "https://player.vimeo.com/video/76979871?h=abcdef1234"],
    ["Vimeo ID in another segment", "video", "https://vimeo.com/channels/staffpicks/76979871"],
    ["Vimeo player path on the page host", "video", "https://vimeo.com/video/76979871"],
    ["Vimeo page path on the player host", "video", "https://player.vimeo.com/76979871"],
    ["Spotify other host", "music", `https://spotify.com/track/${SP}`],
    ["Spotify short ID", "music", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ"],
    ["Spotify long ID", "music", `https://open.spotify.com/track/${SP}Q`],
    ["Spotify unknown kind", "music", `https://open.spotify.com/user/${SP}`],
    ["Spotify extra segment", "music", `https://open.spotify.com/track/${SP}/x`],
    ["Spotify URI", "music", `spotify:track:${SP}`],
    ["Spotify shortener", "music", "https://spotify.link/abc"],
    ["SoundCloud user page", "music", "https://soundcloud.com/forss"],
    ["SoundCloud user tab", "music", "https://soundcloud.com/forss/tracks"],
    ["SoundCloud user sets tab", "music", "https://soundcloud.com/forss/sets"],
    ["SoundCloud secret token", "music", "https://soundcloud.com/forss/flickermood/s-abc123"],
    ["SoundCloud secret set", "music", "https://soundcloud.com/forss/sets/soulhack/s-abc123"],
    ["SoundCloud shortener", "music", "https://on.soundcloud.com/abc"],
    ["SoundCloud bad character", "music", "https://soundcloud.com/forss/flicker.mood"],
    ["SoundCloud API URL", "music", "https://api.soundcloud.com/tracks/293"],
    ["SoundCloud segment too long", "music", `https://soundcloud.com/forss/${"a".repeat(101)}`],
    ["over 2048 characters", "video", `https://youtu.be/${YT}?x=${"a".repeat(2048)}`],
    ["empty", "video", ""],
  ];

  it.each(REFUSED)("refuses %s", (_label, kind, url) => {
    expect(parseEmbed(url, kind)).toBeNull();
    expect(BLOCK_INPUT_SCHEMAS[kind].safeParse({ url }).success).toBe(false);
  });

  it("refuses control characters anywhere, including ones trimming would remove", () => {
    for (const c of CONTROLS) {
      for (const url of [`${c}${VIDEO_YT}`, `${VIDEO_YT}${c}`, `https://youtu.be/${c}${YT}`]) {
        expect(parseEmbed(url, "video"), JSON.stringify(url)).toBeNull();
      }
    }
  });

  it("keeps each provider to its block kind", () => {
    expect(parseEmbed(VIDEO_YT, "music")).toBeNull();
    expect(parseEmbed("https://vimeo.com/76979871", "music")).toBeNull();
    expect(parseEmbed(MUSIC_SP, "video")).toBeNull();
    expect(parseEmbed("https://soundcloud.com/forss/flickermood", "video")).toBeNull();
  });

  it("explains refusals in the owner's terms", () => {
    expect(embedUrlProblem(`<iframe src="${VIDEO_YT}"></iframe>`, "video")).toMatch(/not embed code/);
    expect(embedUrlProblem(MUSIC_SP, "video")).toBe("That's a Spotify link. Use a Music block for it.");
    expect(embedUrlProblem(VIDEO_YT, "music")).toBe("That's a YouTube link. Use a Video block for it.");
    expect(embedUrlProblem("https://on.soundcloud.com/abc", "music")).toMatch(/Short links/);
    expect(embedUrlProblem("https://vimeo.com/76979871/abcdef", "video")).toMatch(/Unlisted Vimeo/);
    expect(embedUrlProblem("https://player.vimeo.com/video/76979871?h=abc", "video")).toMatch(/Unlisted Vimeo/);
    expect(embedUrlProblem("https://soundcloud.com/forss/track/s-abc", "music")).toMatch(/Private SoundCloud/);
    expect(embedUrlProblem("https://example.com/", "video")).toMatch(/YouTube or Vimeo/);
    expect(embedUrlProblem("", "music")).toMatch(/Spotify or SoundCloud/);
  });
});

describe("block contract v2 and legacy reads", () => {
  const stored = (type: "video" | "music", version: number, config: object, extra: object = {}) => ({ id: ID(1), type, version, visible: true, config, ...extra });

  it("is strict and canonicalizes on input", () => {
    const parsed = BLOCK_INPUT_SCHEMAS.video.parse({ url: `https://youtu.be/${YT}?si=x`, title: "  My video  " });
    expect(parsed).toEqual({ url: VIDEO_YT, title: "My video" });
    expect(BLOCK_INPUT_SCHEMAS.music.parse({ url: MUSIC_SP, title: "" })).toEqual({ url: MUSIC_SP, title: undefined });
    for (const type of ["video", "music"] as const) {
      const url = type === "video" ? VIDEO_YT : MUSIC_SP;
      expect(BLOCK_DEFINITIONS[type].version).toBe(2);
      expect(BLOCK_INPUT_SCHEMAS[type].safeParse({ url, version: 2 }).success, "client version").toBe(false);
      expect(BLOCK_INPUT_SCHEMAS[type].safeParse({ url, html: "<b>" }).success, "unknown key").toBe(false);
      expect(BLOCK_INPUT_SCHEMAS[type].safeParse({ url, title: "a".repeat(101) }).success, "long title").toBe(false);
      for (const c of CONTROLS) expect(BLOCK_INPUT_SCHEMAS[type].safeParse({ url, title: `a${c}b` }).success, "control character").toBe(false);
    }
  });

  it("reads a valid v1 block as v2, with no loss and a canonical URL", () => {
    const video = parseBlock(stored("video", 1, { url: `https://youtu.be/${YT}`, title: " Spaced " }));
    expect(video).toMatchObject({ success: true, block: { version: 2, config: { url: VIDEO_YT, title: "Spaced" } } });
    const music = parseBlock(stored("music", 1, { url: MUSIC_SP }));
    expect(music).toMatchObject({ success: true, block: { version: 2, config: { url: MUSIC_SP } } });
    expect(assessStoredBlocks([stored("video", 1, { url: VIDEO_YT })], [])).toMatchObject({ unreadable: 0, lossy: 0, protectedCount: 0 });
  });

  it.each([
    ["an http: URL", "video", { url: `http://www.youtube.com/watch?v=${YT}` }],
    ["a loose path", "video", { url: `https://www.youtube.com/embed/${YT}/extra` }],
    ["a Vimeo hash", "video", { url: "https://vimeo.com/76979871/abcdef" }],
    ["a SoundCloud user page", "music", { url: "https://soundcloud.com/forss" }],
    ["an unknown key", "video", { url: VIDEO_YT, startAt: 42 }],
    ["a control character", "video", { url: VIDEO_YT, title: "a\tb" }],
    ["a missing URL", "music", {}],
  ] as const)("treats a v1 block with %s as unreadable and protected", (_label, type, config) => {
    const raw = stored(type, 1, config);
    expect(parseBlock(raw).success).toBe(false);
    expect(assessStoredBlocks([raw], [])).toMatchObject({ unreadable: 1, protectedCount: 1 });
  });

  it("protects a readable block with an extra envelope key, and a newer version", () => {
    expect(assessStoredBlocks([stored("video", 2, { url: VIDEO_YT }, { pinned: true })], [])).toMatchObject({ lossy: 1, protectedCount: 1 });
    expect(assessStoredBlocks([stored("video", 3, { url: VIDEO_YT })], [])).toMatchObject({ unreadable: 1, protectedCount: 1 });
  });

  it("stamps version 2 and the canonical URL through the client list", () => {
    const r = resolveBlockList([{ id: ID(1), type: "video", visible: true, config: { url: `https://youtu.be/${YT}` } }], assessStoredBlocks([], []));
    expect(r).toMatchObject({ ok: true, write: [{ id: ID(1), type: "video", version: 2, config: { url: VIDEO_YT } }] });
    const bad = resolveBlockList([{ id: ID(1), type: "music", visible: true, config: { url: VIDEO_YT } }], assessStoredBlocks([], []));
    expect(bad).toMatchObject({ ok: false, errors: { items: [{ index: 0, id: ID(1), fields: { url: ["That's a YouTube link. Use a Video block for it."] } }] } });
  });
});

describe("shared renderer", () => {
  const block = (type: "video" | "music", config: object, visible = true) => ({ id: ID(1), type, version: 2, visible, config }) as unknown as Block;
  const render = (blocks: ViewDocument["blocks"], mode: "public" | "preview" = "public") => {
    const base = createDefaultDocument("Ana");
    return renderToStaticMarkup(createElement(ProfileView, { document: { ...base, blocks }, verified: false, mode }));
  };

  it("renders only local content before Load: no iframe and no provider resource", () => {
    for (const blocks of [[block("video", { url: VIDEO_YT, title: "My video" })], [block("music", { url: MUSIC_SP })]]) {
      for (const mode of ["public", "preview"] as const) {
        const html = render(blocks, mode);
        expect(html).not.toMatch(/<iframe/i);
        expect(html).not.toMatch(/<img|<script|<link/i);
        expect(html).not.toMatch(/(?:src|srcset|poster)=/i);
      }
    }
  });

  it("names the box and the Open link, which is outside the box and opens a new tab", () => {
    const html = render([block("video", { url: VIDEO_YT, title: "My video" })]);
    expect(html).toContain('role="group" aria-label="My video" data-box="16:9"');
    expect(html).toContain(
      `<a class="pp-embed-open" href="${VIDEO_YT}" target="_blank" rel="noopener nofollow ugc" aria-label="Open on YouTube: My video">Open on YouTube</a>`,
    );
    expect(html).toContain("Loads from YouTube, which can then collect data about you.");
    const box = html.slice(html.indexOf("pp-embed-box"), html.indexOf('<a class="pp-embed-open"'));
    expect(box.match(/<a /g)).toBeNull();
  });

  it("falls back to a provider name and reserves the right box", () => {
    expect(render([block("video", { url: "https://vimeo.com/76979871" })])).toContain('aria-label="Vimeo video" data-box="16:9"');
    expect(render([block("music", { url: MUSIC_SP })])).toContain('aria-label="Spotify player" data-box="152" style="min-height:152px"');
    expect(render([block("music", { url: `https://open.spotify.com/album/${SP}` })])).toContain('data-box="352" style="min-height:352px"');
    expect(render([block("music", { url: "https://soundcloud.com/forss/flickermood" })])).toContain('data-box="166" style="min-height:166px"');
    expect(render([block("music", { url: "https://soundcloud.com/forss/sets/soulhack" })])).toContain('data-box="300" style="min-height:300px"');
  });

  it("shows no inert Load control before hydration, and the note in the preview", () => {
    const pub = render([block("video", { url: VIDEO_YT })]);
    expect(pub).not.toContain("<button");
    expect(pub).not.toContain("Visitors can load");
    const preview = render([block("video", { url: VIDEO_YT })], "preview");
    expect(preview).not.toContain("<button");
    expect(preview).toContain("Visitors can load this player on your public page");
    expect(preview).toContain(`href="${VIDEO_YT}"`);
  });

  it("rebuilds everything through the parser: a tampered stored URL or an escape attempt never reaches an attribute", () => {
    for (const url of ["javascript:alert(1)", `https://evil.example/?x=${YT}`, `https://www.youtube.com/watch?v=${YT}"><script>alert(1)</script>`]) {
      const html = render([block("video", { url })]);
      expect(html, url).not.toContain("evil.example");
      expect(html, url).not.toContain("javascript:");
      expect(html, url).not.toContain("<script");
      expect(html, url).not.toContain("pp-embed-box");
    }
  });

  it("escapes the title and hides hidden blocks", () => {
    const html = render([block("video", { url: VIDEO_YT, title: '"><script>alert(1)</script>' })]);
    expect(html).not.toContain("<script");
    expect(render([block("video", { url: VIDEO_YT, title: "Secret" }, false)])).not.toContain("Secret");
  });

  const FRAMES: [string, EmbedKind, string, string | undefined][] = [
    [VIDEO_YT, "video", `https://www.youtube-nocookie.com/embed/${YT}`, "encrypted-media; fullscreen"],
    ["https://vimeo.com/76979871", "video", "https://player.vimeo.com/video/76979871?dnt=1", "encrypted-media; fullscreen"],
    [MUSIC_SP, "music", `https://open.spotify.com/embed/track/${SP}`, "encrypted-media"],
    ["https://soundcloud.com/forss/flickermood", "music", "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood&auto_play=false&visual=false&show_comments=false", undefined],
  ];

  it.each(FRAMES)("gives %s the exact player attributes, with no autoplay", (url, kind, src, allow) => {
    const frame = embedFrameAttributes(parseEmbed(url, kind) as EmbedInfo);
    expect(frame).toEqual({ src, allow, sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox", referrerPolicy: "strict-origin-when-cross-origin" });
    const html = renderToStaticMarkup(createElement("iframe", { title: "x", ...frame }));
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"');
    expect(html).toContain('referrerPolicy="strict-origin-when-cross-origin"');
    expect(html).not.toMatch(/allow-presentation|allow-top-navigation|picture-in-picture/);
    expect(`${frame.allow ?? ""} ${frame.src.replace("auto_play=false", "")}`).not.toMatch(/autoplay|auto_play/);
  });

  it("never grants top-level navigation", () => {
    expect(EMBED_SANDBOX).not.toContain("top-navigation");
    expect(EMBED_SANDBOX.split(" ")).toEqual(["allow-scripts", "allow-same-origin", "allow-popups", "allow-popups-to-escape-sandbox"]);
  });
});

describe("editor state", () => {
  it("creates empty, focusable, incomplete blocks that the preview shows as placeholders", () => {
    for (const type of ["video", "music"] as const) {
      const item = createItem(type);
      expect(item.values).toEqual({ url: "", title: "" });
      expect(validateItem(item)).toMatchObject({ ok: false, fields: { url: [expect.any(String)] } });
      expect(toViewBlocks([item])).toEqual([{ id: item.id, type, visible: true, incomplete: true }]);
    }
  });

  it("validates with the server's message and labels the block", () => {
    const item: EditableItem = { ...createItem("video"), values: { url: MUSIC_SP, title: "" } };
    expect(validateItem(item)).toMatchObject({ ok: false, fields: { url: ["That's a Spotify link. Use a Music block for it."] } });
    expect(itemLabel(item)).toBe("Untitled video");
    expect(itemLabel(createItem("music"))).toBe("Untitled music player");
    expect(itemLabel({ ...item, values: { url: VIDEO_YT, title: "My video" } })).toBe("My video");
  });

  it("loads a stored block with its canonical URL", () => {
    const [item] = toEditorItems([{ id: ID(1), type: "music", version: 2, visible: true, config: { url: MUSIC_SP } } as Block]);
    expect(item.values).toEqual({ url: MUSIC_SP, title: "" });
    expect(validateItem(item)).toMatchObject({ ok: true });
  });
});

describe("CSP split", () => {
  const compile = (source: string) => pathToRegexp(source, [], NEXT_SOURCE_OPTIONS);
  const profile = compile(PROFILE_HEADERS_SOURCE);
  const page = compile(PAGE_HEADERS_SOURCE);
  const token = compile(TOKEN_PAGE_HEADERS_SOURCE);
  const vcard = compile(VCARD_HEADERS_SOURCE);
  const media = compile("/media/:path*");
  const FRAME_SRC =
    "frame-src https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/ https://open.spotify.com/embed/ https://w.soundcloud.com/player/";

  it("has exactly the reviewed frame sources, and only frame-src differs from the page policy", () => {
    const pagePolicy = contentSecurityPolicy({ isDev: false });
    const profilePolicy = contentSecurityPolicy({ isDev: false, frameSources: EMBED_FRAME_SOURCES });
    expect(profilePolicy.split("; ").find((d) => d.startsWith("frame-src"))).toBe(FRAME_SRC);
    expect(pagePolicy.split("; ").find((d) => d.startsWith("frame-src"))).toBe("frame-src 'none'");
    expect(profilePolicy.replace(FRAME_SRC, "frame-src 'none'")).toBe(pagePolicy);
    expect(profilePolicy).toContain("frame-ancestors 'none'");
    expect(profilePolicy).not.toContain("*");
  });

  it("changes no other header on the profile route", () => {
    const strip = (h: { key: string; value: string }[]) => h.filter((x) => x.key !== "Content-Security-Policy");
    expect(strip(profileSecurityHeaders({ isDev: false }))).toEqual(strip(securityHeaders({ isDev: false })));
  });

  it("gives every handle-shaped, unreserved path the profile rule, and nothing else", () => {
    for (const p of ["/alice", "/a1", "/imagepage", "/with-dash_1", `/${"a".repeat(30)}`, "/ALICE", "/reset-passwords"]) {
      expect([profile.test(p), page.test(p)], p).toEqual([true, false]);
    }
    for (const p of [
      "/",
      "/a",
      "/-alice",
      "/_alice",
      "/@alice",
      `/${"a".repeat(31)}`,
      "/alice/",
      "/alice/extra",
      "/ali.ce",
      "/dashboard",
      "/DASHBOARD",
      "/dashboard/profiles",
      "/dashboard/analytics",
      "/admin",
      "/admin/users",
      "/login",
      "/register",
      "/setup",
      "/forgot-password",
      "/api",
      "/api/health",
      "/api/v",
      "/go",
      `/go/${ID(1)}/${ID(2)}`,
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect([profile.test(p), page.test(p)], p).toEqual([false, true]);
    }
  });

  it("matches the handle rules for every reserved name, so a live handle always has the embed policy", () => {
    for (const name of RESERVED_HANDLES) expect(profile.test(`/${name}`), name).toBe(false);
    for (const handle of ["alice", "bob-2", "x_y", "administrator", "dashboards", "go1", "mediafile"]) {
      expect(isValidHandle(handle), handle).toBe(true);
      expect(profile.test(`/${handle}`), handle).toBe(true);
    }
  });

  it("gives every path exactly one CSP", () => {
    const rules = (p: string) => [page, profile, token, vcard, media].filter((r) => r.test(p)).length;
    for (const p of [
      "/",
      "/alice",
      "/login",
      "/dashboard",
      "/reset-password",
      "/verify-email",
      "/api/vcard/x/y",
      "/api/vcard/x",
      "/media/abc.webp",
      `/dashboard/profiles/${ID(1)}`,
      "/a",
      "/admin/settings",
    ]) {
      expect(rules(p), p).toBe(1);
    }
    expect(rules(`/dashboard/profiles/${ID(1)}/qr`)).toBe(0); // The route sets its own.
  });

  it("requires every generated frameSrc to match a source", () => {
    const urls: [string, EmbedKind][] = [
      [VIDEO_YT, "video"],
      ["https://vimeo.com/76979871", "video"],
      [MUSIC_SP, "music"],
      ["https://soundcloud.com/forss/sets/soulhack", "music"],
    ];
    for (const [url, kind] of urls) {
      const { frameSrc } = parseEmbed(url, kind) as EmbedInfo;
      expect(EMBED_FRAME_SOURCES.filter((s) => frameSrc.startsWith(s)), frameSrc).toHaveLength(1);
    }
  });

  it("route inventory: every concrete top-level route of the app is reserved, so none can get the embed policy", () => {
    const root = path.resolve("src/app");
    const found = new Set<string>();
    const walk = (dir: string, segments: string[]) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) {
          if (/^(?:page|route)\.[jt]sx?$/.test(entry.name) && segments[0]) found.add(segments[0]);
          continue;
        }
        const group = /^\(.+\)$/.test(entry.name);
        const dynamic = /^\[.+\]$/.test(entry.name);
        // A dynamic first segment has no concrete name; a route inside a group has the group's parent's path.
        if (dynamic && segments.length === 0) continue;
        walk(path.join(dir, entry.name), group ? segments : [...segments, entry.name]);
      }
    };
    walk(root, []);
    expect([...found].sort()).toEqual(expect.arrayContaining(["admin", "api", "dashboard", "forgot-password", "go", "login", "media", "register", "reset-password", "setup", "verify-email"]));
    for (const segment of found) expect(RESERVED_HANDLES.has(segment), `/${segment} isn't reserved`).toBe(true);
  });
});

describe("contrast", () => {
  it("every color the box uses is one the theme contrast check validates, under all ten presets", () => {
    // Title and Open link: text.color. Notice: text.muted. Load: the button's text on its surface. The box has no surface of its own.
    expect(THEME_PRESETS).toHaveLength(10);
    for (const preset of THEME_PRESETS) expect(themeContrastIssues(preset.theme), preset.id).toEqual([]);
  });
});
