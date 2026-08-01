/**
 * Apply or clear Anthropic / Claude Agent SDK routing env vars.
 *
 * API mode sets:
 *   ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
 * and removes ANTHROPIC_AUTH_TOKEN so OAuth cannot override the relay key.
 *
 * Account mode deletes the relay env vars so the SDK uses default login.
 */

/**
 * @typedef {object} RouteConfig
 * @property {string} [station]  "account" | "custom" | any non-account id for API
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {number} [priceMul]
 */

/**
 * @typedef {object} RouteResult
 * @property {"account"|"api"} mode
 * @property {string} station
 * @property {string} baseUrl
 * @property {number} priceMul
 */

/**
 * Normalize config fields.
 * @param {RouteConfig} r
 * @returns {Required<Pick<RouteConfig,"station"|"baseUrl"|"apiKey"|"priceMul">>}
 */
export function normalizeConfig(r = {}) {
  return {
    station: String(r.station || "account"),
    baseUrl: String(r.baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: String(r.apiKey || "").trim(),
    priceMul: Number(r.priceMul) > 0 ? Number(r.priceMul) : 1,
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
 * Apply route to process.env. Call this immediately before every SDK query.
 * @param {RouteConfig} config
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {RouteResult}
 */
export function applyRouteEnv(config, env = process.env) {
  const r = normalizeConfig(config);
  const useApi = r.station !== "account" && r.baseUrl && r.apiKey;
  if (useApi) {
    env.ANTHROPIC_BASE_URL = r.baseUrl;
    env.ANTHROPIC_API_KEY = r.apiKey;
    // Prevent OAuth / login token from winning over the relay key
    delete env.ANTHROPIC_AUTH_TOKEN;
    return {
      mode: "api",
      station: r.station,
      baseUrl: r.baseUrl,
      priceMul: r.priceMul,
    };
  }
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  return {
    mode: "account",
    station: "account",
    baseUrl: "",
    priceMul: 1,
  };
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
