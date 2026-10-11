/**
 * The market stETH/QRL rate, from CoinGecko: what `scripts/oracle-post.js`
 * posts to a testnet's price double and what `scripts/oracle-report.js` has
 * each reporter key `submit` to `ArkReferenceOracle` (OC-ORC-06; staking
 * CLAUDE.md items 121, 122).
 *
 * The one rule this module exists to enforce: **a quote that is not formed
 * posts nothing.** The QRL leg is the volume-weighted median of the QRL
 * tickers, every venue more than 5% off the median dropped, and at least two
 * venues left (technical reference §3.4: "a reporter with fewer than two
 * venues within the cut posts nothing for the round"); stETH must hold its ETH
 * peg within 2%. Anything short of that throws, and the caller posts nothing:
 * on the real oracle a key that posts nothing is how a feed falls silent
 * after its heartbeat, by design (yellow paper §6.1, I40).
 *
 *   stETH/QRL = stETH/USD ÷ QRL/USD
 *
 * `COINGECKO_API_KEY` in .env (Demo plan) lifts the anonymous rate limit to
 * 30 calls a minute; a spot read makes two, the 90-day series two more.
 */
const CG = 'https://api.coingecko.com/api/v3';
/**
 * The outlier cut of the QRL leg (technical reference §3.4: 500 bps).
 * `ORACLE_QRL_DEVIATION_BPS` overrides it for a testnet reporter only: on
 * 2026-10-10 the hoodi-vps audit relaxed it to 1,000 bps for a while, the
 * committed venues being three thin markets where one stale venue silenced
 * the oracle (OC-ORC-14). Never set on a production reporter.
 */
const DEVIATION = Math.min(Math.max(Number(process.env.ORACLE_QRL_DEVIATION_BPS || 500), 100), 2000) / 10_000;
/** stETH off its ETH peg by more than this, and nothing is posted. */
const PEG_TOLERANCE = 0.02;
const ONE = 10n ** 18n;

let cachedKey = null;
function cgKey() {
  if (cachedKey !== null) return cachedKey;
  try {
    cachedKey = require('../qrl').loadEnv().COINGECKO_API_KEY || process.env.COINGECKO_API_KEY || '';
  } catch {
    cachedKey = process.env.COINGECKO_API_KEY || '';
  }
  return cachedKey;
}

/**
 * A CoinGecko GET. Rate-limited (HTTP 429): wait 15 s, 30 s, … and ask again,
 * five times. With `retry5xx` a server error (5xx), a timeout or a dropped
 * connection is retried the same way (the reporter's daemon); without it they
 * throw at once, as `oracle-post.js` always has.
 */
async function get(url, { retry5xx = false, attempts = 5, backoffMs = 15_000 } = {}) {
  const key = cgKey();
  const headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  for (let attempt = 0; ; attempt += 1) {
    let r;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      if (!retry5xx || attempt >= attempts) throw e;
      await new Promise((res) => setTimeout(res, backoffMs * (attempt + 1)));
      continue;
    }
    if (r.ok) return r.json();
    const retryable = r.status === 429 || (retry5xx && r.status >= 500);
    if (!retryable || attempt >= attempts) throw new Error(`${url}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, backoffMs * (attempt + 1)));
  }
}

function weightedMedian(rows) {
  const s = [...rows].sort((a, b) => a.price - b.price);
  const total = s.reduce((t, r) => t + r.weight, 0);
  let acc = 0;
  for (const r of s) {
    acc += r.weight;
    if (acc >= total / 2) return r.price;
  }
  return s[s.length - 1].price;
}

/** QRL/USD: the volume-weighted median of the QRL tickers after the cut, at least two venues; throws otherwise. */
async function qrlUsd(opts = {}) {
  const t = await get(`${CG}/coins/quantum-resistant-ledger/tickers`, opts);
  const rows = (t.tickers || [])
    .filter((x) => !x.is_stale && !x.is_anomaly && x.converted_last && x.converted_last.usd > 0 && x.converted_volume && x.converted_volume.usd > 0)
    .map((x) => ({ venue: x.market && x.market.name, pair: `${x.base}/${x.target}`, price: x.converted_last.usd, weight: x.converted_volume.usd }));
  if (rows.length < 2) throw new Error(`only ${rows.length} QRL venue(s) answered; nothing posted`);
  const m0 = weightedMedian(rows);
  const kept = rows.filter((r) => Math.abs(r.price / m0 - 1) <= DEVIATION);
  if (kept.length < 2) throw new Error(`fewer than two QRL venues within ${DEVIATION * 100}% of the median; nothing posted`);
  return { price: weightedMedian(kept), venues: kept, dropped: rows.filter((r) => !kept.includes(r)) };
}

/** stETH/USD and ETH/USD; throws where stETH is off its peg by more than 2%. */
async function stethUsd(opts = {}) {
  const simple = await get(`${CG}/simple/price?ids=ethereum,staked-ether&vs_currencies=usd`, opts);
  const steth = simple['staked-ether'].usd;
  const eth = simple.ethereum.usd;
  if (Math.abs(steth / eth - 1) > PEG_TOLERANCE) throw new Error(`stETH off its ETH peg by more than 2% (${steth} vs ${eth}); nothing posted`);
  return { steth, eth };
}

/** The spot stETH/QRL rate, QRL per stETH, with the legs it was formed from. Throws where a leg is not formed. */
async function spotStethQrl(opts = {}) {
  const q = await qrlUsd(opts);
  const s = await stethUsd(opts);
  return { spot: s.steth / q.price, qrl: q, stethUsd: s.steth, ethUsd: s.eth };
}

/** The 91-day daily USD series of a CoinGecko id. */
async function series(id, opts = {}) {
  const c = await get(`${CG}/coins/${id}/market_chart?vs_currency=usd&days=91&interval=daily`, opts);
  return c.prices.map(([t, p]) => ({ t, p }));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** QRL per stETH as a float into 18-decimal planck per unit, to the micro-QRL. */
const toWei = (qrlPerSteth) => (BigInt(Math.round(qrlPerSteth * 1e6)) * ONE) / 1_000_000n;

/** The legs of a spot read on one line. */
function describeSpot(r) {
  const q = r.qrl;
  return `QRL/USD ${q.price.toFixed(5)} from ${q.venues.map((v) => `${v.venue} ${v.price.toFixed(5)} ($${Math.round(v.weight)})`).join(', ')}` +
    (q.dropped.length ? `; dropped ${q.dropped.map((v) => v.venue).join(', ')}` : '') +
    `; stETH $${r.stethUsd} (ETH $${r.ethUsd})`;
}

/**
 * The realised yield of stETH over a trailing window, in bps per annum: Lido's
 * published seven-day simple moving average of the protocol APR, which Lido
 * computes from the share rate of its daily oracle reports — the yield the
 * token actually realised, not a projection. Mainnet, as the price legs are:
 * a compressed testnet epoch is 70 minutes, inside which the Hoodi token
 * rebases once a day or not at all, so a figure read from the testnet token
 * over one epoch is not a yield. Throws where the API does not answer a
 * figure; the caller then posts no yield and the oracle keeps reading the
 * last one accepted.
 */
const LIDO_APR_SMA = 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma';
async function lidoAprBps({ attempts = 3, backoffMs = 5_000 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const r = await fetch(LIDO_APR_SMA, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`${LIDO_APR_SMA}: HTTP ${r.status}`);
      const body = await r.json();
      const apr = Number(body && body.data && body.data.smaApr);
      if (!Number.isFinite(apr) || apr <= 0 || apr > 100) throw new Error(`${LIDO_APR_SMA}: no smaApr in the answer`);
      return Math.round(apr * 100);
    } catch (e) {
      last = e;
      if (attempt + 1 < attempts) await new Promise((res) => setTimeout(res, backoffMs * (attempt + 1)));
    }
  }
  throw last;
}

module.exports = { CG, DEVIATION, PEG_TOLERANCE, get, weightedMedian, qrlUsd, stethUsd, spotStethQrl, series, mean, toWei, describeSpot, lidoAprBps, LIDO_APR_SMA };
