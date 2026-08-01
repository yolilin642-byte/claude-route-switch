#!/usr/bin/env bash
# Apply route env then run Claude Code / any child that reads Anthropic env.
# Usage: ./examples/shell-wrapper.sh claude
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLAUDE_ROUTE_CONFIG="${CLAUDE_ROUTE_CONFIG:-$ROOT/config.json}"

# Print env exports from apply (node prints JSON; we set vars here via node -e)
eval "$(node --input-type=module -e "
import { applyFromConfig, loadConfig } from './src/index.js';
import { resolveConfigPath } from './src/config.js';
const cfgPath = process.env.CLAUDE_ROUTE_CONFIG;
const route = applyFromConfig(cfgPath);
if (route.mode === 'api') {
  const c = (await import('./src/config.js')).loadConfig(cfgPath);
  console.log('export ANTHROPIC_BASE_URL=' + JSON.stringify(c.baseUrl));
  console.log('export ANTHROPIC_API_KEY=' + JSON.stringify(c.apiKey));
  console.log('unset ANTHROPIC_AUTH_TOKEN');
} else {
  console.log('unset ANTHROPIC_BASE_URL');
  console.log('unset ANTHROPIC_API_KEY');
}
console.error('# mode=' + route.mode);
" 2>/dev/null)"

exec "$@"
