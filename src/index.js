/**
 * claude-route-switch
 *
 * Switch Claude Agent SDK / Claude Code between:
 *   - account: the machine's login, or a named subscription account
 *   - api:     Anthropic-compatible base URL + API key, picked from a named pool
 *
 * per lane (conversation), each query getting its own env.
 * Plus optional local USD wallet from token usage estimates.
 */

export {
  envFor,
  routeEnv,
  resolveRoute,
  publicRoute,
  resolveAccount,
  pickFromPool,
  keyDirUsable,
  ROUTE_ENV_KEYS,
} from "./egress.js";

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

export {
  estimateUsd,
  estimateUsdDetailed,
  pickRate,
  parseClaudeModel,
  normalizeRates,
  RATES,
  PRICES_AS_OF,
} from "./pricing.js";

export {
  loadLedger,
  saveLedger,
  recordSpend,
  walletSummary,
  walletAct,
  resolveWalletPath,
} from "./wallet.js";

export { maskApiKey, publicConfig } from "./public.js";
