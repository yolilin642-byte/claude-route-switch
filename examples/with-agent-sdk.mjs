/**
 * One turn on a lane through the Claude Agent SDK, with the lane's own env.
 * Requires: npm i @anthropic-ai/claude-agent-sdk
 * Config: copy config.example.json → config.json and fill in the pool.
 *
 *   node examples/with-agent-sdk.mjs              global route
 *   node examples/with-agent-sdk.mjs night        lane "night"
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envFor, recordSpend, walletSummary } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.CLAUDE_ROUTE_CONFIG || path.join(__dirname, "..", "config.json");
const lane = process.argv[2];

// A fresh env for this query only; process.env is not touched.
const { env, route } = envFor(lane, { configPath });
console.log("route:", route);

// Dynamic import so this file still loads without the SDK installed
let query;
try {
  ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
} catch {
  console.log("\n(SDK not installed — route resolved only.)");
  console.log("npm i @anthropic-ai/claude-agent-sdk");
  process.exit(0);
}

for await (const msg of query({
  prompt: "Reply with one short sentence: routing works.",
  options: {
    env,
    cwd: process.cwd(),
    model: "haiku",
    maxTurns: 1,
    allowedTools: [],
  },
})) {
  if (msg.type === "rate_limit_event") {
    // Usage of whichever account this lane is on (setup-token accounts included).
    const w = msg.rate_limit_info?.unifiedWindows ?? {};
    console.log("usage: 5h", w.five_hour?.utilization, "/ 7d", w.seven_day?.utilization);
  }
  if (msg.type === "result") {
    console.log("result:", msg.result);
    const model = Object.keys(msg.modelUsage ?? {})[0] || "";
    const led = recordSpend({ usage: msg.usage, model, route, configPath }); // api routes only
    if (led) console.log("wallet:", walletSummary(configPath, lane));
  }
}
