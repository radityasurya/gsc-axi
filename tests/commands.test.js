import test from "node:test";
import assert from "node:assert/strict";
import { AxiError } from "axi-sdk-js";
import { compareCommand, opportunitiesCommand, performanceCommand, resolveDimension } from "../src/commands/performance.js";
import { inspectCommand, sitemapsCommand, sitesCommand } from "../src/commands/index-tools.js";
import { RANGES, previous, window } from "../src/range.js";
import { SITE, mockGoogle, oneSite, rows, withRefreshToken } from "./helpers.js";

test.beforeEach(withRefreshToken);

const ANALYTICS = `POST /sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;

test("the default window ends where Search Console has finalised, not today", () => {
  const { startDate, endDate } = window({});
  const today = new Date().toISOString().slice(0, 10);
  assert.notEqual(endDate, today, "ending today always shows a fake decline in the last rows");
  const span = (new Date(endDate) - new Date(startDate)) / 86_400_000;
  assert.equal(span, RANGES["28d"]);
});

test("an unknown range is rejected before any request", () => {
  assert.throws(() => window({ range: "30d" }), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /28d/);
    return true;
  });
});

test("the comparison window is the equal span immediately before", () => {
  const before = previous({ startDate: "2026-08-01", endDate: "2026-08-10" });
  assert.equal(before.endDate, "2026-07-31");
  assert.equal(before.startDate, "2026-07-22");
});

test("dimension plurals resolve, unknown ones fail loud", () => {
  assert.equal(resolveDimension("queries"), "query");
  assert.equal(resolveDimension("pages"), "page");
  assert.equal(resolveDimension("searchappearance"), "searchAppearance");
  assert.throws(() => resolveDimension("keyword"), (error) => {
    assert.match(error.suggestions.join(" "), /searchAppearance/);
    return true;
  });
});

test("performance formats ctr as a percentage and rounds position", async () => {
  mockGoogle({
    ...oneSite,
    [ANALYTICS]: rows([{ keys: ["openpanel"], clicks: 12, impressions: 340, ctr: 0.0352941, position: 8.43219 }]),
  });
  const output = await performanceCommand([]);
  assert.equal(output.by_query[0].ctr, "3.5%");
  assert.equal(output.by_query[0].position, 8.4);
});

test("performance sends the filters it was given", async () => {
  const calls = mockGoogle({ ...oneSite, [ANALYTICS]: rows([]) });
  await performanceCommand(["--by", "page", "--country", "nld", "--device", "mobile", "--contains", "blog"]);
  const sent = calls.at(-1).body;
  assert.deepEqual(sent.dimensions, ["page"]);
  const filters = sent.dimensionFilterGroups[0].filters;
  assert.deepEqual(filters.find((f) => f.dimension === "country"), {
    dimension: "country",
    operator: "equals",
    expression: "nld",
  });
  assert.equal(filters.find((f) => f.dimension === "device").expression, "MOBILE");
  assert.equal(filters.find((f) => f.operator === "contains").dimension, "page");
});

test("performance states an empty window rather than printing nothing", async () => {
  mockGoogle({ ...oneSite, [ANALYTICS]: rows([]) });
  const output = await performanceCommand([]);
  assert.match(output.query, /0 rows/);
  assert.match(output.help.join(" "), /2-3 day delay/);
});

test("opportunities keeps only positions 4-20 above the impression floor", async () => {
  mockGoogle({
    ...oneSite,
    [ANALYTICS]: rows([
      { keys: ["already first"], clicks: 90, impressions: 900, ctr: 0.1, position: 1.2 },
      { keys: ["winnable"], clicks: 3, impressions: 400, ctr: 0.0075, position: 7.8 },
      { keys: ["too rare"], clicks: 0, impressions: 5, ctr: 0, position: 9 },
      { keys: ["too deep"], clicks: 0, impressions: 800, ctr: 0, position: 44 },
    ]),
  });
  const output = await opportunitiesCommand([]);
  assert.equal(output.opportunities.length, 1);
  assert.equal(output.opportunities[0].query, "winnable");
  assert.equal(output.count, "1 of 4 queries");
});

test("compare reports the delta against the preceding window", async () => {
  let call = 0;
  mockGoogle({
    ...oneSite,
    [ANALYTICS]: () => {
      call += 1;
      // First call is the current window, second is the previous one.
      return rows([
        call === 1
          ? { clicks: 120, impressions: 2000, ctr: 0.06, position: 9 }
          : { clicks: 100, impressions: 1800, ctr: 0.055, position: 10 },
      ]);
    },
  });
  const output = await compareCommand([]);
  assert.match(output.change.clicks, /120 \(\+20\.0%\)/);
  assert.match(output.change.position, /9\.0 \(was 10\.0\)/);
});

test("inspect flattens the nested verdicts an agent has to act on", async () => {
  mockGoogle({
    ...oneSite,
    "POST /urlInspection/index:inspect": {
      inspectionResult: {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          lastCrawlTime: "2026-09-01T10:00:00Z",
          googleCanonical: "https://example.com/post",
          userCanonical: "https://example.com/post",
          robotsTxtState: "ALLOWED",
        },
        mobileUsabilityResult: { verdict: "PASS" },
      },
    },
  });
  const output = await inspectCommand(["https://example.com/post"]);
  assert.equal(output.indexed, true);
  assert.equal(output.coverage, "Submitted and indexed");
  assert.ok(!("your_canonical" in output), "an agreeing canonical is not worth a row");
  assert.deepEqual(output.help, [], "a passing verdict needs no next step");
});

test("inspect surfaces a canonical mismatch and what to do about it", async () => {
  mockGoogle({
    ...oneSite,
    "POST /urlInspection/index:inspect": {
      inspectionResult: {
        indexStatusResult: {
          verdict: "NEUTRAL",
          coverageState: "Crawled - currently not indexed",
          googleCanonical: "https://example.com/other",
          userCanonical: "https://example.com/post",
        },
      },
    },
  });
  const output = await inspectCommand(["https://example.com/post"]);
  assert.equal(output.indexed, false);
  assert.equal(output.your_canonical, "https://example.com/post");
  assert.match(output.help.join(" "), /not indexed/);
});

test("resubmitting an existing sitemap is a no-op, not a change", async () => {
  const map = "https://example.com/sitemap.xml";
  mockGoogle({
    ...oneSite,
    [`GET /sites/${encodeURIComponent(SITE)}/sitemaps`]: { sitemap: [{ path: map }] },
    [`PUT /sites/${encodeURIComponent(SITE)}/sitemaps/${encodeURIComponent(map)}`]: {},
  });
  const output = await sitemapsCommand(["submit", map]);
  assert.equal(output.unchanged, true);
  assert.match(output.note, /no-op/);
});

test("a sitemap must be a full URL", async () => {
  mockGoogle(oneSite);
  await assert.rejects(() => sitemapsCommand(["submit", "/sitemap.xml"]), (error) => {
    assert.ok(error instanceof AxiError);
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
});

test("sites explains the service-account gotcha when nothing is visible", async () => {
  mockGoogle({ "GET /sites": { siteEntry: [] } });
  const output = await sitesCommand([]);
  assert.match(output.sites, /0 properties/);
  assert.match(output.help.join(" "), /client_email/);
});
