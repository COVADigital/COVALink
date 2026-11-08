/**
 * A strict, test-only RFC 6350 reader, written independently of
 * `features/blocks/vcard.ts`, so round-trip tests don't just mirror the
 * generator. It checks the physical format (CRLF only, at most 75 octets per
 * line, folding by CRLF + one space) and returns the logical properties with
 * TEXT values unescaped.
 */
export interface VCardProperty {
  name: string;
  params: string[];
  /** Raw value after unfolding (still escaped). */
  raw: string;
}

const encoder = new TextEncoder();

export function readVCardLines(text: string): string[] {
  if (!text.endsWith("\r\n")) throw new Error("vCard must end with CRLF");
  if (/\r(?!\n)|(?<!\r)\n/.test(text)) throw new Error("bare CR or LF");
  const physical = text.slice(0, -2).split("\r\n");
  for (const line of physical) {
    if (encoder.encode(line).length > 75) throw new Error(`line over 75 octets: ${line}`);
    if (line.includes("\uFFFD")) throw new Error("split character");
  }
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(" ")) {
      if (!logical.length) throw new Error("continuation without a line");
      logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }
  return logical;
}

export function parseVCard(text: string): VCardProperty[] {
  return readVCardLines(text).map((line) => {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`no property name: ${line}`);
    const [name, ...params] = line.slice(0, colon).split(";");
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`bad property name: ${name}`);
    return { name: name.toUpperCase(), params, raw: line.slice(colon + 1) };
  });
}

/** RFC 6350 §3.4 TEXT unescaping (`\\`, `\,`, `\;`, `\n`/`\N`). */
export function unescapeText(raw: string): string {
  return raw.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Splits a structured value on unescaped `;`, then unescapes each component. */
export function components(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      current += raw[i] + raw[i + 1];
      i++;
    } else if (raw[i] === ";") {
      out.push(current);
      current = "";
    } else {
      current += raw[i];
    }
  }
  out.push(current);
  return out.map(unescapeText);
}
