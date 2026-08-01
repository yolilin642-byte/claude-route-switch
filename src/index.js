/**
 * claude-route-switch
 *
 * Switch Claude Agent SDK / Claude Code between:
 *   - account: official login (clear relay env)
 *   - api:     Anthropic-compatible base URL + API key
 *
 * Plus optional local USD wallet from token usage estimates.
 */

export {
  applyRouteEnv,
  clearRelayEnv,
  canUseApi,
  effectiveMode,
  normalizeConfig,
  envSnapshot,
} from "./env.js";

export {
  loadConfig,
  saveConfig,
  mergeConfigPatch,
  resolveConfigPath,
} from "./config.js";

export {
  setRouteMode,
  parseRouteTarget,
  publicStatus,
  applyFromConfig,
} from "./route.js";

export { estimateUsd, pickRate, RATES } from "./pricing.js";

export {
  loadLedger,
  saveLedger,
  recordSpend,
  walletSummary,
  walletAct,
  resolveWalletPath,
} from "./wallet.js";

export { maskApiKey, publicConfig } from "./public.js";
