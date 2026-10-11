/**
 * veARK: the boost curve, the one-way lock rules, and non-transferability.
 *
 * The rules under test are the ones the design leans on elsewhere: a lock can
 * only ever be extended, weight is capped at 4x, and there is no exit before
 * maturity for any price.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { Chain, ACCOUNTS } = require('./harness');

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const MAX_LOCK = 4 * YEAR;
const ONE = 10n ** 18n;

async function fixture() {
  const chain = await Chain.create();
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
    [
      ACCOUNTS.alice,
      ACCOUNTS.bob,
      ACCOUNTS.attester,
      ACCOUNTS.oracle,
      ACCOUNTS.guardian,
      ACCOUNTS.mallory,
      chain.timestamp,
    ],
  );
  const ve = await chain.deploy('VeArk', ['address'], [ark.address]);

  // alice holds the incentives bucket and is the only unlocked whale we need.
  await ark.send('approve', [ve.address, 10n ** 30n], { from: ACCOUNTS.alice });
  await ark.send('transfer', [ACCOUNTS.bob, 1_000_000n * ONE], { from: ACCOUNTS.alice });
  await ark.send('approve', [ve.address, 10n ** 30n], { from: ACCOUNTS.bob });
  return { chain, ark, ve };
}

describe('VeArk', () => {
  describe('boost curve', () => {
    let chain;
    let ve;

    before(async () => {
      ({ chain, ve } = await fixture());
    });

    test('the documented bounds are what the contract actually holds', async () => {
      assert.equal(await ve.call('MIN_LOCK'), BigInt(7 * DAY));
      assert.equal(await ve.call('MAX_LOCK'), BigInt(MAX_LOCK));
      assert.equal(await ve.call('MAX_BOOST_BPS'), 40000n);
      assert.equal(await ve.call('MIN_BOOST_BPS'), 10000n, 'weight floors at 1x, not zero');
    });

    test('a maximum-duration lock earns exactly 4x', async () => {
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(MAX_LOCK)], {
        from: ACCOUNTS.alice,
      });
      assert.equal(await ve.call('boostBpsOf', [ACCOUNTS.alice]), 40000n);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), 4000n * ONE);
    });

    test('a minimum-duration lock is barely above 1x', async () => {
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(7 * DAY)], {
        from: ACCOUNTS.bob,
      });
      const boost = await ve.call('boostBpsOf', [ACCOUNTS.bob]);
      assert.ok(boost > 10000n && boost < 10200n, `expected just over 1x, got ${boost}`);
    });

    test('weight decays as the lock ages', async () => {
      const before = await ve.call('weightOf', [ACCOUNTS.alice]);
      chain.advanceTime(YEAR);
      const after = await ve.call('weightOf', [ACCOUNTS.alice]);
      assert.ok(after < before, 'a shorter remaining lock must weigh less');
      // Three of four years left: 10000 + 30000*3/4 = 32500 bps.
      assert.equal(await ve.call('boostBpsOf', [ACCOUNTS.alice]), 32500n);
    });

    test('weight floors at 1x rather than zero once expired', async () => {
      chain.advanceTime(4 * YEAR);
      assert.equal(await ve.call('boostBpsOf', [ACCOUNTS.alice]), 10000n);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), 1000n * ONE);
    });
  });

  describe('lock lifecycle', () => {
    let chain;
    let ark;
    let ve;

    before(async () => {
      ({ chain, ark, ve } = await fixture());
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(YEAR)], {
        from: ACCOUNTS.alice,
      });
    });

    test('a second lock for the same account is rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('a duration outside the permitted band is rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(DAY)], { from: ACCOUNTS.bob }),
        (e) => e.reverted,
        'below MIN_LOCK',
      );
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(MAX_LOCK + YEAR)], {
          from: ACCOUNTS.bob,
        }),
        (e) => e.reverted,
        'above MAX_LOCK',
      );
    });

    test('increasing the amount raises weight without moving the unlock time', async () => {
      const lockBefore = await ve.call('lockOf', [ACCOUNTS.alice]);
      await ve.send('increaseAmount', [1000n * ONE], { from: ACCOUNTS.alice });
      const lockAfter = await ve.call('lockOf', [ACCOUNTS.alice]);
      assert.equal(lockAfter.amount, 2000n * ONE);
      assert.equal(lockAfter.end, lockBefore.end);
    });

    test('a lock can be extended', async () => {
      const before = await ve.call('boostBpsOf', [ACCOUNTS.alice]);
      await ve.send('extendLock', [chain.timestamp + BigInt(3 * YEAR)], { from: ACCOUNTS.alice });
      assert.ok((await ve.call('boostBpsOf', [ACCOUNTS.alice])) > before);
    });

    test('a lock can never be shortened', async () => {
      const lock = await ve.call('lockOf', [ACCOUNTS.alice]);
      await assert.rejects(
        ve.send('extendLock', [lock.end - BigInt(DAY)], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
        'shortening would let a 4x vote unwind the moment it lands',
      );
    });

    test('withdrawal before maturity is impossible at any price', async () => {
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.alice }), (e) => e.reverted);
    });

    test('a matured lock returns the full principal', async () => {
      const balanceBefore = await ark.call('balanceOf', [ACCOUNTS.alice]);
      chain.advanceTime(3 * YEAR + DAY);
      await ve.send('withdraw', [], { from: ACCOUNTS.alice });
      assert.equal(
        await ark.call('balanceOf', [ACCOUNTS.alice]),
        balanceBefore + 2000n * ONE,
      );
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), 0n);
    });

    test('withdrawing twice is rejected', async () => {
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.alice }), (e) => e.reverted);
    });
  });

  describe('guards', () => {
    let chain;
    let ve;

    before(async () => {
      ({ chain, ve } = await fixture());
    });

    test('a zero-amount lock is rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [0n, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('an unlock time in the past is rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp - 1n], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('extending beyond the four-year ceiling is rejected', async () => {
      await ve.send('createLock', [ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.alice });
      await assert.rejects(
        ve.send('extendLock', [chain.timestamp + BigInt(MAX_LOCK + YEAR)], {
          from: ACCOUNTS.alice,
        }),
        (e) => e.reverted,
      );
    });

    test('topping up an expired lock is rejected', async () => {
      chain.advanceTime(YEAR + DAY);
      await assert.rejects(
        ve.send('increaseAmount', [ONE], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
        'an expired position must be withdrawn, not quietly re-armed',
      );
    });

    test('acting without a lock is rejected on every path', async () => {
      for (const call of [
        ['increaseAmount', [ONE]],
        ['extendLock', [chain.timestamp + BigInt(YEAR)]],
        ['withdraw', []],
      ]) {
        await assert.rejects(ve.send(call[0], call[1], { from: ACCOUNTS.mallory }), (e) => e.reverted);
      }
    });

    test('jury weight matches governance weight', async () => {
      assert.equal(
        await ve.call('juryWeightOf', [ACCOUNTS.alice]),
        await ve.call('weightOf', [ACCOUNTS.alice]),
      );
    });
  });

  describe('the veARK dividend', () => {
    let chain;
    let ve;

    before(async () => {
      ({ chain, ve } = await fixture());
      // Equal principal, unequal horizon: alice locks four years, bob one.
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(MAX_LOCK)], {
        from: ACCOUNTS.alice,
      });
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(YEAR)], {
        from: ACCOUNTS.bob,
      });
    });

    test('a dividend with no lock outstanding is rejected, not swallowed', async () => {
      const empty = await fixture();
      await assert.rejects(
        empty.ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: ONE }),
        (e) => e.reverted,
        'stranded value with no owner is worse than a revert',
      );
    });

    test('a zero-value dividend is rejected', async () => {
      await assert.rejects(
        ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 0n }),
        (e) => e.reverted,
      );
    });

    test('the split follows lock weight, not principal', async () => {
      // alice 4x = 4000, bob ~1.75x = 1750; total 5750 units.
      const total = await ve.call('totalWeight');
      const aliceUnits = await ve.call('unitsOf', [ACCOUNTS.alice]);
      const bobUnits = await ve.call('unitsOf', [ACCOUNTS.bob]);
      assert.equal(aliceUnits + bobUnits, total);

      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 575n * ONE });

      const aliceDue = await ve.call('pendingDividend', [ACCOUNTS.alice]);
      const bobDue = await ve.call('pendingDividend', [ACCOUNTS.bob]);

      assert.ok(aliceDue > bobDue, 'the longer horizon earns more on equal principal');
      // Shares follow units exactly, and nothing is created out of thin air.
      assert.equal(aliceDue / bobDue, aliceUnits / bobUnits);
      assert.ok(aliceDue + bobDue <= 575n * ONE, 'never distributes more than was paid in');
      assert.ok(575n * ONE - (aliceDue + bobDue) < ONE, 'and loses no more than rounding dust');
    });

    test('claiming pays QRL and cannot be repeated', async () => {
      const before = await chain.balanceOf(ACCOUNTS.alice);
      const due = await ve.call('pendingDividend', [ACCOUNTS.alice]);

      await ve.send('claimDividend', [], { from: ACCOUNTS.alice });
      assert.equal((await chain.balanceOf(ACCOUNTS.alice)) - before, due);
      assert.equal(await ve.call('pendingDividend', [ACCOUNTS.alice]), 0n);

      await assert.rejects(ve.send('claimDividend', [], { from: ACCOUNTS.alice }), (e) => e.reverted);
    });

    test('an account with no lock can claim nothing', async () => {
      await assert.rejects(
        ve.send('claimDividend', [], { from: ACCOUNTS.mallory }),
        (e) => e.reverted,
      );
    });

    test('a stale lock keeps what it earned but is corrected going forward', async () => {
      chain.advanceTime(2 * YEAR);

      const staleUnits = await ve.call('unitsOf', [ACCOUNTS.alice]);
      const liveWeight = await ve.call('weightOf', [ACCOUNTS.alice]);
      assert.ok(staleUnits > liveWeight, 'units have not decayed with the clock');

      // Anyone may correct it; bob has every reason to.
      const owedBefore = await ve.call('pendingDividend', [ACCOUNTS.bob]);
      await ve.send('syncWeight', [ACCOUNTS.alice], { from: ACCOUNTS.bob });

      assert.equal(await ve.call('unitsOf', [ACCOUNTS.alice]), liveWeight);
      assert.equal(
        await ve.call('pendingDividend', [ACCOUNTS.bob]),
        owedBefore,
        'correcting someone else must not touch what is already owed',
      );
    });

    test('units still sum to the aggregate after a sync', async () => {
      const total = await ve.call('totalWeight');
      const aliceUnits = await ve.call('unitsOf', [ACCOUNTS.alice]);
      const bobUnits = await ve.call('unitsOf', [ACCOUNTS.bob]);
      assert.equal(
        aliceUnits + bobUnits,
        total,
        'the quorum denominator and the parts can never disagree',
      );

      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 100n * ONE });
      assert.ok((await ve.call('pendingDividend', [ACCOUNTS.bob])) > 0n);
    });

    test('the division remainder is carried, not abandoned', async () => {
      // A boost of 39,999 bps rather than a round 40,000 guarantees a remainder.
      const dust = await ve.call('carriedDust');
      assert.ok(dust < ONE, `dust should be sub-token, got ${dust}`);

      const before = await ve.call('carriedDust');
      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 7n * ONE });
      const after = await ve.call('carriedDust');
      assert.notEqual(
        after,
        before + 7n * ONE,
        'the carry must be spent into the index, not merely accumulated',
      );
    });

    test('the contract holds only what it still owes', async () => {
      const held = await chain.balanceOf(ve.address);
      const owed =
        (await ve.call('pendingDividend', [ACCOUNTS.alice])) +
        (await ve.call('pendingDividend', [ACCOUNTS.bob]));
      assert.ok(held >= owed, `holds ${held}, owes ${owed}`);
      assert.ok(held - owed < ONE, 'nothing beyond rounding dust is stranded');
    });
  });

  describe('non-transferability and aggregate weight', () => {
    let chain;
    let ve;

    before(async () => {
      ({ chain, ve } = await fixture());
    });

    test('no transfer entry point exists at all', () => {
      const movers = ve.iface.fragments.filter(
        (f) => f.type === 'function' && /^(transfer|transferFrom|approve)$/.test(f.name),
      );
      assert.deepEqual(movers, [], 'a transferable lock is a tradable vote');
    });

    test('aggregate weight tracks locks as they are created', async () => {
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(MAX_LOCK)], {
        from: ACCOUNTS.alice,
      });
      assert.equal(await ve.call('totalWeight'), 4000n * ONE);

      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(MAX_LOCK)], {
        from: ACCOUNTS.bob,
      });
      assert.equal(await ve.call('totalWeight'), 8000n * ONE);
    });

    test('the aggregate drifts upward between mutations, never downward', async () => {
      const recorded = await ve.call('totalWeight');
      chain.advanceTime(2 * YEAR);
      const live =
        (await ve.call('weightOf', [ACCOUNTS.alice])) + (await ve.call('weightOf', [ACCOUNTS.bob]));
      assert.ok(
        recorded > live,
        'an overstated denominator makes quorum harder, which is the safe direction',
      );
    });

    test('a historical lookup is rejected for an unmined block', async () => {
      await assert.rejects(
        ve.call('totalWeightAt', [chain.blockNumber]),
        (e) => e.reverted,
      );
    });

    test('a historical lookup returns the checkpoint in force at that block', async () => {
      assert.equal(await ve.call('totalWeightAt', [chain.blockNumber - 1n]), 8000n * ONE);
    });
  });
});
