import { runAxiCli } from "axi-sdk-js";
// The SDK renders command output itself but does not re-export its encoder,
// so the static top-level help encodes through the same official TOON library.
import { encode } from "@toon-format/toon";
import { CREDENTIAL_HELP, hasCredentials, listSites, resolveSite } from "./api.js";
import { BIN } from "./args.js";
import { inspectCommand, sitemapsCommand, sitesCommand } from "./commands/index-tools.js";
import {
  compareCommand,
  opportunitiesCommand,
  performanceCommand,
  query,
  totals,
} from "./commands/performance.js";
import { setupCommand } from "./commands/setup.js";
import { previous, window } from "./range.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Read Google Search Console — search performance, indexing status, and sitemaps";

const HOME_ROWS = 5;

export const TOP_HELP = `${encode({
  usage: `${BIN} [command] [args] [flags]`,
  commands: {
    "(none)": "dashboard — this month's search traffic and top queries",
    sites: "list, add — properties this account can reach, and claiming new ones",
    performance: "clicks, impressions, CTR, position by query, page, country, device",
    compare: "this window against the one before it",
    opportunities: "queries ranking 4-20 with real volume",
    inspect: "whether Google indexed a URL, and what it saw",
    sitemaps: "list, submit",
    setup: "hooks, status, uninstall",
  },
  globals: { "--site": "Target property (or GSC_SITE)" },
  auth: "GOOGLE_APPLICATION_CREDENTIALS (service account), or GSC_CLIENT_ID/SECRET/REFRESH_TOKEN",
  note: "Search Console finalises data on a 2-3 day delay; windows end there, not today",
  examples: [
    BIN,
    `${BIN} performance --by page --range 90d`,
    `${BIN} opportunities`,
    `${BIN} compare --by query`,
    `${BIN} inspect https://example.com/post`,
  ],
  help: [`Run \`${BIN} <command> --help\` for a command reference`],
})}\n`;

/**
 * AXI §8: no-args shows live state. Missing credentials are reported as data
 * with a fix, not as a failure — this view is what a SessionStart hook runs.
 */
async function home() {
  if (!hasCredentials()) {
    return { search: "no Google credentials in the environment", help: CREDENTIAL_HELP };
  }

  const sites = await listSites({});
  if (sites.length === 0) {
    return {
      search: "0 Search Console properties visible to this account",
      help: [
        "Add the account as a user on the property: Settings -> Users and permissions",
        "A service account needs its `client_email` added there",
      ],
    };
  }
  if (sites.length > 1 && !process.env.GSC_SITE) {
    return {
      count: `${sites.length} properties`,
      sites: sites.slice(0, HOME_ROWS).map((entry) => entry.siteUrl),
      help: [
        `Run \`${BIN} performance --site <property>\` for one of them`,
        "Export GSC_SITE to make one the default",
      ],
    };
  }

  const site = await resolveSite(undefined);
  const dates = window({});
  const before = previous(dates);
  const [current, prior, queries] = await Promise.all([
    totals(site, dates),
    totals(site, before),
    query(site, dates, { dimensions: ["query"], rowLimit: HOME_ROWS }),
  ]);

  if (current.impressions === 0) {
    return {
      site,
      window: `${dates.startDate}..${dates.endDate}`,
      search: "0 impressions in this window",
      help: [
        `Run \`${BIN} performance --range 90d\` for a wider window`,
        `Run \`${BIN} sitemaps\` to check Google has read a sitemap`,
      ],
    };
  }

  const change = prior.clicks ? Math.round(((current.clicks - prior.clicks) / prior.clicks) * 100) : null;
  return {
    site,
    window: `${dates.startDate}..${dates.endDate}`,
    clicks: change === null ? current.clicks : `${current.clicks} (${change >= 0 ? "+" : ""}${change}% vs previous)`,
    impressions: current.impressions,
    ctr: `${(current.ctr * 100).toFixed(1)}%`,
    position: Number(current.position.toFixed(1)),
    top_queries: queries.map((entry) => ({
      query: entry.keys?.[0] ?? "-",
      clicks: entry.clicks,
      position: Number((entry.position ?? 0).toFixed(1)),
    })),
    help: [
      `Run \`${BIN} opportunities\` for queries ranking 4-20`,
      `Run \`${BIN} performance --by page\` for the pages earning this`,
      `Run \`${BIN} compare --by query\` for what moved`,
    ],
  };
}

export async function main() {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home,
    commands: {
      sites: sitesCommand,
      performance: performanceCommand,
      compare: compareCommand,
      opportunities: opportunitiesCommand,
      inspect: inspectCommand,
      sitemaps: sitemapsCommand,
      setup: setupCommand,
    },
  });
}
