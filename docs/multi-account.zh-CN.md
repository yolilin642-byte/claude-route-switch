# 一台电脑并排跑几个 Claude 订阅号＋API：钥匙、额度、换出口（Windows 实测笔记）

> **验证环境**：Windows 11，Claude Code 2.1.201 / 2.1.210（2026-09）、2.1.280（2026-10）。这里用到的好几个开关都没写进官方文档，版本一升就可能变，动手前先拿你自己的版本复测一遍。
> **我们是怎么跑的**：宿主是一个用 Node 写的 Agent SDK 程序，每次 `query()` 起一个 CLI 子进程。「换号接着聊」「好几个会话并发各走各的号」都是在这条路上测的。直接在终端里开交互式 CC（包括在 tmux 里开好几个），我们只用 `claude -p` 单发跑过几组，没长期这么用过。
> **标注**：【实测】是我们亲手跑过的；【推断】是读源码或别人的票得出来的，我们自己没跑；【未验证】就是还没验。
> 这篇是本仓库 [README](../README.md) 的续篇。README 管的是「订阅号 ↔ API」怎么切，这篇补上「好几个订阅号」那一块。这篇里的代码是独立的一小段，不依赖本仓库的包，复制就能用。

---

## 能做到什么，做不到什么

能做到：

- 每个会话、每次调用，自己挑走哪个订阅号，还是走 API。
- 换了出口，对话照样接着往下聊：会话记录、`CLAUDE.md`、设置只有一份，大家共用。【实测，Agent SDK 宿主，我们每天都这么用】
- 每个号的 5 小时额度和周额度都看得见，包括只有一年期钥匙的号。【实测，见第三步】

做不到：

- **换号以后，第一轮缓存会落空。**prompt 缓存是按账号算的，换号后第一轮要整段重写，按全价算一次（细节见 [RESEARCH.md](./RESEARCH.md)）。
- **不会自己无感切换。**什么时候换，要么你手动点，要么自己写规则（比如 5 小时用到 95% 就让路）。

## 原理就一句

CLI 挑凭证有固定的先后顺序；会话记录按 `cwd + session_id` 存在 `CLAUDE_CONFIG_DIR` 底下，记录里不写是谁付的钱。所以**只换凭证、不动 `CLAUDE_CONFIG_DIR`，同一段对话就能换个号接着说。**

官方文档给的凭证顺序（只摘跟这篇有关的几条，靠前的赢）：

1. `ANTHROPIC_AUTH_TOKEN`
2. `ANTHROPIC_API_KEY`
3. `apiKeyHelper`
4. `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 生成的那串）
5. 交互登录（`/login`）存下的凭证

---

## 第一步：每个号拿一把钥匙

钥匙有两种，一个号可以两种都有：

| | 一年期钥匙（setup-token） | 登录钥匙 |
|---|---|---|
| 怎么拿 | `claude setup-token`，在浏览器里点同意，终端会把钥匙打印出来 | 用 `/login` 登一次，存成 `.credentials.json` |
| 能用多久 | 一年 | **大约 29 天**，到期时间在登录那一刻就定死了，期间怎么刷新都不会往后延【实测】 |
| 权限 | 只有 `user:inference`：只能推理【实测：从 CLI 自己生成的授权链接里看到的】 | 推理以外还带 `user:profile` 等 |
| 能看额度吗 | **能**，从回话的回执里读（第三步） | 能，另外还能主动去问额度端点 |
| 怎么用 | 设环境变量 `CLAUDE_CODE_OAUTH_TOKEN` | 用 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 指到这个号自己的格子 |

**我们的建议：平时说话全走一年期钥匙。**登录钥匙一个月掉一次，拿它当主力，掉的那天这个号就哑了。登录钥匙只在两种情况下需要：号闲着时也想刷新额度条，或者想用那些要 `user:profile` 权限的接口。（这条建议是从下面几条实测推出来的，我们自己的宿主还没整个切过去。）

### 登录钥匙的到期时间写在文件里

`.credentials.json` 里的 `claudeAiOauth.refreshTokenExpiresAt` 是毫秒时间戳，读出来就知道哪天掉。【实测：主账号这个值连续两天没变过，中间刷新了很多次】官方的说法是：离到期还剩三天时，CLI 启动会提示 `Your login expires in 3 days · run /login to renew`。

### 每个号一个钥匙格：`CLAUDE_SECURESTORAGE_CONFIG_DIR`（可选）

想让好几个号**各自留着登录钥匙**、又不想拆开会话记录，就用这个变量。它只管凭证文件放在哪，跟 `CLAUDE_CONFIG_DIR` 没关系。

- **Windows 上它管用。**有第三方工具的注释说它只给 macOS 钥匙串用，这句是错的。CLI 本体里，明文凭证的路径也是拿它拼出来的。【实测，两组对照：格子里放好钥匙，额度读得到；格子是空的，就当成没登录，**也不会回头去找默认那份**】
- 它的值会被逐字拿去算哈希：`~` 不会展开，路径也不会规范化。值是空字符串时会把默认凭证库钉住，光删掉这个变量不行。（来自 [#79223](https://github.com/anthropics/claude-code/issues/79223)）
- **最危险的一条**：如果当前环境里继承了别的号的格子路径，这时跑 `/login`，会**悄悄把那个号的钥匙盖掉**（#79223）。所以给默认账号拼环境变量时，要**显式删掉**这个变量。
- 往格子里登一个号：开一个干净的终端，只设这一个变量，运行 `claude`，敲 `/login`。【推断：读源码加上那张票得出来的，我们自己是手写 OAuth 登进去的，没走过这条路】
- 两扇窗同时用同一个格子时，CLI 可能各自去刷新同一把钥匙，然后撞车。claude-swap 为这个专门写了锁。【未验证：我们还没撞上过】

---

## 第二步：每次调用前拼一份 env

```js
const STRIP = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
               "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"];

/**
 * 给一次 query 拼 env。choice：
 *   { kind: "login" }                 走本机默认登录
 *   { kind: "token", token }          某个订阅号的一年期钥匙
 *   { kind: "api", baseUrl, apiKey }  API 或中转
 */
export function egressEnv(choice, base = process.env) {
  const env = { ...base };
  for (const k of STRIP) delete env[k];   // 上一轮留下的一律清掉，尤其是钥匙格那个开关
  // CLAUDE_CONFIG_DIR 不碰：会话记录、CLAUDE.md、设置都在它底下，动了就分家
  if (choice.kind === "token") env.CLAUDE_CODE_OAUTH_TOKEN = choice.token;
  if (choice.kind === "api") {
    env.ANTHROPIC_BASE_URL = choice.baseUrl;
    env.ANTHROPIC_API_KEY = choice.apiKey;
  }
  return env;
}
```

在 Agent SDK 里，`options.env` 是每次 `query()` 各带一份的。同一个进程里好几个会话并发，各走各的出口，互相不会盖掉。**别去改全局的 `process.env`**，那是整个进程共用的一份。

```js
for await (const m of query({ prompt, options: { env: egressEnv(choice), resume: sessionId } })) {
  if (m.type === "rate_limit_event") saveUsage(choice, m.rate_limit_info);
  // ...
}
```

同一个 `sessionId`，这一轮走 A 号，下一轮走 B 号，再下一轮走 API，都能接着聊。【实测，Agent SDK】

不写代码、直接开 CC 的话，PowerShell 里这样写：

```powershell
# 用 B 号的一年期钥匙开一个 CC，接着之前的对话
Remove-Item Env:ANTHROPIC_AUTH_TOKEN, Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_BASE_URL, Env:CLAUDE_SECURESTORAGE_CONFIG_DIR -ErrorAction SilentlyContinue
$env:CLAUDE_CODE_OAUTH_TOKEN = "<B 号的 setup-token>"
claude --resume
```

【推断】上面清变量、塞钥匙那几行，我们拿 `claude -p` 单发跑过（第三步那几组就是这么测的）。可是拿它开交互式 CC、用 `--resume` 接上别的号聊过的对话，我们没试过；tmux 里同时开好几个、各塞各的号，也没试过。按机制应该跟 SDK 是同一回事（会话记录里不记是谁付的钱），但我们没跑过，你用之前先试一轮。

---

## 第三步：看额度

### 从回执里读（一年期钥匙也有）

每次回话，服务器都会在响应头里附上这个号的用量（`anthropic-ratelimit-unified-*`）。CLI 会把它转成一条 `rate_limit_event`：

```powershell
claude -p "在吗" --output-format stream-json --verbose | Select-String rate_limit_event
```

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792174800,
 "rateLimitType":"five_hour","unifiedWindows":{
   "five_hour":{"utilization":0.17,"resetsAt":1792174800},
   "seven_day":{"utilization":0.17,"resetsAt":1792688400}}}}
```

`utilization` 取值 0 到 1，`resetsAt` 是秒级时间戳。

- 【实测】只用一年期钥匙（登录钥匙全部隔开），撞墙状态下：`five_hour 1 / seven_day 0.76`，还带着重置时间。
- 【实测】用登录钥匙，没撞墙：`0.17 / 0.17`。
- 【实测，2026-10-18，CLI 2.1.280】只用一年期钥匙，没撞墙：`status: allowed_warning`（回执里写着 `surpassedThreshold: 0.75`，是周额度过线了；上面那组没过线的是 `allowed`），`five_hour 0.57 / seven_day 0.95`。[clauth #110](https://github.com/uwuclxdy/clauth/issues/110) 在 HTTP 层也测过，正常 200 响应里就带着。
- Agent SDK 宿主那边也能收到同样类型的消息：CLI 本体里的 schema 写的是 "Rate limit event emitted when rate limit info changes"。【推断，我们的 bot 还没接】

两点要注意：

- **只有真发了请求才会更新。**号闲着，数字就停在最后一次。不过闲着时用量不会涨，只会到点清零，用 `resetsAt` 就能自己算出来。
- **别拿一句话去戳它刷新。**5 小时窗口是从第一句话开始计时的，号闲着的时候发一句探针，等于替它新开了一个窗口（clauth #110 实测过）。探针也不便宜：一句 `hi` 照样带上整份系统提示和 `CLAUDE.md`，我们测的那一次光缓存写入就六万多 token。【实测】

### 主动去问（只有登录钥匙能问）

`GET https://api.anthropic.com/api/oauth/usage` 这个接口要 `user:profile` 权限。

- 拿一年期钥匙去问会被拒：问 `/api/oauth/profile` 回 `403`，带 `x-should-retry: false`【实测】；问 usage 回 `403 ... does not meet scope requirement user:profile`（clauth #110）。
- 请求头要带 `anthropic-beta: oauth-2025-04-20` 和一个 CLI 样式的 `User-Agent`，不带会被拒。【实测】
- 配额非常小：我们连问几次就吃到 `429`，`Retry-After` 将近一小时。也有人报过这个接口一直回 429 的 bug（[#31021](https://github.com/anthropics/claude-code/issues/31021)），这两种情况我们分不出来。宿主一定要做缓存，别每轮都去问。
- **用环境变量塞钥匙时，CLI 不会自己去问这个接口。**哪怕塞的是一把完好的登录钥匙也一样。【实测，三组对照】

---

## 坑（按我们踩的顺序）

1. 只盯着「问额度被 403」，以为一年期钥匙看不见额度，结果方向错了一个月。它只是不能**主动问**，回执里一直都有。
2. 拿环境变量塞登录钥匙去对照，以为能排除变量，其实环境变量这条路本身就不去拉额度。
3. 手写 OAuth 时，`state` 短了只会回一句 `Invalid request format`（官方生成的是 43 个字符）。**能用官方 `/login` 就别手写。**
4. **登录钥匙过期时，CLI 会把钥匙清成空字符串，文件本身还在。**如果宿主只看文件在不在、有多大，就会继续往空钥匙上送请求。要读 `accessToken` 判断它是不是空的。【实测，跟 [#91571](https://github.com/anthropics/claude-code/issues/91571) 描述的一致】
5. 已知还会在到期**之前**就被清空（[#83464](https://github.com/anthropics/claude-code/issues/83464)、#91571）。所以文件里写的到期日不算保票。

---

## 合规，先读原文

官方[合规页](https://code.claude.com/docs/en/legal-and-compliance)的原话：OAuth 是给订阅用户「ordinary use of Claude Code and other native Anthropic applications」用的；做产品的开发者应该用 API key；开发者「may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow」。

我们的用法是：自己的号、自己用、没改过的 CLI、登录走官方页面。一个人用好几个订阅号合不合你那份条款，请自己读原文判断。**钥匙别给别人，也别拿去替别人跑。**用脚本绕过人机验证去自动登录，我们不做，也不推荐。

---

## 参考

- 官方：[Authentication](https://code.claude.com/docs/en/authentication)（凭证顺序、到期提示、setup-token）
- [claude-code #79223](https://github.com/anthropics/claude-code/issues/79223) · `CLAUDE_SECURESTORAGE_CONFIG_DIR` 的行为，以及 `/login` 会覆盖钥匙的警告
- [claude-code #83464](https://github.com/anthropics/claude-code/issues/83464)、[#91571](https://github.com/anthropics/claude-code/issues/91571) · 钥匙被提前清空
- [claude-code #31021](https://github.com/anthropics/claude-code/issues/31021) · usage 接口一直回 429
- [clauth #110](https://github.com/uwuclxdy/clauth/issues/110)、[CodexBar #1894](https://github.com/steipete/CodexBar/issues/1894) · 从回执里读一年期钥匙的额度
- [realiti4/claude-swap](https://github.com/realiti4/claude-swap) · 多号切换和刷新锁（它那句「仅限 macOS」是错的）
- 本仓库 [RESEARCH.md](./RESEARCH.md) · 订阅号 ↔ API 混用时会话记录和缓存怎么走
