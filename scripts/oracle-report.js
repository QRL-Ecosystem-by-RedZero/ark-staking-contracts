/**
 * The reporters of `ArkReferenceOracle` on a testnet deployment (yellow paper
 * §6.1; technical reference §1.4, §3.7; staking CLAUDE.md item 122), as one
 * long-running process holding one or more reporter keys.
 *
 *   node scripts/oracle-report.js --chain hoodi-vps                      # every key in .env, forever
 *   node scripts/oracle-report.js --chain hoodi-vps --reporters 1,2      # ORACLE_REPORTER1/2_MNEMONIC only
 *   node scripts/oracle-report.js --chain hoodi-vps --once               # one step, then exit
 *   node scripts/oracle-report.js --chain hoodi-vps --once --dry-run     # read and form the spot; send nothing
 *   node scripts/oracle-report.js --chain hoodi-vps --price 3264.12      # post this spot instead of the market's (tests)
 *
 * Every τ_o (`settings().roundIntervalSeconds`, read each step) each selected
 * key submits the market stETH/QRL spot for the open round — formed exactly as
 * `oracle-post.js` forms it (`scripts/lib/market-price.js`: the
 * volume-weighted median of the QRL venues after a 5% cut, at least two
 * venues, stETH's peg checked) — until the round is accepted; and at each
 * epoch boundary every key submits its figure for the realised yield of the
 * epoch just closed (`submitYield`) at the book's key `(0, address(0))` and at
 * each admitted asset's key `(chainId, asset)`. How a round and a yield are
 * decided: `scripts/lib/oracle-reporter.js`.
 *
 * The yield figure (`--yield-source`, default `auto`): technical reference
 * §1.4 — "the realised yield of the asset over the trailing window closed at
 * the last boundary, the median of the reporters' figures, one figure per
 * epoch". For an asset whose manifest `source` is `lido` it is Lido's seven-day
 * moving average of the stETH APR (mainnet, as the price legs are), read once
 * per epoch; for any other asset the manifest's `admissionYieldBps` (a
 * double's yield, what MockPriceOracle was set to). The book's key takes the
 * mean of the admitted assets' figures (the registry keeps no per-asset
 * notional to weight by; with one admitted asset, as on hoodi-vps, it is that
 * asset's figure). `--yield-source
 * manifest` posts what the double posted (the book 220 bps, each asset its
 * `admissionYieldBps`); `--yield-bps <n>` posts n at every key.
 *
 * Robustness: a failed market read posts nothing for the round (the oracle
 * then falls silent after its heartbeat, by design); CoinGecko 429 and 5xx are
 * retried; node reads are retried; a key never resubmits a round (simulated
 * first, and kept in memory); a step that fails is logged and the loop goes on.
 * One log line per round. While the hold file exists (`--hold-file`, default
 * <tmp>/ark-oracle-report-<chain>.hold) nothing is posted: the oracle-live
 * scenario writes it to silence the feed on purpose.
 *
 * Keys: ORACLE_REPORTER<n>_MNEMONIC in .env; each must be a reporter of the
 * deployed oracle (`isReporter`). Gas: each key needs QRL; deployQrlLeg tops
 * the configured reporters up to QRL_ROLE_FUNDING.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const { qrlClient, iface, qrlBuild, qrvmBuild, evmToQrl } = require('./lib/chains');
const { profile: buildProfile } = require('./lib/profile');
const { BOOK_YIELD_BPS } = require('./lib/deploy');
const market = require('./lib/market-price');
const { OracleReporter, withRetry } = require('./lib/oracle-reporter');
const { errorInterface } = require('../ecdsa-stakings/relayer/engine/errors');
const manifestLib = require('../ecdsa-stakings/relayer/lib/manifest');
const { toHex } = require('../ecdsa-stakings/relayer/lib/addresses');

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const same = (a, b) => toHex(a).toLowerCase() === toHex(b).toLowerCase();
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const log = (line) => console.log(`${stamp()} ${line}`);

async function main() {
  const chain = flag('chain');
  if (!chain) throw new Error('usage: node scripts/oracle-report.js --chain <name> [--reporters 1,2,3] [--once] [--dry-run] [--price <qrlPerSteth>] [--yield-source auto|lido|manifest] [--yield-bps <n>] [--hold-file <path>]');
  const depFile = path.join(__dirname, '..', 'deployments', `testnet-${chain}.json`);
  if (!fs.existsSync(depFile)) throw new Error(`no ${path.relative(process.cwd(), depFile)}`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const po = dep.priceOracle || {};
  const oracleAddr = (dep.qrl && dep.qrl.ArkReferenceOracle) || (po.kind === 'real' ? po.address : null);
  if (!oracleAddr) {
    throw new Error(`testnet-${chain}.json wires ${po.contract || 'MockPriceOracle'}, not ArkReferenceOracle: nothing to report to (post the double with scripts/oracle-post.js; redeploy the QRL leg with ARK_PRICE_ORACLE=ArkReferenceOracle)`);
  }
  const m = manifestLib.load(chain);
  const epochLength = BigInt(buildProfile(dep.profile || m.profile).day) * 7n;

  // The keys: ORACLE_REPORTER<n>_MNEMONIC, all of them or those --reporters names.
  // Read from .env directly: a reporter host needs no deployer key.
  const env = require('./qrl').loadEnv();
  const wanted = flag('reporters') ? flag('reporters').split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(env).map((k) => (k.match(/^ORACLE_REPORTER(\d+)_MNEMONIC$/) || [])[1]).filter(Boolean).sort((a, b) => Number(a) - Number(b));
  if (!wanted.length) throw new Error('no ORACLE_REPORTER<n>_MNEMONIC in .env');
  const reporters = wanted.map((n) => {
    const key = `ORACLE_REPORTER${n}_MNEMONIC`;
    if (!env[key]) throw new Error(`${key} is not in .env`);
    return { label: `r${n}`, client: qrlClient({ name: `oracle-reporter-${n}`, mnemonicKey: key }) };
  });

  // Reads go through the first key's client.
  const probe = reporters[0].client;

  // The ABI: the v3 build where it exists, else the v2 build of the profile (one source, one ABI).
  const qrvm = qrvmBuild(dep.profile || m.profile);
  const build = fs.existsSync(path.join(qrvm, 'ArkReferenceOracle.json')) ? qrvm : qrlBuild(dep.profile || m.profile);
  if (!fs.existsSync(path.join(build, 'ArkReferenceOracle.json'))) throw new Error(`no ArkReferenceOracle artifact in ${path.basename(build)}/; compile the profile first`);
  const abi = iface('ArkReferenceOracle', build);
  const errors = errorInterface([build]);
  const zero = '0x' + '00'.repeat(64);
  const assetArg = (a) => evmToQrl(toHex(a));

  for (const r of reporters) {
    const [is] = await r.client.call(oracleAddr, abi, 'isReporter', [r.client.address]);
    const bal = await r.client.balance(r.client.address);
    log(`oracle   ${r.label} ${r.client.address.slice(0, 18)}… reporter ${is ? 'yes' : 'NO'}, balance ${bal / 10n ** 18n} QRL`);
    if (!is) throw new Error(`${r.label} (${r.client.address}) is not a reporter of ${oracleAddr}; check ORACLE_REPORTERS at deploy time`);
    if (bal === 0n) log(`oracle   WARNING ${r.label} holds no QRL; its sends will fail (QRL_ROLE_FUNDING at deploy, or fund it)`);
  }

  // The spot.
  const forced = flag('price');
  const priceSource = forced
    ? async () => ({ wei: market.toWei(Number(forced)), line: `--price ${forced}` })
    : async () => {
      const r = await market.spotStethQrl({ retry5xx: true });
      return { wei: market.toWei(r.spot), line: market.describeSpot(r) };
    };

  // The yields: the book's key and each admitted asset's.
  const assets = (dep.assets || []).map((a) => {
    const ma = (m.assets || []).find((x) => same(x.address, a.asset)) || {};
    return { ...a, source: ma.source || null, admissionYieldBps: ma.admissionYieldBps || null };
  });
  const yieldKeys = [{ label: 'book', chainId: 0n, asset: zero, book: true }, ...assets.map((a) => ({ label: a.symbol, chainId: BigInt(dep.originChainId), asset: assetArg(a.asset), assetKey: a.assetKey, entry: a }))];
  const mode = flag('yield-source', 'auto');
  const fixed = flag('yield-bps');
  const perEpoch = new Map();
  const assetFigure = async (a, epoch) => {
    const k = `${a.symbol}|${epoch}`;
    if (perEpoch.has(k)) return perEpoch.get(k);
    let v;
    if (mode === 'manifest' || (mode === 'auto' && a.source !== 'lido')) v = a.admissionYieldBps || 220;
    else v = await market.lidoAprBps();
    perEpoch.set(k, v);
    return v;
  };
  const yieldSource = async (yk, epoch) => {
    if (fixed) return Number(fixed);
    if (!yk.book) return assetFigure(yk.entry, epoch);
    if (mode === 'manifest') return BOOK_YIELD_BPS;
    // The book: the mean of the admitted assets' figures. The registry keeps no
    // per-asset notional to weight by; with one admitted asset it is that asset's.
    const figs = [];
    for (const a of assets) figs.push(await assetFigure(a, epoch));
    if (!figs.length) return null;
    return Math.round(figs.reduce((x, y) => x + y, 0) / figs.length);
  };

  const holdFile = flag('hold-file', path.join(os.tmpdir(), `ark-oracle-report-${chain}.hold`));
  const reporter = new OracleReporter({
    reporters,
    oracle: oracleAddr,
    abi,
    errors,
    priceKey: { chainId: 0n, asset: zero },
    yieldKeys,
    epochLength,
    priceSource,
    yieldSource,
    holdFile,
    now: async () => (await probe.head()).timestamp,
    log,
  });
  const st = await reporter.state();
  log(`oracle   ${chain} ${oracleAddr.slice(0, 18)}… τ_o ${st.settings.interval} s, heartbeat ${st.settings.heartbeat} s, quorum ${st.settings.quorum}, s_obs ${st.settings.maxStepBps} bps, d_rep ${st.settings.maxDispersionBps} bps; last round ${st.latest.roundId} at ${st.latest.updatedAt}; keys ${reporters.map((r) => r.label).join(', ')}; hold file ${holdFile}`);
  const silent = await withRetry(() => probe.call(oracleAddr, abi, 'silent', [0n, zero]));
  log(`oracle   the book's series is ${silent[0] ? 'SILENT (warm-up, heartbeat, pause or no mark yet)' : 'live'}`);

  if (has('dry-run')) {
    const p = await priceSource();
    log(`oracle   dry run: would post ${Number(p.wei / 10n ** 12n) / 1e6} QRL/stETH (${p.line}); nothing sent`);
    for (const yk of yieldKeys) {
      try {
        log(`oracle   dry run: yield ${yk.label} ${await yieldSource(yk, st.now / epochLength - 1n)} bps`);
      } catch (e) {
        log(`oracle   dry run: yield ${yk.label} not formed (${e.message})`);
      }
    }
    return;
  }

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  await reporter.run({ once: has('once'), maxWaitSeconds: Number(flag('max-wait', '60')), stop: () => stopping });
  log(`oracle   stopped: ${JSON.stringify(reporter.stats)}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
