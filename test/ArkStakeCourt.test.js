/**
 * The dispute court of Ark Staking and its juror pool, end to end on the
 * harness with the real bond behind it (phase C4; whitepaper §6.2, §6.6;
 * yellow paper §4.1, §4.3, §4.5; I24′, G8, G13).
 *
 * The one rule this file exists to defend: **no finding reaches the bond that
 * a purchase could buy for less than one and a half times what it moves** —
 * the bound is fixed at the opening from the stake the first panel's majority
 * forfeits (κ, the slash and the seat frozen for the case), every seat is
 * judged at the end against the FINAL verdict so an overturned majority is
 * slashed, and every drawn juror's stake is held until the case is final,
 * through the escalation and a retrial. Each of the four findings is driven
 * from an assertion through the bond's settlement.
 *
 * The arithmetic of record is the model's: `verdictBound`, `bribeCostFloor`
 * and `determinationsFor` of `ark-staking.ts`, and `escalationSchedule` and
 * `escalationDeposit` of `ark-governance.ts`, called beside the contracts.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const F = require('./stake-fixture');
const { coder } = require('./harness');
const { loadModel, MISSING } = require('./spec-model');

const { ACCOUNTS, ONE, EPOCH, BPS, TERM, CLASS, CHAIN_ID, JUROR_MIN_STAKE, DEPOSIT_BASE, JUROR_FEE } = F;
const DAY = 24 * 3600;
const HOLDER = ACCOUNTS.alice;
const OTHER = ACCOUNTS.bob;
const ASSERTER = ACCOUNTS.mallory;
const CHALLENGER = ACCOUNTS.attester;
const GOVERNOR = ACCOUNTS.guardian;
const KIND = { LOSS: 1, CENSORSHIP: 2, SEVERITY: 3, RECOVERY: 4 };
const V = { UPHOLD: 1, REJECT: 2 };
const STAGE = { CHALLENGE: 1n, ROUNDS: 2n, ESCALATED: 3n, DECIDED: 4n, FINAL: 5n };
const ARK_PRICE = 100n * ONE; // QRL per ARK: the bound on the minimum seat is 7,999.2 ARK, 799,920 QRL
const EVIDENCE = keccak256(toUtf8Bytes('origin state at a named height'));

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
const recoveryPayload = (chainId, successorId, escrow, realised, base) =>
  coder.encode(['uint256', 'bytes32', 'address', 'uint256', 'uint256'], [chainId, successorId, escrow, realised, base]);
const commitment = (id, round, vote, who) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'uint8', 'bytes32', 'address'], [id, round, vote, salt(who), who]));

/**
 * A book behind the real court: positions, a junior and a senior class,
 * `jurors` jurors of `stakeEach` ARK active in the pool, and ARK priced.
 */
async function court({ jurors = 30, stakeEach, positions = [{ owner: HOLDER, notional: 100n * ONE }], term = TERM.YEAR, vested = true, vestFirst = false, params, courtOpts } = {}) {
  const ctx = await F.deployBondStack({ court: 'real', params, courtOpts });
  // Each open case reserves its first round's seven seats (QL-19, PV-01): by
  // default each juror stakes enough that the pool admits one case of the
  // minimum seat, and no less than that seat.
  if (stakeEach === undefined) stakeEach = BigInt(Math.ceil(7 / jurors)) * JUROR_MIN_STAKE;
  ctx.stakeEach = stakeEach;
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  // The claimant record and the recovery run in the fourth body (phase C3b), at the bond's address.
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [];
  let nonce = 0n;
  for (const p of positions) ctx.pos.push({ ...(await F.anchor(ctx, { owner: p.owner, depositor: p.owner, nonce: nonce++, notional: p.notional })), ...p });
  // Positions vested at the ratification behind young holdings: the full settlement is the pool.
  if (vestFirst) ctx.chain.advanceTime(91 * DAY);
  ctx.junior = await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term, value: 70_000n * ONE });
  ctx.senior = await F.subscribe(ctx, { from: OTHER, class_: CLASS.SENIOR, term, value: 30_000n * ONE });
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

/** Record every position as a claimant and open the trigger-2 settlement (phase C3b). */
async function open2(ctx) {
  await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)]);
  return ctx.s.send('settleDeclaration');
}

/**
 * Assert a finding at its quoted deposit, one per value slice; returns the
 * (first) case id, the quote, and every slice's case id (EC-04).
 */
async function assertFinding(ctx, kind, payload, from = ASSERTER) {
  // Quoted for the asserter: an outsider's loss posts the deposit of V_max (OC-COURT-02).
  const q = await ctx.findings.call('quote', [kind, payload], { from });
  const res = await ctx.court.send('assertFinding', [kind, payload, EVIDENCE], { from, value: q[3] * q[4] });
  const opened = ctx.court.events(res, 'AssertionOpened');
  return { id: opened[0].args.caseId, ids: opened.map((e) => e.args.caseId), value: q[0], valueArk: q[1], seat: q[2], deposit: q[3], slices: q[4], res };
}

const caseOf = (ctx, id) => ctx.court.call('caseOf', [id]);
const roundOf = (ctx, id, n) => ctx.court.call('roundOf', [id, n]);

function until(ctx, at) {
  const now = BigInt(ctx.chain.timestamp);
  if (BigInt(at) > now) ctx.chain.advanceTime(Number(BigInt(at) - now));
}

/** Move to the draw block of the round in progress and draw it; returns the panel. */
async function drawRound(ctx, id) {
  const c = await caseOf(ctx, id);
  const r = await roundOf(ctx, id, c.round);
  // Drawn from the draw block's hash, so in a block after it (QL-18).
  while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
  await ctx.court.send('drawPanel', [id]);
  return (await ctx.jurorPool.call('panelOf', [id, c.round])).map((a) => a.toLowerCase());
}

/**
 * Commit and reveal `votes[i]` for the i-th juror of the round's panel (0: no
 * commit, 'x': commits and never reveals), then move to the end of the reveal.
 */
async function vote(ctx, id, votes) {
  const c = await caseOf(ctx, id);
  const n = Number(c.round);
  const panel = (await ctx.jurorPool.call('panelOf', [id, n])).map((a) => a.toLowerCase());
  for (let i = 0; i < panel.length; i++) {
    const v = votes[i] || 0;
    if (v === 0) continue;
    await ctx.court.send('commitVote', [id, commitment(id, n, v === 'x' ? V.UPHOLD : v, panel[i])], { from: panel[i] });
  }
  const r = await roundOf(ctx, id, n);
  until(ctx, r.commitEnd);
  for (let i = 0; i < panel.length; i++) {
    const v = votes[i] || 0;
    if (v === 0 || v === 'x') continue;
    await ctx.court.send('revealVote', [id, v, salt(panel[i])], { from: panel[i] });
  }
  until(ctx, r.revealEnd);
  return panel;
}

/** Challenge, wait out the evidence window, arm and draw round 1. */
async function toFirstPanel(ctx, id, deposit) {
  await ctx.court.send('challenge', [id], { from: CHALLENGER, value: deposit });
  const c = await caseOf(ctx, id);
  until(ctx, c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY));
  await ctx.court.send('armDraw', [id]);
  return drawRound(ctx, id);
}

async function claim(ctx, who) {
  const before = await ctx.chain.balanceOf(who);
  await ctx.court.send('claim', [], { from: who });
  return (await ctx.chain.balanceOf(who)) - before;
}

/** Everything the court holds is owed, pooled or posted on a case still open; forfeits are pooled (OC-COURT-07). */
async function courtBalanceAccounts(ctx, who, openDeposits = 0n) {
  let owed = 0n;
  for (const a of who) owed += await ctx.court.call('owed', [a]);
  const sum = owed + (await ctx.court.call('feePool')) + openDeposits;
  assert.equal(await ctx.chain.balanceOf(ctx.court.address), sum, 'the court holds exactly what it owes, pools and holds on open cases');
}

/* ------------------------------------------------------------------ */
/* The optimistic path                                                 */
/* ------------------------------------------------------------------ */

describe('an unchallenged assertion stands at the close of its challenge window, without a jury (whitepaper §6.2)', () => {
  test('a trigger-1 loss: the determination opens at the assertion and settles through the waterfall at the close', async () => {
    // Five hundred units anchored: K (61.7 units at the launch stage) is above
    // the fifty asserted, so V is the claim itself (PV-07 caps it at K).
    const ctx = await court({ positions: [{ owner: HOLDER, notional: 500n * ONE }] });
    const pos = ctx.pos[0];
    const payload = lossPayload([{ id: pos.id, loss: 50n * ONE }]);
    // The bound beneficiary asserts its own loss: the deposit is V's (an outsider posts V_max's, OC-COURT-02).
    const a = await assertFinding(ctx, KIND.LOSS, payload, HOLDER);
    assert.equal(a.value, 50n * F.REF_PRICE, 'V: the claim at the settlement series, rounded up');
    assert.equal(a.deposit, a.value / 100n > DEPOSIT_BASE ? a.value / 100n : DEPOSIT_BASE, 'the deposit is proportional to V above its base');
    assert.equal(ctx.bond.events(a.res, 'DeterminationOpened').length, 1, 'issuance suspends and maturities hold from the assertion (yellow paper §1.4)');
    await assert.rejects(() => ctx.court.send('finalize', [a.id, payload]), /WindowOpen/);
    await assert.rejects(() => ctx.court.send('assertFinding', [KIND.LOSS, payload, EVIDENCE], { from: HOLDER, value: a.deposit - 1n }), /IncorrectBond/);

    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    await assert.rejects(() => ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit }), /WindowClosed/);
    await assert.rejects(() => ctx.court.send('finalize', [a.id, lossPayload([{ id: pos.id, loss: 60n * ONE }])]), /BadPayload/, 'the finding is the one asserted');
    const res = await ctx.court.send('finalize', [a.id, payload], { from: OTHER });
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 1, 'the bond settled the finding');
    assert.equal(ctx.court.events(res, 'FindingApplied').length, 1);
    assert.equal(ctx.bond.events(res, 'DeterminationClosed').length, 1, 'and the determination closed');
    const part = await ctx.s.call('lossPartOf', [a.id, pos.id]);
    assert.ok(part.qrl > 0n, 'the bond\'s part of the claim is an entitlement in QRL');
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.FINAL);
    assert.equal(await claim(ctx, HOLDER), a.deposit, 'the asserter\'s deposit returns');
    await assert.rejects(() => ctx.court.send('finalize', [a.id, payload]), /InvalidCaseState/);
    await courtBalanceAccounts(ctx, [HOLDER]);
  });
});

/* ------------------------------------------------------------------ */
/* The jury                                                            */
/* ------------------------------------------------------------------ */

describe('the jury: commit, reveal, a majority, and every seat judged against the final verdict', () => {
  test('a rejected assertion: nothing reaches the bond, the minority and the silent are slashed, the fees come from the losing deposit', async () => {
    const ctx = await court();
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 50n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    const panel = await toFirstPanel(ctx, a.id, a.deposit);
    assert.equal(panel.length, 7, 'seven in the first round');
    assert.equal(await ctx.court.call('isDrawnJuror', [a.id, panel[0]]), true);
    await assert.rejects(() => ctx.court.send('commitVote', [a.id, commitment(a.id, 1, V.REJECT, ACCOUNTS.bob)], { from: ACCOUNTS.bob }), /NotADrawnJuror/);
    // Five reject, one upholds, one commits and never reveals.
    await vote(ctx, a.id, [V.REJECT, V.REJECT, V.REJECT, V.REJECT, V.REJECT, V.UPHOLD, 'x']);
    await assert.rejects(() => ctx.court.send('revealVote', [a.id, V.REJECT, salt(panel[6])], { from: panel[6] }), /WindowClosed/);
    await assert.rejects(() => ctx.court.send('finalize', [a.id, '0x']), /WindowOpen/, 'the appeal window runs first');
    await assert.rejects(() => ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit }), /NotTheLoser/, 'only the loser appeals');
    const r1 = await roundOf(ctx, a.id, 1);
    until(ctx, r1.appealEnd);
    const feePool = await ctx.court.call('feePool');
    const res = await ctx.court.send('finalize', [a.id, '0x']);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 0, 'a rejected finding moves nothing');
    assert.equal(ctx.bond.events(res, 'DeterminationClosed').length, 1, 'the determination closes');
    const c = await caseOf(ctx, a.id);
    assert.equal(c.outcome, BigInt(V.REJECT));

    const cut = (JUROR_MIN_STAKE * 3000n) / BPS;
    for (let i = 0; i < 7; i++) {
      const j = await ctx.jurorPool.call('jurorOf', [panel[i]]);
      assert.equal(j.held, 0n, 'released at the end');
      assert.equal(j.active, i < 5 ? ctx.stakeEach : ctx.stakeEach - cut, i < 5 ? 'coherent: whole' : 'minority or silent: 3,000 bps of the seat');
      // Decided by its first panel alone, unappealed: its slash subsidises no majority; held for an appealed case (OC-COURT-09).
      assert.equal(j.reward, 0n, 'no seat of an unappealed first round is paid the slash');
    }
    assert.equal(await ctx.jurorPool.call('unallocatedSlash'), 2n * cut, 'the two seats\' slash is held unallocated');
    const fee = 5n * JUROR_FEE;
    assert.equal(await claim(ctx, panel[0]), JUROR_FEE, 'a coherent seat is paid its fee');
    assert.equal((await ctx.court.call('feePool')) - feePool, a.deposit - fee, 'the failed assertion\'s deposit, less the fees, is forfeited to the fee pool (OC-COURT-07)');
    assert.equal(await claim(ctx, CHALLENGER), a.deposit, 'the challenger\'s deposit returns');
    await courtBalanceAccounts(ctx, [...panel, ASSERTER, CHALLENGER]);
  });

  test('the draw is taken from the hash of a target block eight after the arm, in any of the 256 blocks after it; re-armed only after (QL-18, PV-06)', async () => {
    const ctx = await court();
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    await assert.rejects(() => ctx.court.send('armDraw', [a.id]), /WindowOpen/, 'not before the evidence window closes');
    const c = await caseOf(ctx, a.id);
    until(ctx, c.openedAt + 10n * BigInt(DAY));
    await ctx.court.send('armDraw', [a.id]);
    const r = await roundOf(ctx, a.id, 1);
    assert.equal(await ctx.court.call('DRAW_LOOKAHEAD'), 8n);
    assert.equal(r.drawBlock, r.armBlock + 8n, 'the target block, eight ahead');
    await assert.rejects(() => ctx.court.send('drawPanel', [a.id]), /NotDrawBlock/, 'not before the target block has a hash');
    while (BigInt(ctx.chain.blockNumber) < r.drawBlock) ctx.chain.advanceTime(0);
    await assert.rejects(() => ctx.court.send('drawPanel', [a.id]), /NotDrawBlock/, 'not in the target block itself: no panel before target + 1');
    await assert.rejects(() => ctx.court.send('armDraw', [a.id]), /InvalidCaseState/, 'no re-arm while the block is ahead');
    while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
    await assert.rejects(() => ctx.court.send('armDraw', [a.id]), /InvalidCaseState/, 'no re-arm while the draw is drawable: a drawer who dislikes the panel cannot sample again (C-3)');
    // Let the window pass undrawn: the drawer abstained. Re-armed only now.
    ctx.chain.advanceTime(257 * 12);
    await assert.rejects(() => ctx.court.send('drawPanel', [a.id]), /NotDrawBlock/, 'the hash has left reach');
    await ctx.court.send('armDraw', [a.id]);
    const r2 = await roundOf(ctx, a.id, 1);
    assert.equal(r2.drawBlock, r2.armBlock + 8n, 'a fresh target');
    // Any block of the window: the panel is keccak(seed, round, blockhash(target)) alone.
    ctx.chain.advanceTime(100 * 12);
    const res = await ctx.court.send('drawPanel', [a.id], { from: OTHER });
    const [ev] = ctx.court.events(res, 'JuryDrawn');
    // The harness's hash of block n is keccak("block-<n>").
    const hash = keccak256(toUtf8Bytes('block-' + r2.drawBlock));
    assert.equal(ev.args.drawSeed, keccak256(coder.encode(['bytes32', 'uint8', 'bytes32'], [c.seed, 1, hash])), 'a function of the target block\'s hash and the seed only');
    const panel = (await ctx.jurorPool.call('panelOf', [a.id, 1])).map((x) => x.toLowerCase());
    await assert.rejects(() => ctx.court.send('armDraw', [a.id]), /InvalidCaseState/, 'drawn once');
    await ctx.court.send('commitVote', [a.id, commitment(a.id, 1, V.UPHOLD, panel[0])], { from: panel[0] });
    await assert.rejects(() => ctx.court.send('revealVote', [a.id, V.UPHOLD, salt(panel[0])], { from: panel[0] }), /WindowOpen/, 'no reveal inside the commit window');
    until(ctx, (await roundOf(ctx, a.id, 1)).commitEnd);
    await assert.rejects(() => ctx.court.send('commitVote', [a.id, commitment(a.id, 1, V.UPHOLD, panel[1])], { from: panel[1] }), /WindowClosed/);
    await assert.rejects(() => ctx.court.send('revealVote', [a.id, V.REJECT, salt(panel[0])], { from: panel[0] }), /RevealMismatch/, 'the vote is the one committed');
    await ctx.court.send('revealVote', [a.id, V.UPHOLD, salt(panel[0])], { from: panel[0] });
    await assert.rejects(() => ctx.court.send('revealVote', [a.id, V.UPHOLD, salt(panel[0])], { from: panel[0] }), /RevealMismatch/, 'once');
  });

  /** A challenged loss past its evidence window, armed after `wait` further blocks. */
  async function armedCase(wait = 0) {
    const ctx = await court();
    const a = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }]));
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 10n * BigInt(DAY));
    for (let i = 0; i < wait; i++) ctx.chain.advanceTime(0);
    const armedAt = BigInt(ctx.chain.blockNumber);
    await ctx.court.send('armDraw', [a.id]);
    return { ctx, a, armedAt, r: await roundOf(ctx, a.id, 1) };
  }
  const drawAt = async ({ ctx, a, r }, offset) => {
    while (BigInt(ctx.chain.blockNumber) < r.drawBlock + BigInt(offset)) ctx.chain.advanceTime(0);
    await ctx.court.send('drawPanel', [a.id], { from: OTHER });
    return (await ctx.jurorPool.call('panelOf', [a.id, 1])).map((x) => x.toLowerCase());
  };

  test('the same panel at any block of the window: one after the target, and two hundred after (QL-18)', async () => {
    const first = await drawAt(await armedCase(), 1);
    const late = await drawAt(await armedCase(), 200);
    assert.equal(first.length, 7);
    assert.deepEqual(late, first, 'the drawer gains nothing by choosing when to call');
  });

  test('the armer picks among no known panels: every block it could arm in targets a block not yet built (QL-18, PV-06)', async () => {
    const panels = new Set();
    for (const wait of [0, 1, 2, 3]) {
      const x = await armedCase(wait);
      // At the arm the target is eight blocks ahead: its hash does not exist,
      // so no value the armer can read — the arming block's prevrandao
      // included, known a block early — decides the panel.
      assert.equal(x.r.drawBlock, x.armedAt + 8n);
      assert.ok(x.r.drawBlock > BigInt(x.ctx.chain.blockNumber), 'the target is unbuilt when the arm lands');
      await assert.rejects(() => x.ctx.court.send('drawPanel', [x.a.id]), /NotDrawBlock/, 'nothing to preview at the arm');
      const p = await drawAt(x, 1);
      assert.ok((await x.ctx.court.call('roundOf', [x.a.id, 1])).commitEnd > 0n, 'drawn');
      panels.add(p.join(','));
    }
    // Waiting a block only moves the target to another unbuilt block: a different, equally unknown sample.
    assert.ok(panels.size > 1, 'the panel follows the target block, not the arm');
  });

  test('the appeal: fourteen fresh jurors on twice the deposit; the overturned majority of the first round forfeits its stake (I24′)', async (t) => {
    if (needModel(t)) return;
    // K above the fifty units asserted, so V and the deposit are the claim's (PV-07).
    const ctx = await court({ jurors: 30, positions: [{ owner: HOLDER, notional: 500n * ONE }] });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 50n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    // A bought first round: four uphold.
    await vote(ctx, a.id, [V.UPHOLD, V.UPHOLD, V.UPHOLD, V.UPHOLD, V.REJECT, V.REJECT, V.REJECT]);
    await assert.rejects(() => ctx.court.send('appeal', [a.id], { from: ASSERTER, value: 2n * a.deposit }), /NotTheLoser/);
    await assert.rejects(() => ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: a.deposit }), /IncorrectBond/, 'the appeal doubles the deposit');
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    const p2 = await drawRound(ctx, a.id);
    assert.equal(p2.length, 14);
    assert.equal(p1.filter((x) => p2.includes(x)).length, 0, 'no juror of the first round sits on the appeal');
    await vote(ctx, a.id, Array(14).fill(V.REJECT).map((v, i) => (i < 3 ? V.UPHOLD : v)));
    until(ctx, (await roundOf(ctx, a.id, 2)).appealEnd);
    const feePool = await ctx.court.call('feePool');
    const res = await ctx.court.send('finalize', [a.id, '0x']);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 0);
    const cut = (JUROR_MIN_STAKE * 3000n) / BPS;
    for (let i = 0; i < 4; i++) {
      assert.equal((await ctx.jurorPool.call('jurorOf', [p1[i]])).active, ctx.stakeEach - cut, 'the first round\'s majority, overturned, is slashed');
    }
    assert.equal((await ctx.jurorPool.call('jurorOf', [p1[4]])).active, ctx.stakeEach, 'its minority was right, and is whole');
    // The stake the deciding majority of round 1 forfeited bounds what the finding could move.
    const F1 = 4n * a.seat * 3000n / BPS;
    assert.ok(a.valueArk <= M.ark.verdictBound(4n * a.seat, 3000, 6666), 'V inside the bound on F_1');
    assert.ok(F1 >= M.ark.bribeCostFloor(a.valueArk, 6666), 'F_1 is at least the bribe-cost floor of V');
    assert.ok(F1 * 2n >= 3n * a.valueArk, 'so a purchased first round costs at least 1.5 V');
    // Fees: 3 + 11 coherent seats, from the asserter's deposit.
    const coherent = 3n + 11n;
    assert.equal((await ctx.court.call('feePool')) - feePool, a.deposit - coherent * JUROR_FEE, 'forfeited to the fee pool (OC-COURT-07)');
    assert.equal(await claim(ctx, CHALLENGER), 3n * a.deposit, 'the challenger\'s deposits return: its own and the appeal');
    await courtBalanceAccounts(ctx, [...p1, ...p2, ASSERTER, CHALLENGER]);
  });

  test('a juror reveals only in the round it was seated on: a round-one juror is not counted in the appeal (QL-02; PoC C-2)', async () => {
    const ctx = await court({ jurors: 30 });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 50n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    // p1[0] commits a round-2 commitment during round 1; the rest of round 1 rejects.
    await ctx.court.send('commitVote', [a.id, commitment(a.id, 2, V.UPHOLD, p1[0])], { from: p1[0] });
    for (let i = 1; i < 7; i++) await ctx.court.send('commitVote', [a.id, commitment(a.id, 1, V.REJECT, p1[i])], { from: p1[i] });
    let r = await roundOf(ctx, a.id, 1);
    until(ctx, r.commitEnd);
    for (let i = 1; i < 7; i++) await ctx.court.send('revealVote', [a.id, V.REJECT, salt(p1[i])], { from: p1[i] });
    until(ctx, r.revealEnd);
    await ctx.court.send('appeal', [a.id], { from: ASSERTER, value: 2n * a.deposit });
    const p2 = await drawRound(ctx, a.id);
    assert.ok(!p2.includes(p1[0]));
    r = await roundOf(ctx, a.id, 2);
    until(ctx, r.commitEnd);
    await assert.rejects(() => ctx.court.send('revealVote', [a.id, V.UPHOLD, salt(p1[0])], { from: p1[0] }), /NotADrawnJuror/, 'not seated on round 2');
    const r2 = await roundOf(ctx, a.id, 2);
    assert.equal(r2.upholds, 0n);
    until(ctx, r2.appealEnd);
    const res = await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 0, 'a silent appeal panel does not uphold');
    assert.equal((await caseOf(ctx, a.id)).outcome, BigInt(V.REJECT));
  });
});

/* ------------------------------------------------------------------ */
/* The terminal step                                                   */
/* ------------------------------------------------------------------ */

describe('the terminal step: the appeal\'s loser escalates, the governor upholds or orders a retrial of 28 (whitepaper §6.6)', () => {
  /** To an escalated case: round 1 rejects, the asserter appeals, round 2 upholds, the challenger escalates. */
  async function escalated(opts) {
    const ctx = await court({ jurors: 60, ...opts });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 50n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, Array(7).fill(V.REJECT));
    await ctx.court.send('appeal', [a.id], { from: ASSERTER, value: 2n * a.deposit });
    const p2 = await drawRound(ctx, a.id);
    await vote(ctx, a.id, Array(14).fill(V.UPHOLD));
    await assert.rejects(() => ctx.court.send('escalateToGovernance', [a.id], { from: ASSERTER, value: 4n * a.deposit }), /NotTheLoser/);
    await assert.rejects(() => ctx.court.send('escalateToGovernance', [a.id], { from: CHALLENGER, value: 2n * a.deposit }), /IncorrectBond/);
    assert.equal(await ctx.court.call('escalationPending', [a.id]), false);
    assert.equal(BigInt(await ctx.court.call('escalationLapsesAt', [a.id])), 0n, 'no escalation, no lapse');
    await ctx.court.send('escalateToGovernance', [a.id], { from: CHALLENGER, value: 4n * a.deposit });
    assert.equal(await ctx.court.call('escalationPending', [a.id]), true, 'the governor may now open the five-day vote');
    // OC-COURT-03: the governor reads when the escalation lapses, and opens no vote that would end after it.
    const at = BigInt(ctx.chain.timestamp);
    assert.equal(BigInt(await ctx.court.call('escalationLapsesAt', [a.id])), at + BigInt(await ctx.court.call('ESCALATION_LAPSE')));
    return { ctx, a, payload, p1, p2 };
  }

  test('the deposits and panels double each round, as the model\'s schedule', async (t) => {
    if (needModel(t) || !M.gov) return t.skip && !M ? undefined : undefined;
    const { ctx, a, p1, p2 } = await escalated();
    const s = M.gov.escalationSchedule(a.deposit);
    assert.deepEqual(s.map((r) => r.panel), [7, 14, 28]);
    assert.equal(p1.length, s[0].panel);
    assert.equal(p2.length, s[1].panel);
    const c = await caseOf(ctx, a.id);
    assert.equal(c.posted[0], s[0].deposit + s[1].deposit, 'the asserter posted D_1 and the appeal 2 D_1');
    assert.equal(c.posted[1], s[0].deposit + M.gov.escalationDeposit(s[1].deposit), 'the challenger D_1 and the escalation 2 D_2 = D_3');
    assert.equal(M.gov.escalationDeposit(s[1].deposit), s[2].deposit);
  });

  test('uphold: the stake of every drawn juror is held while veARK votes, past the unbonding period, and released at the end (G13)', async () => {
    const { ctx, a, payload, p2 } = await escalated();
    await assert.rejects(() => ctx.court.send('resolveEscalation', [a.id, false], { from: ACCOUNTS.mallory }), /OnlyGovernor/);
    // An appeal juror tries to leave while the governor votes.
    await assert.rejects(() => ctx.jurorPool.send('unbond', [JUROR_MIN_STAKE], { from: p2[0] }), /NotFree/, 'held stake cannot unbond (G13)');
    ctx.chain.advanceTime(22 * DAY);
    assert.equal((await ctx.jurorPool.call('jurorOf', [p2[0]])).held, JUROR_MIN_STAKE, 'held past the unbonding period');
    await ctx.court.send('resolveEscalation', [a.id, false], { from: GOVERNOR });
    // One answer: a second is a no-op (OC-COURT-03), so a second proposal on the case resolves too.
    const again = await ctx.court.send('resolveEscalation', [a.id, true], { from: GOVERNOR });
    assert.equal(ctx.court.events(again, 'EscalationResolved').length, 0, 'one answer');
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.DECIDED);
    const res = await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 1, 'the appeal verdict stood: the finding reaches the bond');
    assert.equal((await ctx.jurorPool.call('jurorOf', [p2[0]])).held, 0n, 'released only now');
    // The first panel, overturned, earns nothing; the fourteen of the appeal are paid from the challenger's D_1 + 4 D_1.
    assert.equal(await claim(ctx, ASSERTER), 3n * a.deposit + (5n * a.deposit - 14n * JUROR_FEE), 'the winner: its deposits, and what the loser\'s leave after the fees');
  });

  test('a lapsed escalation closes on the appeal verdict', async () => {
    const { ctx, a, payload } = await escalated();
    await assert.rejects(() => ctx.court.send('finalize', [a.id, payload]), /WindowOpen/);
    ctx.chain.advanceTime(14 * DAY);
    const res = await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 1);
    // A vote ending after the lapse resolves as a no-op (OC-COURT-03): it used to revert NotEscalated for good.
    const late = await ctx.court.send('resolveEscalation', [a.id, true], { from: GOVERNOR });
    assert.equal(ctx.court.events(late, 'EscalationResolved').length, 0);
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.FINAL);
  });

  test('retrial: twenty-eight jurors excluding both earlier panels, final, no further window', async () => {
    const { ctx, a, payload, p1, p2 } = await escalated();
    await ctx.court.send('resolveEscalation', [a.id, true], { from: GOVERNOR });
    const c = await caseOf(ctx, a.id);
    assert.equal(c.round, 3n);
    const p3 = await drawRound(ctx, a.id);
    assert.equal(p3.length, 28);
    assert.equal(p3.filter((x) => p1.includes(x) || p2.includes(x)).length, 0, 'a fresh panel: no juror of either earlier panel');
    await vote(ctx, a.id, Array(28).fill(V.REJECT));
    const r3 = await roundOf(ctx, a.id, 3);
    assert.equal(r3.appealEnd, r3.revealEnd, 'the retrial is final');
    await assert.rejects(() => ctx.court.send('appeal', [a.id], { from: ASSERTER, value: 2n * a.deposit }), /InvalidCaseState/);
    await assert.rejects(() => ctx.court.send('escalateToGovernance', [a.id], { from: ASSERTER, value: 4n * a.deposit }), /InvalidCaseState/);
    const res = await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 0, 'the retrial rejected it');
    const cut = (JUROR_MIN_STAKE * 3000n) / BPS;
    assert.equal((await ctx.jurorPool.call('jurorOf', [p2[0]])).active, JUROR_MIN_STAKE - cut, 'the appeal majority, overturned by the retrial, is slashed');
    assert.equal((await ctx.jurorPool.call('jurorOf', [p1[0]])).active, JUROR_MIN_STAKE, 'the first round, right in the end, is whole');
    await courtBalanceAccounts(ctx, [...p1, ...p2, ...p3, ASSERTER, CHALLENGER]);
  });
});

/* ------------------------------------------------------------------ */
/* The bound, frozen per case                                          */
/* ------------------------------------------------------------------ */

describe('V and the seat indexed on the book (whitepaper §6.2, §6.4; EC-04, PV-07)', () => {
  test('a loss asserted above the occurrence limit K is heard at K (adversarial: a claim inflated past what trigger 1 can draw buys no larger case)', async (t) => {
    if (needModel(t)) return;
    const ctx = await court();
    const k = await ctx.registry.call('requiredCapital');
    assert.ok(k < 50n * ONE, 'K is 12.33 units on a hundred anchored at the launch stage');
    for (const loss of [50n * ONE, 1000n * ONE]) {
      const [value] = await ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss }])]);
      const capped = M.ark.lossFindingValue(loss, k);
      assert.equal(capped, k);
      assert.equal(value, (capped * F.REF_PRICE + ONE - 1n) / ONE, 'V = K at the settlement series, rounded up');
    }
    // Below K the claim is its own value.
    const [small] = await ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: ONE }])]);
    assert.equal(small, F.REF_PRICE);
  });

  test('V_max, the seat and the S3 view agree with the model, and the seat follows the book up but never falls below a case\'s opening seat', async (t) => {
    if (needModel(t)) return;
    const ctx = await court({ jurors: 49, stakeEach: JUROR_MIN_STAKE });
    const k = await ctx.registry.call('requiredCapital');
    const att = Number(await ctx.registry.call('effectiveAttachmentBps'));
    const nMax = await ctx.registry.call('censorshipNotionalMax');
    assert.equal(nMax, 100n * ONE);
    const units = M.ark.findingValueMax(M.params, k, (BigInt(att) * nMax) / BPS);
    const price = await ctx.registry.call('settlementPrice');
    assert.equal(await ctx.findings.call('valueMax'), (units * price + ONE - 1n) / ONE);
    const vMaxArk = ((await ctx.findings.call('valueMax')) * ONE + ARK_PRICE - 1n) / ARK_PRICE;
    assert.equal(await ctx.findings.call('seatNow'), M.ark.indexedMinimumJurorStakeArk(JUROR_MIN_STAKE, vMaxArk));
    assert.equal(await ctx.findings.call('seatNow'), JUROR_MIN_STAKE, 'the floor binds on this book');
    // S3: 49 jurors at the seat and a pool of 7 * s_min * slices(V_max).
    const [ready, seat, slices, eligible, poolStake] = await ctx.findings.call('s3Ready');
    assert.equal(slices, BigInt(Math.max(1, M.ark.findingSlices(vMaxArk, seat, 3000, 6666))));
    assert.equal(eligible, 49n);
    assert.equal(ready, M.ark.s3JurorPoolSufficient(poolStake, seat, Number(slices), Number(eligible)));
    assert.equal(ready, true);
    // The ARK price falls a hundredfold: V_max in ARK rises, and with it the seat.
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ARK_PRICE / 100n]);
    const raised = await ctx.findings.call('seatNow');
    assert.ok(raised > JUROR_MIN_STAKE, 'one eighth of V_max above the floor');
    const [ready2, , , eligible2] = await ctx.findings.call('s3Ready');
    assert.equal(eligible2, 0n, 'no juror holds the raised seat free');
    assert.equal(ready2, false);
  });
});

describe('the verdict bound and the terms of a case (I24′, G8)', () => {
  test('a loss above the bound on the minimum seat is refused, and is heard as the model\'s number of pieces', async (t) => {
    if (needModel(t)) return;
    // A thousand units anchored: K (123.4 units) is above the bound on the
    // seat (80 units), so a loss past the bound is not capped back inside it.
    const ctx = await court({ positions: [{ owner: HOLDER, notional: 1000n * ONE }] });
    const bound = await ctx.findings.call('boundOf', [JUROR_MIN_STAKE, 3000, 6666]);
    assert.equal(bound, M.ark.verdictBound(4n * JUROR_MIN_STAKE, 3000, 6666), 'floor(κ * 4 * s_min * slash / BPS²)');
    // V = units * 10,000 QRL, V_ark = ceil(V * 1e18 / p): the largest whole-unit loss inside the bound, and one past it.
    const unitsIn = (bound * ARK_PRICE) / F.REF_PRICE / ONE;
    const vArk = (units) => (units * ONE * F.REF_PRICE + ARK_PRICE - 1n) / ARK_PRICE;
    assert.ok(vArk(unitsIn) <= bound && vArk(unitsIn + 1n) > bound);
    assert.ok((await ctx.registry.call('requiredCapital')) > (unitsIn + 1n) * ONE, 'K is above the loss, which V is not capped at');
    const outside = lossPayload([{ id: ctx.pos[0].id, loss: (unitsIn + 1n) * ONE }]);
    await assert.rejects(() => ctx.findings.call('quote', [KIND.LOSS, outside]), /ClaimAboveBound/);
    await assert.rejects(() => ctx.court.send('assertFinding', [KIND.LOSS, outside, EVIDENCE], { from: ASSERTER, value: 10n ** 24n }), /ClaimAboveBound/);
    assert.equal(await ctx.findings.call('piecesFor', [vArk(unitsIn + 1n)]), BigInt(M.ark.determinationsFor(vArk(unitsIn + 1n), bound)), 'ceil(V * BPS / (κ * F_1)) pieces');
    assert.equal(await ctx.findings.call('piecesFor', [vArk(3n * unitsIn)]), BigInt(M.ark.determinationsFor(vArk(3n * unitsIn), bound)));
    const inside = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: unitsIn * ONE }]));
    assert.equal(inside.seat, JUROR_MIN_STAKE, 'a loss is heard on the minimum seat');
    assert.equal(inside.valueArk, vArk(unitsIn));
  });

  test('the bound agrees with the model, and a purchased first round costs at least 1.5 V at κ <= 6,666 (Eq. 4.1′)', async (t) => {
    if (needModel(t)) return;
    const ctx = await court({ jurors: 7 });
    for (const kappa of [3333, 5000, 6666, 8000]) {
      for (const slash of [500, 1750, 3000]) {
        for (const seat of [JUROR_MIN_STAKE, 37n * JUROR_MIN_STAKE + 12345n]) {
          const bound = await ctx.findings.call('boundOf', [seat, slash, kappa]);
          assert.equal(bound, M.ark.verdictBound(4n * seat, slash, kappa), `bound at κ ${kappa}, slash ${slash}`);
          // F_1 = 4 * seat * slash / BPS, kept exact: scaled by BPS on both sides.
          const F1bps = 4n * seat * BigInt(slash);
          const floor = M.ark.bribeCostFloor(bound, kappa);
          assert.ok(bound * BPS * BPS <= BigInt(kappa) * F1bps, `the bound is at most κ F_1 at κ ${kappa}`);
          assert.ok((floor - 1n) * BPS < F1bps, `F_1 covers the bribe-cost floor of the bound at κ ${kappa}`);
          if (kappa <= 6666) assert.ok(2n * floor >= 3n * bound, 'at least one and a half times what it moves');
          else assert.ok(4n * floor >= 5n * bound, 'five quarters at the top of the range');
        }
      }
    }
  });

  test('a single fact above the bound on the seat is heard in value slices, each its own case at the seat (EC-04; adversarial: no seat is raised past what a pool can seat)', async (t) => {
    if (needModel(t)) return;
    const ctx = await court({ jurors: 12, stakeEach: 40n * JUROR_MIN_STAKE });
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ONE]); // one QRL an ARK: the censorship draw is far above the minimum bound
    const [value, valueArk, seat, deposit, slices] = await ctx.findings.call('quote', [KIND.CENSORSHIP, uintPayload(0n)]);
    // V = D_0 of the full settlement, S_full <= min(pool, K_T) with K_T on the
    // widest claimant base (re-audit 2026-09-30, COURT-03), rounded up.
    const capUnits = (BigInt(await ctx.registry.call('effectiveAttachmentBps')) * (await ctx.registry.call('censorshipNotionalMax'))) / BPS;
    const capQrl = (capUnits * (await ctx.registry.call('settlementPrice')) + ONE - 1n) / ONE;
    const full = capQrl < 100_000n * ONE ? capQrl : 100_000n * ONE;
    assert.equal(value, (full * 6000n + BPS - 1n) / BPS, 'V = D_0 of min(pool, K_T)');
    // The seat in force is indexed on V_max (PV-07), and is not raised for V.
    assert.equal(seat, await ctx.findings.call('seatNow'), 'the seat in force, not raised to cover V');
    const bound = await ctx.findings.call('boundOf', [seat, 3000, 6666]);
    assert.ok(valueArk > bound, 'above the bound on the seat');
    assert.equal(slices, BigInt(M.ark.findingSlices(valueArk, seat, 3000, 6666)), 'the model\'s findingSlices');
    assert.ok(slices > 1n && (valueArk + slices - 1n) / slices <= bound, 'each slice inside the bound');
    assert.equal(deposit, M.ark.assertionDeposit((value + slices - 1n) / slices, DEPOSIT_BASE), 'each slice deposits on V / n');
    await assert.rejects(
      () => ctx.court.send('assertFinding', [KIND.CENSORSHIP, uintPayload(0n), EVIDENCE], { from: ASSERTER, value: deposit }),
      /IncorrectBond/,
      'one deposit per slice',
    );
    const a = await assertFinding(ctx, KIND.CENSORSHIP, uintPayload(0n));
    const [so] = ctx.s.events(a.res, 'SlicesOpened');
    const g = so.args.group;
    assert.equal(so.args.n, slices);
    assert.equal(ctx.bond.events(a.res, 'DeterminationOpened').length, 1, 'one determination for the group');
    assert.equal(a.ids.length, Number(slices));
    for (let i = 0; i < a.ids.length; i++) {
      assert.equal(a.ids[i], keccak256(coder.encode(['bytes32', 'uint8'], [g, i])), 'the i-th case id');
      const c = await caseOf(ctx, a.ids[i]);
      assert.deepEqual([c.seat, c.group, c.sliceIndex, c.slices, c.deposit], [seat, g, BigInt(i), slices, deposit]);
    }
    assert.equal(await ctx.court.call('openSeatStake'), slices * 7n * seat, 'each slice reserves its first round');
    await assert.rejects(() => assertFinding(ctx, KIND.CENSORSHIP, uintPayload(0n), OTHER), /FindingPending/);
    // Every slice stands unchallenged: the ground stands with the last
    // (re-audit 2026-09-30, COURT-04), the bond's determination closes with
    // it, and the kind's slot with it.
    until(ctx, (await caseOf(ctx, a.ids[0])).openedAt + 7n * BigInt(DAY));
    for (let i = 0; i < a.ids.length; i++) {
      const res = await ctx.court.send('finalize', [a.ids[i], uintPayload(0n)]);
      assert.equal(ctx.s.events(res, 'Trigger2Grounded').length, i === a.ids.length - 1 ? 1 : 0);
      assert.equal(ctx.bond.events(res, 'DeterminationClosed').length, i === a.ids.length - 1 ? 1 : 0);
    }
    assert.equal(await ctx.court.call('openSeatStake'), 0n);
    assert.equal((await ctx.s.call('sliceGroup')).id, '0x' + '00'.repeat(32));
    // The whole ground upheld: the opening draws D_0 of the pool, as unsliced.
    const res = await open2(ctx);
    assert.equal(ctx.s.events(res, 'Trigger2Drawn')[0].args.drawQrl, (100_000n * ONE * 6000n) / BPS);
    assert.equal((await ctx.s.call('declaration')).stage, 3n);
  });

  test('a slice the jury rejects reaches the bond and settles its fraction: the ground draws only the upheld part (EC-04)', async (t) => {
    if (needModel(t)) return;
    const ctx = await court({ jurors: 12, stakeEach: 40n * JUROR_MIN_STAKE });
    await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, ONE]);
    const a = await assertFinding(ctx, KIND.CENSORSHIP, uintPayload(0n));
    const n = a.ids.length;
    // Slice 0 challenged and rejected by its panel; the rest stand.
    await toFirstPanel(ctx, a.ids[0], a.deposit);
    await vote(ctx, a.ids[0], Array(7).fill(V.REJECT));
    until(ctx, (await roundOf(ctx, a.ids[0], 1)).appealEnd);
    const rej = await ctx.court.send('finalize', [a.ids[0], '0x']);
    const [closed] = ctx.s.events(rej, 'SliceClosed');
    assert.equal(closed.args.upheld, false, 'a rejection is delivered as well');
    assert.equal(ctx.s.events(rej, 'Trigger2Grounded').length, 0);
    for (let i = 1; i < n; i++) await ctx.court.send('finalize', [a.ids[i], uintPayload(0n)]);
    await open2(ctx);
    const d = await ctx.s.call('declaration');
    const U = 10n ** 18n - M.ark.sliceFraction(10n ** 18n, n, 0);
    assert.equal(d.drawn, M.ark.slicedDrawTarget(d.fullSettlement, U * d.d0), 'floor(S * D_0 * U / (BPS * F))');
    assert.equal(d.stage, 3n);
  });

  test('κ, the slash and the windows are fixed at the opening: a vote after it reaches the next case, not this one (G8)', async () => {
    const ctx = await court({ jurors: 30, stakeEach: 4n * JUROR_MIN_STAKE }); // two cases open at once
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 50n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    await F.enactParams(ctx.chain, ctx.params, { jurorSlashBps: 2000, verdictCoverBps: 5500, commitDays: 1 });
    const c = await caseOf(ctx, a.id);
    assert.equal(c.slashBps, 3000n);
    assert.equal(c.coverBps, 6666n);
    assert.equal(c.commitDays, 2n);
    const b = await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: 10n * ONE }]), OTHER);
    const cb = await caseOf(ctx, b.id);
    assert.equal(cb.slashBps, 2000n, 'the next case is heard under the new values');
    assert.equal(cb.coverBps, 5500n);
    until(ctx, c.openedAt + 10n * BigInt(DAY));
    await ctx.court.send('armDraw', [a.id]);
    const panel = await drawRound(ctx, a.id);
    const r = await roundOf(ctx, a.id, 1);
    assert.equal(r.commitEnd - BigInt(ctx.chain.timestamp), 2n * BigInt(DAY), 'the commit window the case opened with');
    await vote(ctx, a.id, [V.REJECT, V.REJECT, V.REJECT, V.REJECT, V.REJECT, V.REJECT, V.UPHOLD]);
    until(ctx, (await roundOf(ctx, a.id, 1)).appealEnd);
    await ctx.court.send('finalize', [a.id, '0x']);
    assert.equal((await ctx.jurorPool.call('jurorOf', [panel[6]])).active, ctx.stakeEach - (JUROR_MIN_STAKE * 3000n) / BPS, 'slashed at the 3,000 bps in force at the opening');
  });

  test('determinations heard at once are capped by the pool, each case reserving its first round\'s seven seats: floor(S_pool / (7 * s_min)) (QL-19, PV-01)', async () => {
    const ctx = await court({ jurors: 7 });
    assert.equal(await ctx.jurorPool.call('poolStake'), 7n * JUROR_MIN_STAKE);
    // A view of the findings module since the value slices of 2026-09-30.
    assert.equal(await ctx.findings.call('concurrencyCap'), 1n);
    assert.equal(await ctx.court.call('openSeatStake'), 0n);
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    assert.equal(await ctx.court.call('openSeatStake'), 7n * JUROR_MIN_STAKE, 'the first round\'s seven seats, no more');
    await assert.rejects(() => assertFinding(ctx, KIND.LOSS, payload, OTHER), /PoolAtCapacity/, 'a second waits for the first to close');
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    await ctx.court.send('finalize', [a.id, payload]);
    await assertFinding(ctx, KIND.LOSS, payload, OTHER);
  });
});

/* ------------------------------------------------------------------ */
/* Each finding through the bond                                       */
/* ------------------------------------------------------------------ */

describe('each kind of finding, from the assertion through the bond\'s settlement (yellow paper §4.1, §4.3)', () => {
  test('the censorship ground: the finding fixes T, and the record opens D_0 of the full settlement, junior first (item 25b)', async () => {
    const ctx = await court();
    const a = await assertFinding(ctx, KIND.CENSORSHIP, uintPayload(0n));
    assert.equal(ctx.bond.events(a.res, 'DeterminationOpened').length, 1);
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    const found = await ctx.court.send('finalize', [a.id, uintPayload(0n)]);
    assert.equal(ctx.s.events(found, 'Trigger2Grounded').length, 1, 'the ground and T, recorded at the finding');
    assert.equal(ctx.s.events(found, 'Trigger2Drawn').length, 0, 'the draw waits for the claimant record');
    const res = await open2(ctx);
    const [ev] = ctx.s.events(res, 'Trigger2Drawn');
    assert.equal(ev.args.drawQrl, (100_000n * ONE * 6000n) / BPS, '100 vested units at 10,000 QRL exceed the pool: D_0 of the pool');
    const t2 = await ctx.s.call('declaration');
    assert.equal(t2.censorship, true);
    assert.equal(t2.stage, 3n);
  });

  /** A declared book whose severity is held under a dead series (item 25a). */
  async function held() {
    const ctx = await court({ term: TERM.QUARTER, vested: false, vestFirst: true });
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    // The ARK price seen before the oracle fell silent, for every key (OC-ORC-03, -09): the seat is valued on it.
    await ctx.findings.send('carryArkPrice');
    await ctx.oracle.send('setReverting', [true]);
    await ctx.s.send('settleSeverity');
    return { ctx, t2 };
  }

  test('the m_loss of a held balance: opened only 2 x W_a after the window, and settles the hold as the court\'s', async () => {
    const { ctx, t2 } = await held();
    const payload = uintPayload(9000n);
    await assert.rejects(() => ctx.findings.call('quote', [KIND.SEVERITY, payload]), /SeverityNotOpen/);
    F.toEpoch(ctx, t2.epoch + 4n + 8n);
    const a = await assertFinding(ctx, KIND.SEVERITY, payload);
    const heldNow = (await ctx.s.call('declaration')).held;
    assert.ok(heldNow > 0n);
    assert.equal(a.value, heldNow, 'V: the held balance the finding divides, whatever m_loss it states (QL-23)');
    // The audit's cheap assertion: m_loss at the floor, formerly V = 0, a minimum seat and the whole balance released.
    const low = await ctx.findings.call('quote', [KIND.SEVERITY, uintPayload(0n)]);
    assert.equal(low[0], heldNow, 'a low m_loss is valued on the same balance, so on the same seat (C-8)');
    await assert.rejects(() => assertFinding(ctx, KIND.SEVERITY, uintPayload(0n), OTHER), /FindingPending/, 'concurrent findings on one determination are serialised');
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    const res = await ctx.court.send('finalize', [a.id, payload]);
    const [ev] = ctx.s.events(res, 'SeveritySettled');
    assert.equal(ev.args.byCourt, true);
    assert.equal(ev.args.drawTotalBps, 9000n);
  });

  test('a recovery on an admitted successor: the bond takes min(R, P_rem), senior first', async () => {
    const ctx = await court({ term: TERM.QUARTER, vested: false, vestFirst: true });
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    const t2 = await ctx.s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('set', [9000n * ONE, 9000n * ONE, 9000n * ONE]);
    await ctx.s.send('settleSeverity');
    const successor = '0x' + 'a1'.repeat(32);
    await ctx.params.send('admitSuccessor', [CHAIN_ID, successor]);
    const [pRem] = await ctx.r.call('recoveryResidual', [CHAIN_ID, F.ESCROW]);
    const payload = recoveryPayload(CHAIN_ID, successor, F.ESCROW, 3n * ONE, 100n * ONE);
    const a = await assertFinding(ctx, KIND.RECOVERY, payload);
    // Valued at the escrow's residual P_rem, at the declaration's price (OC-COURT-05): it was heard at V = 0.
    const price = (await ctx.s.call('declaration')).price;
    assert.ok(pRem > 0n);
    assert.equal(a.value, (pRem * price + ONE - 1n) / ONE, 'V: P_rem in QRL, rounded up');
    assert.ok(a.valueArk <= (await ctx.findings.call('boundOf', [a.seat, 3000n, 6666n])), 'inside the bound on its seat (I24′)');
    // The deposit's base is base_orig at the price at the assertion, 9,000 QRL here, not the declaration's (yellow paper §5.1).
    const base = (F.DEPOSIT_BASE_ORIG * 9000n * ONE + ONE - 1n) / ONE;
    const floor = base > 7n * JUROR_FEE ? base : 7n * JUROR_FEE;
    assert.equal(a.deposit, (a.value + 99n) / 100n > floor ? (a.value + 99n) / 100n : floor);
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    await ctx.court.send('finalize', [a.id, payload]);
    const r = await ctx.r.call('recoveryOf', [a.id]);
    assert.equal(r.applied, true, 'the first admitted successor: nothing ahead of it');
    assert.equal(r.escrow.toLowerCase(), F.ESCROW.toLowerCase());
    assert.equal(r.toClass[0] + r.toClass[1], 3n * ONE < pRem ? 3n * ONE : pRem, 'min(R, P_rem) (I36)');
  });

  test('a finding the bond no longer admits closes the case, recorded, and nothing moves', async () => {
    const ctx = await court();
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await open2(ctx);
    until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
    const res = await ctx.court.send('finalize', [a.id, payload]);
    const [ev] = ctx.court.events(res, 'FindingRefused');
    assert.ok(ev, 'the bond refused: the triggers are exclusive');
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 0);
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.FINAL);
    await assert.rejects(() => ctx.court.send('finalize', [a.id, payload]), /InvalidCaseState/);
    assert.equal(await ctx.court.call('owed', [ASSERTER]), 0n, 'a finding the bond refused forfeits its deposit (QL-20)');
    assert.equal(await ctx.court.call('feePool'), a.deposit, 'into the fee pool (OC-COURT-07)');
    await courtBalanceAccounts(ctx, [ASSERTER]);
  });

  test('a loss that moves nothing, or less than base_orig, or names no anchored position, is not heard (QL-20; PoC C-5; OC-COURT-02)', async () => {
    const ctx = await court({ jurors: 7 });
    const send = (payload) => ctx.court.send('assertFinding', [KIND.LOSS, payload, EVIDENCE], { from: OTHER, value: 100_000n * ONE });
    // Zero, and a dust loss on a real position: below base_orig, in origin units.
    await assert.rejects(() => send(lossPayload([{ id: ctx.pos[0].id, loss: 0n }])), /LossBelowFloor/, 'V = 0: no case, no capacity held, no determination opened');
    await assert.rejects(() => send(lossPayload([{ id: ctx.pos[0].id, loss: 1n }])), /LossBelowFloor/, 'a 1-wei loss');
    // A loss on an id the registry does not know is refused at the assertion: it used to suspend the book until the bond refused it.
    await assert.rejects(() => send(lossPayload([{ id: keccak256(toUtf8Bytes('nope')), loss: ONE }])), /NotAnchored/);
    await assert.rejects(() => ctx.findings.call('quote', [KIND.LOSS, lossPayload([{ id: keccak256(toUtf8Bytes('nope')), loss: ONE }])]), /NotAnchored/);
    assert.equal((await ctx.bond.call('state')).determinationsOpen, 0n);
    assert.equal(await ctx.court.call('openCases'), 0n);
  });

  test('finalize under any gas limit either delivers the finding or reverts: a starved call is never recorded as a refusal (QL-22; PoC C-7)', async () => {
    const build = async () => {
      const ctx = await court({ jurors: 7, positions: Array.from({ length: 30 }, () => ({ owner: HOLDER, notional: 10n * ONE })) });
      const payload = lossPayload(ctx.pos.map((p) => ({ id: p.id, loss: ONE / 10n })));
      const a = await assertFinding(ctx, KIND.LOSS, payload);
      until(ctx, (await caseOf(ctx, a.id)).openedAt + 7n * BigInt(DAY));
      return { ctx, a, payload };
    };
    const full = await build();
    const ok = await full.ctx.court.send('finalize', [full.a.id, full.payload], { from: OTHER });
    assert.equal(full.ctx.court.events(ok, 'FindingApplied').length, 1);
    const G = BigInt(ok.gasUsed);
    const { ctx, a, payload } = await build();
    let refused = 0;
    let reverted = 0;
    for (let k = 40n; k <= 104n; k += 4n) {
      ctx.chain.gasPool = (G * k) / 100n;
      try {
        const res = await ctx.court.send('finalize', [a.id, payload], { from: OTHER });
        refused += ctx.court.events(res, 'FindingRefused').length;
        assert.equal(ctx.court.events(res, 'FindingApplied').length, 1, 'a finalize that lands delivers the finding');
        break;
      } catch (e) {
        reverted += 1;
      } finally {
        ctx.chain.gasPool = 30_000_000n;
      }
    }
    assert.equal(refused, 0, 'no gas limit drops the finding');
    assert.ok(reverted > 0, 'the scan did reach the starved range');
    assert.equal((await caseOf(ctx, a.id)).stage, STAGE.FINAL);
  });
});

describe('a panel the pool cannot seat: re-armed as the pool grows, then resolved for the unchallenged side (court question w)', () => {
  /** A challenged loss past its evidence window, round 1 armed and its draw block reached. */
  async function undrawable(ctx) {
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    await ctx.court.send('challenge', [a.id], { from: CHALLENGER, value: a.deposit });
    const c = await caseOf(ctx, a.id);
    until(ctx, c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY));
    await ctx.court.send('armDraw', [a.id]);
    const r = await roundOf(ctx, a.id, 1);
    while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
    return { a, payload };
  }

  /** Draw a round the pool cannot seat: nothing seated, the arm spent. */
  async function unseatable(ctx, id) {
    const res = await ctx.court.send('drawPanel', [id]);
    assert.equal(ctx.court.events(res, 'PanelUnseatable').length, 1);
    assert.equal(ctx.court.events(res, 'JuryDrawn').length, 0);
  }

  test('re-armed freely inside its window, counted once a window lapses; after four the assertion fails and every deposit returns', async () => {
    // One juror holding seven seats' stake: the cap admits one case, a panel needs seven jurors.
    const ctx = await court({ jurors: 1 });
    const { a } = await undrawable(ctx);
    await unseatable(ctx, a.id);
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /WindowOpen/);
    await assert.rejects(() => ctx.court.send('armDraw', [a.id]), /InvalidCaseState/, 'not re-armed inside the draw block\'s window (QL-18)');
    // Once that window has passed a round is armed again, and inside the draw window counts nothing.
    ctx.chain.advanceTime(257 * 12);
    await ctx.court.send('armDraw', [a.id], { from: OTHER });
    assert.equal((await roundOf(ctx, a.id, 1)).lapses, 0n);
    const W = Number(await ctx.court.call('DRAW_WINDOW'));
    const MAX = await ctx.court.call('MAX_DRAW_LAPSES');
    assert.equal(W, EPOCH, 'one epoch: stake joins the draw at the next epoch boundary');
    assert.equal(MAX, 4n);
    for (let i = 1n; i <= MAX; i++) {
      ctx.chain.advanceTime(W);
      await ctx.court.send('armDraw', [a.id], { from: OTHER });
      assert.equal((await roundOf(ctx, a.id, 1)).lapses, i, 'a re-arm after a lapsed window is a failed draw');
      if (i < MAX) await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /WindowOpen/);
    }
    // Not while the round's draw is armed and drawable (re-audit 2026-09-30, COURT-07).
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id], { from: OTHER }), /WindowOpen/);
    ctx.chain.advanceTime(270 * 12);
    const res = await ctx.court.send('lapseDraw', [a.id], { from: OTHER });
    const [ev] = ctx.court.events(res, 'DrawLapsed');
    assert.equal(ev.args.lapses, 4n);
    const [fin] = ctx.court.events(res, 'CaseFinal');
    assert.equal(fin.args.outcome, 2n, 'the assertion is rejected');
    assert.equal(fin.args.jurorFees, 0n);
    const c = await caseOf(ctx, a.id);
    assert.equal(c.stage, STAGE.FINAL);
    assert.equal(await ctx.court.call('owed', [ASSERTER]), a.deposit, 'nothing forfeited: no jury found it false');
    assert.equal(await ctx.court.call('owed', [CHALLENGER]), a.deposit);
    assert.equal(await ctx.court.call('feePool'), 0n, 'nothing forfeited');
    assert.equal((await ctx.bond.call('state')).determinationsOpen, 0n, 'the bond\'s determination is closed');
    assert.equal(await ctx.court.call('openCases'), 0n);
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /InvalidCaseState/);
    await assert.rejects(() => ctx.court.send('finalize', [a.id, '0x']), /InvalidCaseState/);
    // A determination can always be asserted again.
    await assertFinding(ctx, KIND.LOSS, lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]));
    await courtBalanceAccounts(ctx, [ASSERTER, CHALLENGER], (await caseOf(ctx, await ctx.court.call('caseAt', [2n]))).deposit);
  });

  test('without a re-arm, four draw windows from the first arming resolve it all the same', async () => {
    const ctx = await court({ jurors: 1 });
    const { a } = await undrawable(ctx);
    const r = await roundOf(ctx, a.id, 1);
    until(ctx, r.armedAt + 4n * BigInt(EPOCH) - 1n);
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /WindowOpen/);
    ctx.chain.advanceTime(1);
    await ctx.court.send('lapseDraw', [a.id]);
    assert.equal((await caseOf(ctx, a.id)).outcome, 2n);
  });

  test('as the pool grows, the re-armed round is drawn and the case goes on', async () => {
    const ctx = await court({ jurors: 1 });
    const { a } = await undrawable(ctx);
    await unseatable(ctx, a.id);
    // Six more stake now; they join the draw at the next epoch boundary.
    for (let i = 1; i <= 6; i++) {
      const j = juror(100 + i);
      await ctx.ark.send('transfer', [j, JUROR_MIN_STAKE], { from: ACCOUNTS.admin });
      await ctx.ark.send('approve', [ctx.jurorPool.address, JUROR_MIN_STAKE], { from: j });
      await ctx.jurorPool.send('stake', [JUROR_MIN_STAKE], { from: j });
    }
    ctx.chain.advanceTime(EPOCH);
    await ctx.court.send('armDraw', [a.id]);
    assert.equal((await roundOf(ctx, a.id, 1)).lapses, 1n);
    const panel = await drawRound(ctx, a.id);
    assert.equal(panel.length, 7);
    await assert.rejects(() => ctx.court.send('lapseDraw', [a.id]), /InvalidCaseState/, 'a drawn round does not lapse');
  });

  test('an appeal panel the pool cannot seat: the first round\'s verdict stands and the appellant loses (QL-19; PoC C-4)', async () => {
    // Ten jurors: seven for round 1, and fourteen that exclude them do not exist.
    const ctx = await court({ jurors: 10 });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: 5n * ONE }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload);
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    // The audit's move: round 1 upholds all but unanimously; the challenger appeals into an unseatable panel.
    await vote(ctx, a.id, [V.UPHOLD, V.UPHOLD, V.UPHOLD, V.UPHOLD, V.REJECT, V.REJECT, 'x']);
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    const r2 = await roundOf(ctx, a.id, 2);
    while (BigInt(ctx.chain.blockNumber) <= r2.drawBlock) ctx.chain.advanceTime(0);
    await unseatable(ctx, a.id);
    until(ctx, r2.armedAt + 4n * BigInt(EPOCH));
    const lapsed = await ctx.court.send('lapseDraw', [a.id], { from: CHALLENGER });
    assert.equal(ctx.court.events(lapsed, 'DrawLapsed').length, 1);
    const c = await caseOf(ctx, a.id);
    assert.equal(c.stage, STAGE.DECIDED, 'decided on the previous round');
    assert.equal(c.outcome, BigInt(V.UPHOLD), 'the round-1 verdict stands: no rejection by lapse');
    const res = await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(ctx.s.events(res, 'LossDetermined').length, 1, 'the upheld finding reaches the bond');
    const cut = (JUROR_MIN_STAKE * 3000n) / BPS;
    for (let i = 0; i < 7; i++) {
      const s = await ctx.jurorPool.call('jurorOf', [p1[i]]);
      assert.equal(s.held, 0n, 'the seat is released');
      assert.equal(s.active, i < 4 ? ctx.stakeEach : ctx.stakeEach - cut, 'judged against the verdict that stood');
    }
    assert.equal(await ctx.court.call('owed', [CHALLENGER]), 0n, 'the appellant forfeits its deposits');
    assert.equal(await ctx.court.call('owed', [ASSERTER]), a.deposit + 3n * a.deposit - 4n * JUROR_FEE, 'the asserter: its deposit and the loser\'s, less the fees');
    await courtBalanceAccounts(ctx, [ASSERTER, CHALLENGER, ...p1]);
  });
});

describe('the fee pool pays what it holds, and the losing deposit first (whitepaper §6.2)', () => {
  test('the losing deposits pay the coherent seats before the pool is touched', async () => {
    const ctx = await court({ jurors: 30 });
    // A claim at the floor, the base deposit's worth (OC-COURT-02), by its beneficiary: the deposit is the base.
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: ONE / 10n }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload, HOLDER);
    assert.equal(a.deposit, DEPOSIT_BASE, 'a small claim posts the base');
    await ctx.court.send('fundFeePool', [], { from: OTHER, value: 50n * ONE });
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, Array(7).fill(V.UPHOLD));
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    const p2 = await drawRound(ctx, a.id);
    await vote(ctx, a.id, Array(14).fill(V.UPHOLD));
    until(ctx, (await roundOf(ctx, a.id, 2)).appealEnd);
    // 21 coherent seats x 100 = 2,100 against the challenger's 3,000: its deposits pay them all.
    await ctx.court.send('finalize', [a.id, payload]);
    assert.equal(await ctx.court.call('owed', [p1[0]]), JUROR_FEE);
    assert.equal(await ctx.court.call('feePool'), 50n * ONE, 'the pool untouched');
    assert.equal(await claim(ctx, HOLDER), DEPOSIT_BASE + 3n * DEPOSIT_BASE - 21n * JUROR_FEE);
    await courtBalanceAccounts(ctx, [...p1, ...p2, HOLDER, CHALLENGER]);
  });

  test('where the losing deposit is short, the pool pays the balance, pro rata where it holds too little', async () => {
    // Seven juror fees are the least first deposit (yellow paper §5.1), so the
    // losing deposit alone pays a first panel; the shortfall arises where the
    // asserter loses an appeal: fourteen coherent seats cost 1,400 against
    // the 1,000 it posted.
    const ctx = await court({ jurors: 30 });
    const payload = lossPayload([{ id: ctx.pos[0].id, loss: ONE / 10n }]);
    const a = await assertFinding(ctx, KIND.LOSS, payload, HOLDER);
    assert.equal(a.deposit, DEPOSIT_BASE);
    await ctx.court.send('fundFeePool', [], { from: OTHER, value: 200n * ONE });
    const p1 = await toFirstPanel(ctx, a.id, a.deposit);
    await vote(ctx, a.id, Array(7).fill(V.UPHOLD));
    await ctx.court.send('appeal', [a.id], { from: CHALLENGER, value: 2n * a.deposit });
    const p2 = await drawRound(ctx, a.id);
    await vote(ctx, a.id, Array(14).fill(V.REJECT));
    until(ctx, (await roundOf(ctx, a.id, 2)).appealEnd);
    const res = await ctx.court.send('finalize', [a.id, payload]);
    const [ev] = ctx.court.events(res, 'CaseFinal');
    // 1,000 from the losing deposit, then the pool's 200 of the 400 short: 1,200 across fourteen seats.
    const paid = DEPOSIT_BASE + 200n * ONE;
    const each = paid / 14n;
    assert.equal(ev.args.fromFeePool, 200n * ONE, 'the pool pays what it holds');
    assert.equal(await ctx.court.call('owed', [p2[0]]), each, 'every coherent seat is paid alike, the shortfall shared');
    assert.equal(await ctx.court.call('owed', [p1[0]]), 0n, 'a seat against the final verdict is paid nothing');
    assert.equal(await ctx.court.call('feePool'), paid - each * 14n, 'the remainder of the division returns to the pool');
    assert.equal(ev.args.toBuffer, 0n, 'the loser\'s deposit went to the fees');
    assert.equal(await claim(ctx, CHALLENGER), 3n * DEPOSIT_BASE, 'the winner\'s deposits return');
    await courtBalanceAccounts(ctx, [...p1, ...p2, HOLDER, CHALLENGER]);
  });
});

/* ------------------------------------------------------------------ */
/* contracts/core: the governor's half, the Q-Day oracle, deployment   */
/* ------------------------------------------------------------------ */

describe('contracts/core: the terminal step\'s interface, the real Q-Day oracle, and the governance record', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { CORE, coreBuild, deployCore } = require('./core-build');
  const coreFile = (...p) => path.join(CORE, 'contracts', ...p);
  const ours = (...p) => path.join(__dirname, '..', 'contracts', ...p);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  test('IArkCourtEscalation is core\'s, word for word', (t) => {
    if (!fs.existsSync(coreFile('interfaces', 'IArkCourtEscalation.hyp'))) return t.skip(`the ecosystem contracts are not checked out at ${CORE}`);
    const strip = (s) => norm(s.slice(s.indexOf('interface IArkCourtEscalation')));
    assert.equal(strip(fs.readFileSync(ours('interfaces', 'IArkCourtEscalation.hyp'), 'utf8')), strip(fs.readFileSync(coreFile('interfaces', 'IArkCourtEscalation.hyp'), 'utf8')));
  });

  test('the three views the registry and the bond read are core\'s ArkQDayOracle state, signature for signature', (t) => {
    if (!fs.existsSync(coreFile('interfaces', 'IArkQDayOracle.hyp'))) return t.skip(`the ecosystem contracts are not checked out at ${CORE}`);
    const theirs = norm(fs.readFileSync(coreFile('interfaces', 'IArkQDayOracle.hyp'), 'utf8'));
    const src = fs.readFileSync(ours('interfaces', 'IArkStakeExternal.hyp'), 'utf8');
    const block = src.slice(src.indexOf('interface IQDayOracle'), src.indexOf('}', src.indexOf('interface IQDayOracle')));
    const sigs = block.match(/function [^;]+;/g);
    assert.deepEqual(sigs.map((x) => x.split('(')[0]), ['function declared', 'function frozen', 'function declaredAt']);
    for (const sig of sigs) assert.ok(theirs.includes(norm(sig)), `${sig} is in core's IArkQDayState`);
  });

  test('the bond and the registry run on core\'s own ArkQDayOracle: frozen at the advisory, declared at the ratification', async (t) => {
    if (!coreBuild('ArkQDayOracle')) return t.skip(`contracts/core has no build at ${path.join(CORE, 'build')}`);
    const attesters = [0, 1, 2, 3, 4].map((i) => '0x' + (0x3000 + i).toString(16).padStart(40, '0'));
    let oracle;
    const ctx = await F.deployBondStack({
      qday: async (chain) => {
        oracle = await deployCore(chain, 'ArkQDayOracle', ['address', 'address', 'uint256', 'uint64', 'address[]'], [ACCOUNTS.admin, '0x' + '00'.repeat(20), ONE, 7n * BigInt(DAY), attesters]);
        return oracle.address;
      },
    });
    const pos = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, notional: 100n * ONE });
    ctx.chain.advanceTime(91 * DAY);
    await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 70_000n * ONE });
    await oracle.send('setGovernor', [GOVERNOR]);
    for (const a of attesters) {
      await ctx.chain.fund(a, 10n * ONE);
      await oracle.send('postBond', [], { from: a, value: ONE });
    }
    const s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
    await oracle.send('raiseAdvisory', [EVIDENCE], { from: attesters[0] });
    assert.equal(await ctx.qday.call('frozen'), true, 'the advisory freezes at once, read through the interface the bond uses');
    assert.equal(await ctx.qday.call('declared'), false);
    await assert.rejects(() => s.send('settleDeclaration'), /DeclarationNotRatified/, 'a freeze pays nothing');
    for (const a of attesters.slice(1)) await oracle.send('certify', [], { from: a });
    await oracle.send('resolve', [1n, true], { from: GOVERNOR });
    assert.equal(await ctx.qday.call('declared'), true);
    assert.ok((await ctx.qday.call('declaredAt')) > 0n);
    await assert.rejects(() => ctx.registry.send('instructRelease', [pos.id, HOLDER], { from: HOLDER }), /ReleaseClosed/, 'release closes on core\'s declaration');
    // The claimants are recorded as of core's ratification (declaredAt).
    await ctx.chain.at('ArkCatBondRecovery', ctx.bond.address).send('recordClaimants', [[pos.id]]);
    // The forward root of the epoch before the ratification's (audit 2026-09-22, G6).
    // Its count of anchors, none (audit 2026-09-29, QL-05, QL-06).
    const prior = BigInt(await ctx.qday.call('declaredAt')) / BigInt(F.EPOCH) - 1n;
    await ctx.attest.send('seal', [prior, F.anchorCountLeaf(prior, 0n)]);
    await ctx.chain.at('ArkCatBondRecovery', ctx.bond.address).send('provePriorAnchors', [0n, []]);
    const res = await s.send('settleDeclaration');
    const [drawn] = s.events(res, 'Trigger2Drawn');
    assert.equal(drawn.args.drawQrl, (70_000n * ONE * 6000n) / BPS, 'the floor draw runs on core\'s declaration');
    assert.equal((await s.call('declaration')).declaredAt, await ctx.qday.call('declaredAt'), 'T is core\'s ratification');
  });

  test('deployQrlLeg reads core\'s governance record: every address it names, for this chain only', () => {
    const { governanceRecordOf } = require('../scripts/lib/deploy');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-gov-'));
    const file = path.join(dir, 'governance-7.json');
    const addresses = { ArkToken: 'Q' + '11'.repeat(20), VeArk: 'Q' + '22'.repeat(20), ArkQDayOracle: 'Q' + '33'.repeat(20), ArkTimelock: 'Q' + '44'.repeat(20), ArkGovernor: 'Q' + '55'.repeat(20) };
    fs.writeFileSync(file, JSON.stringify({ chainId: 7, addresses }));
    const r = governanceRecordOf({ chain: 'local', qrlChainId: 7, explicit: file });
    assert.equal(r.addresses.ArkQDayOracle.toLowerCase(), '0x' + '33'.repeat(20), 'a Q address reaches the deployment as its hex');
    assert.equal(r.addresses.ArkTimelock.toLowerCase(), '0x' + '44'.repeat(20));
    assert.throws(() => governanceRecordOf({ chain: 'local', qrlChainId: 8, explicit: file }), /is for chain 7/);
    fs.writeFileSync(file, JSON.stringify({ chainId: 7, addresses: { ...addresses, VeArk: undefined } }));
    assert.throws(() => governanceRecordOf({ chain: 'local', qrlChainId: 7, explicit: file }), /names no VeArk/);
    assert.throws(() => governanceRecordOf({ chain: 'local', qrlChainId: 7, explicit: path.join(dir, 'none.json') }), /not found/);
    assert.equal(governanceRecordOf({ chain: 'local', qrlChainId: 999999991, env: {} }), null, 'no record: the doubles');
  });

  test('the findings module acts only inside the court\'s delegatecall', async () => {
    const ctx = await court({ jurors: 7 });
    await assert.rejects(() => ctx.findings.send('deliver', [EVIDENCE, KIND.LOSS, '0x' + '00'.repeat(32), 0, false, true, '0x', 0n]), /BadPayload/);
    // A value slice's verdict likewise (EC-04).
    await assert.rejects(() => ctx.findings.send('deliver', [EVIDENCE, KIND.CENSORSHIP, EVIDENCE, 0, true, false, '0x', 0n]), /BadPayload/);
    assert.equal((await ctx.findings.call('BOND')).toLowerCase(), ctx.bond.address.toLowerCase());
    assert.equal(await ctx.findings.call('MIN_STAKE'), JUROR_MIN_STAKE);
  });
});
