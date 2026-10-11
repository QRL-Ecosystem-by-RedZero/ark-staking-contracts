/**
 * ARK token: fixed supply, allocation split, vesting, and checkpointed votes.
 *
 * The property worth guarding here is invariant #6 in one direction and the
 * vesting rule in the other: supply can never grow, and unvested allocations
 * can neither move nor vote.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { Chain, ACCOUNTS } = require('./harness');

const YEAR = 365 * 24 * 60 * 60;
const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE;

/** Allocation buckets, mapped onto the harness's fixed test accounts. */
const BUCKETS = {
  incentives: ACCOUNTS.alice,
  treasury: ACCOUNTS.bob,
  contributors: ACCOUNTS.attester,
  backers: ACCOUNTS.oracle,
  backstop: ACCOUNTS.guardian,
  liquidity: ACCOUNTS.mallory,
};

async function deployToken(chain) {
  return chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
    [
      BUCKETS.incentives,
      BUCKETS.treasury,
      BUCKETS.contributors,
      BUCKETS.backers,
      BUCKETS.backstop,
      BUCKETS.liquidity,
      chain.timestamp,
    ],
  );
}

describe('ArkToken', () => {
  describe('supply and allocation', () => {
    let chain;
    let ark;

    before(async () => {
      chain = await Chain.create();
      ark = await deployToken(chain);
    });

    test('mints exactly the fixed supply', async () => {
      assert.equal(await ark.call('totalSupply'), SUPPLY);
      assert.equal(await ark.call('MAX_SUPPLY'), SUPPLY);
    });

    test('splits the supply across the six documented buckets', async () => {
      const expected = {
        incentives: 3500n,
        treasury: 2000n,
        contributors: 1800n,
        backers: 1200n,
        backstop: 1000n,
        liquidity: 500n,
      };
      let total = 0n;
      for (const [name, bps] of Object.entries(expected)) {
        const balance = await ark.call('balanceOf', [BUCKETS[name]]);
        assert.equal(balance, (SUPPLY * bps) / 10000n, `${name} bucket`);
        total += balance;
      }
      assert.equal(total, SUPPLY, 'buckets must account for the whole supply');
    });

    test('has no mint function at all', () => {
      const named = ark.iface.fragments.filter((f) => f.type === 'function' && /mint/i.test(f.name));
      assert.deepEqual(named, [], 'a mint entry point would break invariant #6');
    });

    test('the documented constants are what the contract actually holds', async () => {
      // governance.md section 1.1 lists these as compiled-in, not governable.
      assert.equal(await ark.call('MAX_SUPPLY'), 1_000_000_000n * ONE);
      assert.equal(await ark.call('VEST_CLIFF'), BigInt(YEAR));
      assert.equal(await ark.call('VEST_DURATION'), BigInt(4 * YEAR));
    });

    test('rejects a zero vesting start', async () => {
      await assert.rejects(
        chain.deploy(
          'ArkToken',
          ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
          [
            BUCKETS.incentives,
            BUCKETS.treasury,
            BUCKETS.contributors,
            BUCKETS.backers,
            BUCKETS.backstop,
            BUCKETS.liquidity,
            0,
          ],
        ),
      );
    });

    test('rejects a zero address in any bucket', async () => {
      await assert.rejects(
        chain.deploy(
          'ArkToken',
          ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
          [
            BUCKETS.incentives,
            '0x' + '00'.repeat(20),
            BUCKETS.contributors,
            BUCKETS.backers,
            BUCKETS.backstop,
            BUCKETS.liquidity,
            chain.timestamp,
          ],
        ),
      );
    });
  });

  describe('vesting', () => {
    let chain;
    let ark;
    const contributorTotal = (SUPPLY * 1800n) / 10000n;

    before(async () => {
      chain = await Chain.create();
      ark = await deployToken(chain);
    });

    test('locks the whole contributor allocation before the cliff', async () => {
      assert.equal(await ark.call('lockedOf', [BUCKETS.contributors]), contributorTotal);
      assert.equal(await ark.call('vestedBalanceOf', [BUCKETS.contributors]), 0n);
    });

    test('a locked allocation cannot be transferred', async () => {
      await assert.rejects(
        ark.send('transfer', [ACCOUNTS.admin, ONE], { from: BUCKETS.contributors }),
        (e) => e.reverted,
        'moving unvested tokens would defeat the no-weight rule',
      );
    });

    test('unallocated buckets are unlocked from the start', async () => {
      assert.equal(await ark.call('lockedOf', [BUCKETS.treasury]), 0n);
      assert.equal(
        await ark.call('vestedBalanceOf', [BUCKETS.treasury]),
        (SUPPLY * 2000n) / 10000n,
      );
    });

    test('nothing vests one day before the cliff', async () => {
      chain.advanceTime(YEAR - 24 * 60 * 60);
      assert.equal(await ark.call('lockedOf', [BUCKETS.contributors]), contributorTotal);
    });

    test('a quarter has vested at the cliff', async () => {
      chain.advanceTime(24 * 60 * 60);
      const locked = await ark.call('lockedOf', [BUCKETS.contributors]);
      assert.equal(locked, contributorTotal - contributorTotal / 4n);
    });

    test('half has vested at two years', async () => {
      chain.advanceTime(YEAR);
      const vested = await ark.call('vestedBalanceOf', [BUCKETS.contributors]);
      assert.equal(vested, contributorTotal / 2n);
    });

    test('everything is unlocked after four years', async () => {
      chain.advanceTime(2 * YEAR);
      assert.equal(await ark.call('lockedOf', [BUCKETS.contributors]), 0n);
      assert.equal(await ark.call('vestedBalanceOf', [BUCKETS.contributors]), contributorTotal);
    });

    test('a fully vested allocation transfers freely', async () => {
      await ark.send('transfer', [ACCOUNTS.admin, ONE], { from: BUCKETS.contributors });
      assert.equal(await ark.call('balanceOf', [ACCOUNTS.admin]), ONE);
    });
  });

  describe('partial vesting', () => {
    let chain;
    let ark;
    const contributorTotal = (SUPPLY * 1800n) / 10000n;

    before(async () => {
      chain = await Chain.create();
      ark = await deployToken(chain);
      chain.advanceTime(2 * YEAR); // half vested
    });

    test('exactly the vested half may leave, and not one wei more', async () => {
      const half = contributorTotal / 2n;
      await assert.rejects(
        ark.send('transfer', [ACCOUNTS.admin, half + ONE], { from: BUCKETS.contributors }),
        (e) => e.reverted,
      );
      await ark.send('transfer', [ACCOUNTS.admin, half], { from: BUCKETS.contributors });
      assert.equal(await ark.call('balanceOf', [ACCOUNTS.admin]), half);
    });

    test('the locked remainder is still pinned after the vested part is spent', async () => {
      assert.equal(await ark.call('vestedBalanceOf', [BUCKETS.contributors]), 0n);
      await assert.rejects(
        ark.send('transfer', [ACCOUNTS.admin, ONE], { from: BUCKETS.contributors }),
        (e) => e.reverted,
      );
    });

    test('the backer bucket vests on the same schedule', async () => {
      const backerTotal = (SUPPLY * 1200n) / 10000n;
      assert.equal(await ark.call('vestedBalanceOf', [BUCKETS.backers]), backerTotal / 2n);
    });

    test('a spender cannot pull locked tokens either', async () => {
      await ark.send('approve', [ACCOUNTS.admin, SUPPLY], { from: BUCKETS.contributors });
      await assert.rejects(
        ark.send('transferFrom', [BUCKETS.contributors, ACCOUNTS.admin, ONE], {
          from: ACCOUNTS.admin,
        }),
        (e) => e.reverted,
        'the lock must not be routable around via an allowance',
      );
    });
  });

  describe('delegation and checkpoints', () => {
    let chain;
    let ark;
    const treasuryBalance = (SUPPLY * 2000n) / 10000n;

    before(async () => {
      chain = await Chain.create();
      ark = await deployToken(chain);
    });

    test('holding tokens confers no votes until delegated', async () => {
      assert.equal(await ark.call('getVotes', [BUCKETS.treasury]), 0n);
    });

    test('self-delegation activates the holder’s vested weight', async () => {
      await ark.send('delegate', [BUCKETS.treasury], { from: BUCKETS.treasury });
      assert.equal(await ark.call('getVotes', [BUCKETS.treasury]), treasuryBalance);
      assert.equal(await ark.call('delegates', [BUCKETS.treasury]), BUCKETS.treasury);
    });

    test('DelegateVotesChanged names the delegate, not the caller', async () => {
      const res = await ark.send('delegate', [ACCOUNTS.admin], { from: BUCKETS.liquidity });
      const [ev] = ark.events(res, 'DelegateVotesChanged');
      assert.equal(ev.args.delegate.toLowerCase(), ACCOUNTS.admin.toLowerCase());
    });

    test('delegation is revocable, which is what makes a bought vote unstable', async () => {
      await ark.send('delegate', [BUCKETS.treasury], { from: BUCKETS.liquidity });
      assert.equal(await ark.call('getVotes', [ACCOUNTS.admin]), 0n);
      await ark.send('delegate', [ACCOUNTS.admin], { from: BUCKETS.liquidity });
      assert.equal(await ark.call('getVotes', [ACCOUNTS.admin]), (SUPPLY * 500n) / 10000n);
    });

    test('an unvested allocation delegates zero weight', async () => {
      await ark.send('delegate', [BUCKETS.contributors], { from: BUCKETS.contributors });
      assert.equal(
        await ark.call('getVotes', [BUCKETS.contributors]),
        0n,
        'contributors must not vote with tokens they have not earned',
      );
    });

    test('newly vested weight is inert until someone syncs it', async () => {
      chain.advanceTime(2 * YEAR);
      assert.equal(
        await ark.call('getVotes', [BUCKETS.contributors]),
        0n,
        'weight understates until poked, which is the safe direction',
      );

      await ark.send('syncVotingWeight', [BUCKETS.contributors], { from: ACCOUNTS.mallory });
      assert.equal(
        await ark.call('getVotes', [BUCKETS.contributors]),
        (SUPPLY * 1800n) / 10000n / 2n,
      );
    });

    test('a past lookup is stable after later weight changes', async () => {
      const written = chain.blockNumber;
      chain.advanceTime(12);

      const before = await ark.call('getPastVotes', [BUCKETS.contributors, written]);
      assert.ok(before > 0n, 'the snapshot must hold real weight to be worth testing');

      await ark.send('delegate', [ACCOUNTS.bob], { from: BUCKETS.incentives });
      chain.advanceTime(12);

      assert.equal(await ark.call('getPastVotes', [BUCKETS.contributors, written]), before);
    });

    test('a lookup of the current or a future block is rejected', async () => {
      await assert.rejects(
        ark.call('getPastVotes', [BUCKETS.treasury, chain.blockNumber]),
        (e) => e.reverted,
      );
      await assert.rejects(
        ark.call('getPastTotalSupply', [chain.blockNumber + 100n]),
        (e) => e.reverted,
      );
    });

    test('transferring moves voting weight with the tokens', async () => {
      const donor = BUCKETS.treasury;
      const before = await ark.call('getVotes', [donor]);
      await ark.send('transfer', [ACCOUNTS.admin, 1000n * ONE], { from: donor });
      assert.equal(await ark.call('getVotes', [donor]), before - 1000n * ONE);
    });
  });
  describe('withdrawing delegated weight', () => {
    let chain;
    let ark;
    const treasuryBalance = (SUPPLY * 2000n) / 10000n;

    before(async () => {
      chain = await Chain.create();
      ark = await deployToken(chain);
      await ark.send('delegate', [BUCKETS.treasury], { from: BUCKETS.treasury });
    });

    test('delegating to the zero address withdraws the weight entirely', async () => {
      assert.equal(await ark.call('getVotes', [BUCKETS.treasury]), treasuryBalance);
      await ark.send('delegate', ['0x' + '00'.repeat(20)], { from: BUCKETS.treasury });
      assert.equal(await ark.call('getVotes', [BUCKETS.treasury]), 0n);
    });

    test('re-delegating brings it back', async () => {
      await ark.send('delegate', [BUCKETS.treasury], { from: BUCKETS.treasury });
      assert.equal(await ark.call('getVotes', [BUCKETS.treasury]), treasuryBalance);
    });

    test('an inbound delegation is untouched when the delegate withdraws its own', async () => {
      await ark.send('delegate', [BUCKETS.treasury], { from: BUCKETS.liquidity });
      const liquidity = (SUPPLY * 500n) / 10000n;
      assert.equal(await ark.call('getVotes', [BUCKETS.treasury]), treasuryBalance + liquidity);

      await ark.send('delegate', ['0x' + '00'.repeat(20)], { from: BUCKETS.treasury });
      assert.equal(
        await ark.call('getVotes', [BUCKETS.treasury]),
        liquidity,
        "withdrawing your own weight must not confiscate a delegator's",
      );
    });

    test('past total supply counts only delegated weight', async () => {
      // The harness only advances the block number with the clock, so every send
      // above shares one block. Move on before reading history.
      const written = chain.blockNumber;
      chain.advanceTime(12);

      const total = await ark.call('getPastTotalSupply', [written]);
      assert.equal(
        total,
        (SUPPLY * 500n) / 10000n,
        'only the liquidity delegation is still standing',
      );
      assert.ok(total < SUPPLY, 'undelegated and unvested holdings are excluded');
    });
  });
});
