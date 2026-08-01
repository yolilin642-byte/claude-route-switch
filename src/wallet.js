import fs from "node:fs";
import path from "node:path";
import { estimateUsd } from "./pricing.js";
import { loadConfig, resolveConfigPath } from "./config.js";

function defaultLedger() {
  return {
    balanceUsd: 0,
    usedUsd: 0,
    turns: 0,
    lastCostUsd: 0,
    lastAt: null,
    history: [],
  };
}

/**
 * Wallet file next to config, or CLAUDE_ROUTE_WALLET / wallet.json.
 * @param {string} [configPath]
 */
export function resolveWalletPath(configPath) {
  if (process.env.CLAUDE_ROUTE_WALLET) return path.resolve(process.env.CLAUDE_ROUTE_WALLET);
  const cfg = resolveConfigPath(configPath);
  return path.join(path.dirname(cfg), "wallet.json");
}

export function loadLedger(configPath) {
  const p = resolveWalletPath(configPath);
  try {
    return { ...defaultLedger(), ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {
    return defaultLedger();
  }
}

export function saveLedger(patch, configPath) {
  const p = resolveWalletPath(configPath);
  const next = {
    ...loadLedger(configPath),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Record a turn cost when mode is api.
 * @param {{ usage: object, model?: string, route?: { mode: string, priceMul?: number, station?: string, baseUrl?: string }, configPath?: string }} args
 */
export function recordSpend({ usage, model, route, configPath }) {
  if (!route || route.mode !== "api") return null;
  const cfg = loadConfig(configPath);
  const mul = Number(route.priceMul ?? cfg.priceMul) > 0 ? Number(route.priceMul ?? cfg.priceMul) : 1;
  const cost = estimateUsd(usage, model, mul);
  if (!(cost > 0)) return null;

  const led = loadLedger(configPath);
  const entry = {
    ts: Date.now(),
    costUsd: cost,
    model: model || "",
    in: Number(usage.input_tokens || 0),
    out: Number(usage.output_tokens || 0),
    cache_write: Number(usage.cache_creation_input_tokens || 0),
    cache_read: Number(usage.cache_read_input_tokens || 0),
    station: route.station,
    baseUrl: route.baseUrl,
  };
  const history = [entry, ...(Array.isArray(led.history) ? led.history : [])].slice(0, 80);
  const usedUsd = Math.round(((Number(led.usedUsd) || 0) + cost) * 1e6) / 1e6;
  return saveLedger(
    {
      balanceUsd: Number(led.balanceUsd) || 0,
      usedUsd,
      turns: (Number(led.turns) || 0) + 1,
      lastCostUsd: cost,
      lastAt: new Date().toISOString(),
      history,
    },
    configPath,
  );
}

/**
 * @param {string} [configPath]
 */
export function walletSummary(configPath) {
  const led = loadLedger(configPath);
  const balance = Number(led.balanceUsd) || 0;
  const used = Number(led.usedUsd) || 0;
  return {
    currency: "USD",
    balanceUsd: Math.round(balance * 100) / 100,
    usedUsd: Math.round(used * 100) / 100,
    remainUsd: Math.round((balance - used) * 100) / 100,
    turns: Number(led.turns) || 0,
    lastCostUsd: Number(led.lastCostUsd) || 0,
    lastAt: led.lastAt || null,
    recent: Array.isArray(led.history) ? led.history.slice(0, 8) : [],
    note: "Local estimate from public list prices × priceMul. Relays often have no balance API.",
  };
}

/**
 * @param {"topup"|"set"|"reset_used"} action
 * @param {number} [amount]
 * @param {string} [configPath]
 */
export function walletAct(action, amount, configPath) {
  const led = loadLedger(configPath);
  if (action === "topup") {
    if (!(amount > 0) || amount > 1e6) return { error: "topup amount must be in (0, 1e6]" };
    led.balanceUsd = Math.round(((Number(led.balanceUsd) || 0) + amount) * 100) / 100;
    saveLedger(led, configPath);
    return { ok: true, wallet: walletSummary(configPath) };
  }
  if (action === "set") {
    if (!(amount >= 0) || amount > 1e6) return { error: "balance must be in [0, 1e6]" };
    led.balanceUsd = Math.round(amount * 100) / 100;
    saveLedger(led, configPath);
    return { ok: true, wallet: walletSummary(configPath) };
  }
  if (action === "reset_used") {
    saveLedger(
      {
        ...led,
        usedUsd: 0,
        turns: 0,
        lastCostUsd: 0,
        lastAt: null,
        history: [],
      },
      configPath,
    );
    return { ok: true, wallet: walletSummary(configPath) };
  }
  return { error: "unknown wallet action" };
}
