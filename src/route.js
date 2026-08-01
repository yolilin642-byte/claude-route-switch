import { applyRouteEnv, canUseApi, effectiveMode, normalizeConfig } from "./env.js";
import { loadConfig, saveConfig } from "./config.js";
import { walletSummary } from "./wallet.js";

const API_ALIASES = new Set(["api", "custom", "relay", "中转"]);
const ACCOUNT_ALIASES = new Set(["account", "main", "cc", "主账号", "官方", "official"]);

/**
 * Parse /route target string.
 * @param {string} target
 * @returns {"api"|"account"|null}
 */
export function parseRouteTarget(target) {
  const t = String(target || "").trim().toLowerCase();
  if (API_ALIASES.has(t)) return "api";
  if (ACCOUNT_ALIASES.has(t)) return "account";
  return null;
}

/**
 * Switch between account and API. Does not erase baseUrl / apiKey.
 * @param {string} target  "api" | "account" | aliases
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 * @param {() => void} [opts.onRouteChange]  e.g. drop warm SDK sessions
 * @returns {{ ok: boolean, error?: string, route?: object, relay?: object }}
 */
export function setRouteMode(target, opts = {}) {
  const want = parseRouteTarget(target);
  if (!want) {
    return { ok: false, error: "usage: route api | route account" };
  }

  const prev = loadConfig(opts.configPath);
  const baseUrl = prev.baseUrl;
  const apiKey = prev.apiKey;
  const priceMul = prev.priceMul;

  let next;
  if (want === "api") {
    if (!baseUrl || !apiKey) {
      return {
        ok: false,
        error: "baseUrl and apiKey required before switching to API. Set them in config first.",
      };
    }
    const st = prev.station && prev.station !== "account" ? prev.station : "custom";
    next = { station: st, baseUrl, apiKey, priceMul };
  } else {
    next = { station: "account", baseUrl, apiKey, priceMul };
  }

  saveConfig(next, opts.configPath);
  const route = applyRouteEnv(next);
  try {
    opts.onRouteChange?.(route);
  } catch {
    /* host cleanup is best-effort */
  }

  return {
    ok: true,
    route,
    relay: publicStatus(opts.configPath),
  };
}

/**
 * Public status for UI (no full key).
 * @param {string} [configPath]
 */
export function publicStatus(configPath) {
  const r = loadConfig(configPath);
  const canApi = !!(r.baseUrl && r.apiKey);
  const mode = effectiveMode(r);
  return {
    mode,
    station: r.station || "account",
    baseUrl: r.baseUrl || "",
    apiKeySet: !!r.apiKey,
    canApi,
    priceMul: r.priceMul,
    wallet: walletSummary(configPath),
  };
}

/**
 * Load config + apply env in one call. Use before every Agent SDK turn.
 * @param {string} [configPath]
 */
export function applyFromConfig(configPath) {
  const cfg = loadConfig(configPath);
  return applyRouteEnv(cfg);
}

export { canUseApi, effectiveMode, normalizeConfig };
