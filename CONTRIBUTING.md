# Contributing to COVALink

Thank you for helping. This guide covers how to propose a change and what a pull request needs.

**Security problems:** please don't open a public issue or pull request. Report them privately as described in [SECURITY.md](SECURITY.md).

## Before you start

- **For a bug,** open an issue describing what happened, what you expected, and how to reproduce it, with the version or commit you used. Don't include real people's data, secrets or private addresses.
- **For a new feature or a larger change,** open an issue first to discuss it, so the work fits the project's direction before you invest in it.
- Small fixes, such as typos or obvious bugs, can go straight to a pull request.

## Development setup

Follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). It covers the local database, the environment file, running the app and the test suites.

## Making a change

- **Keep changes focused.** One pull request should do one thing. Avoid unrelated refactoring or formatting.
- **Follow the existing patterns:** strict TypeScript, Zod validation at server boundaries, authorization inside the service layer, Server Components by default, and the existing UI components and design tokens. The architecture notes in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#architecture) describe the main principles.
- **Treat every input as untrusted** until it's validated on the server, and check ownership for reads as well as writes.
- **Keep the interface accessible:** semantic HTML, labels, keyboard support, visible focus, sufficient contrast, layouts that work on small screens, and respect for reduced-motion preferences.
- **Add or update tests** for any change in behavior. Bug fixes should include a test that fails without the fix.
- **Database changes** need a reviewed migration generated with `npm run db:generate`, following the expand/contract rule in [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md#rollback).
- **Dependencies:** add one only when it's clearly worth its maintenance and security cost, and explain why in the pull request. Changing dependencies or the base image means regenerating the third-party notices ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#third-party-notices)).
- **Documentation:** update the guides in `docs/` when behavior that installers, operators or users rely on changes. The repository holds only the documents listed in `.boundary/manifest.json`; adding a new document needs a change to that list.

## Before you open a pull request

From `web/`, run:

```sh
npm run typecheck
npm run lint
npm test               # unit and integration tests; needs the test database
```

For changes that affect pages or HTTP behavior, also run `npm run build`, then `npm run test:e2e` and `npm run test:browser`. For changes to the Dockerfile, Compose files or `ops/` scripts, run `npm run test:deploy`. From the repository root, run the public boundary check, and its tests if you changed anything under `.boundary/`:

```sh
node .boundary/check.mjs --dir .
node --test ".boundary/test/*.test.mjs"
```

## Pull requests

- Describe what changed and why, and link the issue it addresses.
- List the checks you ran and their results, and anything you couldn't test.
- Keep commits focused and their messages descriptive.
- Every pull request runs the boundary check. Changes to documentation, `.gitignore` or the boundary rules also need a maintainer's approval before they can be merged.
- A maintainer will review your pull request. Please be patient, and expect questions or requests for changes.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0, the same license as the project ([LICENSE](LICENSE)). Don't submit code or assets you don't have the right to contribute under that license.
