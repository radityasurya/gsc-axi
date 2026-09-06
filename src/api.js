import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { BIN } from "./args.js";

const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE = "https://searchconsole.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const READ_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/webmasters";

export const CREDENTIAL_HELP = [
  "Service account: create one in Google Cloud, enable the Search Console API, download its JSON key",
  "Add the service account's email as a user on the property in Search Console (Settings -> Users)",
  "Export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json",
  "Or use an OAuth refresh token: GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN",
];

export function hasCredentials(env = process.env) {
  return Boolean(
    env.GOOGLE_APPLICATION_CREDENTIALS ||
      (env.GSC_CLIENT_ID && env.GSC_CLIENT_SECRET && env.GSC_REFRESH_TOKEN),
  );
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Mint an access token from a service account key. Signing an RS256 JWT is the
 * whole of the flow, and `node:crypto` does RS256 — so this needs no googleapis
 * dependency, which would be an order of magnitude more install weight than the
 * rest of this tool put together.
 */
async function serviceAccountToken(keyPath, scope, fetchImpl) {
  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (cause) {
    throw new AxiError(`Could not read the service account key: ${cause.message}`, "AUTH_REQUIRED", [
      `GOOGLE_APPLICATION_CREDENTIALS points at ${keyPath}`,
      "It must be the JSON key file downloaded from Google Cloud",
    ]);
  }
  if (!key.client_email || !key.private_key) {
    throw new AxiError("That JSON is not a service account key", "AUTH_REQUIRED", [
      "A service account key has `client_email` and `private_key` fields",
      "Download it from Google Cloud -> IAM -> Service Accounts -> Keys",
    ]);
  }

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claim))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  return exchange(
    { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` },
    fetchImpl,
    { email: key.client_email },
  );
}

async function refreshTokenGrant(env, fetchImpl) {
  return exchange(
    {
      grant_type: "refresh_token",
      client_id: env.GSC_CLIENT_ID,
      client_secret: env.GSC_CLIENT_SECRET,
      refresh_token: env.GSC_REFRESH_TOKEN,
    },
    fetchImpl,
    {},
  );
}

async function exchange(body, fetchImpl, context) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (cause) {
    throw new AxiError(`Could not reach Google to mint a token: ${cause.message}`, "NETWORK_ERROR", [
      "Check network connectivity to oauth2.googleapis.com",
    ]);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new AxiError(`Google refused the credentials: ${detail}`, "AUTH_ERROR", [
      ...(context.email
        ? [`Check the Search Console API is enabled for the project owning ${context.email}`]
        : ["Check GSC_CLIENT_ID, GSC_CLIENT_SECRET, and GSC_REFRESH_TOKEN are current"]),
      "A revoked key or a disabled API both land here",
    ]);
  }
  return payload.access_token;
}

// Keyed by scope: a token minted for the read scope cannot perform a write, and
// `sitemaps submit` reads the existing list before it PUTs. Caching one token
// for the process meant the write reused the read-only one and Google answered
// "Request had insufficient authentication scopes".
const cached = new Map();

export async function accessToken(options = {}) {
  const { env = process.env, write = false, fetchImpl = fetch } = options;
  const scope = write ? WRITE_SCOPE : READ_SCOPE;
  if (cached.has(scope)) return cached.get(scope);
  if (!hasCredentials(env)) {
    throw new AxiError("No Google credentials in the environment", "AUTH_REQUIRED", CREDENTIAL_HELP);
  }
  const token = env.GOOGLE_APPLICATION_CREDENTIALS
    ? await serviceAccountToken(env.GOOGLE_APPLICATION_CREDENTIALS, scope, fetchImpl)
    : await refreshTokenGrant(env, fetchImpl);
  cached.set(scope, token);
  return token;
}

export function resetTokenCache() {
  cached.clear();
}

function apiError(status, payload, path) {
  const error = payload?.error ?? {};
  const message = error.message || `Search Console request failed (HTTP ${status})`;

  if (status === 401) {
    return new AxiError(message, "AUTH_ERROR", [
      "The token was rejected — the key may be revoked or the API disabled",
      ...CREDENTIAL_HELP.slice(0, 2),
    ]);
  }
  if (status === 403) {
    // Google returns 403 for two unrelated causes; sending someone to the
    // property's user list when the problem is the token's scope wastes the
    // one piece of information the error actually carried.
    if (/insufficient (authentication )?scope/i.test(message)) {
      return new AxiError(message, "AUTH_ERROR", [
        "The token was minted for read-only access but this command writes",
        "An OAuth refresh token granted `webmasters.readonly` cannot submit sitemaps",
        "Use a service account, or re-consent with the `webmasters` scope",
      ]);
    }
    return new AxiError(message, "AUTH_ERROR", [
      "This account has no access to that property",
      "Add it as a user in Search Console: Settings -> Users and permissions",
      `Run \`${BIN} sites\` to see the properties it can reach`,
    ]);
  }
  if (status === 404) {
    return new AxiError(message, "NOT_FOUND", [
      `Run \`${BIN} sites\` to list the exact property strings`,
      "A domain property is written `sc-domain:example.com`, not `https://example.com/`",
    ]);
  }
  if (status === 429) {
    return new AxiError(message, "RATE_LIMITED", [
      "Search Console allows 1200 queries per minute per property; wait and retry",
    ]);
  }
  return new AxiError(message, "API_ERROR", [`while requesting ${path}`]);
}

/** One authenticated request against the Search Console API. */
export async function gsc(path, options = {}) {
  const { method = "GET", body, base = WEBMASTERS, env = process.env, fetchImpl = fetch, write = false } = options;
  const token = await accessToken({ env, write, fetchImpl });

  let response;
  try {
    response = await fetchImpl(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new AxiError(`Could not reach the Search Console API: ${cause.message}`, "NETWORK_ERROR", [
      "Check network connectivity to googleapis.com",
    ]);
  }

  if (response.status === 204) return {};
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(response.status, payload, path);
  return payload;
}

export const inspectionBase = SEARCHCONSOLE;

/** Property strings are URLs or `sc-domain:` prefixed, and must be encoded whole. */
export function sitePath(site, suffix = "") {
  return `/sites/${encodeURIComponent(site)}${suffix}`;
}

export async function listSites(options = {}) {
  const payload = await gsc("/sites", options);
  return (payload.siteEntry ?? []).filter((entry) => entry.permissionLevel !== "siteUnverifiedUser");
}

/**
 * Resolve the property to act on: the flag, the environment, or the only one
 * the account can see. Refuses to guess between several, the way an ambiguous
 * name should — acting on the wrong property is a silent wrong answer.
 */
export async function resolveSite(selector, options = {}) {
  const env = options.env ?? process.env;
  const wanted = selector || env.GSC_SITE;
  const sites = await listSites(options);

  if (wanted) {
    const exact = sites.find((entry) => entry.siteUrl === wanted);
    if (exact) return exact.siteUrl;
    // Accept `example.com` for either property shape rather than making the
    // agent remember which kind was verified.
    const bare = wanted.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const near = sites.filter((entry) =>
      entry.siteUrl.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "") === bare,
    );
    if (near.length === 1) return near[0].siteUrl;
    if (near.length > 1) {
      throw new AxiError(`${wanted} matches ${near.length} properties`, "VALIDATION_ERROR", [
        "Pass the exact property string instead",
        ...near.map((entry) => `Run with --site ${entry.siteUrl}`),
      ]);
    }
    throw new AxiError(`no property matching ${wanted}`, "NOT_FOUND", [
      ...sites.slice(0, 5).map((entry) => `Run with --site ${entry.siteUrl}`),
      `Run \`${BIN} sites\` to see all ${sites.length}`,
    ]);
  }

  if (sites.length === 1) return sites[0].siteUrl;
  if (sites.length === 0) {
    throw new AxiError("This account can not see any Search Console property", "AUTH_ERROR", [
      "Add the account as a user on the property: Settings -> Users and permissions",
    ]);
  }
  throw new AxiError(`the property is ambiguous: this account sees ${sites.length}`, "VALIDATION_ERROR", [
    "Pass `--site <property>` to choose one, or set GSC_SITE",
    ...sites.slice(0, 5).map((entry) => `Run with --site ${entry.siteUrl}`),
  ]);
}
