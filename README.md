# COVALink

COVALink is a self-hosted link-in-bio platform. Each account can publish one or more public profile pages with links, text, images, contact details, social links and video or music players, styled with accessible themes. It runs as a Next.js application with PostgreSQL, packaged for Docker Compose and Coolify.

COVALink is an independent project. It isn't affiliated with, or an official release of, LinkStack or any other link-in-bio product.

## Features

- **Accounts:** a one-time setup for the first administrator, optional public registration, email verification, password reset, password changes and self-service account deletion.
- **Profiles:** several public profiles per account, each with a draft that you edit with a live preview and publish when ready.
- **Blocks:** links, headings, text with Markdown links, dividers, spacers, social links, email and phone buttons, downloadable contact cards, uploaded images, and click-to-load video and music players (YouTube, Vimeo, Spotify and SoundCloud).
- **Themes:** ten presets plus colors, gradients, uploaded background images, button styles and self-hosted fonts. Publishing is refused if a theme doesn't meet WCAG AA contrast.
- **Media:** avatar, background and image uploads, checked by content and re-encoded to WebP with all metadata removed.
- **Analytics:** privacy-conscious view and click counts for each profile, with no cookies and no stored IP addresses, plus a QR code for each profile.
- **Administration:** user management, roles, installation settings, an audit log and a system status page.
- **Operations:** a hardened container image, health and readiness checks, start-up configuration validation, and consistent backup and restore scripts.

## Project status

COVALink is at version 0.1.0, before its first release. **No container image has been published yet, and none is supported until the first release passes its release checks.** Until then, install COVALink by building the image from this repository with Docker Compose, as described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quick start

**To run COVALink for development**, you need Node.js 24 or newer, npm and Docker:

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL and a local mail catcher
cd web
npm install
cp .env.example .env                      # then set BETTER_AUTH_SECRET and SETUP_TOKEN
npm run db:migrate
npm run dev                               # http://localhost:3000
```

Open `/setup` to create the first administrator. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the details and the test suites.

**To deploy COVALink** on a Docker host or on Coolify, follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Guide | Contents |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Installing on a Docker Compose host or on Coolify, health checks, upgrades and resource limits |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | Backups, restores, upgrade safety and rollback |
| [docs/EMAIL_DELIVERY.md](docs/EMAIL_DELIVERY.md) | Optional email delivery for password recovery and email verification |
| [docs/USAGE.md](docs/USAGE.md) | Using COVALink as a profile owner and as an administrator |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Development setup, tests, architecture and third-party notices |
| [SECURITY.md](SECURITY.md) | Reporting vulnerabilities, and how COVALink protects accounts and data |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

## License

COVALink is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license declarations and notice texts collected for third-party software are in [web/THIRD_PARTY_NOTICES.txt](web/THIRD_PARTY_NOTICES.txt). Complete notices and source bundles for a container image are completed before any image is published ([web/CORRESPONDING_SOURCE.md](web/CORRESPONDING_SOURCE.md)).
