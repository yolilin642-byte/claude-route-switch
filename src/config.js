import fs from "node:fs";
import path from "node:path";
import { normalizeConfig } from "./env.js";

const DEFAULTS = {
  station: "account",
  baseUrl: "",
  apiKey: "",
  priceMul: 1,
};

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
 * Load route config from disk.
 * Supports either flat `{ station, baseUrl, apiKey, priceMul }`
 * or nested `{ ccRelay: { ... } }` (compat with some host apps).
 * @param {string} [file]
 */
export function loadConfig(file) {
  const p = resolveConfigPath(file);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const raw = j?.ccRelay && typeof j.ccRelay === "object" ? j.ccRelay : j;
    return normalizeConfig({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
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
    disk = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    disk = {};
  }

  const next = normalizeConfig({
    ...DEFAULTS,
    ...(disk.ccRelay || disk),
    ...patch,
  });

  // Nested host shape
  if (disk.ccRelay || Object.keys(disk).some((k) => !["station", "baseUrl", "apiKey", "priceMul"].includes(k))) {
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

/**
 * Merge rules used when UI saves settings (never wipe URL/Key by accident).
 * - Missing baseUrl field → keep previous
 * - Explicit empty baseUrl → clear
 * - apiKey masked / empty / unchanged → keep previous
 * - apiKey === "__clear__" → clear
 * @param {object} prev
 * @param {object} patch
 */
export function mergeConfigPatch(prev = {}, patch = {}) {
  const station = String(patch.station || prev.station || "account");
  let baseUrl = Object.prototype.hasOwnProperty.call(patch, "baseUrl")
    ? String(patch.baseUrl || "").trim().replace(/\/+$/, "")
    : String(prev.baseUrl || "").trim().replace(/\/+$/, "");

  let apiKey = prev.apiKey || "";
  const incoming = patch.apiKey;
  if (incoming === "__clear__") apiKey = "";
  else if (
    typeof incoming === "string" &&
    incoming.trim() &&
    !incoming.includes("•") &&
    !/^•|^\*+$/.test(incoming.trim())
  ) {
    apiKey = incoming.trim();
  }

  let priceMul = Number(prev.priceMul) > 0 ? Number(prev.priceMul) : 1;
  if (patch.priceMul != null && Number(patch.priceMul) > 0) priceMul = Number(patch.priceMul);

  return normalizeConfig({ station, baseUrl, apiKey, priceMul });
}
