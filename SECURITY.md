# Security

## Supported versions

COVALink hasn't had its first release yet. Until it does, security fixes go to the `master` branch. After the first release, security fixes go to the latest release only.

## Reporting a vulnerability

**Please don't report security problems in public issues, discussions or pull requests.** Report them privately through GitHub's private vulnerability reporting: on this repository's **Security** tab, choose **Report a vulnerability** ([how it works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Please include the affected version or commit, how to reproduce the problem, and what an attacker could do with it. Don't include real people's data, and don't test against installations you don't operate. Reports are answered as soon as possible, and fixes are coordinated with the reporter before details are published.

## How COVALink protects accounts and data

This section describes current behavior, so operators and contributors can judge it. Each control is covered by the automated test suites ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#quality-checks)).

### Setup, registration and roles

- **First administrator:** created only through `/setup`, authorized by the operator's `SETUP_TOKEN` (compared in constant time). Setup runs in one transaction under an advisory lock, so concurrent attempts produce exactly one administrator, and database constraints allow at most one super administrator. Setup can't be reused while the database exists. If the database is lost or replaced with an empty one, setup opens again to anyone holding the token, so keep it secret and rotate it if it was shared.
- **Registration:** every sign-up, through the interface or the API, is forced to an ordinary role and an active account. Sign-up is refused until setup completes, while registration is disabled, and in invite-only mode. Role and ban fields can't be set or changed through the account API.
- **Privileged changes** re-read the acting administrator's role inside the transaction, with row locks. Nobody can change their own role or status, administrators can manage only ordinary users, only the super administrator grants or removes administrator rights, and the super administrator role is never granted or changed. Each change writes an audit entry atomically with it.

### Sessions and routes

- Database-backed sessions expire after 30 days and are refreshed daily. Every check reads the current session and user records; nothing is cached in the cookie.
- Disabling an account deletes all its sessions in the same transaction and takes its public profiles offline on the next request. Signing out deletes the session. Expired or forged cookies resolve to no user.
- `/dashboard` and `/admin` require a session, and each page checks the user's capabilities on the server. Authenticated responses are never cached.
- Post-login redirects accept only internal paths.

### Request forgery and rate limits

- Origin checks are always on: cookie-bearing cross-origin requests, and requests without an origin, are refused.
- Rate limits are stored in PostgreSQL: sign-in 5 per minute, sign-up 5 per 10 minutes, password reset and verification email 3 per 10 minutes, password change 10 per 10 minutes, account deletion 5 per 10 minutes per account, and 100 per minute otherwise.
- **Client addresses** come from `X-Forwarded-For` or `X-Real-IP` only when `TRUST_PROXY=true`. The default, `false`, trusts no forwarding header, so all clients share one bucket per endpoint. Set `true` only behind a proxy verified to overwrite both headers ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#trust_proxy)).

### Security headers

Every response, including API routes and redirects, carries these headers, and `X-Powered-By` is removed:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self'; worker-src 'self' blob:` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` |

- **Public profile pages** have the same policy, except that `frame-src` allows exactly the four video and music player origins: `https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/ https://open.spotify.com/embed/ https://w.soundcloud.com/player/`. Every other route keeps `frame-src 'none'`.
- **Uploaded media, QR codes, contact cards and the password-reset and verification pages** send their own complete header sets instead, so every header appears once.
- **`img-src https:`** allows profile owners to use externally hosted avatars. A visitor's browser then contacts that host, which learns their IP address and user agent; the page URL isn't sent.
- **`'unsafe-inline'` for scripts and styles** is required by Next.js's inline bootstrap scripts with partial prerendering, which nonces don't support. It's mitigated by React's escaping, no use of `dangerouslySetInnerHTML`, no third-party script origins, and the locked-down `object-src`, `base-uri`, `form-action` and `frame-ancestors`.
- **HSTS** isn't sent by the app. Configure it at the TLS-terminating proxy ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#hsts-traefik-once-https-works)).

### Profiles and content

- **Ownership:** every profile read and write is scoped to its owner on the server. Another user's profile, or a malformed identifier, yields "not found", with no data and no change.
- **Narrow, strict contracts:** a profile save accepts exactly the header and SEO fields, the block list and the theme, each with a strict schema; any other field is refused. The whole merged document is validated again before every write. Writes carry the expected revision, so a stale write is refused, and save-and-publish is one locked transaction.
- **Stored data is never silently lost:** a draft holding blocks or a theme the editor can't reproduce exactly is protected. Every write to it is refused, with nothing changed, until the owner explicitly replaces it.
- **Links** accept only `http:` and `https:` destinations (plus `mailto:` in Markdown), and refuse other schemes, protocol-relative and root-relative forms, credentials, control characters, single-label hosts and URLs over 2048 characters. Links are rendered with `rel="noopener nofollow ugc"`.
- **No server-side fetching:** the server never fetches link destinations, avatars, previews or embed metadata, so content creates no server-side request forgery surface.
- **Rendering:** text is rendered as React nodes, with no `dangerouslySetInnerHTML`. Themes are built only from validated colors, bounded numbers and lookup tables, never from CSS text. Publishing a theme below WCAG AA contrast is refused.
- **Contact cards** escape text and fold lines so stored text can't add a property, and email and phone links are built from re-checked values so no header can be added.
- **Video and music players** accept only exact provider link forms. Nothing contacts a provider until the visitor presses Load. The player then runs in a sandboxed iframe that never gets autoplay or top-level navigation. After Load, the provider sees the visitor's IP address and user agent and may set its own cookies; the operator is responsible for any notices that requires.

### Uploaded media

- Uploads require a session and a same-origin request. Every library read and delete is scoped to the owner.
- **Bounded intake:** a durable hourly attempt counter and the per-user quota are checked before the body is read. The body is streamed to a private temporary file and cancelled the moment it passes 5 MiB, with a 30-second deadline. Temporary files are removed on every path.
- **Content, not names:** the declared type and file extension are ignored. A structural check refuses SVG, GIF, HTML, archives, animated images and data appended after the image; the image must then have one frame, at most 8192 pixels per side and at most 40 megapixels; it must decode fully without warnings; and it's re-encoded to WebP with all metadata (EXIF, GPS, ICC, XMP) removed. The original is never stored.
- **Abuse limits:** at most two decodes run at once, with a short queue, plus decoder and response timeouts.
- **Storage:** files have server-generated names only. Paths are contained by resolving them, never by prefix; symbolic links and junctions are refused; files are created exclusively with private permissions and never overwritten.
- **Serving:** a file is served only while its database record exists, as `image/webp` with `nosniff`, a sandbox Content-Security-Policy, same-origin resource policy, `noindex` and no cookies.
- **Accepted:** media URLs are unguessable but not secret. Anyone with the URL of an image, including one used only in a draft, can view it, and deleting it can't recall copies already cached elsewhere.

### Analytics

- **Stored per event:** the profile, the event type, the block for a click, the time, a device category, the referrer's hostname only, an allowlisted source for QR visits, and a visitor hash or nothing.
- **Never stored or logged:** IP addresses, user agents, full referrer URLs, request headers or cookies.
- **Visitor hashes** are SHA-256 hashes of a random daily salt, the trusted client address, a coarse browser class and the profile. They're made only when `TRUST_PROXY=true`. Salts never leave the database, and the purge deletes them after a day. Hashes are pseudonymous, not anonymous: someone with database access and a candidate address could test a hash until its salt is deleted.
- **No cookies or client identifiers** on public pages, the view beacon or the click redirect.
- **The click redirect** never takes a destination from the request, so it isn't an open redirect. Only GET records a click.
- **Abuse limits:** per visitor, per profile and installation-wide, per minute. Bot filtering is pattern-based and not exhaustive, so counts are traffic estimates.
- **Only the profile's owner** can see its analytics. Administrators can't see other users' analytics.

### Account self-service

- **Token transport:** reset and verification links carry their token only in the URL fragment, so it never reaches a request line, an access log, a referrer or a cache, and the page removes it from history at once. Endpoints that would accept a token in the URL answer 404, in every spelling.
- **Lifetimes:** reset tokens last one hour and work once; using one revokes every session. Verification tokens last one hour.
- **No account enumeration:** reset and resend requests get the same response for every address, and mail delivery runs after the response, so it can't change its timing.
- **Account deletion** needs the current password and a typed confirmation phrase, and administrators must be demoted first. Password changes need the current password and sign out other devices by default.
- **Logs** record only an error code for delivery failures, never recipients, links or tokens.

### Administration

- Every administrative read and write re-reads the actor's role and ban state from the database. Hidden controls are a convenience, never the control.
- A management request checks the actor before revealing anything about the target, so an unauthorized user can't use the response to tell whether an account exists.
- Every successful change writes exactly one audit entry, atomically with it, and refused or no-op requests write none. The audit display shows only allowlisted fields.
- The status page shows a fixed vocabulary and validated numbers: no URLs, paths, hosts, credentials or error text.

### Secrets and configuration

- Environment files are never committed; only `web/.env.example`, with placeholders, is tracked. Secrets are validated at runtime and never sent to the browser. The logger redacts password, token, cookie and authorization fields.
- A production server refuses to start with an unsafe configuration ([docs/CONFIGURATION.md](docs/CONFIGURATION.md#start-up-validation)).
- The image build has no environment, no secrets and no network during `next build`.

### Container and deployment

- **Image:** pinned Node.js and PostgreSQL base images. The app runs as uid 1000 with root-owned, read-only application files. npm and other package managers are removed, and the image contains no tests, environment files, keys or development dependencies.
- **Runtime:** a read-only root filesystem, no shared memory, exactly three writable paths, all capabilities dropped, `no-new-privileges`, and bounded processes, memory and CPU.
- **Network:** PostgreSQL has no published port and is on an internal network (on Coolify, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#1-what-runs)). The app publishes no host port; only the reverse proxy reaches it.
- **Backups** contain password hashes, sessions and personal data. They're written with private permissions and must be encrypted and copied off the host. Restore treats every backup as untrusted input, verifies it before any change, and starts the app only after the database and media agree ([docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md#5-restore)).

### Known limitations

- Browser tests cover one engine (Chromium) at one desktop and one phone size. There's no automated screen-reader or full WCAG audit.
- With `TRUST_PROXY=false`, one client can use up an authentication endpoint's limit, or the analytics ingestion budget, for everyone, and visitor counts are unavailable.
- Email queued just before the server stops can be lost, and an account audit entry can be lost if the server crashes between the account change and the audit write.
- Email addresses and phone numbers that owners publish are readable by anyone, including scrapers.
- Link blocks may point at any http or https host the owner chooses, including private addresses. Visitors' browsers follow them; the server never does.
- Theme contrast checks don't model blur effects. Over background images, contrast is checked conservatively without analysing the image.
- Audit entries are kept indefinitely, and administrators can see every account's email address.
- Uploaded media is stored locally, so only one app replica is supported.
- Images are decoded natively by libvips. Re-encoding and the size limits reduce the impact of a decoder bug but can't remove it, so keep sharp and libvips updated. sharp's timeout isn't enforced inside its metadata call, so a stuck call keeps its decode slot.
- Email-address changes, session lists, two-factor authentication, invitations and administrator-initiated account deletion aren't implemented.
