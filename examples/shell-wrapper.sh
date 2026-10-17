#!/usr/bin/env bash
# Set one lane's route env, then run Claude Code / any child that reads Anthropic env.
# Usage: CLAUDE_ROUTE_LANE=night ./examples/shell-wrapper.sh claude -p "hi"
#        ./examples/shell-wrapper.sh claude          (no lane = the global route)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CLAUDE_ROUTE_CONFIG="${CLAUDE_ROUTE_CONFIG:-$ROOT/config.json}"

# node prints one export/unset line per route variable; values are single-quoted for bash.
exports="$(cd "$ROOT" && node --input-type=module -e "
import { envFor, ROUTE_ENV_KEYS } from './src/index.js';
const { env, route } = envFor(process.env.CLAUDE_ROUTE_LANE || undefined, { configPath: process.env.CLAUDE_ROUTE_CONFIG });
const q = (v) => \"'\" + String(v).replace(/'/g, \"'\\\\''\") + \"'\";
for (const k of ROUTE_ENV_KEYS) console.log(k in env ? 'export ' + k + '=' + q(env[k]) : 'unset ' + k);
console.error('# lane=' + (route.lane || '(global)') + ' mode=' + route.mode + ' credential=' + route.credential);
")"
eval "$exports"

exec "$@"
