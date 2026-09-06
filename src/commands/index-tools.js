import { AxiError } from "axi-sdk-js";
import {
  gsc,
  inspectionBase,
  listSites,
  resolveSite,
  sitePath,
  verificationBase,
  verifyScope,
} from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

const HELP = {
  sites: helpFor({
    command: "sites list",
    description: "Properties this account can reach, and its permission on each",
    usage: `${BIN} sites [list]`,
    examples: [`${BIN} sites`],
  }),
  add: helpFor({
    command: "sites add",
    description:
      "Claim a domain as a Search Console property: prints the DNS TXT to add, verifies once it resolves, then registers it",
    usage: `${BIN} sites add <domain>`,
    examples: [`${BIN} sites add example.com`, `${BIN} sites add sc-domain:example.com`],
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

async function sitesList(argv) {
  if (wantsHelp(argv)) return HELP.sites;
  parse(argv, { command: "sites list" });
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
      `Run \`${BIN} sites add <domain>\` to claim another one`,
      "Export GSC_SITE to make one the default",
    ],
  };
}

/** `example.com`, `sc-domain:example.com` and `https://example.com/` all mean one domain. */
function bareDomain(input) {
  const stripped = input.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(stripped)) {
    throw new AxiError(`${input} is not a domain`, "VALIDATION_ERROR", [
      `Pass the apex domain: ${BIN} sites add example.com`,
    ]);
  }
  return stripped;
}

async function sitesAdd(argv) {
  if (wantsHelp(argv)) return HELP.add;
  const { positionals } = parse(argv, { command: "sites add" });
  const domain = bareDomain(
    required(positionals[0], "<domain>", "sites add", `${BIN} sites add example.com`),
  );
  const property = `sc-domain:${domain}`;

  const already = await listSites({});
  if (already.some((entry) => entry.siteUrl === property)) {
    return {
      property,
      unchanged: true,
      note: `${property} is already on this account (no-op)`,
      help: [`Run \`${BIN} sitemaps submit https://${domain}/sitemap.xml --site ${property}\``],
    };
  }

  const site = { type: "INET_DOMAIN", identifier: domain };
  const verifyOptions = { base: verificationBase, scope: verifyScope };

  // Verification is what makes the property claimable, and it can only succeed
  // once the TXT resolves — so ask for the token first and hand it back if the
  // record is not live yet. Re-running once DNS has propagated finishes the job.
  const { token } = await gsc("/token", {
    ...verifyOptions,
    method: "POST",
    body: { verificationMethod: "DNS_TXT", site },
  });

  try {
    await gsc("/webResource?verificationMethod=DNS_TXT", {
      ...verifyOptions,
      method: "POST",
      body: { site },
    });
  } catch (error) {
    if (error.code === "AUTH_ERROR" && !/verif/i.test(error.message)) throw error;
    return {
      property,
      verified: false,
      dns_record: { name: domain, type: "TXT", content: token },
      help: [
        `Add that TXT record, then re-run \`${BIN} sites add ${domain}\``,
        `With cloudflare-axi: \`cloudflare-axi dns set @ TXT "${token}" --zone ${domain}\``,
        `Google refused verification: ${error.message}`,
      ],
    };
  }

  await gsc(sitePath(property), { method: "PUT", write: true });
  return {
    property,
    verified: true,
    created: true,
    help: [
      `Run \`${BIN} sitemaps submit https://${domain}/sitemap.xml --site ${property}\``,
      "Keep the TXT record in place — removing it un-verifies the property",
    ],
  };
}

export const sitesCommand = makeDispatcher(
  "sites",
  { list: sitesList, add: sitesAdd },
  {
    fallback: "list",
    summary: {
      list: "Properties this account can reach",
      add: "Claim a domain as a property (verify by DNS TXT, then register)",
    },
  },
);

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
