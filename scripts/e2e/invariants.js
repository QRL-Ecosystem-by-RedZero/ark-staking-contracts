/**
 * Read-only invariant checks over a live deployment of both legs.
 *
 * Each check reads deployed state and asserts one predicate of the yellow
 * paper's I-list or core's G-list (docs/review/audit-2026-10-03/INVARIANTS.md
 * and the per-area "Invariant probes" of that round). Nothing here sends a
 * transaction, so it runs after every scenario step, at the end of a scenario,
 * and on its own against a running deployment (scripts/invariants.js --watch).
 *
 * A check whose contract is not deployed, or whose view reverts, is skipped
 * with the reason. A violation that a known, still-open finding predicts is
 * recorded with that finding's id (`known`) and does not fail a scenario; any
 * other violation does, in strict mode.
 */
const { Interface } = require('ethers');
const { qrlBuild, iface } = require('../lib/chains');

/** The ecosystem phase as the parameter set reads it (item 129): written out, so a deployment from before it is checkable. */
const PARAMS_PHASE = new Interface(['function arkPhase() view returns (address)']);
const PHASE_READ = new Interface(['function phase() view returns (uint8)', 'function phaseAt(uint256 epoch) view returns (uint8)', 'function governance() view returns (address)']);
/** `ArkStakeParams.STAGE_OF_PHASE`: phase 2 reads the band 2 - 3. */
const STAGE_OF_PHASE = [1, 1, 2, 4, 1];

const BPS = 10_000n;
const ZERO = '0x' + '0'.repeat(40);

const isZero = (a) => /^0x0*$/.test(String(a));
const same = (a, b) => String(a).toLowerCase().replace(/^q/, '0x') === String(b).toLowerCase().replace(/^q/, '0x');

/** A struct return as a plain object, read by position: a field named like an Array method is shadowed by name (OC-OPS-02). */
function named(abi, method, res) {
  const out = abi.getFunction(method).outputs;
  if (out.length === 1 && out[0].components) {
    const tuple = res[0];
    return Object.fromEntries(out[0].components.map((c, i) => [c.name, tuple[i]]));
  }
  return Object.fromEntries(out.map((o, i) => [o.name || String(i), res[i]]));
}

class Reader {
  constructor(ctx) {
    this.ctx = ctx;
    this.qrl = ctx.qrl;
    this.q = ctx.r.q;
    this.build = qrlBuild(ctx.r.manifest.profile);
  }

  abi(name) {
    return iface(name, this.build);
  }

  /** One value, or the struct as an object. */
  async view(contract, name, method, args = []) {
    const abi = this.abi(name);
    const res = await this.qrl.call(contract, abi, method, args);
    const out = abi.getFunction(method).outputs;
    return out.length === 1 && !out[0].components ? res[0] : named(abi, method, res);
  }

  async epoch() {
    return this.ctx.clock.epochOf((await this.qrl.head()).timestamp);
  }
}

/** Every check: `{ id, inv, run(reader) -> [{ ok, detail, known? }] }`. A check returns [] when it does not apply. */
const CHECKS = [
  {
    id: 'handover',
    inv: 'G2',
    async run(R) {
      const gov = R.ctx.r.deployment.governance;
      const timelock = gov && gov.addresses && gov.addresses.ArkTimelock;
      if (!timelock) return [];
      const out = [];
      for (const [name, key] of [['ArkStakeParams', 'ArkStakeParams'], ['ArkStakeRegistry', 'ArkStakeRegistry'], ['ArkBondDelegation', 'ArkBondDelegation']]) {
        const at = R.q[key];
        if (!at) continue;
        const governance = await R.view(at, name, 'governance');
        const pending = await R.view(at, name, 'pendingGovernance');
        out.push({ ok: same(governance, timelock) && isZero(pending), detail: { contract: name, governance, pending, timelock }, known: 'OC-GOV-03' });
      }
      return out;
    },
  },
  {
    // The stage is the phase's (item 129): STAGE_OF_PHASE outside phase 2, the
    // band 2 - 3 inside it; the parameter set reads the network's ArkPhase
    // where the governance record names one, and the timelock governs that.
    // A parameter set from before ArkPhase has no arkPhase(): nothing to check.
    id: 'phase-stage',
    inv: 'item 129, core §3.6',
    async run(R) {
      const p = R.q.ArkStakeParams;
      if (!p) return [];
      let at;
      try {
        [at] = await R.qrl.call(p, PARAMS_PHASE, 'arkPhase');
      } catch {
        return [];
      }
      const e = await R.epoch();
      const atEpoch = Number((await R.qrl.call(at, PHASE_READ, 'phaseAt', [e]))[0]);
      // In the declaring epoch phase() is already 3 while phaseAt(current) is not.
      const now = Number((await R.qrl.call(at, PHASE_READ, 'phase'))[0]);
      const stage = Number(await R.view(p, 'ArkStakeParams', 'threatStage'));
      const fits = (ph) => (ph === 2 ? stage === 2 || stage === 3 : stage === STAGE_OF_PHASE[ph]);
      const out = [{ ok: fits(atEpoch) || fits(now), detail: { epoch: e, phaseAt: atEpoch, phase: now, stage } }];
      const gov = R.ctx.r.deployment.governance;
      const named = gov && gov.addresses && gov.addresses.ArkPhase;
      if (named) {
        const governance = (await R.qrl.call(at, PHASE_READ, 'governance'))[0];
        out.push({ ok: same(at, named) && same(governance, gov.addresses.ArkTimelock), detail: { params: at, record: named, governance, timelock: gov.addresses.ArkTimelock } });
      }
      return out;
    },
  },
  {
    id: 'params-relations',
    inv: 'I13 I22 I25',
    async run(R) {
      if (!R.q.ArkStakeParams) return [];
      const p = await R.view(R.q.ArkStakeParams, 'ArkStakeParams', 'params');
      const n = (k) => BigInt(p[k]);
      const out = [];
      out.push({ ok: n('premiumSlopeRatioBps') >= 2500n && n('premiumSlopeRatioBps') <= BPS, detail: { I13: n('premiumSlopeRatioBps') } });
      const ceiling = n('premiumCeilingBps');
      const surge = n('surgeCeilingBps');
      out.push({
        ok: n('threatStage4Bps') < ceiling && ceiling <= BPS - n('bufferBps') - n('operationsBps') && ceiling < surge && surge <= BPS - n('operationsBps') - 1000n,
        detail: { I22: { stage4: n('threatStage4Bps'), ceiling, surge, buffer: n('bufferBps'), ops: n('operationsBps') } },
      });
      const release = n('releaseBoundBps');
      const ladder = n('maturityLadderBps');
      const maxExit = R.q.ArkStakeRegistry ? BigInt(await R.view(R.q.ArkStakeRegistry, 'ArkStakeRegistry', 'maxAssetExitBps')) : 0n;
      out.push({ ok: release > 0n && ladder <= BPS / (3n + (BPS + release - 1n) / release) && maxExit <= release && release <= 2500n, detail: { I25: { ladder, release, maxExit } } });
      if (R.q.ArkStakeRegistry) {
        const a = await R.view(R.q.ArkStakeRegistry, 'ArkStakeRegistry', 'allocation');
        const sum = BigInt(a.premiumBps) + BigInt(a.bufferBps) + BigInt(a.operationsBps) + BigInt(a.levyBps);
        out.push({ ok: sum <= BPS, detail: { I22_allocation: { premium: a.premiumBps, buffer: a.bufferBps, ops: a.operationsBps, levy: a.levyBps } } });
      }
      return out;
    },
  },
  {
    id: 'registry-book',
    inv: 'I18',
    async run(R) {
      const reg = R.q.ArkStakeRegistry;
      if (!reg) return [];
      // Matched on the high 32 bytes of each slot, so a QIP-55 log (64-byte
      // slots, a bytes32 left-aligned) reads like a 32-byte one: ethers'
      // parseLog would skip every v3 log and report an empty book.
      const topic0 = R.abi('ArkStakeRegistry').getEvent('Anchored').topicHash.toLowerCase();
      const head = await R.qrl.head();
      const from = BigInt(R.ctx.r.deployment.deployedFromBlock || 0);
      const ids = new Set(
        (await R.qrl.logs(reg, from, head.latest))
          .filter((l) => String(l.topics[0]).slice(0, 66).toLowerCase() === topic0)
          .map((l) => String(l.topics[1]).slice(0, 66).toLowerCase()),
      );
      let anchored = 0n;
      let transit = 0n;
      for (const id of ids) {
        const a = await R.view(reg, 'ArkStakeRegistry', 'anchorOf', [id]);
        if (Number(a.status) === 1) anchored += BigInt(a.anchoredNotional);
        if (Number(a.status) === 2) transit += BigInt(a.anchoredNotional);
      }
      const totalAnchored = BigInt(await R.view(reg, 'ArkStakeRegistry', 'totalAnchored'));
      const totalInTransit = BigInt(await R.view(reg, 'ArkStakeRegistry', 'totalInTransit'));
      return [{ ok: anchored === totalAnchored && transit === totalInTransit, detail: { positions: ids.size, anchored, totalAnchored, transit, totalInTransit } }];
    },
  },
  {
    id: 'venue-solvency',
    inv: 'I21 I32',
    async run(R) {
      const d = R.q.ArkBondDelegation;
      if (!d) return [];
      const v = async (m) => BigInt(await R.view(d, 'ArkBondDelegation', m));
      const balance = BigInt(await R.qrl.balance(d));
      const idle = await v('idle');
      const bonds = await v('bondsHeld');
      const refunds = await v('refundsOwed');
      const reconciled = await v('distributionReconciled');
      const distributed = await v('distributed');
      const owed = idle + bonds + refunds + (reconciled > distributed ? reconciled - distributed : 0n);
      const out = [{ ok: balance >= owed, detail: { balance, idle, bondsHeld: bonds, refundsOwed: refunds, distributionReconciled: reconciled, distributed } }];
      // I32 against the cap each forward was made under (the event carries
      // it): `rewardCap()` read now halves when a validator closes mid-epoch,
      // which would flag a forward that was inside its cap when made.
      const topic0 = R.abi('ArkBondDelegation').getEvent('ProvisionallyDistributed').topicHash.toLowerCase();
      const head = await R.qrl.head();
      const from = BigInt(R.ctx.r.deployment.deployedFromBlock || 0);
      const wide = R.qrl.kind === 'qrl';
      const word = (hex, i) => BigInt('0x' + hex.slice(i * (wide ? 128 : 64), (i + 1) * (wide ? 128 : 64)));
      const perEpoch = new Map();
      for (const l of await R.qrl.logs(d, from, head.latest)) {
        if (String(l.topics[0]).slice(0, 66).toLowerCase() !== topic0) continue;
        const epoch = BigInt(l.topics[2]);
        const data = String(l.data).replace(/^0x/, '');
        const e = perEpoch.get(epoch) || { amount: 0n, cap: 0n };
        e.amount += word(data, 0);
        e.cap = word(data, 1) > e.cap ? word(data, 1) : e.cap;
        perEpoch.set(epoch, e);
      }
      for (const [epoch, e] of perEpoch) out.push({ ok: e.amount <= e.cap, detail: { I32: { epoch, forwarded: e.amount, cap: e.cap } } });
      return out;
    },
  },
  {
    id: 'pool-book',
    inv: 'I21',
    async run(R) {
      const p = R.q.ArkStakingPool;
      if (!p) return [];
      const v = async (m) => BigInt(await R.view(p, 'ArkStakingPool', m));
      const balance = BigInt(await R.qrl.balance(p));
      const reserved = await v('reserved');
      const locked = await v('lockedShares');
      const total = await v('totalShares');
      const head = await v('queueHead');
      const next = await v('nextRequest');
      return [{ ok: balance >= reserved && locked <= total && head <= next, detail: { balance, reserved, lockedShares: locked, totalShares: total, queueHead: head, nextRequest: next } }];
    },
  },
  {
    id: 'bond-backing',
    inv: 'I21',
    async run(R) {
      const b = R.q.ArkCatBond;
      if (!b) return [];
      const s = await R.view(b, 'ArkCatBond', 'state');
      const placed = BigInt(await R.view(b, 'ArkCatBond', 'placedWithStaking'));
      const balance = BigInt(await R.qrl.balance(b));
      // The fourth pot, the Cushion (I42); zero on a bond built before it.
      const cushion = BigInt(await R.view(b, 'ArkCatBond', 'cushion').catch(() => 0n));
      const owed = BigInt(s.juniorPrincipal) + BigInt(s.seniorPrincipal) + BigInt(s.freePool) + BigInt(s.principalOwed) + cushion;
      return [{ ok: balance + placed >= owed, detail: { balance, placed, juniorPrincipal: s.juniorPrincipal, seniorPrincipal: s.seniorPrincipal, freePool: s.freePool, principalOwed: s.principalOwed, cushion } }];
    },
  },
  {
    id: 'bond-clock',
    inv: 'liveness (OC-ECON-05)',
    async run(R) {
      const b = R.q.ArkCatBond;
      if (!b) return [];
      const s = await R.view(b, 'ArkCatBond', 'state');
      if (BigInt(s.juniorShares) + BigInt(s.seniorShares) === 0n) return [];
      const now = await R.epoch();
      return [{ ok: BigInt(s.lastClosedEpoch) + 32n >= now, detail: { lastClosedEpoch: s.lastClosedEpoch, epoch: now }, known: 'OC-ECON-05' }];
    },
  },
  {
    id: 'ledger',
    inv: 'I7',
    async run(R) {
      const l = R.q.ProceedsLedger;
      if (!l) return [];
      const now = await R.epoch();
      const out = [];
      for (let t = now - 4n; t <= now; t++) {
        if (t <= 0n) continue;
        const delivered = BigInt(await R.view(l, 'ProceedsLedger', 'deliveredIn', [t]));
        const remaining = BigInt(await R.view(l, 'ProceedsLedger', 'remainingIn', [t]));
        const sealed = await R.view(l, 'ProceedsLedger', 'isSealed', [t]);
        out.push({ ok: remaining <= delivered && (!sealed || remaining === 0n), detail: { epoch: t, delivered, remaining, sealed } });
      }
      return out;
    },
  },
  {
    id: 'swap-timetable',
    inv: 'I31',
    async run(R) {
      const s = R.q.PremiumSwap;
      if (!s) return [];
      const t = await R.epoch();
      const a = await R.view(s, 'PremiumSwap', 'timetable', [t]);
      const b = await R.view(s, 'PremiumSwap', 'timetable', [t + 1n]);
      return [{ ok: BigInt(a.evmExpiry) < BigInt(a.qrlExpiry) && BigInt(a.qrlExpiry) <= BigInt(b.quoteOpens), detail: { epoch: t, ...a, nextQuoteOpens: b.quoteOpens } }];
    },
  },
  {
    id: 'court-capacity',
    inv: 'I24 premise',
    async run(R) {
      const c = R.q.ArkStakeCourt;
      const p = R.q.ArkJurorPool;
      if (!c || !p) return [];
      const open = BigInt(await R.view(c, 'ArkStakeCourt', 'openSeatStake'));
      const pool = BigInt(await R.view(p, 'ArkJurorPool', 'poolStake'));
      const balance = BigInt(await R.qrl.balance(c));
      const fees = BigInt(await R.view(c, 'ArkStakeCourt', 'feePool'));
      // Forfeits go to the fee pool since OC-COURT-07; an older court still holds them apart.
      const forfeits = await R.view(c, 'ArkStakeCourt', 'bufferForfeits').then(BigInt, () => 0n);
      return [
        { ok: open <= pool, detail: { openSeatStake: open, poolStake: pool } },
        { ok: balance >= fees + forfeits, detail: { courtBalance: balance, feePool: fees, bufferForfeits: forfeits } },
      ];
    },
  },
  {
    id: 'escrow-holding',
    inv: 'I3 I11 I25',
    async run(R) {
      const out = [];
      for (const a of R.ctx.r.assets) {
        const abi = R.ctx.r.escrowAbi(a);
        const v = async (m) => BigInt((await R.ctx.origin.call(a.escrow, abi, m))[0]);
        const held = await v('sharesHeld');
        const pots = (await v('positionShares')) + (await v('bufferShares')) + (await v('auctionShares')) + (await v('queuedShares')) + (await v('unclaimedShares')) + (await v('psrShares'));
        const queuedRelease = await v('queuedReleaseShares');
        const queued = await v('queuedShares');
        out.push({ ok: pots <= held + 2n && queuedRelease <= queued, detail: { asset: a.symbol, sharesHeld: held, pots, queuedReleaseShares: queuedRelease, queuedShares: queued } });
        if ((await v('queueHead')) !== (await v('queueTail'))) {
          const base = await v('queueBase');
          out.push({ ok: base * 2n <= held * 3n, detail: { asset: a.symbol, queueBase: base, sharesHeld: held }, known: 'OC-LEGA-05' });
        }
      }
      return out;
    },
  },
  {
    id: 'relay-authority',
    inv: 'I17 I35',
    async run(R) {
      const relay = R.ctx.r.relay;
      if (!relay) return [];
      const abi = R.ctx.r.abi.relay;
      const v = async (m) => BigInt((await R.ctx.origin.call(relay, abi, m))[0]);
      const next = await v('nextLeaf');
      const count = await v('LEAF_COUNT');
      const generation = await v('generation');
      return [{ ok: next < count && generation >= 1n && generation <= 4n, detail: { nextLeaf: next, LEAF_COUNT: count, generation } }];
    },
  },
  {
    // ArkReferenceOracle (yellow paper §6.1, CLAUDE.md item 122): while the
    // book's series answers, P30 lies inside B_e (1 ± m_epoch) (I38); while it
    // is silent, the registry strikes the carried price, carries the premium
    // mark (item 125) and nothing reverts (I40).
    id: 'oracle-series',
    inv: 'I38, I40',
    async run(R) {
      const o = R.q.ArkReferenceOracle;
      if (!o) return [];
      const zero = R.ctx.r.evmArg(ZERO);
      const silent = await R.view(o, 'ArkReferenceOracle', 'silent', [0n, zero]);
      if (silent) {
        const settle = BigInt(await R.view(R.q.ArkStakeRegistry, 'ArkStakeRegistry', 'settlementPrice'));
        const dead = BigInt(await R.view(R.q.ArkStakeRegistry, 'ArkStakeRegistry', 'deadOracleOpeningPrice'));
        const share = BigInt(await R.view(R.q.ArkStakeRegistry, 'ArkStakeRegistry', 'premiumShareBps'));
        const mark = BigInt((await R.qrl.call(R.q.ArkStakeRegistry, R.abi('ArkStakeRegistry'), 'premiumMark'))[1]);
        return [{ ok: settle === dead && share === mark, detail: { silent: true, settlementPrice: settle, deadOracleOpeningPrice: dead, premiumShareBps: share, premiumMark: mark } }];
      }
      const obs = await R.qrl.call(o, R.abi('ArkReferenceOracle'), 'observe', [0n, zero]);
      const p30 = BigInt(obs[1]);
      const e = await R.epoch();
      const b = BigInt(await R.view(o, 'ArkReferenceOracle', 'boundOf', [0n, zero, e]));
      const m = BigInt((await R.qrl.call(R.q.ArkStakeParams, R.abi('ArkStakeParams'), 'trigger2Params'))[3]);
      const low = (b * (BPS - m)) / BPS;
      const high = (b * (BPS + m)) / BPS;
      return [{ ok: b > 0n && p30 >= low && p30 <= high, detail: { epoch: e, P30: p30, B_e: b, mEpochBps: m, low, high } }];
    },
  },
];

/**
 * Runs every check once. Records each result on the context (`kind:
 * 'invariant'`) and returns `{ held, violated, known, skipped }`. With
 * `strict`, a violation no open finding predicts throws.
 */
async function checkInvariants(ctx, { tag = '', strict = false, only = null } = {}) {
  const R = new Reader(ctx);
  const block = (await ctx.qrl.head()).latest;
  const summary = { held: 0, violated: [], known: [], skipped: [] };
  for (const check of CHECKS) {
    if (only && !only.includes(check.id)) continue;
    let results;
    try {
      results = await check.run(R);
    } catch (e) {
      summary.skipped.push({ id: check.id, reason: String(e.shortMessage || e.message).slice(0, 200) });
      continue;
    }
    for (const r of results) {
      const record = { at: new Date().toISOString(), kind: 'invariant', tag, id: check.id, inv: check.inv, ok: r.ok, block, detail: r.detail, known: r.ok ? undefined : r.known };
      ctx.records.push(record);
      if (r.ok) summary.held += 1;
      else if (r.known) summary.known.push(record);
      else summary.violated.push(record);
    }
  }
  const line = `invariants${tag ? ` [${tag}]` : ''}: ${summary.held} held, ${summary.violated.length} violated, ${summary.known.length} known open, ${summary.skipped.length} skipped`;
  ctx.log(`   ${line}`);
  for (const v of summary.violated) ctx.log(`   VIOLATED ${v.id} (${v.inv}) ${JSON.stringify(v.detail, (k, x) => (typeof x === 'bigint' ? x.toString() : x))}`);
  if (strict && summary.violated.length) throw new Error(`${line}: ${summary.violated.map((v) => v.id).join(', ')}`);
  return summary;
}

module.exports = { checkInvariants, CHECKS, ZERO };
