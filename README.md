# claude-route-switch

Switch **Claude Agent SDK** / **Claude Code** between:

| Mode | Meaning |
|------|---------|
| **account** | Official login (clear relay env → SDK uses default auth) |
| **api** | Anthropic-compatible **Base URL + API key** (third-party relay) |

Optional: a **local USD wallet** that estimates cost from token usage (most relays do not expose a balance API).

Extracted as a standalone library from a private home chat stack. No product UI, no secrets, no personal data.

## Why

When the official account hits rate limits, you can keep the same Agent SDK `query()` path and only change the **egress**:

```
applyRouteEnv(config)  →  process.env.ANTHROPIC_*  →  @anthropic-ai/claude-agent-sdk
```

The conversation survives the switch because transcripts are plain JSONL keyed by `cwd` + `session_id` — they record *what happened*, not *which credential paid for it*. Auth is applied per request. See [RESEARCH.md](./RESEARCH.md) for the sourced write-up (session file format, resume semantics, prompt-cache behaviour across accounts, and the policy line you should not cross).

## Install

```bash
# clone or copy this folder
cd claude-route-switch
npm link   # optional global CLI: claude-route
```

Zero runtime dependencies (Node ≥ 18), so there is no `npm install` step for the folder itself.

Not published to npm. To `import` it from another project, install it straight from GitHub:

```bash
npm install github:yolilin642-byte/claude-route-switch
```

## Quick start

```bash
cp config.example.json config.json
# edit config.json: baseUrl + apiKey for API mode

npx claude-route set --url "https://your-relay.example" --key "<your-relay-key>" --station custom
npx claude-route api       # switch to API
npx claude-route status
npx claude-route account   # switch back to official login
```

Config and wallet stay local (`config.json`, `wallet.json`) and are **gitignored**.

## Programmatic use

```js
import {
  applyFromConfig,
  setRouteMode,
  recordSpend,
  publicStatus,
} from "claude-route-switch";

// Before every SDK turn:
const route = applyFromConfig(); // reads ./config.json or CLAUDE_ROUTE_CONFIG

// Or switch without wiping credentials:
setRouteMode("api");     // needs baseUrl+apiKey already saved
setRouteMode("account");

// After a turn (API mode only):
recordSpend({
  usage: {
    input_tokens: 1200,
    output_tokens: 400,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 800,
  },
  model: "claude-sonnet-4-...",
  route,
});
```

### Env contract

| Mode | Action |
|------|--------|
| **api** | Set `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`; **delete** `ANTHROPIC_AUTH_TOKEN` (so OAuth cannot override the key) |
| **account** | Delete `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` |

Call `applyRouteEnv` / `applyFromConfig` **immediately before** each `query()`. Concurrent account/API paths in one process will stomp each other — serialize turns or use separate processes.

### Config shape

```json
{
  "station": "account",
  "baseUrl": "https://api.example.com",
  "apiKey": "<your-relay-key>",
  "priceMul": 1,
  "rates": {}
}
```

- `station: "account"` → always account mode (URL/Key kept on disk for later).
- Any other station + non-empty URL+Key → API mode.
- `apiKey` is **never validated by prefix**. Anthropic Console keys start with `sk-ant-`, but third-party relays issue keys in their own formats (`fe…`, `cr_…`, bare hex, …). Any non-empty string is passed through to `ANTHROPIC_API_KEY` as-is.
- `rates` is optional; see [Pricing non-Claude models](#pricing-non-claude-models).
- Nested host apps may store the same object under `ccRelay` — load/save still work.
- A UTF-8 BOM in `config.json` is tolerated (Notepad and PowerShell's `Out-File -Encoding utf8` both write one). Any other parse error is reported on stderr rather than silently falling back to defaults.

Safe UI merge (do not wipe secrets when the form sends masks / empty disabled fields):

```js
import { mergeConfigPatch, saveConfig, loadConfig } from "claude-route-switch";
saveConfig(mergeConfigPatch(loadConfig(), formPatch));
```

### Wallet

Local ledger only (public list prices × `priceMul`):

```bash
claude-route topup 20
claude-route wallet
claude-route estimate --in 1000000 --out 0 --model sonnet
```

### Pricing non-Claude models

Built-in rates cover **haiku / sonnet / opus** only. Any other model name falls back to
Opus-tier rates — a relay running `gpt-4o-mini` would otherwise be billed at roughly 100x
its real price. The fallback is no longer silent: estimates carry `assumed: true`, and the
wallet lists the offending models under `assumedModels` with a `warn`.

```bash
$ claude-route estimate --in 1000000 --out 1000000 --model gpt-4o-mini
{ "usd": 90, "tier": "opus", "assumed": true, "warn": "Unknown model ..." }
```

Fix it by declaring the real prices ($ / MTok) in `config.json`. Keys match by exact name
first, then by longest substring, so one entry covers dated variants:

```json
{
  "rates": {
    "gpt-4o-mini": { "in": 0.15, "out": 0.6 },
    "deepseek-chat": { "in": 0.27, "out": 1.1 }
  }
}
```

```bash
$ claude-route estimate --in 1000000 --out 1000000 --model gpt-4o-mini-2024-07-18
{ "usd": 0.75, "tier": "gpt-4o-mini", "assumed": false }
```

`cacheWrite` / `cacheRead` are optional and default to `in × 1.25` and `in × 0.1`.
Third-party prices are deliberately **not** bundled: they change often and would rot in a
release. The library only promises to be honest about what it does not know.

## CLI

```
claude-route status
claude-route api | account
claude-route set --url U --key K [--mul N] [--station custom]
claude-route topup <usd>
claude-route wallet [set <usd>|reset]
claude-route estimate --in N --out N [--model sonnet|haiku|opus]
claude-route apply
```

Env overrides:

- `CLAUDE_ROUTE_CONFIG` — config path  
- `CLAUDE_ROUTE_WALLET` — wallet path  

## Several subscription accounts

[MULTI-ACCOUNT.zh-CN.md](./MULTI-ACCOUNT.zh-CN.md) (Chinese) is the sequel: several Pro/Max accounts plus API side by side on one machine, sharing one session store. Every claim is tagged *tested* / *inferred* / *unverified*, with CLI versions and dates. All of it was tested from an Agent SDK host (one CLI subprocess per `query()`); interactive terminal sessions, including several in tmux, were only spot-checked with `claude -p`. It covers:

- passing a per-call `options.env` to the Agent SDK instead of mutating `process.env`, so concurrent turns can use different egresses
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` on **Windows** (it is not macOS-only), and the `/login` overwrite trap
- reading 5h / 7-day usage from `rate_limit_event`, which works with a `setup-token` too, even though that token cannot call the usage endpoint
- login credentials expire after ~29 days no matter how often they refresh

## Examples

- `examples/with-agent-sdk.mjs` — apply route, optional SDK ping, record spend  
- `examples/shell-wrapper.sh` — export env then `exec` Claude Code  

## What this is not

- Not a proxy server  
- Not a guarantee every third-party “Claude compatible” relay works  
- Not affiliated with Anthropic  
- You are responsible for ToS / provider compliance  

## Tests

```bash
npm test
```

## License

MIT

## Origin

Logic distilled from a private Node host that wraps `@anthropic-ai/claude-agent-sdk`: same session stack, switchable egress when the main account is limited. This package is the portable core only.
