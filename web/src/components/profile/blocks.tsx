import type { ComponentType } from "react";
import type { Block } from "@/features/blocks/block";
import {
  BLOCK_DEFINITIONS,
  isRenderableBlockType,
  type BlockConfig,
  type BlockType,
  type RenderableBlockType,
} from "@/features/blocks/definitions";
import { clickPath, socialClickPath } from "@/features/analytics/paths";
import { mailtoHref, telHref } from "@/features/blocks/contact-points";
import { embedFrameAttributes, parseEmbed, type EmbedInfo } from "@/features/blocks/embeds";
import { getSocialPlatform, socialDestination, socialLinkName } from "@/features/blocks/social-platforms";
import { vcardDataUrl, vcardFileNames, vcardPath } from "@/features/blocks/vcard";
import { Markdown, type MarkdownLinkProps } from "@/lib/markdown";
import { isMediaUrl } from "@/lib/validation/media";
import { EmbedPlayer } from "./embed-player";

/**
 * Block renderers shared by the public page and the editor preview.
 * Only reviewed types have a renderer (`RENDERABLE_BLOCK_TYPES`); the
 * map is typed over that set, so other stored types can't reach the page.
 * Pure and client-safe: no server-only imports.
 */

export interface RenderContext {
  mode: "public" | "preview";
  openLinksInNewTab: boolean;
  /**
   * Public page only: the live profile's id. Link blocks then point at the
   * tracked `/go/{profileId}/{blockId}` redirect, social items at
   * `/go/{profileId}/{blockId}/{index}` and contact cards at
   * `/api/vcard/{profileId}/{blockId}`, linked images at the same
   * `/go/{profileId}/{blockId}` as link blocks. Without it (and always in the
   * preview) links are direct and the contact card is built in the browser.
   */
  clickTrackingProfileId?: string;
  /** The theme's social style, used by social blocks set to `inherit` (`theme.social.style`). */
  socialStyle?: "icon" | "pill";
}

/** An editor block that doesn't validate yet; rendered as a placeholder in the preview only. */
export interface IncompleteBlock {
  id: string;
  type: BlockType;
  visible: boolean;
  incomplete: true;
}

export type ViewBlock = Block | IncompleteBlock;

export interface BlockRendererProps<T extends RenderableBlockType> {
  block: Extract<Block, { type: T }>;
  config: BlockConfig<T>;
  ctx: RenderContext;
}

/**
 * Outbound link policy for blocks and Markdown links (validated at write
 * time). Published link blocks go through the `/go` redirect; Markdown links
 * and the preview stay direct and untracked. Preview links always open a new
 * tab so the editor isn't navigated away.
 */
export function linkProps(ctx: RenderContext): MarkdownLinkProps {
  return ctx.openLinksInNewTab || ctx.mode === "preview"
    ? { target: "_blank", rel: "noopener noreferrer nofollow ugc" }
    : { rel: "noopener nofollow ugc" };
}

function linkBlockHref(block: { id: string }, url: string, ctx: RenderContext): string {
  return ctx.mode === "public" && ctx.clickTrackingProfileId ? clickPath(ctx.clickTrackingProfileId, block.id) : url;
}

const LinkRenderer = ({ block, config, ctx }: BlockRendererProps<"link">) => (
  <a className="pp-btn" href={linkBlockHref(block, config.url, ctx)} {...linkProps(ctx)}>
    <span className="pp-btn-label">
      <span className="pp-btn-title">{config.title}</span>
      {config.description && <span className="pp-btn-desc">{config.description}</span>}
    </span>
  </a>
);

/** Always an <h2> (the profile name is the page's <h1>); `size` is visual only. */
const HeadingRenderer = ({ config }: BlockRendererProps<"heading">) => (
  <h2 className="pp-heading" data-size={config.size} style={config.align !== "inherit" ? { textAlign: config.align } : undefined}>
    {config.text}
  </h2>
);

const TextRenderer = ({ config, ctx }: BlockRendererProps<"text">) => (
  <div className="pp-text" style={config.align !== "inherit" ? { textAlign: config.align } : undefined}>
    <Markdown source={config.markdown} linkProps={linkProps(ctx)} />
  </div>
);

const DividerRenderer = ({ config }: BlockRendererProps<"divider">) => <hr className="pp-divider" data-style={config.style} />;

/**
 * Social links: original monogram badges drawn with the button
 * tokens, so their text has the button's validated contrast. Every
 * destination is rechecked here; an item that fails is left out, and its
 * `/go` index (the stored position) would answer 404 anyway.
 */
const SocialRenderer = ({ block, config, ctx }: BlockRendererProps<"social">) => {
  const style = config.style === "inherit" ? (ctx.socialStyle ?? "icon") : config.style;
  const tracked = ctx.mode === "public" && ctx.clickTrackingProfileId;
  const links = config.items.flatMap((item, index) => {
    const platform = getSocialPlatform(item.platform);
    const destination = socialDestination(item.platform, item.url);
    if (!platform || !destination) return [];
    const href = tracked ? socialClickPath(tracked, block.id, index) : destination.toString();
    return [{ index, platform, href }];
  });
  if (links.length === 0) return null;
  return (
    <ul className="pp-social" data-style={style} aria-label="Social links">
      {links.map(({ index, platform, href }) => (
        <li key={index}>
          <a className="pp-social-link" href={href} aria-label={socialLinkName(platform)} {...linkProps(ctx)}>
            <span className="pp-social-mark" aria-hidden="true">
              {platform.mark}
            </span>
            {style === "pill" && (
              <span className="pp-social-label" aria-hidden="true">
                {platform.label}
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
};

/** A button-styled action link; email and phone actions are direct and never counted. */
const ActionButton = ({ href, label, download }: { href: string; label: string; download?: string }) => (
  <a className="pp-btn" href={href} download={download}>
    <span className="pp-btn-label">
      <span className="pp-btn-title">{label}</span>
    </span>
  </a>
);

const EmailRenderer = ({ config }: BlockRendererProps<"email">) => {
  const href = mailtoHref(config.email, config.subject);
  return href ? <ActionButton href={href} label={config.label} /> : null;
};

const PhoneRenderer = ({ config }: BlockRendererProps<"phone">) => {
  const href = telHref(config.phone);
  return href ? <ActionButton href={href} label={config.label} /> : null;
};

/**
 * Contact card: the public page downloads the published card
 * from `/api/vcard`; the preview downloads the draft's card as a `data:` URL.
 * Neither is counted.
 */
const ContactRenderer = ({ block, config, ctx }: BlockRendererProps<"contact">) => {
  const href =
    ctx.mode === "public" && ctx.clickTrackingProfileId ? vcardPath(ctx.clickTrackingProfileId, block.id) : vcardDataUrl(config);
  return href ? <ActionButton href={href} label={config.label} download={vcardFileNames(config).ascii} /> : null;
};

/**
 * Uploaded image: a plain `<img>` with the server-stamped size, so
 * its box is reserved before it decodes; same-origin only, so no CSP change
 * and no image optimizer. A decorative image has empty alt text and never a
 * link; a linked image's alt text names the link.
 */
const ImageRenderer = ({ block, config, ctx }: BlockRendererProps<"image">) => {
  if (!isMediaUrl(config.src)) return null;
  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin uploaded media with stored dimensions; no optimizer
    <img
      className="pp-image"
      src={config.src}
      alt={config.decorative ? "" : config.alt}
      width={config.width}
      height={config.height}
      loading="lazy"
      decoding="async"
    />
  );
  const href = config.href && !config.decorative ? linkBlockHref(block, config.href, ctx) : undefined;
  return (
    <figure className="pp-figure" data-aspect={config.aspect}>
      {href ? (
        <a className="pp-image-link" href={href} {...linkProps(ctx)}>
          {image}
        </a>
      ) : (
        image
      )}
      {config.caption && <figcaption className="pp-caption">{config.caption}</figcaption>}
    </figure>
  );
};

/**
 * Video and music: the player's details are rebuilt from the
 * canonical URL through the parser on every render, so the raw stored string
 * never reaches an attribute. The Open link sits outside the box: it works
 * without JavaScript, isn't counted, and stays as the way out when a player fails.
 */
function Embed({ embed, title, ctx }: { embed: EmbedInfo | null; title?: string; ctx: RenderContext }) {
  if (!embed) return null;
  const name = title ?? embed.defaultTitle;
  return (
    <div className="pp-embed">
      <EmbedPlayer frame={embedFrameAttributes(embed)} box={embed.box} kind={embed.kind} label={embed.label} name={name} loadable={ctx.mode === "public"} />
      <a className="pp-embed-open" href={embed.canonicalUrl} target="_blank" rel="noopener nofollow ugc" aria-label={`Open on ${embed.label}: ${name}`}>
        Open on {embed.label}
      </a>
    </div>
  );
}

const VideoRenderer = ({ config, ctx }: BlockRendererProps<"video">) => <Embed embed={parseEmbed(config.url, "video")} title={config.title} ctx={ctx} />;
const MusicRenderer = ({ config, ctx }: BlockRendererProps<"music">) => <Embed embed={parseEmbed(config.url, "music")} title={config.title} ctx={ctx} />;

/** Fixed sizes only (`data-size` → globals.css); never focusable or announced. */
const SpacerRenderer = ({ config }: BlockRendererProps<"spacer">) => <div className="pp-spacer" data-size={config.size} aria-hidden="true" />;

type RendererMap = { [K in RenderableBlockType]: ComponentType<BlockRendererProps<K>> };

export const BLOCK_RENDERERS: RendererMap = {
  link: LinkRenderer,
  heading: HeadingRenderer,
  text: TextRenderer,
  divider: DividerRenderer,
  social: SocialRenderer,
  email: EmailRenderer,
  phone: PhoneRenderer,
  contact: ContactRenderer,
  spacer: SpacerRenderer,
  image: ImageRenderer,
  video: VideoRenderer,
  music: MusicRenderer,
};

function isIncomplete(block: ViewBlock): block is IncompleteBlock {
  return "incomplete" in block;
}

/** What a visitor would see: visible blocks of a reviewed type, in stored order. */
export function isShownPublicly(block: ViewBlock): boolean {
  return block.visible && !isIncomplete(block) && isRenderableBlockType(block.type);
}

function RenderBlock({ block, ctx }: { block: Block; ctx: RenderContext }) {
  if (!isRenderableBlockType(block.type)) return null;
  const Renderer = BLOCK_RENDERERS[block.type] as ComponentType<BlockRendererProps<RenderableBlockType>>;
  return <Renderer block={block as never} config={block.config as never} ctx={ctx} />;
}

export function ProfileBlocks({ blocks, ctx }: { blocks: readonly ViewBlock[]; ctx: RenderContext }) {
  const shown = blocks.filter((b) => isShownPublicly(b) || (ctx.mode === "preview" && b.visible && isIncomplete(b)));
  if (shown.length === 0) return null;
  return (
    <div className="pp-blocks">
      {shown.map((block) => (
        <div key={block.id} className="pp-block" data-block-id={block.id} data-block-type={block.type}>
          {isIncomplete(block) ? (
            <p className="pp-incomplete">Incomplete {BLOCK_DEFINITIONS[block.type].label.toLowerCase()}: finish it in the editor.</p>
          ) : (
            <RenderBlock block={block} ctx={ctx} />
          )}
        </div>
      ))}
    </div>
  );
}
