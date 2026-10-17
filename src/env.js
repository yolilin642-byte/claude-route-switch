/**
 * Apply or clear Anthropic / Claude Agent SDK routing env vars.
 *
 * API mode sets:
 *   ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
 * and removes ANTHROPIC_AUTH_TOKEN so OAuth cannot override the relay key.
 *
 * Account mode deletes the relay env vars so the SDK uses default login.
 */

import { ROUTE_ENV_KEYS, resolveRoute, routeEnv } from "./egress.js";

/**
 * @typedef {object} RouteConfig
 * @property {string} [station]  "account" | "custom" | any non-account id for API
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {number} [priceMul]
 * @property {Record<string, { in: number, out: number, cacheWrite?: number, cacheRead?: number }>} [rates]
 */

/**
 * @typedef {object} RouteResult
 * @property {"account"|"api"} mode
 * @property {string} station
 * @property {string} baseUrl
 * @property {number} priceMul
 */

const trimUrl = (s) => String(s || "").trim().replace(/\/+$/, "");
const str = (s) => String(s ?? "").trim();
const list = (a, fn) => (Array.isArray(a) ? a.map(fn).filter(Boolean) : []);

/** Pool entry: a base URL you can route to. `keyId` optionally pairs it with a key. */
function normUrl(x) {
  const id = str(x?.id || x?.name);
  if (!id) return null;
  return { id, name: str(x.name) || id, baseUrl: trimUrl(x.baseUrl), keyId: str(x.keyId) };
}

/** Pool entry: an API key. `urlId` optionally pairs it with a URL. */
function normKey(x) {
  const id = str(x?.id || x?.name);
  if (!id) return null;
  return { id, name: str(x.name) || id, secret: str(x.secret), urlId: str(x.urlId) };
}

/**
 * A named subscription account besides the machine's own login ("main").
 * `oauthToken` is a `claude setup-token` token; `keyDir` is a folder holding this account's
 * own `.credentials.json` (used through CLAUDE_SECURESTORAGE_CONFIG_DIR).
 * `prefer` decides which one wins when both exist.
 */
function normAccount(x) {
  const id = str(x?.id).toLowerCase();
  if (!id || id === "main" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) return null;
  return {
    id,
    name: str(x.name) || id,
    oauthToken: str(x.oauthToken),
    keyDir: str(x.keyDir),
    prefer: x.prefer === "token" ? "token" : "keyDir",
  };
}

/** One lane's own choice. Lanes without an entry follow the global default. */
function normLane(x) {
  if (!x || typeof x !== "object") return null;
  if (String(x.station || "account") === "account") {
    return { station: "account", accountId: str(x.accountId).toLowerCase() };
  }
  return {
    station: str(x.station) || "custom",
    baseUrl: trimUrl(x.baseUrl),
    apiKey: str(x.apiKey),
    keyId: str(x.keyId),
    urlId: str(x.urlId),
    keyName: str(x.keyName),
    urlName: str(x.urlName),
  };
}

/**
 * Normalize config fields. Unknown fields are dropped.
 * @param {RouteConfig & object} r
 */
export function normalizeConfig(r = {}) {
  const lanes = {};
  if (r.lanes && typeof r.lanes === "object" && !Array.isArray(r.lanes)) {
    for (const [name, v] of Object.entries(r.lanes)) {
      const lane = normLane(v);
      if (str(name) && lane) lanes[str(name)] = lane;
    }
  }
  return {
    station: String(r.station || "account"),
    baseUrl: trimUrl(r.baseUrl),
    apiKey: str(r.apiKey),
    priceMul: Number(r.priceMul) > 0 ? Number(r.priceMul) : 1,
    rates: r.rates && typeof r.rates === "object" && !Array.isArray(r.rates) ? r.rates : {},
    accountId: str(r.accountId).toLowerCase(),
    activeUrlId: str(r.activeUrlId),
    activeKeyId: str(r.activeKeyId),
    urls: list(r.urls, normUrl),
    keys: list(r.keys, normKey),
    accounts: list(r.accounts, normAccount),
    lanes,
  };
}

/**
 * Whether config can run in API mode (URL + key present, station not account).
 * @param {RouteConfig} r
 */
export function canUseApi(r) {
  const n = normalizeConfig(r);
  return n.station !== "account" && !!(n.baseUrl && n.apiKey);
}

/**
 * Effective mode without mutating env.
 * @param {RouteConfig} r
 * @returns {"account"|"api"}
 */
export function effectiveMode(r) {
  return canUseApi(r) ? "api" : "account";
}

/**
 * Apply the global route to an env object **in place** (process.env by default).
 *
 * process.env is shared by the whole process, so two turns on different routes at the
 * same time will overwrite each other. Prefer `envFor()` / `routeEnv()`, which return a
 * fresh copy for one query's `options.env`. This stays for single-route hosts and shells.
 * @param {RouteConfig} config
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {RouteResult}
 */
export function applyRouteEnv(config, env = process.env) {
  const { env: next, route } = routeEnv(resolveRoute(config), env);
  for (const k of ROUTE_ENV_KEYS) {
    if (next[k] === undefined) delete env[k];
    else env[k] = next[k];
  }
  return route;
}

/**
 * Force account mode (clear relay env only).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
export function clearRelayEnv(env = process.env) {
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  return { mode: "account", station: "account", baseUrl: "", priceMul: 1 };
}

/**
 * Snapshot whether relay env is currently set (does not read config file).
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
export function envSnapshot(env = process.env) {
  return {
    hasBaseUrl: !!env.ANTHROPIC_BASE_URL,
    hasApiKey: !!env.ANTHROPIC_API_KEY,
    hasAuthToken: !!env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: env.ANTHROPIC_BASE_URL || "",
  };
}
