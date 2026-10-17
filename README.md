# claude-route-switch

Give each **Claude Agent SDK** / **Claude Code** conversation its own egress:

| Route | What it uses |
|-------|--------------|
| **account** (main) | The machine's own login |
| **account** (named) | Another subscription account: its `claude setup-token` token, or its own key folder |
| **api** | An Anthropic-compatible **base URL + API key**, picked by name from a pool |

Several conversations ("lanes") can run at once on different routes: every `query()` gets a fresh env of its own, nothing global is mutated.

Optional: a **local USD wallet** that estimates relay cost from token usage, per lane and per key (most relays do not expose a balance API).

Extracted as a standalone library from a private home chat stack. No product UI, no secrets, no personal data.

**What's in here · 这里有什么**

- **The package** (`src/`, `bin/`) — this README is its manual. 代码包，下面整页都是它的说明书。
- [docs/RESEARCH.md](./docs/RESEARCH.md) — why a conversation survives switching egress, with sources. 换出口以后对话为什么接得上，带出处的调研。
- [docs/multi-account.zh-CN.md](./docs/multi-account.zh-CN.md) — field notes in Chinese on running several subscription accounts side by side; `envFor()` below is the code it describes. 好几个订阅号并排跑的实测笔记，下面的 `envFor()` 就是它讲的那段代码。

## Why

When an account hits its limit, keep the same Agent SDK `query()` path and only change the **egress**:

```
envFor(lane)  →  { env }  →  query({ prompt, options: { env, resume } })
```

The conversation survives the switch because transcripts are plain JSONL keyed by `cwd` + `session_id` — they record *what happened*, not *which credential paid for it*. Auth is applied per request. See [docs/RESEARCH.md](./docs/RESEARCH.md) for the sourced write-up (session file format, resume semantics, prompt-cache behaviour across accounts, and the policy line you should not cross).

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
cp config.example.json config.json   # fill in your URLs, keys and accounts
npx claude-route list                # what is in the pool (secrets masked)

npx claude-route api work --lane chat      # lane "chat" → key "work" and its paired URL
npx claude-route account b --lane night    # lane "night" → account b
npx claude-route status --lane chat
npx claude-route default --lane chat       # lane "chat" follows the global route again
```

Without `--lane` the same commands change the global route, which every lane without its own entry follows. Config and wallet stay local (`config.json`, `wallet.json`) and are **gitignored**.

## Programmatic use

```js
import { query } from "@anthropic-ai/claude-agent-sdk";
import { envFor, recordSpend } from "claude-route-switch";

// Right before each turn: a fresh env for this lane (reads ./config.json or CLAUDE_ROUTE_CONFIG).
const { env, route } = envFor("chat");

for await (const m of query({ prompt, options: { env, resume: sessionId } })) {
  if (m.type === "rate_limit_event") console.log(m.rate_limit_info.unifiedWindows); // 5h / 7-day usage
  if (m.type === "result") {
    recordSpend({ usage: m.usage, model: Object.keys(m.modelUsage ?? {})[0], route }); // api routes only
  }
}
```

Tested on 2026-10-18 with three lanes in parallel through the Agent SDK: the machine login, account B by setup-token, account B by key folder. Each `rate_limit_event` carried its own account's usage. It arrives for setup-token accounts too, even though those tokens cannot call the usage endpoint.

Switch from code with `setRouteMode("api work", { lane: "chat" })` or `setRouteMode("account b", { lane: "night" })`; leave out `lane` to change the global route. A global switch also writes `process.env`, and `applyFromConfig()` still does that before a turn. That old style is fine for a host with one route at a time; anything concurrent should use `envFor()`, because `process.env` is shared by the whole process.

### Env contract

| Route | Sets | Removes |
|-------|------|---------|
| **api** | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | `ANTHROPIC_AUTH_TOKEN` (it would win over the key), `CLAUDE_SECURESTORAGE_CONFIG_DIR` |
| **account**, main | — | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` |
| **account**, named, key folder | `CLAUDE_SECURESTORAGE_CONFIG_DIR` | the relay pair, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| **account**, named, token | `CLAUDE_CODE_OAUTH_TOKEN` | the relay pair, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` |

- `CLAUDE_CONFIG_DIR` is never touched, so transcripts, `CLAUDE.md` and settings stay shared across every route. Anything else in the env passes through.
- Every route except a key-folder account drops `CLAUDE_SECURESTORAGE_CONFIG_DIR` on purpose: an inherited value points at some account's key folder, and running `/login` there overwrites that account's credentials ([claude-code#79223](https://github.com/anthropics/claude-code/issues/79223)).
- A key folder only counts if its `.credentials.json` holds a non-empty `accessToken`. An expired login leaves the file in place with the token blanked, so file size proves nothing. Then the account falls back to its token. With both present, `prefer` decides (default `keyDir`). No usable credential at all is an error, not an empty token.

### Config shape

```json
{
  "station": "account",
  "accountId": "",
  "priceMul": 1,
  "urls": [{ "id": "u1", "name": "relay-a", "baseUrl": "https://relay-a.example" }],
  "keys": [{ "id": "k1", "name": "work", "secret": "<your-relay-key>", "urlId": "u1" }],
  "accounts": [{ "id": "b", "name": "Account B", "oauthToken": "<setup-token>", "keyDir": "", "prefer": "keyDir" }],
  "lanes": { "night": { "station": "account", "accountId": "b" } },
  "rates": {}
}
```

- The top level is the global route: `station` (`"account"` or any relay name), `accountId` (empty = main), and for API the current `baseUrl` / `apiKey` (`activeUrlId` / `activeKeyId` record which pool entries they came from).
- Names are matched exactly first, then by unique partial match. Naming a key brings its paired URL (`keys[].urlId` or `urls[].keyId`), and the other way round.
- A lane stores a snapshot of its URL + key, so moving the global route does not drag it along. The CLI and `setRouteMode` write `lanes` for you.
- Keys are **never validated by prefix**. Anthropic Console keys start with `sk-ant-`, but third-party relays issue keys in their own formats (`fe…`, `cr_…`, bare hex, …). Any non-empty string is passed through as-is.
- `rates` is optional; see [Pricing](#pricing).
- Nested host apps may store the same object under `ccRelay` — load/save still work.
- A UTF-8 BOM in `config.json` is tolerated (Notepad and PowerShell's `Out-File -Encoding utf8` both write one). Any other parse error is reported on stderr rather than silently falling back to defaults.

Safe UI merge (do not wipe secrets when the form sends masks / empty disabled fields; masked `keys[].secret` and `accounts[].oauthToken` keep the stored value for the same id):

```js
import { mergeConfigPatch, saveConfig, loadConfig } from "claude-route-switch";
saveConfig(mergeConfigPatch(loadConfig(), formPatch));
```

`publicConfig()` / `claude-route list` give the same config with every secret masked.

### Wallet

Local ledger only (list prices × `priceMul`). Each API turn is booked in the total, under its lane (`byLane`) and under the key that paid (`byKey`): "how much did this conversation spend" and "how much did this key spend" are different questions.

```bash
claude-route topup 20
claude-route wallet
claude-route estimate --in 1000000 --out 0 --model claude-sonnet-4-5
```

### Pricing

Built-in prices are per model version, copied from the [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-18 (`PRICES_AS_OF`). For example Opus 4 / 4.1 are $15 / $75 per MTok, Opus 4.5 – 5 are $5 / $25, Opus 5.5 is $4 / $20. Prices go stale: check the page, or override in `rates`.

- 1-hour cache writes cost 2x input and 5-minute ones 1.25x. When `usage.cache_creation` splits the two, each part is priced on its own; otherwise all writes count as 5-minute.
- Cache reads are 0.1x input, except 0.05x on Opus 5.5 and Sonnet 5.5.
- Haiku 5.5 prompts over 100k tokens (input + cache reads + cache writes) pay the long-context price. That threshold is per request, so pass per-request usage if you need it exact.
- A bare `opus` / `sonnet` / `haiku` means the newest listed version. A Claude version the table does not know is priced as the newest of its family and flagged `assumed: true`.

Before 2026-10-18 this package priced every Opus at $15 / $75, which is three to four times too high for current models.

#### Non-Claude models

Anything that is not a Claude model falls back to the newest Opus rates. A relay running `gpt-4o-mini` would otherwise be billed dozens of times its real price, so the fallback is not silent: estimates carry `assumed: true`, and the wallet lists the offending models under `assumedModels` with a `warn`.

```bash
$ claude-route estimate --in 1000000 --out 1000000 --model gpt-4o-mini
{ "usd": 24, "tier": "opus-5.5", "assumed": true, "warn": "Unknown model ..." }
```

Fix it by declaring the real prices ($ / MTok) in `config.json`. Keys match by exact name first, then by longest substring, so one entry covers dated variants:

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

`cacheWrite` / `cacheWrite1h` / `cacheRead` are optional and default to `in × 1.25`, `in × 2` and `in × 0.1`. Third-party prices are deliberately **not** bundled: they change often and would rot in a release. The library only promises to be honest about what it does not know.

### Relays we have run

- **OpenRouter**, base URL `https://openrouter.ai/api`. 30 turns through Claude Code in 2026-08 and 2026-10, all on non-Claude models: 19 came back normally, 11 came back with zero tokens. One error we saw on an empty turn was `diagnostics.previous_message_id: must be the id from a prior /v1/messages response`; we did not check whether every empty turn was that. Price its models with `rates`.

## CLI

```
claude-route status [--lane L]
claude-route list
claude-route api [key] [url] [--lane L]
claude-route account [name] [--lane L]
claude-route default --lane L
claude-route set --url U --key K [--mul N] [--station custom]
claude-route topup <usd>
claude-route wallet [set <usd>|reset]
claude-route estimate --in N --out N [--model claude-sonnet-4-5]
claude-route apply
```

Env overrides:

- `CLAUDE_ROUTE_CONFIG` — config path  
- `CLAUDE_ROUTE_WALLET` — wallet path  

## Examples

- `examples/with-agent-sdk.mjs` — one turn on a lane through the Agent SDK: per-query env, usage from `rate_limit_event`, spend recorded  
- `examples/shell-wrapper.sh` — export one lane's env (`CLAUDE_ROUTE_LANE`, empty = global), then `exec` Claude Code. We checked the exported variables in Git Bash; we have not used it for long interactive sessions  

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
