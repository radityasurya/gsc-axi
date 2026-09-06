# Contributing

## Getting set up

```sh
npm install
npm test
```

Node 20+ is required; CI runs the suite on 20, 22, and 24. There is no build step and no
transpile — `bin/gsc-axi.js` runs `src/` directly.

The test suite needs no Google account and makes no network calls. It runs against a stubbed
`globalThis.fetch` with a route table, so tests assert the exact requests sent — including
the ones that must *not* be sent, such as a read with no project id.

## Before you push

```sh
npm test
npm run check:skill
```

## Conventions

- **Conventional commits.** `feat:`, `fix:`, and `docs:` drive release-please. Anything else
  will not appear in the changelog.
- **Generated files are generated.** `skills/gsc-axi/SKILL.md` comes from `src/skill.js`
  via `npm run build:skill`. `CHANGELOG.md` and `.release-please-manifest.json` belong to
  release-please. A guard workflow fails PRs that hand-edit any of them.
- **Allow-list new fields.** Output schemas are allow-lists (`DETAIL_FIELDS` and friends). A
  new upstream field should stay out of default output unless it informs a decision.
- **Reads only.** This CLI never tracks an event or writes to a project. A command that
  would mutate analytics data does not belong here — see [VISION.md](VISION.md).
- **Verify endpoints against the schema.** New paths and request bodies are checked against
  the OpenPanel API source, not recalled. See [AGENTS.md](AGENTS.md).
- **Read [AGENTS.md](AGENTS.md) first.** It documents the traps that have already bitten,
  including the project-id trap that turns a wrong id into a silent empty 200.

## Releasing

Merging the release-please PR on `main` tags the release and publishes to npm over npm
trusted publishing (OIDC) — there is no token to store. Verify afterwards with
`npm view gsc-axi version`. See [AGENTS.md](AGENTS.md) for the one-time
`npm trust` registration.
