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
  // Position is inverted: a lower number is better, and the output says which.
  assert.match(output.change.position, /9\.0 \(was 10\.0, better\)/);
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
        mobileUsabilityResult: { verdict: "VERDICT_UNSPECIFIED" },
      },
    },
  });
  const output = await inspectCommand(["https://example.com/post"]);
  assert.equal(output.indexed, true);
  assert.equal(output.coverage, "Submitted and indexed");
  assert.ok(!("your_canonical" in output), "an agreeing canonical is not worth a row");
  assert.ok(!("help" in output), "a passing verdict needs no next step — and no empty help key");
  assert.ok(!("mobile" in output), "VERDICT_UNSPECIFIED is 'no data', not a result");
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

test("a page breakdown does not suggest the page breakdown", async () => {
  mockGoogle({ ...oneSite, [ANALYTICS]: rows([{ keys: ["/"], clicks: 3, impressions: 55, ctr: 0.055, position: 5.4 }]) });
  const pages = await performanceCommand(["--by", "page"]);
  assert.ok(!pages.help.some((line) => line.includes("--by page")), "suggesting the current view is noise");
  assert.ok(pages.help.some((line) => line.includes("--by query")));

  mockGoogle({ ...oneSite, [ANALYTICS]: rows([{ keys: ["q"], clicks: 1, impressions: 9, ctr: 0.11, position: 8 }]) });
  const queries = await performanceCommand([]);
  assert.ok(queries.help.some((line) => line.includes("--by page")));
});

const VERIFY_TOKEN = "POST /siteVerification/v1/token";
const VERIFY_INSERT = "POST /siteVerification/v1/webResource";
const NO_SITES = { "GET /sites": { siteEntry: [] } };

test("sites add returns the TXT to publish when the domain is not verified yet", async () => {
  const calls = mockGoogle({
    ...NO_SITES,
    [VERIFY_TOKEN]: { method: "DNS_TXT", token: "google-site-verification=abc123" },
    [VERIFY_INSERT]: { __status: 400, payload: { error: { message: "Domain could not be verified" } } },
  });
  const output = await sitesCommand(["add", "example.com"]);

  assert.equal(output.verified, false);
  assert.deepEqual(output.dns_record, {
    name: "example.com",
    type: "TXT",
    content: "google-site-verification=abc123",
  });
  // Registering an unverified property would fail; it must not be attempted.
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("sites add registers the property once verification passes", async () => {
  const calls = mockGoogle({
    ...NO_SITES,
    [VERIFY_TOKEN]: { method: "DNS_TXT", token: "google-site-verification=abc123" },
    [VERIFY_INSERT]: { id: "dns://example.com" },
    [`PUT /sites/${encodeURIComponent("sc-domain:example.com")}`]: {},
  });
  const output = await sitesCommand(["add", "example.com"]);

  assert.equal(output.verified, true);
  assert.equal(output.created, true);
  assert.equal(output.property, "sc-domain:example.com");
  assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
});

test("sites add is a no-op when the property is already on the account", async () => {
  const calls = mockGoogle({
    "GET /sites": { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
  });
  const output = await sitesCommand(["add", "example.com"]);

  assert.equal(output.unchanged, true);
  // The OAuth token mint is a POST too, so count only the calls that matter.
  const touched = calls.filter((c) => /siteVerification|\/sites\//.test(c.url) && c.method !== "GET");
  assert.deepEqual(touched, [], "a no-op must not re-verify or re-register");
});

test("sites add accepts sc-domain: and https:// spellings of the same domain", async () => {
  for (const input of ["sc-domain:example.com", "https://example.com/", "example.com"]) {
    mockGoogle({
      "GET /sites": { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
    });
    const output = await sitesCommand(["add", input]);
    assert.equal(output.property, "sc-domain:example.com", `for ${input}`);
  }
});

test("a path or a non-domain is rejected before any request", async () => {
  const calls = mockGoogle({});
  await assert.rejects(() => sitesCommand(["add", "not a domain"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("bare `sites` still lists, so the dispatcher did not change the old entry point", async () => {
  mockGoogle(oneSite);
  const output = await sitesCommand([]);
  assert.equal(output.sites[0].property, SITE);
});
