# Development guide

**Requirements:** Node.js 24 or newer (the production image uses Node.js 24.22.2), npm, Docker with Compose v2, and Git. The browser tests use an installed Microsoft Edge or Chrome. The examples use POSIX shell syntax; on Windows they work in Git Bash, and PowerShell equivalents are noted where they differ. Run commands from `web/` unless noted.

## Compose files

| File | Purpose | Never use it for |
|---|---|---|
| `compose.dev.yaml` | Local services only: PostgreSQL 17 and Mailpit, with ports bound to 127.0.0.1. The app runs on the host (`npm run dev`). | Production: its credential is a local placeholder and its images aren't pinned. |
| `compose.prod.yaml` | Production: `db`, `migrate` and `app`, built from `web/Dockerfile` ([DEPLOYMENT.md](DEPLOYMENT.md)). | Local development: it publishes no ports and needs real secrets. |
| `compose.smoke.yaml` | An override for isolated verification only: publishes the app on 127.0.0.1 and accepts an http loopback `APP_URL`. Used by `npm run test:deploy`. | Any deployment. |

## 1. First-time setup

```sh
# From the repository root: PostgreSQL 17 and Mailpit, bound to 127.0.0.1 only.
docker compose -f compose.dev.yaml up -d

cd web
npm install
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
# Generate secrets for BETTER_AUTH_SECRET and SETUP_TOKEN, and paste them into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm run db:migrate
```

On Windows, use `127.0.0.1` rather than `localhost` in `DATABASE_URL`: the development container publishes only on IPv4, and `localhost` may try IPv6 first and stall.

## 2. Database migrations

| Task | Command |
|---|---|
| Generate a migration after editing `src/db/schema/*` | `npm run db:generate -- --name <short_name>` |
| Apply pending migrations to `DATABASE_URL` | `npm run db:migrate` |

`db:migrate` runs `scripts/migrate.mjs`, which holds a PostgreSQL advisory lock so concurrent starts can't race. Review generated SQL before applying it, and never use `drizzle-kit push` against a shared or production database. New migrations follow the expand/contract rule in [BACKUP_RESTORE.md](BACKUP_RESTORE.md#rollback).

If `/setup`, `/register` or the editor fail with a missing table or column, your development database needs `npm run db:migrate`. Automated tests never touch the development database.

## 3. Running the app

```sh
npm run dev          # http://localhost:3000
npm run build        # production build
npm run start        # serve the production build
```

Open `/setup`, enter `SETUP_TOKEN` and the administrator's details, and you're signed in as the super administrator. Public sign-up follows `REGISTRATION_ENABLED` once setup is done.

- `next.config.ts` sets `output: "standalone"` for the image, so `npm run start` warns that `next start` doesn't work with it. It still serves the build, and the test runners use it.
- `next build` needs **no database** and no environment: missing settings get inert placeholders during the build only.
- A production server validates its configuration at start-up and exits with code 78 if it's unsafe, so `npm run start` with the development `.env` fails because `APP_URL` isn't https. For a local production run on `http://localhost`, add `COVALINK_ALLOW_LOOPBACK_APP_URL=true`, as the test runners do.
- Without SMTP settings, development logs email text, links included. With the Mailpit service running, set `SMTP_HOST=127.0.0.1` and `SMTP_PORT=1025` and read messages at `http://localhost:8025`.
- Locally, `TRUST_PROXY` is normally unset, so analytics views get no visitor hash. Headless browsers and tools such as `curl` count as bots, and your own signed-in visits as the owner, so test views from a private window or a second account.

**Maintenance commands:**

```sh
npm run media:gc                                   # dry run: counts and up to 20 orphan keys
npm run media:gc -- --apply --min-age-hours=24     # delete orphan and temporary files older than 24 hours
npm run analytics:purge -- --dry-run               # counts only
npm run analytics:purge                            # delete expired analytics and old salts
```

Uploaded media is stored under `STORAGE_LOCAL_PATH` (default `./data/uploads`, ignored by Git) as `{hh}/{hh}/{uuid}.webp`, with in-flight uploads in `tmp/`. Back up the database and the media together.

## Quality checks

| Check | Command | Needs PostgreSQL |
|---|---|---|
| Types | `npm run typecheck` | no |
| Lint | `npm run lint` | no |
| Unit tests | `npm run test:unit` | no |
| Integration tests | `npm run test:integration` | yes, `TEST_DATABASE_URL` |
| Unit and integration | `npm test` | yes |
| HTTP end-to-end tests against the production build | `npm run build && npm run test:e2e` | yes, `E2E_DATABASE_URL` |
| Browser workflows (Playwright with installed Edge) | `npm run build && npm run test:browser` | yes, `E2E_DATABASE_URL` |
| Build without a database | `npm run verify:offline-build` | no |
| End-to-end and browser suites against the production image | `E2E_SERVER_IMAGE=covalink:<tag> npm run test:e2e`, then the same for `test:browser` | yes, `E2E_DATABASE_URL` |
| Deployment smoke and security checks: builds the image, runs throwaway Compose stacks, and drills backup and restore | `npm run test:deploy` (add `-- --keep` to leave the stacks up) | no; needs Docker, bash and Edge |
| Public boundary check | `node .boundary/check.mjs --dir .` (from the repository root) | no |
| Boundary validator tests | `node --test ".boundary/test/*.test.mjs"` (from the repository root) | no |
| Candidate gate regression tests | `node --test "release/gates/test/*.test.mjs"` (from the repository root) | no; needs Docker |

- The boundary check in folder mode looks at what the repository would publish: tracked files, and untracked files that `.gitignore` doesn't exclude. Ignored files such as `web/.env` and build output aren't checked.
- `npm run test:deploy` keeps the image it builds, so you can pass it to `E2E_SERVER_IMAGE`. With `SMOKE_PREVIOUS_TAG=<tag of the previous release image>` it also checks that the previous image still runs on the current schema. With `SMOKE_IMAGE=<image>@sha256:<digest>` it pulls that published image by digest and tests it instead of building one. It removes every project, network and volume it creates. On Windows it runs `ops/*.sh` with Git for Windows' bash; set `SMOKE_BASH` to use another.
- **Real-provider check (manual):** `tests/browser/embed-real-providers.spec.ts` is skipped unless `EMBED_CONFIRM_OUT` names a results file outside the repository, because it contacts YouTube, Vimeo, Spotify and SoundCloud. No automated suite contacts a provider.
- **Stale CSS:** `next build` can reuse old `globals.css` output from a previous `.next` folder. After editing `globals.css`, delete `.next` before a build you'll test against.

### Test databases

Integration, end-to-end and browser tests **delete data**, so they refuse to run unless the target database:

- is on a loopback host (`localhost`, `127.0.0.1` or `::1`);
- has a name ending in `_test`;
- has a different database name from the `DATABASE_URL` database (host aliases and ports don't count as different);
- carries the marker comment `covalink-isolated-test-database`.

Create and migrate them (this creates them if missing and never drops anything):

```sh
npm run db:test:prepare   # TEST_DATABASE_URL -> covalink_test
npm run db:e2e:prepare    # E2E_DATABASE_URL  -> covalink_e2e_test (test:e2e also does this)
```

`npm run test:e2e` and `npm run test:browser` each start three production servers with throwaway secrets and temporary media folders: one on the E2E database, one with an unreachable database and one with a database that never answers. They run `tests/e2e` (Vitest over HTTP) or `tests/browser` (Playwright) against them, then stop them.

The browser suite uses the locally installed Microsoft Edge, so no Playwright browser download is needed. Set `PW_CHANNEL=chrome` to use Chrome. If browser tests time out on clicks, or a page stays on "Loading…" while the server is fast, `requestAnimationFrame` may be stalled: on some Windows hosts, while the display is idle, GPU vsync slows headless Chromium to about one frame every few seconds. Set `PW_DISABLE_GPU=1` to use software rendering. Failure traces and screenshots go to `web/test-results/playwright/`.

## Architecture

COVALink is a modular monolith: one Next.js application (App Router, React Server Components) over one PostgreSQL database, accessed through Drizzle ORM. Better Auth handles accounts and sessions, and Zod validates every input at the server boundary.

```
web/src/app            routes: auth pages, /dashboard, /admin, public profiles, API routes
web/src/features       domain services: setup, settings, admin, account, profiles, blocks, themes, media, analytics
web/src/components     UI: the editor, the shared profile renderer, admin and account screens, ui/ primitives
web/src/lib            auth, environment, logging, mail, security headers, validation, health
web/src/db             Drizzle schema and SQL migrations
web/scripts            migrations, test-database guards, test runners, media:gc, analytics:purge, health check, notices
web/tests              unit, integration, e2e, browser and deploy suites, with shared support code
web/third-party        pinned upstream license texts, extracted component notices and release pins
web/Dockerfile         the production image
ops/                   backup and restore scripts for operators
release/               release pins, the source-bundle tooling and the candidate gates
.github/workflows/     the boundary check and the release workflows
.boundary/             the public boundary check and its rules
```

**Principles the code follows:**
- **Authorization lives in the services,** not only in pages or hidden controls. Every service call re-checks the session or the actor's role, and every query is scoped to the resources the caller owns.
- **One rendering path:** the public page and the editor preview use the same renderer and the same validated data, so the preview shows what will be published.
- **Profiles are draft and published documents.** The editor writes the draft under an expected revision; publishing copies a validated draft. Public pages read only the published snapshot and check visibility on every request.
- **Blocks are typed and versioned.** Each block type has a strict schema per version, an editor and a renderer. A stored block the code can't reproduce exactly protects its draft rather than being rewritten.
- **Input is untrusted until validated on the server,** and errors returned to clients contain only fixed messages.
- **Operational endpoints and logs use fixed vocabularies,** never hosts, connection strings or secrets.

## Third-party notices

`web/THIRD_PARTY_NOTICES.txt` is generated by `web/scripts/third-party-notices.mjs` and must not be edited by hand. It covers every production npm package for Linux on amd64 and arm64, the packages Next.js vendors, the base image's Alpine packages, the license and copyright files of the components in the source bundle, Node.js, and copied source code. The generator uses the pinned texts in `web/third-party/sources.json` and the extracted texts in `web/third-party/component-notices.json`, and never contacts the network. The same file ships in the image, byte for byte.

**Component notices:** `web/third-party/component-notices.json` is generated from a source bundle (see "Releases") by `release/source-bundle/extract-notices.mjs` and must not be edited by hand. Regenerate it, then the notices file, whenever the base image, the Alpine security update or the sharp-libvips version changes:

```sh
. release/config.env
bash release/source-bundle/build.sh "$WORK"      # WORK: an empty folder outside the repository; downloads about 600 MB
docker run --rm --network none -v "$WORK/bundle:/b:ro" -v "$PWD:/repo" -w /repo --entrypoint node "$NODE_IMAGE" \
  release/source-bundle/extract-notices.mjs /b web/third-party/component-notices.json
```

Add `--check` to confirm that the committed file matches a bundle. The release workflow runs that check on every candidate.

**The notices file:** regenerate it after changing dependencies, the base image or the Alpine security update. The generator runs inside the image's patched base (the pinned base image with the update applied; `release/patched-base.sh` builds it from `web/Dockerfile`), so the Alpine package database and Node.js version are the image's own. From the repository root (the volume holds only throwaway installs):

```sh
BASE=$(bash release/patched-base.sh)
docker run --rm -v covalink-notices:/work -v "$PWD/web:/src:ro" "$BASE" sh -c '
  set -e
  for arch in x64 arm64; do
    rm -rf /work/$arch && mkdir -p /work/$arch && cp /src/package.json /src/package-lock.json /work/$arch/
  done
  cd /work/x64 && npm ci --ignore-scripts --no-audit --no-fund
  cd /work/arm64 && npm ci --ignore-scripts --no-audit --no-fund --cpu=arm64 --os=linux --libc=musl'
docker run --rm --network none -v covalink-notices:/work -v "$PWD/web:/src" -w /src "$BASE" \
  node scripts/third-party-notices.mjs --modules /work/x64/node_modules --modules /work/arm64/node_modules
docker volume rm covalink-notices
```

Add `--check` to the generator command to confirm that the committed file is current without rewriting it. In Git Bash on Windows, prefix both `docker run` commands with `MSYS_NO_PATHCONV=1`.

**Adding a license text:** if the generator reports that it has no standard text for a license, add that license's entry from the SPDX license list to `web/third-party/sources.json`, with its source URL and SHA-256, in the same form as the existing entries.

**The boundary check** records a SHA-256 for the notices file and for `component-notices.json` in `.boundary/rules.json`. Update those hashes in the same change that regenerates the files.

## Releases

Images are published to the GitHub Container Registry by two manually dispatched workflows, run on a tag `v<version>` whose commit is on `master`. Every third-party action is pinned to a full commit SHA, every container image used by the tooling is pinned by digest in `release/config.env`, and each job starts with `release/guard.sh`, which refuses any other ref, version or commit.

1. **Release candidate** (`.github/workflows/candidate.yml`) refuses if the version is already in production. It builds the source bundle and checks `component-notices.json` against it. It reuses the published bundle when its manifest is byte-identical, and otherwise pushes the new bundle to the private staging package. It then builds the image for `linux/amd64` with no cache, an SBOM and minimal provenance, with the bundle's digest in `/app/SOURCE_BUNDLE` and the `io.covalink.source-bundle` label, and pushes it to the private staging package. The same job then rebuilds the commit from scratch and compares the two builds (the rebuild gate). A second job runs every other candidate gate against that digest and writes `candidate-report.json`, which passes only if every gate passed.

2. **Promote release** (`.github/workflows/promote.yml`) requires approval through the protected `release` environment. It first confirms the environment's protection. It then confirms the candidate run and report name the same digest, tag and commit, and that the version isn't in production. It copies the bundle (or confirms the reused one) and then the image, by digest, to the production packages, and reads both back. For every release after the first, the bundle must also be retrievable anonymously before the image is tagged. A last job attests the production digest and verifies the attestation.

**Pinned build toolchain:** `web/Dockerfile` starts with a `# syntax=` line that pins the Dockerfile frontend by digest, and every release workflow runs its builder on the BuildKit image pinned in `release/config.env` (`DOCKERFILE_FRONTEND`, `BUILDKIT_IMAGE`). `release/toolchain-check.sh` refuses to continue unless the builder reports that BuildKit version and the Dockerfile names that frontend. The rebuild gate also checks the frontend recorded in the candidate's provenance and the one the comparison rebuild resolved. Both pins are recorded in the source bundle's `MANIFEST.json` and in `candidate-report.json`, and the report fails if the build record doesn't name them.

**Reproducible builds:** a release build passes the full commit SHA as `GIT_SHA`, which `web/next.config.ts` uses as the Next.js build ID. Next.js also embeds a Server Actions encryption key in the build output. The candidate job generates one random 32-byte key per run, gives it to the candidate build and the comparison rebuild only as the BuildKit secret `server_actions_key`, and deletes it before the job ends.

The key ends up in the image's server files, as it does in every Next.js build. Anyone with the published image can recover it, so it isn't a secret, and it must not be used as a repository, workflow, deployment or runtime secret. What the process controls is that it appears nowhere else. The workflow never prints it, never passes it as a build argument or job output, and never stores it in an artifact. The rebuild gate checks that both builds embed it (`keyEmbeddedInBothBuilds`). It fails if the key appears in either image's history or configuration, the candidate's provenance or the rebuild log (`keyLeakedOutsideBuildOutput`). Builds without the secret, such as local ones, get a random key and build ID as usual.

The two builds must then be byte-identical, file by file, with six exceptions, each narrowly normalized: the three draft-mode values Next.js generates at random in `.next/server/preview-props.json` and in the `preview` object of `.next/prerender-manifest.json`, and the single random fallback-parameter placeholder in each of four prerendered route segments. Exactly those six files must differ, the JSON files must parse with exactly those fields in their expected formats, and each segment must hold exactly one placeholder for its own route parameter. Because the `[handle]` segment's final row records the byte length of its static stage, which includes the placeholder, that one value may differ too, but only after it's recomputed from the file's own bytes: it must equal the offset where the trailing completion rows (one `true` row, then `C` rows) begin, with the same row ID in both builds. The `[id]` segments must have no such row. These rules (`KNOWN_DIFFERENCES` in `release/gates/checks.mjs`) apply to Next.js 16.4.3 only; with any other version the gate fails until they're reviewed again. Docker's per-container `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` aren't image content and aren't compared.

**Candidate gates** (`release/gates/candidate-gates.mjs`, with their decision rules in `release/gates/checks.mjs` and regression tests in `release/gates/test/`, assembled by `release/gates/report.mjs`): a no-cache rebuild with the same commit and key, with the offline build step, the same build ID, equal file lists and labels, byte-identical files apart from the six known differences above, the pinned toolchain, and the key embedded in both builds' output and leaked nowhere else; the image's identity (digest, revision label and `COVALINK_GIT_SHA`); its contents (no dev dependencies, required license files, no forbidden paths); a secrets scan and minimal provenance; the attached SBOM against an independent scan; vulnerabilities, under the policy below; a non-root runtime whose application files it can't write; the notices file, byte-identical between a fresh generation, the repository and the image; the source bundle, which must be the one the image names and must cover every Alpine package, the sharp-libvips version and the shipped library's recorded checksum (`web/third-party/upstream-libvips.json`); replacing libvips in a derived image; and the deployment smoke test against the published digest (`SMOKE_IMAGE`).

**Vulnerability policy:** a critical finding blocks, as does a high finding with a fix. A high finding without a fix blocks unless `web/third-party/vulnerability-exceptions.json` holds an exception for that digest naming the finding, package and reason, naming `COVADigital` as approver, and expiring within 30 days. Medium and low findings are reported. A scanner failure blocks.

**Source-bundle tooling** (`release/source-bundle/`): `build.sh` builds a bundle in stages (a rerun skips finished ones), `verify.mjs` checks one offline, `extract-notices.mjs` derives the component notices, `retrieve.mjs` downloads one by digest with no credentials, and `pack.Dockerfile` packs one as an image. The gates and bundle scripts can be run locally against a local registry on `127.0.0.1`; `retrieve.mjs --insecure-http` is for such registries only.
