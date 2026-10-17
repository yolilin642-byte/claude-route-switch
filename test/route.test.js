import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyRouteEnv,
  clearRelayEnv,
  estimateUsd,
  estimateUsdDetailed,
  loadConfig,
  saveConfig,
  setRouteMode,
  parseRouteTarget,
  mergeConfigPatch,
  publicConfig,
  recordSpend,
  walletAct,
  walletSummary,
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

  it("loads config written with a UTF-8 BOM", () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(
      cfg,
      "﻿" + JSON.stringify({ station: "custom", baseUrl: "https://bom", apiKey: "k" }),
      "utf8",
    );
    const c = loadConfig(cfg);
    assert.equal(c.station, "custom");
    assert.equal(c.baseUrl, "https://bom");
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
    assert.equal(opus, 4); // bare "opus" = newest listed (Opus 5.5)
  });

  it("prices by model version, not just family", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    assert.equal(estimateUsd(usage, "claude-opus-4-1-20250805"), 90);
    assert.equal(estimateUsd(usage, "claude-opus-4-20250514"), 90); // the date is not a minor version
    assert.equal(estimateUsd(usage, "claude-opus-4-5-20251101"), 30);
    assert.equal(estimateUsd(usage, "claude-opus-5-5"), 24);
    assert.equal(estimateUsd(usage, "anthropic/claude-sonnet-4.5"), 18);
    assert.equal(estimateUsd(usage, "claude-sonnet-5"), 12);
    assert.equal(estimateUsdDetailed(usage, "claude-3-5-haiku-20241022").tier, "haiku-3.5");
    assert.equal(estimateUsdDetailed(usage, "claude-haiku-4-5").tier, "haiku-4.5");
  });

  it("a Claude version the table does not know is flagged", () => {
    const est = estimateUsdDetailed({ input_tokens: 1_000_000 }, "claude-3-7-sonnet-20250219");
    assert.equal(est.assumed, true);
    assert.equal(est.tier, "sonnet-5.5");
  });

  it("prices 1-hour cache writes at 2x and model-specific cache reads", () => {
    const write = (split) => ({
      cache_creation_input_tokens: 1_000_000,
      ...(split ? { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } } : {}),
    });
    assert.equal(estimateUsd(write(false), "claude-sonnet-4-5"), 3.75);
    assert.equal(estimateUsd(write(true), "claude-sonnet-4-5"), 6);
    assert.equal(estimateUsd({ cache_read_input_tokens: 1_000_000 }, "claude-opus-5-5"), 0.2); // 0.05x
    assert.equal(estimateUsd({ cache_read_input_tokens: 1_000_000 }, "claude-opus-4-5"), 0.5); // 0.1x
  });

  it("Haiku 5.5 prompts over 100k tokens pay the long-context price", () => {
    const short = estimateUsdDetailed({ input_tokens: 50_000 }, "claude-haiku-5-5");
    const long = estimateUsdDetailed({ input_tokens: 20_000, cache_read_input_tokens: 130_000 }, "claude-haiku-5-5");
    assert.equal(short.tier, "haiku-5.5");
    assert.equal(short.usd, 0.005);
    assert.equal(long.tier, "haiku-5.5-long");
    assert.equal(long.usd, 0.0165); // 20k × $0.50 + 130k × $0.05
  });

  it("flags unknown models as assumed, known tiers as not", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    const mini = estimateUsdDetailed(usage, "gpt-4o-mini");
    assert.equal(mini.assumed, true);
    assert.equal(mini.tier, "opus-5.5");
    assert.equal(mini.usd, 4); // still Opus-priced — the point is it says so

    for (const m of ["claude-opus-4", "claude-sonnet-4-5", "claude-3-5-haiku"]) {
      assert.equal(estimateUsdDetailed(usage, m).assumed, false, m);
    }
  });

  it("custom rates override the fallback", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const rates = { "gpt-4o-mini": { in: 0.15, out: 0.6 } };
    const est = estimateUsdDetailed(usage, "gpt-4o-mini-2024", 1, rates);
    assert.equal(est.assumed, false);
    assert.equal(est.tier, "gpt-4o-mini");
    assert.equal(est.usd, 0.75);
    // longest substring wins
    const two = estimateUsdDetailed(usage, "gpt-4o-mini", 1, {
      gpt: { in: 100, out: 100 },
      "gpt-4o-mini": { in: 0.15, out: 0.6 },
    });
    assert.equal(two.tier, "gpt-4o-mini");
  });

  it("wallet reads rates from config and marks assumed turns", () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    saveConfig(
      {
        station: "custom",
        baseUrl: "https://r",
        apiKey: "k",
        rates: { "gpt-4o-mini": { in: 0.15, out: 0.6 } },
      },
      cfg,
    );
    process.env.CLAUDE_ROUTE_WALLET = path.join(dir, "wallet.json");
    const route = { mode: "api", priceMul: 1, station: "custom", baseUrl: "https://r" };

    recordSpend({
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      model: "gpt-4o-mini",
      route,
      configPath: cfg,
    });
    let sum = walletSummary(cfg);
    assert.equal(sum.recent[0].assumed, false);
    assert.equal(sum.recent[0].costUsd, 0.15); // not 15
    assert.deepEqual(sum.assumedModels, []);
    assert.equal(sum.warn, undefined);

    recordSpend({
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      model: "some-unlisted-model",
      route,
      configPath: cfg,
    });
    sum = walletSummary(cfg);
    assert.equal(sum.recent[0].assumed, true);
    assert.deepEqual(sum.assumedModels, ["some-unlisted-model"]);
    assert.ok(sum.warn);
    delete process.env.CLAUDE_ROUTE_WALLET;
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
