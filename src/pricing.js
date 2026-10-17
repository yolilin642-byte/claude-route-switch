/**
 * Rough USD estimate from Anthropic-style usage fields.
 * Rates are public Claude list prices ($ / MTok); relays often differ — use priceMul.
 *
 * Built-in prices are per model version, copied from
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-18. They go stale;
 * check that page, or override with `rates` in config.json.
 *
 * Anything that is not a Claude model falls back to the newest Opus price and is flagged
 * `assumed: true` — a relay model such as `gpt-4o-mini` would otherwise be billed dozens
 * of times its real price in silence. Supply custom `rates` to price it correctly.
 */

/** Prices checked against the official page on this date. */
export const PRICES_AS_OF = "2026-10-18";

/**
 * Built-in table, $ / MTok. `cacheRead` is listed where it is not the standard 0.1x.
 * Cache writes are 1.25x input (5-minute) and 2x input (1-hour) for every model.
 * @type {Record<string, { in: number, out: number, cacheRead?: number }>}
 */
export const RATES = {
  "opus-5.5": { in: 4, out: 20, cacheRead: 0.2 },
  "opus-5": { in: 5, out: 25 },
  "opus-4.8": { in: 5, out: 25 },
  "opus-4.7": { in: 5, out: 25 },
  "opus-4.6": { in: 5, out: 25 },
  "opus-4.5": { in: 5, out: 25 },
  "opus-4.1": { in: 15, out: 75 },
  "opus-4": { in: 15, out: 75 },
  "sonnet-5.5": { in: 2, out: 10, cacheRead: 0.1 },
  "sonnet-5": { in: 2, out: 10 },
  "sonnet-4.6": { in: 3, out: 15 },
  "sonnet-4.5": { in: 3, out: 15 },
  "sonnet-4": { in: 3, out: 15 },
  "haiku-5.5": { in: 0.1, out: 0.5 },
  // Haiku 5.5 prompts over 100k tokens (input + cache reads + cache writes) pay this instead.
  "haiku-5.5-long": { in: 0.5, out: 2.5 },
  "haiku-4.5": { in: 1, out: 5 },
  "haiku-3.5": { in: 0.8, out: 4 },
};

/** What a bare family name ("opus", "sonnet", "haiku") means: the newest listed version. */
const NEWEST = { opus: "opus-5.5", sonnet: "sonnet-5.5", haiku: "haiku-5.5" };

const HAIKU_LONG_THRESHOLD = 100_000;

function fullRate(r) {
  return {
    in: r.in,
    out: r.out,
    cacheWrite: r.cacheWrite ?? r.in * 1.25,
    cacheWrite1h: r.cacheWrite1h ?? r.in * 2,
    cacheRead: r.cacheRead ?? r.in * 0.1,
  };
}

/**
 * Family + version from a model id. Handles `claude-opus-4-1-20250805`, `claude-opus-5-5`,
 * `anthropic/claude-sonnet-4.5`, `claude-3-5-haiku-20241022`, and bare `opus`.
 * A trailing date is never read as a minor version.
 * @param {string} model
 * @returns {{ family: string, version: string } | null}
 */
export function parseClaudeModel(model = "") {
  const m = String(model || "").toLowerCase();
  // Old ids put the version first: claude-3-5-haiku-20241022.
  let hit = m.match(/(?<!\d)(\d)[-.](\d)[-_ ]?(opus|sonnet|haiku)/);
  if (hit) return { family: hit[3], version: `${hit[1]}.${hit[2]}` };
  hit = m.match(/(opus|sonnet|haiku)[-_ ]?(\d{1,2})(?!\d)(?:[-.](\d)(?!\d))?/);
  if (hit) return { family: hit[1], version: hit[3] ? `${hit[2]}.${hit[3]}` : hit[2] };
  hit = m.match(/(opus|sonnet|haiku)/);
  if (hit) return { family: hit[1], version: "" };
  return null;
}

/**
 * Normalize a user-supplied rate table: `{ "<model substring>": { in, out, ... } }`.
 * `in` and `out` are required; cache rates default to 1.25x / 2x / 0.1x of `in`.
 * @param {object} [rates]
 */
export function normalizeRates(rates = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!rates || typeof rates !== "object") return out;
  for (const [key, val] of Object.entries(rates)) {
    if (!key || key.startsWith("_") || !val || typeof val !== "object") continue;
    const i = Number(val.in);
    const o = Number(val.out);
    if (!(i >= 0) || !(o >= 0)) continue;
    out[String(key).toLowerCase()] = fullRate({
      in: i,
      out: o,
      cacheWrite: Number(val.cacheWrite) >= 0 ? Number(val.cacheWrite) : undefined,
      cacheWrite1h: Number(val.cacheWrite1h) >= 0 ? Number(val.cacheWrite1h) : undefined,
      cacheRead: Number(val.cacheRead) >= 0 ? Number(val.cacheRead) : undefined,
    });
  }
  return out;
}

/**
 * Pick a rate for a model name.
 * Custom rates win (exact key, then longest substring match), then the built-in version
 * table, then the newest Opus price marked `assumed`.
 *
 * @param {string} [model]
 * @param {object} [rates] custom table, see normalizeRates
 * @param {number} [promptTokens] input + cache reads + cache writes of one request
 * @returns {{ in: number, out: number, cacheWrite: number, cacheWrite1h: number, cacheRead: number, tier: string, assumed: boolean }}
 */
export function pickRate(model = "", rates, promptTokens = 0) {
  const m = String(model || "").toLowerCase();
  const custom = normalizeRates(rates);

  if (custom[m]) return { ...custom[m], tier: m, assumed: false };
  const hit = Object.keys(custom)
    .filter((k) => m.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return { ...custom[hit], tier: hit, assumed: false };

  const parsed = parseClaudeModel(m);
  if (parsed) {
    let tier = parsed.version ? `${parsed.family}-${parsed.version}` : NEWEST[parsed.family];
    // A Claude version this table does not know yet (or no longer lists): price it as the
    // newest of its family, and say so.
    const known = !!RATES[tier];
    if (!known) tier = NEWEST[parsed.family];
    if (tier === "haiku-5.5" && promptTokens > HAIKU_LONG_THRESHOLD) tier = "haiku-5.5-long";
    return { ...fullRate(RATES[tier]), tier, assumed: !known };
  }
  return { ...fullRate(RATES[NEWEST.opus]), tier: NEWEST.opus, assumed: true };
}

/**
 * Estimate cost and report how it was priced.
 * If `usage.cache_creation` splits writes into `ephemeral_5m_input_tokens` /
 * `ephemeral_1h_input_tokens`, the 1-hour part is priced at 2x input; otherwise every
 * cache write is priced as a 5-minute write.
 * @param {object} [usage]
 * @param {string} [model]
 * @param {number} [priceMul=1]
 * @param {object} [rates] custom table, see normalizeRates
 * @returns {{ usd: number, tier: string, assumed: boolean, model: string }}
 */
export function estimateUsdDetailed(usage = {}, model = "", priceMul = 1, rates) {
  const inT = Number(usage.input_tokens || 0);
  const outT = Number(usage.output_tokens || 0);
  const cw = Number(usage.cache_creation_input_tokens || 0);
  const cr = Number(usage.cache_read_input_tokens || 0);
  const split = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
  const cw1h = split ? Number(split.ephemeral_1h_input_tokens || 0) : 0;
  const cw5m = split ? Math.max(0, cw - cw1h) : cw;

  const rate = pickRate(model, rates, inT + cw + cr);
  const usd =
    (inT * rate.in +
      outT * rate.out +
      cw5m * rate.cacheWrite +
      cw1h * rate.cacheWrite1h +
      cr * rate.cacheRead) /
    1e6;
  const mul = Number(priceMul) > 0 ? Number(priceMul) : 1;
  return {
    usd: Math.round(usd * mul * 1e6) / 1e6,
    tier: rate.tier,
    assumed: rate.assumed,
    model: String(model || ""),
  };
}

/**
 * @param {object} [usage]
 * @param {string} [model]
 * @param {number} [priceMul=1]
 * @param {object} [rates] custom table, see normalizeRates
 * @returns {number} USD
 */
export function estimateUsd(usage = {}, model = "", priceMul = 1, rates) {
  return estimateUsdDetailed(usage, model, priceMul, rates).usd;
}
