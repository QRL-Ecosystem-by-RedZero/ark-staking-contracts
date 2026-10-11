/**
 * StakingVault: tier scoping, pro-rata slashing, exact reward accounting, and
 * the 21-day unbonding delay that makes slashing enforceable at all.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { Chain, ACCOUNTS } = require('./harness');

const DAY = 24 * 60 * 60;
const ONE = 10n ** 18n;
const T1 = 0; // NoahArk
const T2 = 1; // Vault

async function fixture() {
  const chain = await Chain.create();
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
    [
      ACCOUNTS.admin,
      ACCOUNTS.bob,
      ACCOUNTS.attester,
      ACCOUNTS.oracle,
      ACCOUNTS.guardian,
      ACCOUNTS.mallory,
      chain.timestamp,
    ],
  );
  const ve = await chain.deploy('VeArk', ['address'], [ark.address]);
  const vault = await chain.deploy('StakingVault', ['address', 'address'], [ark.address, ve.address]);

  // The court is a plain EOA here: this suite tests the vault's rules, not the
  // court's, and the vault only cares that exactly one address may slash.
  await vault.send('setDisputeCourt', [ACCOUNTS.guardian], { from: ACCOUNTS.admin });

  for (const who of [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory, ACCOUNTS.oracle]) {
    if (who !== ACCOUNTS.admin) {
      await ark.send('transfer', [who, 100_000n * ONE], { from: ACCOUNTS.admin });
    }
    await ark.send('approve', [vault.address, 10n ** 30n], { from: who });
  }
  return { chain, ark, ve, vault };
}

describe('StakingVault', () => {
  describe('tier scoping', () => {
    let vault;

    before(async () => {
      ({ vault } = await fixture());
      await vault.send('registerOperator', [T1, 1000], { from: ACCOUNTS.attester });
      await vault.send('registerOperator', [T2, 500], { from: ACCOUNTS.oracle });
    });

    test('the documented constants are what the contract actually holds', async () => {
      assert.equal(await vault.call('UNBONDING_PERIOD'), BigInt(21 * DAY));
      assert.equal(await vault.call('MAX_JUROR_SHARE_BPS'), 1000n);
      assert.equal(await vault.call('MAX_COMMISSION_BPS'), 3000n);
    });

    test('a zero-amount stake is rejected', async () => {
      await assert.rejects(
        vault.send('stake', [T1, ACCOUNTS.attester, 0n], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('staking into an operator registered for another tier is rejected', async () => {
      await assert.rejects(
        vault.send('stake', [T2, ACCOUNTS.attester, 100n * ONE], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('an unregistered operator cannot be staked to', async () => {
      await assert.rejects(
        vault.send('stake', [T1, ACCOUNTS.mallory, 100n * ONE], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('stake lands in the tier its operator serves', async () => {
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.alice });
      assert.equal(await vault.call('totalStaked', [T1]), 1000n * ONE);
      assert.equal(await vault.call('totalStaked', [T2]), 0n);
    });

    test('a candidate has no draw weight in a tier it has not staked in', async () => {
      assert.ok((await vault.call('drawWeight', [ACCOUNTS.alice, T1])) > 0n);
      assert.equal(
        await vault.call('drawWeight', [ACCOUNTS.alice, T2]),
        0n,
        'nobody votes on a risk they do not carry',
      );
    });

    test('draw weight is capped so no address can take a jury majority', async () => {
      const total = await vault.call('totalStaked', [T1]);
      const weight = await vault.call('drawWeight', [ACCOUNTS.alice, T1]);
      assert.equal(weight, (total * 1000n) / 10000n, 'capped at 10% of the tier');
    });

    test('commission is capped, and may be lowered but never raised', async () => {
      await assert.rejects(
        vault.send('registerOperator', [T1, 5000], { from: ACCOUNTS.bob }),
        (e) => e.reverted,
        'above MAX_COMMISSION_BPS',
      );
      await vault.send('registerOperator', [T1, 500], { from: ACCOUNTS.attester });
      await assert.rejects(
        vault.send('registerOperator', [T1, 900], { from: ACCOUNTS.attester }),
        (e) => e.reverted,
        'raising it would be a retroactive fee on capital locked for 21 days',
      );
    });
  });

  describe('slashing is pro rata and reaches delegators', () => {
    let ark;
    let vault;
    let courtBalanceBefore;

    before(async () => {
      ({ ark, vault } = await fixture());
      // The court address here doubles as the backstop allocation holder, so
      // only the delta is meaningful.
      courtBalanceBefore = await ark.call('balanceOf', [ACCOUNTS.guardian]);
      await vault.send('registerOperator', [T1, 0], { from: ACCOUNTS.attester });
      await vault.send('stake', [T1, ACCOUNTS.attester, 3000n * ONE], { from: ACCOUNTS.alice });
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.bob });
    });

    test('only the dispute court may slash', async () => {
      await assert.rejects(
        vault.send('slash', [ACCOUNTS.attester, ONE, '0x' + '11'.repeat(32)], {
          from: ACCOUNTS.admin,
        }),
        (e) => e.reverted,
        'no governance role reaches staker capital directly',
      );
    });

    test('a stranger cannot name the dispute court', async () => {
      const fresh = await fixture();
      await assert.rejects(
        fresh.vault.send('setDisputeCourt', [ACCOUNTS.mallory], { from: ACCOUNTS.mallory }),
        (e) => e.reverted,
      );
    });

    test('the court cannot be re-pointed once set', async () => {
      await assert.rejects(
        vault.send('setDisputeCourt', [ACCOUNTS.mallory], { from: ACCOUNTS.admin }),
        (e) => e.reverted,
      );
    });

    test('a slash cuts every delegator in the pool proportionally', async () => {
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.alice]), 3000n * ONE);
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.bob]), 1000n * ONE);

      // Slash a quarter of the 4000 ARK pool.
      await vault.send('slash', [ACCOUNTS.attester, 1000n * ONE, '0x' + '22'.repeat(32)], {
        from: ACCOUNTS.guardian,
      });

      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.alice]), 2250n * ONE);
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.bob]), 750n * ONE);
      assert.equal(await vault.call('totalStaked', [T1]), 3000n * ONE);
    });

    test('slashed ARK moves to the court, it is not burned', async () => {
      const gained = (await ark.call('balanceOf', [ACCOUNTS.guardian])) - courtBalanceBefore;
      assert.equal(gained, 1000n * ONE);
    });

    test('a slash larger than the pool is rejected', async () => {
      await assert.rejects(
        vault.send('slash', [ACCOUNTS.attester, 999_999n * ONE, '0x' + '33'.repeat(32)], {
          from: ACCOUNTS.guardian,
        }),
        (e) => e.reverted,
      );
    });
  });

  describe('unbonding outlasts a dispute', () => {
    let chain;
    let vault;

    before(async () => {
      ({ chain, vault } = await fixture());
      await vault.send('registerOperator', [T1, 0], { from: ACCOUNTS.attester });
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.alice });
    });

    test('the delay is 21 days, longer than the longest dispute cycle', async () => {
      assert.equal(await vault.call('UNBONDING_PERIOD'), BigInt(21 * DAY));
    });

    test('unbonding removes jury weight but NOT the stake', async () => {
      await vault.send('beginUnbonding', [1000n * ONE], { from: ACCOUNTS.alice });

      assert.equal(await vault.call('drawWeight', [ACCOUNTS.alice, T1]), 0n, 'no longer drawable');
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.alice]), 0n, 'no active stake');
      assert.equal(
        await vault.call('exitingValueOf', [ACCOUNTS.alice]),
        1000n * ONE,
        'still exposed',
      );
      assert.equal(
        await vault.call('totalStaked', [T1]),
        1000n * ONE,
        'the stake stays in the slashable pool for the full window',
      );
    });

    test('a second unbonding request cannot be queued behind the first', async () => {
      await vault.send('stake', [T1, ACCOUNTS.attester, 500n * ONE], { from: ACCOUNTS.bob });
      await vault.send('beginUnbonding', [500n * ONE], { from: ACCOUNTS.bob });
      await assert.rejects(
        vault.send('beginUnbonding', [1n], { from: ACCOUNTS.bob }),
        (e) => e.reverted,
        'a sliced exit could be timed around a dispute the staker can already see',
      );
    });

    test('withdrawal before the delay elapses is rejected', async () => {
      await assert.rejects(vault.send('withdraw', [], { from: ACCOUNTS.alice }), (e) => e.reverted);
      chain.advanceTime(20 * DAY);
      await assert.rejects(vault.send('withdraw', [], { from: ACCOUNTS.alice }), (e) => e.reverted);
    });

    test('withdrawal succeeds once the delay has passed', async () => {
      chain.advanceTime(2 * DAY);
      await vault.send('withdraw', [], { from: ACCOUNTS.alice });
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.alice]), 0n);
    });
  });

  describe('an exit cannot outrun a slash', () => {
    let chain;
    let vault;

    before(async () => {
      ({ chain, vault } = await fixture());
      await vault.send('registerOperator', [T1, 0], { from: ACCOUNTS.attester });
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.alice });
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.bob });
    });

    test('stake unbonding when the slash lands still takes the cut', async () => {
      // Alice sees a dispute coming and heads for the exit.
      await vault.send('beginUnbonding', [1000n * ONE], { from: ACCOUNTS.alice });

      // The verdict arrives inside her 21-day window and halves the pool.
      await vault.send('slash', [ACCOUNTS.attester, 1000n * ONE, '0x' + '44'.repeat(32)], {
        from: ACCOUNTS.guardian,
      });

      assert.equal(
        await vault.call('exitingValueOf', [ACCOUNTS.alice]),
        500n * ONE,
        'unbonding is a delay, not an escape hatch',
      );
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.bob]), 500n * ONE);
    });

    test('the withdrawal pays the slashed value, not the requested one', async () => {
      chain.advanceTime(22 * DAY);
      const res = await vault.send('withdraw', [], { from: ACCOUNTS.alice });
      const [ev] = vault.events(res, 'Withdrawn');
      assert.equal(ev.args.amount, 500n * ONE);
    });

    test('the pool is left consistent after the exit completes', async () => {
      assert.equal(await vault.call('totalStaked', [T1]), 500n * ONE);
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.bob]), 500n * ONE);
    });
  });

  describe('redelegation', () => {
    let vault;

    before(async () => {
      ({ vault } = await fixture());
      await vault.send('registerOperator', [T1, 0], { from: ACCOUNTS.attester });
      await vault.send('registerOperator', [T1, 0], { from: ACCOUNTS.mallory });
      await vault.send('registerOperator', [T2, 0], { from: ACCOUNTS.oracle });
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.alice });
    });

    test('moving to another operator in the same tier keeps the stake', async () => {
      await vault.send('redelegate', [ACCOUNTS.mallory], { from: ACCOUNTS.alice });
      const d = await vault.call('delegationOf', [ACCOUNTS.alice]);
      assert.equal(d.operator.toLowerCase(), ACCOUNTS.mallory.toLowerCase());
      assert.equal(await vault.call('stakeValueOf', [ACCOUNTS.alice]), 1000n * ONE);
      assert.equal(await vault.call('totalStaked', [T1]), 1000n * ONE);
    });

    test('crossing tiers this way is rejected', async () => {
      await assert.rejects(
        vault.send('redelegate', [ACCOUNTS.oracle], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
        'hopping tiers would dodge the slash the same way an instant exit would',
      );
    });

    test('redelegating while shares are exiting is rejected', async () => {
      await vault.send('beginUnbonding', [500n * ONE], { from: ACCOUNTS.alice });
      await assert.rejects(
        vault.send('redelegate', [ACCOUNTS.attester], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });

    test('staking to a second operator while committed to one is rejected', async () => {
      await assert.rejects(
        vault.send('stake', [T1, ACCOUNTS.attester, ONE], { from: ACCOUNTS.alice }),
        (e) => e.reverted,
      );
    });
  });

  describe('jury draw combines stake with veARK', () => {
    let chain;
    let ark;
    let ve;
    let vault;

    before(async () => {
      ({ chain, ark, ve, vault } = await fixture());
      await vault.send('registerOperator', [T1, 0], { from: ACCOUNTS.attester });
      // One whale plus two equal small stakers, so the 10% per-address cap does
      // not bind and the veARK term is actually visible.
      await vault.send('stake', [T1, ACCOUNTS.attester, 90_000n * ONE], { from: ACCOUNTS.mallory });
      await vault.send('stake', [T1, ACCOUNTS.attester, 5_000n * ONE], { from: ACCOUNTS.alice });
      await vault.send('stake', [T1, ACCOUNTS.attester, 5_000n * ONE], { from: ACCOUNTS.bob });
      await ark.send('approve', [ve.address, 10n ** 30n], { from: ACCOUNTS.bob });
      await ve.send('createLock', [4000n * ONE, chain.timestamp + BigInt(4 * 365 * DAY)], {
        from: ACCOUNTS.bob,
      });
    });

    test('a veARK lock raises draw weight above bare stake', async () => {
      const plain = await vault.call('drawWeight', [ACCOUNTS.alice, T1]);
      const locked = await vault.call('drawWeight', [ACCOUNTS.bob, T1]);
      assert.ok(locked > plain, 'a long horizon is rewarded in the draw');
    });

    test('veARK alone confers no draw weight without stake in the tier', async () => {
      await ark.send('transfer', [ACCOUNTS.oracle, 5000n * ONE], { from: ACCOUNTS.admin });
      await ark.send('approve', [ve.address, 10n ** 30n], { from: ACCOUNTS.oracle });
      await ve.send('createLock', [5000n * ONE, chain.timestamp + BigInt(4 * 365 * DAY)], {
        from: ACCOUNTS.oracle,
      });
      assert.equal(
        await vault.call('drawWeight', [ACCOUNTS.oracle, T1]),
        0n,
        'nothing to lose means no say',
      );
    });

    test('a huge lock with a token stake cannot buy influence', async () => {
      // oracle already holds a 5,000 ARK four-year lock from the test above, far
      // larger than the stake it is about to put down.
      await vault.send('stake', [T1, ACCOUNTS.attester, 10n * ONE], { from: ACCOUNTS.oracle });

      const base = await vault.call('stakeValueOf', [ACCOUNTS.oracle]);
      const weight = await vault.call('drawWeight', [ACCOUNTS.oracle, T1]);

      assert.equal(
        weight,
        base * 2n,
        'the veARK bonus is capped at the stake itself, so a long lock is worth at most a doubling',
      );
    });

    test('the per-address cap still binds however large the stake is', async () => {
      const total = await vault.call('totalStaked', [T1]);
      const cap = (total * 1000n) / 10000n;
      assert.equal(
        await vault.call('drawWeight', [ACCOUNTS.mallory, T1]),
        cap,
        'a 90% staker is cut to 10% of the jury weight',
      );
      assert.ok((await vault.call('drawWeight', [ACCOUNTS.bob, T1])) <= cap);
    });
  });

  describe('reward accounting', () => {
    let chain;
    let vault;

    before(async () => {
      ({ chain, vault } = await fixture());
      await vault.send('registerOperator', [T1, 1000], { from: ACCOUNTS.attester });
    });

    test('rewards for an empty tier are held, not lost and not reverted', async () => {
      await vault.send('distributeRewards', [T1], { from: ACCOUNTS.admin, value: 100n * ONE });
      await vault.send('registerOperator', [T2, 0], { from: ACCOUNTS.oracle });
      assert.equal(await vault.call('totalStaked', [T1]), 0n);
    });

    test('held rewards are folded into the next distribution', async () => {
      await vault.send('stake', [T1, ACCOUNTS.attester, 1000n * ONE], { from: ACCOUNTS.alice });
      await vault.send('distributeRewards', [T1], { from: ACCOUNTS.admin, value: 100n * ONE });

      // 200 QRL total, 10% commission to the operator, 180 to the sole delegator.
      await vault.send('claimRewards', [], { from: ACCOUNTS.alice });
      assert.equal(await vault.call('claimableOf', [ACCOUNTS.alice]), 0n);
    });

    test('rewards split by stake share, and commission goes to the operator', async () => {
      await vault.send('stake', [T1, ACCOUNTS.attester, 3000n * ONE], { from: ACCOUNTS.bob });
      await vault.send('distributeRewards', [T1], { from: ACCOUNTS.admin, value: 400n * ONE });

      const balanceBefore = await chain.balanceOf(ACCOUNTS.bob);
      await vault.send('claimRewards', [], { from: ACCOUNTS.bob });
      const gained = (await chain.balanceOf(ACCOUNTS.bob)) - balanceBefore;

      // 400 QRL, 10% commission = 360 to delegators; bob holds 3/4 of the pool.
      assert.equal(gained, 270n * ONE);
    });

    test('an operator collects its commission through the same call', async () => {
      const balanceBefore = await chain.balanceOf(ACCOUNTS.attester);
      await vault.send('claimRewards', [], { from: ACCOUNTS.attester });
      const gained = (await chain.balanceOf(ACCOUNTS.attester)) - balanceBefore;
      assert.ok(gained > 0n, 'commission accrued across both distributions');
    });

    test('claiming twice pays nothing the second time', async () => {
      await vault.send('claimRewards', [], { from: ACCOUNTS.bob });
      assert.equal(await vault.call('claimableOf', [ACCOUNTS.bob]), 0n);
    });
  });
});
