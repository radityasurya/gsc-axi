<h1 align="center">gsc-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/gsc-axi"><img alt="npm" src="https://img.shields.io/npm/v/gsc-axi?style=flat-square" /></a>
  <a href="https://axi.md"><img alt="AXI" src="https://img.shields.io/badge/built%20with-AXI-black?style=flat-square" /></a>
</p>

<h3 align="center">Google Search Console CLI for agents.</h3>

Search performance, indexing status, and sitemaps from the shell, designed with
[AXI](https://axi.md) (Agent eXperience Interface).

Talks to the Search Console API directly. No `googleapis` dependency — the service-account
flow is an RS256 JWT, which `node:crypto` signs in a dozen lines — so the install is
[`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) and a TOON encoder.

## Why

Search Console has no CLI. Agents reach for the API and re-derive the same three things every
time: minting a token, guessing which property string is verified, and remembering that the
data lags.

- **Windows that end today show a decline that isn't real.** Search Console finalises data on
  a 2-3 day delay. Every named `--range` here ends where the data is final.
- **`https://example.com/` and `sc-domain:example.com` are different properties.** Passing the
  wrong one returns 404 with no hint. `gsc-axi` accepts a bare domain, resolves it to whichever
  is verified, and refuses to guess when both are.
- **A 403 is almost never the credentials.** It is the service account's `client_email` not
  being a user on the property. The error says that instead of sending you back to Google Cloud.

## Quick Start

```sh
npx skills add radityasurya/gsc-axi --skill gsc-axi -g
```

Then give it credentials. A **service account** is the headless path:

1. Google Cloud → create a service account → download its JSON key
2. Enable the **Google Search Console API** for that project
3. In Search Console → Settings → Users and permissions → add the service account's
   `client_email` as a user (its own address, not yours)

```sh
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
export GSC_SITE=https://example.com/    # optional when the account sees one property
```

An OAuth refresh token works too, if you already have one:

```sh
export GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=...
```

## Usage

```bash
gsc-axi                                        # dashboard — traffic, change, top queries
gsc-axi sites                                  # properties and permission level

gsc-axi performance                            # top queries
gsc-axi performance --by page --range 90d
gsc-axi performance --by country --limit 10
gsc-axi performance --by query --contains pricing --device mobile

gsc-axi compare                                # vs the preceding window
gsc-axi compare --by query                     # which queries moved, ranked by swing

gsc-axi opportunities                          # queries ranking 4-20
gsc-axi opportunities --min-impressions 200 --range 90d

gsc-axi inspect https://example.com/blog/post  # indexed? canonical? last crawl?
gsc-axi sitemaps                               # submitted, last read, errors
gsc-axi sitemaps submit https://example.com/sitemap.xml
```

### Commands

| Command | Purpose |
| --- | --- |
| *(none)* | Dashboard: clicks, impressions, CTR, position, change, top queries |
| `sites` | Properties this account can reach |
| `performance` | Break traffic down by query, page, country, device, date, or appearance |
| `compare` | This window against the one before it |
| `opportunities` | Queries ranking 4-20 with real volume |
| `inspect` | Index status, canonical, crawl time, mobile and rich-result verdicts |
| `sitemaps` | `list`, `submit` |
| `setup` | Agent session integration: `hooks`, `status`, `uninstall` |

### Windows

`--range` takes `7d`, `28d` (default), `90d`, `6m`, `12m`, `16m` — Search Console keeps 16
months and nothing older. `--start` / `--end` take `YYYY-MM-DD` and override the range.

## Behaviour worth relying on

- **Reads, plus sitemap submission.** It never deletes a sitemap or removes a property.
- **`sitemaps submit` is idempotent** — an already-submitted sitemap reports `unchanged`.
- **Refuses to guess the property** when the account sees several and none was named.
- **CTR and position are formatted** — `3.5%` and `8.4`, not `0.0352941` and `8.43219`.
- **Fails loud.** Unknown flags, ranges, and dimensions exit 2 and name the valid values.
- **TOON output** on stdout, structured errors on stdout too, diagnostics on stderr.

## Relationship to openpanel-axi

[`openpanel-axi`](https://github.com/radityasurya/openpanel-axi) also has a `gsc` command. It
reads Search Console data **that OpenPanel has synced**, which requires connecting GSC to
OpenPanel and is limited to what OpenPanel stores. `gsc-axi` talks to Google directly, needs
no OpenPanel, and covers what OpenPanel does not: URL inspection, sitemaps, arbitrary
dimension and filter combinations, and properties you do not track in OpenPanel at all.

## Development

```sh
npm install
npm test              # node:test, no framework, no network
npm run build:skill
node bin/gsc-axi.js --help
```

The suite stubs `fetch` with a route table standing in for Google, and generates a real RSA
key so the JWT signing path is exercised rather than mocked. No Google account required.

See [AGENTS.md](AGENTS.md) for architecture notes and [VISION.md](VISION.md) for scope.

## License

MIT
