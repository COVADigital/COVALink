import { Fragment, type ReactNode } from "react";
import { parseLinkUrl } from "@/lib/validation/url";

/**
 * Renders a small Markdown subset to React elements: paragraphs, line breaks,
 * **bold**, *italic*, and [label](https://…) links. Output is built from React
 * nodes (never HTML strings), so user text cannot inject markup. Link targets
 * must pass the same rules as link blocks (`parseLinkUrl`), or be `mailto:`;
 * anything else is shown as plain text.
 */
const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]{1,200})\]\(([^)\s]{1,2048})\)/g;

function safeHref(raw: string): string | null {
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(raw)) return raw;
  return parseLinkUrl(raw)?.toString() ?? null;
}

export interface MarkdownLinkProps {
  target?: "_blank";
  rel: string;
}

function inline(text: string, keyBase: string, linkProps: MarkdownLinkProps): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else {
      const href = safeHref(m[4]);
      out.push(
        href ? (
          <a key={key} href={href} {...linkProps}>
            {m[3]}
          </a>
        ) : (
          m[0]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** `linkProps` comes from the profile renderer so Markdown links follow the same target/rel policy as link blocks. */
export function Markdown({ source, linkProps }: { source: string; linkProps: MarkdownLinkProps }) {
  const paragraphs = source.trim().split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((p, pi) => (
        <p key={pi}>
          {p.split("\n").map((line, li) => (
            <Fragment key={li}>
              {li > 0 && <br />}
              {inline(line, `${pi}-${li}`, linkProps)}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  );
}
