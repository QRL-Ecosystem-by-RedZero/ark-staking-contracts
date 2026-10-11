/**
 * The product's court on chain, every path a case can take: the optimistic
 * path, the jury, the appeal, the terminal step through ArkGovernor and its
 * retrial, the undrawable panel, and the settlement of every seat. Audit round
 * OC of 2026-10-03, docs/review/audit-2026-10-03/COURT/REPORT.md, rows S0–S7
 * and the invariant probes P-I24a/b/c, P-S1, P-S2, P-S3, P-C, P-D, P-G13, P-G.
 *
 * Run live first, fixed after: a rule an open finding says the code breaks is
 * asserted as the specification states it and recorded with `knownIssue`
 * (OC-COURT-01, -02, -03, -08), so a live run reproduces it and carries on.
 *
 * The cases, all asserted at once (t0) on one anchored position:
 *   dust  a loss of 1 wei by an account that is not the beneficiary (OC-COURT-02): refused at the assertion
 *   K     a loss above the occurrence limit K, unchallenged, while K grows (S1, S6, OC-COURT-01)
 *   A     challenged; round 1 upholds 4–3, the challenger appeals, round 2 rejects, the asserter
 *         escalates, veARK orders a retrial, the retrial rejects: 49 seats (S2, S3, S4, P-I24c, P-G13)
 *   B     challenged; round 1 upholds, nobody appeals: 7 seats (S2, S5)
 *   C     challenged; round 1 rejects, the asserter appeals, round 2 upholds: 21 seats (S3, P-I24c)
 *   S7    challenged while fewer than seven jurors are eligible: unseatable, lapsed, refunded (S7)
 *   E     a recovery, challenged and never armed: lapseDraw cannot close it (OC-COURT-08), then a jury
 * Forty-nine juror accounts are staked right after S7's draw is armed, so they
 * sit in every later draw and in none of S7's. The deployer stakes the capacity
 * the seven cases reserve. All are derived actors (`ctx.actor`), funded from
 * the deployer: a live QRL client signs only from its own key.
 *
 * Expected wall-clock (court day / epoch: rapid 60 s / 7 min, testnet 600 s / 70 min):
 *   setup — ~52 actors funded in QRL and ARK from the one deployer key, about
 *     two blocks each (~20 min either profile), then one epoch boundary for the
 *     capacity stake (<= 7 / 70 min);
 *   t0 -> evidence end 10 court days (10 / 100 min), then the juror stake's
 *     boundary (<= 7 / 70 min);
 *   A: three draws of 9 blocks, three commit/reveal rounds, the 5-day
 *     governance vote (COURT_PERIOD, 50 min in both: governance is vendored at
 *     testnet) — ~70 / ~150 min;
 *   S7's lapse 4 epochs after its arm (28 / 280 min) and E's jury after it
 *     (~6 / ~55 min); S5's unbonding 21 court days (21 / 210 min), in parallel.
 *   Total ~2 h rapid, ~8.5 h testnet. Where ArkGovernor does not yet name this
 *   court, `setCourt` runs through the timelock's 30 days (300 min at the
 *   testnet governance profile) from setup, which bounds the rapid run at ~5.5 h.
 * The harness runs it in minutes: its clock moves, and a block passes per 12 s.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { ONE, BPS, ScenarioError, units } = require('../lib');
const { iface, qrlBuild } = require('../../lib/chains');
const { governanceBuild } = require('../../lib/governance');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const { revertName } = require('../../../ecdsa-stakings/relayer/engine/errors');
const H = require('../helpers/court');
const { sweep, whenOf, span, STAGE: SWEEP_STAGE } = require('../../lib/court-sweep');

const LOSS = 1;
const CENSORSHIP = 2;
const RECOVERY = 4;
const UPHOLD = 1;
const REJECT = 2;
const ST = { CHALLENGE: 1, ROUNDS: 2, ESCALATED: 3, DECIDED: 4, FINAL: 5 };
/** The retrial's forty-nine: 7 + 14 + 28 distinct jurors (yellow paper §4.5). */
const JURORS = 49;
/** Seats each juror stakes for: A, B and C may seat one juror at once. */
const STAKE_SEATS = 3n;
/** P-G: the harness block's gas limit; assumed for a live block too. */
const BLOCK_GAS_LIMIT = 30_000_000n;
const POOL_SIZE_MAX = 256n;
const GAS_FUND = 10n * ONE;

const n = (x) => Number(x);
const big = (x) => BigInt(x);
const min = (a, b) => (a < b ? a : b);
const fill = (k, v) => Array(Math.max(0, k)).fill(v);
const verdictName = (v) => (v === UPHOLD ? 'uphold' : 'reject');

/** Votes in panel order of the jurors this run holds keys for; 'silent' commits and never reveals. */
const PLANS = {
  // 4–3, the purchased verdict an appeal overturns (I24's premise).
  A: { 1: (k) => [...fill(Math.floor(k / 2) + 1, UPHOLD), ...fill(k - Math.floor(k / 2) - 1, REJECT)], 2: (k) => [UPHOLD, ...fill(k - 1, REJECT)], 3: (k) => ['silent', ...fill(k - 1, REJECT)] },
  B: { 1: (k) => [REJECT, ...fill(k - 1, UPHOLD)] },
  C: { 1: (k) => [...fill(Math.min(2, k - 1), UPHOLD), ...fill(k - Math.min(2, k - 1), REJECT)], 2: (k) => [REJECT, ...fill(k - 1, UPHOLD)] },
  E: { 1: (k) => fill(k, REJECT) },
};

module.exports = {
  description: 'the court on chain: an optimistic loss, three juries (7, 21 and 49 seats) through appeal and a governance retrial, an unseatable panel lapsed, every seat settled; OC-COURT-01/02/03/08 recorded where they reproduce',
  // Read by scripts/e2e-local.js: contracts/core's governance stack, so the
  // court's terminal step answers to ArkGovernor (S4). The defaults: the
  // deployer owns the proposer multisig one of one, which schedules setCourt.
  governance: {},
  outOfScope: [
    'OC-COURT-04 (a proposer grinding the draw block\'s hash): the team runs the devnet validators',
    'OC-COURT-05 (a recovery heard at V = 0 with no bound): needs a declaration; qday.js asserts a recovery unchallenged',
    'OC-COURT-06 (256 minimum stakes fill the juror list): 2.56M ARK and 256 accounts',
    'OC-COURT-07 (bufferForfeits and unallocatedSlash have no exit): read here as balances (P-S2, P-S3), not routed',
    'OC-COURT-09 (an unappealed bribed 4–3): B is 6–1; the slash a 4–3 pays its majority is read in A and C only after the overturn',
    'censorship and severity findings: quoted for their value slices (S6), not asserted — the ground needs a held transit, the severity a held declaration',
    'P-G on ZVM v3 is extrapolated linearly from this pool to 256 jurors against an assumed 30M block gas limit',
  ],
  async run(ctx, opts) {
    await new CourtRun(ctx, opts, module.exports.outOfScope).go();
  },
};

class CourtRun {
  constructor(ctx, opts, outOfScope) {
    this.ctx = ctx;
    this.opts = opts;
    this.outOfScope = outOfScope;
    this.cases = [];
    this.jurors = new Map();
    this.gas = { draw: [], finalize: [] };
    this.nonce = ctx.started.toISOString();
    this.refused = new Set();
  }

  /* ------------------------------------------------------------ reads */

  async now() {
    return (await this.ctx.qrl.head()).timestamp;
  }

  async block() {
    return (await this.ctx.qrl.head()).latest;
  }

  c(m, args = []) {
    return H.view(this.ctx.qrl, this.at.court, this.abi.court, m, args);
  }

  p(m, args = []) {
    return H.view(this.ctx.qrl, this.at.pool, this.abi.pool, m, args);
  }

  fi(m, args = []) {
    return H.view(this.ctx.qrl, this.at.findings, this.abi.findings, m, args);
  }

  ark(m, args = []) {
    return H.view(this.ctx.qrl, this.at.ark, this.abi.ark, m, args);
  }

  caseOf(id) {
    return this.c('caseOf', [id]);
  }

  roundOf(id, round) {
    return this.c('roundOf', [id, round]);
  }

  async jurorOf(a) {
    const j = await this.p('jurorOf', [a]);
    return { active: big(j.active), pending: big(j.pending), pendingEpoch: big(j.pendingEpoch), held: big(j.held), unbonding: big(j.unbonding), unbondAt: big(j.unbondAt), reward: big(j.reward) };
  }

  async quote(kind, payload) {
    const q = await this.fi('quote', [kind, payload]);
    return { value: big(q.value), valueArk: big(q.valueArk), seat: big(q.seat), deposit: big(q.deposit), slices: big(q.slices) };
  }

  lossPayload(id, units) {
    return this.ctx.encodeQrl(['bytes32[]', 'uint256[]'], [[id], [units]]);
  }

  async poolFree() {
    return big(await this.p('armedUntil')) === 0n;
  }

  /** Every panel member of a case, rounds 1..`rounds`, with its round. */
  async panel(id, rounds) {
    const out = [];
    for (let r = 1; r <= rounds; r++) for (const a of await this.p('panelOf', [id, r])) out.push({ addr: H.norm(a), round: r });
    return out;
  }

  /** A refusal asserted once per rule, against live state, without mining. */
  async refusesOnce(rule, name, fn) {
    if (this.refused.has(rule)) return;
    this.refused.add(rule);
    await this.ctx.refuses(rule, name, fn);
  }

  /* ------------------------------------------------------------ setup */

  async go() {
    const ctx = this.ctx;
    const q = ctx.r.q;
    if (!q.ArkStakeCourt || !q.ArkJurorPool) throw new ScenarioError('this deployment has no ArkStakeCourt (ARK_COURT=mock)');
    const build = qrlBuild(ctx.r.manifest.profile);
    this.abi = { court: ctx.courtAbi, pool: iface('ArkJurorPool', build), findings: iface('ArkCourtFindings', build), ark: iface('ArkToken', build), bond: iface('ArkCatBond', build) };
    this.at = { court: q.ArkStakeCourt, pool: q.ArkJurorPool, findings: q.ArkCourtFindings || toHex(await ctx.court('FINDINGS')), ark: q.ArkToken || q.ArkTokenDouble, bond: q.ArkCatBond };
    const k = {};
    for (const name of ['COURT_DAY', 'DRAW_LOOKAHEAD', 'BLOCKHASH_REACH', 'DRAW_WINDOW', 'MAX_DRAW_LAPSES', 'ESCALATION_LAPSE', 'JUROR_FEE', 'MIN_STAKE']) k[name] = big(await this.c(name));
    // The deposit base lives on the findings module, in origin units (yellow paper §5.1, 2026-10-06).
    k.DEPOSIT_BASE_ORIG = big(await this.fi('DEPOSIT_BASE_ORIG'));
    this.k = k;
    this.step = min(big(ctx.pollSeconds), k.COURT_DAY / 4n);
    const cp = await ctx.qrl.call(q.ArkStakeParams, ctx.r.abi.params, 'courtParams');
    this.cover = big(cp[0]);
    this.slash = big(cp[1]);
    this.seat = big(await this.fi('seatNow'));
    this.cut = (this.seat * this.slash) / BPS;
    ctx.note(`court: day ${k.COURT_DAY} s, draw window ${k.DRAW_WINDOW} s, lookahead ${k.DRAW_LOOKAHEAD}, reach ${k.BLOCKHASH_REACH}; seat ${this.seat / ONE} ARK, κ ${this.cover}, slash ${this.slash}; step ${this.step} s`);

    // Actors: the asserter, the challenger, the griefer of OC-COURT-02, and the jurors.
    // The position's bound beneficiary, the deployer, asserts its losses: an
    // outsider posts the deposit of V_max and holds one loss open at a time
    // (OC-COURT-02), and this run holds five at once.
    this.asserter = ctx.qrl;
    this.challenger = await ctx.actor('court-challenger');
    this.griefer = await ctx.actor('court-griefer');
    this.jurorActors = await ctx.actors('court-juror', JURORS, { fund: GAS_FUND });
    this.jurors.set(H.norm(ctx.qrl.address), ctx.qrl);
    for (const j of this.jurorActors) this.jurors.set(H.norm(j.address), j);
    await this.recoverUnbonded();

    await this.wireGovernance();

    /* -------------------------------------------- the position and the book */
    const a = ctx.asset(this.opts.asset);
    this.a = a;
    await ctx.seedIfNeeded(a);
    this.notional = units(this.opts.notional, 100);
    this.p1 = await ctx.anchor(a, this.notional);
    await ctx.waitAnchorRecorded(this.p1.id);

    // Every case this run asserts has an index above this one (OC-OPS-26).
    this.caseBase = big(await this.c('caseCount'));
    this.sweepFrom = await this.block();
    try {
      await this.boundaryS6();
      await this.openCases();
      await this.loop();
      await this.closeOut();
    } catch (e) {
      await this.sweepOnFailure(e);
      throw e;
    }
  }

  /**
   * OC-OPS-26: a run that fails midway leaves its cases open, and each open
   * loss holds a determination on the bond, which refuses issuance while any
   * is open. Best effort, once, without waiting: every step
   * scripts/lib/court-sweep.js finds possible now for the cases this run
   * opened is sent, and the rest are logged with the time they become
   * possible, for `npm run court:sweep -- --chain <name> --execute`.
   */
  async sweepOnFailure(failure) {
    const ctx = this.ctx;
    if (this.caseBase === undefined) return;
    try {
      const payloads = new Map(this.cases.map((cs) => [cs.id, cs.payload]));
      const errors = ctx.r.errors;
      const { before, after, results } = await sweep({
        client: ctx.qrl,
        at: { court: this.at.court, bond: this.at.bond },
        abi: { court: this.abi.court, bond: this.abi.bond },
        errors,
        execute: true,
        fromIndex: this.caseBase + 1n,
        fromBlock: this.sweepFrom,
        payloads,
        log: (m) => ctx.note(`sweep: ${m}`),
      });
      const open = before.cases.filter((x) => x.stage !== SWEEP_STAGE.FINAL);
      if (!open.length) return;
      ctx.note(`sweep after the failure (${String(failure.message).slice(0, 80)}): ${open.length} open case(s) of this run; ${results.filter((r) => r.ok).length} step(s) sent, ${results.filter((r) => !r.ok).length} refused`);
      for (const x of after.cases.filter((y) => y.stage !== SWEEP_STAGE.FINAL)) {
        const when = whenOf(x.plan, after.now, after.block, after.spb);
        ctx.note(`sweep: still open ${x.id.slice(0, 12)}… (${x.plan.step || 'no step'}${x.plan.blocked ? `, ${x.plan.blocked}` : ''}) ${when === null ? 'not closable by the sweep' : span(when - after.now)}`);
      }
      const closed = before.cases.filter((x) => x.stage !== SWEEP_STAGE.FINAL && after.cases.find((y) => y.id === x.id && y.stage === SWEEP_STAGE.FINAL));
      ctx.note(`sweep: closed ${closed.length} case(s) (${closed.map((x) => x.id.slice(0, 12)).join(', ') || 'none'}); bond determinationsOpen ${before.bond.determinationsOpen} -> ${after.bond.determinationsOpen}${after.cases.some((y) => y.stage !== SWEEP_STAGE.FINAL) ? '; the rest: npm run court:sweep -- --chain <name> --execute once possible' : ''}`);
    } catch (e) {
      ctx.note(`sweep after the failure did not complete: ${String(e.message).slice(0, 160)}`);
    }
  }

  /** Jurors of an earlier run unbonded at its close: their ARK back, if the period has run. */
  async recoverUnbonded() {
    const now = await this.now();
    const tasks = [];
    for (const j of this.jurorActors) {
      const r = await this.jurorOf(j.address);
      if (r.unbonding === 0n || r.unbondAt > now) continue;
      tasks.push(async () => {
        try {
          await j.send(this.at.pool, this.abi.pool, 'withdraw');
        } catch (e) {
          this.ctx.note(`a juror's earlier unbonding is not withdrawable yet: ${String(e.message).slice(0, 80)}`);
        }
      });
    }
    if (tasks.length) {
      await H.all(this.ctx, tasks);
      this.ctx.note(`${tasks.length} juror(s) withdrew a previous run's unbonded ARK`);
    }
  }

  /**
   * S4's precondition: ArkGovernor names this court and the court names the
   * governor. Where the governor names none yet, the proposer multisig (the
   * deployer, one of one, on the harness) schedules `setCourt` through the
   * timelock, executed once its delay has run.
   */
  async wireGovernance() {
    const ctx = this.ctx;
    const governor = toHex(await ctx.court('GOVERNOR'));
    const gov = ctx.r.deployment.governance;
    this.govPath = 'lapse';
    if (gov && gov.addresses && H.same(governor, gov.addresses.ArkGovernor)) {
      const G = Object.fromEntries(Object.entries(gov.addresses).map(([k, v]) => [k, toHex(v)]));
      const build = governanceBuild({ client: ctx.qrl, profileName: ctx.r.manifest.profile });
      this.G = G;
      this.gabi = (name) => iface(name, build);
      this.gcall = async (to, name, m, args = []) => (await ctx.qrl.call(to, this.gabi(name), m, args))[0];
      this.gsend = (to, name, m, args = [], o = {}) => ctx.qrl.send(to, this.gabi(name), m, args, o);
      this.COURT_PERIOD = big(await this.gcall(G.ArkGovernor, 'ArkGovernor', 'COURT_PERIOD'));
      const named = await this.gcall(G.ArkGovernor, 'ArkGovernor', 'court');
      if (H.same(named, this.at.court)) {
        this.govPath = 'governor';
        this.courtWired = true;
      } else if (H.isZero(named)) {
        const owners = (await this.gcall(G.ProposerMultisig, 'ArkMultisig', 'owners')).map(H.norm);
        const threshold = big(await this.gcall(G.ProposerMultisig, 'ArkMultisig', 'threshold'));
        if (threshold === 1n && owners.includes(H.norm(ctx.qrl.address))) {
          const inner = H.encode(ctx.qrl, this.gabi('ArkGovernor'), 'setCourt', [this.at.court]);
          const sched = H.encode(ctx.qrl, this.gabi('ArkTimelock'), 'schedule', [G.ArkGovernor, inner]);
          const txId = await this.gcall(G.ProposerMultisig, 'ArkMultisig', 'txCount');
          await this.gsend(G.ProposerMultisig, 'ArkMultisig', 'submit', [G.ArkTimelock, 0n, sched]);
          const receipt = await this.gsend(G.ProposerMultisig, 'ArkMultisig', 'execute', [txId]);
          this.setCourtOp = H.scheduled(ctx.qrl, this.gabi('ArkTimelock'), receipt.logs);
          if (!this.setCourtOp) throw new ScenarioError('the multisig executed and the timelock scheduled nothing');
          ctx.note(`ArkGovernor.setCourt(court) scheduled through the timelock, executable from ${this.setCourtOp.eta} (in ${this.setCourtOp.eta - (await this.now())} s)`);
          this.govPath = 'governor';
          this.courtWired = false;
        } else {
          this.outOfScope.push('S4 through ArkGovernor: the governor names no court and the deployer cannot schedule setCourt (not a one-of-one proposer owner); the escalation is closed at its lapse instead');
        }
      } else {
        this.outOfScope.push(`S4 through ArkGovernor: the governor names another court (${named}); the escalation is closed at its lapse instead`);
      }
      if (this.govPath === 'governor') await this.lockVeArk();
    } else if (H.same(governor, ctx.qrl.address)) {
      // A deployment without governance: the deployer answers the terminal step.
      this.govPath = 'direct';
      this.outOfScope.push('S4\'s veARK vote: this deployment has no governor, so the deployer resolves the escalation (scripts/lib/deploy.js)');
    }
    ctx.note(`S4 path: ${this.govPath}`);
  }

  /** veARK weight for the deployer, a quarter of the total at least, so its vote carries the 10% quorum and 66% approval. */
  async lockVeArk() {
    const ctx = this.ctx;
    const G = this.G;
    const lock = await H.view(ctx.qrl, G.VeArk, this.gabi('VeArk'), 'lockOf', [ctx.qrl.address]);
    if (big(lock.amount ?? lock[0] ?? 0n) > 0n) {
      ctx.note('the deployer holds a veARK lock already');
      return;
    }
    const total = big(await this.gcall(G.VeArk, 'VeArk', 'totalWeight'));
    const amount = total / 3n > 100_000n * ONE ? total / 3n : 100_000n * ONE;
    const unlock = (await this.now()) + 30n * big(ctx.clock.EPOCH_LENGTH);
    await this.gsend(G.ArkToken, 'ArkToken', 'approve', [G.VeArk, amount]);
    await this.gsend(G.VeArk, 'VeArk', 'createLock', [amount, unlock]);
    ctx.note(`the deployer locked ${amount / ONE} ARK in veARK to vote the escalation`);
  }

  /**
   * S6: a loss is refused above the bound on the seat in force and heard up
   * to it. A loss is capped at the occurrence limit K before it is valued, so
   * on a book whose K is worth less than the bound no loss is refused at all.
   */
  async boundaryS6() {
    const ctx = this.ctx;
    const bound = big(await this.fi('boundOf', [this.seat, this.slash, this.cover]));
    const K = big(await ctx.registry('requiredCapital'));
    this.boundArk = bound;
    const tryQuote = async (units) => {
      try {
        return await this.quote(LOSS, this.lossPayload(this.p1.id, units));
      } catch (e) {
        return { error: revertName(ctx.r.errors, e) };
      }
    };
    ctx.note(`S6: bound ${bound / ONE} ARK on the seat ${this.seat / ONE} ARK (κ ${this.cover}, slash ${this.slash}); K ${K} units`);
    const atK = await tryQuote(K);
    if (!atK.error) {
      const above = await tryQuote(K * 1000n);
      ctx.check(!above.error && above.value === atK.value && atK.valueArk <= bound, 'a loss asserted above K is valued at K (PV-07) and, at K, within the bound on the seat in force: it is heard, not refused (I24′)', { K, valueAtK: atK.value, valueArk: atK.valueArk, bound, aboveK: above.error || above.value });
      this.kLoss = K * 1000n;
      ctx.note('S6: on this book K is worth less than the bound, so ClaimAboveBound is unreachable for a loss (the boundary is quoted, not crossed)');
    } else if (String(atK.error).includes('LossBelowFloor')) {
      // Since OC-COURT-02 a loss below the deposit base is not heard at all;
      // since 2026-10-06 the base is in origin units (DEPOSIT_BASE_ORIG,
      // yellow paper §5.1), compared with the loss capped at K. On a book
      // whose K is below it the refusal is the fix working, and the loss
      // path needs a larger book.
      const floor = this.k.DEPOSIT_BASE_ORIG;
      ctx.check(K < floor, 'a loss below DEPOSIT_BASE_ORIG is refused, even at K (OC-COURT-02)', { K, floor, error: atK.error });
      throw new ScenarioError(`the book's K (${K} units) is below DEPOSIT_BASE_ORIG (${floor} units), so no loss on it can be heard: rerun with a larger --notional`);
    } else {
      ctx.check(String(atK.error).includes('ClaimAboveBound'), 'a loss at K is refused only for its bound', { error: atK.error });
      let lo = 0n;
      let hi = K;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if ((await tryQuote(mid)).error) hi = mid;
        else lo = mid;
      }
      const at = await tryQuote(lo);
      ctx.check(!at.error && at.valueArk <= bound, 'a loss whose value in ARK is just within the bound is heard as one case (I24′)', { units: lo, valueArk: at.valueArk, bound });
      await ctx.refuses('a loss whose value in ARK is just above the bound on the seat is refused, to be split by position', 'ClaimAboveBound', () =>
        this.ctx.qrl.call(this.at.findings, this.abi.findings, 'quote', [LOSS, this.lossPayload(this.p1.id, hi)]),
      );
      this.kLoss = lo;
      this.outOfScope.push('OC-COURT-01 on this book: K is worth more than the bound, so a loss above K is refused and its draw cannot outgrow V that way');
    }
    // The single facts slice instead (EC-04): quoted, at most sixteen slices.
    try {
      const cq = await this.quote(CENSORSHIP, this.ctx.encodeQrl(['uint256'], [0n]));
      ctx.check(cq.slices >= 1n && cq.slices <= 16n, 'a censorship finding above the bound is heard in at most sixteen value slices at the seat in force (EC-04)', { value: cq.value, valueArk: cq.valueArk, slices: cq.slices });
    } catch (e) {
      ctx.note(`S6: the censorship ground quotes no value here (${String(e.shortMessage || e.message).slice(0, 80)})`);
    }
  }

  /* ------------------------------------------------------------ t0 */

  async openCases() {
    const ctx = this.ctx;
    const p1 = this.p1.id;
    const successor = '0x' + 'e8'.repeat(32);
    const specs = {
      K: { kind: LOSS, payload: this.lossPayload(p1, this.kLoss), asserter: this.asserter, unchallenged: true },
      A: { kind: LOSS, payload: this.lossPayload(p1, ONE), plan: PLANS.A, after: { 1: 'appeal', 2: 'escalate' }, expect: REJECT },
      B: { kind: LOSS, payload: this.lossPayload(p1, ONE), plan: PLANS.B, after: {}, expect: UPHOLD },
      C: { kind: LOSS, payload: this.lossPayload(p1, ONE), plan: PLANS.C, after: { 1: 'appeal' }, expect: UPHOLD },
      S7: { kind: LOSS, payload: this.lossPayload(p1, ONE), lapse: true, expect: REJECT },
      E: { kind: RECOVERY, payload: ctx.encodeQrl(['uint256', 'bytes32', 'address', 'uint256', 'uint256'], [ctx.r.chainId, successor, ctx.r.evmArg(this.a.escrow), 0n, 0n]), plan: PLANS.E, after: {}, expect: REJECT, probe08: true },
    };
    for (const [key, s] of Object.entries(specs)) Object.assign(s, { key, asserter: s.asserter || this.asserter, quote: await this.quote(s.kind, s.payload) });

    // The capacity seven cases reserve, staked by the deployer (S0 for one account).
    const reserve = Object.values(specs).reduce((t, s) => t + 7n * s.quote.seat * s.quote.slices, 0n);
    const open = big(await this.c('openSeatStake'));
    const pool = big(await this.p('poolStake'));
    const need = open + reserve;
    if (need > pool) {
      const me = await this.jurorOf(this.ctx.qrl.address);
      let amount = need - pool;
      if (me.active + me.pending + amount < this.k.MIN_STAKE) amount = this.k.MIN_STAKE;
      const have = big(await this.ark('balanceOf', [ctx.qrl.address]));
      if (have < amount + STAKE_SEATS * this.seat * BigInt(JURORS)) throw new ScenarioError(`the deployer holds ${have / ONE} ARK; the run stakes ${(amount + STAKE_SEATS * this.seat * BigInt(JURORS)) / ONE}`);
      await ctx.qrl.send(this.at.ark, this.abi.ark, 'approve', [this.at.pool, amount]);
      const r = await ctx.qrl.send(this.at.pool, this.abi.pool, 'stake', [amount]);
      const staked = H.decode(ctx, r).find((e) => e.name === 'Staked');
      ctx.check(staked && staked.args.amount === amount && staked.args.activeFromEpoch === (await ctx.originEpoch()) + 1n, 'S0: stake joins the draw at the next epoch boundary, not before (QL-01)', { amount, staked: staked && staked.args });
      await ctx.waitFor('the capacity stake in the pool', async () => big(await this.p('poolStake')) >= need, { timeoutEpochs: 2 });
    }

    // S7 needs fewer than seven eligible at its arm; a pool left full by an earlier run cannot give it.
    const eligible = big(await this.p('eligibleCount', [this.seat]));
    if (eligible >= 7n) {
      delete specs.S7;
      this.outOfScope.push(`S7: the pool seats ${eligible} jurors already (an earlier run's stake), so no panel is unseatable`);
    }

    // QRL for the deposits each side posts: D each, the appeal 2D, the escalation 4D.
    const D = (key) => (specs[key] ? specs[key].quote.deposit * specs[key].quote.slices : 0n);
    // Plus 4 D_1 each: the refusals read with eth_call carry the bond the winner would post.
    await ctx.actor('court-challenger', { fund: D('A') + D('B') + D('C') + D('S7') + D('E') + 2n * D('A') + 4n * D('A') + GAS_FUND });
    await ctx.actor('court-griefer', { fund: GAS_FUND });

    this.t0 = await this.now();
    // The dust first, against a book with no determination of its own open (OC-COURT-02).
    await this.probeDust(p1);
    for (const key of ['K', 'A', 'B', 'C', 'S7', 'E']) if (specs[key]) this.cases.push(await this.assertCase(specs[key]));
    for (const cs of this.cases.filter((x) => !x.unchallenged)) {
      const r = await this.challenger.send(this.at.court, this.abi.court, 'challenge', [cs.id], { value: cs.deposit });
      const ev = H.decode(ctx, r).find((e) => e.name === 'Challenged');
      ctx.check(ev && ev.args.deposit === cs.deposit, 'a challenge posts the same deposit as the assertion, inside its window (whitepaper §6.2)', { case: cs.key, deposit: cs.deposit });
    }
    await this.refusesOnce('a second challenge of a challenged case', 'InvalidCaseState', () =>
      this.challenger.call(this.at.court, this.abi.court, 'challenge', [this.get('A').id], { value: this.get('A').deposit }),
    );
    await this.probes('t0');

    // The book grows before K is finalized (OC-COURT-01): a second position.
    const kBefore = big(await ctx.registry('requiredCapital'));
    this.p2 = await ctx.anchor(this.a, this.notional * 2n);
    await ctx.waitAnchorRecorded(this.p2.id);
    this.get('K').kOpen = kBefore;
    this.get('K').kGrown = big(await ctx.registry('requiredCapital'));
    ctx.note(`K grew from ${kBefore} to ${this.get('K').kGrown} units while the K case was open`);
  }

  get(key) {
    return this.cases.find((c) => c.key === key);
  }

  /** An assertion, with P-I24a, P-C and P-D at its opening. */
  async assertCase(s) {
    const ctx = this.ctx;
    const before = { open: big(await this.c('openSeatStake')), pool: big(await this.p('poolStake')), det: big((await H.view(ctx.qrl, this.at.bond, this.abi.bond, 'state')).determinationsOpen) };
    const q = s.quote;
    const r = await s.asserter.send(this.at.court, this.abi.court, 'assertFinding', [s.kind, s.payload, keccak256(toUtf8Bytes(`court-live:${s.key}`))], { value: q.deposit * q.slices });
    const count = big(await this.c('caseCount'));
    const id = String(await this.c('caseAt', [count - q.slices + 1n])).toLowerCase();
    const c = await this.caseOf(id);
    const ev = H.decode(ctx, r);
    const cs = { ...s, id, deposit: big(c.deposit), value: big(c.value), seatStake: big(c.seat), votes: {}, done: false, acted: new Set(), committed: new Set(), revealed: new Set(), drawTried: new Set(), finalizeTries: 0, receipts: {} };
    const bound = big(await this.fi('boundOf', [c.seat, c.slashBps, c.coverBps]));
    const perCaseArk = (q.valueArk + q.slices - 1n) / q.slices;
    ctx.check(perCaseArk <= bound && q.slices <= 16n, 'P-I24a: each case is admitted at a value in ARK within κ of its first majority\'s forfeit, in at most sixteen slices (I24′)', { case: s.key, valueArk: q.valueArk, bound, slices: q.slices });
    const after = big(await this.c('openSeatStake'));
    ctx.check(after === before.open + 7n * q.seat * q.slices && after <= before.pool, 'P-C: each open case reserves its first panel\'s seven seats, within the pool\'s stake (QL-19, PV-01)', { case: s.key, before: before.open, after, seat: q.seat, poolStake: before.pool });
    const opened = ev.filter((e) => e.name === 'DeterminationOpened' && e.args.determinationId === id);
    if (s.kind === LOSS) ctx.check(opened.length === 1, 'P-D: a loss opens the bond\'s determination once, at its assertion (yellow paper §1.4)', { case: s.key, opened: opened.length });
    ctx.note(`${s.key}: case ${id.slice(0, 12)}… V ${cs.value} QRL wei, seat ${cs.seatStake / ONE} ARK, deposit ${cs.deposit / ONE} QRL`);
    return cs;
  }

  /** OC-COURT-02: a dust loss by an account that is not the position's beneficiary, read with eth_call. */
  async probeDust(p1) {
    const ctx = this.ctx;
    const payload = this.lossPayload(p1, 1n);
    const det = async () => big((await H.view(ctx.qrl, this.at.bond, this.abi.bond, 'state')).determinationsOpen);
    const before = await det();
    let refused = null;
    try {
      await this.griefer.call(this.at.court, this.abi.court, 'assertFinding', [LOSS, payload, keccak256(toUtf8Bytes('court-live:dust'))]);
    } catch (e) {
      refused = revertName(ctx.r.errors, e) || String(e.shortMessage || e.message).slice(0, 80);
    }
    const after = await det();
    const sealable = Boolean((await ctx.qrl.call(this.at.bond, this.abi.bond, 'seedReturnSealable'))[0]);
    const outsider = !H.same(this.griefer.address, this.asserter.address);
    ctx.check(outsider && String(refused).includes('LossBelowFloor') && after === before, 'a loss of dust value asserted by an account that is not the position\'s beneficiary does not open the bond\'s determination (I21; C-5)', { refused, determinationsOpen: { before, after }, seedReturnSealable: sealable });
    ctx.note(`OC-COURT-02: the dust loss -> ${refused}; seedReturnSealable ${sealable}`);
  }

  /* ------------------------------------------------------------ the loop */

  async loop() {
    const ctx = this.ctx;
    const start = await this.now();
    const setCourtWait = this.setCourtOp ? this.setCourtOp.eta - start : 0n;
    const deadline = start + 80n * this.k.COURT_DAY + 14n * big(ctx.clock.EPOCH_LENGTH) + (this.COURT_PERIOD || 0n) * 2n + (setCourtWait > 0n ? setCourtWait : 0n);
    for (;;) {
      await ctx.tick();
      await this.duties();
      for (const cs of this.cases) if (!cs.done) await this.advance(cs);
      if (this.cases.every((c) => c.done) && this.s5done) break;
      if ((await this.now()) > deadline) {
        const open = this.cases.filter((c) => !c.done).map((c) => c.key);
        throw new ScenarioError(`the court's cases did not close by the run's deadline: ${open.join(', ')}${this.s5done ? '' : ' (and S5\'s withdrawal)'}`);
      }
      await ctx.sleep(n(this.step));
    }
  }

  /** What is due outside a case: setCourt's execution, the jurors' stake, S5's withdrawal. */
  async duties() {
    const ctx = this.ctx;
    if (this.setCourtOp && !this.courtWired && (await this.now()) >= this.setCourtOp.eta) {
      await this.gsend(this.G.ArkTimelock, 'ArkTimelock', 'execute', [this.setCourtOp.opId]);
      const named = await this.gcall(this.G.ArkGovernor, 'ArkGovernor', 'court');
      ctx.check(H.same(named, this.at.court) && H.same(await ctx.court('GOVERNOR'), this.G.ArkGovernor), 'S4: ArkGovernor names this court and the court this governor, through the timelock\'s delay (G13)', { governorCourt: named });
      this.courtWired = true;
    }
    // The jurors stake once S7's draw is armed (or at once without S7), so they sit in none of its draw.
    if (!this.staked) {
      const s7 = this.get('S7');
      if (!s7 || s7.armed) await this.stakeJurors();
    } else if (!this.jurorsActive) {
      const eligible = big(await this.p('eligibleCount', [this.seat]));
      let all = true;
      for (const j of this.jurorActors) if (big(await this.p('freeStakeOf', [j.address])) < this.seat) all = false;
      if (all && eligible >= BigInt(JURORS)) {
        this.jurorsActive = true;
        const s3 = await this.fi('s3Ready');
        const pool = big(await this.p('poolStake'));
        const open = big(await this.c('openSeatStake'));
        ctx.check(eligible >= 49n && pool >= open + 7n * this.seat, 'S0: past the boundary 49 jurors hold a free seat and the pool holds the open cases\' reserve and one case more (whitepaper §3.7, PV-01)', { eligible, poolStake: pool, openSeatStake: open });
        ctx.check(Boolean(s3.ready ?? s3[0]), 'S0: the S3 juror-pool condition holds: the largest finding\'s slices seat at once and 49 jurors can seat a retrial (EC-04, PV-07)', { s3Ready: s3 });
      }
    }
    if (this.s5 && !this.s5done && (await this.now()) >= this.s5.unbondAt) {
      const j = this.s5.juror;
      let blocked = null;
      try {
        await j.call(this.at.pool, this.abi.pool, 'withdraw');
      } catch (e) {
        blocked = revertName(ctx.r.errors, e);
      }
      if (blocked) {
        ctx.note(`S5: withdraw not yet: ${blocked}`);
      } else {
        const balance = big(await this.ark('balanceOf', [j.address]));
        const r = await j.send(this.at.pool, this.abi.pool, 'withdraw');
        const ev = H.decode(ctx, r).find((e) => e.name === 'Withdrawn');
        const got = big(await this.ark('balanceOf', [j.address])) - balance;
        ctx.check(ev && ev.args.amount === this.s5.amount && got === this.s5.amount, 'S5: unbonded stake is withdrawn whole once the unbonding period has run (whitepaper §6.1)', { amount: this.s5.amount, withdrawn: ev && ev.args.amount, received: got });
        this.s5done = true;
      }
    }
  }

  /** S0 for the forty-nine: each topped up to three seats, ARK from the deployer, staked from its own key. */
  async stakeJurors() {
    const ctx = this.ctx;
    this.staked = true;
    const target = STAKE_SEATS * this.seat;
    const plans = [];
    for (const j of this.jurorActors) {
      const r = await this.jurorOf(j.address);
      const have = r.active + r.pending;
      if (have >= target) continue;
      const deficit = target - have;
      const balance = big(await this.ark('balanceOf', [j.address]));
      if (balance < deficit) await ctx.qrl.send(this.at.ark, this.abi.ark, 'transfer', [j.address, deficit - balance]);
      plans.push({ j, deficit });
    }
    const epoch = await ctx.originEpoch();
    const receipts = await H.all(ctx, plans.map(({ j, deficit }) => async () => {
      await j.send(this.at.ark, this.abi.ark, 'approve', [this.at.pool, deficit]);
      return { deficit, r: await j.send(this.at.pool, this.abi.pool, 'stake', [deficit]) };
    }));
    const bad = receipts.filter(({ deficit, r }) => {
      const ev = H.decode(ctx, r).find((e) => e.name === 'Staked');
      return !ev || ev.args.amount !== deficit || ev.args.activeFromEpoch <= epoch;
    });
    ctx.check(bad.length === 0, 'S0: each juror\'s stake is recorded and joins the draw from a later epoch, never the armed one (QL-01)', { staked: receipts.length, target, bad: bad.length });
    ctx.note(`S0: ${receipts.length} juror(s) staked to ${target / ONE} ARK each (${this.jurorActors.length - receipts.length} already held it)`);
  }

  /** One case, one step: whatever is due for it now. */
  async advance(cs) {
    const ctx = this.ctx;
    const c = await this.caseOf(cs.id);
    const stage = n(c.stage);
    const now = await this.now();
    if (stage === ST.FINAL) {
      cs.done = true;
      return;
    }
    const day = this.k.COURT_DAY;
    const challengeEnd = big(c.openedAt) + big(c.challengeDays) * day;
    const evidenceEnd = challengeEnd + big(c.evidenceDays) * day;
    if (stage === ST.CHALLENGE) {
      if (cs.unchallenged) {
        if (now >= challengeEnd && (cs.key !== 'K' || cs.kGrown !== undefined)) await this.finalize(cs, c);
        return;
      }
      if (now < evidenceEnd) return;
      if (cs.probe08 && !cs.probed) {
        await this.probe08(cs, evidenceEnd);
        return;
      }
      if (!(await this.armGate(cs))) return;
      if (await this.poolFree()) await this.arm(cs, 1);
      return;
    }
    if (stage === ST.ROUNDS) {
      const round = n(c.round);
      const r = await this.roundOf(cs.id, round);
      const block = await this.block();
      if (big(r.commitEnd) === 0n) {
        const d = big(r.drawBlock);
        const reach = d + this.k.BLOCKHASH_REACH;
        if (d !== 0n && block > d && block <= reach && !cs.drawTried.has(`${round}:${d}`)) {
          cs.drawTried.add(`${round}:${d}`);
          await this.draw(cs, round);
          return;
        }
        if (cs.lapse) {
          if (d !== 0n && block > reach && now >= big(r.armedAt) + this.k.MAX_DRAW_LAPSES * this.k.DRAW_WINDOW) await this.lapse(cs, c);
          return;
        }
        if ((d === 0n || block > reach) && (await this.poolFree())) await this.arm(cs, round);
        return;
      }
      await this.vote(cs, c, round, r, now);
      return;
    }
    if (stage === ST.ESCALATED) {
      await this.escalated(cs, c, now);
      return;
    }
    if (stage === ST.DECIDED) await this.finalize(cs, c);
  }

  /** S7 arms while the pool seats too few; every other jury waits for the forty-nine. */
  async armGate(cs) {
    if (cs.lapse) return true;
    if (this.get('S7') && !this.get('S7').armed) return false;
    return Boolean(this.jurorsActive);
  }

  /** S2: armDraw -> DrawArmed, the target block eight ahead, the pool armed until d + 256. */
  async arm(cs, round) {
    const ctx = this.ctx;
    const r = await ctx.qrl.send(this.at.court, this.abi.court, 'armDraw', [cs.id]);
    const ev = H.decode(ctx, r).find((e) => e.name === 'DrawArmed');
    const until = big(await this.p('armedUntil'));
    ctx.check(ev && ev.args.round === BigInt(round) && ev.args.drawBlock === r.blockNumber + this.k.DRAW_LOOKAHEAD && until === ev.args.drawBlock + this.k.BLOCKHASH_REACH, 'S2: a round is armed for the block eight ahead and drawable for the 256 after it, the pool fixed at the arm (QL-01, QL-18)', { case: cs.key, round, armedAt: r.blockNumber, drawBlock: ev && ev.args.drawBlock, armedUntil: until });
    cs.armed = true;
    await this.refusesOnce('a panel drawn before its target block', 'NotDrawBlock', () => ctx.qrl.call(this.at.court, this.abi.court, 'drawPanel', [cs.id]));
    await this.refusesOnce('a second draw armed while one is drawable', 'InvalidCaseState', () => ctx.qrl.call(this.at.court, this.abi.court, 'armDraw', [cs.id]));
  }

  /** S2/S3/S4: drawPanel -> JuryDrawn of 7, 14 or 28, each seat's stake held; or PanelUnseatable (S7). */
  async draw(cs, round) {
    const ctx = this.ctx;
    const size = 7n << BigInt(round - 1);
    const known = [...this.jurors.keys()];
    const held = new Map();
    for (const a of known) held.set(a, (await this.jurorOf(a)).held);
    const listed = big(await this.p('jurorCount'));
    const r = await ctx.qrl.send(this.at.court, this.abi.court, 'drawPanel', [cs.id]);
    const ev = H.decode(ctx, r);
    if (ev.some((e) => e.name === 'PanelUnseatable')) {
      const panel = await this.p('panelOf', [cs.id, round]);
      ctx.check(cs.lapse && panel.length === 0 && (await this.poolFree()), 'S7: with fewer than seven eligible at the arm the panel is unseatable, nobody is seated, and the arm is spent (court question w)', { case: cs.key, round, eligible: await this.p('eligibleCount', [this.seat]) });
      await this.refusesOnce('a lapse inside the draw window', 'WindowOpen', () => ctx.qrl.call(this.at.court, this.abi.court, 'lapseDraw', [cs.id]));
      return;
    }
    const drawn = ev.find((e) => e.name === 'JuryDrawn');
    const panel = (await this.p('panelOf', [cs.id, round])).map(H.norm);
    const moved = [];
    for (const a of panel) {
      if (!held.has(a)) continue;
      const delta = (await this.jurorOf(a)).held - held.get(a);
      if (delta !== cs.seatStake) moved.push({ juror: a, delta });
    }
    ctx.check(drawn && drawn.args.jurySize === size && BigInt(panel.length) === size && new Set(panel).size === panel.length && moved.length === 0, `S${round === 1 ? 2 : round === 2 ? 3 : 4}: the panel of ${size} is drawn without replacement and each seat holds the case's seat stake from the draw (G13)`, { case: cs.key, round, jurySize: drawn && drawn.args.jurySize, panel: panel.length, wrongHeld: moved });
    if (round > 1) {
      const earlier = new Set((await this.panel(cs.id, round - 1)).map((x) => x.addr));
      ctx.check(panel.every((a) => !earlier.has(a)), 'a later panel seats no juror of an earlier round of the case (yellow paper §4.5)', { case: cs.key, round });
    }
    const extrapolated = (r.gasUsed * POOL_SIZE_MAX) / (listed > 0n ? listed : 1n);
    this.gas.draw.push({ seats: Number(size), gasUsed: r.gasUsed, jurorsListed: listed, extrapolated256: extrapolated });
    ctx.note(`P-G: drawPanel(${size}) used ${r.gasUsed} gas over ${listed} listed jurors; ~${extrapolated} at 256`);
    ctx.check(extrapolated < BLOCK_GAS_LIMIT / 2n, 'P-G: a draw fits half a block at 256 listed jurors (linear in the list)', { seats: size, gasUsed: r.gasUsed, listed, extrapolated, limit: BLOCK_GAS_LIMIT });
    // Commit at once: the window is two court days from the draw.
    const c = await this.caseOf(cs.id);
    await this.vote(cs, c, round, await this.roundOf(cs.id, round), await this.now());
  }

  /** Commit, reveal, and the loser's appeal or escalation, as the case's plan says. */
  async vote(cs, c, round, r, now) {
    const ctx = this.ctx;
    const commitEnd = big(r.commitEnd);
    const revealEnd = big(r.revealEnd);
    const appealEnd = big(r.appealEnd);
    if (!cs.committed.has(round) && now < commitEnd) {
      cs.committed.add(round);
      const panel = (await this.p('panelOf', [cs.id, round])).map(H.norm).filter((a) => this.jurors.has(a));
      const plan = cs.plan[round](panel.length);
      const votes = new Map();
      panel.forEach((a, i) => {
        const v = plan[i];
        const salt = keccak256(toUtf8Bytes(`${this.nonce}:${cs.key}:${round}:${a}`));
        votes.set(a, { vote: v === 'silent' ? REJECT : v, reveal: v !== 'silent', salt });
      });
      cs.votes[round] = votes;
      if (round === 1 && cs.key === 'A') {
        const outsider = this.jurorActors.find((j) => !votes.has(H.norm(j.address)));
        if (outsider) await this.refusesOnce('a vote committed by a juror not seated on the round', 'NotADrawnJuror', () => outsider.call(this.at.court, this.abi.court, 'commitVote', [cs.id, '0x' + '11'.repeat(32)]));
        const first = this.jurors.get(panel[0]);
        if (first) await this.refusesOnce('a reveal before the commit window closes', 'WindowOpen', () => first.call(this.at.court, this.abi.court, 'revealVote', [cs.id, UPHOLD, '0x' + '00'.repeat(32)]));
      }
      await H.all(ctx, [...votes.entries()].map(([a, v]) => async () => {
        const client = this.jurors.get(a);
        const commitment = await this.c('voteCommitment', [cs.id, round, v.vote, v.salt, client.address]);
        return client.send(this.at.court, this.abi.court, 'commitVote', [cs.id, commitment]);
      }));
      ctx.note(`${cs.key} round ${round}: ${votes.size} commitment(s) of ${7 << (round - 1)} seats`);
      return;
    }
    if (cs.committed.has(round) && !cs.revealed.has(round) && now >= commitEnd && now < revealEnd) {
      cs.revealed.add(round);
      const votes = cs.votes[round];
      await H.all(ctx, [...votes.entries()].filter(([, v]) => v.reveal).map(([a, v]) => async () => this.jurors.get(a).send(this.at.court, this.abi.court, 'revealVote', [cs.id, v.vote, v.salt])));
      const after = await this.roundOf(cs.id, round);
      const ups = [...votes.values()].filter((v) => v.reveal && v.vote === UPHOLD).length;
      const rej = [...votes.values()].filter((v) => v.reveal && v.vote === REJECT).length;
      ctx.check(n(after.upholds) === ups && n(after.rejects) === rej, 'each revealed vote is counted once, against its commitment (QL-02)', { case: cs.key, round, upholds: after.upholds, rejects: after.rejects });
      return;
    }
    if (now < revealEnd) return;
    const action = cs.after && cs.after[round];
    if (action && !cs.acted.has(round) && now < appealEnd) {
      cs.acted.add(round);
      await this.loserActs(cs, c, round, r, action);
      return;
    }
    if (now >= appealEnd && (!action || cs.acted.has(round))) {
      if (cs.key === 'A' && round === 3 && !cs.retrialFinal) {
        cs.retrialFinal = true;
        await this.refusesOnce('a retrial is final: nobody appeals or escalates it', 'InvalidCaseState', () => this.asserter.call(this.at.court, this.abi.court, 'escalateToGovernance', [cs.id], { value: 4n * cs.deposit }));
      }
      await this.finalize(cs, c);
    }
  }

  /** S3: the loser appeals (2 D_1) and the appeal is armed in the same transaction; S4: the loser escalates (4 D_1). */
  async loserActs(cs, c, round, r, action) {
    const ctx = this.ctx;
    const verdict = n(r.upholds) > n(r.rejects) ? UPHOLD : REJECT;
    const loser = verdict === UPHOLD ? this.challenger : this.asserter;
    const winner = verdict === UPHOLD ? this.asserter : this.challenger;
    const times = action === 'appeal' ? 2n : 4n;
    const fn = action === 'appeal' ? 'appeal' : 'escalateToGovernance';
    await this.refusesOnce(`only the loser of the round ${action === 'appeal' ? 'appeals' : 'escalates'}`, 'NotTheLoser', () => winner.call(this.at.court, this.abi.court, fn, [cs.id], { value: times * cs.deposit }));
    const poolWasFree = await this.poolFree();
    const rc = await loser.send(this.at.court, this.abi.court, fn, [cs.id], { value: times * cs.deposit });
    const ev = H.decode(ctx, rc);
    const decided = ev.find((e) => e.name === 'RoundDecided');
    ctx.check(decided && n(decided.args.verdict) === verdict, `round ${round} is decided by the majority of the votes revealed, a tie against the assertion (whitepaper §6.2)`, { case: cs.key, round, verdict: decided && decided.args });
    if (action === 'appeal') {
      const appealed = ev.find((e) => e.name === 'Appealed');
      const armed = ev.find((e) => e.name === 'DrawArmed');
      ctx.check(appealed && appealed.args.newRound === 2n && appealed.args.newBond === 2n * cs.deposit && (!poolWasFree || (armed && armed.args.round === 2n)), 'S3: the loser appeals at twice the deposit and the appeal\'s panel of 14 is armed in the same transaction where the pool is free (COURT-07)', { case: cs.key, appealed: appealed && appealed.args, armed: armed && armed.args, poolWasFree });
      ctx.note(`${cs.key}: round 1 ${verdictName(verdict)} appealed by the ${verdict === UPHOLD ? 'challenger' : 'asserter'}`);
      return;
    }
    const esc = ev.find((e) => e.name === 'EscalatedToGovernance');
    const pending = Boolean(await this.c('escalationPending', [cs.id]));
    ctx.check(esc && esc.args.bond === 4n * cs.deposit && pending, 'S4: the appeal\'s loser escalates at four times the deposit and the case awaits the governor (escalationPending; G13)', { case: cs.key, bond: esc && esc.args.bond, escalationPending: pending });
    const now = await this.now();
    cs.escalation = { at: now, held: await this.heldOf(cs, 2) };
    await this.refusesOnce('a case escalated is not closed before its lapse', 'WindowOpen', () => ctx.qrl.call(this.at.court, this.abi.court, 'finalize', [cs.id, cs.payload]));
    await this.refusesOnce('only the governor resolves an escalation', 'OnlyGovernor', () => this.challenger.call(this.at.court, this.abi.court, 'resolveEscalation', [cs.id, true]));
  }

  /** Each known juror of rounds 1..`rounds` with its held stake and its seat on the case. */
  async heldOf(cs, rounds) {
    const out = [];
    for (const { addr, round } of await this.panel(cs.id, rounds)) {
      out.push({ addr, round, held: (await this.jurorOf(addr)).held, seatRound: n(await this.p('seatRound', [cs.id, addr])) });
    }
    return out;
  }

  /** S4: the governor's vote on the escalation, a retrial ordered; or the lapse where no governor answers. */
  async escalated(cs, c, now) {
    const ctx = this.ctx;
    const lapse = big(c.escalatedAt) + this.k.ESCALATION_LAPSE;
    if (this.govPath === 'direct' && !cs.resolved) {
      cs.resolved = true;
      const r = await ctx.qrl.send(this.at.court, this.abi.court, 'resolveEscalation', [cs.id, true]);
      const ev = H.decode(ctx, r).find((e) => e.name === 'EscalationResolved');
      ctx.check(ev && ev.args.retrial === true, 'S4: the governor orders a retrial before twenty-eight (yellow paper §4.5)', { case: cs.key });
      return;
    }
    if (this.govPath === 'governor' && !cs.gov) {
      if (!this.courtWired) {
        if (now >= lapse) {
          this.outOfScope.push('S4\'s vote: setCourt had not run its timelock delay when the escalation lapsed; the case closed on the appeal verdict');
          this.govPath = 'lapse';
        }
        return;
      }
      const G = this.G;
      const pr = await ctx.qrl.send(G.ArkGovernor, this.gabi('ArkGovernor'), 'proposeCourtEscalation', [cs.id]);
      const pid = big(await this.gcall(G.ArkGovernor, 'ArkGovernor', 'proposalCount'));
      const voteEnd = big(await this.gcall(G.ArkGovernor, 'ArkGovernor', 'voteEndOf', [pid]));
      // G3: power at the snapshot block is readable from the next block on; a
      // vote estimated in the snapshot block reverts FutureLookup (live,
      // 2026-10-09). Wait a block, then retry over a few blocks.
      const snap = big(pr.blockNumber);
      for (let i = 0; ; i++) {
        await ctx.waitFor('a block after the escalation proposal\'s snapshot', async () => (await ctx.qrl.head()).latest > snap, { timeoutEpochs: 1 });
        try {
          await ctx.qrl.send(G.ArkGovernor, this.gabi('ArkGovernor'), 'castVote', [pid, 1]);
          break;
        } catch (e) {
          if (i >= 7) throw e;
          const head = (await ctx.qrl.head()).latest;
          await ctx.waitFor('the next block', async () => (await ctx.qrl.head()).latest > head, { timeoutEpochs: 1 });
        }
      }
      cs.gov = { pid, voteEnd, proposedAt: voteEnd - this.COURT_PERIOD };
      ctx.note(`S4: proposal ${pid} on the escalation, veARK votes until ${voteEnd} (the lapse is at ${lapse})`);
      ctx.knownIssue('OC-COURT-03', voteEnd <= lapse, 'a governor vote opened on an escalation ends before anyone may close the case on the appeal verdict (G13)', { escalatedAt: c.escalatedAt, voteEnd, lapse, COURT_PERIOD: this.COURT_PERIOD, ESCALATION_LAPSE: this.k.ESCALATION_LAPSE });
      await this.refusesOnce('the escalation is not resolved while veARK votes', 'VotingOpen', () => ctx.qrl.call(G.ArkGovernor, this.gabi('ArkGovernor'), 'resolve', [pid]));
      return;
    }
    if (this.govPath === 'governor' && cs.gov && !cs.resolved && now >= cs.gov.voteEnd) {
      cs.resolved = true;
      const pending = Boolean(await this.c('escalationPending', [cs.id]));
      const held = await this.heldOf(cs, 2);
      const kept = held.every((h, i) => h.held >= cs.seatStake && h.seatRound === cs.escalation.held[i].seatRound);
      ctx.check(pending && n(c.stage) === ST.ESCALATED && kept, 'P-G13: until the governor resolves, the case stays escalated, nobody has closed it, and every seat of rounds 1–2 is still held (G13)', { case: cs.key, escalationPending: pending, seatsHeld: kept });
      const r = await ctx.qrl.send(this.G.ArkGovernor, this.gabi('ArkGovernor'), 'resolve', [cs.gov.pid]);
      const tr = await this.now();
      const ev = H.decode(ctx, r);
      const res = ev.find((e) => e.name === 'EscalationResolved');
      const armed = ev.find((e) => e.name === 'DrawArmed');
      ctx.check(res && res.args.retrial === true && tr >= cs.gov.proposedAt + this.COURT_PERIOD && !(await this.c('escalationPending', [cs.id])), 'S4: veARK orders a retrial through ArkGovernor.resolve once its vote has run (EscalationResolved; t_r >= t_p + COURT_PERIOD)', { case: cs.key, retrial: res && res.args.retrial, resolvedAt: tr, proposedAt: cs.gov.proposedAt, armed: armed && armed.args });
      return;
    }
    if (this.govPath === 'lapse' && now >= lapse) await this.finalize(cs, c);
  }

  /** S7: the round lapses once its window and four draw windows have passed; every deposit returns. */
  async lapse(cs, c) {
    const ctx = this.ctx;
    const owed = { a: big(await this.c('owed', [cs.asserter.address])), c: big(await this.c('owed', [this.challenger.address])) };
    const open = big(await this.c('openSeatStake'));
    const r = await ctx.qrl.send(this.at.court, this.abi.court, 'lapseDraw', [cs.id]);
    const ev = H.decode(ctx, r);
    const lapsed = ev.find((e) => e.name === 'DrawLapsed');
    const fin = ev.find((e) => e.name === 'CaseFinal');
    const closed = ev.filter((e) => e.name === 'DeterminationClosed' && e.args.determinationId === cs.id);
    const after = { a: big(await this.c('owed', [cs.asserter.address])), c: big(await this.c('owed', [this.challenger.address])) };
    ctx.check(lapsed && fin && n(fin.args.outcome) === REJECT && after.a - owed.a === big(c.posted[0]) && after.c - owed.c === big(c.posted[1]), 'S7: a first round nobody can seat lapses against the assertion and every deposit is refunded, no fee paid (court question w)', { case: cs.key, lapses: lapsed && lapsed.args.lapses, outcome: fin && fin.args.outcome, refunded: { asserter: after.a - owed.a, challenger: after.c - owed.c } });
    ctx.check(closed.length === 1 && big(await this.c('openSeatStake')) === open - 7n * cs.seatStake, 'P-D, P-C: the lapse closes the bond\'s determination once and frees the case\'s reserve', { case: cs.key, closed: closed.length });
    cs.done = true;
  }

  /**
   * OC-COURT-08: a challenged case nobody arms. The fix lets `lapseDraw`
   * close it once the evidence window and four draw windows have passed;
   * the code needs an arm first. Read with eth_call, then the case is heard.
   */
  async probe08(cs, evidenceEnd) {
    const ctx = this.ctx;
    if ((await this.now()) < evidenceEnd + this.k.MAX_DRAW_LAPSES * this.k.DRAW_WINDOW || !this.jurorsActive) return;
    cs.probed = true;
    let got = null;
    try {
      await ctx.qrl.call(this.at.court, this.abi.court, 'lapseDraw', [cs.id]);
    } catch (e) {
      got = revertName(ctx.r.errors, e);
    }
    ctx.check(got === null, 'a challenged case nobody arms can be closed by lapseDraw once its evidence window and four draw windows have passed (liveness)', { case: cs.key, evidenceEnd, now: await this.now(), lapseDraw: got || 'admitted' });
    await ctx.qrl.send(this.at.court, this.abi.court, 'lapseDraw', [cs.id]);
    cs.done = true;
  }

  /* ------------------------------------------------------------ finalize */

  async finalize(cs, c) {
    const ctx = this.ctx;
    const jury = !cs.unchallenged;
    const rounds = n(c.round);
    const pre = {
      unalloc: big(await this.p('unallocatedSlash')),
      feePool: big(await this.c('feePool')),
      owedA: big(await this.c('owed', [cs.asserter.address])),
      posted: [big(c.posted[0]), big(c.posted[1])],
      seat: jury ? big(await this.p('seatStakeOf', [cs.id])) : 0n,
      panel: jury ? await this.panel(cs.id, rounds) : [],
    };
    pre.held = new Map();
    for (const { addr } of pre.panel) pre.held.set(addr, (await this.jurorOf(addr)).held);
    let r;
    try {
      r = await ctx.qrl.send(this.at.court, this.abi.court, 'finalize', [cs.id, cs.payload]);
    } catch (e) {
      cs.finalizeTries += 1;
      const why = revertName(ctx.r.errors, e);
      if (cs.finalizeTries > 5) throw new ScenarioError(`finalize of ${cs.key} reverted ${cs.finalizeTries} times: ${why}`);
      ctx.note(`finalize of ${cs.key} reverted (${why}); retried next step (QL-22)`);
      return;
    }
    cs.done = true;
    const ev = H.decode(ctx, r);
    const fin = ev.find((e) => e.name === 'CaseFinal');
    const outcome = fin ? n(fin.args.outcome) : 0;
    const applied = ev.some((e) => e.name === 'FindingApplied' && e.args.caseId === cs.id);
    const loss = ev.find((e) => e.name === 'LossDetermined' && e.args.determinationId === cs.id);
    const closed = ev.filter((e) => e.name === 'DeterminationClosed' && e.args.determinationId === cs.id);
    if (cs.kind === LOSS) ctx.check(closed.length === 1, 'P-D: the bond\'s determination is closed once, at the case\'s CaseFinal (QL-22)', { case: cs.key, closed: closed.length });
    if (loss) {
      ctx.check(loss.args.drawQrl <= cs.value, 'P-I24b: the bond draws no more than the V the finding was admitted and bounded at (I24, G8)', { case: cs.key, drawQrl: loss.args.drawQrl, value: cs.value, ratio: cs.value > 0n ? Number((loss.args.drawQrl * 1000n) / cs.value) / 1000 : null, drawArk: cs.value > 0n ? (loss.args.drawQrl * cs.quote.valueArk) / cs.value : null, boundArk: this.boundArk, haircutBps: loss.args.haircutBps, available: loss.args.available });
      await this.nameBufferParts(cs);
    }

    if (!jury) {
      const owed = big(await this.c('owed', [cs.asserter.address])) - pre.owedA;
      ctx.check(fin && outcome === UPHOLD && applied && loss, 'S1: an unchallenged loss stands at the close of its window without a jury, and reaches the bond (FindingApplied, LossDetermined; whitepaper §6.2)', { case: cs.key, outcome, applied, drawQrl: loss && loss.args.drawQrl });
      ctx.check(owed === cs.deposit, 'S1: the asserter of a finding that stands is owed its deposit back', { owed, deposit: cs.deposit });
      if (cs.key === 'K') ctx.note(`OC-COURT-01: V ${cs.value} was fixed on K ${cs.kOpen}; delivered on K ${cs.kGrown}: draw ${loss && loss.args.drawQrl}`);
      const before = big(await ctx.qrl.balance(cs.asserter.address));
      const rc = await cs.asserter.send(this.at.court, this.abi.court, 'claim');
      const claimed = H.decode(ctx, rc).find((e) => e.name === 'Claimed');
      ctx.check(claimed && claimed.args.amount >= owed && big(await this.c('owed', [cs.asserter.address])) === 0n, 'S1: claim pays the asserter what it is owed and clears it', { claimed: claimed && claimed.args.amount, balanceBefore: before });
      await this.pS3(`after ${cs.key}`);
      return;
    }

    // A jury case: every seat of every round settles against the final verdict.
    ctx.check(outcome === cs.expect, `the case closes on the verdict its last round reached (${verdictName(cs.expect)})`, { case: cs.key, outcome, rounds });
    if (rounds >= 1 && !ev.some((e) => e.name === 'RoundDecided') && n(c.stage) === ST.ROUNDS) ctx.check(false, 'the final round is tallied at finalize (RoundDecided)', { case: cs.key });
    const seats = ev.filter((e) => e.name === 'SeatSettled' && e.args.caseId === cs.id);
    const count = (7 << rounds) - 7;
    const cut = (pre.seat * big(c.slashBps)) / BPS;
    const wrong = [];
    let slashed = 0n;
    let reward = 0n;
    let coherent = 0n;
    for (const s of seats) {
      const where = pre.panel.find((x) => x.addr === s.args.juror);
      const v = where && cs.votes[where.round] && cs.votes[where.round].get(s.args.juror);
      const isCoherent = Boolean(v && v.reveal && v.vote === outcome);
      if (s.args.coherent !== isCoherent || s.args.slashed !== (isCoherent ? 0n : cut)) wrong.push({ juror: s.args.juror, coherent: s.args.coherent, slashed: s.args.slashed });
      slashed += s.args.slashed;
      reward += s.args.reward;
      if (s.args.coherent) coherent += 1n;
    }
    const unalloc = big(await this.p('unallocatedSlash'));
    ctx.check(seats.length === count && wrong.length === 0, `P-S1: ${count} seats settle (7 << round − 7); a seat is coherent only where its revealed vote is the final verdict, else slashed ⌊seat·slash⌋ (whitepaper §6.2)`, { case: cs.key, seats: seats.length, count, cut, wrong });
    ctx.check(slashed === reward + (unalloc - pre.unalloc), 'P-S1: every slashed ARK goes to the coherent seats or to unallocatedSlash, none made or lost', { case: cs.key, slashed, reward, unallocatedDelta: unalloc - pre.unalloc });
    const released = [];
    for (const [addr, held] of pre.held) {
      const seatsHere = pre.panel.filter((x) => x.addr === addr).length;
      const now = (await this.jurorOf(addr)).held;
      if (held - now !== pre.seat * BigInt(seatsHere)) released.push({ juror: addr, before: held, after: now });
    }
    ctx.check(released.length === 0, 'P-S1: finalize releases each seat\'s held stake exactly once (G13)', { case: cs.key, seat: pre.seat, wrong: released });
    // P-I24c: where the appeal overturned round one, its majority forfeits at least four seats' cut.
    const r1 = cs.votes[1];
    if (r1) {
      const ups = [...r1.values()].filter((v) => v.reveal && v.vote === UPHOLD).length;
      const rej = [...r1.values()].filter((v) => v.reveal && v.vote === REJECT).length;
      const v1 = ups > rej ? UPHOLD : REJECT;
      if (v1 !== outcome) {
        const majority = [...r1.entries()].filter(([, v]) => v.reveal && v.vote === v1).map(([a]) => a);
        const forfeited = seats.filter((s) => majority.includes(s.args.juror)).reduce((t, s) => t + s.args.slashed, 0n);
        ctx.check(forfeited >= 4n * cut, 'P-I24c: the majority of an overturned first round forfeits at least ⌈7/2⌉ seats\' slash, the stake the bound rests on (I24′)', { case: cs.key, majority: majority.length, forfeited, floor: 4n * cut });
      }
    }
    // Fees: the losing deposits first, the fee pool the balance, as far as it holds (whitepaper §6.2).
    const loserPosted = pre.posted[outcome === UPHOLD ? 1 : 0];
    const fee = coherent * this.k.JUROR_FEE;
    const fromDeposit = min(fee, loserPosted);
    const fromPool = min(fee - fromDeposit, pre.feePool);
    ctx.check(fin && fin.args.jurorFees === fromDeposit + fromPool && fin.args.fromFeePool === fromPool, 'P-S3: CaseFinal pays each coherent seat the juror fee from the losing deposits, then the fee pool as far as it holds', { case: cs.key, coherent, jurorFees: fin && fin.args.jurorFees, fromFeePool: fin && fin.args.fromFeePool, loserPosted, feePool: pre.feePool });
    if (outcome === UPHOLD && cs.kind === LOSS) ctx.check(applied && loss, 'an upheld loss reaches the bond (FindingApplied, LossDetermined)', { case: cs.key });
    if (outcome === REJECT) ctx.check(!loss && !applied, 'a rejected finding moves nothing on the bond', { case: cs.key });
    this.gas.finalize.push({ case: cs.key, seats: count, gasUsed: r.gasUsed });
    ctx.note(`P-G: finalize of ${cs.key} with ${count} seats used ${r.gasUsed} gas`);
    ctx.check(r.gasUsed < BLOCK_GAS_LIMIT / 2n, 'P-G: finalize of up to 49 seats fits half a block', { case: cs.key, seats: count, gasUsed: r.gasUsed });
    await this.pS3(`after ${cs.key}`);
    if (cs.key === 'B') await this.s5(cs, seats);
  }

  /** A buffer part of a determined loss waits for its beneficiary's destination; unnamed, it holds every seed return (BOND-03). */
  async nameBufferParts(cs) {
    const ctx = this.ctx;
    const part = await ctx.bond('lossPartOf', [cs.id, this.p1.id]);
    if (big(part.bufferUnits ?? part[0]) > 0n) {
      await ctx.bondSend('nameLossDestination', [cs.id, this.p1.id, ctx.r.evmArg(ctx.origin.address)]);
      ctx.note(`${cs.key}: the buffer's part named to the deployer's origin account`);
    }
  }

  /** S5: a coherent juror claims its reward and fees, and unbonds part of its stake. */
  async s5(cs, seats) {
    const ctx = this.ctx;
    const coherent = seats.filter((s) => s.args.coherent).map((s) => s.args.juror);
    const juror = this.jurorActors.find((j) => coherent.includes(H.norm(j.address)));
    if (!juror) {
      this.s5done = true;
      this.outOfScope.push('S5: no coherent seat of B was one of this run\'s jurors');
      return;
    }
    const record = await this.jurorOf(juror.address);
    if (record.reward > 0n) {
      const r = await juror.send(this.at.pool, this.abi.pool, 'claimReward');
      const ev = H.decode(ctx, r).find((e) => e.name === 'RewardClaimed');
      ctx.check(ev && ev.args.amount === record.reward && (await this.jurorOf(juror.address)).reward === 0n, 'S5: a coherent juror claims its share of the slashed stake in ARK', { reward: record.reward, claimed: ev && ev.args.amount });
    }
    const owed = big(await this.c('owed', [juror.address]));
    const rc = await juror.send(this.at.court, this.abi.court, 'claim');
    const claimed = H.decode(ctx, rc).find((e) => e.name === 'Claimed');
    ctx.check(claimed && claimed.args.amount === owed && owed >= this.k.JUROR_FEE, 'S5: a coherent juror is paid its juror fees in QRL (court.claim)', { owed, claimed: claimed && claimed.args.amount, fee: this.k.JUROR_FEE });
    const free = big(await this.p('freeStakeOf', [juror.address]));
    const amount = min(free, this.seat / 2n);
    const r = await juror.send(this.at.pool, this.abi.pool, 'unbond', [amount]);
    const ev = H.decode(ctx, r).find((e) => e.name === 'Unbonding');
    const after = await this.jurorOf(juror.address);
    ctx.check(ev && ev.args.amount === amount && after.unbonding >= amount && after.held <= after.active, 'S5: only stake no seat holds is unbonded, and it leaves the draw at once (G13)', { amount, unbondAt: after.unbondAt, held: after.held, active: after.active });
    let early = null;
    try {
      await juror.call(this.at.pool, this.abi.pool, 'withdraw');
    } catch (e) {
      early = revertName(ctx.r.errors, e);
    }
    // DrawPending where a draw armed now checkpointed the juror's unbond (QL-01): refused either way.
    ctx.check(early !== null && /NothingWithdrawable|DrawPending/.test(early), 'S5: unbonded stake is not withdrawn before the unbonding period', { got: early });
    this.s5 = { juror, amount: after.unbonding, unbondAt: after.unbondAt };
  }

  /* ------------------------------------------------------------ probes */

  /** P-S3 and P-C over every case the court ever opened. */
  async pS3(tag) {
    const ctx = this.ctx;
    const count = big(await this.c('caseCount'));
    const who = new Set();
    let openPosted = 0n;
    let openSeat = 0n;
    let openCount = 0n;
    for (let i = 1n; i <= count; i++) {
      const id = await this.c('caseAt', [i]);
      const c = await this.caseOf(id);
      who.add(H.norm(c.asserter));
      if (!H.isZero(c.challenger)) who.add(H.norm(c.challenger));
      for (let r = 1; r <= n(c.round); r++) for (const a of await this.p('panelOf', [id, r])) who.add(H.norm(a));
      if (n(c.stage) !== ST.FINAL) {
        openPosted += big(c.posted[0]) + big(c.posted[1]);
        openSeat += 7n * big(c.seat);
        openCount += 1n;
      }
    }
    let owed = 0n;
    for (const a of who) owed += big(await this.c('owed', [a]));
    const balance = big(await ctx.qrl.balance(this.at.court));
    const feePool = big(await this.c('feePool'));
    const forfeits = await this.c('bufferForfeits').then(big, () => 0n);
    ctx.check(balance === feePool + forfeits + owed + openPosted, `P-S3 (${tag}): the court holds exactly its fee pool, its forfeits, what it owes and the deposits of open cases`, { balance, feePool, bufferForfeits: forfeits, owed, openPosted });
    const reserved = big(await this.c('openSeatStake'));
    const pool = big(await this.p('poolStake'));
    ctx.check(reserved === openSeat && big(await this.c('openCases')) === openCount && reserved <= pool, `P-C (${tag}): openSeatStake is seven seats of every open case, within the pool`, { openSeatStake: reserved, sevenSeatsOpen: openSeat, openCases: openCount, poolStake: pool });
  }

  /** P-S2: the pool's ARK is every juror's stake, unbonding and reward, and the unallocated slash. */
  async pS2(tag) {
    const ctx = this.ctx;
    let jurors;
    let exact = true;
    try {
      const head = await ctx.qrl.head();
      const logs = await ctx.qrl.logs(this.at.pool, big(ctx.r.deployment.deployedFromBlock || 0), head.latest);
      jurors = new Set(H.decode(ctx, { logs }).filter((e) => e.name === 'Staked').map((e) => e.args.juror));
    } catch (e) {
      exact = false;
      jurors = new Set(this.jurors.keys());
      ctx.note(`P-S2: the pool's Staked log could not be scanned (${String(e.message).slice(0, 80)}); this run's jurors only`);
    }
    let sum = 0n;
    for (const a of jurors) {
      const j = await this.jurorOf(a);
      sum += j.active + j.pending + j.unbonding + j.reward;
    }
    const unalloc = big(await this.p('unallocatedSlash'));
    const balance = big(await this.ark('balanceOf', [this.at.pool]));
    ctx.check(exact ? balance === sum + unalloc : balance >= sum + unalloc, `P-S2 (${tag}): the pool's ARK is the sum of every juror's active, pending, unbonding and reward, and the unallocated slash`, { balance, jurors: jurors.size, sum, unallocatedSlash: unalloc });
  }

  async probes(tag) {
    await this.pS3(tag);
    await this.ctx.invariants(`court-live ${tag}`);
  }

  /* ------------------------------------------------------------ close */

  /** Claims, the gas summary, the probes; every juror's stake unbonded so the next run can show S7 again. */
  async closeOut() {
    const ctx = this.ctx;
    const claimers = [this.asserter, this.challenger, this.griefer, ...this.jurorActors];
    await H.all(ctx, claimers.map((who) => async () => {
      if (big(await this.c('owed', [who.address])) > 0n) await who.send(this.at.court, this.abi.court, 'claim');
      const j = await this.jurorOf(who.address);
      if (j.reward > 0n) await who.send(this.at.pool, this.abi.pool, 'claimReward');
    }));
    await this.pS2('end');
    await this.pS3('end');
    const stillHeld = [];
    await H.all(ctx, this.jurorActors.map((j) => async () => {
      const r = await this.jurorOf(j.address);
      if (r.held > 0n) stillHeld.push(j.address);
      const free = r.active + r.pending - r.held;
      if (free > 0n) await j.send(this.at.pool, this.abi.pool, 'unbond', [free]);
    }));
    ctx.check(stillHeld.length === 0, 'G13: once every case is final no juror of this run holds a seat', { stillHeld });
    ctx.note(`P-G: drawPanel ${JSON.stringify(this.gas.draw.map((g) => `${g.seats}:${g.gasUsed}(~${g.extrapolated256}@256)`))}; finalize ${JSON.stringify(this.gas.finalize.map((g) => `${g.case}/${g.seats}:${g.gasUsed}`))}`);
    await ctx.invariants('court-live end');
  }
}
