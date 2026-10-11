/**
 * The re-audit of 2026-09-30 (docs/review/audit-2026-09-30/CONTRACTS-*.md):
 * every PoC that demonstrated a defect, re-run as a regression against the
 * fix (gap items 104 - of CLAUDE.md). Each test follows its PoC's steps and
 * asserts that the exploit no longer works, and why; the rules themselves are
 * tested where they live (ArkCatBondSettlement, ArkStakeCourt, PremiumSwap,
 * the escrow and relayer suites).
 *
 * The PoCs of the BOND area's BOND-01 and BOND-02 are regressions in
 * ArkCatBondSettlement.test.js, next to the rules they break.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, Interface, id: selectorOf } = require('ethers');
const F = require('./stake-fixture');
const { coder } = require('./harness');
const { loadModel, MISSING } = require('./spec-model');

const { ACCOUNTS, ONE, EPOCH, BPS, TERM, CLASS, JUROR_MIN_STAKE, CHAIN_ID, ESCROW, ASSET_A, REF_PRICE } = F;
const DAY = 24 * 3600;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const ASSERTER = ACCOUNTS.mallory;
const CHALLENGER = ACCOUNTS.attester;
const KIND = { LOSS: 1, CENSORSHIP: 2 };
const V = { UPHOLD: 1, REJECT: 2 };
const ARK_PRICE = 100n * ONE;
const EVIDENCE = keccak256(toUtf8Bytes('e'));
const ZERO32 = '0x' + '00'.repeat(32);

let M;
before(async () => {
  M = await loadModel();
});
const needModel = (t) => {
  if (!M) {
    t.skip(MISSING);
    return true;
  }
  return false;
};

const juror = (i) => '0x' + (0x2000 + i).toString(16).padStart(40, '0');
const salt = (a) => keccak256(toUtf8Bytes(`salt:${a.toLowerCase()}`));
const lossPayload = (list) => coder.encode(['bytes32[]', 'uint256[]'], [list.map((x) => x.id), list.map((x) => x.loss)]);
const uintPayload = (x) => coder.encode(['uint256'], [x]);
const commitment = (id, round, vote, who) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'uint8', 'bytes32', 'address'], [id, round, vote, salt(who), who]));
const det = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const refused = (cause) => (e) =>
  /FindingRefused/.test(String(e && e.message)) && String((e && e.data) || '').toLowerCase().includes(selectorOf(cause).slice(2, 10));

/* ------------------------------------------------------------------ */
/* The court's fixture, as the COURT PoCs built it                     */
/* ------------------------------------------------------------------ */

async function court({ jurors = 30, stakeEach = 10n * JUROR_MIN_STAKE, notional = 100n * ONE } = {}) {
  const ctx = await F.deployBondStack({ court: 'real' });
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional })];
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  await stakeJurors(ctx, 0, jurors, stakeEach);
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ARK_PRICE]);
  return ctx;
}
async function stakeJurors(ctx, from, to, stakeEach) {
  for (let i = from; i < to; i++) {
    const j = juror(i);
    await ctx.ark.send('transfer', [j, stakeEach], { from: ACCOUNTS.admin });
    await ctx.ark.send('approve', [ctx.jurorPool.address, stakeEach], { from: j });
    await ctx.jurorPool.send('stake', [stakeEach], { from: j });
  }
}
async function assertF(ctx, kind, payload, from = ASSERTER) {
  const q = await ctx.findings.call('quote', [kind, payload]);
  const res = await ctx.court.send('assertFinding', [kind, payload, EVIDENCE], { from, value: q[3] * q[4] });
  const opened = ctx.court.events(res, 'AssertionOpened');
  return { id: opened[0].args.caseId, ids: opened.map((e) => e.args.caseId), deposit: q[3], seat: q[2], slices: q[4], value: q[0] };
}
const caseOf = (ctx, id) => ctx.court.call('caseOf', [id]);
const roundOf = (ctx, id, n) => ctx.court.call('roundOf', [id, n]);
function until(ctx, at) {
  const now = BigInt(ctx.chain.timestamp);
  if (BigInt(at) > now) ctx.chain.advanceTime(Number(BigInt(at) - now));
}
async function toDrawBlock(ctx, id) {
  const c = await caseOf(ctx, id);
  const r = await roundOf(ctx, id, c.round);
  while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
  return r;
}
async function toFirstPanel(ctx, id, deposit) {
  await ctx.court.send('challenge', [id], { from: CHALLENGER, value: deposit });
  const c = await caseOf(ctx, id);
  until(ctx, c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY));
  await ctx.court.send('armDraw', [id]);
  await toDrawBlock(ctx, id);
  await ctx.court.send('drawPanel', [id]);
  return (await ctx.jurorPool.call('panelOf', [id, 1])).map((a) => a.toLowerCase());
}
async function vote(ctx, id, panel, n, votes) {
  for (let i = 0; i < panel.length; i++) {
    if (!votes[i]) continue;
    await ctx.court.send('commitVote', [id, commitment(id, n, votes[i], panel[i])], { from: panel[i] });
  }
  const r = await roundOf(ctx, id, n);
  until(ctx, r.commitEnd);
  for (let i = 0; i < panel.length; i++) {
    if (!votes[i]) continue;
    await ctx.court.send('revealVote', [id, votes[i], salt(panel[i])], { from: panel[i] });
  }
  until(ctx, r.revealEnd);
}
/** The ARK price at which the indexed seat is `mult` times the floor on this book. */
async function priceForSeat(ctx, mult) {
  const vmax = await ctx.findings.call('valueMax');
  return (vmax * ONE) / (8n * mult * JUROR_MIN_STAKE);
}

/* ------------------------------------------------------------------ */
/* COURT-01: the seat is the case's, fixed at its assertion            */
/* ------------------------------------------------------------------ */

describe('COURT-01 (re-audit 2026-09-30): every round of a case draws at the seat fixed at its assertion', () => {
  test('/A: the ARK price moves between round 1 and the appeal; the appeal is drawn at the case\'s seat and can overturn the bought verdict', async () => {
    const ctx = await court();
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertF(ctx, KIND.LOSS, payload);
    assert.equal(a.seat, JUROR_MIN_STAKE);
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, p1, 1, [V.UPHOLD, V.UPHOLD, V.UPHOLD, V.UPHOLD, V.REJECT, V.REJECT, V.REJECT]);
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, await priceForSeat(ctx, 2n)]);
    assert.ok((await ctx.findings.call('seatNow')) > JUROR_MIN_STAKE, 'the seat in force moved');
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    const r2 = await toDrawBlock(ctx, a.id);
    assert.equal(r2.seat, a.seat, 'round 2 is armed at the case\'s seat, not the seat in force');
    await ctx.court.send('drawPanel', [a.id]);
    const p2 = (await ctx.jurorPool.call('panelOf', [a.id, 2])).map((x) => x.toLowerCase());
    assert.equal(p2.length, 14, 'the appeal panel is drawn: no SeatMismatch');
    assert.equal(await ctx.jurorPool.call('armedUntil'), 0n, 'the pool is free again');
    // The appeal overturns the bought majority, which forfeits its stake (I24').
    await vote(ctx, a.id, p2, 2, Array(14).fill(V.REJECT));
    until(ctx, (await roundOf(ctx, a.id, 2)).appealEnd);
    const res = await ctx.court.send('finalize', [a.id, '0x']);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 0, 'the false loss never reaches the bond');
    for (let i = 0; i < 4; i++) {
      const j = await ctx.jurorPool.call('jurorOf', [p1[i]]);
      assert.ok(j.active < 10n * JUROR_MIN_STAKE, 'the bought majority is slashed');
    }
  });

  test('/B: on a book above the floor, one anchor between the rounds no longer kills the appeal', async () => {
    const ctx = await court();
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, await priceForSeat(ctx, 2n)]);
    const seat0 = await ctx.findings.call('seatNow');
    assert.ok(seat0 > JUROR_MIN_STAKE);
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: ONE / 2n }]);
    const a = await assertF(ctx, KIND.LOSS, payload);
    assert.equal(a.seat, seat0);
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, p1, 1, [V.UPHOLD, V.UPHOLD, V.UPHOLD, V.UPHOLD, V.REJECT, V.REJECT, V.REJECT]);
    await F.anchor(ctx, { owner: ASSERTER, depositor: ASSERTER, nonce: 0n, notional: ONE });
    assert.ok((await ctx.findings.call('seatNow')) > seat0, 'the seat in force moved');
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    await toDrawBlock(ctx, a.id);
    await ctx.court.send('drawPanel', [a.id]);
    assert.equal((await ctx.jurorPool.call('panelOf', [a.id, 2])).length, 14);
    assert.equal(await ctx.jurorPool.call('seatStakeOf', [a.id]), seat0);
  });

  test('/C: an unseatable first draw pins nothing; once the pool grows and the price moves, round 1 is drawn at the case\'s seat', async () => {
    const ctx = await court({ jurors: 6 });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertF(ctx, KIND.LOSS, payload);
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    const c = await caseOf(ctx, a.id);
    until(ctx, c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY));
    await ctx.court.send('armDraw', [a.id]);
    await toDrawBlock(ctx, a.id);
    const res = await ctx.court.send('drawPanel', [a.id]);
    assert.equal(ctx.court.events(res, 'PanelUnseatable').length, 1);
    assert.equal(await ctx.jurorPool.call('seatStakeOf', [a.id]), 0n, 'a draw that seats nobody pins nothing');
    await stakeJurors(ctx, 100, 130, 10n * JUROR_MIN_STAKE);
    ctx.chain.advanceTime(EPOCH);
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, await priceForSeat(ctx, 2n)]);
    await ctx.court.send('armDraw', [a.id]);
    await toDrawBlock(ctx, a.id);
    await ctx.court.send('drawPanel', [a.id]);
    assert.equal((await ctx.jurorPool.call('panelOf', [a.id, 1])).length, 7, 'drawn');
    assert.equal(await ctx.jurorPool.call('seatStakeOf', [a.id]), a.seat);
  });
});

/* ------------------------------------------------------------------ */
/* COURT-02: a refusal is the bond's one refusal error                 */
/* ------------------------------------------------------------------ */

const ATTACKER = '0x' + 'a7'.repeat(20);
const courtIface = new Interface(['function finalize(bytes32 caseId, bytes payload)']);

/**
 * Runtime of a holder contract: on receiving QRL with slot 0 set, clear it and
 * CALL `target` with the embedded calldata, store the call's success in slot 1,
 * and accept the payment whatever happened. The COURT-02 PoC's.
 */
function reentrantHolder(target, data) {
  const d = data.replace(/^0x/, '');
  const len = d.length / 2;
  const h2 = (n) => n.toString(16).padStart(4, '0');
  const code =
    '600054' + '15' + '603a' + '57' +
    '6000' + '6000' + '55' +
    '61' + h2(len) + '61' + h2(0x3c) + '6000' + '39' +
    '6000' + '6000' + '61' + h2(len) + '6000' + '6000' + '73' + target.replace(/^0x/, '').toLowerCase() + '5a' + 'f1' +
    '6001' + '55' +
    '5b' + '00' +
    d;
  return '0x' + code;
}

async function reentryBook({ jurors = 30, stakeEach = 10n * JUROR_MIN_STAKE } = {}) {
  const ctx = await F.deployBondStack({ court: 'real' });
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE })];
  const first = (BigInt(ctx.chain.timestamp) + BigInt(30 * DAY)) / BigInt(EPOCH) + 1n;
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 29_000n * ONE });
  await ctx.chain.fund(ATTACKER, 10n ** 30n);
  await ctx.chain.installCode(ATTACKER, reentrantHolder(ctx.court.address, '0x'));
  ctx.attackerHolding = await F.subscribe(ctx, { from: ATTACKER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 1_000n * ONE });
  await F.distributeDue(ctx);
  await F.deliverAndDistribute(ctx, first, 50n * ONE);
  await stakeJurors(ctx, 0, jurors, stakeEach);
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, 100n * ONE]);
  return ctx;
}
async function finalizeFromCoupon(ctx, caseId, payload) {
  const data = courtIface.encodeFunctionData('finalize', [caseId, payload]);
  await ctx.chain.installCode(ATTACKER, reentrantHolder(ctx.court.address, data), { 0: 1 });
  const res = await ctx.bond.send('claim', [ctx.attackerHolding], { from: ATTACKER });
  const key = new Uint8Array(32);
  key[31] = 1;
  const st = await ctx.chain.vm.stateManager.getStorage(require('@ethereumjs/util').createAddressFromString(ATTACKER), key);
  return { res, finalizeOk: st.length > 0 && st[st.length - 1] === 1 };
}

describe('COURT-02 (re-audit 2026-09-30): a finding re-entered from a bond payout is retried, never refused', () => {
  test('/A: an unchallenged loss finalized from a coupon receipt reverts inside the payout; finalized afterwards it reaches the bond and the asserter keeps its deposit', async () => {
    const ctx = await reentryBook();
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertF(ctx, KIND.LOSS, payload);
    const c = await caseOf(ctx, a.id);
    until(ctx, c.openedAt + c.challengeDays * BigInt(DAY));
    const { res, finalizeOk } = await finalizeFromCoupon(ctx, a.id, payload);
    assert.equal(finalizeOk, false, 'the re-entered finalize reverts (the bond\'s guard is no refusal)');
    assert.ok(ctx.coupon.events(res, 'CouponPaid').length >= 1, 'the holder was paid all the same');
    assert.equal(ctx.court.events(res, 'FindingRefused').length, 0);
    assert.equal((await caseOf(ctx, a.id)).stage, 1n, 'the case is still open: nothing dropped');
    const fin = await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(ctx.s.events(fin, 'LossDetermined').length, 1, 'the loss reaches the bond');
    assert.equal(ctx.court.events(fin, 'CaseFinal')[0].args.toBuffer, 0n, 'nothing forfeited');
    assert.equal(await ctx.court.call('owed', [ASSERTER]), a.deposit, 'the honest asserter gets its deposit back');
  });

  test('/B: a censorship slice re-entered from a coupon is retried; the group completes, the ground stands and nothing is stranded', async () => {
    const ctx = await reentryBook({ jurors: 12, stakeEach: 40n * JUROR_MIN_STAKE });
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ONE]);
    const a = await assertF(ctx, KIND.CENSORSHIP, uintPayload(0n));
    const n = a.ids.length;
    assert.ok(n > 1, `heard in ${n} slices`);
    const c = await caseOf(ctx, a.ids[0]);
    until(ctx, c.openedAt + c.challengeDays * BigInt(DAY));
    for (let i = 0; i < n - 1; i++) await ctx.court.send('finalize', [a.ids[i], uintPayload(0n)]);
    const { res, finalizeOk } = await finalizeFromCoupon(ctx, a.ids[n - 1], uintPayload(0n));
    assert.equal(finalizeOk, false);
    assert.equal(ctx.court.events(res, 'FindingRefused').length, 0);
    const fin = await ctx.court.send('finalize', [a.ids[n - 1], uintPayload(0n)]);
    assert.equal(ctx.s.events(fin, 'SliceClosed').length, 1);
    assert.equal(ctx.s.events(fin, 'Trigger2Grounded').length, 1, 'the ground stands with the last slice');
    assert.equal((await ctx.s.call('sliceGroup')).id, ZERO32, 'the group is cleared');
    assert.equal(await ctx.court.call('openCases'), 0n);
    assert.equal((await ctx.bond.call('state')).determinationsOpen, 0n, 'the determination closed with the group');
    await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)]);
    await ctx.s.send('settleDeclaration');
    const d = await ctx.s.call('declaration');
    assert.equal(d.stage, 3n, 'settled');
    assert.equal(d.held, 0n);
    assert.equal(d.phiOpen, 0n);
  });
});

/* ------------------------------------------------------------------ */
/* COURT-03: censorship V on S_full <= K_T                             */
/* ------------------------------------------------------------------ */

test('COURT-03 (re-audit 2026-09-30): on a book whose bond principal is ~8x K the censorship ground is heard, V within V_max', async () => {
  const ctx = await court({ notional: 10n * ONE });
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ONE / 100n]);
  const vmax = await ctx.findings.call('valueMax');
  assert.ok((await ctx.findings.call('seatNow')) > JUROR_MIN_STAKE, 'the indexed seat binds');
  const payload = uintPayload(0n);
  const q = await ctx.findings.call('quote', [KIND.CENSORSHIP, payload]);
  assert.ok(q[0] <= vmax + 1n, `V ${q[0]} within V_max ${vmax}: D_0 of min(pool, K_T), not of the pool`);
  assert.ok(q[0] < (100_000n * ONE * 6000n) / BPS, 'less than D_0 of the whole pool');
  assert.ok(q[4] >= 1n && q[4] <= 16n, `${q[4]} slices`);
  // Past the slice count; this small pool cannot seat an indexed seat's slices, which is the pool's capacity, not the value.
  await assert.rejects(
    () => ctx.court.send('assertFinding', [KIND.CENSORSHIP, payload, EVIDENCE], { from: ASSERTER, value: q[3] * q[4] }),
    /PoolAtCapacity/,
  );
});

/* ------------------------------------------------------------------ */
/* COURT-04, end to end through the court                              */
/* ------------------------------------------------------------------ */

test('COURT-04 (re-audit 2026-09-30): one slice of five standing, four rejected by their juries; a later declaration is settled on the other four fifths', async () => {
  const ctx = await F.deployBondStack({ court: 'real' });
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  const pos = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE });
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  await stakeJurors(ctx, 0, 12, 40n * JUROR_MIN_STAKE);
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ONE]);
  const q = await ctx.findings.call('quote', [KIND.CENSORSHIP, uintPayload(0n)]);
  const res0 = await ctx.court.send('assertFinding', [KIND.CENSORSHIP, uintPayload(0n), EVIDENCE], { from: ASSERTER, value: q[3] * q[4] });
  const ids = ctx.court.events(res0, 'AssertionOpened').map((e) => e.args.caseId);
  const n = ids.length;
  assert.ok(n >= 3, `${n} slices`);
  for (let k = 1; k < n; k++) await ctx.court.send('challenge', [ids[k]], { from: CHALLENGER, value: q[3] });
  const c0 = await caseOf(ctx, ids[0]);
  until(ctx, c0.openedAt + (c0.challengeDays + c0.evidenceDays) * BigInt(DAY));
  const g = await ctx.court.send('finalize', [ids[0], uintPayload(0n)]);
  assert.equal(ctx.s.events(g, 'Trigger2Grounded').length, 0, 'one slice of n grounds nothing alone');
  for (let k = 1; k < n; k++) {
    await ctx.court.send('armDraw', [ids[k]]);
    await toDrawBlock(ctx, ids[k]);
    await ctx.court.send('drawPanel', [ids[k]]);
    const panel = (await ctx.jurorPool.call('panelOf', [ids[k], 1])).map((a) => a.toLowerCase());
    await vote(ctx, ids[k], panel, 1, Array(7).fill(V.REJECT));
    until(ctx, (await roundOf(ctx, ids[k], 1)).appealEnd);
    const fin = await ctx.court.send('finalize', [ids[k], '0x']);
    assert.equal(ctx.s.events(fin, 'Trigger2Grounded').length, k === n - 1 ? 1 : 0, 'the ground stands with the last slice');
  }
  await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
  await ctx.r.send('recordClaimants', [[pos.id]]);
  const open = await ctx.s.send('settleDeclaration');
  const d = await ctx.s.call('declaration');
  assert.equal(d.censorship, true);
  assert.equal(d.stage, 1n, 'the declaration opens on the remainder: an assessment window, then its severity');
  assert.equal(ctx.s.events(open, 'DeclarationOnRemainder').length, 1);
  assert.equal(d.drawn, (d.fullSettlement * BigInt(d.d0)) / BPS, 'D_0 of the whole drawn in all: 1/n by the ground, the rest by the declaration');
  F.toEpoch(ctx, d.epoch + 4n);
  await ctx.oracle.send('set', [(REF_PRICE * 3n) / 10n, (REF_PRICE * 3n) / 10n, (REF_PRICE * 3n) / 10n]);
  const sev = await ctx.s.send('settleSeverity');
  assert.equal(ctx.s.events(sev, 'SeveritySettled').length, 1, 'the severity applies to the remainder');
  await assert.rejects(() => ctx.s.send('settleDeclaration'), /DeclarationAlreadySettled/);
});

/* ------------------------------------------------------------------ */
/* BOND-03, BOND-04, BOND-05                                          */
/* ------------------------------------------------------------------ */

async function stack() {
  const ctx = await F.deployBondStack();
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  return ctx;
}
const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);

test('BOND-03 (re-audit 2026-09-30): after a trigger-1 determination closes, the seed is not sealable while its buffer part is unsealed', async () => {
  const ctx = await stack();
  const p0 = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE });
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  const epoch = epochNow(ctx);
  await ctx.attest.send('seal', [epoch, F.bufferLeaf(CHAIN_ID, ASSET_A, epoch, 5n * ONE)]);
  await ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, 5n * ONE, []], { from: ASSERTER });
  await ctx.court.send('open', [det(1)]);
  await ctx.court.send('determineLoss', [det(1), [p0.id], [10n * ONE]]);
  await ctx.court.send('close', [det(1)]);
  const part = await ctx.s.call('lossPartOf', [det(1), p0.id]);
  assert.ok(part.bufferUnits > 0n);
  assert.equal(await ctx.bond.call('seedReturnSealable'), false, 'the determined buffer part holds the seed');
  await ctx.s.send('nameLossDestination', [det(1), p0.id, '0x' + '33'.repeat(20)], { from: HOLDER });
  assert.equal(await ctx.bond.call('seedReturnSealable'), true, 'sealed as its loss leaf: the relayer checks its presentation');
});

test('BOND-04 (re-audit 2026-09-30): no recovery is found between the slices of the censorship ground; after them it recovers the whole draw', async () => {
  const ctx = await stack();
  const p0 = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 100n * ONE });
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  const G = det(0x5c);
  await ctx.court.send('open', [G]);
  await ctx.court.send('openSlices', [G, 2, 4]);
  await ctx.court.send('closeSlice', [G, 0, true, uintPayload(0n)]);
  // The PoC opened here; the ground does not stand until the last slice.
  await assert.rejects(() => ctx.r.send('recordClaimants', [[p0.id]]), /DeclarationNotRatified/);
  const R = 1000n * ONE;
  await assert.rejects(() => ctx.court.send('openRecovery', [det(0x77), CHAIN_ID, ZERO32, ESCROW, R, 100n * ONE]), refused('NothingToSubrogate()'));
  for (const i of [1, 2, 3]) await ctx.court.send('closeSlice', [G, i, true, uintPayload(0n)]);
  await ctx.r.send('recordClaimants', [[p0.id]]);
  await ctx.s.send('settleDeclaration');
  await ctx.court.send('openRecovery', [det(0x77), CHAIN_ID, ZERO32, ESCROW, R, 100n * ONE]);
  const led = await ctx.r.call('escrowLedger', [CHAIN_ID, ESCROW]);
  assert.equal(led.residual, 0n, 'P_rem recovered in full: no draw is left behind the slot');
});

test('BOND-05 (re-audit 2026-09-30): after the breaker fired, a dead oracle opens at min(carried, floor_k), never above the live rule', async () => {
  const ctx = await stack();
  const p0 = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 3n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term: TERM.QUARTER, value: 30_000n * ONE });
  await ctx.registry.send('markPremium');
  const [carried] = await ctx.registry.call('carriedPrice');
  await ctx.oracle.send('set', [REF_PRICE / 10n, (REF_PRICE * 4n) / 10n, (REF_PRICE * 9n) / 10n]);
  await ctx.registry.send('markPremium');
  F.toNextEpoch(ctx);
  F.toNextEpoch(ctx);
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setEmergency', [REF_PRICE / 10n]);
  await F.declare(ctx, BigInt(ctx.chain.timestamp));
  await ctx.r.send('recordClaimants', [[p0.id]]);
  const live = await ctx.registry.call('settlementPrice');
  const [, , firedPlusOne] = await ctx.registry.call('carriedPrice');
  assert.ok(firedPlusOne > 0n, 'the breaker was marked');
  await ctx.oracle.send('setReverting', [true]);
  const want = await ctx.registry.call('deadOracleOpeningPrice');
  if (M) {
    const move = Number((await ctx.params.call('trigger2Params'))[3]);
    assert.equal(want, M.ark.deadOracleOpeningPrice(carried, move, Number(epochNow(ctx) - (firedPlusOne - 1n))), 'the model\'s deadOracleOpeningPrice');
  }
  const res = await ctx.s.send('settleDeclaration', [], { from: HOLDER });
  const t2 = await ctx.s.call('declaration');
  assert.equal(ctx.s.events(res, 'OpenedAtCarriedPrice').length, 1);
  assert.equal(t2.price, want);
  assert.ok(t2.price < carried, 'not the pre-decline price');
  assert.ok(t2.price <= live, 'no more than the live rule\'s strike');
});

/* ------------------------------------------------------------------ */
/* SWAPGOV-05: the deploy wires the governor's chamber too             */
/* ------------------------------------------------------------------ */

test('SWAPGOV-05 / SWAPGOV-03 (re-audit 2026-09-30): the deploy wires the timelock\'s source, names the governor, and schedules the governor\'s source', async (t) => {
  const gov = require('../scripts/lib/governance');
  const { iface } = require('../scripts/lib/chains');
  const build = gov.vendoredLine({ qrvm: false, profileName: 'testnet' });
  if (!require('fs').existsSync(require('path').join(build, 'ArkTimelock.json'))) return t.skip('no vendored governance artifacts: run npm run vendor:governance');
  const abi = (n) => iface(n, build);
  const G = { ProposerMultisig: '0x' + '01'.repeat(20), ArkTimelock: '0x' + '02'.repeat(20), ArkGovernor: '0x' + '03'.repeat(20) };
  const leg = { ArkCatBond: '0x' + '04'.repeat(20) };
  const submitted = [];
  const client = {
    kind: 'evm',
    async call(to, _i, fn) {
      if (fn === 'txCount') return [BigInt(submitted.length)];
      return ['0x' + '00'.repeat(20)];
    },
    async send(to, i, fn, args) {
      if (fn === 'submit') submitted.push({ target: args[0].toLowerCase(), data: args[2] });
      return { logs: [] };
    },
  };
  // Threshold two: submitted, left for the other owners, and returned as kept
  // entries (OC-GOV-04, 2026-10-03; at one the stub would have to answer the
  // Scheduled event the tooling now records).
  const entries = await gov.wireObjectionSource({ client, abi, governance: G, leg, threshold: 2n, opts: {}, log: () => {} });
  assert.deepEqual(entries.map((e) => [e.name, e.kind, e.multisigTx, e.executed]), [
    ['ArkTimelock.setObjectionSource', 'call', 0n, false],
    ['ArkTimelock.setGovernor', 'call', 1n, false],
    ['ArkGovernor.setObjectionSource', 'schedule', 2n, false],
  ]);
  const tl = abi('ArkTimelock');
  const decoded = submitted.map((s) => ({ target: s.target, call: tl.parseTransaction({ data: s.data }) }));
  assert.deepEqual(decoded.map((d) => d.call.name), ['setObjectionSource', 'setGovernor', 'schedule']);
  assert.equal(decoded[1].call.args[0].toLowerCase(), G.ArkGovernor);
  // The scheduled operation: the governor's own objection source, the bond.
  assert.equal(decoded[2].call.args[0].toLowerCase(), G.ArkGovernor);
  const inner = abi('ArkGovernor').parseTransaction({ data: decoded[2].call.args[1] });
  assert.equal(inner.name, 'setObjectionSource');
  assert.equal(inner.args[0].toLowerCase(), leg.ArkCatBond);
});

/* ------------------------------------------------------------------ */
/* SWAPGOV-04 and SWAPGOV-09 against core's own timelock               */
/* ------------------------------------------------------------------ */

describe('SWAPGOV-04 / SWAPGOV-09 (re-audit 2026-09-30): the parameter set under core\'s timelock', { skip: !require('./core-build').coreBuild('ArkTimelock') && 'no core build' }, () => {
  const { Interface } = require('ethers');
  const { artifact } = require('./harness');
  const { deployCore } = require('./core-build');
  const iface = new Interface(artifact('ArkStakeParams').abi);
  async function governed() {
    const ctx = await F.deployStack({ assets: [] });
    const tl = await deployCore(ctx.chain, 'ArkTimelock', ['address', 'address'], [ACCOUNTS.admin, ACCOUNTS.guardian]);
    await ctx.params.send('proposeGovernance', [tl.address], { from: ACCOUNTS.admin });
    const schedule = async (target, data) => {
      const res = await tl.send('schedule', [target, data]);
      const log = res.logs.map((l) => { try { return tl.iface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === 'Scheduled');
      return log.args.opId;
    };
    const accept = await schedule(ctx.params.address, iface.encodeFunctionData('acceptGovernance'));
    ctx.chain.advanceTime(2 * DAY + 1);
    await tl.send('execute', [accept]);
    return { ctx, tl, schedule };
  }

  test('SWAPGOV-04 (the PoC, now refused): the second of four concurrent quarter-steps on one key is refused at scheduling (KeyPending)', async () => {
    const { ctx, tl, schedule } = await governed();
    const k = F.paramKey('claimCostGwei');
    const first = await schedule(ctx.params.address, iface.encodeFunctionData('setParamsDiff', [[[k, 600_000n, 3_100_000n]]]));
    // core's error, read by its selector (this harness decodes the staking ABIs).
    const keyPending = selectorOf('KeyPending(bytes32,bytes32)').slice(2, 10);
    await assert.rejects(
      schedule(ctx.params.address, iface.encodeFunctionData('setParamsDiff', [[[k, 3_100_000n, 5_600_000n]]])),
      (e) => /KeyPending/.test(String(e.message)) || String(e.data || '').toLowerCase().includes(keyPending),
    );
    ctx.chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [first]);
    F.toNextEpoch(ctx);
    assert.equal(BigInt((await ctx.params.call('params')).claimCostGwei), 3_100_000n, 'one step, not the whole range');
  });

  test('SWAPGOV-04: the staking set measures the step from the value in force: two diffs staged in one epoch move one step between them', async () => {
    const ctx = await F.deployStack({ assets: [] });
    const k = F.paramKey('claimCostGwei');
    await ctx.params.send('setParamsDiff', [[[k, 600_000n, 3_100_000n]]], { from: ACCOUNTS.admin });
    // Staged, not in force: a second diff builds on it (compare-and-swap) but steps from the value in force.
    await assert.rejects(ctx.params.send('setParamsDiff', [[[k, 3_100_000n, 5_600_000n]]], { from: ACCOUNTS.admin }), /ParameterStepTooLarge/);
    await ctx.params.send('setParamsDiff', [[[k, 3_100_000n, 2_000_000n]]], { from: ACCOUNTS.admin });
    F.toNextEpoch(ctx);
    assert.equal(BigInt((await ctx.params.call('params')).claimCostGwei), 2_000_000n);
  });

  test('SWAPGOV-09 (the PoC, now refused): a stage step aimed at no parameter set leaves the allocation\'s stepQueued false', async () => {
    const { ctx, schedule } = await governed();
    await schedule(ACCOUNTS.bob, iface.encodeFunctionData('setThreatStage', [3, 4]));
    assert.equal((await ctx.registry.call('allocation')).stepQueued, false, 'term commitments stay open');
    // One aimed at the set itself still counts.
    await schedule(ctx.params.address, iface.encodeFunctionData('setThreatStage', [1, 2]));
    assert.equal((await ctx.registry.call('allocation')).stepQueued, true);
  });
});
