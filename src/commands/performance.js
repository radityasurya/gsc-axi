import { AxiError } from "axi-sdk-js";
import { gsc, resolveSite, sitePath } from "../api.js";
import { DATE_FLAGS, dateFlagHelp, previous, window } from "../range.js";
import { BIN, helpFor, parse, positiveInt, wantsHelp } from "../args.js";

const DEFAULT_LIMIT = 20;

// Search Console's dimension names, plus the plurals an agent is likely to type.
export const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"];
const PLURALS = new Map([
  ["queries", "query"],
  ["pages", "page"],
  ["countries", "country"],
  ["devices", "device"],
  ["dates", "date"],
]);

const TYPES = ["web", "image", "video", "news", "discover", "googleNews"];

const HELP = {
  performance: helpFor({
    command: "performance",
    description: "Clicks, impressions, CTR, and average position, broken down by a dimension",
    usage: `${BIN} performance [--by query|page|country|device|date] [--range <window>] [--limit <n>] [--type web|discover|...]`,
    flags: {
      ...dateFlagHelp(),
      "--by": `Dimension to group by (default query): ${DIMENSIONS.join(", ")}`,
      "--limit": `Rows to show (default ${DEFAULT_LIMIT})`,
      "--type": `Search type (default web): ${TYPES.join(", ")}`,
      "--country": "Only this country, as a 3-letter code (e.g. nld)",
      "--device": "Only this device: desktop, mobile, tablet",
      "--contains": "Only rows whose dimension value contains this text",
    },
    examples: [
      `${BIN} performance`,
      `${BIN} performance --by page --range 90d`,
      `${BIN} performance --by query --contains openpanel`,
    ],
  }),
  compare: helpFor({
    command: "compare",
    description: "This window against the one immediately before it",
    usage: `${BIN} compare [--range <window>] [--by query|page]`,
    flags: {
      ...dateFlagHelp(),
      "--by": "Also break the change down by this dimension",
      "--limit": `Rows when --by is given (default ${DEFAULT_LIMIT})`,
    },
    examples: [`${BIN} compare`, `${BIN} compare --range 90d --by query`],
  }),
  opportunities: helpFor({
    command: "opportunities",
    description: "Queries ranking 4-20 with real volume — the cheapest positions to improve",
    usage: `${BIN} opportunities [--min-impressions <n>] [--range <window>] [--limit <n>]`,
    flags: {
      ...dateFlagHelp(),
      "--min-impressions": "Volume floor (default 50)",
      "--limit": `Rows to show (default ${DEFAULT_LIMIT})`,
    },
    examples: [`${BIN} opportunities`, `${BIN} opportunities --min-impressions 200 --range 90d`],
  }),
};

export function resolveDimension(input) {
  const wanted = String(input);
  if (DIMENSIONS.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const exact = DIMENSIONS.find((dimension) => dimension.toLowerCase() === lower);
  if (exact) return exact;
  const singular = PLURALS.get(lower);
  if (singular) return singular;
  throw new AxiError(`unknown dimension ${input}`, "VALIDATION_ERROR", [
    `valid dimensions: ${DIMENSIONS.join(", ")}`,
  ]);
}

function filters(values) {
  const built = [];
  if (values.country) built.push({ dimension: "country", operator: "equals", expression: values.country });
  if (values.device) {
    built.push({ dimension: "device", operator: "equals", expression: String(values.device).toUpperCase() });
  }
  if (values.contains) {
    built.push({ dimension: values.by ?? "query", operator: "contains", expression: values.contains });
  }
  return built.length ? [{ filters: built }] : undefined;
}

/** ctr arrives as a fraction and position with float noise. */
function row(entry, dimensions) {
  const projected = {};
  dimensions.forEach((dimension, index) => {
    projected[dimension] = entry.keys?.[index] ?? "-";
  });
  return {
    ...projected,
    clicks: entry.clicks ?? 0,
    impressions: entry.impressions ?? 0,
    ctr: `${((entry.ctr ?? 0) * 100).toFixed(1)}%`,
    position: Number((entry.position ?? 0).toFixed(1)),
  };
}

export async function query(site, { startDate, endDate }, body, options = {}) {
  const payload = await gsc(sitePath(site, "/searchAnalytics/query"), {
    ...options,
    method: "POST",
    body: { startDate, endDate, dataState: "final", ...body },
  });
  return payload.rows ?? [];
}

/** Totals for a window: one query with no dimensions. */
export async function totals(site, dates, extra = {}, options = {}) {
  const [row_] = await query(site, dates, { ...extra }, options);
  return {
    clicks: row_?.clicks ?? 0,
    impressions: row_?.impressions ?? 0,
    ctr: row_?.ctr ?? 0,
    position: row_?.position ?? 0,
  };
}

export async function performanceCommand(argv) {
  if (wantsHelp(argv)) return HELP.performance;
  const { values } = parse(argv, {
    command: "performance",
    flags: {
      ...DATE_FLAGS,
      by: { type: "string" },
      limit: { type: "string" },
      type: { type: "string" },
      country: { type: "string" },
      device: { type: "string" },
      contains: { type: "string" },
    },
  });
  const dimension = resolveDimension(values.by ?? "query");
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  const type = values.type ?? "web";
  if (!TYPES.includes(type)) {
    throw new AxiError(`unknown --type ${type}`, "VALIDATION_ERROR", [`valid types: ${TYPES.join(", ")}`]);
  }
  const dates = window(values);
  const site = await resolveSite(values.site);

  const rows = await query(site, dates, {
    dimensions: [dimension],
    rowLimit: limit,
    type,
    dimensionFilterGroups: filters({ ...values, by: dimension }),
  });

  if (rows.length === 0) {
    return {
      site,
      window: `${dates.startDate}..${dates.endDate}`,
      [dimension]: `0 rows in this window`,
      help: [
        `Run \`${BIN} performance --range 90d\` for a wider window`,
        "Search Console finalises data on a 2-3 day delay",
      ],
    };
  }
  return {
    site,
    window: `${dates.startDate}..${dates.endDate}`,
    count: `${rows.length} shown`,
    [`by_${dimension}`]: rows.map((entry) => row(entry, [dimension])),
    help: [
      `Run \`${BIN} performance --by page\` for the pages behind these`,
      `Run \`${BIN} opportunities\` for queries ranking 4-20`,
    ],
  };
}

function delta(now, before) {
  if (!before) return now ? "+100%" : "0%";
  const change = ((now - before) / before) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

export async function compareCommand(argv) {
  if (wantsHelp(argv)) return HELP.compare;
  const { values } = parse(argv, {
    command: "compare",
    flags: { ...DATE_FLAGS, by: { type: "string" }, limit: { type: "string" } },
  });
  const dates = window(values);
  const before = previous(dates);
  const site = await resolveSite(values.site);

  const [current, prior] = await Promise.all([totals(site, dates), totals(site, before)]);
  const summary = {
    clicks: `${current.clicks} (${delta(current.clicks, prior.clicks)})`,
    impressions: `${current.impressions} (${delta(current.impressions, prior.impressions)})`,
    ctr: `${(current.ctr * 100).toFixed(1)}% (was ${(prior.ctr * 100).toFixed(1)}%)`,
    position: `${current.position.toFixed(1)} (was ${prior.position.toFixed(1)})`,
  };

  if (!values.by) {
    return {
      site,
      window: `${dates.startDate}..${dates.endDate}`,
      against: `${before.startDate}..${before.endDate}`,
      change: summary,
      help: [`Run \`${BIN} compare --by query\` to see which queries moved`],
    };
  }

  const dimension = resolveDimension(values.by);
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  const [nowRows, beforeRows] = await Promise.all([
    query(site, dates, { dimensions: [dimension], rowLimit: 200 }),
    query(site, before, { dimensions: [dimension], rowLimit: 200 }),
  ]);
  const priorClicks = new Map(beforeRows.map((entry) => [entry.keys?.[0], entry.clicks ?? 0]));

  const moved = nowRows
    .map((entry) => {
      const key = entry.keys?.[0];
      const was = priorClicks.get(key) ?? 0;
      return { [dimension]: key, clicks: entry.clicks, was, change: (entry.clicks ?? 0) - was };
    })
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, limit);

  return {
    site,
    window: `${dates.startDate}..${dates.endDate}`,
    against: `${before.startDate}..${before.endDate}`,
    change: summary,
    moved,
  };
}

export async function opportunitiesCommand(argv) {
  if (wantsHelp(argv)) return HELP.opportunities;
  const { values } = parse(argv, {
    command: "opportunities",
    flags: { ...DATE_FLAGS, "min-impressions": { type: "string" }, limit: { type: "string" } },
  });
  const floor = positiveInt(values["min-impressions"], "--min-impressions", 50);
  const limit = positiveInt(values.limit, "--limit", DEFAULT_LIMIT);
  const dates = window(values);
  const site = await resolveSite(values.site);

  // The API cannot filter on position, so pull a wide page and rank locally.
  const rows = await query(site, dates, { dimensions: ["query"], rowLimit: 1000 });
  const found = rows
    .filter((entry) => (entry.position ?? 0) >= 4 && (entry.position ?? 0) <= 20)
    .filter((entry) => (entry.impressions ?? 0) >= floor)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);

  if (found.length === 0) {
    return {
      site,
      window: `${dates.startDate}..${dates.endDate}`,
      opportunities: `0 queries rank 4-20 with at least ${floor} impressions`,
      help: [`Run \`${BIN} opportunities --min-impressions 10\` to lower the floor`],
    };
  }
  return {
    site,
    window: `${dates.startDate}..${dates.endDate}`,
    count: `${found.length} of ${rows.length} queries`,
    note: "ranking 4-20 — a page of one already, so position gains convert fastest",
    opportunities: found.map((entry) => row(entry, ["query"])),
  };
}
