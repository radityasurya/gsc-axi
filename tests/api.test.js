import test from "node:test";
import assert from "node:assert/strict";
import { listSites, resolveSite } from "../src/api.js";
import { SITE, fails, mockGoogle, oneSite, withRefreshToken, withServiceAccount } from "./helpers.js";

test.beforeEach(withRefreshToken);

test("a missing credential fails loud with the setup steps", async () => {
  delete process.env.GSC_CLIENT_ID;
  mockGoogle(oneSite);
  await assert.rejects(() => listSites({}), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.match(error.suggestions.join(" "), /Service account/);
    return true;
  });
});

test("a service account key is exchanged as a signed jwt-bearer assertion", async () => {
  withServiceAccount();
  const calls = mockGoogle(oneSite);
  await listSites({});

  const token = calls.find((call) => call.url.includes("oauth2.googleapis.com"));
  const form = new URLSearchParams(token.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claim, signature] = form.get("assertion").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const parsed = JSON.parse(Buffer.from(claim, "base64url").toString());
  assert.equal(parsed.iss, "axi@example.iam.gserviceaccount.com");
  assert.match(parsed.scope, /webmasters.readonly/);
  assert.ok(signature.length > 100, "the assertion must actually be signed");
});

test("the access token is minted once per process, not per request", async () => {
  const calls = mockGoogle({ ...oneSite });
  await listSites({});
  await listSites({});
  assert.equal(calls.filter((call) => call.url.includes("oauth2")).length, 1);
});

test("a rejected credential explains what to check", async () => {
  mockGoogle({ TOKEN: fails(400, { error: "invalid_grant", error_description: "Token has been expired" }) });
  await assert.rejects(() => listSites({}), (error) => {
    assert.equal(error.code, "AUTH_ERROR");
    assert.match(error.message, /expired/);
    return true;
  });
});

test("unverified properties are hidden — they answer 403 on every query", async () => {
  mockGoogle({
    "GET /sites": {
      siteEntry: [
        { siteUrl: SITE, permissionLevel: "siteOwner" },
        { siteUrl: "https://other.com/", permissionLevel: "siteUnverifiedUser" },
      ],
    },
  });
  const sites = await listSites({});
  assert.equal(sites.length, 1);
});

test("a single property resolves without being named", async () => {
  mockGoogle(oneSite);
  assert.equal(await resolveSite(undefined), SITE);
});

test("several properties refuse to be guessed between", async () => {
  mockGoogle({
    "GET /sites": {
      siteEntry: [
        { siteUrl: SITE, permissionLevel: "siteOwner" },
        { siteUrl: "sc-domain:other.com", permissionLevel: "siteOwner" },
      ],
    },
  });
  await assert.rejects(() => resolveSite(undefined), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /--site/);
    return true;
  });
});

test("a bare domain matches either property shape", async () => {
  mockGoogle({ "GET /sites": { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] } });
  assert.equal(await resolveSite("example.com"), "sc-domain:example.com");
  assert.equal(await resolveSite("https://example.com"), "sc-domain:example.com");
});

test("403 points at the property's user list, not the credentials", async () => {
  mockGoogle({ "GET /sites": fails(403, { error: { message: "User does not have permission" } }) });
  await assert.rejects(() => listSites({}), (error) => {
    assert.equal(error.code, "AUTH_ERROR");
    assert.match(error.suggestions.join(" "), /Users and permissions/);
    return true;
  });
});
