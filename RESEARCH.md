# Research: Mixing Claude subscription (OAuth) and API key in one conversation context

**Scope:** Same *logical* chat / agent session, two *billing egresses*:

1. **Subscription channel** — Claude Code / Agent SDK via OAuth (`sk-ant-oat01-…` / Claude Code login), billed against Pro/Max (etc.) quotas  
2. **API channel** — Console API key (`sk-ant-api03-…`) or Anthropic-compatible `ANTHROPIC_BASE_URL` + key, billed per token  

**Goal when subscription hits a limit:** continue without “who are you?” amnesia.

**Method:** Official Claude Code / Agent SDK docs, Anthropic legal pages, public reverse-engineering of JSONL transcripts, and representative open-source proxies. Conclusions below are tagged with **verifiable sources**. Community blogs are marked as secondary.

**Date of survey:** 2026-08-02.

---

## Executive answer

| Question | Short answer |
|----------|----------------|
| Same session file for both auths? | **Yes for local Agent SDK / Claude Code.** Transcripts are disk JSONL keyed by `cwd` + `session_id`, not by credential type. |
| Official “convert OAuth transcript → API transcript”? | **No separate format.** Resume is `options.resume = sessionId` after you change env auth. |
| Seamless *model-side* cache across accounts? | **No.** Prompt cache is account/org-scoped; first turn after switch is usually a cache miss. |
| Seamless *conversation* continuity? | **Yes if you resume the same `session_id` with the same `cwd` and aligned tools/system options.** |
| Productizing “use Max OAuth inside a third-party app for other users”? | **Against Anthropic’s stated policy.** Personal dual-route on *your own* machine is a different risk profile. |

---

## ① Transcript / session file format — compatibility & conversion

### Where files live

Agent SDK and Claude Code both persist sessions as **append-only JSONL**:

```text
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

- `<encoded-cwd>`: absolute working directory with non-alphanumeric chars replaced by `-`  
- Optional override: `$CLAUDE_CONFIG_DIR/projects/...`

**Sources:**

- [Work with sessions (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/sessions) — storage path tip; resume / continue / fork  
- [Building a session browser (Cookbook)](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) — same path; `list_sessions` / `get_session_messages` / `fork_session`  
- [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting) — subprocess owns JSONL on local disk  
- Secondary field notes: [Claude Code JSONL format](https://claude-dev.tools/docs/jsonl-format), [adityabawankule.io writeup](https://www.adityabawankule.io/blog/claude-code-session-jsonl-format), Simon Willison [2025-10-22](https://simonwillison.net/2025/Oct/22/claude-code-logs/)

### Record shape (conversation, not credentials)

Each line is a JSON object with a shared envelope, approximately:

| Field | Role |
|-------|------|
| `type` | `user` / `assistant` / system-ish events |
| `uuid` / `parentUuid` | message DAG (not only a flat list) |
| `timestamp` | ISO time |
| `sessionId` / `cwd` | session binding (when present) |
| `message` | Anthropic-like `{ role, content: blocks[] }` |

**Verified on a live local file** (format only; no private text reproduced here):  
`%USERPROFILE%\.claude\projects\D--claudecode-*\*.jsonl` contains `type:user|assistant`, `parentUuid`, `message.role`, `message.content[]` with `type:text` — matching public descriptions.

**Implication:** The file stores **dialogue + tool traffic**, not “this was OAuth.” Auth is applied at **request time** by the CLI/SDK subprocess when it calls the model endpoint.

### Compatibility matrix

| Pair | Compatible? | How |
|------|-------------|-----|
| Claude Code CLI ↔ Agent SDK (same machine, same `cwd`) | **Yes** | Shared `~/.claude/projects` layout; SDK docs treat CLI transcripts as the same store ([session browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser)) |
| Resume after switching `ANTHROPIC_API_KEY` / clearing it for OAuth | **Intended path** | Keep `resume=sessionId` + same `cwd`; change env only ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [hosting auth](https://code.claude.com/docs/en/agent-sdk/hosting)) |
| OAuth Max account A → OAuth Max account B (different org) | **Transcript can resume; cache cannot** | Community multi-account proxies re-send full history; cache miss on first turn ([teamclaude README](https://github.com/KarpelesLab/teamclaude)) |
| Raw Messages API (`/v1/messages` only, no Agent SDK) | **Not the same file** | You must either (a) drive Agent SDK, or (b) rehydrate messages yourself from JSONL / your app DB |

### “Conversion” tools (view / export, not auth adapters)

| Repo | Link | Role |
|------|------|------|
| simonw/claude-code-transcripts | https://github.com/simonw/claude-code-transcripts | JSON/JSONL → HTML |
| simonw tools `claude_to_markdown.py` | https://github.com/simonw/tools/blob/main/python/claude_to_markdown.py | JSONL → Markdown |
| anthropics SDK session APIs | https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages | Read messages without re-running agent |
| `fork_session` | Cookbook above | Branch history to a new `session_id` |

There is **no official converter** titled “subscription session → API session” because **the wire format is already shared**. Conversion is only needed if you leave the Agent SDK and rebuild prompts for bare `/v1/messages`.

### Official resume APIs (not file munging)

From [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions):

- Capture `session_id` from `ResultMessage` / init `SystemMessage`  
- Next call: `options.resume = session_id`  
- `continue: true` (TS) / `continue_conversation` (Py): most recent session in directory  
- `fork_session: true`: copy history → new id  
- Cross-host: copy JSONL to same path **or** use `SessionStore` ([hosting](https://code.claude.com/docs/en/agent-sdk/hosting), session-storage docs)

---

## ② System prompt & tool definitions — alignment

### What the session file does **not** freeze for you

JSONL stores **what happened** (user text, assistant text, tool_use / tool_result).  
Each new `query()` still passes **options** that define the agent loop:

- system / persona (`systemPrompt` or Claude Code settings / `CLAUDE.md` via `settingSources`)  
- tools / MCP servers  
- model, permission mode, `cwd`, etc.

**Sources:** [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Hosting multi-tenant isolation](https://code.claude.com/docs/en/agent-sdk/hosting) (`settingSources: []`, `CLAUDE_CONFIG_DIR`, per-tenant `cwd`).

### Alignment rules for dual-channel

| Risk | Mitigation |
|------|------------|
| API turn loads different `CLAUDE.md` / MCP than OAuth turn | Pin the same `cwd`, `settingSources`, MCP map, and system string on **both** routes |
| Tool list shrinks on API (cost / safety) | Model may re-call missing tools or invent args; keep tool schemas identical for “seamless” feel |
| Host injects a different system preamble only on failover | Treat failover as a **branch** (fork) or inject an explicit handoff user message |
| Subprocess env differs only by auth | Correct pattern: same options object, only `ANTHROPIC_*` env changes ([hosting – Auth](https://code.claude.com/docs/en/agent-sdk/hosting)) |

### Env vars that choose the channel (not the transcript)

Documented / widely observed (CLI gist + official hosting):

| Variable | Role |
|----------|------|
| `ANTHROPIC_API_KEY` | Console / API key path |
| `ANTHROPIC_AUTH_TOKEN` | Bearer; can **override** key when set |
| `ANTHROPIC_BASE_URL` | Custom gateway / relay / proxy |
| Claude Code OAuth login | Default when API key env cleared |

**Sources:**

- [Hosting – Auth and secrets](https://code.claude.com/docs/en/agent-sdk/hosting) — subprocess reads `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` for proxy injection  
- Env catalog (community reverse-engineer): https://gist.github.com/unkn0wncode/f87295d055dd0f0e8082358a0b5cc467  
- Auth comparison (secondary): [LinkedIn: API key vs Claude Code OAuth](https://www.linkedin.com/pulse/claude-agent-sdk-authentication-api-key-vs-code-oauth-pachauri-64ibc)

**Practical rule used by this package:** for API mode set `BASE_URL` + `API_KEY` and **delete** `ANTHROPIC_AUTH_TOKEN` so OAuth cannot win; for account mode delete relay env so default login returns.

---

## ③ Switching without amnesia — context transfer strategies

Ranked by fidelity to “same brain, new wallet”:

### Strategy A — Resume same `session_id` (best when still on Agent SDK)

```text
[OAuth] query(..., resume=sid)  →  429 / rate limit
        apply API env
[API]   query(..., resume=sid, same cwd + tools + system)
```

- Disk transcript already has full tool history  
- Official recovery language even covers “recover from a limit” then resume with higher limits ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions) — “Recover from a limit”)  
- **Must** drop warm/long-lived subprocesses that were started under the old credentials (host concern)

**Verified constraints:**

- Wrong `cwd` → SDK looks in the wrong folder → **looks like a new chat** ([sessions tip](https://code.claude.com/docs/en/agent-sdk/sessions))  
- Prompt cache does not cross accounts/orgs — first post-switch turn often full-price ([teamclaude – Prompt caching across rotation](https://github.com/KarpelesLab/teamclaude))

### Strategy B — Application-owned history (always works, more lossy)

Host keeps its own message log (chat DB). On switch:

1. Stop using channel A  
2. Build a **handoff block** (last N turns, open tools, “you already did X”)  
3. New `query()` without resume, or new session with handoff as first user message  

Used when: leaving Agent SDK, switching to bare HTTP, or channels that **cannot** read `~/.claude/projects`.

### Strategy C — Multi-account proxy in front of Claude Code (subscription↔subscription or +API)

Proxy terminates TLS or sits on `ANTHROPIC_BASE_URL`, injects the next account’s token, **rewrites `account_uuid` in metadata**, retries 429. Client keeps one session id; upstream account changes.

**Example:** [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude) documents that the client resends full transcript each turn and that cache is **not** shared across orgs.

### Strategy D — Fork then continue on the new channel

`fork_session` / `forkSession: true` → new id with copied history → resume fork under API env. Original subscription thread remains intact for later.

**Source:** [sessions – Fork](https://code.claude.com/docs/en/agent-sdk/sessions), [session browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser).

### What “seamless” is *not*

| Expectation | Reality |
|-------------|---------|
| Zero extra latency on switch | Cache miss + possible reconnect |
| Same dollar cost as continuous OAuth | API path is pay-per-token ([hosting cost note](https://code.claude.com/docs/en/agent-sdk/hosting)) |
| Thinking blocks / cache always identical after resume | Known resume/thinking wedge cases; proxies exist specifically to heal history ([claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix)) |
| Custom `ANTHROPIC_BASE_URL` keeps all Claude.ai features | Non-first-party base URL can disable Remote Control / some connectors (documented in cache-fix README and CLI behavior notes) |

---

## ④ Open-source implementations (repos + links)

### Official / first-party

| Name | Link | Relevance |
|------|------|-----------|
| Claude Agent SDK (TS) | https://github.com/anthropics/claude-agent-sdk-typescript | `query`, resume, session file APIs |
| Claude Agent SDK (Python) | https://github.com/anthropics/claude-agent-sdk-python | Same |
| Claude cookbooks – session browser | https://github.com/anthropics/claude-cookbooks/blob/main/claude_agent_sdk/05_Building_a_session_browser.ipynb | JSONL list/read/fork |
| Claude cookbooks – hosting | https://github.com/anthropics/claude-cookbooks/tree/main/claude_agent_sdk/hosting | Deploy + `ANTHROPIC_BASE_URL` |
| Sessions docs | https://code.claude.com/docs/en/agent-sdk/sessions | Resume / continue / fork |
| Hosting docs | https://code.claude.com/docs/en/agent-sdk/hosting | Subprocess + auth env |
| Legal & compliance (auth rules) | https://code.claude.com/docs/en/legal-and-compliance | OAuth vs API for products |

### Multi-account / quota rotation / dual egress

| Name | Link | Notes |
|------|------|-------|
| **teamclaude** | https://github.com/KarpelesLab/teamclaude | Multi Max/API accounts; 5h/weekly rotation; MITM or `ANTHROPIC_BASE_URL`; documents cache miss on rotate |
| **claude-code-cache-fix** | https://github.com/cnighswonger/claude-code-cache-fix | Fixes resume/cache/thinking 400s; reverse-proxy or MITM |
| **claude-code-proxy** (raine) | https://github.com/raine/claude-code-proxy | Point Claude Code at non-Anthropic backends via base URL pattern |
| **claude-code-go** | https://github.com/tunsuy/claude-code-go | Reimplementation; OAuth + API key |
| Env var reference gist | https://gist.github.com/unkn0wncode/f87295d055dd0f0e8082358a0b5cc467 | `ANTHROPIC_*` catalog |

### Transcript tooling

| Name | Link |
|------|------|
| claude-code-transcripts | https://github.com/simonw/claude-code-transcripts |
| Example JSONL in the wild | https://github.com/simonw/research/blob/main/deepseek-ocr-nvidia-spark/claude-log.jsonl |

### This extract

| Name | Path / role |
|------|-------------|
| **claude-route-switch** | This package — env apply + config + local USD wallet; **not** a multi-account MITM proxy |

**Gap:** No widely known MIT-licensed project is both (a) official and (b) “subscription OAuth + Console API seamless product for third-party SaaS.” Open proxies that rotate **Max OAuth for arbitrary clients** sit in a **ToS hazard zone** (next section).

---

## ⑤ Known pitfalls & ToS boundary

### Technical pitfalls

1. **Auth priority** — Leaving `ANTHROPIC_AUTH_TOKEN` set while trying to use a relay key → OAuth wins. Clear it for API mode.  
2. **Warm process** — Long-lived CLI subprocess started under OAuth keeps old identity until killed/recreated.  
3. **cwd mismatch** — Resume fails silently into “empty” history.  
4. **Prompt cache** — Cross-account = miss; budget spike on first failover turn.  
5. **Custom BASE_URL** — May mark client non-first-party; Remote Control / some MCP features break.  
6. **Thinking / resume 400** — Malformed or stripped thinking blocks can wedge resume ([claude-code issues / cache-fix docs](https://github.com/cnighswonger/claude-code-cache-fix)).  
7. **Session cleanup** — Default cleanup period can delete old JSONL ([issue #4172 discussion via Willison](https://simonwillison.net/2025/Oct/22/claude-code-logs/)); `cleanupPeriodDays` in settings.  
8. **Third-party “compatible” relays** — Tool schemas / streaming / cache headers often incomplete; not the same as Console API.  
9. **Concurrent dual env in one process** — One `process.env` → serialize turns or isolate processes.  
10. **Billing surprise** — Subscription 5h limit vs API pay-as-you-go are different meters; local “wallet” is estimate only.

### ToS / policy boundary (read primary sources)

Anthropic’s **Claude Code Legal and compliance** page states (paraphrase with obligation to re-read live text):

- **OAuth** is for purchasers of Free/Pro/Max/Team/Enterprise and for **ordinary use of Claude Code and other native Anthropic applications**.  
- Developers building **products or services** that interact with Claude should use **API keys** (Console or Bedrock/Vertex).  
- Anthropic **does not permit** third-party developers to offer Claude.ai login or to **route requests through Free/Pro/Max credentials on behalf of their users**.

**Primary source:**  
https://code.claude.com/docs/en/legal-and-compliance  

**Secondary reporting** on enforcement / Agent SDK wording:  
https://thenewstack.io/anthropic-agent-sdk-confusion/  
https://news.ycombinator.com/item?id=46549823  

| Pattern | Risk sketch (not legal advice) |
|---------|--------------------------------|
| You on your machine: Agent SDK + your Max OAuth + failover to **your** Console API key | Common personal setup; still subject to Consumer/Commercial terms for each product |
| Open-source library that only toggles env + resumes session | Generally describing supported mechanisms; do not instruct ToS evasion |
| SaaS that logs users into **their** Max and serves many tenants | **Explicitly disallowed** by legal page above |
| Proxy that pools many Max accounts for one workload | ToS / AUP risk; some projects exist in the wild anyway |
| Shipping other users’ traffic on your Max OAuth | Against “on behalf of their users” language |

**For open-source README:** recommend Console API for any multi-user product; document dual-route as **personal / self-host egress switch**; link Anthropic legal page; no claim of Anthropic endorsement.

---

## Recommended architecture (evidence-based)

```text
                    ┌─────────────────────────────┐
                    │  Host app (your process)     │
                    │  - owns chat UX / message DB │
                    │  - same tools + system always│
                    │  - serializes turns          │
                    └─────────────┬───────────────┘
                                  │ query({ resume, cwd, tools, system })
                                  ▼
                    ┌─────────────────────────────┐
                    │  Agent SDK → claude CLI      │
                    │  JSONL: ~/.claude/projects…  │
                    └─────────────┬───────────────┘
                                  │ HTTPS
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
     OAuth / subscription                      API key or BASE_URL
     (default login)                           (Console or relay)
              │                                       │
              └──────── on limit: swap env, ──────────┘
                        same resume + cwd
                        (expect cache miss)
```

Optional: put **teamclaude**-class proxy only if you accept multi-account ToS risk and need automatic rotation without host changes.

---

## Mapping to this package (`claude-route-switch`)

| Concern | Package provides | Package does **not** provide |
|---------|------------------|------------------------------|
| Env switch account ↔ API | `applyRouteEnv` / CLI | MITM multi-account |
| Persist URL/key without wipe | `setRouteMode`, `mergeConfigPatch` | Official Anthropic login UI |
| Local $ estimate | `estimateUsd` / wallet | Real Console billing |
| Session resume | Documented only | Calling Agent SDK for you |
| ToS | RESEARCH + README warnings | Legal clearance |

---

## Verification checklist (reproduce yourself)

1. Create a session with Agent SDK under OAuth (no `ANTHROPIC_API_KEY`). Note `session_id` and `cwd`.  
2. Confirm file: `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` grows.  
3. Set Console `ANTHROPIC_API_KEY`, clear `ANTHROPIC_AUTH_TOKEN`, `query({ resume: session_id })` with same `cwd`.  
4. Confirm next assistant turn references prior tool/file context.  
5. Compare usage: subscription quota UI vs Console cost.  
6. Re-read https://code.claude.com/docs/en/legal-and-compliance before shipping any multi-user product.

---

## Changelog

| Date | Note |
|------|------|
| 2026-08-02 | Initial survey for open-source extract |
