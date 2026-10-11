/**
 * The bond as a scenario holds it: holdings bought, moved and paid from
 * accounts of their own, and the events those calls leave decoded on either
 * leg build.
 *
 * Every holder is a `ctx.actor`: on a live QRL client the signer is the
 * client's own key and `from` is ignored, so a second holder is a second
 * key, derived and funded from the deployer (lib.js). Every amount is read
 * from the chain, never assumed; every wait is on the chain's clock.
 *
 * What stands in, and only on the harness: the yield of a mock asset each
 * epoch, the reference solver as a sidecar (the VPS runs its own
 * `ark-solver.service`), and a staking reward reaching the pool's balance
 * (a validator's withdrawal credits a balance without a call; the harness
 * cannot run a validator). Each is refused on a live chain by name.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ONE } = require('../lib');
const { iface, qrlBuild, parseLogs, decodeQrlLogs, harnessAccount, QRL_EVENTS } = require('../../lib/chains');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const { stageKit } = require('./phase');

const TERM = { QUARTER: 0, YEAR: 1, THREE_YEAR: 2 };
const CLASS = { JUNIOR: 0, SENIOR: 1 };

const u = (n) => ({ name: n, type: 'uint256' });
const a = (n) => ({ name: n, type: 'address' });
const b32 = (n) => ({ name: n, type: 'bytes32' });

/**
 * The events a v3 (QIP-55) log is decoded against (`decodeQrlLogs`): ethers
 * cannot read a 64-byte slot. The harness and v2 legs use the ABI instead.
 */
const V3_EVENTS = {
  Subscribed: { signature: 'Subscribed(address,uint256,uint8,uint256,uint256,uint256)', topics: [a('owner'), u('id'), { name: 'class_', type: 'uint8' }], data: [u('amount'), u('shares'), u('maturityEpoch')] },
  HoldingTransferred: { signature: 'HoldingTransferred(address,address,uint256,uint256,uint256)', topics: [a('from'), a('to'), u('id')], data: [u('newId'), u('shares')] },
  Redeemed: { signature: 'Redeemed(address,uint256,uint256)', topics: [a('owner'), u('id')], data: [u('amount')] },
  ReliefPaid: { signature: 'ReliefPaid(uint256,uint256)', topics: [u('id')], data: [u('amount')] },
  CouponTailOpened: { signature: 'CouponTailOpened(uint256,address,uint8,uint256,uint256,uint256)', topics: [u('tailId'), a('owner')], data: [{ name: 'class_', type: 'uint8' }, u('shares'), u('fromEpoch'), u('throughEpoch')] },
  Claimed: { signature: 'Claimed(address,uint256,uint256,uint256)', topics: [a('owner'), u('id')], data: [u('coupon'), u('principalAndDistribution')] },
  ConditionalReleased: { signature: 'ConditionalReleased(uint256,uint256,uint256)', topics: [u('epoch')], data: [u('junior'), u('senior')] },
  RunoffGateClosed: { signature: 'RunoffGateClosed(uint256,uint256)', topics: [u('epoch')], data: [u('atGateClose')] },
  Queued: { signature: 'Queued(uint256,uint256,uint256)', topics: [u('maturityEpoch')], data: [u('amount'), u('queueTotal')] },
  DistributionCredited: { signature: 'DistributionCredited(uint256)', topics: [], data: [u('amount')] },
  CouponPaid: { signature: 'CouponPaid(address,uint8,uint256,uint256,uint256)', topics: [a('to'), { name: 'class_', type: 'uint8' }], data: [u('fromEpoch'), u('toEpoch'), u('amount')] },
  CouponDistributed: { signature: 'CouponDistributed(uint256,uint256,uint256,uint256,bool)', topics: [u('epoch')], data: [u('poolCouponBps'), u('juniorAmount'), u('seniorAmount'), { name: 'seniorShortfall', type: 'bool' }] },
  RecoveryOpened: { signature: 'RecoveryOpened(bytes32,bytes32,address,uint256,uint256,uint256,uint256,uint256)', topics: [b32('recoveryId'), b32('successorId')], data: [{ name: 'escrow', type: 'evmAddress' }, u('realised'), u('toSenior'), u('toJunior'), u('toPositions'), u('residual')] },
  Trigger2Drawn: { signature: 'Trigger2Drawn(bytes32,uint256,uint256,uint256,uint256)', topics: [b32('settlementId')], data: [u('drawBps'), u('drawQrl'), u('drawJunior'), u('drawSenior')] },
  RecoveryLeafSealed: QRL_EVENTS.ArkCatBond.RecoveryLeafSealed,
};

const same = (x, y) => toHex(String(x)).toLowerCase() === toHex(String(y)).toLowerCase();

/** A struct return as a plain object, by position (a field named like an Array method is shadowed by name: OC-OPS-02). */
function plain(abi, method, res) {
  const out = abi.getFunction(method).outputs;
  if (out.length === 1 && out[0].components) return Object.fromEntries(out[0].components.map((c, i) => [c.name, res[0][i]]));
  if (out.length === 1) return res[0];
  return Object.fromEntries(out.map((o, i) => [o.name || String(i), res[i]]));
}

class BondKit {
  constructor(ctx) {
    this.ctx = ctx;
    const build = qrlBuild(ctx.r.manifest.profile);
    this.abi = {
      bond: iface('ArkCatBond', build),
      coupon: iface('ArkBondCoupon', build),
      params: iface('ArkStakeParams', build),
      staking: iface('ArkBondStaking', build),
      pool: iface('ArkStakingPool', build),
      settlement: iface('ArkCatBondSettlement', build),
      recovery: iface('ArkCatBondRecovery', build),
    };
    this.q = ctx.r.q;
  }

  get harness() {
    return this.ctx.qrl.kind === 'harness';
  }

  /** A view of the bond's own surface, structs as plain objects. */
  async view(m, args = []) {
    return plain(this.abi.bond, m, await this.ctx.qrl.call(this.q.ArkCatBond, this.abi.bond, m, args));
  }

  async couponView(m, args = []) {
    return plain(this.abi.coupon, m, await this.ctx.qrl.call(this.q.ArkBondCoupon, this.abi.coupon, m, args));
  }

  async paramsView(m, args = []) {
    return plain(this.abi.params, m, await this.ctx.qrl.call(this.q.ArkStakeParams, this.abi.params, m, args));
  }

  holding(id) {
    return this.view('holdingOf', [id]);
  }

  state() {
    return this.view('state');
  }

  /** `who` sends `m` to the bond (the exit module's stubs are on the bond's own ABI). */
  send(who, m, args = [], opts = {}) {
    return who.send(this.q.ArkCatBond, this.abi.bond, m, args, opts);
  }

  /** The same call as `who`, read with eth_call: for a refusal asserted without mining. */
  callAs(who, m, args = [], opts = {}) {
    return who.call(this.q.ArkCatBond, this.abi.bond, m, args, opts);
  }

  /** Decoded events of a receipt (or a log list) by name, on either leg build. */
  events(receiptOrLogs, name) {
    const logs = Array.isArray(receiptOrLogs) ? receiptOrLogs : receiptOrLogs.logs || [];
    if (this.ctx.r.qrlIsV3) return decodeQrlLogs({ [name]: V3_EVENTS[name] }, logs).filter((x) => x.name === name);
    const abis = [this.abi.bond, this.abi.coupon, this.abi.settlement, this.abi.recovery];
    for (const abi of abis) {
      if (!abi.getEvent(name)) continue;
      const out = parseLogs(abi, logs).filter((x) => x.name === name);
      if (out.length) return out;
    }
    return [];
  }

  /** Every `name` event the bond (or the coupon account) emitted since `fromBlock`. */
  async eventsSince(name, fromBlock, at = this.q.ArkCatBond) {
    const head = await this.ctx.qrl.head();
    return this.events(await this.ctx.qrl.logs(at, fromBlock, head.latest), name);
  }

  /** A holder: an actor of its own, funded to cover `value` and its gas. */
  holder(label, value = 0n) {
    return this.ctx.actor(label, { fund: value + 100n * ONE });
  }

  /** Subscribe `value` into `term` and `class_` from `who`; returns the holding as the bond recorded it. */
  async subscribe(who, term, class_, value) {
    const before = (await this.ctx.qrl.head()).timestamp;
    const receipt = await this.send(who, 'subscribe', [term, class_], { value });
    const [ev] = this.events(receipt, 'Subscribed');
    if (!ev) throw new Error('no Subscribed event');
    const id = BigInt(ev.args.id);
    return { id, at: before, minted: BigInt(ev.args.shares), maturity: BigInt(ev.args.maturityEpoch), ...(await this.holding(id)) };
  }

  /** Move `shares` of `id` from `who` to `to`; returns the new id (or `id` where the whole holding moved). */
  async transfer(who, id, to, shares) {
    const receipt = await this.send(who, 'transferHolding', [id, to, shares]);
    const [ev] = this.events(receipt, 'HoldingTransferred');
    if (!ev) throw new Error('no HoldingTransferred event');
    return BigInt(ev.args.newId);
  }

  /**
   * Run a payout from `who` and say what it paid, by stream: the principal
   * the bond emits, the relief, the coupon its account sent, and the staking
   * distribution and released principal read as the fall of their pots
   * (`state().freePool`, `principalOwed`) across the one transaction — a
   * balance difference would carry gas on a live chain.
   */
  async payout(who, m, args) {
    const s0 = await this.state();
    const receipt = await this.send(who, m, args);
    const s1 = await this.state();
    const sum = (name, field) => this.events(receipt, name).reduce((t, x) => t + BigInt(x.args[field]), 0n);
    return {
      receipt,
      principal: sum('Redeemed', 'amount'),
      relief: sum('ReliefPaid', 'amount'),
      coupon: sum('CouponPaid', 'amount'),
      free: BigInt(s0.freePool) - BigInt(s1.freePool),
      release: BigInt(s0.principalOwed) > BigInt(s1.principalOwed) ? BigInt(s0.principalOwed) - BigInt(s1.principalOwed) : 0n,
      tails: this.events(receipt, 'CouponTailOpened').map((x) => ({ tailId: BigInt(x.args.tailId), from: BigInt(x.args.fromEpoch), through: BigInt(x.args.throughEpoch), shares: BigInt(x.args.shares) })),
    };
  }

  /**
   * Whether this run may move the threat stage: its key governs the parameter
   * set and, where the stage is the ecosystem phase's (item 129), operates
   * the phase double. Never where core's ArkPhase is read: a phase step is a
   * 30-day timelock operation (helpers/phase.js).
   */
  async governsParams() {
    if (!this._stages) this._stages = await stageKit(this.ctx);
    return this._stages.may();
  }

  /**
   * One threat-stage step, `from` to `to`, in force from the next boundary,
   * waiting out the epoch where one was voted already. A parameter set from
   * before item 129 takes the vote itself; on the phase double the kit puts
   * the phase whose stage is `to` in force, or votes the band of phase 2.
   */
  async stepStage(from, to) {
    const ctx = this.ctx;
    if (!this._stages) this._stages = await stageKit(ctx);
    const last = BigInt(await this.paramsView('lastStageEpoch').catch(() => 0n));
    if (last === (await ctx.originEpoch())) await ctx.waitEpochs(1);
    const effective = await this._stages.step(from, to);
    ctx.note(`threat stage ${from} -> ${to}${this._stages.kind === 'legacy' ? ' voted' : ` (${this._stages.kind} phase)`}, in force from epoch ${effective}`);
    return BigInt(effective);
  }

  /**
   * Several findings asserted together, each at its quoted deposit, and
   * closed unchallenged when their challenge windows end: `ctx.assertUnchallenged`
   * for a claim the court hears in pieces (one determination is bounded by
   * the verdict bound, I24′). The juror pool is opened once for every seat.
   * Unsliced findings only. Returns the case ids.
   */
  async assertMany(kind, payloads, label) {
    const ctx = this.ctx;
    const findings = await ctx.court('FINDINGS');
    const fAbi = iface('ArkCourtFindings', qrlBuild(ctx.r.manifest.profile));
    const quote = (p) => ctx.qrl.call(findings, fAbi, 'quote', [kind, p]);
    let seats = 0n;
    for (const p of payloads) {
      const q = await quote(p);
      if (BigInt(q[4]) !== 1n) throw new Error('assertMany takes unsliced findings only');
      seats += BigInt(q[2]);
    }
    await ctx.openJurorPool(seats);
    const ids = [];
    let closes = 0n;
    const day = BigInt(await ctx.court('COURT_DAY'));
    for (const p of payloads) {
      const q = await quote(p);
      await ctx.courtSend('assertFinding', [kind, p, '0x' + '00'.repeat(32)], { value: BigInt(q[3]) });
      const id = await ctx.court('caseAt', [BigInt(await ctx.court('caseCount'))]);
      const c = await ctx.court('caseOf', [id]);
      const end = BigInt(c.openedAt) + BigInt(c.challengeDays) * day;
      if (end > closes) closes = end;
      ids.push(id);
    }
    ctx.note(`${label}: ${ids.length} finding(s) asserted, unchallenged until ${closes}`);
    await ctx.waitFor(`the challenge windows of ${label}`, async () => (await ctx.qrl.head()).timestamp >= closes, { timeoutEpochs: 3 });
    for (let i = 0; i < ids.length; i++) await ctx.courtSend('finalize', [ids[i], payloads[i]]);
    return ids;
  }

  /* ---------------------------------------------------------- harness stand-ins */

  /**
   * A staking reward reaching the pool, on the harness only: the pool's
   * balance is raised without a call, which is how a validator's withdrawal
   * credits an account. The relayer's keeper then harvests it for the
   * holders (`keepStaking`): harvest, the pool settles, the staking contract
   * claims and passes it to the bond as `creditDistribution`.
   */
  async creditPoolReward(amount) {
    if (!this.harness) throw new Error('a staking reward is credited by hand on the harness only');
    const { createAddressFromString } = require('@ethereumjs/util');
    const sm = this.ctx.qrl.chain.vm.stateManager;
    const addr = createAddressFromString(this.q.ArkStakingPool);
    const acc = await sm.getAccount(addr);
    acc.balance += BigInt(amount);
    await sm.putAccount(addr, acc);
    this.ctx.note(`stand-in: ${amount / ONE} QRL of validator reward credited to the pool's balance (harness)`);
  }

  /** Wait for the staking distribution to reach the holders' pot: `freePool` rises. Returns the rise. */
  async awaitDistribution(label, before, timeoutEpochs = 3) {
    let rise = 0n;
    await this.ctx.waitFor(label, async () => {
      rise = BigInt((await this.state()).freePool) - before;
      return rise > 0n;
    }, { timeoutEpochs });
    return rise;
  }

  /**
   * Proceeds for the coupon, every epoch, on the harness: the mock asset
   * yields `units` each epoch and the reference solver, a sidecar with an
   * account of its own, quotes every offering at the reserve; the relayer
   * selects, seals, carries the secret and the ledger is credited. On a live
   * chain both are the deployment's own (real yield, `ark-solver.service`).
   * Returns a stop function.
   */
  async startPremiumMarket(asset, { units }) {
    const ctx = this.ctx;
    if (!this.harness) return () => {};
    const { Solver, SolverService } = require('../../../ecdsa-stakings/relayer/engine/solver');
    const { revealBudgetSeconds } = require('../../../ecdsa-stakings/relayer/lib/epoch');
    const SOLVER = '0x' + '5f'.repeat(20);
    await ctx.qrl.transfer(SOLVER, 10_000_000n * ONE);
    const account = harnessAccount(ctx.qrl, SOLVER);
    const swapAbi = iface('PremiumSwap', qrlBuild(ctx.r.manifest.profile));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-bond-solver-'));
    const quiet = () => {};
    const svc = new SolverService({
      chain: ctx.r.chain,
      qrl: account,
      origin: account,
      assets: [{ symbol: asset.symbol, address: asset.asset, escrow: asset.escrow }],
      deployment: () => ({ qrl: ctx.r.q, qrlGenesisHash: ctx.r.deployment.qrlGenesisHash }),
      makeSolver: (_x, swap) =>
        new Solver({
          qrl: account,
          origin: account,
          swap,
          swapAbi,
          chainId: ctx.r.chainId,
          escrow: { asset: asset.asset, escrow: asset.escrow, abi: asset.abi },
          recipient: SOLVER,
          clock: ctx.clock,
          revealBudget: revealBudgetSeconds(ctx.r.manifest, 60),
          relay: ctx.r.relay,
          relayAbi: ctx.r.abi.relay,
          errors: ctx.r.errors,
          log: quiet,
        }),
      clock: ctx.clock,
      dir,
      relay: ctx.r.relay,
      relayAbi: ctx.r.abi.relay,
      lookbackBlocks: 1_000_000n,
      maxLotValue: null,
      carryAfter: ctx.clock.day,
      errors: ctx.r.errors,
      log: quiet,
      warn: quiet,
    }).lock();
    let yielded = null;
    const side = async () => {
      const e = await ctx.originEpoch();
      if (yielded !== e) {
        yielded = e;
        if (asset.rebasing) await asset.token.send('rebase', [units]);
        else await asset.token.send('mint', [asset.escrow, units]);
      }
      await svc.tick();
    };
    ctx.sidecars.push(side);
    ctx.note(`stand-in: ${asset.symbol} yields ${units} units each epoch, and the reference solver quotes every offering (harness)`);
    return () => {
      ctx.sidecars.splice(ctx.sidecars.indexOf(side), 1);
      svc.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
  }
}

module.exports = { BondKit, TERM, CLASS, V3_EVENTS, same };
