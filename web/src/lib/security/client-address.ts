import { isIPv4, isIPv6 } from "node:net";

/**
 * Trusted client addresses. Forwarding headers are client
 * input unless a verified reverse proxy overwrites them, so they are read only
 * when `TRUST_PROXY=true`. Better Auth's rate limiter reads the same headers
 * (`lib/auth/server.ts`), and `trustedClientAddress` applies the same rules as
 * its `getIPFromHeader` without trusted-proxy CIDRs: exactly one valid IP in
 * the header, IPv4-mapped IPv6 reduced to IPv4, other IPv6 truncated to its
 * /64 prefix. Unlike Better Auth there is no development/test fallback: no
 * trusted address means `null`, never a shared placeholder.
 *
 * The result is used transiently (hash input, rate-limit identity) and is
 * never stored or logged.
 */
export const TRUSTED_IP_HEADERS = ["x-forwarded-for", "x-real-ip"] as const;

export function trustedClientAddress(headers: Headers, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  for (const name of TRUSTED_IP_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    const address = addressFromHeader(value);
    if (address) return address;
  }
  return null;
}

function addressFromHeader(value: string): string | null {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 1) return null;
  const ip = parts[0];
  if (isIPv4(ip)) return ip;
  // Zone ids (fe80::1%eth0) are accepted by node:net but are not client addresses.
  if (ip.includes("%") || !isIPv6(ip)) return null;
  const groups = expandIPv6(ip);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
    const hi = Number.parseInt(groups[6], 16);
    const lo = Number.parseInt(groups[7], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return [...groups.slice(0, 4), "0000", "0000", "0000", "0000"].join(":");
}

/** Eight lowercase 4-digit groups; an embedded dotted IPv4 tail becomes two groups. */
function expandIPv6(ip: string): string[] | null {
  let text = ip.toLowerCase();
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    if (!isIPv4(v4[2])) return null;
    const [a, b, c, d] = v4[2].split(".").map(Number);
    text = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [left, right] = text.includes("::") ? text.split("::") : [text, undefined];
  const head = left ? left.split(":") : [];
  const tail = right === undefined ? [] : right ? right.split(":") : [];
  const fill = right === undefined ? 0 : 8 - head.length - tail.length;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, "0"));
}
