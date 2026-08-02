/**
 * Rough USD estimate from Anthropic-style usage fields.
 * Rates are public Claude list prices ($ / MTok); relays often differ — use priceMul.
 *
 * Only haiku / sonnet / opus are known built-in tiers. Anything else falls back to
 * Opus-tier rates and is flagged `assumed: true` — a relay model such as
 * `gpt-4o-mini` would otherwise be billed ~100x its real price in silence.
 * Supply custom `rates` (from config) to price non-Claude models correctly.
 */

/** @type {Record<string, { in: number, out: number, cacheWrite: number, cacheRead: number }>} */
export const RATES = {
  opus: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Normalize a user-supplied rate table: `{ "<model substring>": { in, out, ... } }`.
 * `in` and `out` are required; cache rates default to Anthropic's 1.25x / 0.1x shape.
 * @param {object} [rates]
 * @returns {Record<string, { in: number, out: number, cacheWrite: number, cacheRead: number }>}
 */
export function normalizeRates(rates = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!rates || typeof rates !== "object") return out;
  for (const [key, val] of Object.entries(rates)) {
    if (!key || !val || typeof val !== "object") continue;
    const i = Number(val.in);
    const o = Number(val.out);
    if (!(i >= 0) || !(o >= 0)) continue;
    out[String(key).toLowerCase()] = {
      in: i,
      out: o,
      cacheWrite: Number(val.cacheWrite) >= 0 ? Number(val.cacheWrite) : i * 1.25,
      cacheRead: Number(val.cacheRead) >= 0 ? Number(val.cacheRead) : i * 0.1,
    };
  }
  return out;
}

/**
 * Pick a rate for a model name.
 * Custom rates win (exact key, then longest substring match), then built-in tiers,
 * then an Opus-tier guess marked `assumed`.
 *
 * @param {string} [model]
 * @param {object} [rates] custom table, see normalizeRates
 * @returns {{ in: number, out: number, cacheWrite: number, cacheRead: number, tier: string, assumed: boolean }}
 */
export function pickRate(model = "", rates) {
  const m = String(model || "").toLowerCase();
  const custom = normalizeRates(rates);

  if (custom[m]) return { ...custom[m], tier: m, assumed: false };
  const hit = Object.keys(custom)
    .filter((k) => m.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return { ...custom[hit], tier: hit, assumed: false };

  if (m.includes("haiku")) return { ...RATES.haiku, tier: "haiku", assumed: false };
  if (m.includes("sonnet")) return { ...RATES.sonnet, tier: "sonnet", assumed: false };
  if (m.includes("opus")) return { ...RATES.opus, tier: "opus", assumed: false };
  return { ...RATES.opus, tier: "opus", assumed: true };
}

/**
 * Estimate cost and report how it was priced.
 * @param {object} [usage]
 * @param {string} [model]
 * @param {number} [priceMul=1]
 * @param {object} [rates] custom table, see normalizeRates
 * @returns {{ usd: number, tier: string, assumed: boolean, model: string }}
 */
export function estimateUsdDetailed(usage = {}, model = "", priceMul = 1, rates) {
  const rate = pickRate(model, rates);
  const inT = Number(usage.input_tokens || 0);
  const outT = Number(usage.output_tokens || 0);
  const cw = Number(usage.cache_creation_input_tokens || 0);
  const cr = Number(usage.cache_read_input_tokens || 0);
  const usd =
    (inT * rate.in + outT * rate.out + cw * rate.cacheWrite + cr * rate.cacheRead) / 1e6;
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
