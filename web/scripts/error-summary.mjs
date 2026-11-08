// Bounded, credential-free error descriptions for operational scripts.
// Plain ESM with no imports so it is traced into the runtime image as-is.

const MAX_MESSAGE = 300;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;

/**
 * One line describing `err`: its code (or name) and a truncated message with
 * every URL and every given secret replaced, so a connection string, password
 * or host list can't reach the logs. Causes are summarized by code only.
 * @param {unknown} err
 * @param {Array<string | undefined>} secrets values to scrub (e.g. DATABASE_URL and its password)
 */
export function describeError(err, secrets = []) {
  const e = /** @type {{ code?: unknown, name?: unknown, message?: unknown, cause?: { code?: unknown } }} */ (err ?? {});
  const code = typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(e.code) ? e.code : typeof e.name === "string" ? e.name : "Error";
  let message = typeof e.message === "string" ? e.message : String(err);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) message = message.split(secret).join("[redacted]");
  }
  message = message.replace(URL_PATTERN, "[url]").replace(/\s+/g, " ").trim();
  if (message.length > MAX_MESSAGE) message = `${message.slice(0, MAX_MESSAGE)}…`;
  const cause = typeof e.cause?.code === "string" ? ` (cause ${e.cause.code})` : "";
  return `${code}: ${message}${cause}`;
}

/**
 * The secret parts of a database URL: the URL itself and its raw and decoded
 * password. An unparseable value is scrubbed as a whole.
 * @param {string | undefined} url
 */
export function databaseUrlSecrets(url) {
  if (!url) return [];
  const secrets = [url];
  try {
    const parsed = new URL(url);
    if (parsed.password) secrets.push(parsed.password, decodeURIComponent(parsed.password));
  } catch {
    // An unparseable URL is still scrubbed as a whole.
  }
  return secrets;
}
