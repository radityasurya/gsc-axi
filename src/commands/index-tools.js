import { AxiError } from "axi-sdk-js";
import { gsc, inspectionBase, listSites, resolveSite, sitePath } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

const HELP = {
  sites: helpFor({
    command: "sites",
    description: "Properties this account can reach, and its permission on each",
    usage: `${BIN} sites`,
    examples: [`${BIN} sites`],
  }),
  inspect: helpFor({
    command: "inspect",
    description: "Whether Google has indexed a URL, and what it saw",
    usage: `${BIN} inspect <url> [--site <property>]`,
    examples: [`${BIN} inspect https://example.com/blog/post`],
  }),
  list: helpFor({
    command: "sitemaps list",
    description: "Submitted sitemaps, when they were last read, and any errors",
    usage: `${BIN} sitemaps [list] [--site <property>]`,
    examples: [`${BIN} sitemaps`],
  }),
  submit: helpFor({
    command: "sitemaps submit",
    description: "Submit a sitemap (idempotent — resubmitting an existing one is a no-op)",
    usage: `${BIN} sitemaps submit <url> [--site <property>]`,
    examples: [`${BIN} sitemaps submit https://example.com/sitemap.xml`],
  }),
};

export async function sitesCommand(argv) {
  if (wantsHelp(argv)) return HELP.sites;
  parse(argv, { command: "sites" });
  const sites = await listSites({});

  if (sites.length === 0) {
    return {
      sites: "0 properties visible to this account",
      help: [
        "Add the account as a user on the property in Search Console: Settings -> Users and permissions",
        "A service account needs its `client_email` added there, not your own address",
      ],
    };
  }
  return {
    count: `${sites.length} total`,
    sites: sites.map((entry) => ({ property: entry.siteUrl, permission: entry.permissionLevel })),
    help: [
      `Run \`${BIN} performance --site <property>\` for its search traffic`,
      "Export GSC_SITE to make one the default",
    ],
  };
}

const verdict = (block) =>
  block?.verdict && block.verdict !== "VERDICT_UNSPECIFIED" ? block.verdict : undefined;

/** The inspection payload nests three verdicts an agent has to act on. */
function inspection(result) {
  const index = result?.indexStatusResult ?? {};
  return {
    verdict: index.verdict ?? "UNKNOWN",
    coverage: index.coverageState ?? "-",
    indexed: index.verdict === "PASS",
    ...(index.lastCrawlTime ? { last_crawled: String(index.lastCrawlTime).slice(0, 19).replace("T", " ") } : {}),
    ...(index.googleCanonical ? { google_canonical: index.googleCanonical } : {}),
    ...(index.userCanonical && index.userCanonical !== index.googleCanonical
      ? { your_canonical: index.userCanonical }
      : {}),
    ...(index.robotsTxtState ? { robots: index.robotsTxtState } : {}),
    // VERDICT_UNSPECIFIED is Google's "no data for this check" — printing it
    // implies a result was returned when none was.
    ...(verdict(result?.mobileUsabilityResult) ? { mobile: verdict(result.mobileUsabilityResult) } : {}),
    ...(verdict(result?.richResultsResult) ? { rich_results: verdict(result.richResultsResult) } : {}),
  };
}

export async function inspectCommand(argv) {
  if (wantsHelp(argv)) return HELP.inspect;
  const { values, positionals } = parse(argv, { command: "inspect" });
  const url = required(positionals[0], "<url>", "inspect", `${BIN} inspect https://example.com/page`);
  const site = await resolveSite(values.site);

  const payload = await gsc("/urlInspection/index:inspect", {
    base: inspectionBase,
    method: "POST",
    body: { inspectionUrl: url, siteUrl: site },
  });
  const result = inspection(payload?.inspectionResult);

  return {
    url,
    site,
    ...result,
    // AXI §9: a detail view that fully answers the question takes no suggestions.
    ...(result.indexed
      ? {}
      : {
          help: [
            "A NEUTRAL or FAIL verdict means Google has not indexed this URL",
            `Run \`${BIN} sitemaps\` to check the sitemap covering it was read`,
          ],
        }),
  };
}

async function sitemapsList(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "sitemaps list" });
  const site = await resolveSite(values.site);
  const payload = await gsc(sitePath(site, "/sitemaps"), {});
  const sitemaps = payload.sitemap ?? [];

  if (sitemaps.length === 0) {
    return {
      site,
      sitemaps: "0 sitemaps submitted for this property",
      help: [`Run \`${BIN} sitemaps submit <url>\` to add one`],
    };
  }
  return {
    site,
    count: `${sitemaps.length} total`,
    sitemaps: sitemaps.map((entry) => ({
      path: entry.path,
      type: entry.type ?? "-",
      submitted: String(entry.lastSubmitted ?? "").slice(0, 10),
      last_read: String(entry.lastDownloaded ?? "").slice(0, 10) || "never",
      // Google returns these as strings; numbers render bare and compare right.
      errors: Number(entry.errors ?? 0),
      warnings: Number(entry.warnings ?? 0),
      pending: Boolean(entry.isPending),
    })),
  };
}

async function sitemapsSubmit(argv) {
  if (wantsHelp(argv)) return HELP.submit;
  const { values, positionals } = parse(argv, { command: "sitemaps submit" });
  const url = required(
    positionals[0],
    "<url>",
    "sitemaps submit",
    `${BIN} sitemaps submit https://example.com/sitemap.xml`,
  );
  if (!/^https?:\/\//.test(url)) {
    throw new AxiError("a sitemap must be submitted as a full URL", "VALIDATION_ERROR", [
      `Example: ${BIN} sitemaps submit https://example.com/sitemap.xml`,
    ]);
  }
  const site = await resolveSite(values.site);

  const existing = await gsc(sitePath(site, "/sitemaps"), {});
  const already = (existing.sitemap ?? []).some((entry) => entry.path === url);

  // PUT is idempotent upstream, but saying so beats a second identical call
  // looking like it changed something.
  await gsc(sitePath(site, `/sitemaps/${encodeURIComponent(url)}`), { method: "PUT", write: true });
  return {
    site,
    sitemap: url,
    ...(already ? { unchanged: true, note: "already submitted (no-op)" } : { submitted: true }),
    help: [`Run \`${BIN} sitemaps\` in a few hours to see when Google read it`],
  };
}

export const sitemapsCommand = makeDispatcher(
  "sitemaps",
  { list: sitemapsList, submit: sitemapsSubmit },
  {
    fallback: "list",
    summary: {
      list: "Submitted sitemaps and their read status (default)",
      submit: "Submit a sitemap (idempotent)",
    },
  },
);
