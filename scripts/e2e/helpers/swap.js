/**
 * What the atomic premium swap scenarios of audit round OC (2026-10-03) share:
 * `swap-live` and `swap-preemption` (docs/review/audit-2026-10-03/SWAP/REPORT.md,
 * "On-chain scenarios needed" S2-S5 and the I31/I33/I7 probes).
 *
 * Everything here runs against both legs exactly as a scenario does: the
 * relayer in-process, every solver an account of its own (`ctx.actor`, which
 * on a live QRL node is a key of its own), every wait derived from the clock
 * the contracts number epochs by, never a fixed number of seconds.
 *
 * Two levers are the scenarios' own and touch no engine code:
 *  - `withholdCarry` keeps the relayer from carrying one lot's preimage: the
 *    secret its origin scan reads is swallowed for that lot only, as a
 *    finality delay beyond the claim margin would (OC-SWAP-05);
 *  - `crashAfter` makes a client die right after one kind of send landed, as
 *    a process killed between a transaction and the line that records it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ScenarioError, ONE } = require('../lib');
const { iface, qrlBuild, parseLogs, QRL_EVENTS } = require('../../lib/chains');
const { Solver, SolverService } = require('../../../ecdsa-stakings/relayer/engine/solver');
const { revealBudgetSeconds } = require('../../../ecdsa-stakings/relayer/lib/epoch');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const ids = require('../../../ecdsa-stakings/relayer/lib/identifiers');

const BPS = 10_000n;
const STATUS = ['None', 'Quoted', 'Selected', 'Claimed', 'Refunded', 'Evicted'];
/** QRL a solver account keeps for gas beyond what it locks; the service's own default reserve is 50. */
const GAS_QRL = 100n * ONE;

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
const lower = (v) => String(v).toLowerCase();
const sameAccount = (a, b) => {
  try {
    return lower(toHex(a)) === lower(toHex(b));
  } catch {
    return lower(a) === lower(b);
  }
};

/* ------------------------------------------------------------------ events */

/**
 * The QRL-leg events the probes read, as the v3 decoder needs them (64-byte
 * slots); on the harness and the enclave stand-in the ABI decodes them and
 * this table is not consulted (`Relayer.parseQrl`).
 */
const SWAP_EVENTS = {
  ...QRL_EVENTS.PremiumSwap,
  OfferingCarried: {
    signature: 'OfferingCarried(bytes32,uint256,uint256,uint256,uint256)',
    topics: [
      { name: 'key', type: 'bytes32' },
      { name: 'epoch', type: 'uint256' },
    ],
    data: [
      { name: 'units', type: 'uint256' },
      { name: 'threshold', type: 'uint256' },
      { name: 'carriedEpochs', type: 'uint256' },
    ],
  },
  BondsForfeited: {
    signature: 'BondsForfeited(uint256,uint256)',
    topics: [{ name: 'epoch', type: 'uint256' }],
    data: [{ name: 'amount', type: 'uint256' }],
  },
};

const LEDGER_EVENTS = {
  ProceedsDelivered: {
    signature: 'ProceedsDelivered(uint256,address,uint256)',
    topics: [
      { name: 'epoch', type: 'uint256' },
      { name: 'from', type: 'address' },
    ],
    data: [{ name: 'amount', type: 'uint256' }],
  },
  ProceedsDrawn: {
    signature: 'ProceedsDrawn(uint256,address,uint256)',
    topics: [
      { name: 'epoch', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    data: [{ name: 'amount', type: 'uint256' }],
  },
  ResidueCarried: {
    signature: 'ResidueCarried(uint256,uint256,uint256)',
    topics: [
      { name: 'fromEpoch', type: 'uint256' },
      { name: 'toEpoch', type: 'uint256' },
    ],
    data: [{ name: 'amount', type: 'uint256' }],
  },
  BondsForfeited: SWAP_EVENTS.BondsForfeited,
};

const COUPON_EVENTS = {
  CouponDistributed: {
    signature: 'CouponDistributed(uint256,uint256,uint256,uint256,bool)',
    topics: [{ name: 'epoch', type: 'uint256' }],
    data: [
      { name: 'poolCouponBps', type: 'uint256' },
      { name: 'juniorAmount', type: 'uint256' },
      { name: 'seniorAmount', type: 'uint256' },
      { name: 'seniorShortfall', type: 'bool' },
    ],
  },
};

/* ------------------------------------------------------------------ the kit */

/**
 * The swap as one asset's scenario sees it: views, events, the clock's four
 * instants of an offering, and the ledger and coupon events beside them.
 */
function swapKit(ctx, a) {
  const q = ctx.r.q;
  if (!q.PremiumSwap) throw new ScenarioError('this QRL leg has no PremiumSwap; redeploy it');
  const build = qrlBuild(ctx.r.manifest.profile);
  const swapAbi = iface('PremiumSwap', build);
  const ledgerAbi = ctx.r.abi.ledger;
  const couponAbi = ctx.r.abi.coupon;
  const chainId = ctx.r.chainId;
  const assetArg = ctx.r.evmArg(a.asset);
  const clock = ctx.clock;

  const raw = (m, args = []) => ctx.qrl.call(q.PremiumSwap, swapAbi, m, args);
  const view = async (m, args = []) => (await raw(m, args))[0];
  const qrlEvents = async (contract, abi, table, fromBlock) => {
    const head = await ctx.qrl.head();
    return ctx.r.parseQrl(table, abi, await ctx.qrl.logs(contract, big(fromBlock), head.latest));
  };

  const kit = {
    a,
    q,
    swapAbi,
    chainId,
    assetArg,
    view,
    raw,
    /** The four instants of offering `t`, by the relayer's clock (the contract's are probed in I31.1). */
    times(t) {
      t = big(t);
      return { qo: clock.quoteOpens(t), qc: clock.quoteCloses(t), evmExpiry: clock.evmExpiry(t), qrlExpiry: clock.settlementCloses(t) };
    },
    async timetable(t) {
      const r = await raw('timetable', [big(t)]);
      return { quoteOpens: big(r[0]), quoteCloses: big(r[1]), evmExpiry: big(r[2]), qrlExpiry: big(r[3]) };
    },
    offering: (t) => view('offeringOf', [chainId, assetArg, big(t)]),
    available: (t) => view('available', [chainId, assetArg, big(t)]).then(big),
    required: (t, shares) => view('required', [chainId, assetArg, big(t), big(shares)]).then(big),
    async bondFor(t, value) {
      const r = await raw('bondFor', [chainId, assetArg, big(t), big(value)]);
      return big(r[0]);
    },
    lotOf: (lotId) => view('lotOf', [lotId]),
    async status(lotId) {
      return STATUS[Number((await view('lotOf', [lotId])).status)];
    },
    bondsAtRisk: (t) => view('bondsAtRisk', [big(t)]).then(big),
    key: () => view('assetKey', [chainId, assetArg]),
    async failed() {
      return big(await view('failedOfferings', [await kit.key()]));
    },
    swapEvents: (fromBlock) => qrlEvents(q.PremiumSwap, swapAbi, SWAP_EVENTS, fromBlock),
    ledgerEvents: (fromBlock) => qrlEvents(q.ProceedsLedger, ledgerAbi, LEDGER_EVENTS, fromBlock),
    couponEvents: (fromBlock) => (q.ArkBondCoupon ? qrlEvents(q.ArkBondCoupon, couponAbi, COUPON_EVENTS, fromBlock) : []),
    /** Origin-chain events of this asset's escrow since `fromBlock`. */
    async escrowEvents(fromBlock, name) {
      const head = await ctx.origin.head();
      return parseLogs(a.abi, await ctx.origin.logs(a.escrow, big(fromBlock), head.latest)).filter((x) => !name || x.name === name);
    },
    /** The batching threshold in base units: the params in force (`ArkStakeMath.offeringBatchThresholdUnits`). */
    async batchThreshold() {
      const p = (await ctx.qrl.call(q.ArkStakeParams, ctx.r.abi.params, 'swapParams'))[0];
      return (big(p.offeringBatchMultiple) * big(p.claimCostGwei) * ONE) / 1_000_000_000n;
    },
    /** The juror fraction of a lot of `value` once claimed (none where the swap names no fee pool). */
    async feeOf(t, value) {
      const pool = await view('FEE_POOL');
      if (/^(0x|Q)0*$/i.test(String(pool))) return 0n;
      return (big(value) * big((await kit.offering(t)).jurorBps)) / BPS;
    },
  };
  return kit;
}

/* ------------------------------------------------------------------ time */

/** Seconds between two ticks of a fine wait: a twelfth of a day, never more than the run's poll. */
function stepOf(ctx) {
  return BigInt(Math.max(1, Math.floor(Math.min(ctx.pollSeconds, Number(ctx.clock.day) / 12))));
}

async function nowOn(ctx, leg = 'qrl') {
  return big((await (leg === 'origin' ? ctx.origin : ctx.qrl).head()).timestamp);
}

/**
 * Tick until `leg`'s clock reaches `ts`, and return its time then. The last
 * act is a wait, never a tick, so the state at `ts` is the state the last tick
 * before it left; with `quiet` no tick is made in the last `quiet` seconds
 * either (on a live chain a tick takes time of its own).
 */
async function until(ctx, ts, { leg = 'qrl', tick = true, quiet = 0n } = {}) {
  ts = big(ts);
  const step = stepOf(ctx);
  for (;;) {
    let now = await nowOn(ctx, leg);
    if (now >= ts) return now;
    if (tick && ts - now > big(quiet)) {
      await ctx.tick();
      now = await nowOn(ctx, leg);
      if (now >= ts) return now;
    }
    const gap = ts - now;
    await ctx.sleep(Number(gap < step ? gap : step));
  }
}

/** `ctx.waitFor` at the fine step: tick until `predicate()` holds, within `timeoutEpochs` of the origin clock. */
async function waitFine(ctx, label, predicate, { timeoutEpochs = 3, throws = true } = {}) {
  const deadline = (await nowOn(ctx, 'origin')) + ctx.clock.EPOCH_LENGTH * BigInt(timeoutEpochs);
  const step = stepOf(ctx);
  for (;;) {
    await ctx.tick();
    if (await predicate()) {
      ctx.note(`waited for: ${label}`);
      return true;
    }
    if ((await nowOn(ctx, 'origin')) > deadline) {
      if (throws) throw new ScenarioError(`timed out after ${timeoutEpochs} epochs waiting for: ${label}`);
      ctx.note(`gave up waiting for: ${label}`);
      return false;
    }
    await ctx.sleep(Number(step));
  }
}

/* ------------------------------------------------------------------ the pot */

/**
 * Seed, anchor, record the allocation, put yield in the escrows and wait for
 * each one's premium to be offered and recorded on QRL (atomic-yield-flow's
 * opening, for any number of assets at once). Returns the offered epoch per
 * asset and the origin block the yield went in at.
 */
async function openOfferings(ctx, assets, { notional = 1000n * ONE, yieldUnits = 40n * ONE } = {}) {
  const out = [];
  for (const a of assets) {
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, notional);
    await ctx.waitAnchorRecorded(anchored.id);
    out.push({ a, anchored });
  }
  const epoch0 = await ctx.originEpoch();
  for (const { a } of out) {
    await ctx.waitFor(`the allocation of epoch ${epoch0} recorded in ${a.symbol}'s escrow`, async () => big((await a.call('recordedAllocation')).epoch) >= epoch0, { sealNow: true });
  }
  const fromBlock = (await ctx.origin.head()).latest;
  for (const { a } of out) {
    if (a.mock) await ctx.produceYield(a, yieldUnits);
    else ctx.note(`${a.symbol} is not a double: its yield arrives on its own`);
  }
  for (const { a } of out) await ctx.waitFor(`${a.symbol}'s yield swept into the premium pot`, async () => (await a.call('auctionShares')) > 0n, { timeoutEpochs: a.mock ? 12 : 26 });
  for (const o of out) {
    const offered = async () => {
      const evs = parseLogs(o.a.abi, await ctx.origin.logs(o.a.escrow, fromBlock, (await ctx.origin.head()).latest)).filter((x) => x.name === 'PremiumOffered');
      return evs.length ? evs[0].args : null;
    };
    await ctx.waitFor(`${o.a.symbol}'s escrow offered its premium`, async () => Boolean(await offered()));
    o.offer = await offered();
    o.t = big(o.offer.epoch);
  }
  for (const o of out) {
    const k = swapKit(ctx, o.a);
    // The swap opens an offering only on premium new since the last one
    // (SWAPGOV-01), batching up to its bound. A double yields every epoch, so
    // the first offer is recorded; a real asset (stETH on Hoodi) yields at the
    // daily rebase and repeats the same pot in between, so the offering that
    // opens is a later epoch's. Wait for the first one recorded from o.t on.
    const first = o.t;
    // Only an offering whose quote window (the epoch after its own) is not yet
    // past: one recorded earlier has been judged without this run's lots.
    await ctx.waitFor(`${o.a.symbol}'s first offering from epoch ${first} recorded on QRL`, async () => {
      const now = await ctx.originEpoch();
      for (let e = first > now - 1n ? first : now - 1n; e <= now; e += 1n) {
        if ((await k.offering(e)).recorded) {
          o.t = e;
          return true;
        }
      }
      return false;
    }, { timeoutEpochs: o.a.mock ? 8 : 26 });
    o.k = k;
  }
  return { offerings: out, fromBlock };
}

/** Units of each `PremiumOffered` of the escrow since `fromBlock`, by epoch. */
async function offeredUnits(k, fromBlock) {
  const out = {};
  for (const e of await k.escrowEvents(fromBlock, 'PremiumOffered')) out[String(e.args.epoch)] = { shares: big(e.args.shares), units: big(e.args.units), blockNumber: e.blockNumber };
  return out;
}

/* ------------------------------------------------------------------ solvers */

/** A solver account on the QRL leg (its own key on a live node), with an origin-chain recipient. */
function rawSolver(ctx, k, client, recipient, { origin = ctx.origin, log = (m) => ctx.note(m) } = {}) {
  const { a } = k;
  return new Solver({
    qrl: client,
    origin,
    swap: k.q.PremiumSwap,
    swapAbi: k.swapAbi,
    chainId: k.chainId,
    escrow: { asset: a.asset, escrow: a.escrow, abi: a.abi },
    recipient,
    clock: ctx.clock,
    relay: ctx.r.relay,
    relayAbi: ctx.r.abi.relay,
    fromBlock: big(ctx.r.manifest.deployedFromBlock || 0),
    errors: ctx.r.errors,
    log,
  });
}

/** Top the actor up to `amount` (actor() only ever tops up). */
function fund(ctx, label, amount) {
  return ctx.actor(label, { fund: amount });
}

/**
 * Quote a lot of `shares` at the reserve the views give now, with `extra`
 * QRL above what the swap computes (it must come straight back, I33.1).
 * Returns the lot (secret included) and what the swap's balance moved by.
 */
async function quoteLot(ctx, k, label, solver, t, shares, { extra = 0n } = {}) {
  const lot = await solver.prepare(t, shares);
  const client = await fund(ctx, label, lot.value + lot.bond + extra + GAS_QRL);
  const head = await ctx.qrl.head();
  const before = big(await ctx.qrl.balance(k.q.PremiumSwap));
  await client.send(k.q.PremiumSwap, k.swapAbi, 'quote', solver.quoteArgs(lot), { value: lot.value + lot.bond + extra });
  const after = big(await ctx.qrl.balance(k.q.PremiumSwap));
  // Another lot's quote, claim or refund mined after the first read would move the balance too.
  const others = (await k.swapEvents(head.latest)).filter((e) => ['LotQuoted', 'LotRefunded', 'LotClaimed'].includes(e.name) && big(e.blockNumber) > big(head.latest) && lower(e.args.lotId) !== lower(lot.lotId));
  const status = await k.status(lot.lotId);
  if (status !== 'Quoted') throw new ScenarioError(`${label}: the swap holds lot ${lot.lotId} as ${status}, not Quoted`);
  ctx.note(`${label}: quoted ${lot.shares} shares of ${k.a.symbol} at ${lot.value} planck, bond ${lot.bond}${extra ? `, ${extra} sent above` : ''}`);
  return { lot, delta: after - before, alone: others.length === 0 };
}

/**
 * Keep the relayer from carrying one lot's revealed preimage to QRL: its
 * origin scan writes the secret into the lot's record (`PremiumClaimed`), and
 * here that write is kept aside. `seen` is the secret the relayer read;
 * `release(secret)` hands it over late, as a carry after the margin would be.
 */
function withholdCarry(ctx, lotId) {
  const w = ctx.r.lotRecord(lotId);
  let seen = null;
  Object.defineProperty(w, 'secret', {
    configurable: true,
    enumerable: false,
    get: () => undefined,
    set: (v) => {
      seen = v;
    },
  });
  return {
    get seen() {
      return seen;
    },
    release(secret = null) {
      delete w.secret;
      const s = secret || seen;
      if (s) w.secret = s;
      return s;
    },
  };
}

/**
 * `client`, except that the first `method` send after `arm()` lands and then
 * throws — a process killed between its transaction and the line recording it.
 */
function crashAfter(client, method) {
  const c = { armed: false, fired: 0, receipt: null };
  c.client = new Proxy(client, {
    get(target, prop) {
      if (prop === 'send') {
        return async (to, abi, m, args, opts) => {
          const receipt = await target.send(to, abi, m, args, opts);
          if (c.armed && m === method) {
            c.armed = false;
            c.fired += 1;
            c.receipt = receipt;
            throw new Error(`the process died after its ${m} landed`);
          }
          return receipt;
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  c.arm = () => {
    c.armed = true;
    return c;
  };
  return c;
}

/**
 * The reference solver service as a process that can die and come back from
 * its state file. Its QRL account is `qrl` (an actor); its origin sends go
 * through `origin`. A crash armed on either client kills it the tick it fires;
 * `restartWhen(now)` decides, each tick while it is down, whether it is back.
 */
class SolverProcess {
  constructor(ctx, k, { name, qrl, origin, recipient, shareBps = 1_000n, carryAfter = 0n, fromBlock = 0n, restartWhen = null }) {
    Object.assign(this, { ctx, k, name, qrlCrash: qrl, originCrash: origin, recipient, restartWhen });
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `ark-oc-${name}-`));
    this.lines = [];
    this.starts = [];
    this.deaths = [];
    const a = k.a;
    const log = (m) => {
      this.lines.push(m);
      if (/ALARM|WARNING/.test(m)) ctx.note(`${name}: ${m.trim()}`);
    };
    this.make = () =>
      new SolverService({
        chain: ctx.r.chain,
        qrl: qrl.client,
        origin: origin.client,
        assets: [{ symbol: a.symbol, address: a.asset, escrow: a.escrow }],
        deployment: () => ({ qrl: ctx.r.q, qrlGenesisHash: ctx.r.deployment.qrlGenesisHash }),
        makeSolver: (asset, swap) =>
          new Solver({
            qrl: qrl.client,
            origin: origin.client,
            swap,
            swapAbi: k.swapAbi,
            chainId: k.chainId,
            escrow: { asset: a.asset, escrow: a.escrow, abi: a.abi },
            recipient,
            clock: ctx.clock,
            revealBudget: revealBudgetSeconds(ctx.r.manifest, 60),
            relay: ctx.r.relay,
            relayAbi: ctx.r.abi.relay,
            fromBlock,
            errors: ctx.r.errors,
            log,
          }),
        clock: ctx.clock,
        dir: this.dir,
        relay: ctx.r.relay,
        relayAbi: ctx.r.abi.relay,
        fromBlock,
        lookbackBlocks: 1_000_000n,
        shareBps,
        maxLotValue: null,
        carryAfter,
        errors: ctx.r.errors,
        log,
        warn: log,
      }).lock();
    this.svc = null;
  }

  async start() {
    this.svc = this.make();
    this.last = this.svc;
    this.starts.push(await nowOn(this.ctx, 'origin'));
    if (this.starts.length > 1) this.ctx.note(`${this.name}: restarted from its state file (start ${this.starts.length})`);
  }

  get up() {
    return Boolean(this.svc);
  }

  /** Its state as the running process holds it, or as the dead one left it on disk. */
  get state() {
    return (this.svc || this.last).state;
  }

  kill(why) {
    if (!this.svc) return;
    this.svc.close();
    this.svc = null;
    this.ctx.note(`${this.name}: killed: ${why}`);
  }

  /** Run as a sidecar: one pass of the service, a death where a crash fired, a restart where due. */
  async tick() {
    const now = await nowOn(this.ctx, 'origin');
    if (this.closed) return;
    if (!this.svc) {
      if (this.restartWhen && this.deaths.length && this.restartWhen(now, this.deaths[this.deaths.length - 1])) await this.start();
      else return;
    }
    const [q0, o0] = [this.qrlCrash.fired, this.originCrash.fired];
    try {
      await this.svc.tick();
    } catch (e) {
      this.lines.push(`tick threw: ${e.message}`);
    }
    if (this.originCrash.fired > o0 || this.qrlCrash.fired > q0) {
      this.deaths.push({ at: now, after: this.originCrash.fired > o0 ? 'origin' : 'qrl' });
      this.kill(this.originCrash.fired > o0 ? 'right after its origin claim landed, before it recorded it' : 'right after its QRL carry was sent, before its receipt');
    }
  }

  lot() {
    const s = this.state;
    return s.lots[0] || s.done[s.done.length - 1] || null;
  }

  done(lotId) {
    return this.state.done.find((x) => x.lotId === lotId) || null;
  }

  close() {
    this.closed = true;
    this.kill('its part of the scenario is over');
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* a report, not state */
    }
  }
}

/* ------------------------------------------------------------------ probes */

/**
 * Where a premium lock was sealed: the epoch of the admitted root that
 * carries it (relayer state, which the relay's published leaves mirror) and
 * the origin-chain time that root was admitted at (`EpochRootAdmitted`).
 */
async function lockAdmission(ctx, leaf, fromBlock) {
  const epochs = ctx.epochsCarrying(leaf);
  if (!epochs.length) return null;
  const epoch = epochs[0];
  const head = await ctx.origin.head();
  const ev = parseLogs(ctx.r.abi.relay, await ctx.origin.logs(ctx.r.relay, big(fromBlock), head.latest)).find((x) => x.name === 'EpochRootAdmitted' && big(x.args.epoch) === epoch);
  const at = ev ? big(await ctx.origin.timestampOf(ev.blockNumber)) : null;
  const published = parseLogs(ctx.r.abi.relay, await ctx.origin.logs(ctx.r.relay, big(fromBlock), head.latest)).some(
    (x) => x.name === 'LeavesPublished' && big(x.args.epoch) === epoch && [...x.args.leaves].some((l) => lower(l) === lower(leaf)),
  );
  return { epoch, at, published };
}

/**
 * I33.6, conservation: the swap's balance is the value and bond of every lot
 * still Quoted, Selected or Evicted — less the bonds of Selected lots, which
 * `bondsAtRisk` counts — plus the bonds of Claimed lots not yet returned and
 * every epoch's bonds at risk (lapsed and not yet forfeited included).
 */
async function conservation(ctx, k) {
  const from = big(ctx.r.deployment.deployedFromBlock || ctx.r.manifest.deployedFromBlock || 0);
  const lots = new Set();
  const epochs = new Set();
  for (const e of await k.swapEvents(from)) {
    if (e.name !== 'LotQuoted') continue;
    lots.add(e.args.lotId);
    epochs.add(String(e.args.epoch));
  }
  let expected = 0n;
  const by = { Quoted: 0n, Selected: 0n, Evicted: 0n, Claimed: 0n, atRisk: 0n };
  for (const id of lots) {
    const l = await k.lotOf(id);
    const s = STATUS[Number(l.status)];
    if (s === 'Quoted' || s === 'Evicted') by[s] += big(l.value) + big(l.bond);
    else if (s === 'Selected') by.Selected += big(l.value);
    else if (s === 'Claimed') by.Claimed += big(l.bond);
  }
  for (const e of epochs) by.atRisk += await k.bondsAtRisk(e);
  expected = by.Quoted + by.Evicted + by.Selected + by.Claimed + by.atRisk;
  const balance = big(await ctx.qrl.balance(k.q.PremiumSwap));
  return { ok: balance === expected, balance, expected, lots: lots.size, ...by };
}

/** sha256(secret) is the lot's hashlock (I31.5): the same hash on both legs. */
const hashlockOf = (secret) => ids.hashlockOf(secret);

module.exports = {
  BPS,
  GAS_QRL,
  STATUS,
  SWAP_EVENTS,
  LEDGER_EVENTS,
  COUPON_EVENTS,
  big,
  lower,
  sameAccount,
  swapKit,
  stepOf,
  nowOn,
  until,
  waitFine,
  openOfferings,
  offeredUnits,
  rawSolver,
  fund,
  quoteLot,
  withholdCarry,
  crashAfter,
  SolverProcess,
  lockAdmission,
  conservation,
  hashlockOf,
};
