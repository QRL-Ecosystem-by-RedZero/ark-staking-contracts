/**
 * Posts a market stETH/QRL rate to a testnet's `MockPriceOracle` (audit
 * 2026-10-03, OC-ORC-06): the deployment posts 10,000 QRL per stETH once and
 * nobody updates it, about three times the market.
 *
 *   node scripts/oracle-post.js --chain hoodi-vps            # print the plan; sends nothing
 *   node scripts/oracle-post.js --chain hoodi-vps --apply    # post, signed by ORACLE_OPERATOR_MNEMONIC
 *
 * Run it daily. The rate is stETH/QRL = stETH/USD ÷ QRL/USD, from CoinGecko:
 *   - QRL/USD: the volume-weighted median of the QRL/USDT-type tickers, every
 *     venue more than 5% off the median dropped, at least two venues left,
 *     else nothing is posted;
 *   - stETH/USD (ETH/USD as a check), and the 90-day daily series of both.
 * It posts `set(twapEpoch = spot, twap30d = 30-day mean, twap24hAgo = 30-day
 * mean as of a day ago)` and `setDrawdown(90 profile-days, max drawdown of
 * QRL in stETH over 90 days)`; the registry caps the haircut itself.
 *
 * This is the stand-in the audit recommends for a testnet only. A value-holding
 * deployment runs `ArkReferenceOracle` (a reporter quorum, averages computed
 * on chain, step / staleness guards; CLAUDE.md item 122), fed by
 * `scripts/oracle-report.js`, which forms the same spot rate from the same
 * legs (`scripts/lib/market-price.js`).
 */
const { qrlClient, iface, qrlBuild } = require('./lib/chains');
const { profile: buildProfile } = require('./lib/profile');
// The market legs are shared with scripts/oracle-report.js (the reporters of
// ArkReferenceOracle): one formation of the rate, posted two ways.
const { get, qrlUsd, series, mean, toWei, CG } = require('./lib/market-price');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

async function main() {
  const chain = flag('chain');
  if (!chain) throw new Error('usage: node scripts/oracle-post.js --chain <name> [--apply]');
  const dep = require(path.join(__dirname, '..', 'deployments', `testnet-${chain}.json`));
  const oracle = dep.qrl.MockPriceOracle;
  if (!oracle) throw new Error(`testnet-${chain}.json names no MockPriceOracle`);
  const day = BigInt(buildProfile(dep.profile).day);

  const q = await qrlUsd();
  const simple = await get(`${CG}/simple/price?ids=ethereum,staked-ether&vs_currencies=usd`);
  const stethUsd = simple['staked-ether'].usd;
  const ethUsd = simple.ethereum.usd;
  if (Math.abs(stethUsd / ethUsd - 1) > 0.02) throw new Error(`stETH off its ETH peg by more than 2% (${stethUsd} vs ${ethUsd}); nothing posted`);

  const [qs, ss] = await Promise.all([series('quantum-resistant-ledger'), series('staked-ether')]);
  const n = Math.min(qs.length, ss.length);
  const pair = Array.from({ length: n }, (_, i) => ss[ss.length - n + i].p / qs[qs.length - n + i].p); // QRL per stETH, daily
  const spot = stethUsd / q.price;
  const twap30d = mean([...pair.slice(-29), spot]);
  const twap24hAgo = mean(pair.slice(-31, -1));
  // QRL's value in stETH is 1/pair; its worst fall from a running peak over 90 days.
  let peak = 0;
  let dd = 0;
  for (const p of pair.slice(-91)) { const v = 1 / p; peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak); }
  const drawdownBps = BigInt(Math.min(10_000, Math.round(dd * 10_000)));
  const window = 90n * day;

  console.log(`chain    ${chain}  oracle ${oracle}  profile ${dep.profile} (day ${day} s)`);
  console.log(`QRL/USD  ${q.price.toFixed(5)}  from ${q.venues.map((v) => `${v.venue} ${v.price.toFixed(5)} ($${Math.round(v.weight)})`).join(', ')}` + (q.dropped.length ? `; dropped ${q.dropped.map((v) => v.venue).join(', ')}` : ''));
  console.log(`stETH    $${stethUsd} (ETH $${ethUsd})`);
  console.log(`post     twapEpoch ${spot.toFixed(2)}  twap30d ${twap30d.toFixed(2)}  twap24hAgo ${twap24hAgo.toFixed(2)} QRL per stETH`);
  console.log(`         drawdown ${drawdownBps} bps over ${window} s (90 profile-days); the registry caps the haircut`);

  const c = qrlClient({ mnemonicKey: 'ORACLE_OPERATOR_MNEMONIC' });
  const abi = iface('MockPriceOracle', qrlBuild(dep.profile));
  const operator = (await c.call(oracle, abi, 'operator', []))[0];
  if (String(operator).toLowerCase().replace(/^q/, '0x') !== String(c.address).toLowerCase().replace(/^q/, '0x')) {
    throw new Error(`ORACLE_OPERATOR_MNEMONIC signs as ${c.address}, but the oracle's operator is ${operator}`);
  }
  const before = await c.call(oracle, abi, 'observe', [0, '0x' + '00'.repeat(64)]).catch(() => null);
  if (before) console.log(`now      ${before.map((x) => (Number(BigInt(x) / 10n ** 14n) / 1e4).toFixed(2)).join(' / ')}`);
  if (!has('apply')) {
    console.log('\nplan only; nothing sent. Add --apply to post.');
    return;
  }
  await c.send(oracle, abi, 'set', [toWei(spot), toWei(twap30d), toWei(twap24hAgo)]);
  await c.send(oracle, abi, 'setDrawdown', [window, drawdownBps]);
  const after = await c.call(oracle, abi, 'observe', [0, '0x' + '00'.repeat(64)]);
  console.log(`posted   ${after.map((x) => (Number(BigInt(x) / 10n ** 14n) / 1e4).toFixed(2)).join(' / ')} QRL per stETH`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
