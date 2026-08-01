import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRouteEnv,
  clearRelayEnv,
  estimateUsd,
  loadConfig,
  saveConfig,
  setRouteMode,
  parseRouteTarget,
  mergeConfigPatch,
  publicConfig,
  recordSpend,
  walletAct,
} from "../src/index.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crs-"));
}

describe("env", () => {
  it("api mode sets base url and key, clears auth token", () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: "oauth-should-go",
      ANTHROPIC_BASE_URL: "old",
    };
    const r = applyRouteEnv(
      { station: "custom", baseUrl: "https://relay.example/v1", apiKey: "sk-test" },
      env,
    );
    assert.equal(r.mode, "api");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://relay.example/v1");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("passes through relay keys that do not look like sk-ant-", () => {
    // Real-world relays issue their own key formats; never gate on prefix.
    for (const key of ["fe1a2b3c4d5e", "cr_live_9f8e7d", "0123456789abcdef"]) {
      const env = {};
      const r = applyRouteEnv(
        { station: "custom", baseUrl: "https://relay.example", apiKey: key },
        env,
      );
      assert.equal(r.mode, "api");
      assert.equal(env.ANTHROPIC_API_KEY, key);
    }
  });

  it("account mode clears relay env", () => {
    const env = {
      ANTHROPIC_BASE_URL: "https://x",
      ANTHROPIC_API_KEY: "k",
    };
    const r = applyRouteEnv({ station: "account", baseUrl: "https://x", apiKey: "k" }, env);
    assert.equal(r.mode, "account");
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  it("clearRelayEnv works", () => {
    const env = { ANTHROPIC_BASE_URL: "u", ANTHROPIC_API_KEY: "k" };
    clearRelayEnv(env);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  });
});

describe("config + route", () => {
  it("switches without wiping url/key", () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    saveConfig(
      { station: "custom", baseUrl: "https://relay.example", apiKey: "sk-abc", priceMul: 1.1 },
      cfg,
    );
    let r = setRouteMode("account", { configPath: cfg });
    assert.equal(r.ok, true);
    assert.equal(r.route.mode, "account");
    let disk = loadConfig(cfg);
    assert.equal(disk.station, "account");
    assert.equal(disk.baseUrl, "https://relay.example");
    assert.equal(disk.apiKey, "sk-abc");

    r = setRouteMode("api", { configPath: cfg });
    assert.equal(r.ok, true);
    assert.equal(r.route.mode, "api");
    disk = loadConfig(cfg);
    assert.equal(disk.station, "custom");
  });

  it("parse aliases", () => {
    assert.equal(parseRouteTarget("中转"), "api");
    assert.equal(parseRouteTarget("主账号"), "account");
    assert.equal(parseRouteTarget("nope"), null);
  });

  it("mergeConfigPatch keeps key on mask", () => {
    const next = mergeConfigPatch(
      { station: "custom", baseUrl: "https://a", apiKey: "sk-secret-key", priceMul: 1 },
      { station: "account", baseUrl: "https://a", apiKey: "••••key" },
    );
    assert.equal(next.apiKey, "sk-secret-key");
    assert.equal(next.station, "account");
  });
});

describe("pricing + wallet", () => {
  it("estimates sonnet cheaper than opus default", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const opus = estimateUsd(usage, "opus");
    const sonnet = estimateUsd(usage, "sonnet");
    assert.ok(sonnet < opus);
    assert.equal(opus, 15);
  });

  it("records spend only in api mode", () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    saveConfig({ station: "custom", baseUrl: "https://r", apiKey: "k" }, cfg);
    process.env.CLAUDE_ROUTE_WALLET = path.join(dir, "wallet.json");
    const led = recordSpend({
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: "sonnet",
      route: { mode: "api", priceMul: 1, station: "custom", baseUrl: "https://r" },
      configPath: cfg,
    });
    assert.ok(led);
    assert.ok(led.usedUsd > 0);
    assert.equal(recordSpend({
      usage: { input_tokens: 1000 },
      route: { mode: "account" },
      configPath: cfg,
    }), null);
    delete process.env.CLAUDE_ROUTE_WALLET;
  });

  it("topup wallet", () => {
    const dir = tmpDir();
    process.env.CLAUDE_ROUTE_WALLET = path.join(dir, "w.json");
    const r = walletAct("topup", 10, path.join(dir, "c.json"));
    assert.equal(r.ok, true);
    assert.equal(r.wallet.balanceUsd, 10);
    delete process.env.CLAUDE_ROUTE_WALLET;
  });
});

describe("public", () => {
  it("masks key", () => {
    const p = publicConfig({ apiKey: "sk-abcdefghijklmnop" });
    assert.equal(p.apiKeySet, true);
    assert.ok(p.apiKey.includes("••••"));
    assert.ok(!p.apiKey.includes("sk-abcdef"));
  });
});
