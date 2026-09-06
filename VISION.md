# Vision

## The problem

Google Search Console has a good API and no CLI. So an agent asked "why did search traffic
drop" reaches for `curl`, and immediately hits three things that have nothing to do with the
question: minting an OAuth token, discovering which property string is verified, and finding
out the hard way that the last two days of data are always incomplete.

MCP servers exist for this. They cost tool-schema tokens on every turn of every session, and
they only work inside an agent that speaks MCP.

## What gsc-axi is

One agent-ergonomic surface over the Search Console API, following the ten
[AXI](https://axi.md) principles. Nothing loads until an agent runs it; what comes back is
TOON projected down to the fields a decision needs.

It owns four things raw API calls do not:

1. **Windows that end where the data is final.** Every named range stops 2 days short,
   because Search Console has not finished counting yet and a window ending today always
   shows a decline that is not real.
2. **Property resolution.** `example.com` finds whichever of `sc-domain:example.com` or
   `https://example.com/` is verified, and refuses to guess when both are.
3. **Errors that name the actual cause.** A 403 on Search Console is nearly always a service
   account that was never added as a user on the property — not a bad key.
4. **The 4-20 band.** `opportunities` is the one piece of judgement encoded here: queries
   already ranking on or near page one are where position gains convert to clicks.

## What it deliberately does not do

- **No deletion.** No removing properties, no deleting sitemaps. Both are one API call away
  and neither belongs on an agent's trigger.
- **No indexing API.** Requesting indexation is rate-limited, abusable, and only supported for
  job postings and livestreams — the thing people actually want it for is not what it does.
- **No credential minting from nothing.** The service account key or refresh token comes from
  the environment. This tool never logs in, opens a browser, or writes a credential to disk.
- **No interactive anything.** Every operation completes from flags alone.

## Where it could go

- **`--fields` on `inspect`**, whose payload carries far more than the index verdict.
- **Page-level query attribution** — "which queries drive this URL" is two calls today and
  could be one command.
- **Regression watch**: queries that lost position between two windows, which is `compare`
  with a sort and a threshold.
