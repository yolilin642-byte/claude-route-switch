/**
 * Per-query egress: build a fresh env for one Agent SDK `query()` instead of mutating the
 * shared process.env, so several conversations ("lanes") can run at the same time, each on
 * its own route — the machine login, a named subscription account, or an API relay.
 *
 * A lane is whatever your host runs side by side: a chat window, a bot channel, a job.
 * Lanes without their own entry in `config.lanes` follow the global default.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { normalizeConfig } from "./env.js";

/** Every variable a route may set or clear. Anything else in the env is left alone. */
export const ROUTE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
];

const MAIN = { id: "main", name: "main", oauthToken: "", keyDir: "", prefer: "keyDir" };

/**
 * Does this key folder hold a live login? When a login expires, the CLI blanks
 * `accessToken` but leaves `.credentials.json` in place, so file size says nothing —
 * read the token itself.
 * @param {string} dir
 */
export function keyDirUsable(dir) {
  if (!dir) return false;
  try {
    const raw = fs.readFileSync(path.join(dir, ".credentials.json"), "utf8").replace(/^﻿/, "");
    const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof tok === "string" && tok.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Find an account by id or name: exact first, then a unique partial match.
 * Empty / "main" / "default" is the machine's own login.
 * @param {object} config
 * @param {string[]|string} [words]
 * @returns {object} account, or `{ error }`
 */
export function resolveAccount(config, words = []) {
  const cfg = normalizeConfig(config);
  const all = [MAIN, ...cfg.accounts];
  const wanted = (Array.isArray(words) ? words : String(words || "").split(/\s+/))
    .filter(Boolean)
    .join(" ")
    .trim()
    .toLowerCase();
  if (!wanted || wanted === "main" || wanted === "default") return MAIN;
  const exact = all.filter((a) => a.id === wanted || a.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const fuzzy = all.filter((a) => a.id.includes(wanted) || a.name.toLowerCase().includes(wanted));
  if (fuzzy.length === 1) return fuzzy[0];
  const names = all.map((a) => a.name).join(" / ");
  if (fuzzy.length > 1) return { error: `account "${wanted}" is ambiguous: ${fuzzy.map((a) => a.name).join(" / ")}` };
  return { error: `no account "${wanted}". Known: ${names}` };
}

/**
 * Pick a URL / key pair from the pool by name or id (exact first, then partial).
 * A word matching both a key and a URL counts as the key. If only one side is named,
 * the other comes from its pairing (`keys[].urlId` or `urls[].keyId`), then from the
 * current global baseUrl / apiKey.
 * @param {object} config
 * @param {string[]} words
 */
export function pickFromPool(config, words = []) {
  const cfg = normalizeConfig(config);
  const { urls, keys } = cfg;
  const find = (arr, w, fields) =>
    arr.find((x) => fields.some((f) => String(x[f] || "").toLowerCase() === w)) ||
    arr.find((x) => fields.some((f) => String(x[f] || "").toLowerCase().includes(w)));
  let url = null;
  let key = null;
  const unknown = [];
  for (const raw of words) {
    const w = String(raw).toLowerCase();
    const k = find(keys, w, ["name", "id"]);
    const u = find(urls, w, ["name", "id", "baseUrl"]);
    if (k && !key) key = k;
    else if (u && !url) url = u;
    else unknown.push(raw);
  }
  if (unknown.length) {
    const names = [...urls.map((x) => `url:${x.name}`), ...keys.map((x) => `key:${x.name}`)].join(" / ");
    return { error: `not in the pool: ${unknown.join(" ")}. Known: ${names || "(empty)"}` };
  }
  if (!url && key) url = (key.urlId && urls.find((x) => x.id === key.urlId)) || urls.find((x) => x.keyId === key.id) || null;
  if (!key && url) key = (url.keyId && keys.find((x) => x.id === url.keyId)) || keys.find((x) => x.urlId === url.id) || null;
  return {
    baseUrl: url?.baseUrl || cfg.baseUrl,
    apiKey: key?.secret || cfg.apiKey,
    urlId: url?.id || cfg.activeUrlId,
    keyId: key?.id || cfg.activeKeyId,
    urlName: url?.name || "",
    keyName: key?.name || "",
  };
}

/**
 * The route a lane runs on right now, with secrets. Keep it on the server side.
 * @param {object} config
 * @param {string} [lane] omit for the global default
 */
export function resolveRoute(config, lane) {
  const cfg = normalizeConfig(config);
  const own = lane != null && lane !== "" ? cfg.lanes[String(lane)] : null;
  const r = own
    ? { ...own, priceMul: cfg.priceMul }
    : {
        station: cfg.station,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        priceMul: cfg.priceMul,
        keyId: cfg.activeKeyId,
        urlId: cfg.activeUrlId,
        accountId: cfg.accountId,
      };
  const base = { lane: lane == null ? "" : String(lane), ownRoute: !!own, priceMul: r.priceMul };
  if (r.station !== "account" && r.baseUrl && r.apiKey) {
    return {
      ...base,
      mode: "api",
      station: r.station,
      baseUrl: r.baseUrl,
      apiKey: r.apiKey,
      keyId: r.keyId || "",
      urlId: r.urlId || "",
      keyName: r.keyName || "",
      urlName: r.urlName || "",
    };
  }
  const account = resolveAccount(cfg, [r.accountId || "main"]);
  if (account.error) throw new Error(account.error);
  return { ...base, mode: "account", station: "account", baseUrl: "", priceMul: 1, account };
}

/**
 * Build the env for one query from a resolved route. Never mutates `base`.
 *
 * - api: sets ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY, drops ANTHROPIC_AUTH_TOKEN
 *   (it would win over the key) and CLAUDE_SECURESTORAGE_CONFIG_DIR.
 * - main account: drops the relay vars and CLAUDE_SECURESTORAGE_CONFIG_DIR, so a value
 *   inherited from another account's lane can never point main at someone else's key
 *   folder (running /login there would overwrite that account's credentials).
 *   Whatever OAuth setup the process itself was started with stays.
 * - named account: its key folder (CLAUDE_SECURESTORAGE_CONFIG_DIR) or its setup-token
 *   (CLAUDE_CODE_OAUTH_TOKEN), per `prefer`; an empty key folder falls back to the token.
 *   CLAUDE_CONFIG_DIR is never touched, so transcripts, CLAUDE.md and settings stay shared.
 *
 * @param {object} resolved from resolveRoute()
 * @param {NodeJS.ProcessEnv} [base=process.env]
 * @returns {{ env: Record<string, string>, route: object }}
 */
export function routeEnv(resolved, base = process.env) {
  const env = { ...base };
  const route = publicRoute(resolved);
  if (resolved.mode === "api") {
    env.ANTHROPIC_BASE_URL = resolved.baseUrl;
    env.ANTHROPIC_API_KEY = resolved.apiKey;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Not needed for the key to work; dropped so a /login typed on this route cannot land
    // in an inherited key folder.
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    return { env, route: { ...route, credential: "api" } };
  }
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  const acc = resolved.account || MAIN;
  if (acc.id === "main") {
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    return { env, route: { ...route, credential: "login" } };
  }
  const dirOk = keyDirUsable(acc.keyDir);
  const useDir = dirOk && !(acc.prefer === "token" && acc.oauthToken);
  if (useDir) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = acc.keyDir;
    return { env, route: { ...route, credential: "keyDir" } };
  }
  if (acc.oauthToken) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    env.CLAUDE_CODE_OAUTH_TOKEN = acc.oauthToken;
    return { env, route: { ...route, credential: "token" } };
  }
  throw new Error(
    `account "${acc.id}" has no usable credential: ` +
      (acc.keyDir ? "its key folder holds no live login" : "no keyDir") + " and no oauthToken",
  );
}

/**
 * Route summary without secrets — safe for logs, UIs and the wallet.
 * @param {object} resolved
 */
export function publicRoute(resolved) {
  if (resolved.mode === "api") {
    return {
      mode: "api",
      station: resolved.station,
      baseUrl: resolved.baseUrl,
      priceMul: resolved.priceMul,
      lane: resolved.lane,
      ownRoute: resolved.ownRoute,
      keyId: resolved.keyId,
      urlId: resolved.urlId,
      keyName: resolved.keyName,
      urlName: resolved.urlName,
    };
  }
  return {
    mode: "account",
    station: "account",
    baseUrl: "",
    priceMul: 1,
    lane: resolved.lane,
    ownRoute: resolved.ownRoute,
    accountId: resolved.account?.id || "main",
    accountName: resolved.account?.name || "main",
  };
}

/**
 * Load config from disk and build one query's env for a lane. Call it right before each
 * `query()` and pass the result as `options.env`.
 * @param {string} [lane]
 * @param {{ configPath?: string, base?: NodeJS.ProcessEnv }} [opts]
 */
export function envFor(lane, opts = {}) {
  return routeEnv(resolveRoute(loadConfig(opts.configPath), lane), opts.base || process.env);
}
