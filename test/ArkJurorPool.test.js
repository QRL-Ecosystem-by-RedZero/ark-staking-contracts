/**
 * The juror pool of the product's court (phase C4; whitepaper §6.1, §6.2,
 * yellow paper §4.1, G13).
 *
 * The one rule this file exists to defend: **the stake a draw seats is held
 * until the court settles the case**, and nothing else moves it — unbonding
 * reaches only free stake, the court alone slashes, and a seat is released
 * once. Beside it the draw weight: active stake plus a veARK bonus of at most
 * the same again, read at a checkpointed block, capped at a tenth of the
 * pool's stake per address; and stake that joined after the draw was coming
 * does not reach it.
 *
 * contracts/core holds veARK. The repositories do not import each other, so
 * the interface is held to core's source as text, and where the umbrella
 * checkout has core's build the pool is run against core's own VeArk.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Interface, keccak256, toUtf8Bytes } = require('ethers');
const { createAddressFromString, hexToBytes } = require('@ethereumjs/util');
const { Chain, ACCOUNTS, coder } = require('./harness');
const { ONE, EPOCH, DAY, JUROR_MIN_STAKE } = require('./stake-fixture');

const CORE = process.env.ARK_CORE_DIR || path.join(__dirname, '..', '..', '..', 'ecosystem', 'contracts');
const CORE_BUILD = path.join(CORE, 'build');
const BPS = 10000n;
const COURT = ACCOUNTS.guardian;
const CASE = keccak256(toUtf8Bytes('case-1'));
const CASE2 = keccak256(toUtf8Bytes('case-2'));
const RAND = keccak256(toUtf8Bytes('rand'));

const juror = (i) => '0x' + (0x1000 + i).toString(16).padStart(40, '0');

function toNextEpoch(chain, plus = 1) {
  const next = (BigInt(chain.timestamp) / BigInt(EPOCH) + 1n) * BigInt(EPOCH);
  chain.advanceTime(Number(next - BigInt(chain.timestamp)) + plus);
}

async function stack({ veArk = null, minStake = JUROR_MIN_STAKE } = {}) {
  const chain = await Chain.create();
  const admin = ACCOUNTS.admin;
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
    [admin, '0x' + '91'.repeat(20), '0x' + '92'.repeat(20), '0x' + '93'.repeat(20), '0x' + '94'.repeat(20), '0x' + '95'.repeat(20), chain.timestamp],
  );
  const ve = veArk ? await veArk(chain, ark) : await chain.deploy('MockVeArk');
  const pool = await chain.deploy('ArkJurorPool', ['address', 'address', 'uint256', 'address'], [ark.address, ve.address, minStake, admin]);
  await pool.send('setCourt', [COURT], { from: admin });
  return { chain, ark, ve, pool, minStake };
}

async function fund(ctx, who, amount) {
  await ctx.ark.send('transfer', [who, amount], { from: ACCOUNTS.admin });
  await ctx.ark.send('approve', [ctx.pool.address, amount], { from: who });
}

async function stake(ctx, who, amount) {
  await fund(ctx, who, amount);
  return ctx.pool.send('stake', [amount], { from: who });
}

/** Stake `n` jurors of `each` and cross the boundary that activates them. */
async function jurors(ctx, n, each = ctx.minStake) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(juror(i));
    await stake(ctx, juror(i), each);
  }
  toNextEpoch(ctx.chain);
  return out;
}

/**
 * Arm a draw as the court does (QL-01): a veARK checkpoint in this block,
 * readable from the next, and the pool fixed as it stands until the draw or
 * the last drawable block. Returns the snapshot block.
 */
async function snapshot(ctx, reach = 300n) {
  const blk = ctx.chain.blockNumber;
  await ctx.pool.send('arm', [blk + reach], { from: COURT });
  ctx.chain.advanceTime(0);
  return blk;
}

const draw = (ctx, caseId, round, n, seat, blk, rand = RAND) =>
  ctx.pool.send('drawPanel', [caseId, round, n, seat, blk, rand], { from: COURT });

async function arkHeld(ctx) {
  let sum = 0n;
  const n = await ctx.pool.call('jurorCount');
  for (let i = 0; i < 80; i++) {
    const j = await ctx.pool.call('jurorOf', [juror(i)]);
    sum += j.active + j.pending + j.unbonding + j.reward;
  }
  return { sum: sum + (await ctx.pool.call('unallocatedSlash')), n };
}

describe('stake: in the draw from the next boundary, out of it at once, withdrawn after the unbonding period', () => {
  test('new stake waits one epoch boundary before it can be drawn', async () => {
    const ctx = await stack();
    await stake(ctx, juror(0), 3n * JUROR_MIN_STAKE);
    assert.equal(await ctx.pool.call('activeStakeOf', [juror(0)]), 0n, 'not in the draw in the epoch it was added');
    assert.equal(await ctx.pool.call('poolStake'), 0n);
    toNextEpoch(ctx.chain);
    assert.equal(await ctx.pool.call('activeStakeOf', [juror(0)]), 3n * JUROR_MIN_STAKE);
    assert.equal(await ctx.pool.call('poolStake'), 3n * JUROR_MIN_STAKE);
  });

  test('unbonding leaves every later draw at once and is withdrawn only after twenty-one days', async () => {
    const ctx = await stack();
    await stake(ctx, juror(0), 2n * JUROR_MIN_STAKE);
    toNextEpoch(ctx.chain);
    await ctx.pool.send('unbond', [JUROR_MIN_STAKE], { from: juror(0) });
    assert.equal(await ctx.pool.call('activeStakeOf', [juror(0)]), JUROR_MIN_STAKE, 'out of the draw at the unbonding');
    await assert.rejects(() => ctx.pool.send('withdraw', [], { from: juror(0) }), /NothingWithdrawable/);
    ctx.chain.advanceTime(21 * DAY - 10);
    await assert.rejects(() => ctx.pool.send('withdraw', [], { from: juror(0) }), /NothingWithdrawable/);
    ctx.chain.advanceTime(10);
    const before = await ctx.ark.call('balanceOf', [juror(0)]);
    await ctx.pool.send('withdraw', [], { from: juror(0) });
    assert.equal((await ctx.ark.call('balanceOf', [juror(0)])) - before, JUROR_MIN_STAKE);
  });

  test('pending stake unbonds first; a juror emptied leaves the list', async () => {
    const ctx = await stack();
    await stake(ctx, juror(0), JUROR_MIN_STAKE);
    await ctx.pool.send('unbond', [JUROR_MIN_STAKE], { from: juror(0) });
    assert.equal((await ctx.pool.call('jurorOf', [juror(0)])).pending, 0n);
    ctx.chain.advanceTime(21 * DAY);
    await ctx.pool.send('withdraw', [], { from: juror(0) });
    assert.equal(await ctx.pool.call('jurorCount'), 0n, 'nothing held, nothing listed: a departed juror costs no draw a read');
  });
});

describe('the draw weight: stake plus a veARK bonus of at most the same again, capped per address (whitepaper §6.1, §6.2)', () => {
  test('the bonus is capped at one times the stake; a lock with no stake behind it weighs nothing', async () => {
    const ctx = await stack();
    const js = await jurors(ctx, 12);
    await ctx.ve.send('setWeight', [js[0], 5n * JUROR_MIN_STAKE]); // a boosted lock far above the stake
    await ctx.ve.send('setWeight', [js[1], JUROR_MIN_STAKE / 2n]);
    await ctx.ve.send('setWeight', [juror(99), 100n * JUROR_MIN_STAKE]); // veARK and no stake
    const blk = await snapshot(ctx);
    const cap = ((await ctx.pool.call('poolStake')) * 1000n) / BPS;
    assert.equal(cap, (12n * JUROR_MIN_STAKE) / 10n);
    assert.equal(await ctx.pool.call('drawWeightOf', [js[0], blk]), cap < 2n * JUROR_MIN_STAKE ? cap : 2n * JUROR_MIN_STAKE, 'stake + min(stake, veARK), under the cap');
    assert.equal(await ctx.pool.call('drawWeightOf', [js[1], blk]), cap < (3n * JUROR_MIN_STAKE) / 2n ? cap : (3n * JUROR_MIN_STAKE) / 2n);
    assert.equal(await ctx.pool.call('drawWeightOf', [js[2], blk]), JUROR_MIN_STAKE, 'no lock, the stake alone');
    assert.equal(await ctx.pool.call('drawWeightOf', [juror(99), blk]), 0n, 'a lock with no stake behind it seats nobody');
  });

  test('no address weighs more than a tenth of the pool\'s stake, however much it stakes', async () => {
    const ctx = await stack();
    await jurors(ctx, 9);
    await stake(ctx, ACCOUNTS.mallory, 100n * JUROR_MIN_STAKE);
    toNextEpoch(ctx.chain);
    await ctx.ve.send('setWeight', [ACCOUNTS.mallory, 100n * JUROR_MIN_STAKE]);
    const blk = await snapshot(ctx);
    const pool = await ctx.pool.call('poolStake');
    assert.equal(await ctx.pool.call('drawWeightOf', [ACCOUNTS.mallory, blk]), (pool * 1000n) / BPS, 'capped at 10 per cent of pool stake');
  });

  test('the bonus is read at the snapshot: a lock raised after it does not reach the draw', async () => {
    const ctx = await stack();
    const js = await jurors(ctx, 20);
    const blk = await snapshot(ctx);
    await ctx.ve.send('setWeight', [js[3], JUROR_MIN_STAKE]);
    ctx.chain.advanceTime(0);
    assert.equal(await ctx.pool.call('drawWeightOf', [js[3], blk]), JUROR_MIN_STAKE, 'the weight at the snapshot, not the weight now');
    await assert.rejects(() => ctx.pool.call('drawWeightOf', [js[3], blk + 1n]), /SnapshotNotRecorded/, 'a block no checkpoint recorded is not readable');
  });

  test('stake added in the epoch of a draw is not drawn from', async () => {
    const ctx = await stack();
    await jurors(ctx, 7);
    await stake(ctx, ACCOUNTS.mallory, 10n * JUROR_MIN_STAKE);
    const blk = await snapshot(ctx);
    const res = await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    const [ev] = ctx.pool.events(res, 'PanelDrawn');
    assert.ok(!ev.args.jurors.map((a) => a.toLowerCase()).includes(ACCOUNTS.mallory.toLowerCase()), 'pending stake is out of the draw');
  });
});

describe('the panel: without replacement, never twice on a case, each seat held until the case settles (G13)', () => {
  test('a draw seats n distinct jurors and holds a seat on each; held stake cannot unbond', async () => {
    const ctx = await stack();
    await jurors(ctx, 10, 2n * JUROR_MIN_STAKE);
    const blk = await snapshot(ctx);
    const res = await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    const panel = (await ctx.pool.call('panelOf', [CASE, 1])).map((a) => a.toLowerCase());
    assert.equal(panel.length, 7);
    assert.equal(new Set(panel).size, 7, 'no juror twice');
    assert.equal(ctx.pool.events(res, 'PanelDrawn').length, 1);
    const seated = panel[0];
    assert.equal(await ctx.pool.call('seatRound', [CASE, seated]), 1n);
    assert.equal(await ctx.pool.call('freeStakeOf', [seated]), JUROR_MIN_STAKE, 'a seat holds its stake');
    await assert.rejects(() => ctx.pool.send('unbond', [2n * JUROR_MIN_STAKE], { from: seated }), /NotFree/, 'held stake cannot unbond (G13)');
    await ctx.pool.send('unbond', [JUROR_MIN_STAKE], { from: seated });
    // Past the unbonding period the seat is still held: nothing but the court's settlement releases it.
    ctx.chain.advanceTime(30 * DAY);
    await ctx.pool.send('withdraw', [], { from: seated });
    const j = await ctx.pool.call('jurorOf', [seated]);
    assert.equal(j.held, JUROR_MIN_STAKE, 'held past the unbonding period');
    assert.equal(j.active, JUROR_MIN_STAKE);
  });

  test('a later round excludes every juror already seated on the case; too few eligible is refused', async () => {
    const ctx = await stack();
    await jurors(ctx, 21);
    let blk = await snapshot(ctx);
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    blk = await snapshot(ctx);
    await draw(ctx, CASE, 2, 14, JUROR_MIN_STAKE, blk, keccak256(toUtf8Bytes('r2')));
    const r1 = (await ctx.pool.call('panelOf', [CASE, 1])).map((a) => a.toLowerCase());
    const r2 = (await ctx.pool.call('panelOf', [CASE, 2])).map((a) => a.toLowerCase());
    assert.equal(r1.filter((a) => r2.includes(a)).length, 0, 'the appeal panel is fresh');
    blk = await snapshot(ctx);
    let res = await draw(ctx, CASE, 3, 28, JUROR_MIN_STAKE, blk);
    assert.equal(ctx.pool.events(res, 'PanelDrawn').length, 0, 'a retrial of 28 needs 28 unseated jurors: nobody is seated');
    assert.equal((await ctx.pool.call('panelOf', [CASE, 3])).length, 0);
    await assert.rejects(() => draw(ctx, CASE, 3, 28, JUROR_MIN_STAKE, blk), /NotArmed/, 'the arm is spent by the failed draw');
    // The same jurors can sit on another case, on their free stake: each holds one seat already.
    blk = await snapshot(ctx);
    res = await draw(ctx, CASE2, 1, 7, JUROR_MIN_STAKE, blk);
    assert.equal(ctx.pool.events(res, 'PanelDrawn').length, 0, 'no free stake left for a second seat');
  });

  test('a case keeps one seat stake', async () => {
    const ctx = await stack();
    await jurors(ctx, 14, 3n * JUROR_MIN_STAKE);
    let blk = await snapshot(ctx);
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    blk = await snapshot(ctx);
    await assert.rejects(() => draw(ctx, CASE, 2, 7, 2n * JUROR_MIN_STAKE, blk), /SeatMismatch/);
  });

  test('the court alone draws and settles; the court is named once, by the deployer', async () => {
    const ctx = await stack();
    await jurors(ctx, 7);
    const blk = await snapshot(ctx);
    await assert.rejects(() => ctx.pool.send('drawPanel', [CASE, 1, 7, JUROR_MIN_STAKE, blk, RAND], { from: ACCOUNTS.mallory }), /OnlyCourt/);
    await assert.rejects(() => ctx.pool.send('arm', [blk + 300n], { from: ACCOUNTS.mallory }), /OnlyCourt/);
    await assert.rejects(() => ctx.pool.send('settle', [CASE, [], [], 3000], { from: ACCOUNTS.mallory }), /OnlyCourt/);
    await assert.rejects(() => ctx.pool.send('setCourt', [ACCOUNTS.mallory], { from: ACCOUNTS.admin }), /AlreadySet/);
    const other = await Chain.create();
    const p2 = await other.deploy('ArkJurorPool', ['address', 'address', 'uint256', 'address'], [ACCOUNTS.alice, ACCOUNTS.bob, 1n, ACCOUNTS.admin]);
    await assert.rejects(() => p2.send('setCourt', [COURT], { from: ACCOUNTS.mallory }), /OnlyDeployer/);
  });
});

describe('settlement: coherent seats released whole, the rest slashed, the slash to the coherent', () => {
  test('incoherent and unrevealed seats lose the slash of the seat; a first panel alone pays it to none of its seats (OC-COURT-09); every seat is released once', async () => {
    const ctx = await stack();
    await jurors(ctx, 7, 2n * JUROR_MIN_STAKE);
    const blk = await snapshot(ctx);
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    const panel = await ctx.pool.call('panelOf', [CASE, 1]);
    const coherent = [true, true, true, true, false, false, false];
    const before = await ctx.ark.call('balanceOf', [ctx.pool.address]);
    const res = await ctx.pool.send('settle', [CASE, panel, coherent, 3000], { from: COURT });
    const cut = (JUROR_MIN_STAKE * 3000n) / BPS;
    for (let i = 0; i < 7; i++) {
      const j = await ctx.pool.call('jurorOf', [panel[i]]);
      assert.equal(j.held, 0n, 'released');
      assert.equal(j.active, coherent[i] ? 2n * JUROR_MIN_STAKE : 2n * JUROR_MIN_STAKE - cut, 'slashed 3,000 bps of the seat, not of the stake');
      // Seven seats: the first panel decided alone, so its 4–3 majority is not paid the dissenters' stake (OC-COURT-09).
      assert.equal(j.reward, 0n);
    }
    assert.equal(await ctx.pool.call('unallocatedSlash'), 3n * cut, 'held for the next appealed case');
    assert.equal(ctx.pool.events(res, 'SeatSettled').length, 7);
    assert.equal(await ctx.ark.call('balanceOf', [ctx.pool.address]), before, 'a slash moves ARK inside the pool, never out of it');
    const { sum } = await arkHeld(ctx);
    assert.equal(sum, before, 'every ARK the pool holds is a juror\'s or unallocated');
    await assert.rejects(() => ctx.pool.send('settle', [CASE, panel, coherent, 3000], { from: COURT }), /SeatMismatch/, 'a case settles once');
    await assert.rejects(() => ctx.pool.send('claimReward', [], { from: panel[0] }), /ZeroAmount/);
  });

  test('no coherent seat: the slash is unallocated; a list short of the seats is refused', async () => {
    const ctx = await stack();
    await jurors(ctx, 7);
    const blk = await snapshot(ctx);
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    const panel = await ctx.pool.call('panelOf', [CASE, 1]);
    await assert.rejects(() => ctx.pool.send('settle', [CASE, panel.slice(1), Array(6).fill(false), 3000], { from: COURT }), /SeatMismatch/);
    await ctx.pool.send('settle', [CASE, panel, Array(7).fill(false), 3000], { from: COURT });
    assert.equal(await ctx.pool.call('unallocatedSlash'), 7n * ((JUROR_MIN_STAKE * 3000n) / BPS));
  });
});

describe('a draw reads the pool as it stood when it was armed (audit 2026-09-29, QL-01; PoC C-1)', () => {
  /** Thirty jurors of twice the minimum, active, and a draw armed on them. */
  async function armed() {
    const ctx = await stack();
    await jurors(ctx, 30, 2n * JUROR_MIN_STAKE);
    // A reach past the next epoch boundary: the harness moves a block per twelve seconds.
    const blk = await snapshot(ctx, 10n ** 7n);
    return { ctx, blk };
  }
  const panelOf = async (ctx, caseId, round = 1) => (await ctx.pool.call('panelOf', [caseId, round])).map((a) => a.toLowerCase());

  test('unbonding one wei after the arm no longer reshuffles the panel: the same randomness draws the same seven', async () => {
    const a = await armed();
    await draw(a.ctx, CASE, 1, 7, JUROR_MIN_STAKE, a.blk);
    const b = await armed();
    // The audit's grinding move, and more: a juror unbonds one wei, another all it has, a third stakes more.
    await b.ctx.pool.send('unbond', [1n], { from: juror(29) });
    await b.ctx.pool.send('unbond', [2n * JUROR_MIN_STAKE], { from: juror(5) });
    await stake(b.ctx, juror(7), 5n * JUROR_MIN_STAKE);
    toNextEpoch(b.ctx.chain); // the new stake matures after the arm: still not in this draw
    await draw(b.ctx, CASE, 1, 7, JUROR_MIN_STAKE, b.blk);
    assert.deepEqual(await panelOf(b.ctx, CASE), await panelOf(a.ctx, CASE), 'the weights, the eligibility and the cap are the arm\'s');
  });

  test('stake unbonded after the arm still counts for that draw, is seated from the unbonding lot, and cannot leave while the draw is armed', async () => {
    const ctx = await stack();
    await jurors(ctx, 7, JUROR_MIN_STAKE);
    const blk = await snapshot(ctx);
    // Everyone leaves after the arm: seven eligible at the arm, seven seated.
    for (let i = 0; i < 7; i++) await ctx.pool.send('unbond', [JUROR_MIN_STAKE], { from: juror(i) });
    assert.equal(await ctx.pool.call('poolStake'), 0n, 'out of every later draw');
    await assert.rejects(() => ctx.pool.send('withdraw', [], { from: juror(0) }), /DrawPending/, 'nothing of a moved juror\'s lot leaves while the draw is armed');
    await assert.rejects(() => ctx.pool.send('arm', [ctx.chain.blockNumber + 300n], { from: COURT }), /DrawPending/, 'one draw armed at a time');
    assert.ok((await ctx.pool.call('armedUntil')) > 0n);
    const res = await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    assert.equal(ctx.pool.events(res, 'PanelDrawn').length, 1);
    for (let i = 0; i < 7; i++) {
      const j = await ctx.pool.call('jurorOf', [juror(i)]);
      assert.equal(j.held, JUROR_MIN_STAKE, 'seated: slashable until the case closes');
      assert.equal(j.active, JUROR_MIN_STAKE, 'taken back from the unbonding lot');
      assert.equal(j.unbonding, 0n);
    }
    assert.equal(await ctx.pool.call('armedUntil'), 0n, 'the arm is spent');
    await assert.rejects(() => draw(ctx, CASE2, 1, 7, JUROR_MIN_STAKE, blk), /NotArmed/);
  });

  test('a draw is armed until its last drawable block; after it, nothing is drawn on that arm and the next may be armed', async () => {
    const ctx = await stack();
    await jurors(ctx, 7);
    const blk = await snapshot(ctx, 3n);
    ctx.chain.advanceTime(60);
    await assert.rejects(() => draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk), /NotArmed/, 'past its window');
    assert.equal(await ctx.pool.call('armedUntil'), 0n);
    const blk2 = await snapshot(ctx);
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk2);
  });

  test('the list is not reordered while a draw is armed: an emptied juror stays listed until it is drawn', async () => {
    const ctx = await stack();
    await jurors(ctx, 8);
    await ctx.pool.send('unbond', [JUROR_MIN_STAKE], { from: juror(0) });
    ctx.chain.advanceTime(21 * DAY);
    const blk = await snapshot(ctx);
    await ctx.pool.send('withdraw', [], { from: juror(0) });
    assert.equal(await ctx.pool.call('jurorCount'), 8n, 'kept at its place while the draw is armed');
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    assert.ok(!(await panelOf(ctx, CASE)).includes(juror(0).toLowerCase()), 'unbonded before the arm: not drawn');
  });
});

describe('a juror is listed only at the minimum stake (audit 2026-09-29, QL-21; PoC C-6)', () => {
  test('a stake below the minimum is refused a slot; the minimum lists it', async () => {
    const ctx = await stack();
    await fund(ctx, juror(0), JUROR_MIN_STAKE);
    await assert.rejects(() => ctx.pool.send('stake', [1n], { from: juror(0) }), /BelowMinimumStake/, 'the one-wei staker of the PoC');
    await assert.rejects(() => ctx.pool.send('stake', [JUROR_MIN_STAKE - 1n], { from: juror(0) }), /BelowMinimumStake/);
    await ctx.pool.send('stake', [JUROR_MIN_STAKE], { from: juror(0) });
    assert.equal(await ctx.pool.call('jurorCount'), 1n);
  });

  test('a full list gives the slot of a juror below the minimum to a new juror; a list of full stakes is full', async () => {
    const ctx = await stack();
    const max = Number(await ctx.pool.call('MAX_JURORS'));
    for (let i = 0; i < max; i++) await stake(ctx, juror(i), JUROR_MIN_STAKE);
    toNextEpoch(ctx.chain);
    await fund(ctx, ACCOUNTS.mallory, 2n * JUROR_MIN_STAKE);
    await assert.rejects(() => ctx.pool.send('stake', [JUROR_MIN_STAKE], { from: ACCOUNTS.mallory }), /PoolFull/, 'every listed juror holds the minimum');
    // One juror leaves all but one wei: its slot is no longer held by a stake of the minimum.
    await ctx.pool.send('unbond', [JUROR_MIN_STAKE - 1n], { from: juror(9) });
    // Not while a draw is armed.
    const blk = await snapshot(ctx);
    await assert.rejects(() => ctx.pool.send('stake', [JUROR_MIN_STAKE], { from: ACCOUNTS.mallory }), /PoolFull/, 'no eviction while a draw is armed');
    await draw(ctx, CASE, 1, 7, JUROR_MIN_STAKE, blk);
    const res = await ctx.pool.send('stake', [JUROR_MIN_STAKE], { from: ACCOUNTS.mallory });
    const [ev] = ctx.pool.events(res, 'JurorEvicted');
    assert.equal(ev.args.juror.toLowerCase(), juror(9).toLowerCase());
    assert.equal(await ctx.pool.call('jurorCount'), BigInt(max));
    assert.equal((await ctx.pool.call('jurorOf', [juror(9)])).index, 0n, 'out of the list');
    assert.equal((await ctx.pool.call('jurorOf', [ACCOUNTS.mallory])).index, 10n, 'in its slot');
    // The evicted juror keeps its stake and its unbonding lot.
    ctx.chain.advanceTime(21 * DAY);
    await ctx.pool.send('withdraw', [], { from: juror(9) });
    await ctx.pool.send('unbond', [1n], { from: juror(9) });
  });
});

describe('contracts/core\'s veARK', () => {
  const coreIVeArk = path.join(CORE, 'contracts', 'interfaces', 'IVeArk.hyp');

  test('the two calls the pool makes are core\'s IVeArk, word for word', (t) => {
    if (!fs.existsSync(coreIVeArk)) return t.skip(`contracts/core not found at ${CORE}`);
    const norm = (s) => s.replace(/\s+/g, ' ');
    const theirs = norm(fs.readFileSync(coreIVeArk, 'utf8'));
    const ours = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'interfaces', 'IArkVeArkSnapshot.hyp'), 'utf8');
    const sigs = ours.match(/function [^;]+;/g);
    assert.equal(sigs.length, 2);
    for (const sig of sigs) assert.ok(theirs.includes(norm(sig)), `${sig} is in core's IVeArk`);
  });

  test('against core\'s own VeArk: a four-year lock is capped at the stake, read at the pool\'s checkpoint', async (t) => {
    const file = path.join(CORE_BUILD, 'VeArk.json');
    if (!fs.existsSync(file)) return t.skip(`contracts/core has no build at ${CORE_BUILD}`);
    const art = JSON.parse(fs.readFileSync(file, 'utf8'));
    const iface = new Interface(art.abi);
    let core;
    const ctx = await stack({
      veArk: async (chain, ark) => {
        const res = await chain.vm.evm.runCall({
          caller: createAddressFromString(ACCOUNTS.admin),
          to: undefined,
          data: hexToBytes(art.bytecode + coder.encode(['address', 'address[]'], [ark.address, []]).slice(2)),
          gasLimit: chain.gasPool,
          value: 0n,
          block: chain.blockContext(),
        });
        assert.ok(!res.execResult.exceptionError, 'core VeArk deploys');
        core = { address: res.createdAddress.toString() };
        core.send = (m, args, from) => chain.execute(core.address, from, iface.encodeFunctionData(m, args));
        core.call = async (m, args) => iface.decodeFunctionResult(m, (await chain.execute(core.address, ACCOUNTS.admin, iface.encodeFunctionData(m, args), 0n, true)).returnValue)[0];
        return core;
      },
    });
    const [a, b] = [juror(0), juror(1)];
    // Twenty jurors, so the per-address cap (a tenth of the pool) sits at twice the stake.
    for (let i = 0; i < 20; i++) await stake(ctx, juror(i), JUROR_MIN_STAKE);
    toNextEpoch(ctx.chain);
    // a: a four-year lock of the stake's size, weight ~4x; b: a short one of a tenth.
    for (const [who, amount, years] of [[a, JUROR_MIN_STAKE, 4], [b, JUROR_MIN_STAKE / 10n, 1]]) {
      await ctx.ark.send('transfer', [who, amount], { from: ACCOUNTS.admin });
      await ctx.ark.send('approve', [core.address, amount], { from: who });
      await core.send('createLock', [amount, BigInt(ctx.chain.timestamp) + BigInt(years * 364 * DAY)], who);
    }
    const blk = await snapshot(ctx);
    const wa = await core.call('weightAt', [a, blk]);
    const wb = await core.call('weightAt', [b, blk]);
    assert.ok(wa > 3n * JUROR_MIN_STAKE, 'core boosts a four-year lock toward 4x');
    const cap = ((await ctx.pool.call('poolStake')) * 1000n) / BPS;
    const expect = (w) => {
      const x = JUROR_MIN_STAKE + (w < JUROR_MIN_STAKE ? w : JUROR_MIN_STAKE);
      return x > cap ? cap : x;
    };
    assert.equal(await ctx.pool.call('drawWeightOf', [a, blk]), expect(wa), 'the bonus stops at the stake: the boost does not carry past it');
    assert.equal(await ctx.pool.call('drawWeightOf', [b, blk]), expect(wb));
  });
});
