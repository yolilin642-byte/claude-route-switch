#!/usr/bin/env node
/**
 * CLI: claude-route status | api | account | set | topup | estimate
 */
import {
  applyFromConfig,
  envSnapshot,
  loadConfig,
  publicStatus,
  saveConfig,
  setRouteMode,
  estimateUsd,
  walletAct,
  walletSummary,
  resolveConfigPath,
  resolveWalletPath,
} from "../src/index.js";

function help() {
  console.log(`claude-route — switch Claude between main account and API relay

Usage:
  claude-route status              Show mode, paths, wallet (no full key)
  claude-route account             Switch to official login
  claude-route api                 Switch to API (needs baseUrl + apiKey)
  claude-route set --url U --key K [--mul N] [--station custom]
  claude-route topup <usd>         Add to local wallet balance
  claude-route wallet set <usd>    Set wallet balance
  claude-route wallet reset        Clear used + history
  claude-route estimate --in N --out N [--model sonnet] [--mul 1]
  claude-route apply               Apply env from config (for shell wrappers)

Env:
  CLAUDE_ROUTE_CONFIG   path to config.json
  CLAUDE_ROUTE_WALLET   path to wallet.json

Config example: copy config.example.json → config.json
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" || a === "--baseUrl") args.url = argv[++i];
    else if (a === "--key" || a === "--apiKey") args.key = argv[++i];
    else if (a === "--mul" || a === "--priceMul") args.mul = Number(argv[++i]);
    else if (a === "--station") args.station = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--in") args.in = Number(argv[++i]);
    else if (a === "--out") args.out = Number(argv[++i]);
    else if (a === "--cache-write") args.cw = Number(argv[++i]);
    else if (a === "--cache-read") args.cr = Number(argv[++i]);
    else if (a === "--config") args.config = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

function printStatus(configPath) {
  const s = publicStatus(configPath);
  const env = envSnapshot();
  console.log(JSON.stringify({
    config: resolveConfigPath(configPath),
    walletFile: resolveWalletPath(configPath),
    mode: s.mode,
    station: s.station,
    baseUrl: s.baseUrl,
    apiKeySet: s.apiKeySet,
    canApi: s.canApi,
    priceMul: s.priceMul,
    wallet: s.wallet,
    envNow: env,
  }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args._.length === 0) {
  help();
  process.exit(args.help ? 0 : 1);
}

const cmd = args._[0];
const configPath = args.config;

try {
  if (cmd === "status") {
    printStatus(configPath);
    process.exit(0);
  }

  if (cmd === "account" || cmd === "api") {
    const r = setRouteMode(cmd, { configPath });
    if (!r.ok) {
      console.error(r.error);
      process.exit(1);
    }
    printStatus(configPath);
    process.exit(0);
  }

  if (cmd === "set") {
    if (!args.url && !args.key && args.station == null && args.mul == null) {
      console.error("set needs at least one of --url --key --station --mul");
      process.exit(1);
    }
    const prev = loadConfig(configPath);
    const next = saveConfig(
      {
        ...prev,
        ...(args.url != null ? { baseUrl: args.url } : {}),
        ...(args.key != null ? { apiKey: args.key } : {}),
        ...(args.station != null ? { station: args.station } : {}),
        ...(args.mul != null ? { priceMul: args.mul } : {}),
      },
      configPath,
    );
    console.log(JSON.stringify({
      ok: true,
      station: next.station,
      baseUrl: next.baseUrl,
      apiKeySet: !!next.apiKey,
      priceMul: next.priceMul,
    }, null, 2));
    process.exit(0);
  }

  if (cmd === "topup") {
    const amount = Number(args._[1]);
    const r = walletAct("topup", amount, configPath);
    if (r.error) {
      console.error(r.error);
      process.exit(1);
    }
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  if (cmd === "wallet") {
    const sub = args._[1];
    if (sub === "set") {
      const r = walletAct("set", Number(args._[2]), configPath);
      if (r.error) {
        console.error(r.error);
        process.exit(1);
      }
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    }
    if (sub === "reset") {
      console.log(JSON.stringify(walletAct("reset_used", 0, configPath), null, 2));
      process.exit(0);
    }
    console.log(JSON.stringify(walletSummary(configPath), null, 2));
    process.exit(0);
  }

  if (cmd === "estimate") {
    const usd = estimateUsd(
      {
        input_tokens: args.in || 0,
        output_tokens: args.out || 0,
        cache_creation_input_tokens: args.cw || 0,
        cache_read_input_tokens: args.cr || 0,
      },
      args.model || "opus",
      args.mul || 1,
    );
    console.log(JSON.stringify({ usd, model: args.model || "opus", priceMul: args.mul || 1 }, null, 2));
    process.exit(0);
  }

  if (cmd === "apply") {
    const route = applyFromConfig(configPath);
    console.log(JSON.stringify({ applied: route, env: envSnapshot() }, null, 2));
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  help();
  process.exit(1);
} catch (e) {
  console.error(e?.message || e);
  process.exit(1);
}
