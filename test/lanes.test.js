import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  envFor,
  keyDirUsable,
  loadConfig,
  mergeConfigPatch,
  pickFromPool,
  publicConfig,
  recordSpend,
  resolveRoute,
  routeEnv,
  saveConfig,
  setRouteMode,
  walletSummary,
} from "../src/index.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crs-lanes-"));
}

/** A key folder like the one /login writes. `token: ""` is what an expired login leaves. */
function keyFolder(token) {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "r", expiresAt: 1 } }),
  );
  return dir;
}

function pool(extra = {}) {
  return {
    station: "account",
    urls: [
      { id: "u1", name: "relay-a", baseUrl: "https://a.example/", keyId: "" },
      { id: "u2", name: "openrouter", baseUrl: "https://openrouter.ai/api", keyId: "k3" },
    ],
    keys: [
      { id: "k1", name: "work", secret: "fe-work-1111", urlId: "u1" },
      { id: "k2", name: "spare", secret: "cr_spare_2222" },
      { id: "k3", name: "or-key", secret: "sk-or-3333" },
    ],
    accounts: [{ id: "b", name: "Account B", oauthToken: "setup-token-b" }],
    ...extra,
  };
}

const BASE = Object.freeze({
  PATH: "/bin",
  ANTHROPIC_AUTH_TOKEN: "inherited-auth",
  CLAUDE_CODE_OAUTH_TOKEN: "process-level-token",
  CLAUDE_SECURESTORAGE_CONFIG_DIR: "/somebody/elses/keys",
});

describe("routeEnv: one fresh env per query", () => {
  it("api route sets URL + key, drops ANTHROPIC_AUTH_TOKEN, leaves base untouched", () => {
    const cfg = pool({ lanes: { chat: { station: "custom", baseUrl: "https://a.example", apiKey: "fe-work-1111", keyId: "k1" } } });
    const base = { ...BASE };
    const { env, route } = routeEnv(resolveRoute(cfg, "chat"), base);
    assert.equal(env.ANTHROPIC_BASE_URL, "https://a.example");
    assert.equal(env.ANTHROPIC_API_KEY, "fe-work-1111");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(env.PATH, "/bin");
    assert.deepEqual(base, BASE);
    assert.equal(route.mode, "api");
    assert.equal(route.lane, "chat");
    assert.equal(route.keyId, "k1");
    assert.equal(JSON.stringify(route).includes("fe-work"), false);
  });

  it("two lanes on different routes do not see each other", () => {
    const cfg = pool({
      lanes: {
        one: { station: "custom", baseUrl: "https://a.example", apiKey: "fe-work-1111" },
        two: { station: "account", accountId: "b" },
      },
    });
    const a = routeEnv(resolveRoute(cfg, "one"), BASE).env;
    const b = routeEnv(resolveRoute(cfg, "two"), BASE).env;
    const c = routeEnv(resolveRoute(cfg, "three"), BASE).env; // no entry → global (main)
    assert.equal(a.ANTHROPIC_API_KEY, "fe-work-1111");
    assert.equal(b.ANTHROPIC_API_KEY, undefined);
    assert.equal(b.CLAUDE_CODE_OAUTH_TOKEN, "setup-token-b");
    assert.equal(c.ANTHROPIC_API_KEY, undefined);
    assert.equal(c.CLAUDE_CODE_OAUTH_TOKEN, "process-level-token");
  });

  it("main account drops an inherited key folder but keeps the process's own OAuth setup", () => {
    const { env, route } = routeEnv(resolveRoute(pool()), BASE);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "process-level-token");
    assert.equal(route.credential, "login");
    assert.equal(route.accountId, "main");
  });

  it("named account with a live key folder uses the folder and clears tokens", () => {
    const dir = keyFolder("live-access-token");
    const cfg = pool({ accounts: [{ id: "b", oauthToken: "setup-token-b", keyDir: dir }], accountId: "b" });
    const { env, route } = routeEnv(resolveRoute(cfg), BASE);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, dir);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(route.credential, "keyDir");
  });

  it("an expired login (file still there, accessToken blank) falls back to the setup-token", () => {
    const dir = keyFolder("");
    assert.ok(fs.statSync(path.join(dir, ".credentials.json")).size > 0); // size alone would lie
    assert.equal(keyDirUsable(dir), false);
    const cfg = pool({ accounts: [{ id: "b", oauthToken: "setup-token-b", keyDir: dir }], accountId: "b" });
    const { env, route } = routeEnv(resolveRoute(cfg), BASE);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "setup-token-b");
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(route.credential, "token");
  });

  it("prefer: token picks the setup-token even when the folder is live", () => {
    const dir = keyFolder("live-access-token");
    const cfg = pool({ accounts: [{ id: "b", oauthToken: "setup-token-b", keyDir: dir, prefer: "token" }], accountId: "b" });
    assert.equal(routeEnv(resolveRoute(cfg), BASE).route.credential, "token");
  });

  it("an account with nothing usable throws instead of sending an empty token", () => {
    const cfg = pool({ accounts: [{ id: "c", keyDir: keyFolder("") }], accountId: "c" });
    assert.throws(() => routeEnv(resolveRoute(cfg), BASE), /no usable credential/);
  });

  it("a lane pointing at a deleted account throws", () => {
    const cfg = pool({ lanes: { x: { station: "account", accountId: "gone" } } });
    assert.throws(() => resolveRoute(cfg, "x"), /no account "gone"/);
  });
});

describe("pool", () => {
  it("a key name brings its paired URL, a URL name brings its paired key", () => {
    const byKey = pickFromPool(pool(), ["work"]);
    assert.equal(byKey.baseUrl, "https://a.example");
    assert.equal(byKey.apiKey, "fe-work-1111");
    const byUrl = pickFromPool(pool(), ["openrouter"]);
    assert.equal(byUrl.apiKey, "sk-or-3333");
    assert.equal(byUrl.keyId, "k3");
  });

  it("key and URL can be named together, partial names work, unknown names are reported", () => {
    const both = pickFromPool(pool(), ["spa", "relay-a"]);
    assert.equal(both.apiKey, "cr_spare_2222");
    assert.equal(both.baseUrl, "https://a.example");
    assert.match(pickFromPool(pool(), ["nope"]).error, /not in the pool: nope/);
  });
});

describe("setRouteMode with lanes", () => {
  function setup() {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    saveConfig(pool(), cfg);
    process.env.CLAUDE_ROUTE_WALLET = path.join(dir, "wallet.json");
    return cfg;
  }

  it("a lane switch writes only that lane and never touches process.env", () => {
    const cfg = setup();
    const before = process.env.ANTHROPIC_API_KEY;
    const r = setRouteMode("api work", { configPath: cfg, lane: "chat" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.route.mode, "api");
    assert.equal(process.env.ANTHROPIC_API_KEY, before);
    const disk = loadConfig(cfg);
    assert.equal(disk.station, "account"); // global untouched
    assert.equal(disk.lanes.chat.keyId, "k1");
    assert.equal(envFor("chat", { configPath: cfg, base: {} }).env.ANTHROPIC_API_KEY, "fe-work-1111");
    assert.equal(envFor("other", { configPath: cfg, base: {} }).env.ANTHROPIC_API_KEY, undefined);
  });

  it("a lane keeps its snapshot when the global choice moves; default drops it", () => {
    const cfg = setup();
    setRouteMode("api work", { configPath: cfg, lane: "chat" });
    setRouteMode("api spare relay-a", { configPath: cfg });
    assert.equal(envFor("chat", { configPath: cfg, base: {} }).env.ANTHROPIC_API_KEY, "fe-work-1111");
    assert.equal(envFor(undefined, { configPath: cfg, base: {} }).env.ANTHROPIC_API_KEY, "cr_spare_2222");
    assert.equal(loadConfig(cfg).activeKeyId, "k2");
    const r = setRouteMode("default", { configPath: cfg, lane: "chat" });
    assert.equal(r.ok, true);
    assert.equal(envFor("chat", { configPath: cfg, base: {} }).env.ANTHROPIC_API_KEY, "cr_spare_2222");
  });

  it("account by name on a lane; default without a lane is refused", () => {
    const cfg = setup();
    const r = setRouteMode("account account b", { configPath: cfg, lane: "night" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.route.accountId, "b");
    assert.equal(envFor("night", { configPath: cfg, base: {} }).env.CLAUDE_CODE_OAUTH_TOKEN, "setup-token-b");
    assert.equal(setRouteMode("default", { configPath: cfg }).ok, false);
    assert.equal(setRouteMode("account nobody", { configPath: cfg, lane: "x" }).ok, false);
  });
});

describe("config + public + wallet with pools", () => {
  it("save/load keeps pools and lanes", () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    saveConfig(pool({ lanes: { chat: { station: "account", accountId: "b" } } }), cfg);
    const raw = JSON.parse(fs.readFileSync(cfg, "utf8"));
    assert.equal(raw.ccRelay, undefined); // still flat
    const c = loadConfig(cfg);
    assert.equal(c.keys.length, 3);
    assert.equal(c.accounts[0].id, "b");
    assert.equal(c.lanes.chat.accountId, "b");
  });

  it("mergeConfigPatch keeps masked pool secrets and untouched lanes", () => {
    const prev = pool({ lanes: { chat: { station: "account", accountId: "b" } } });
    const next = mergeConfigPatch(prev, {
      keys: [{ id: "k1", name: "work-renamed", secret: "••••1111" }, { id: "k9", name: "new", secret: "fresh" }],
      accounts: [{ id: "b", name: "B", oauthToken: "" }],
    });
    assert.equal(next.keys[0].secret, "fe-work-1111");
    assert.equal(next.keys[0].name, "work-renamed");
    assert.equal(next.keys[1].secret, "fresh");
    assert.equal(next.accounts[0].oauthToken, "setup-token-b");
    assert.equal(next.lanes.chat.accountId, "b");
  });

  it("publicConfig never carries a secret", () => {
    const cfg = pool({
      apiKey: "global-secret-9999",
      lanes: { chat: { station: "custom", baseUrl: "https://a.example", apiKey: "lane-secret-8888" } },
    });
    const out = JSON.stringify(publicConfig(cfg));
    for (const s of ["global-secret", "lane-secret", "fe-work", "cr_spare", "sk-or", "setup-token-b"]) {
      assert.equal(out.includes(s), false, s);
    }
  });

  it("spend is booked per lane and per key", () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    saveConfig(pool(), cfg);
    process.env.CLAUDE_ROUTE_WALLET = path.join(dir, "wallet.json");
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const route = (lane, keyId) => ({ mode: "api", station: "custom", baseUrl: "https://a.example", priceMul: 1, lane, keyId });
    recordSpend({ usage, model: "claude-sonnet-4-5", route: route("chat", "k1"), configPath: cfg });
    recordSpend({ usage, model: "claude-sonnet-4-5", route: route("chat", "k2"), configPath: cfg });
    recordSpend({ usage, model: "claude-sonnet-4-5", route: route("night", "k1"), configPath: cfg });
    const w = walletSummary(cfg, "chat");
    assert.equal(w.usedUsd, 9);
    assert.equal(w.laneUsedUsd, 6);
    assert.equal(w.laneTurns, 2);
    assert.equal(w.byKey.k1.usedUsd, 6);
    assert.equal(w.byKey.k2.turns, 1);
    assert.equal(w.byLane.night.usedUsd, 3);
    delete process.env.CLAUDE_ROUTE_WALLET;
  });
});
