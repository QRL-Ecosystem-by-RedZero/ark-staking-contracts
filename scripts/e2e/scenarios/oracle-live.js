/**
 * The production valuation oracle on chain: `ArkReferenceOracle` fed by its
 * reporter quorum (yellow paper §6.1; technical reference §1.4, §3.7;
 * invariants I38, I40, I41; staking CLAUDE.md items 122 and 123).
 *
 * NOT TERMINAL, but it moves the series: the injected rounds (a dispersed
 * report, a step past s_obs) are accepted or cut as the round rule says, the
 * silence and the guardian's pause suspend issuance and pricing while they
 * hold, and on the harness the last part drives the series up into its
 * per-epoch bound and down into the breaker. Run it live only on a testnet.
 *
 *   1  The reporter set, and no price setter (I41): the ABI's state-changing
 *      entries are exactly the round, the yield, governance and the pause; a
 *      stranger's report is refused; governance cannot name an observation.
 *   2  Rounds: a quorum of two reports within d_rep is accepted at their
 *      median; a dispersed report is cut and the round waits for a third; a
 *      step beyond s_obs is clamped to it; latestRound and updatedAt advance
 *      with every accepted round.
 *   3  I38: P30 lies inside B_e (1 ± m_epoch).
 *   4  Silence (I40, yellow paper §4.6, item 123): the reporters stop; after
 *      the heartbeat `observe` and `epochAverage` revert `OracleSilent`, the
 *      registry's `epochPrice` with them, the bond refuses issuance, a premium
 *      quote made before any reserve is fixed is refused and recorded (no
 *      lot, the QRL returned), and `settlementPrice` strikes the carried
 *      price. The offering that refused a quote and sold nothing is carried at
 *      its judgement: `OfferingSuspended`, `failedOfferings` untouched.
 *   5  Resumed: one accepted round and the series answers again.
 *   6  The guardian's pause (only where this run holds the guardian keys):
 *      silent while the pause holds, reports and all; a second pause by the
 *      guardian refused; live again once it lapses.
 *   7  The breaker on the 24-hour average: on the harness driven (rounds at
 *      +s_obs into the bound of item 3, P30 held at B_e (1 + m); then −s_obs
 *      until the 24-hour average is half the one before it); live, its
 *      definition is recomputed from the accepted rounds and compared.
 *   The scenario ends with the invariant checks (oracle-series among them).
 *
 * On the harness (`npm run e2e:local -- --scenario oracle-live`) the leg is
 * deployed with the real oracle (`priceOracle` below), three harness
 * reporters at quorum two, a 60 s round interval (`oracleSettings`: at the
 * reference 120 s and 1,000 bps the compressed profile's 24-hour average falls
 * at most 1 − 0.9^5 ≈ 41% a day, so the breaker could not be driven), and
 * contracts/core's governance stack, whose guardian multisig the deployer
 * owns one of one. Live (`npm run e2e -- --chain hoodi-vps --scenario
 * oracle-live`) the reporters are ORACLE_REPORTER<n>_MNEMONIC of .env, run in
 * this process while the daemon is held by its hold file; the guardian rows
 * need GOV_GUARDIAN<n>_MNEMONIC keys. Wall-clock live: the offering's quote
 * window comes once an epoch (≤ 70 min), the silence one heartbeat (10 min),
 * the pause two epochs (140 min): about 4 – 5 hours.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { ONE, units } = require('../lib');
const { iface, qrlBuild, qrlCodec } = require('../../lib/chains');
const { expectedObservation } = require('../../lib/oracle-reporter');
const O = require('../helpers/oracle');
const S = require('../helpers/swap');
const H = require('../helpers/governance');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const { revertName } = require('../../../ecdsa-stakings/relayer/engine/errors');

const BPS = 10_000n;
const big = (x) => BigInt(x);
/** The state-changing entries the oracle may have: nothing else posts or sets (I41). */
const ALLOWED_WRITES = ['submit', 'submitYield', 'setParamsDiff', 'addReporter', 'removeReporter', 'proposeGovernance', 'acceptGovernance', 'pause'].sort();

module.exports = {
  description: 'ArkReferenceOracle on chain: quorum rounds, the dispersion cut and the step clamp, I38, I41, silence (OracleSilent, issuance refused, a premium quote refused and recorded, the offering carried, the carried settlement price), the guardian pause, and the breaker on the 24-hour average',
  terminal: false,
  // Read by scripts/e2e-local.js: the real oracle, three harness reporters at
  // quorum two, a 60 s round interval so the breaker can be driven.
  priceOracle: 'ArkReferenceOracle',
  oracleSettings: { roundIntervalSeconds: 60 },
  // contracts/core's stack: the timelock governs the oracle and its guardian
  // multisig (the deployer, one of one, on the harness) may pause it.
  governance: {},
  outOfScope: [
    'parameter changes through the timelock (setParamsDiff, add/removeReporter): core\'s ArkGovTables does not yet know the oracle\'s keys (O-10, CLAUDE.md item 122)',
    'the freeze venue list: needs the Q-Day oracle\'s protective freeze (qday.js, governance-qday.js)',
    'the ARK key (0, ARK): no ARK market is admitted; the court reads arkReferencePrice (CLAUDE.md item 121)',
    'live: the breaker is not driven (it would need the market to halve in a day); its definition is recomputed from the accepted rounds',
    'live: the guardian rows need GOV_GUARDIAN<n>_MNEMONIC keys of the deployment\'s guardian multisig',
  ],

  async run(ctx, opts) {
    const o = O.oracleOf(ctx);
    if (o.kind !== 'real') {
      ctx.note(`SKIPPED: this deployment wires ${o.address ? 'MockPriceOracle' : 'no valuation oracle'}, not ArkReferenceOracle (redeploy the QRL leg with ARK_PRICE_ORACLE=ArkReferenceOracle, or run e2e:local --scenario oracle-live)`);
      return;
    }
    const h = await O.attachReporters(ctx, { verbose: opts.verbose });
    try {
      await new OracleRun(ctx, opts, h).go();
    } finally {
      if (h.live) await h.detach();
    }
  },
};

class OracleRun {
  constructor(ctx, opts, h) {
    this.ctx = ctx;
    this.opts = opts;
    this.h = h;
    this.o = h.oracle;
    this.live = h.live;
    this.zero = h.zero;
    this.q = ctx.r.q;
    this.build = qrlBuild(ctx.r.manifest.profile);
    this.E = big(ctx.clock.EPOCH_LENGTH);
  }

  view(m, args = [], opts = {}) {
    return this.h.view(m, args, opts);
  }

  async now() {
    return big((await this.ctx.qrl.head()).timestamp);
  }

  async settings() {
    const s = await this.view('settings');
    const p = (n, i) => (s[n] !== undefined ? s[n] : s[i]);
    return { quorum: Number(p('reporterQuorum', 0)), interval: big(p('roundIntervalSeconds', 1)), heartbeat: big(p('heartbeatSeconds', 2)), maxStepBps: big(p('maxStepBps', 3)), maxDispersionBps: big(p('maxDispersionBps', 4)), pauseMaxEpochs: big(p('pauseMaxEpochs', 6)) };
  }

  async latest() {
    const r = await this.view('latestRound', [0n, this.zero]);
    return { roundId: big(r[0]), updatedAt: big(r[1]), observation: big(r[2]), clamped: Boolean(r[3]) };
  }

  silent() {
    return this.view('silent', [0n, this.zero]);
  }

  /** The revert name of an eth_call, or null where it answers. */
  async outcome(fn) {
    try {
      await fn();
      return null;
    } catch (e) {
      return revertName(this.ctx.r.errors, e);
    }
  }

  /**
   * The chain's clock at `ts`: the reporters posting unless paused, the
   * relayer ticking unless `tick` is false. It ticks through the silent
   * stretches too: the registry carries the premium mark under silence
   * (yellow paper §6.1, I40; CLAUDE.md item 125), so a root seals while the
   * series is silent, and a tick that failed would fail the scenario.
   */
  until(ts, { tick = true } = {}) {
    return S.until(this.ctx, ts, { tick });
  }

  async go() {
    const { ctx } = this;
    this.cfg = await this.settings();
    this.fromBlock = big(ctx.r.deployment.deployedFromBlock || 0);
    ctx.note(`ArkReferenceOracle ${this.o.address.slice(0, 14)}…: quorum ${this.cfg.quorum}, τ_o ${this.cfg.interval} s, heartbeat ${this.cfg.heartbeat} s, s_obs ${this.cfg.maxStepBps} bps, d_rep ${this.cfg.maxDispersionBps} bps; keys held ${this.h.labels.join(', ')}`);
    if (await this.silent()) {
      // Live, the warm-up may not be over: wait for it (thirty days and a day of profile time, and a mark).
      await ctx.waitFor('the book\'s series answers (warm-up over)', async () => !(await this.silent()), { timeoutEpochs: 7 });
    }
    await this.setAndSetters();
    await this.rounds();
    await this.bounded('after the injected rounds');
    await this.silence();
    await this.guardianPause();
    await this.breaker();
    await ctx.invariants('oracle-live');
  }

  /* -------------------------------------------------- 1: the set, I41 */

  async setAndSetters() {
    const { ctx } = this;
    const count = big(await this.view('reporterCount'));
    const held = [];
    for (const r of this.h.reporter.reporters) held.push(Boolean(await this.view('isReporter', [r.client.address])));
    ctx.check(held.every(Boolean) && count >= 3n && count <= 9n && BigInt(this.cfg.quorum) * 2n > count && BigInt(this.cfg.quorum) <= count, 'the reporter set holds 3 – 9 keys and a quorum above half of it; every key this run reports with is in it (technical reference §3.7)', { reporterCount: count, quorum: this.cfg.quorum, held: this.h.labels });

    const writes = this.o.abi.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
    ctx.check(JSON.stringify(writes) === JSON.stringify(ALLOWED_WRITES) && !writes.some((n) => /price|observ|series|twap|setYield|post/i.test(n)),
      'I41: no account posts a price — the oracle\'s only state-changing entries are the round, the yield, governance, the reporter set and the pause; there is no setter of an observation or a series', { writes });
    const stranger = (await ctx.actor('oracle-stranger')).address;
    const latest = await this.latest();
    const venueList = await this.view('venueListInForce');
    await ctx.refuses('I41: an account outside the reporter set cannot report a round', 'NotReporter', () => ctx.qrl.call(this.o.address, this.o.abi, 'submit', [latest.roundId + 1n, 0n, this.zero, latest.observation || ONE, venueList], { from: stranger }));
    const governance = toHex(await this.view('governance'));
    for (const name of ['observation', 'twap30d', 'price']) {
      await ctx.refuses(`I41: governance itself cannot set "${name}": setParamsDiff knows no such key`, 'UnknownParameter', () => ctx.qrl.call(this.o.address, this.o.abi, 'setParamsDiff', [[[keccak256(toUtf8Bytes(name)), 0n, 1n]]], { from: governance }));
    }
  }

  /* -------------------------------------------------- 2: the rounds */

  /** Waits (reporters paused) until the next round is due, then posts `spots` in `sequence` and returns the round. */
  async manual(label, spots, sequence) {
    const { ctx } = this;
    const before = await this.latest();
    await this.until(before.updatedAt + this.cfg.interval);
    const res = await this.h.reporter.stepRound({ spots, sequence });
    const after = await this.latest();
    const sent = (res.sent || []).map((x) => x.split('@')[0]);
    const reports = sent.map((l) => big(spots[l]));
    const want = expectedObservation(reports, { quorum: this.cfg.quorum, maxDispersionBps: this.cfg.maxDispersionBps, maxStepBps: this.cfg.maxStepBps, last: before.observation });
    ctx.note(`${label}: reports ${sent.map((l) => `${l}=${spots[l]}`).join(', ')} -> round ${after.roundId} at ${after.observation}${after.clamped ? ' (clamped)' : ''}`);
    return { before, after, res, sent, reports, want };
  }

  async rounds() {
    const { ctx } = this;
    if (this.h.labels.length < 3) {
      ctx.note(`SKIPPED the injected rounds: this run holds ${this.h.labels.length} reporter key(s); the dispersed round needs three`);
      return;
    }
    const [a, b, c] = this.h.labels;
    this.h.reporter.pause();
    ctx.note('the reporters\' own loop is paused: the next four rounds are posted by hand');
    try {
      const P = (await this.latest()).observation;
      const at = (bps) => (P * big(bps)) / BPS;

      // A: two reports within d_rep — the quorum — accepted at their median.
      const A = await this.manual('A, a quorum', { [a]: P, [b]: at(10_020) }, [a, b]);
      ctx.check(A.want && A.after.roundId === A.before.roundId + 1n && A.after.observation === A.want.observation && !A.after.clamped,
        'a round is accepted at the k_o-th report within d_rep, at the median of those reports (yellow paper §6.1, round steps 1 – 2)', { reports: A.reports, observation: A.after.observation, expected: A.want && A.want.observation });
      ctx.check(A.after.updatedAt > A.before.updatedAt && A.after.updatedAt === await this.now() && A.after.updatedAt >= A.before.updatedAt + this.cfg.interval,
        'latestRound advances: the round id by one, updatedAt to the accepting block, at least τ_o after the round before', { before: A.before, after: A.after });

      // B: a dispersed report first: two reports and no quorum; a third, and the dispersed one is cut.
      const B = await this.manual('B, a dispersed report', { [a]: at(12_000), [b]: P, [c]: at(10_010) }, [a, b, c]);
      ctx.check(B.sent.length === 3 && B.want && B.after.roundId === B.before.roundId + 1n && B.after.observation === B.want.observation && !B.want.kept.includes(at(12_000)),
        'a report more than d_rep from the median is cut: two reports 20% apart form no quorum, a third accepts the round at the median of the two inside d_rep (round step 2)', { reports: B.reports, kept: B.want && B.want.kept, observation: B.after.observation, expected: B.want && B.want.observation });

      // C: a step beyond s_obs is clamped to it.
      const C = await this.manual('C, a step of +50%', { [a]: at(15_000), [b]: at(15_000) }, [a, b]);
      const cap = (C.before.observation * (BPS + this.cfg.maxStepBps)) / BPS;
      ctx.check(C.after.clamped && C.after.observation === cap && C.want && C.want.clamped,
        'a round beyond s_obs of the last accepted observation is accepted at the bound, and recorded as clamped (round step 3)', { median: at(15_000), last: C.before.observation, bound: cap, observation: C.after.observation });

      // D: back to the market; within s_obs of the clamped round, so unclamped.
      const D = await this.manual('D, back to the spot', { [a]: P, [b]: P }, [a, b]);
      ctx.check(D.want && D.after.observation === D.want.observation && D.after.clamped === D.want.clamped && D.after.roundId === C.after.roundId + 1n,
        'the next round returns to the spot, clamped only if that is beyond s_obs of the clamped round', { observation: D.after.observation, expected: D.want && D.want.observation, clamped: D.after.clamped });
      const [series, updatedAt] = await this.view('lastAccepted', [0n, this.zero]);
      ctx.check(big(updatedAt) === D.after.updatedAt && big(series) > 0n, 'lastAccepted carries the bounded series as at the last accepted round, and its time', { twap30d: series, updatedAt });
    } finally {
      this.h.reporter.resume();
    }
  }

  /* -------------------------------------------------- 3: I38 */

  async bounded(when) {
    const { ctx } = this;
    const [, p30] = await this.view('observe', [0n, this.zero]);
    const e = ctx.clock.epochOf(await this.now());
    const B = big(await this.view('boundOf', [0n, this.zero, e]));
    const m = big((await ctx.qrl.call(this.q.ArkStakeParams, ctx.r.abi.params, 'trigger2Params'))[3]);
    const low = (B * (BPS - m)) / BPS;
    const high = (B * (BPS + m)) / BPS;
    ctx.check(B > 0n && big(p30) >= low && big(p30) <= high, `I38: P30 lies inside B_e (1 ± m_epoch), ${when}`, { epoch: e, P30: p30, B_e: B, mEpochBps: m, low, high });
    return { p30: big(p30), B, m, low, high };
  }

  /* -------------------------------------------------- 4, 5: silence */

  /** The offering whose quote window the silence covers: opened here on the harness, the next recorded one live. */
  async offering() {
    const { ctx } = this;
    const a = ctx.asset(this.opts.asset || (ctx.r.assets[0] && ctx.r.assets[0].symbol));
    const k = S.swapKit(ctx, a);
    if (!this.live) {
      const { offerings } = await S.openOfferings(ctx, [a], { notional: units(this.opts.notional, 1000), yieldUnits: units(this.opts.quantity, 40) });
      const t = offerings[0].t;
      // Fresh premium for the next offer (t+1), whose first quote judges t.
      const nowO = await S.nowOn(ctx, 'origin');
      if (a.mock && ctx.clock.epochOf(nowO) === t + 1n && nowO < ctx.clock.offerOpens(t + 1n)) await ctx.produceYield(a, units(this.opts.quantity, 40) / 4n);
      return { a, k, t };
    }
    // Live: the offering of the epoch before this one, if it is recorded and its window is ahead; else the next.
    const hb = this.cfg.heartbeat;
    for (const lag of [1n, 0n]) {
      const t = ctx.clock.epochOf(await this.now()) - lag;
      const T = k.times(t);
      const ok = async () => Boolean((await k.offering(t)).recorded) && (await this.now()) < T.qo - hb - 60n;
      if (await ok()) return { a, k, t };
      if (lag === 0n) {
        const found = await S.waitFine(ctx, `the offering of epoch ${t} recorded on QRL ahead of its quote window`, ok, { timeoutEpochs: 2, throws: false });
        if (found) return { a, k, t };
      }
    }
    return null;
  }

  async silence() {
    const { ctx } = this;
    const off = await this.offering();
    const hb = this.cfg.heartbeat;
    let T = null;
    if (off) {
      T = off.k.times(off.t);
      ctx.note(`offering ${off.t} of ${off.a.symbol}: quote window [${T.qo}, ${T.qc}); the reporters stop at ${T.qo - hb - 1n}, one heartbeat before it opens`);
      await this.until(T.qo - hb - 1n);
    } else {
      ctx.note('SKIPPED the premium refusal: no offering recorded ahead of its quote window within two epochs');
    }
    this.h.pause();
    const last = await this.latest();
    const silentFrom = last.updatedAt + hb + 1n;
    await this.until(off && T.qo + 1n > silentFrom ? T.qo + 1n : silentFrom);
    const now = await this.now();
    ctx.check(now > last.updatedAt + hb && (await this.silent()), 'I40: a key with no accepted round for more than T_hb is silent', { lastRound: last.roundId, updatedAt: last.updatedAt, now, heartbeat: hb });

    await ctx.refuses('I40: observe reverts OracleSilent while the series is silent', 'OracleSilent', () => ctx.qrl.call(this.o.address, this.o.abi, 'observe', [0n, this.zero]));
    const e = ctx.clock.epochOf(now);
    await ctx.refuses('I40: epochAverage reverts OracleSilent while the series is silent', 'OracleSilent', () => ctx.qrl.call(this.o.address, this.o.abi, 'epochAverage', [0n, this.zero, e - 1n]));
    await ctx.refuses('the registry\'s epochPrice (P_{t-1}) reverts with it: there is no price to sell at', 'OracleSilent', () => ctx.registry('epochPrice'));
    const bondAbi = iface('ArkCatBond', this.build);
    let minSub = 1_000n * ONE;
    try {
      minSub = big((await ctx.qrl.call(this.q.ArkCatBond, bondAbi, 'MIN_SUBSCRIPTION'))[0]);
    } catch {
      /* not public */
    }
    await ctx.refuses('the bond refuses issuance while the series is silent (yellow paper §6.1, the table of silence)', 'OracleSilent', () => ctx.qrl.call(this.q.ArkCatBond, bondAbi, 'subscribe', [1, 0], { value: minSub }));
    const R = this.q.ArkStakeRegistry;
    const alloc = (await ctx.qrl.call(R, ctx.r.abi.registry, 'allocation'))[0];
    const mark = await ctx.qrl.call(R, ctx.r.abi.registry, 'premiumMark');
    const share = big(await ctx.registry('premiumShareBps'));
    const [, leaf] = await ctx.qrl.call(R, ctx.r.abi.registry, 'currentAllocationLeaf', [ctx.r.evmArg(ctx.r.assets[0].escrow)]);
    ctx.check(share === big(mark[1]) && big(alloc.premiumBps) === share && /^0x[0-9a-f]{64}$/i.test(String(leaf)),
      'I40: premiumShareBps and allocation() answer while the series is silent, at the carried mark, and the allocation leaf the relayer seals is computable (yellow paper §6.1, the table of silence)', { premiumShareBps: share, premiumMark: mark[1], markEpoch: mark[0], allocationPremium: alloc.premiumBps, coveredBps: alloc.coveredBps });
    const settle = big(await ctx.registry('settlementPrice'));
    const carried = await ctx.qrl.call(this.q.ArkStakeRegistry, ctx.r.abi.registry, 'carriedPrice');
    const dead = big(await ctx.registry('deadOracleOpeningPrice'));
    ctx.check(settle > 0n && settle === dead && settle === big(carried[0]),
      'I40: settlementPrice does not revert while silent and strikes the carried price (deadOracleOpeningPrice, the carried price with no breaker fired)', { settlementPrice: settle, carried: carried[0], carriedEpoch: carried[1], deadOracleOpeningPrice: dead });

    let refusal = null;
    if (off) refusal = await this.refusedQuote(off, T);

    // 5: resumed — one accepted round and the series answers.
    this.h.resume();
    if (!this.live) await this.h.reporter.step();
    await S.waitFine(ctx, 'the series answers again after one accepted round', async () => !(await this.silent()), { timeoutEpochs: 1 });
    const back = await this.latest();
    ctx.check(back.updatedAt > last.updatedAt && !(await this.silent()), 'resumed: the first accepted round after the silence makes the series answer again', { round: back.roundId, updatedAt: back.updatedAt });
    await this.bounded('after the silence');
    if (refusal) await this.carried(off, refusal);
  }

  /** A quote under silence before any reserve is fixed: refused, recorded, the QRL returned. */
  async refusedQuote(off, T) {
    const { ctx } = this;
    const { k, t } = off;
    const now = await this.now();
    if (now >= T.qc) {
      ctx.note('SKIPPED the premium refusal: the quote window closed before the silence held');
      return null;
    }
    const offering = await k.offering(t);
    if (big(offering.reserveNum || 0) !== 0n) {
      ctx.note(`SKIPPED the premium refusal: a quote fixed offering ${t}'s reserve before the silence (it runs to its close at it, §4.6)`);
      return null;
    }
    const failedBefore = await k.failed();
    const avail = await k.available(t);
    const label = 'oracle-silent-solver';
    const client = await S.fund(ctx, label, 10n * ONE + S.GAS_QRL);
    const solver = S.rawSolver(ctx, k, client, '0x' + 'c1'.repeat(20));
    const lot = await solver.judgingLot(t, (avail + 31n) / 32n || 1n);
    ctx.check((await solver.quoteRefusal(lot)) === 'PricingSuspended', 'a quote while the series is silent and no reserve is fixed answers the zero lot id: refused, not reverted (yellow paper §4.6)', { epoch: t, shares: lot.shares });
    const head = (await ctx.qrl.head()).latest;
    const swapBefore = big(await ctx.qrl.balance(k.q.PremiumSwap));
    await solver.recordRefusal(lot);
    const swapAfter = big(await ctx.qrl.balance(k.q.PremiumSwap));
    const evs = await k.swapEvents(head);
    const refused = evs.filter((x) => x.name === 'QuoteRefused' && big(x.args.epoch) === t);
    const quoted = evs.filter((x) => x.name === 'LotQuoted' && String(x.args.lotId).toLowerCase() === String(lot.lotId).toLowerCase());
    ctx.check(refused.length >= 1 && quoted.length === 0 && swapAfter === swapBefore && (await k.status(lot.lotId)) === 'None',
      'the refusal is recorded (QuoteRefused), no lot is stored and every planck sent comes back in the same transaction (item 123)', { refusals: refused.length, lotsQuoted: quoted.length, swapBalanceMoved: swapAfter - swapBefore, lot: lot.lotId });
    return { failedBefore, avail, block: head };
  }

  /** The offering that refused a quote and sold nothing is carried at its judgement, no failure counted. */
  async carried(off, refusal) {
    const { ctx } = this;
    const { k, t } = off;
    const t1 = t + 1n;
    const T1 = k.times(t1);
    const ready = await S.waitFine(ctx, `the offering of epoch ${t1} recorded on QRL`, async () => Boolean((await k.offering(t1)).recorded), { timeoutEpochs: 2, throws: false });
    if (!ready) {
      ctx.note(`SKIPPED the carry: no offering of epoch ${t1} was recorded, so nothing judged ${t}`);
      return;
    }
    await this.until(T1.qo);
    const solver = S.rawSolver(ctx, k, await ctx.actor('oracle-carry-solver'), '0x' + 'c2'.repeat(20));
    const avail1 = await k.available(t1);
    await S.quoteLot(ctx, k, 'oracle-carry-solver', solver, t1, (avail1 + 31n) / 32n);
    // The judgement of t runs at t+1's first quote or at t's selection, whichever comes first.
    const evs = await k.swapEvents(refusal.block);
    const suspended = evs.filter((x) => x.name === 'OfferingSuspended' && big(x.args.epoch) === t);
    const failedAfter = await k.failed();
    ctx.check(suspended.length === 1 && failedAfter === refusal.failedBefore,
      'an offering in whose window a quote was refused and which sold nothing is carried whole at its judgement: OfferingSuspended, and failedOfferings does not move (yellow paper §4.6, item 123)', { epoch: t, suspended: suspended.map((x) => x.args.shares), failedBefore: refusal.failedBefore, failedAfter });
  }

  /* -------------------------------------------------- 6: the guardian's pause */

  async guardianPause() {
    const { ctx } = this;
    const g = toHex(await this.view('guardian'));
    if (/^0x0*$/.test(g)) {
      ctx.note('SKIPPED the guardian pause: the oracle answers no guardian (an account governs it, stage S0, or the guardian was renounced, S3)');
      return;
    }
    const gs = H.stack(ctx);
    if (!gs) {
      ctx.note('SKIPPED the guardian pause: the deployment record names no governance stack to drive the guardian multisig through');
      return;
    }
    const owners = (await gs.call(g, 'ArkMultisig', 'owners')).map(toHex);
    const k = big(await gs.call(g, 'ArkMultisig', 'threshold'));
    const signers = await H.signersFor(ctx, owners, ['oracle-guardian-0', 'gov-guardian-0'], 10n * ONE);
    const GD = H.multisig(gs, g, signers, k);
    if (!GD.able) {
      ctx.note(`SKIPPED the guardian pause: this run holds ${signers.length} of the ${k} guardian keys (GOV_GUARDIAN<n>_MNEMONIC)`);
      return;
    }
    const stranger = (await ctx.actor('oracle-stranger')).address;
    await ctx.refuses('nobody but the guardian pauses the oracle', 'NotGuardian', () => ctx.qrl.call(this.o.address, this.o.abi, 'pause', [], { from: stranger }));
    const payload = ctx.qrl.kind === 'qrl' ? qrlCodec(this.o.abi).encode('pause', []) : this.o.abi.encodeFunctionData('pause', []);
    const t0 = await this.now();
    await GD.run(this.o.address, payload);
    const until = big(await this.view('pausedUntil'));
    const now = await this.now();
    const at = until - this.cfg.pauseMaxEpochs * this.E;
    ctx.check(at >= t0 && at <= now && (await this.silent()), 'the guardian pauses the oracle for pauseMaxEpochs epochs from its block, and the series is silent from that block (yellow paper §6.1)', { pausedUntil: until, pausedAt: at, pauseMaxEpochs: this.cfg.pauseMaxEpochs });
    await ctx.refuses('the guardian cannot renew a pause in force: only the timelock does', 'PauseInForce', () => ctx.qrl.call(this.o.address, this.o.abi, 'pause', [], { from: g }));
    // The reporters go on reporting through the pause; the series stays silent;
    // the relayer ticks and seals through it (I40).
    const roots0 = Object.keys(ctx.r.state.data.roots).length;
    await this.until(now + (until - now) / 2n);
    const mid = await this.latest();
    ctx.check(mid.updatedAt > now && (await this.silent()), 'rounds are still accepted under the pause, and the series stays silent until it lapses', { lastRound: mid.roundId, updatedAt: mid.updatedAt, pausedUntil: until });
    await ctx.refuses('observe reverts OracleSilent under the pause', 'OracleSilent', () => ctx.qrl.call(this.o.address, this.o.abi, 'observe', [0n, this.zero]));
    await this.until(until);
    const sealed = Object.keys(ctx.r.state.data.roots).length - roots0;
    ctx.check(sealed > 0, 'I40: the relayer seals epoch roots through the guardian pause: allocation() carries the mark while the series is silent', { sealed, pausedUntil: until, pauseMaxEpochs: this.cfg.pauseMaxEpochs });
    await S.waitFine(ctx, 'the series answers once the pause lapsed', async () => !(await this.silent()), { timeoutEpochs: 1 });
    ctx.check((await this.now()) >= until && !(await this.silent()), 'once pausedUntil passes the series answers again, with no further act', { pausedUntil: until });
    await this.bounded('after the pause');
  }

  /* -------------------------------------------------- 7: the breaker */

  async breaker() {
    const { ctx } = this;
    const day = big(ctx.clock.day);
    const definition = async (when) => {
      const rounds = await O.acceptedRounds(ctx, this.o, this.fromBlock);
      const t = await this.now();
      const want = O.breakerFromRounds(rounds, t, day);
      const [active, firedAt] = await this.view('breakerActive', [0n, this.zero]);
      ctx.check(want.defined && Boolean(active) === want.active,
        `the breaker is the 24-hour average at or below half the one ending 24 hours earlier, computed from the accepted rounds (yellow paper §6.1), ${when}`, { t, avg24h: want.now, avg24hBefore: want.prev, active, firedAt, rounds: rounds.length });
      return { active: Boolean(active), firedAt: big(firedAt), want };
    };
    await definition('on the series as it stands');
    if (this.live) return;

    // The harness drives it: +s_obs a round into the bound, then −s_obs into the breaker.
    if (this.h.labels.length < 2) return;
    const [a, b] = this.h.labels;
    this.h.reporter.pause();
    try {
      const startEpoch = ctx.clock.epochOf(await this.now());
      let held = null;
      for (let i = 0; i < 60; i++) {
        const L = (await this.latest()).observation;
        await this.manual(`spike ${i + 1}`, { [a]: L * 2n, [b]: L * 2n }, [a, b]);
        const e = ctx.clock.epochOf(await this.now());
        const B = big(await this.view('boundOf', [0n, this.zero, e]));
        const m = big((await ctx.qrl.call(this.q.ArkStakeParams, ctx.r.abi.params, 'trigger2Params'))[3]);
        const [, p30] = await this.view('observe', [0n, this.zero]);
        if (big(p30) === (B * (BPS + m)) / BPS) {
          held = { round: i + 1, epoch: e, startEpoch, P30: big(p30), B_e: B, mEpochBps: m, spot: (await this.latest()).observation };
          break;
        }
      }
      ctx.check(Boolean(held), 'I38 binds: a series driven up s_obs a round is held at B_e (1 + m_epoch) however far the thirty-day average runs above it', held || {});
      let fired = null;
      for (let i = 0; i < 80; i++) {
        const L = (await this.latest()).observation;
        await this.manual(`crash ${i + 1}`, { [a]: L / 2n, [b]: L / 2n }, [a, b]);
        const [active] = await this.view('breakerActive', [0n, this.zero]);
        if (active) {
          fired = i + 1;
          break;
        }
      }
      const d = await definition(`after ${fired} rounds at −s_obs`);
      ctx.check(fired !== null && d.active && d.firedAt === (await this.latest()).updatedAt && (await ctx.registry('breakerActive')),
        'driven down s_obs a round, the breaker fires at the first accepted round at which the 24-hour average is half the one before it, and the registry reads it from the oracle', { rounds: fired, firedAt: d.firedAt });
      const settle = big(await ctx.registry('settlementPrice'));
      const carried = big((await ctx.qrl.call(this.q.ArkStakeRegistry, ctx.r.abi.registry, 'carriedPrice'))[0]);
      ctx.check(settle > 0n && (carried === 0n || settle <= carried), 'under the breaker settlementPrice stays at or below the carried price, between the emergency floor and it (whitepaper §5.5)', { settlementPrice: settle, carried });
      await this.bounded('under the breaker');
    } finally {
      this.h.reporter.resume();
    }
  }
}

