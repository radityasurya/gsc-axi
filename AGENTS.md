# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build,
test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

`gsc-axi` is a direct client for the Google Search Console API, in the same shape as
`cloudflare-axi` and `openpanel-axi`: plain ESM JavaScript, npm, `node:test`, no build step.

## No `googleapis` dependency, on purpose (`src/api.js`)

The service-account flow is: build a JWT, sign it RS256, POST it to `oauth2.googleapis.com`
as a `jwt-bearer` assertion. `node:crypto` signs RS256, so that is about twelve lines. Pulling
in `googleapis` for it would add an order of magnitude more install weight than the whole rest
of this tool, and `npx -y gsc-axi` pays that download on every cold run.

`tests/helpers.js` generates a real RSA key so the signing path is exercised rather than
stubbed — a mocked signature would not have caught a malformed assertion.

## Windows must end before today (`src/range.js#LAG_DAYS`)

Search Console finalises data on a 2-3 day delay. A range ending today therefore always shows
the last two days near zero, which reads as a traffic collapse. Every named range ends
`LAG_DAYS` back. This is the single most important behaviour in the tool: it is the difference
between "traffic is fine" and a false alarm, and no amount of correct API usage fixes it.

`dataState: 'final'` is also sent on every query, so partial days are excluded server-side too.

## The two property shapes are different properties (`src/api.js#resolveSite`)

`https://example.com/` (URL-prefix) and `sc-domain:example.com` (domain) are distinct
properties, and an account often has only one of them. Passing the wrong string returns a 404
whose message does not mention the other shape. `resolveSite` accepts a bare domain, compares
against both normalised forms, and refuses when both exist — the same refuse-to-guess rule the
sibling tools apply to ambiguous names.

Unverified entries are filtered out of `listSites`: they appear in `/sites` with
`permissionLevel: siteUnverifiedUser` and then 403 on every actual query, so surfacing them
only produces a confusing failure one step later.

## A 403 is a permissions row, not a bad key

The most common Search Console failure is a service account whose `client_email` was never
added under Settings → Users and permissions. The credentials are fine; the property does not
know about them. The 403 translation says that, because "check your credentials" sends the
reader to Google Cloud, which is the wrong place.

## The API cannot filter on position (`src/commands/performance.js`)

`dimensionFilterGroups` supports query, page, country, device, and searchAppearance — not
position or impressions. `opportunities` therefore pulls a wide page (1000 rows) and filters
locally, and reports `N of M queries` so the ratio is visible rather than implied.

## `searchAnalytics` is a POST with a body

Unlike the rest of the API it takes its parameters as JSON, not query string. Filters go in
`dimensionFilterGroups[].filters[]`, and device values must be **upper case** (`MOBILE`), while
country is a lower-case 3-letter code (`nld`). Both are silently ignored if cased wrongly,
which returns unfiltered data that looks filtered.

## Release process

Releases are cut by release-please from conventional commits on `main`; merging the bot's
release PR publishes to npm via trusted publishing (OIDC). Register the trust relationship
once, against the workflow filename:

```sh
npm trust github gsc-axi --repo radityasurya/gsc-axi --file release-please.yml --allow-publish
```

A new repository also needs **Settings → Actions → Workflow permissions** set to read/write
with "Allow GitHub Actions to create and approve pull requests" enabled, or release-please
builds the branch and then cannot open the PR.

## Verified against a live property (2026-09-06)

Every read command has been run against a real Search Console property with real
traffic. Four output defects only showed up there, none of which a stub would have
produced — the stub returns what the test author imagined, not what Google sends:

- **`help: []`** on a passing `inspect`. The ternary returned an empty array rather than
  omitting the key. AXI §9: a detail view that answers the question takes no suggestions,
  and an empty `help` is worse than none — it looks like the tool had nothing to say.
- **`mobile: VERDICT_UNSPECIFIED`.** Google's enum for "this check produced no data",
  which read as a result. `verdict()` filters it, along with `richResultsResult`.
- **The help suggested the view already on screen** — `performance --by page` recommending
  `--by page`. Now dimension-aware.
- **`errors: "0"`.** The sitemaps API returns counts as strings, so they came through
  quoted and would sort lexically. Coerced to numbers.

## Position is the one inverted metric (`src/commands/performance.js#direction`)

Every other number is better when it grows. Average position is better when it *shrinks*, so
`compare` prints `25.0 (was 11.4, worse)` rather than leaving a reader — human or agent — to
infer the direction from a bare pair of numbers. On the reference property clicks rose 33%
while position fell from 11.4 to 25.0; reporting only the clicks would have been a
misleading summary of the same window.

## The token cache must be keyed by scope (`src/api.js#accessToken`)

`sitemaps submit` lists the existing sitemaps before it PUTs. The list is a read, the PUT is
a write, and they need tokens minted for different scopes. A single process-level `cached`
token meant the write reused the read-only one, and Google answered:

```
403 Request had insufficient authentication scopes.
```

Only a real write against a real property surfaced this — every test stubbed the token
endpoint and never inspected which scope was requested. `tests/api.test.js` now decodes the
JWT assertions and asserts one token per scope.

## Google returns 403 for two unrelated causes

"This account has no access to that property" and "the token lacks the scope for this
operation" are the same status code. Translating both to the former sends someone to
Search Console's user list when the credential was the problem — the same failure this tool
criticises in other APIs. `apiError` branches on `/insufficient (authentication )?scope/`.

## Verified against a live property with a service account (2026-09-06)

The service-account JWT path — the one the README recommends and the most bespoke code in
the tool — was exercised end to end: `sites` (returns only the properties the service account
was added to, 1 versus 7 for a personal OAuth grant), the dashboard, `performance`,
`compare`, `opportunities`, `inspect`, `sitemaps`, and `sitemaps submit`.
