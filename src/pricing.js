/**
 * Rough USD estimate from Anthropic-style usage fields.
 * Rates are public Claude list prices ($ / MTok); relays often differ — use priceMul.
 *
 * Defaults to Opus-tier rates when the model name is unknown.
 */

/** @type {Record<string, { in: number, out: number, cacheWrite: number, cacheRead: number }>} */
export const RATES = {
  opus: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * @param {string} [model]
 */
export function pickRate(model = "") {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return RATES.haiku;
  if (m.includes("sonnet")) return RATES.sonnet;
  return RATES.opus;
}

/**
 * @param {object} [usage]
 * @param {string} [model]
 * @param {number} [priceMul=1]
 * @returns {number} USD
 */
export function estimateUsd(usage = {}, model = "", priceMul = 1) {
  const rate = pickRate(model);
  const inT = Number(usage.input_tokens || 0);
  const outT = Number(usage.output_tokens || 0);
  const cw = Number(usage.cache_creation_input_tokens || 0);
  const cr = Number(usage.cache_read_input_tokens || 0);
  const usd =
    (inT * rate.in + outT * rate.out + cw * rate.cacheWrite + cr * rate.cacheRead) / 1e6;
  const mul = Number(priceMul) > 0 ? Number(priceMul) : 1;
  return Math.round(usd * mul * 1e6) / 1e6;
}
