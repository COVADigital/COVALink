import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error Next.js ships this compiled module without type declarations.
import { pathToRegexp as untypedPathToRegexp } from "next/dist/compiled/path-to-regexp";
import { createItem, duplicateItem, itemLabel, toBlockInput, toEditorItems, validateItem } from "@/components/editor/block-items";
import { ProfileView, type ViewDocument } from "@/components/profile/profile-view";
import { parseBlock, type Block } from "@/features/blocks/block";
import { canonicalPhone, mailtoHref, telHref } from "@/features/blocks/contact-points";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS } from "@/features/blocks/definitions";
import { assessStoredBlocks, resolveBlockList } from "@/features/blocks/input";
import { getSocialPlatform, SOCIAL_PLATFORMS, socialDestination, socialLinkName } from "@/features/blocks/social-platforms";
import { buildVCard, escapeText, foldLine, vcardDataUrl, vcardFileNames } from "@/features/blocks/vcard";
import { createDefaultDocument } from "@/features/profiles/document";
import { backgroundStops, buttonSurface, contrastRatio, TEXT_CONTRAST, themeContrastIssues } from "@/features/themes/contrast";
import { THEME_PRESETS } from "@/features/themes/presets";
import { PAGE_HEADERS_SOURCE, VCARD_HEADERS_SOURCE, vcardResponseHeaders, vcardSecurityHeaders } from "@/lib/security/headers";
import { components, parseVCard, readVCardLines, unescapeText } from "../support/vcard-parse";

const pathToRegexp = untypedPathToRegexp as (path: string, keys?: unknown[], options?: object) => RegExp;
const NEXT_SOURCE_OPTIONS = { strict: true, sensitive: false, delimiter: "/" };
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = "11111111-1111-4111-8111-111111111111";
const CONTROLS = ["\r", "\n", "\t", "\u0000", "\u007f", "\u0085", "\u001b", "\u2028"];

describe("social destinations", () => {
  it("has the 22 registry entries, each with a unique id, a 1–2 character monogram and an https placeholder", () => {
    expect(SOCIAL_PLATFORMS).toHaveLength(22);
    expect(new Set(SOCIAL_PLATFORMS.map((p) => p.id)).size).toBe(22);
    for (const p of SOCIAL_PLATFORMS) {
      expect(p.mark.length, p.id).toBeGreaterThanOrEqual(1);
      expect(p.mark.length, p.id).toBeLessThanOrEqual(2);
      expect(p.placeholder.startsWith("https://"), p.id).toBe(true);
    }
    expect(SOCIAL_PLATFORMS.filter((p) => p.hosts.length === 0).map((p) => p.id)).toEqual(["mastodon", "website"]);
  });

  it.each(SOCIAL_PLATFORMS.map((p) => [p.id, p] as const))("%s: accepts its hosts over https only, without credentials", (id, p) => {
    const hosts = p.hosts.length ? p.hosts : ["example.social"];
    for (const host of hosts) {
      expect(socialDestination(id, `https://${host}/you`)?.toString(), host).toBe(`https://${host}/you`);
      expect(socialDestination(id, `https://www.${host}/you`)?.hostname, `subdomain of ${host}`).toBe(`www.${host}`);
      // A missing scheme is completed as https (like link blocks); http is refused.
      expect(socialDestination(id, `${host}/you`)?.protocol).toBe("https:");
      expect(socialDestination(id, `http://${host}/you`), "http").toBeNull();
      expect(socialDestination(id, `https://user:pw@${host}/you`), "credentials").toBeNull();
      expect(socialDestination(id, `https://user@${host}/you`), "username").toBeNull();
      expect(socialDestination(id, `//${host}/you`), "protocol-relative").toBeNull();
      expect(socialDestination(id, `https:${host}/you`), "ambiguous scheme").toBeNull();
      expect(socialDestination(id, `https://${host}/you\n`), "control").not.toBeNull(); // trailing whitespace is trimmed
      expect(socialDestination(id, `https://${host}/y\tou`), "tab inside").toBeNull();
      expect(socialDestination(id, `javascript://${host}/%0Aalert(1)`), "javascript").toBeNull();
    }
    if (p.hosts.length) {
      for (const other of ["evil.example", `${p.hosts[0]}.evil.example`, `evil${p.hosts[0]}`]) {
        expect(socialDestination(id, `https://${other}/you`), other).toBeNull();
      }
    } else {
      expect(socialDestination(id, "https://any.example.org/@me")?.toString()).toBe("https://any.example.org/@me");
    }
    expect(socialLinkName(p)).toBe(id === "website" ? "Website" : `${p.label} profile`);
  });

  it("refuses unknown platforms", () => {
    expect(socialDestination("myspace", "https://myspace.com/you")).toBeNull();
    expect(socialDestination("__proto__", "https://example.com")).toBeNull();
    expect(getSocialPlatform("constructor")).toBeUndefined();
  });
});

describe("email and telephone destinations", () => {
  it("builds mailto: with the subject as an encoded query value", () => {
    expect(mailtoHref("ana@example.com")).toBe("mailto:ana@example.com");
    expect(mailtoHref("ana@example.com", "")).toBe("mailto:ana@example.com");
    expect(mailtoHref("o'neil+news@example.co.uk", "Hello & welcome? #1 100%")).toBe(
      "mailto:o'neil+news@example.co.uk?subject=Hello%20%26%20welcome%3F%20%231%20100%25",
    );
    // Header names inside the subject stay part of the encoded value.
    expect(mailtoHref("a@example.com", "x&bcc=b@example.com")).toBe("mailto:a@example.com?subject=x%26bcc%3Db%40example.com");
  });

  it("refuses control characters in the subject and anything but a plain address", () => {
    for (const c of CONTROLS) expect(mailtoHref("a@example.com", `Hi${c}Bcc: x@example.com`), JSON.stringify(c)).toBeNull();
    expect(mailtoHref("a@example.com", "x".repeat(121))).toBeNull();
    for (const bad of ["a?cc=b@example.com", "a@example.com?bcc=x", "a b@example.com", "a%0a@example.com", "a#@example.com", `${"a".repeat(250)}@x.co`]) {
      expect(mailtoHref(bad), bad).toBeNull();
    }
  });

  it.each([
    ["+1 (555) 010-0100", "+15550100100"],
    ["555.0100", "5550100"],
    ["1234", "1234"],
    ["+123456789012345", "+123456789012345"],
    ["  +44 20 7946 0958  ", "+442079460958"],
  ])("canonicalizes %s", (input, canonical) => {
    expect(canonicalPhone(input)).toBe(canonical);
    expect(telHref(input)).toBe(`tel:${canonical}`);
  });

  it.each([
    ["too few digits", "123"],
    ["too many digits", "+1234567890123456"],
    ["punctuation only", "(((-..-)))"],
    ["second plus", "++15550100"],
    ["misplaced plus", "1+5550100"],
    ["extension x", "5550100 x12"],
    ["extension ext", "5550100ext12"],
    ["pause comma", "5550100,12"],
    ["wait semicolon", "5550100;12"],
    ["hash", "5550100#"],
    ["star", "*5550100"],
    ["letters", "1-800-FLOWERS"],
    ["slash", "555/0100"],
    ["tab", "555\t0100"],
    ["leading tab", "\t5550100"],
    ["newline", "5550100\n"],
    ["NUL", "5550100\u0000"],
    ["over 32 characters", `+1 ${"- ".repeat(14)}5550100`],
    ["empty", ""],
  ])("refuses %s", (_label, input) => {
    expect(canonicalPhone(input)).toBeNull();
    expect(telHref(input)).toBeNull();
    expect(BLOCK_INPUT_SCHEMAS.phone.safeParse({ label: "Call", phone: input }).success).toBe(false);
  });
});

describe("contact, social and spacer block schemas", () => {
  const social = { items: [{ platform: "github", url: "https://github.com/ana" }], style: "inherit" };

  it("accept valid configs and normalize them", () => {
    expect(BLOCK_INPUT_SCHEMAS.social.parse({ items: [{ platform: "github", url: "github.com/ana" }] })).toEqual({
      items: [{ platform: "github", url: "https://github.com/ana" }],
      style: "inherit",
    });
    expect(BLOCK_INPUT_SCHEMAS.email.parse({ label: " Write ", email: "a@example.com", subject: "" })).toEqual({ label: "Write", email: "a@example.com", subject: undefined });
    expect(BLOCK_INPUT_SCHEMAS.phone.parse({ label: "Call", phone: " +1 555 0100 " })).toEqual({ label: "Call", phone: "+1 555 0100" });
    expect(BLOCK_INPUT_SCHEMAS.contact.parse({ organization: "Acme", note: "Line 1\nLine 2", website: "acme.example" })).toMatchObject({
      label: "Save contact",
      organization: "Acme",
      note: "Line 1\nLine 2",
      website: "https://acme.example/",
    });
    expect(BLOCK_INPUT_SCHEMAS.spacer.parse({ size: "xl" })).toEqual({ size: "xl" });
  });

  it("reject unknown keys at every level (input and v2 storage alike)", () => {
    expect(BLOCK_INPUT_SCHEMAS.social.safeParse({ ...social, layout: "grid" }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.social.safeParse({ items: [{ platform: "github", url: "https://github.com/ana", label: "" }] }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.email.safeParse({ label: "x", email: "a@example.com", cc: "" }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.phone.safeParse({ label: "x", phone: "5550100", ext: null }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.contact.safeParse({ organization: "Acme", photo: "" }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.spacer.safeParse({ size: "md", px: 0 }).success).toBe(false);
  });

  it("enforce the social item count, platforms and destinations", () => {
    expect(BLOCK_INPUT_SCHEMAS.social.safeParse({ items: [] }).success).toBe(false);
    const max = Array.from({ length: 24 }, (_, i) => ({ platform: "website", url: `https://site${i}.example` }));
    expect(BLOCK_INPUT_SCHEMAS.social.safeParse({ items: max }).success).toBe(true);
    expect(BLOCK_INPUT_SCHEMAS.social.safeParse({ items: [...max, max[0]] }).success).toBe(false);
    const issues = BLOCK_INPUT_SCHEMAS.social.safeParse({
      items: [
        { platform: "github", url: "https://github.com/ok" },
        { platform: "github", url: "http://github.com/ana" },
        { platform: "myspace", url: "https://myspace.com/x" },
        { platform: "instagram", url: "https://evil.example/x" },
      ],
    }).error!.issues.map((i) => i.path.join("."));
    expect(issues).toEqual(["items.1.url", "items.2.platform", "items.3.url"]);
    expect(BLOCK_INPUT_SCHEMAS.social.safeParse({ ...social, style: "grid" }).success).toBe(false);
  });

  it("refuse control characters in labels, subjects and contact fields (the note may contain line feeds)", () => {
    for (const c of CONTROLS) {
      const j = JSON.stringify(c);
      expect(BLOCK_INPUT_SCHEMAS.email.safeParse({ label: "Write", email: "a@example.com", subject: `Hi${c}there` }).success, j).toBe(false);
      expect(BLOCK_INPUT_SCHEMAS.email.safeParse({ label: `Wr${c}ite`, email: "a@example.com" }).success, j).toBe(false);
      expect(BLOCK_INPUT_SCHEMAS.phone.safeParse({ label: `Ca${c}ll`, phone: "5550100" }).success, j).toBe(false);
      expect(BLOCK_INPUT_SCHEMAS.contact.safeParse({ firstName: `A${c}na` }).success, j).toBe(false);
      expect(BLOCK_INPUT_SCHEMAS.contact.safeParse({ firstName: "Ana", note: `x${c}y` }).success, j).toBe(c === "\n");
    }
    // Refused, not trimmed away.
    expect(BLOCK_INPUT_SCHEMAS.email.safeParse({ label: "Write", email: "a@example.com", subject: "Hi\t" }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.email.safeParse({ label: "Write", email: "a@example.com", subject: "x".repeat(121) }).success).toBe(false);
    expect(BLOCK_INPUT_SCHEMAS.email.safeParse({ label: "Write", email: `${"a".repeat(250)}@example.com` }).success).toBe(false);
  });

  it("require a name or organization on contact cards", () => {
    expect(BLOCK_INPUT_SCHEMAS.contact.safeParse({ jobTitle: "CEO" }).error?.issues[0].path).toEqual(["firstName"]);
    expect(BLOCK_INPUT_SCHEMAS.contact.safeParse({ lastName: "Ng" }).success).toBe(true);
  });

  it("new blocks start invalid where a placeholder could be published by accident", () => {
    for (const type of ["social", "email", "phone", "contact"] as const) {
      expect(BLOCK_INPUT_SCHEMAS[type].safeParse(BLOCK_DEFINITIONS[type].defaults()).success, type).toBe(false);
    }
    expect(BLOCK_INPUT_SCHEMAS.spacer.safeParse(BLOCK_DEFINITIONS.spacer.defaults()).success).toBe(true);
  });

  it("refuse a client-supplied version and editable types sent as preserved", () => {
    const stored = assessStoredBlocks([], []);
    const entry = { id: ID(1), type: "spacer", visible: true, config: { size: "md" } };
    expect(resolveBlockList([{ ...entry, version: 1 }], stored)).toMatchObject({ ok: false, errors: { items: [{ index: 0, message: "This block is malformed." }] } });
    const r = resolveBlockList([entry], stored);
    expect(r.ok && r.write[0]).toEqual({ ...entry, version: 1 });
    const withSocial = assessStoredBlocks([{ id: ID(2), type: "social", version: 2, visible: true, config: { items: [{ platform: "x", url: "https://x.com/a" }] } }], []);
    expect(resolveBlockList([{ id: ID(2), preserve: true }], withSocial)).toMatchObject({ ok: false });
  });

  it("report nested social errors as items.{i}.url on the server, like the editor", () => {
    const r = resolveBlockList(
      [{ id: ID(3), type: "social", visible: true, config: { items: [{ platform: "github", url: "https://github.com/a" }, { platform: "x", url: "http://x.com/a" }] } }],
      assessStoredBlocks([], []),
    );
    expect(r).toMatchObject({ ok: false, errors: { items: [{ index: 0, fields: { "items.1.url": [expect.stringContaining("https://")] } }] } });
  });
});

describe("stored v1 → v2 compatibility", () => {
  const v1 = (type: string, config: object, extra: object = {}) => ({ id: ID(5), type, version: 1, visible: true, config, ...extra });

  it("reads valid v1 blocks as v2, unchanged", () => {
    const cases: [string, object][] = [
      ["social", { items: [{ platform: "github", url: "https://github.com/ana" }], style: "pill" }],
      ["email", { label: "Write", email: "a@example.com", subject: "Hello" }],
      ["phone", { label: "Call", phone: "+1 555 0100" }],
      ["contact", { label: "Save contact", firstName: "Bea" }],
    ];
    for (const [type, config] of cases) {
      const r = parseBlock(v1(type, config));
      expect(r.success, type).toBe(true);
      if (r.success) expect(r.block).toMatchObject({ type, version: 2, config });
    }
    const spacer = parseBlock(v1("spacer", { size: "sm" }));
    expect(spacer.success && spacer.block.version).toBe(1);
  });

  it("makes v1 blocks that fail the v2 rules unreadable, so their draft is protected and nothing is rewritten", () => {
    const bad = [
      v1("social", { items: [], style: "inherit" }),
      v1("social", { items: [{ platform: "github", url: "http://github.com/ana" }] }),
      v1("social", { items: [{ platform: "github", url: "https://github.com/ana", label: "x" }] }),
      v1("email", { label: "Write", email: "a@example.com", subject: "Hi\r\nBcc: x@example.com" }),
      v1("email", { label: "Write", email: "a@example.com", extra: "" }),
      v1("phone", { label: "Call", phone: "(((-)))" }),
      v1("contact", { label: "Save", firstName: "Bea", phone: "5550100 x1" }),
    ];
    for (const raw of bad) {
      expect(parseBlock(raw).success, JSON.stringify(raw.config)).toBe(false);
      const stored = assessStoredBlocks([raw], []);
      expect(stored).toMatchObject({ unreadable: 1, protectedCount: 1 });
    }
  });

  it("marks a lenient v1 spacer with an unknown key as lossy (protected), not editable", () => {
    expect(assessStoredBlocks([v1("spacer", { size: "md", px: 3 })], [])).toMatchObject({ lossy: 1, protectedCount: 1 });
    expect(assessStoredBlocks([v1("spacer", { size: "md" })], [])).toMatchObject({ protectedCount: 0 });
  });
});

describe("vCard 4.0", () => {
  const contact = (extra: object = {}) => BLOCK_INPUT_SCHEMAS.contact.parse({ firstName: "Ana", lastName: "Ruiz", ...extra });

  it("generates a conformant card with the required properties", () => {
    const card = buildVCard(
      contact({ organization: "Acme, Inc.", jobTitle: "CTO; founder", email: "ana@example.com", phone: "+1 (555) 010-0100", website: "acme.example/team", note: "Line 1\nLine 2 \\ end" }),
    )!;
    const props = parseVCard(card);
    expect(props[0]).toMatchObject({ name: "BEGIN", raw: "VCARD" });
    expect(props[1]).toMatchObject({ name: "VERSION", raw: "4.0" });
    expect(props.at(-1)).toMatchObject({ name: "END", raw: "VCARD" });
    const get = (n: string) => props.find((p) => p.name === n)!;
    expect(unescapeText(get("FN").raw)).toBe("Ana Ruiz");
    expect(components(get("N").raw)).toEqual(["Ruiz", "Ana", "", "", ""]);
    expect(unescapeText(get("ORG").raw)).toBe("Acme, Inc.");
    expect(get("ORG").raw).toBe("Acme\\, Inc.");
    expect(unescapeText(get("TITLE").raw)).toBe("CTO; founder");
    expect(unescapeText(get("EMAIL").raw)).toBe("ana@example.com");
    expect(get("TEL")).toMatchObject({ params: ["VALUE=uri"], raw: "tel:+15550100100" });
    expect(get("URL").raw).toBe("https://acme.example/team");
    expect(unescapeText(get("NOTE").raw)).toBe("Line 1\nLine 2 \\ end");
    expect(props.filter((p) => p.name === "BEGIN" || p.name === "END")).toHaveLength(2);
  });

  it("derives FN from the organization when there is no name, and omits N", () => {
    const props = parseVCard(buildVCard(BLOCK_INPUT_SCHEMAS.contact.parse({ organization: "Acme" }))!);
    expect(props.find((p) => p.name === "FN")?.raw).toBe("Acme");
    expect(props.some((p) => p.name === "N")).toBe(false);
  });

  it("can't be made to start another property or card by stored text", () => {
    const hostile = "x\r\nEND:VCARD\r\nBEGIN:VCARD\nFN:Mallory\rTEL:1";
    // The schema refuses these characters; the generator stays safe if a value got through anyway.
    const config = { ...contact(), organization: hostile, note: hostile, jobTitle: `a${"\u0085"}b${"\u2028"}c` };
    const card = buildVCard(config)!;
    const props = parseVCard(card);
    expect(props.map((p) => p.name)).toEqual(["BEGIN", "VERSION", "FN", "N", "ORG", "TITLE", "NOTE", "END"]);
    expect(unescapeText(props.find((p) => p.name === "ORG")!.raw)).toBe("x\nEND:VCARD\nBEGIN:VCARD\nFN:Mallory\nTEL:1");
    expect(props.find((p) => p.name === "TITLE")!.raw).toBe("abc");
    expect(card.match(/\r\nEND:VCARD\r\n/g)).toHaveLength(1);
  });

  it("escapes backslash, comma, semicolon and line breaks", () => {
    expect(escapeText("a\\b,c;d\ne\r\nf\rg")).toBe("a\\\\b\\,c\\;d\\ne\\nf\\ng");
    expect(unescapeText(escapeText("a\\n,;\\"))).toBe("a\\n,;\\");
  });

  it("folds at 75 octets without splitting a UTF-8 character", () => {
    const value = "Ü".repeat(30) + "😀".repeat(20) + "a".repeat(80);
    const folded = foldLine(`NOTE:${value}`);
    for (const line of folded.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      expect(line).not.toContain("\uFFFD");
      expect(line.isWellFormed()).toBe(true);
    }
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(readVCardLines(`${folded}\r\n`)).toEqual([`NOTE:${value}`]);
    expect(foldLine("A".repeat(75))).toBe("A".repeat(75));
    expect(foldLine("A".repeat(76))).toBe(`${"A".repeat(75)}\r\n A`);
  });

  it("round-trips long multilingual values through folding and escaping", () => {
    const note = `Zoë; Łódź, 東京\n${"見".repeat(40)} \\ done`;
    const props = parseVCard(buildVCard(contact({ note, organization: "Çà et là; S.A., ✓".repeat(4) }))!);
    expect(unescapeText(props.find((p) => p.name === "NOTE")!.raw)).toBe(note);
    expect(unescapeText(props.find((p) => p.name === "ORG")!.raw)).toBe("Çà et là; S.A., ✓".repeat(4));
  });

  it("returns null without a name or organization", () => {
    expect(buildVCard({ label: "Save", firstName: undefined, lastName: undefined, organization: undefined } as never)).toBeNull();
    expect(vcardDataUrl({ label: "Save" } as never)).toBeNull();
  });

  it("builds safe download names and headers", () => {
    expect(vcardFileNames(contact())).toEqual({ ascii: "Ana-Ruiz.vcf" });
    expect(vcardFileNames(contact({ firstName: "Zoë", lastName: "Łódź" }))).toEqual({ ascii: "Zoe-odz.vcf", utf8: "Zoë Łódź.vcf" });
    expect(vcardFileNames(contact({ firstName: '"../../etc', lastName: "x\\y" }))).toEqual({ ascii: "etc-x-y.vcf" });
    expect(vcardFileNames(contact({ firstName: '"../../Zoë', lastName: "x\\y" }))).toEqual({ ascii: "Zoe-x-y.vcf", utf8: "Zoë xy.vcf" });
    expect(vcardFileNames(BLOCK_INPUT_SCHEMAS.contact.parse({ organization: "東京" }))).toEqual({ ascii: "contact.vcf", utf8: "東京.vcf" });
    const h = vcardResponseHeaders({ ascii: "Zoe.vcf", utf8: "Zoë (o'k)*.vcf" });
    expect(h["content-disposition"]).toBe(`attachment; filename="Zoe.vcf"; filename*=UTF-8''Zo%C3%AB%20%28o%27k%29%2A.vcf`);
    expect(h).toMatchObject({
      "content-type": "text/vcard; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(vcardResponseHeaders()).toMatchObject({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    expect(vcardResponseHeaders()).not.toHaveProperty("content-disposition");
  });

  it("gives exactly the two-segment vCard route the vCard headers and every other path the page headers", () => {
    // Compiled the way Next.js compiles `headers()` sources (lib/build-custom-route.js).
    const page = pathToRegexp(PAGE_HEADERS_SOURCE, [], NEXT_SOURCE_OPTIONS);
    const vcard = pathToRegexp(VCARD_HEADERS_SOURCE, [], NEXT_SOURCE_OPTIONS);
    const rule = (p: string) => [page.test(p), vcard.test(p)];
    for (const p of [`/api/vcard/${PROFILE}/${ID(1)}`, "/api/vcard/x/y", "/API/VCARD/x/y"]) expect(rule(p), p).toEqual([false, true]);
    for (const p of [
      "/api/vcard",
      "/api/vcard/",
      "/api/vcard/x",
      "/api/vcard/x/",
      `/api/vcard/${PROFILE}/${ID(1)}/`,
      `/api/vcard/${PROFILE}/${ID(1)}/extra`,
      "/api/vcard/x/y/z",
      "/api/vcardish/x/y",
      "/api/vcards/x/y",
      `/go/${PROFILE}/${ID(1)}/0`,
      "/api/v",
    ]) {
      expect(rule(p), p).toEqual([true, false]);
    }
    // A handle-shaped path gets the profile headers instead.
    expect(rule("/alice")).toEqual([false, false]);
  });

  it("sends the route's security headers from next.config as a subset of every vCard response's headers", () => {
    const security = vcardSecurityHeaders();
    expect(security).not.toHaveProperty("content-type");
    expect(security).not.toHaveProperty("content-disposition");
    for (const response of [vcardResponseHeaders(), vcardResponseHeaders({ ascii: "a.vcf" })]) {
      expect(response).toMatchObject(security);
    }
  });
});

describe("social contrast", () => {
  it("monogram and pill text reach 4.5:1 on the button surface under all ten presets", () => {
    expect(THEME_PRESETS).toHaveLength(10);
    for (const preset of THEME_PRESETS) {
      const t = preset.theme;
      for (const stop of backgroundStops(t)) {
        const ratio = contrastRatio(t.button.textColor, buttonSurface(t, stop));
        expect(ratio, `${preset.id} over ${stop}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      }
      expect(themeContrastIssues(t).filter((i) => i.field === "button.textColor"), preset.id).toEqual([]);
    }
  });

  it("draws badges with the button tokens, so the publish-time rule covers every theme", () => {
    const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    const rule = /\.pp-social-link \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("background: var(--pp-btn-bg");
    expect(rule).toContain("color: var(--pp-btn-text");
    expect(rule).toContain("border: var(--pp-btn-border-width, 0px) solid var(--pp-btn-border");
    expect(rule).toContain("min-width: 2.75rem");
    expect(rule).toContain("min-height: 2.75rem");
    // No opacity or filter that would change the validated text color.
    expect(/\.pp-social[^{]*\{[^}]*opacity/.test(css)).toBe(false);
  });
});

describe("shared rendering", () => {
  const blocks: Block[] = [
    { id: ID(1), type: "social", version: 2, visible: true, config: { items: [{ platform: "github", url: "https://github.com/ana" }, { platform: "website", url: "https://ana.example/" }], style: "inherit" } },
    { id: ID(2), type: "email", version: 2, visible: true, config: { label: "Write me", email: "ana@example.com", subject: "Hi & bye" } },
    { id: ID(3), type: "phone", version: 2, visible: true, config: { label: "Call me", phone: "+1 (555) 010-0100" } },
    { id: ID(4), type: "contact", version: 2, visible: true, config: BLOCK_INPUT_SCHEMAS.contact.parse({ firstName: "Ana" }) },
    { id: ID(5), type: "spacer", version: 1, visible: true, config: { size: "lg" } },
    { id: ID(6), type: "social", version: 2, visible: false, config: { items: [{ platform: "x", url: "https://x.com/hidden" }], style: "pill" } },
  ];
  const doc = (newTab = false, social: "icon" | "pill" = "icon"): ViewDocument => {
    const d = createDefaultDocument("Ana");
    return { ...d, theme: { ...d.theme, social: { style: social } }, settings: { ...d.settings, openLinksInNewTab: newTab }, blocks };
  };
  const render = (mode: "public" | "preview", newTab = false, social: "icon" | "pill" = "icon") =>
    renderToStaticMarkup(createElement(ProfileView, { document: doc(newTab, social), verified: false, mode, clickTrackingProfileId: PROFILE }));

  it("routes public social items through /go by stored index; the preview links directly in a new tab", () => {
    const pub = render("public");
    expect(pub).toContain(`<a class="pp-social-link" href="/go/${PROFILE}/${ID(1)}/0" aria-label="GitHub profile" rel="noopener nofollow ugc">`);
    expect(pub).toContain(`href="/go/${PROFILE}/${ID(1)}/1" aria-label="Website"`);
    expect(render("public", true)).toContain(`href="/go/${PROFILE}/${ID(1)}/0" aria-label="GitHub profile" target="_blank" rel="noopener noreferrer nofollow ugc"`);
    const preview = render("preview");
    expect(preview).toContain(`href="https://github.com/ana" aria-label="GitHub profile" target="_blank" rel="noopener noreferrer nofollow ugc"`);
    expect(preview).not.toContain("/go/");
    // Hidden blocks render nowhere.
    expect(pub + preview).not.toContain("x.com/hidden");
    expect(pub).not.toContain(ID(6));
  });

  it("uses the theme's social style for inherit, and shows names only for pills", () => {
    expect(render("public", false, "icon")).toContain('<ul class="pp-social" data-style="icon" aria-label="Social links">');
    const pills = render("public", false, "pill");
    expect(pills).toContain('data-style="pill"');
    expect(pills).toContain('<span class="pp-social-mark" aria-hidden="true">Gh</span><span class="pp-social-label" aria-hidden="true">GitHub</span>');
    expect(render("public", false, "icon")).not.toContain("pp-social-label");
  });

  it("renders email and phone as direct, untracked mailto:/tel: buttons", () => {
    for (const mode of ["public", "preview"] as const) {
      const html = render(mode);
      expect(html).toContain('<a class="pp-btn" href="mailto:ana@example.com?subject=Hi%20%26%20bye">');
      expect(html).toContain('<a class="pp-btn" href="tel:+15550100100">');
    }
  });

  it("downloads the published card from /api/vcard publicly and a data: card in the preview", () => {
    expect(render("public")).toContain(`<a class="pp-btn" href="/api/vcard/${PROFILE}/${ID(4)}" download="Ana.vcf">`);
    const preview = render("preview");
    expect(preview).toContain('href="data:text/vcard;charset=utf-8,BEGIN%3AVCARD%0D%0AVERSION%3A4.0%0D%0AFN%3AAna');
    expect(preview).toContain('download="Ana.vcf"');
  });

  it("renders the spacer as a fixed, hidden, unfocusable element", () => {
    expect(render("public")).toContain('<div class="pp-spacer" data-size="lg" aria-hidden="true"></div>');
  });

  it("matches between public and preview apart from the navigation targets", () => {
    const normalize = (html: string) =>
      html
        .replace(/href="[^"]*"/g, 'href=""')
        .replace(/ target="_blank"/g, "")
        .replace(/rel="[^"]*"/g, 'rel=""')
        .replace(/<main class="pp-container">|<div class="pp-container">/g, "<C>")
        .replace(/<\/main>|<\/div>(?=<\/div>$)/g, "")
        .replace(/<h1 class="pp-name"[^>]*>Ana<\/h1>|<p class="pp-name"[^>]*>Ana<\/p>/g, "<N/>")
        .replace(/data-mode="(public|preview)"/, "");
    const blocksOf = (html: string) => normalize(html).slice(normalize(html).indexOf('<div class="pp-blocks">'));
    expect(blocksOf(render("public"))).toBe(blocksOf(render("preview")));
  });
});

describe("social editor rows", () => {
  it("never sends the client-only row keys and keeps them unique on duplicate", () => {
    const item = createItem("social");
    expect(item.rows).toHaveLength(1);
    expect(item.rows![0].key).toMatch(/^[0-9a-f-]{36}$/);
    const input = toBlockInput([item])[0] as { config: { items: object[] } };
    expect(input.config.items).toEqual([{ platform: "instagram", url: "" }]);
    const copy = duplicateItem(item);
    expect(copy.rows![0].key).not.toBe(item.rows![0].key);
    expect(copy.rows![0]).toMatchObject({ platform: "instagram", url: "" });
  });

  it("validates rows with the server's field keys and reloads stored items", () => {
    const item = createItem("social");
    item.rows!.push({ key: "k", platform: "x", url: "http://x.com/a" });
    const v = validateItem(item);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(Object.keys(v.fields)).toEqual(["items.0.url", "items.1.url"]);
    const [loaded] = toEditorItems([
      { id: ID(1), type: "social", version: 2, visible: true, config: { items: [{ platform: "github", url: "https://github.com/a" }], style: "pill" } },
    ]);
    expect(loaded).toMatchObject({ values: { style: "pill" }, rows: [{ platform: "github", url: "https://github.com/a" }] });
    expect(validateItem(loaded).ok).toBe(true);
    expect(itemLabel(loaded)).toBe("GitHub");
  });

  it("labels the other new blocks", () => {
    expect(itemLabel(createItem("email"))).toBe("Email me");
    expect(itemLabel(createItem("phone"))).toBe("Call me");
    expect(itemLabel(createItem("contact"))).toBe("Contact card");
    expect(itemLabel(createItem("spacer"))).toBe("Spacer (medium)");
  });
});
