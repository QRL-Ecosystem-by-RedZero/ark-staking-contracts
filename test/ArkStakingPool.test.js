/**
 * ArkStakingPool: pooled native QRL staking, the venue bond principal earns in.
 *
 * The rules: a share is worth its part of the pool's book — principal at the
 * delegation plus the balance here, less settled withdrawals — and nothing
 * else; rewards raise every share alike and a loss lowers every share alike,
 * shares locked for withdrawal included; the queue settles in order, whole, at
 * the value when reached, and pays only the account that asked; nothing but
 * the delegation pays in. The validators behind the pool are a double here
 * (`MockDelegation`), as `test/ArkBondDelegation.test.js` establishes the real one.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Chain, ACCOUNTS } = require('./harness');

const ONE = 10n ** 18n;
const A = ACCOUNTS.alice;
const B = ACCOUNTS.bob;

async function poolStack() {
  const chain = await Chain.create();
  for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 27n);
  const pool = await chain.deploy('ArkStakingPool');
  const delegation = await chain.deploy('MockDelegation', ['address'], [pool.address]);
  await pool.send('setDelegation', [delegation.address], { from: ACCOUNTS.admin });
  const value = (who) => pool.call('positionValue', [who]);
  return { chain, pool, delegation, value };
}

const near = (x, y, tol = 10n ** 6n) => (x > y ? x - y : y - x) <= tol;

const EPOCH = 7 * 24 * 60 * 60;
/** One second into the next epoch. */
function toNextEpoch(ctx) {
  const now = BigInt(ctx.chain.timestamp);
  const next = (now / BigInt(EPOCH) + 1n) * BigInt(EPOCH);
  ctx.chain.advanceTime(Number(next - now) + 1);
}

describe('ArkStakingPool', () => {
  test('the delegation is named once, by the deployer', async () => {
    const { pool } = await poolStack();
    await assert.rejects(() => pool.send('setDelegation', [A], { from: ACCOUNTS.admin }), /AlreadySet/);
    const chain = await Chain.create();
    const fresh = await chain.deploy('ArkStakingPool');
    await assert.rejects(() => fresh.send('setDelegation', [A], { from: ACCOUNTS.mallory }), /OnlyDeployer/);
  });

  test('a deposit is staked at the delegation and worth what was sent', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 30_000n * ONE });
    await ctx.pool.send('deposit', [], { from: B, value: 10_000n * ONE });
    assert.equal(await ctx.delegation.call('principal'), 40_000n * ONE, 'enough for one validator, from two depositors');
    assert.ok(near(await ctx.value(A), 30_000n * ONE));
    assert.ok(near(await ctx.value(B), 10_000n * ONE));
  });

  test('a reward raises every share alike', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 30_000n * ONE });
    await ctx.pool.send('deposit', [], { from: B, value: 10_000n * ONE });
    // Both join the book at the next epoch (whitepaper §3.4, D16).
    toNextEpoch(ctx);
    await ctx.delegation.send('pushDistribution', [], { value: 400n * ONE });
    assert.ok(near(await ctx.value(A), 30_300n * ONE));
    assert.ok(near(await ctx.value(B), 10_100n * ONE));
    // A later depositor buys at the new price and gets none of the earlier reward.
    await ctx.pool.send('deposit', [], { from: ACCOUNTS.guardian, value: 1_010n * ONE });
    assert.ok(near(await ctx.value(ACCOUNTS.guardian), 1_010n * ONE));
  });

  test('a loss lowers every share alike, and a withdrawal waiting in the queue bears it too', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 30_000n * ONE });
    await ctx.pool.send('deposit', [], { from: B, value: 10_000n * ONE });
    toNextEpoch(ctx);
    await ctx.delegation.send('deployIdle', [40_000n * ONE]);
    const shares = await ctx.pool.call('sharesOf', [B]);
    await ctx.pool.send('requestWithdrawal', [shares], { from: B });
    assert.equal(await ctx.pool.call('queueHead'), 0n, 'nothing idle: the request waits');
    await ctx.delegation.send('loseStake', [4_000n * ONE]);
    assert.ok(near(await ctx.value(A), 27_000n * ONE));
    // The validator exits and its principal is idle again: the queue settles at the value now.
    await ctx.delegation.send('undeploy', [36_000n * ONE]);
    await ctx.pool.send('settle', [8n], { from: ACCOUNTS.mallory });
    assert.ok(near(await ctx.pool.call('withdrawalAmount', [0n]), 9_000n * ONE), 'the locked shares bore their part of the loss');
    assert.ok(near(await ctx.value(A), 27_000n * ONE));
  });

  test('the queue settles in order, whole, and pays only the account that asked', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 30_000n * ONE });
    await ctx.pool.send('deposit', [], { from: B, value: 10_000n * ONE });
    toNextEpoch(ctx);
    const res = await ctx.pool.send('requestWithdrawal', [(await ctx.pool.call('sharesOf', [B])) / 2n], { from: B });
    const [ev] = ctx.pool.events(res, 'WithdrawalRequested');
    const id = ev.args.requestId;
    // Idle principal covers it: settled at once, from the delegation.
    const amount = await ctx.pool.call('withdrawalAmount', [id]);
    assert.ok(near(amount, 5_000n * ONE));
    await assert.rejects(() => ctx.pool.send('claimWithdrawal', [id], { from: ACCOUNTS.mallory }), /NotRequester/);
    const before = await ctx.chain.balanceOf(B);
    await ctx.pool.send('claimWithdrawal', [id], { from: B });
    assert.ok((await ctx.chain.balanceOf(B)) - before === amount);
    await assert.rejects(() => ctx.pool.send('claimWithdrawal', [id], { from: B }), /NotSettled/);
    assert.ok(near(await ctx.value(A), 30_000n * ONE), 'the one who stayed is untouched');
  });

  test('a request the pool cannot cover waits; an exit is asked for only under a real shortfall', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 40_000n * ONE });
    await assert.rejects(() => ctx.pool.send('requestExit', []), /NoShortfall/);
    toNextEpoch(ctx);
    await ctx.delegation.send('deployIdle', [40_000n * ONE]);
    // A quarter of the pool (10,000) waits, but is short of half a stake: no exit for it (OC-LEGB-04).
    const res = await ctx.pool.send('requestWithdrawal', [(await ctx.pool.call('sharesOf', [A])) / 4n], { from: A });
    const id = ctx.pool.events(res, 'WithdrawalRequested')[0].args.requestId;
    assert.equal(await ctx.pool.call('withdrawalAmount', [id]), 0n, 'waiting');
    await assert.rejects(() => ctx.pool.send('requestExit', []), /NoShortfall/, 'a shortfall below half a stake asks no exit');
    await ctx.pool.send('requestWithdrawal', [(await ctx.pool.call('sharesOf', [A])) / 3n], { from: A });
    await ctx.pool.send('requestExit', []);
    await assert.rejects(() => ctx.pool.send('requestExit', []), /NoShortfall/, 'the exit asked for counts');
  });

  // Audit 2026-09-27 D16, whitepaper §3.4: a distribution accrues only to the
  // holdings recorded at the opening of the epoch it is received in. The PoC:
  // deposit, call the permissionless distribution, withdraw at once. Against the
  // pre-fix pool the sniper left with a quarter of a reward it did not earn.
  test('D16 PoC: a deposit placed just ahead of a distribution takes no part of it, and cannot leave with it', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 30_000n * ONE });
    toNextEpoch(ctx);
    await ctx.pool.send('roll', [], { from: A });
    // The epoch of the distribution: the sniper deposits, then the reward lands.
    await ctx.pool.send('deposit', [], { from: ACCOUNTS.mallory, value: 10_000n * ONE });
    await ctx.delegation.send('pushDistribution', [], { value: 400n * ONE });
    assert.equal(await ctx.pool.call('sharesOf', [ACCOUNTS.mallory]), 0n, 'no shares in the epoch of the deposit');
    await assert.rejects(
      () => ctx.pool.send('requestWithdrawal', [1n], { from: ACCOUNTS.mallory }),
      /InsufficientShares/,
      'nothing to withdraw the reward with',
    );
    assert.ok(near(await ctx.value(A), 30_400n * ONE), 'the whole reward is the holder of record\'s');
    assert.equal(await ctx.value(ACCOUNTS.mallory), 10_000n * ONE, 'the sniper holds what it sent');
    // The next epoch it joins at the price the reward set, and shares what comes after.
    toNextEpoch(ctx);
    await ctx.pool.send('roll', [], { from: ACCOUNTS.mallory });
    assert.ok(near(await ctx.value(ACCOUNTS.mallory), 10_000n * ONE));
    await ctx.delegation.send('pushDistribution', [], { value: 404n * ONE });
    assert.ok(near(await ctx.value(ACCOUNTS.mallory), 10_100n * ONE, 10n ** 9n));
    assert.ok(near(await ctx.value(A), 30_704n * ONE, 10n ** 9n));
  });

  test('D16: the batch converts before a distribution of the next epoch counts, whoever touches first', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 30_000n * ONE });
    toNextEpoch(ctx);
    await ctx.pool.send('roll', []);
    await ctx.pool.send('deposit', [], { from: B, value: 10_000n * ONE });
    toNextEpoch(ctx);
    // No one touched the pool this epoch: the reward's own arrival converts B first.
    await ctx.delegation.send('pushDistribution', [], { value: 400n * ONE });
    assert.ok(near(await ctx.value(A), 30_300n * ONE, 10n ** 9n));
    assert.ok(near(await ctx.value(B), 10_100n * ONE, 10n ** 9n));
  });

  test('value reaches the pool from the delegation and from nobody else', async () => {
    const ctx = await poolStack();
    await assert.rejects(() => ctx.chain.execute(ctx.pool.address, A, '0x', ONE), /OnlyDelegation/);
  });

  test('a first depositor cannot inflate the price of a share against the next', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: ACCOUNTS.mallory, value: 1n });
    // A reward the size of a donation arrives before the victim deposits.
    await ctx.delegation.send('pushDistribution', [], { value: 1_000n * ONE });
    await ctx.pool.send('deposit', [], { from: A, value: 1_000n * ONE });
    const lost = 1_000n * ONE - (await ctx.value(A));
    assert.ok(lost < ONE / 1000n, `the victim lost ${lost}`);
  });
});
