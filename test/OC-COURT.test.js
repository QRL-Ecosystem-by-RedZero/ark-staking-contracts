/**
 * Audit round OC of 2026-10-03, the court (docs/review/audit-2026-10-03/COURT):
 * one regression per finding fixed, each asserting the rule as the
 * specification states it.
 *
 *   OC-COURT-02  a dust loss by a non-beneficiary no longer opens the bond's
 *                determination for free: a loss is floored at base_orig, in origin units (yellow paper §5.1), the
 *                ids must be anchored, an outsider posts the deposit of V_max
 *                and holds one loss open at a time
 *   OC-COURT-03  a governor resolution after the lapse closed the case is a no-op
 *   OC-COURT-05  a recovery is valued at the escrow's P_rem for the seat and bound
 *   OC-COURT-06  a full juror list evicts its smallest stake for a larger one
 *   OC-COURT-07  forfeited deposits go to the fee pool; the unallocated slash is
 *                paid to the coherent seats of the next appealed case
 *   OC-COURT-08  a challenged case nobody arms lapses after its evidence window
 *                and four draw windows
 *   OC-COURT-09  a case its first panel decided alone pays its slash to none of
 *                its own seats
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const F = require('./stake-fixture');
const { coder } = require('./harness');

const { ACCOUNTS, ONE, EPOCH, BPS, TERM, CLASS, CHAIN_ID, JUROR_MIN_STAKE, DEPOSIT_BASE } = F;
const DAY = 24 * 3600;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const OUTSIDER = ACCOUNTS.mallory;
const CHALLENGER = ACCOUNTS.attester;
const GOVERNOR = ACCOUNTS.guardian;
const KIND = { LOSS: 1, RECOVERY: 4 };
const V = { UPHOLD: 1, REJECT: 2 };
const STAGE = { CHALLENGE: 1n, ROUNDS: 2n, ESCALATED: 3n, DECIDED: 4n, FINAL: 5n };
const ARK_PRICE = 100n * ONE;
const EVIDENCE = keccak256(toUtf8Bytes('oc-court'));

const juror = (i) => '0x' + (0x5000 + i).toString(16).padStart(40, '0');
const salt = (a) => keccak256(toUtf8Bytes(`salt:${a.toLowerCase()}`));
const lossPayload = (list) => coder.encode(['bytes32[]', 'uint256[]'], [list.map((x) => x.id), list.map((x) => x.loss)]);
const recoveryPayload = (chainId, successorId, escrow, realised, base) =>
  coder.encode(['uint256', 'bytes32', 'address', 'uint256', 'uint256'], [chainId, successorId, escrow, realised, base]);
const commitment = (id, round, vote, who) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'uint8', 'bytes32', 'address'], [id, round, vote, salt(who), who]));
/** D_1 at `price` (yellow paper §5.1): base_orig at the price, 1 per cent of V, seven juror fees; the largest. */
const depositOf = (value, price = F.REF_PRICE) => {
  const p = (value * 100n + BPS - 1n) / BPS;
  let floor = price === F.REF_PRICE ? DEPOSIT_BASE : (F.DEPOSIT_BASE_ORIG * price + ONE - 1n) / ONE;
  if (floor < 7n * F.JUROR_FEE) floor = 7n * F.JUROR_FEE;
  return p > floor ? p : floor;
};

async function court({ jurors = 30, stakeEach, positions = [{ owner: HOLDER, notional: 100n * ONE }], term = TERM.YEAR, vested = true, vestFirst = false } = {}) {
  const ctx = await F.deployBondStack({ court: 'real' });
  if (stakeEach === undefined) stakeEach = BigInt(Math.ceil(7 / jurors)) * JUROR_MIN_STAKE;
  ctx.stakeEach = stakeEach;
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [];
  let nonce = 0n;
  for (const p of positions) ctx.pos.push({ ...(await F.anchor(ctx, { owner: p.owner, depositor: p.owner, nonce: nonce++, notional: p.notional })), ...p });
  if (vestFirst) ctx.chain.advanceTime(91 * DAY);
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term, value: 30_000n * ONE });
  if (vested) ctx.chain.advanceTime(91 * DAY);
  ctx.jurors = [];
  for (let i = 0; i < jurors; i++) {
    const j = juror(i);
    await ctx.ark.send('transfer', [j, stakeEach], { from: ACCOUNTS.admin });
    await ctx.ark.send('approve', [ctx.jurorPool.address, stakeEach], { from: j });
    await ctx.jurorPool.send('stake', [stakeEach], { from: j });
    ctx.jurors.push(j);
  }
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ARK_PRICE]);
  return ctx;
}

async function assertFinding(ctx, kind, payload, from) {
  const q = await ctx.findings.call('quote', [kind, payload], { from });
  const res = await ctx.court.send('assertFinding', [kind, payload, EVIDENCE], { from, value: q[3] * q[4] });
  const [ev] = ctx.court.events(res, 'AssertionOpened');
  return { id: ev.args.caseId, value: q[0], valueArk: q[1], seat: q[2], deposit: q[3], slices: q[4], res };
}

const caseOf = (ctx, id) => ctx.court.call('caseOf', [id]);
const roundOf = (ctx, id, n) => ctx.court.call('roundOf', [id, n]);
function until(ctx, at) {
  const now = BigInt(ctx.chain.timestamp);
  if (BigInt(at) > now) ctx.chain.advanceTime(Number(BigInt(at) - now));
}
async function drawRound(ctx, id) {
  const c = await caseOf(ctx, id);
  const r = await roundOf(ctx, id, c.round);
  while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
  await ctx.court.send('drawPanel', [id]);
  return (await ctx.jurorPool.call('panelOf', [id, c.round])).map((a) => a.toLowerCase());
}
async function vote(ctx, id, votes) {
  const c = await caseOf(ctx, id);
  const n = Number(c.round);
  const panel = (await ctx.jurorPool.call('panelOf', [id, n])).map((a) => a.toLowerCase());
  for (let i = 0; i < panel.length; i++) await ctx.court.send('commitVote', [id, commitment(id, n, votes[i], panel[i])], { from: panel[i] });
  const r = await roundOf(ctx, id, n);
  until(ctx, r.commitEnd);
  for (let i = 0; i < panel.length; i++) await ctx.court.send('revealVote', [id, votes[i], salt(panel[i])], { from: panel[i] });
  until(ctx, r.revealEnd);
  return panel;
}
async function toFirstPanel(ctx, id, deposit) {
  await ctx.court.send('challenge', [id], { from: CHALLENGER, value: deposit });
  const c = await caseOf(ctx, id);
  until(ctx, c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY));
  await ctx.court.send('armDraw', [id]);
  return drawRound(ctx, id);
}

describe('OC-COURT-02: a loss no longer opens the bond\'s determination for free', () => {
  test('the PoC: a 1-wei loss on someone else\'s position is refused, and so is a loss on an unknown id; no determination opens', async () => {
    const ctx = await court({ jurors: 14 });
    const pos = ctx.pos[0];
    for (const loss of [1n, 2n, ONE / 10n - 1n]) {
      await assert.rejects(() => ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: pos.id, loss }])], { from: OUTSIDER }), /LossBelowFloor/, `a loss of ${loss} units, below base_orig`);
    }
    await assert.rejects(
      () => ctx.court.send('assertFinding', [KIND.LOSS, lossPayload([{ id: pos.id, loss: 1n }]), EVIDENCE], { from: OUTSIDER, value: DEPOSIT_BASE }),
      /LossBelowFloor/,
    );
    await assert.rejects(() => ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: keccak256(toUtf8Bytes('no position')), loss: ONE }])]), /NotAnchored/);
    await assert.rejects(() => ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: pos.id, loss: ONE }, { id: keccak256(toUtf8Bytes('x')), loss: ONE }])]), /NotAnchored/, 'every id is anchored');
    assert.equal((await ctx.bond.call('state')).determinationsOpen, 0n);
    assert.equal(await ctx.bond.call('seedReturnSealable'), true, 'no seed return is held');
    // At the floor exactly, the loss is heard: base_orig, one tenth of a unit, is 1,000 QRL at 10,000 QRL a unit.
    const q = await ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: pos.id, loss: ONE / 10n }])], { from: HOLDER });
    assert.equal(q[0], DEPOSIT_BASE);
  });

  test('the beneficiary posts the deposit of its V; an outsider the deposit of V_max, and holds one loss open at a time', async () => {
    const ctx = await court({ jurors: 21, stakeEach: 3n * JUROR_MIN_STAKE });
    const pos = ctx.pos[0];
    const payload = lossPayload([{ id: pos.id, loss: ONE }]);
    const own = await ctx.findings.call('quoteFor', [KIND.LOSS, payload, HOLDER]);
    const out = await ctx.findings.call('quoteFor', [KIND.LOSS, payload, OUTSIDER]);
    assert.equal(own[5], false, 'the bound beneficiary is no outsider');
    assert.equal(out[5], true);
    assert.equal(own[0], out[0], 'the same V');
    assert.equal(own[3], depositOf(own[0]), 'the beneficiary: the deposit of its V');
    const vMax = await ctx.findings.call('valueMax');
    const dMax = depositOf(vMax);
    assert.equal(out[3], dMax > own[3] ? dMax : own[3], 'the outsider: the deposit of V_max, the suspension it opens holds the whole book');
    // `quote` answers for its caller.
    assert.equal((await ctx.findings.call('quote', [KIND.LOSS, payload], { from: OUTSIDER }))[3], out[3]);
    assert.equal((await ctx.findings.call('quote', [KIND.LOSS, payload], { from: HOLDER }))[3], own[3]);
    // The outsider's deposit is required in full.
    await assert.rejects(() => ctx.court.send('assertFinding', [KIND.LOSS, payload, EVIDENCE], { from: OUTSIDER, value: own[3] }), /IncorrectBond/);

    const a = await assertFinding(ctx, KIND.LOSS, payload, OUTSIDER);
    assert.equal(a.deposit, out[3]);
    // A second loss by the same outsider waits for the first to close: overlapping losses kept the determination open indefinitely.
    await assert.rejects(() => assertFinding(ctx, KIND.LOSS, lossPayload([{ id: pos.id, loss: 2n * ONE }]), OUTSIDER), /FindingPending/);
    // The beneficiary is not limited: its own positions, its own claims (split by position above the bound).
    const b1 = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: pos.id, loss: 2n * ONE }]), HOLDER);
    const b2 = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: pos.id, loss: 3n * ONE }]), HOLDER);
    assert.ok(b1.id !== b2.id);
    // Once the outsider's case closes, it may assert again.
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    await ctx.court.send('finalize', [a.id, payload]);
    await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: pos.id, loss: 2n * ONE }]), OUTSIDER);
  });

  test('a loss naming another\'s position beside the asserter\'s own is an outsider\'s', async () => {
    const ctx = await court({ positions: [{ owner: HOLDER, notional: 100n * ONE }, { owner: OUTSIDER, notional: 100n * ONE }] });
    const payload = lossPayload([{ id: ctx.pos[1].id, loss: ONE }, { id: ctx.pos[0].id, loss: ONE }]);
    assert.equal((await ctx.findings.call('quoteFor', [KIND.LOSS, payload, OUTSIDER]))[5], true);
    assert.equal((await ctx.findings.call('quoteFor', [KIND.LOSS, lossPayload([{ id: ctx.pos[1].id, loss: ONE }]), OUTSIDER]))[5], false, 'its own position alone');
  });
});

describe('OC-COURT-03: a resolution after the lapse closed the case is a no-op', () => {
  test('the governor\'s late vote resolves without reverting; the case stays as the lapse closed it', async () => {
    const ctx = await court({ jurors: 60 });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload, OUTSIDER);
    await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, Array(7).fill(V.REJECT));
    await ctx.court.send('appeal', [a.id], { from: OUTSIDER, value: 2n * a.deposit });
    await drawRound(ctx, a.id);
    await vote(ctx, a.id, Array(14).fill(V.UPHOLD));
    await ctx.court.send('escalateToGovernance', [a.id], { from: CHALLENGER, value: 4n * a.deposit });
    ctx.chain.advanceTime(14 * DAY);
    await ctx.court.send('finalize', [a.id, payload]);
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.FINAL);
    const res = await ctx.court.send('resolveEscalation', [a.id, true], { from: GOVERNOR });
    assert.equal(ctx.court.events(res, 'EscalationResolved').length, 0, 'nothing resolved');
    const c = await caseOf(ctx, a.id);
    assert.equal(c.stage, STAGE.FINAL);
    assert.equal(c.round, 2n, 'no retrial armed on a closed case');
    // A case never escalated still refuses.
    const b = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }]), HOLDER);
    await assert.rejects(() => ctx.court.send('resolveEscalation', [b.id, true], { from: GOVERNOR }), /NotEscalated/);
    await assert.rejects(() => ctx.court.send('resolveEscalation', [a.id, true], { from: OTHER }), /OnlyGovernor/);
  });
});

describe('OC-COURT-05: a recovery is valued at the escrow\'s residual P_rem', () => {
  async function recoveryBook(opts = {}) {
    const ctx = await court({ term: TERM.QUARTER, vested: false, vestFirst: true, ...opts });
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)]);
    await ctx.s.send('settleDeclaration');
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('set', [9000n * ONE, 9000n * ONE, 9000n * ONE]);
    await ctx.s.send('settleSeverity');
    const successor = '0x' + 'a1'.repeat(32);
    await ctx.params.send('admitSuccessor', [CHAIN_ID, successor]);
    const [pRem] = await ctx.r.call('recoveryResidual', [CHAIN_ID, F.ESCROW]);
    const price = (await ctx.s.call('declaration')).price;
    return { ctx, successor, pRem, price };
  }

  test('a false zero is valued at P_rem, as an inflated claim is: no longer heard at V = 0 with no bound', async () => {
    const { ctx, successor, pRem, price } = await recoveryBook();
    assert.ok(pRem > 0n, 'the bond drew for this escrow');
    const vRem = (pRem * price + ONE - 1n) / ONE;
    const zero = await ctx.findings.call('quote', [KIND.RECOVERY, recoveryPayload(CHAIN_ID, successor, F.ESCROW, 0n, 0n)]);
    const high = await ctx.findings.call('quote', [KIND.RECOVERY, recoveryPayload(CHAIN_ID, successor, F.ESCROW, 1000n * ONE, 100n * ONE)]);
    assert.equal(zero[0], vRem, 'a realisation of zero: the bond gives up up to P_rem');
    assert.equal(high[0], vRem, 'an inflated one: the bond takes at most P_rem');
    assert.ok(zero[1] <= (await ctx.findings.call('boundOf', [zero[2], 3000n, 6666n])), 'inside the bound on its seat');
    // The deposit's base at the price at the assertion (9,000 QRL here), not the declaration's (yellow paper §5.1).
    assert.equal(zero[3], depositOf(vRem, 9000n * ONE));
    // On an escrow the bond never paid, nothing is at stake: V = 0 at the minimum seat.
    const other = await ctx.findings.call('quote', [KIND.RECOVERY, recoveryPayload(CHAIN_ID, successor, '0x' + 'e6'.repeat(20), 0n, 0n)]);
    assert.equal(other[0], 0n);
    assert.equal(other[2], JUROR_MIN_STAKE);
  });

  test('above the bound on the seat in force, a recovery is heard at the seat whose bound covers it', async () => {
    const { ctx, successor, pRem, price } = await recoveryBook({ stakeEach: 1000n * JUROR_MIN_STAKE });
    const payload = recoveryPayload(CHAIN_ID, successor, F.ESCROW, 0n, 0n);
    const seatNow = await ctx.findings.call('seatNow');
    const vRem = (pRem * price + ONE - 1n) / ONE;
    // The ARK price that puts P_rem just above the bound on the seat in force.
    const bound = await ctx.findings.call('boundOf', [seatNow, 3000n, 6666n]);
    const low = (vRem * ONE) / (2n * bound);
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, low]);
    const seatLow = await ctx.findings.call('seatNow');
    const boundLow = await ctx.findings.call('boundOf', [seatLow, 3000n, 6666n]);
    const q = await ctx.findings.call('quote', [KIND.RECOVERY, payload]);
    assert.ok(q[1] > boundLow, `V in ARK above the bound on the seat in force (${q[1]} > ${boundLow})`);
    assert.equal(q[4], 1n, 'not sliced: one fact at one slot');
    assert.ok(q[2] > seatLow, 'the seat is raised');
    assert.ok(q[1] <= (await ctx.findings.call('boundOf', [q[2], 3000n, 6666n])), 'to the least seat whose bound covers V');
    assert.ok(q[1] > (await ctx.findings.call('boundOf', [q[2] - 1n, 3000n, 6666n])), 'and no more');
    const a = await assertFinding(ctx, KIND.RECOVERY, payload, OUTSIDER);
    assert.equal((await caseOf(ctx, a.id)).seat, q[2], 'the case sits at it, every round');
  });
});

describe('OC-COURT-06: a full juror list evicts its smallest stake for a larger one', () => {
  async function fullPool() {
    const ctx = await F.deployBondStack({ court: 'real' });
    const max = Number(await ctx.jurorPool.call('MAX_JURORS'));
    const fund = async (who, amount) => {
      await ctx.ark.send('transfer', [who, amount], { from: ACCOUNTS.admin });
      await ctx.ark.send('approve', [ctx.jurorPool.address, amount], { from: who });
    };
    for (let i = 0; i < max; i++) {
      // The filler: every slot at the minimum, one of them (index 40) a little above.
      const amount = i === 40 ? JUROR_MIN_STAKE + 5n : JUROR_MIN_STAKE;
      await fund(juror(i), amount);
      await ctx.jurorPool.send('stake', [amount], { from: juror(i) });
    }
    F.toNextEpoch(ctx);
    return { ctx, max, fund };
  }

  test('the list filled at the minimum no longer keeps every seat: a larger stake takes the smallest\'s slot', async () => {
    const { ctx, max, fund } = await fullPool();
    await fund(OUTSIDER, 3n * JUROR_MIN_STAKE);
    await assert.rejects(() => ctx.jurorPool.send('stake', [JUROR_MIN_STAKE], { from: OUTSIDER }), /PoolFull/, 'an equal stake does not evict');
    const res = await ctx.jurorPool.send('stake', [2n * JUROR_MIN_STAKE], { from: OUTSIDER });
    const [ev] = ctx.jurorPool.events(res, 'JurorEvicted');
    assert.equal(ev.args.juror.toLowerCase(), juror(0).toLowerCase(), 'the smallest, the first of equals');
    assert.equal(await ctx.jurorPool.call('jurorCount'), BigInt(max));
    assert.equal((await ctx.jurorPool.call('jurorOf', [OUTSIDER])).index, 1n, 'in its slot');
    assert.equal((await ctx.jurorPool.call('jurorOf', [juror(0)])).index, 0n, 'out of the list');
    assert.equal(await ctx.jurorPool.call('activeStakeOf', [juror(0)]), JUROR_MIN_STAKE, 'the evicted juror keeps its stake, to unbond and withdraw');
    await ctx.jurorPool.send('unbond', [JUROR_MIN_STAKE], { from: juror(0) });
    ctx.chain.advanceTime(21 * DAY);
    await ctx.jurorPool.send('withdraw', [], { from: juror(0) });
    // The next larger stake evicts the next smallest, never the one above the minimum while one at it is listed.
    await fund(OTHER, 2n * JUROR_MIN_STAKE);
    const res2 = await ctx.jurorPool.send('stake', [2n * JUROR_MIN_STAKE], { from: OTHER });
    assert.equal(ctx.jurorPool.events(res2, 'JurorEvicted')[0].args.juror.toLowerCase(), juror(1).toLowerCase());
  });

  test('not while a draw is armed', async () => {
    const ctx = await court({ jurors: 7 });
    const pool = ctx.jurorPool;
    // Fill the rest of the list at the minimum.
    const max = Number(await pool.call('MAX_JURORS'));
    for (let i = 7; i < max; i++) {
      await ctx.ark.send('transfer', [juror(i), JUROR_MIN_STAKE], { from: ACCOUNTS.admin });
      await ctx.ark.send('approve', [pool.address, JUROR_MIN_STAKE], { from: juror(i) });
      await pool.send('stake', [JUROR_MIN_STAKE], { from: juror(i) });
    }
    F.toNextEpoch(ctx);
    const a = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }]), HOLDER);
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 10n * BigInt(DAY));
    await ctx.court.send('armDraw', [a.id]);
    await ctx.ark.send('transfer', [OUTSIDER, 5n * JUROR_MIN_STAKE], { from: ACCOUNTS.admin });
    await ctx.ark.send('approve', [pool.address, 5n * JUROR_MIN_STAKE], { from: OUTSIDER });
    await assert.rejects(() => pool.send('stake', [5n * JUROR_MIN_STAKE], { from: OUTSIDER }), /PoolFull/, 'no eviction while a draw is armed');
    await drawRound(ctx, a.id);
    const res = await pool.send('stake', [5n * JUROR_MIN_STAKE], { from: OUTSIDER });
    assert.equal(pool.events(res, 'JurorEvicted').length, 1, 'evicted once the draw is taken');
  });
});

describe('OC-COURT-07 and OC-COURT-09: forfeits and slashes have an exit, and an unappealed majority is not paid the minority\'s stake', () => {
  test('a failed assertion\'s deposit is forfeited into the fee pool, which pays later coherent seats', async () => {
    const ctx = await court();
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload, OUTSIDER);
    const panel = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, Array(7).fill(V.REJECT));
    until(ctx, (await roundOf(ctx, a.id, 1)).appealEnd);
    const before = await ctx.court.call('feePool');
    const res = await ctx.court.send('finalize', [a.id, '0x']);
    const [fin] = ctx.court.events(res, 'CaseFinal');
    assert.equal(fin.args.toBuffer, a.deposit - 7n * F.JUROR_FEE, 'what the losing deposit leaves after the fees');
    assert.equal((await ctx.court.call('feePool')) - before, fin.args.toBuffer, 'forfeited into the fee pool');
    let owed = 0n;
    for (const w of [...panel, OUTSIDER, CHALLENGER]) owed += await ctx.court.call('owed', [w]);
    assert.equal(await ctx.chain.balanceOf(ctx.court.address), owed + (await ctx.court.call('feePool')), 'the court holds what it owes and its fee pool, nothing apart');
  });

  test('an unappealed 4–3 pays its dissenters\' slash to no seat of its own; the next appealed case\'s coherent seats take it', async () => {
    const ctx = await court({ jurors: 60 });
    const cut = (JUROR_MIN_STAKE * 3000n) / BPS;
    // A: a 4–3 nobody appeals.
    const a = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]), HOLDER);
    const pa = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, [V.UPHOLD, V.UPHOLD, V.UPHOLD, V.UPHOLD, V.REJECT, V.REJECT, V.REJECT]);
    until(ctx, (await roundOf(ctx, a.id, 1)).appealEnd);
    const resA = await ctx.court.send('finalize', [a.id, lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }])]);
    for (const ev of ctx.jurorPool.events(resA, 'SeatSettled')) assert.equal(ev.args.reward, 0n, 'no seat of an unappealed first round is paid the slash');
    for (let i = 0; i < 4; i++) assert.equal((await ctx.jurorPool.call('jurorOf', [pa[i]])).reward, 0n);
    assert.equal(await ctx.jurorPool.call('unallocatedSlash'), 3n * cut, 'the three dissenters\' slash, held');

    // B: appealed and overturned; its coherent seats take B's slash and the held one.
    const b = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: 3n * ONE }]), HOLDER);
    await toFirstPanel(ctx, b.id, b.deposit);
    await vote(ctx, b.id, [V.UPHOLD, V.UPHOLD, V.UPHOLD, V.UPHOLD, V.REJECT, V.REJECT, V.REJECT]);
    await ctx.court.send('appeal', [b.id], { from: CHALLENGER, value: 2n * b.deposit });
    await drawRound(ctx, b.id);
    await vote(ctx, b.id, Array(14).fill(V.REJECT));
    until(ctx, (await roundOf(ctx, b.id, 2)).appealEnd);
    const resB = await ctx.court.send('finalize', [b.id, '0x']);
    const seats = ctx.jurorPool.events(resB, 'SeatSettled');
    assert.equal(seats.length, 21);
    const slashed = seats.reduce((t, e) => t + e.args.slashed, 0n);
    assert.equal(slashed, 4n * cut, 'the overturned majority of round 1');
    const coherent = seats.filter((e) => e.args.coherent);
    assert.equal(coherent.length, 17);
    const share = (slashed + 3n * cut) / 17n;
    for (const e of coherent) assert.equal(e.args.reward, share, 'B\'s slash and A\'s held slash, in equal parts');
    assert.equal(await ctx.jurorPool.call('unallocatedSlash'), slashed + 3n * cut - share * 17n, 'the remainder of the division waits');
  });
});

describe('OC-COURT-08: a challenged case nobody arms lapses', () => {
  test('four draw windows after its evidence window, lapseDraw closes it: rejected, every deposit refunded, the determination closed', async () => {
    const ctx = await court();
    const a = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }]), OUTSIDER);
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    const c = await caseOf(ctx, a.id);
    const due = c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY) + 4n * BigInt(EPOCH);
    until(ctx, due - 1n);
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /WindowOpen/, 'not before');
    ctx.chain.advanceTime(1);
    const res = await ctx.court.send('lapseDraw', [a.id], { from: OTHER });
    const [fin] = ctx.court.events(res, 'CaseFinal');
    assert.equal(fin.args.outcome, BigInt(V.REJECT), 'the burden is the asserter\'s');
    assert.equal(fin.args.jurorFees, 0n);
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.FINAL);
    assert.equal(await ctx.court.call('owed', [OUTSIDER]), a.deposit, 'no jury found it false: refunded');
    assert.equal(await ctx.court.call('owed', [CHALLENGER]), a.deposit);
    assert.equal(ctx.bond.events(res, 'DeterminationClosed').length, 1);
    assert.equal((await ctx.bond.call('state')).determinationsOpen, 0n);
    assert.equal(await ctx.court.call('openCases'), 0n);
    assert.equal(await ctx.court.call('openSeatStake'), 0n, 'the capacity is freed');
    // The outsider's one open loss is freed with it.
    await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }]), OUTSIDER);
  });

  test('an unchallenged case does not lapse: it stands at its window', async () => {
    const ctx = await court();
    const a = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }]), HOLDER);
    ctx.chain.advanceTime(30 * DAY);
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /InvalidCaseState/);
  });
});
