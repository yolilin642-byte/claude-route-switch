import fs from "node:fs";
import path from "node:path";
import { normalizeConfig } from "./env.js";

const DEFAULTS = {
  station: "account",
  baseUrl: "",
  apiKey: "",
  priceMul: 1,
  rates: {},
};

const OWN_KEYS = [
  "station", "baseUrl", "apiKey", "priceMul", "rates",
  "accountId", "activeUrlId", "activeKeyId", "urls", "keys", "accounts", "lanes",
];

/**
 * Resolve config file path.
 * Env CLAUDE_ROUTE_CONFIG wins; else ./config.json under cwd.
 * @param {string} [file]
 */
export function resolveConfigPath(file) {
  if (file) return path.resolve(file);
  if (process.env.CLAUDE_ROUTE_CONFIG) return path.resolve(process.env.CLAUDE_ROUTE_CONFIG);
  return path.resolve(process.cwd(), "config.json");
}

/**
 * Read + parse JSON, tolerating a UTF-8 BOM (Notepad / PowerShell `Out-File -Encoding utf8`
 * both write one, and a BOM makes JSON.parse throw — which used to silently reset the
 * whole config to defaults).
 * @param {string} p
 */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
}

/**
 * Load route config from disk.
 * Supports either flat `{ station, baseUrl, apiKey, priceMul, rates }`
 * or nested `{ ccRelay: { ... } }` (compat with some host apps).
 * @param {string} [file]
 */
export function loadConfig(file) {
  const p = resolveConfigPath(file);
  try {
    const j = readJson(p);
    const raw = j?.ccRelay && typeof j.ccRelay === "object" ? j.ccRelay : j;
    return normalizeConfig({ ...DEFAULTS, ...raw });
  } catch (err) {
    // Missing file is normal; a malformed one is not — say so instead of pretending it's empty.
    if (err && err.code !== "ENOENT" && fs.existsSync(p)) {
      console.warn(`[claude-route] ignoring unreadable config ${p}: ${err.message}`);
    }
    return normalizeConfig(DEFAULTS);
  }
}

/**
 * Save route config. Preserves sibling keys if the file is a larger settings object
 * with a `ccRelay` field; otherwise writes a flat config.
 * @param {object} patch
 * @param {string} [file]
 */
export function saveConfig(patch, file) {
  const p = resolveConfigPath(file);
  let disk = {};
  try {
    disk = readJson(p);
  } catch {
    disk = {};
  }

  const next = normalizeConfig({
    ...DEFAULTS,
    ...(disk.ccRelay || disk),
    ...patch,
  });

  // Nested host shape
  if (disk.ccRelay || Object.keys(disk).some((k) => !OWN_KEYS.includes(k))) {
    if (!disk.ccRelay) {
      // First time embedding into a larger object without ccRelay — write flat if disk empty-ish
      if (Object.keys(disk).length === 0) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
        return next;
      }
    }
    disk.ccRelay = next;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(disk, null, 2), "utf8");
    return next;
  }

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return next;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A secret the UI sent back masked or blank — means "unchanged". */
function isMasked(s) {
  return typeof s !== "string" || !s.trim() || s.includes("•") || /^\*+$/.test(s.trim());
}

/** Incoming secret wins unless masked; "__clear__" clears. */
function keepSecret(incoming, previous) {
  if (incoming === "__clear__") return "";
  return isMasked(incoming) ? previous || "" : incoming.trim();
}

/**
 * Merge rules used when UI saves settings (never wipe URL/Key by accident).
 * - Missing baseUrl field → keep previous
 * - Explicit empty baseUrl → clear
 * - apiKey masked / empty / unchanged → keep previous
 * - apiKey === "__clear__" → clear
 * - Pool lists (`urls`, `keys`, `accounts`) and `lanes`: missing → keep; present → replace,
 *   except that a masked `keys[].secret` / `accounts[].oauthToken` keeps the stored one
 *   for the same id.
 * @param {object} prev
 * @param {object} patch
 */
export function mergeConfigPatch(prev = {}, patch = {}) {
  const old = normalizeConfig(prev);
  const station = String(patch.station || old.station || "account");
  const baseUrl = has(patch, "baseUrl") ? patch.baseUrl : old.baseUrl;
  const apiKey = has(patch, "apiKey") ? keepSecret(patch.apiKey, old.apiKey) : old.apiKey;

  let priceMul = old.priceMul;
  if (patch.priceMul != null && Number(patch.priceMul) > 0) priceMul = Number(patch.priceMul);

  // Missing `rates` keeps the previous table; an explicit object (even {}) replaces it.
  const rates = has(patch, "rates") ? patch.rates : old.rates;

  const keys = has(patch, "keys") && Array.isArray(patch.keys)
    ? patch.keys.map((k) => ({
        ...k,
        secret: keepSecret(k?.secret, old.keys.find((o) => o.id === String(k?.id || k?.name || "").trim())?.secret),
      }))
    : old.keys;
  const accounts = has(patch, "accounts") && Array.isArray(patch.accounts)
    ? patch.accounts.map((a) => ({
        ...a,
        oauthToken: keepSecret(a?.oauthToken, old.accounts.find((o) => o.id === String(a?.id || "").trim().toLowerCase())?.oauthToken),
      }))
    : old.accounts;

  return normalizeConfig({
    ...old,
    station,
    baseUrl,
    apiKey,
    priceMul,
    rates,
    keys,
    accounts,
    urls: has(patch, "urls") ? patch.urls : old.urls,
    lanes: has(patch, "lanes") ? patch.lanes : old.lanes,
    accountId: has(patch, "accountId") ? patch.accountId : old.accountId,
    activeUrlId: has(patch, "activeUrlId") ? patch.activeUrlId : old.activeUrlId,
    activeKeyId: has(patch, "activeKeyId") ? patch.activeKeyId : old.activeKeyId,
  });
}
