import { applyRouteEnv, canUseApi, effectiveMode, normalizeConfig } from "./env.js";
import { loadConfig, saveConfig } from "./config.js";
import { pickFromPool, publicRoute, resolveAccount, resolveRoute, routeEnv } from "./egress.js";
import { walletSummary } from "./wallet.js";

const API_ALIASES = new Set(["api", "custom", "relay", "中转"]);
const ACCOUNT_ALIASES = new Set(["account", "main", "cc", "主账号", "官方", "official"]);
const DEFAULT_ALIASES = new Set(["default", "follow", "clear", "默认", "跟随"]);

/**
 * Parse the mode word of a route target.
 * @param {string} target
 * @returns {"api"|"account"|"default"|null}
 */
export function parseRouteTarget(target) {
  const t = String(target || "").trim().toLowerCase();
  if (API_ALIASES.has(t)) return "api";
  if (ACCOUNT_ALIASES.has(t)) return "account";
  if (DEFAULT_ALIASES.has(t)) return "default";
  return null;
}

const USAGE =
  "usage: route api [key-name] [url-name] | route account [account-name] | route default (lane only)";

/**
 * Switch a route. Never erases URLs, keys or accounts.
 *
 * Target is a mode word plus optional names:
 *   "api"                    the current global URL + key
 *   "api work-key"           a key from the pool (its paired URL comes along)
 *   "api work-key backup"    a key and a URL from the pool
 *   "account"                the machine's own login
 *   "account b"              a named account
 *   "default"                drop the lane's own route (lane only)
 *
 * Without `opts.lane` this changes the global default and, as before, applies it to
 * process.env. With a lane it only rewrites that lane's entry and leaves process.env alone;
 * the host picks it up through envFor(lane) on the next query.
 *
 * @param {string} target
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 * @param {string} [opts.lane]
 * @param {(route: object) => void} [opts.onRouteChange]  e.g. drop warm SDK sessions
 * @returns {{ ok: boolean, error?: string, route?: object, relay?: object }}
 */
export function setRouteMode(target, opts = {}) {
  const words = String(target || "").trim().split(/\s+/).filter(Boolean);
  const want = parseRouteTarget(words[0]);
  const names = words.slice(1);
  if (!want) return { ok: false, error: USAGE };

  const lane = opts.lane != null && String(opts.lane).trim() ? String(opts.lane).trim() : null;
  const prev = loadConfig(opts.configPath);
  const lanes = { ...prev.lanes };
  let next;

  if (want === "default") {
    if (!lane) return { ok: false, error: "default only applies to a lane (pass a lane)" };
    delete lanes[lane];
    next = { ...prev, lanes };
  } else if (want === "api") {
    const pick = names.length
      ? pickFromPool(prev, names)
      : { baseUrl: prev.baseUrl, apiKey: prev.apiKey, urlId: prev.activeUrlId, keyId: prev.activeKeyId, urlName: "", keyName: "" };
    if (pick.error) return { ok: false, error: pick.error };
    if (!pick.baseUrl || !pick.apiKey) {
      return {
        ok: false,
        error: names.length
          ? `"${names.join(" ")}" is missing ${pick.baseUrl ? "a key" : "a URL"}`
          : "baseUrl and apiKey required before switching to API. Set them in config first.",
      };
    }
    const st = prev.station && prev.station !== "account" ? prev.station : "custom";
    if (lane) {
      // A snapshot, not a reference: later changes to the global choice do not drag this lane.
      lanes[lane] = { station: st, baseUrl: pick.baseUrl, apiKey: pick.apiKey,
        keyId: pick.keyId, urlId: pick.urlId, keyName: pick.keyName, urlName: pick.urlName };
      next = { ...prev, lanes };
    } else {
      next = { ...prev, station: st, baseUrl: pick.baseUrl, apiKey: pick.apiKey,
        activeUrlId: pick.urlId, activeKeyId: pick.keyId };
    }
  } else {
    const account = resolveAccount(prev, names);
    if (account.error) return { ok: false, error: account.error };
    const accountId = account.id === "main" ? "" : account.id;
    if (lane) {
      lanes[lane] = { station: "account", accountId };
      next = { ...prev, lanes };
    } else {
      next = { ...prev, station: "account", accountId };
    }
  }

  const saved = saveConfig(next, opts.configPath);
  let route;
  try {
    route = lane ? routeEnv(resolveRoute(saved, lane)).route : applyRouteEnv(saved);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  try {
    opts.onRouteChange?.(route);
  } catch {
    /* host cleanup is best-effort */
  }

  return {
    ok: true,
    route,
    relay: publicStatus(opts.configPath, lane ?? undefined),
  };
}

/**
 * Public status for UI (no secrets).
 * @param {string} [configPath]
 * @param {string} [lane] omit for the global default
 */
export function publicStatus(configPath, lane) {
  const r = loadConfig(configPath);
  const canApi = !!(r.baseUrl && r.apiKey);
  let route;
  let error;
  try {
    route = publicRoute(resolveRoute(r, lane));
  } catch (e) {
    error = e?.message || String(e);
  }
  return {
    mode: route?.mode || effectiveMode(r),
    station: r.station || "account",
    baseUrl: r.baseUrl || "",
    apiKeySet: !!r.apiKey,
    canApi,
    priceMul: r.priceMul,
    ...(lane != null ? { lane: String(lane) } : {}),
    route,
    ...(error ? { error } : {}),
    wallet: walletSummary(configPath, lane),
  };
}

/**
 * Load config + apply the global route to process.env in one call.
 * Single-route hosts only; see envFor() for anything concurrent.
 * @param {string} [configPath]
 */
export function applyFromConfig(configPath) {
  const cfg = loadConfig(configPath);
  return applyRouteEnv(cfg);
}

export { canUseApi, effectiveMode, normalizeConfig };
