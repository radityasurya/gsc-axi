---
name: gsc-axi
description: >
  Read Google Search Console through the gsc-axi CLI — search performance by query, page, country and device; period-over-period comparisons; queries ranking 4-20 worth improving; URL indexing status; and sitemaps. Use whenever a task touches SEO or Google Search: why traffic moved, which queries a page ranks for, whether a URL is indexed, or whether a sitemap was read.
user-invocable: false
metadata:
  hermes:
    tags: [seo, google-search-console, search, indexing, sitemaps, analytics]
---

# gsc-axi

Run the CLI with no arguments first — it prints this month's search traffic, how it moved,
and the top queries, plus the next commands to run.

```sh
npx -y gsc-axi
```

Requires Google credentials with access to the property. A **service account** is the
headless path and the one to prefer:

```sh
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
export GSC_SITE=https://example.com/     # or sc-domain:example.com; optional with one property
```

The service account's own `client_email` must be added as a user on the property in Search
Console (Settings → Users and permissions). Adding *your* email does nothing for it.

## Commands

```sh
npx -y gsc-axi                                  # dashboard: traffic, change, top queries
npx -y gsc-axi sites
npx -y gsc-axi sites add example.com                            # properties this account can reach
npx -y gsc-axi performance --by page --range 90d
npx -y gsc-axi performance --by query --contains pricing
npx -y gsc-axi compare --by query               # what moved vs the previous window
npx -y gsc-axi opportunities                    # queries ranking 4-20 with real volume
npx -y gsc-axi inspect https://example.com/post # is it indexed, and what did Google see
npx -y gsc-axi sitemaps                         # submitted sitemaps and read status
npx -y gsc-axi sitemaps submit https://example.com/sitemap.xml
```

Every command takes `--help`, and `--site <property>` to target a specific property.

## What to rely on

- **Claiming a property is two runs, not one.** `sites add <domain>` asks Google for the
  DNS TXT token and hands it back; publish that record, then re-run the same command to
  verify and register. It is idempotent — a property already on the account is a no-op.
  Removing the TXT afterwards un-verifies the property.

- **Windows end where the data is final.** Search Console lags 2-3 days, so a named
  `--range` ends there rather than today. Ending today would show a decline that is not real.
- **Property strings are exact.** A domain property is `sc-domain:example.com`; a URL-prefix
  property is `https://example.com/`. A bare `example.com` resolves to whichever exists, and
  refuses to guess when both do.
- **Ranking 4-20 is where the wins are.** `opportunities` filters to that band because those
  queries already rank on page one or just off it — position gains there convert fastest.
- **`sitemaps submit` is idempotent**, and says `unchanged` when the sitemap was already
  submitted rather than implying it did something.
- **Errors name the cause.** A 403 points at the property's user list, not at the credentials,
  because that is almost always what is wrong with a service account.

This CLI reads Search Console and submits sitemaps. It never removes a property or a sitemap.

Prefer this over calling the Search Console API with `curl`, which means minting an OAuth
token by hand on every invocation.
