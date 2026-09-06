import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTokenCache } from "../src/api.js";

export const SITE = "https://example.com/";

/**
 * Stand in for Google. `routes` maps "METHOD /path" (the path after the API
 * base) to a payload or a function of `{ body, query }`. The token endpoint is
 * answered automatically unless a route overrides it.
 */
export function mockGoogle(routes = {}) {
  const calls = [];
  resetTokenCache();
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body && init.headers?.["content-type"] === "application/json"
      ? JSON.parse(init.body)
      : init.body;
    calls.push({ url: String(url), method, body, path: parsed.pathname, headers: init.headers });

    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      const override = routes["TOKEN"];
      if (override?.__status) return json(override.__status, override.payload);
      return json(200, { access_token: "test-token", expires_in: 3600 });
    }

    const path = parsed.pathname
      .replace("/webmasters/v3", "")
      .replace(/^\/v1/, "");
    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      return json(404, { error: { message: `no route for ${method} ${path}` } });
    }
    const value = typeof route === "function" ? route({ body, query: Object.fromEntries(parsed.searchParams) }) : route;
    if (value?.__status) return json(value.__status, value.payload);
    return json(200, value);
  };
  return calls;
}

function json(status, payload) {
  return { ok: status < 400, status, json: async () => payload };
}

export function fails(status, payload) {
  return { __status: status, payload };
}

export function withRefreshToken() {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GSC_SITE;
  process.env.GSC_CLIENT_ID = "client";
  process.env.GSC_CLIENT_SECRET = "secret";
  process.env.GSC_REFRESH_TOKEN = "refresh";
}

/** A real RSA key, so the JWT signing path is exercised rather than stubbed. */
export function withServiceAccount() {
  delete process.env.GSC_CLIENT_ID;
  delete process.env.GSC_CLIENT_SECRET;
  delete process.env.GSC_REFRESH_TOKEN;
  delete process.env.GSC_SITE;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(tmpdir(), `gsc-axi-key-${process.pid}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      client_email: "axi@example.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  return path;
}

export const oneSite = { "GET /sites": { siteEntry: [{ siteUrl: SITE, permissionLevel: "siteOwner" }] } };

export function rows(entries) {
  return { rows: entries };
}
