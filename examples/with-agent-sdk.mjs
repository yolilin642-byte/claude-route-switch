/**
 * Minimal sketch: apply route env, then call Claude Agent SDK.
 * Requires: npm i @anthropic-ai/claude-agent-sdk
 * Config: copy config.example.json → config.json and fill URL/Key if using API.
 *
 *   node examples/with-agent-sdk.mjs
 *   node examples/with-agent-sdk.mjs account
 *   node examples/with-agent-sdk.mjs api
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyFromConfig,
  setRouteMode,
  publicStatus,
  recordSpend,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config.json");

const target = process.argv[2];
if (target === "api" || target === "account") {
  const r = setRouteMode(target, { configPath });
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
}

const route = applyFromConfig(configPath);
console.log("route:", publicStatus(configPath));

// Dynamic import so this file still loads without the SDK installed
let query;
try {
  ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
} catch {
  console.log("\n(SDK not installed — env was applied only.)");
  console.log("npm i @anthropic-ai/claude-agent-sdk");
  process.exit(0);
}

const prompt = "Reply with one short sentence: routing works.";
let usage = null;
let model = "";

for await (const msg of query({
  prompt,
  options: {
    cwd: process.cwd(),
    // keep tools minimal for the demo
    allowedTools: [],
  },
})) {
  if (msg?.type === "result") {
    usage = msg.usage || msg.result?.usage || null;
    model = msg.model || msg.result?.model || "";
    console.log("result:", msg.result?.result || msg.result || msg);
  } else if (msg?.type === "assistant" && msg.message?.content) {
    // stream-ish
  }
}

if (usage) {
  const led = recordSpend({ usage, model, route, configPath });
  if (led) console.log("wallet after:", led.usedUsd, "used");
}
