/**
 * `ArkReferenceOracle` as a scenario drives it (yellow paper §6.1; staking
 * CLAUDE.md item 122): its reporters run in this process beside the relayer,
 * on the scenario's clock, through the same `OracleReporter` the daemon
 * `scripts/oracle-report.js` runs.
 *
 * On the harness the reporters are three actor accounts the deployment named
 * (`harnessReporterAddresses`, `scripts/e2e-local.js`), posting the price the
 * double would have posted (`PRICE`) and the yields it would have been set to
 * (the book 220 bps, each asset its `admissionYieldBps`), so a scenario run
 * on the real oracle sees the series the double gave. The reporter is a
 * `ctx.feeds` entry: it steps before each tick and every `feedStep` seconds
 * of every sleep, as a daemon posting each round interval would.
 *
 * On a live chain the keys are `ORACLE_REPORTER<n>_MNEMONIC` of .env, posting
 * the market spot (`scripts/lib/market-price.js`) and the Lido figure, in a
 * background loop; the external daemon is held for the scenario's length by
 * its hold file, so exactly one process reports and the scenario can stop
 * reporting on purpose (`pause`) and start it again (`resume`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { harnessActorAddress, ScenarioError } = require('../lib');
const { iface, qrlBuild, qrvmBuild, qrlClient, harnessAccount, parseLogs, decodeQrlLogs } = require('../../lib/chains');
const { PRICE, BOOK_YIELD_BPS } = require('../../lib/deploy');
const { OracleReporter } = require('../../lib/oracle-reporter');
const market = require('../../lib/market-price');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

const ZERO20 = '0x' + '00'.repeat(20);
const REPORTER_LABELS = ['oracle-reporter-0', 'oracle-reporter-1', 'oracle-reporter-2'];
/** The addresses the harness deployment names as the reporter set (`e2e-local.js`). */
const harnessReporterAddresses = () => REPORTER_LABELS.map(harnessActorAddress);
const same = (a, b) => toHex(a).toLowerCase() === toHex(b).toLowerCase();

/** The QIP-55 decode table of the oracle's events read here. */
const ORACLE_EVENTS = {
  RoundAccepted: {
    signature: 'RoundAccepted(uint64,uint256,address,uint256,bool,uint64)',
    topics: [{ name: 'roundId', type: 'uint64' }, { name: 'asset', type: 'address' }],
    data: [{ name: 'chainId', type: 'uint256' }, { name: 'observation', type: 'uint256' }, { name: 'clamped', type: 'bool' }, { name: 'updatedAt', type: 'uint64' }],
  },
  ReportSubmitted: {
    signature: 'ReportSubmitted(uint64,address,uint256)',
    topics: [{ name: 'roundId', type: 'uint64' }, { name: 'reporter', type: 'address' }],
    data: [{ name: 'spot', type: 'uint256' }],
  },
  Paused: {
    signature: 'Paused(address,uint64)',
    topics: [{ name: 'by', type: 'address' }],
    data: [{ name: 'until', type: 'uint64' }],
  },
};

/** The deployment's valuation oracle: kind, address, ABI. */
function oracleOf(ctx) {
  const dep = ctx.r.deployment;
  const po = dep.priceOracle || {};
  const real = po.kind === 'real' || Boolean(ctx.r.q.ArkReferenceOracle);
  const profile = ctx.r.manifest.profile;
  if (!real) return { kind: 'mock', address: ctx.r.q.MockPriceOracle || po.address || null };
  const v3 = ctx.qrl.kind === 'qrl' && fs.existsSync(path.join(qrvmBuild(profile), 'ArkReferenceOracle.json'));
  const build = v3 ? qrvmBuild(profile) : qrlBuild(profile);
  return { kind: 'real', address: toHex(ctx.r.q.ArkReferenceOracle || po.address), abi: iface('ArkReferenceOracle', build), build, record: po };
}

/** The hold file the daemon honours (`oracle-report.js --hold-file`, default). */
const holdFileOf = (chain) => path.join(os.tmpdir(), `ark-oracle-report-${chain}.hold`);

/**
 * The reporters of the deployment, attached to `ctx` once: on the harness a
 * feed, on a live chain a background loop. Null where the deployment wires
 * the double. Returns the handle every scenario shares.
 */
async function attachReporters(ctx, { verbose = false, price = PRICE } = {}) {
  if (ctx.oracleReporter) return ctx.oracleReporter;
  const o = oracleOf(ctx);
  if (o.kind !== 'real') return null;
  const live = ctx.qrl.kind === 'qrl';
  const named = ((o.record && o.record.reporters) || []).map(toHex);
  let reporters;
  if (!live) {
    const addrs = named.length ? named : harnessReporterAddresses();
    reporters = addrs.map((a, i) => ({ label: `r${i + 1}`, client: harnessAccount(ctx.qrl, a) }));
  } else {
    reporters = [];
    for (const name of Object.keys(ctx.qrl.env || {}).sort()) {
      const m = name.match(/^ORACLE_REPORTER(\d+)_MNEMONIC$/);
      if (!m || !ctx.qrl.env[name]) continue;
      const client = qrlClient({ name: `oracle-reporter-${m[1]}`, mnemonicKey: name });
      if (named.length && !named.some((a) => same(a, client.address))) continue;
      reporters.push({ label: `r${m[1]}`, client });
    }
  }
  const zero = ctx.r.evmArg(ZERO20);
  const assets = ctx.r.assets.map((a) => {
    const ma = (ctx.r.manifest.assets || []).find((x) => same(x.address, a.asset)) || {};
    return { symbol: a.symbol, asset: ctx.r.evmArg(a.asset), source: ma.source || null, yieldBps: ma.admissionYieldBps || 220 };
  });
  const yieldKeys = [{ label: 'book', chainId: 0n, asset: zero, book: true }, ...assets.map((a) => ({ label: a.symbol, chainId: ctx.r.chainId, asset: a.asset, entry: a }))];
  // The harness posts what the double was set to; a live run what the daemon would (oracle-report.js).
  let lido = null;
  const yieldSource = async (yk) => {
    if (!live) return yk.book ? BOOK_YIELD_BPS : yk.entry.yieldBps;
    const fig = async (a) => (a.source === 'lido' ? (lido = lido || (await market.lidoAprBps())) : a.yieldBps);
    if (!yk.book) return fig(yk.entry);
    const figs = [];
    for (const a of assets) figs.push(await fig(a));
    return Math.round(figs.reduce((x, y) => x + y, 0) / figs.length);
  };
  const priceSource = live
    ? async () => {
      const r = await market.spotStethQrl({ retry5xx: true });
      return { wei: market.toWei(r.spot), line: market.describeSpot(r) };
    }
    : async () => ({ wei: BigInt(price), line: '' });
  const reporter = new OracleReporter({
    reporters,
    oracle: o.address,
    abi: o.abi,
    errors: ctx.r.errors,
    priceKey: { chainId: 0n, asset: zero },
    yieldKeys,
    epochLength: ctx.clock.EPOCH_LENGTH,
    priceSource,
    yieldSource,
    now: async () => (await ctx.qrl.head()).timestamp,
    log: verbose || live ? (l) => ctx.log(`   ${l}`) : () => {},
  });

  const handle = {
    oracle: o,
    reporter,
    live,
    zero,
    labels: reporters.map((r) => r.label),
    pause() {
      reporter.pause();
      ctx.note('the reporters stop posting (paused in this process)');
    },
    resume() {
      reporter.resume();
      ctx.note('the reporters post again');
    },
    view: async (m, args = [], opts = {}) => {
      const res = await ctx.qrl.call(o.address, o.abi, m, args, opts);
      return res.length === 1 ? res[0] : res;
    },
    detach: async () => {},
  };

  if (!live) {
    // A round every five minutes of harness time at most: inside the
    // heartbeat (600 s compressed) whatever τ_o is (60 – 600 s compressed).
    const feed = async () => {
      await reporter.step();
    };
    ctx.feeds.push(feed);
    ctx.feedStep = 300;
    handle.detach = async () => {
      ctx.feeds = ctx.feeds.filter((f) => f !== feed);
    };
  } else {
    if (!reporters.length) throw new ScenarioError('no ORACLE_REPORTER<n>_MNEMONIC in .env names a reporter of the deployed oracle');
    // Hold the external daemon for the scenario's length: one process reports.
    const hold = holdFileOf(ctx.r.chain);
    fs.writeFileSync(hold, `held by e2e ${ctx.name} pid ${process.pid} at ${new Date().toISOString()}\n`);
    let stopping = false;
    const loop = reporter.run({ maxWaitSeconds: 15, stop: () => stopping });
    handle.detach = async () => {
      stopping = true;
      await loop.catch(() => {});
      fs.rmSync(hold, { force: true });
      ctx.note(`the scenario's reporter loop stopped and the hold file ${hold} was removed: the daemon reports again`);
    };
    ctx.note(`reporting in-process with ${reporters.map((r) => r.label).join(', ')}; the daemon is held by ${hold}`);
  }
  ctx.oracleReporter = handle;
  return handle;
}

/** RoundAccepted events of the book's key since `fromBlock`, oldest first: { roundId, observation, updatedAt, clamped }. */
async function acceptedRounds(ctx, o, fromBlock) {
  const head = await ctx.qrl.head();
  const logs = await ctx.qrl.logs(o.address, BigInt(fromBlock), head.latest);
  const evs = ctx.qrl.kind === 'qrl' && ctx.r.qrlIsV3 ? decodeQrlLogs({ RoundAccepted: ORACLE_EVENTS.RoundAccepted }, logs) : parseLogs(o.abi, logs).filter((e) => e.name === 'RoundAccepted');
  return evs
    .filter((e) => BigInt(e.args.chainId) === 0n && /^(0x|Q)0*$/i.test(String(e.args.asset)))
    .map((e) => ({ roundId: BigInt(e.args.roundId), observation: BigInt(e.args.observation), updatedAt: BigInt(e.args.updatedAt), clamped: Boolean(e.args.clamped) }));
}

/**
 * The oracle's `_average(a, b)` recomputed from the accepted rounds: the
 * integral of the observation step function over [a, b), floor-divided by
 * its length, exactly as the cumulative sums give it. Null where the rounds
 * do not reach `a`.
 */
function averageFromRounds(rounds, a, b) {
  a = BigInt(a);
  b = BigInt(b);
  if (b <= a || !rounds.length || rounds[0].updatedAt > a) return null;
  let sum = 0n;
  for (let i = 0; i < rounds.length; i++) {
    const from = rounds[i].updatedAt;
    const to = i + 1 < rounds.length ? rounds[i + 1].updatedAt : b;
    const lo = from > a ? from : a;
    const hi = to < b ? to : b;
    if (hi > lo) sum += rounds[i].observation * (hi - lo);
  }
  return sum / (b - a);
}

/**
 * The breaker as yellow paper §6.1 defines it, at `t`: the 24-hour average
 * 5,000 bps or more below the one ending 24 hours earlier.
 */
function breakerFromRounds(rounds, t, day) {
  const now = averageFromRounds(rounds, BigInt(t) - BigInt(day), t);
  const prev = averageFromRounds(rounds, BigInt(t) - 2n * BigInt(day), BigInt(t) - BigInt(day));
  if (now === null || prev === null || prev === 0n) return { defined: false, now, prev, active: false };
  return { defined: true, now, prev, active: now * 10_000n <= prev * 5_000n };
}

/**
 * Warm the oracle up on the harness: the clock moves, the reporters posting,
 * until the book's series answers (thirty days and twenty-four hours of
 * accepted rounds and a mark: 5.2 – 6.2 h of testnet-profile time). The
 * relayer ticks throughout, as a live one does: while the series is silent
 * the registry carries the premium mark and converts cover at the carried
 * price (yellow paper §6.1, I40; CLAUDE.md item 125), so `allocation()`
 * answers and every epoch of the warm-up gets its root. Before 2026-10-05
 * it reverted and the relayer could not be ticked here.
 */
async function warmUp(ctx, handle) {
  const started = (await ctx.qrl.head()).timestamp;
  const roots0 = Object.keys(ctx.r.state.data.roots).length;
  await ctx.waitFor('the book\'s series answers (warm-up over), the relayer ticking', async () => !(await handle.view('silent', [0n, handle.zero])), { timeoutEpochs: 8 });
  const at = (await ctx.qrl.head()).timestamp;
  const sealed = Object.keys(ctx.r.state.data.roots).length - roots0;
  ctx.check(sealed > 0, 'I40: the relayer seals epoch roots while the series is silent (the warm-up): allocation() carries the mark', { sealed, seconds: at - started });
  ctx.note(`warm-up took ${at - started} s of chain time (${handle.reporter.stats.rounds} rounds, ${handle.reporter.stats.yields} yield reports); the relayer sealed ${sealed} roots meanwhile`);
  return at - started;
}

module.exports = { REPORTER_LABELS, harnessReporterAddresses, oracleOf, attachReporters, acceptedRounds, averageFromRounds, breakerFromRounds, warmUp, holdFileOf, ORACLE_EVENTS };
