import { normalizeConfig } from "./env.js";

/**
 * Mask API key for UI responses (never send full key to the client).
 * @param {string} key
 */
export function maskApiKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `••••${s.slice(-4)}`;
}

/**
 * @param {object} cfg
 */
export function publicConfig(cfg = {}) {
  const c = normalizeConfig(cfg);
  return {
    station: c.station,
    baseUrl: c.baseUrl,
    apiKey: maskApiKey(c.apiKey),
    apiKeySet: !!c.apiKey,
    priceMul: c.priceMul,
    accountId: c.accountId,
    activeUrlId: c.activeUrlId,
    activeKeyId: c.activeKeyId,
    urls: c.urls,
    keys: c.keys.map(({ id, name, urlId, secret }) => ({ id, name, urlId, secret: maskApiKey(secret), secretSet: !!secret })),
    accounts: c.accounts.map(({ id, name, oauthToken, keyDir, prefer }) => ({
      id, name, prefer, tokenSet: !!oauthToken, keyDirSet: !!keyDir,
    })),
    lanes: Object.fromEntries(
      Object.entries(c.lanes).map(([lane, r]) => [
        lane,
        r.station === "account"
          ? { station: "account", accountId: r.accountId || "main" }
          : { station: r.station, baseUrl: r.baseUrl, keyName: r.keyName, urlName: r.urlName, apiKeySet: !!r.apiKey },
      ]),
    ),
  };
}
