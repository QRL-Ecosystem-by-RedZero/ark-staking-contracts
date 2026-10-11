/**
 * ProceedsLedger: the account a coupon is paid from, and the reasons it is a
 * separate contract from the one holding bond principal.
 *
 * Whitepaper section 4.7 condition 1 — a coupon only from proceeds delivered
 * for its own epoch, credited by the premium swap until the QRL expiry of that
 * epoch's lots, early in the epoch after next — and condition 2 — "bond
 * principal is never a source of a coupon" — are claims about reachability
 * and about the clock, not about a guard. These tests fail if either is
 * relaxed.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Chain, ACCOUNTS } = require('./harness');

const DAY = 24 * 60 * 60;
const EPOCH = 7 * DAY;
const ONE = 10n ** 18n;

/** The bond and the swap are EOAs here: this suite tests the ledger's rules, not theirs. */
const BOND = ACCOUNTS.guardian;
const SWAP = ACCOUNTS.alice;

/** ArkEpoch.settlementCloses: four days into `e + 2`. */
const settlementCloses = (e) => (BigInt(e) + 2n) * BigInt(EPOCH) + 4n * BigInt(DAY);

async function fixture() {
  const chain = await Chain.create();
  const ledger = await chain.deploy('ProceedsLedger');
  await ledger.send('setBond', [BOND], { from: ACCOUNTS.admin });
  await ledger.send('setSwap', [SWAP], { from: ACCOUNTS.admin });
  return { chain, ledger };
}

const epochNow = (ledger) => ledger.call('currentEpoch');

/** Move to the first second of the next epoch: the previous one's settlement window is open. */
function toNextEpoch(chain, plus = 1) {
  const next = (chain.timestamp / BigInt(EPOCH) + 1n) * BigInt(EPOCH);
  chain.advanceTime(Number(next - chain.timestamp) + plus);
}

/** Epoch `e` has been swept; move into its settlement window and return it. */
async function inWindow(ctx) {
  const e = await epochNow(ctx.ledger);
  toNextEpoch(ctx.chain);
  return e;
}

/** Past the settlement window of the epoch before the current one: its coupon is due. */
function pastWindow(chain) {
  const e = chain.timestamp / BigInt(EPOCH) - 1n;
  const at = settlementCloses(e);
  if (at > chain.timestamp) chain.advanceTime(Number(at - chain.timestamp));
}

describe('ProceedsLedger', () => {
  describe('naming the drawer', () => {
    test('only the deployer may name the bond', async () => {
      const chain = await Chain.create();
      const ledger = await chain.deploy('ProceedsLedger');
      await assert.rejects(() => ledger.send('setBond', [BOND], { from: ACCOUNTS.mallory }), /OnlyDeployer/);
    });

    test('the bond cannot be re-pointed once named', async () => {
      const { ledger } = await fixture();
      await assert.rejects(() => ledger.send('setBond', [ACCOUNTS.mallory], { from: ACCOUNTS.admin }), /BondAlreadySet/);
    });

    test('the swap, the one depositor, is named once by the deployer and never re-pointed', async () => {
      const chain = await Chain.create();
      const ledger = await chain.deploy('ProceedsLedger');
      await assert.rejects(() => ledger.send('setSwap', [SWAP], { from: ACCOUNTS.mallory }), /OnlyDeployer/);
      await ledger.send('setSwap', [SWAP], { from: ACCOUNTS.admin });
      await assert.rejects(() => ledger.send('setSwap', [ACCOUNTS.mallory], { from: ACCOUNTS.admin }), /SwapAlreadySet/);
    });
  });

  describe('an epoch is credited by the swap during its settlement window and at no other time', () => {
    test('the epoch just closed is credited until its lots expire on QRL, early in the epoch after next', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 600n * ONE });
      toNextEpoch(ctx.chain);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE });
      assert.equal(await ctx.ledger.call('deliveredIn', [e]), 601n * ONE);
    });

    test('an epoch still in progress cannot be credited: its premium has not been sold', async () => {
      const ctx = await fixture();
      const e = await epochNow(ctx.ledger);
      await assert.rejects(() => ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE }), /CreditWindowShut/);
    });

    test('a credit after the window has closed is refused, not re-attributed', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      pastWindow(ctx.chain);
      await assert.rejects(() => ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE }), /CreditWindowShut/);
      assert.equal(await ctx.ledger.call('deliveredIn', [e]), 0n);
      assert.equal(await ctx.ledger.call('deliveredIn', [e + 1n]), 0n);
    });

    test('the swap credits the epoch its lot sold, which need not be the one closest', async () => {
      // Two settlement windows overlap in time, so the epoch is the lot's and
      // the swap names it; a lot of e is credited to e while e + 1 is open too.
      const ctx = await fixture();
      const e = await inWindow(ctx);
      toNextEpoch(ctx.chain);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE });
      await ctx.ledger.send('deliver', [e + 1n], { from: SWAP, value: 2n * ONE });
      assert.equal(await ctx.ledger.call('deliveredIn', [e]), ONE);
      assert.equal(await ctx.ledger.call('deliveredIn', [e + 1n]), 2n * ONE);
      await assert.rejects(() => ctx.ledger.send('deliver', [e + 2n], { from: SWAP, value: ONE }), /CreditWindowShut/);
    });

    test('nobody but the swap credits an epoch: choosing the epoch moves value between bondholders', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await assert.rejects(() => ctx.ledger.send('deliver', [e], { from: ACCOUNTS.mallory, value: ONE }), /OnlySwap/);
      await assert.rejects(() => ctx.ledger.send('deliver', [e], { from: BOND, value: ONE }), /OnlySwap/);
    });

    test('a bare transfer is refused because it names no epoch', async () => {
      const { chain, ledger } = await fixture();
      await assert.rejects(() => chain.execute(ledger.address, ACCOUNTS.alice, '0x', ONE), /ZeroValue/);
    });

    test('a zero delivery is refused', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await assert.rejects(() => ctx.ledger.send('deliver', [e], { from: SWAP, value: 0n }), /ZeroValue/);
    });
  });

  describe('a coupon is drawn from its own epoch, at the close of its window, and from no other account', () => {
    test('the coupon is not payable while the window is open', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 10n * ONE });
      await assert.rejects(() => ctx.ledger.send('draw', [e, ACCOUNTS.bob, ONE], { from: BOND }), /NotYetPayable/);
      pastWindow(ctx.chain);
      await ctx.ledger.send('draw', [e, ACCOUNTS.bob, ONE], { from: BOND });
    });

    test('only the bond may draw', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 10n * ONE });
      pastWindow(ctx.chain);
      await assert.rejects(() => ctx.ledger.send('draw', [e, ACCOUNTS.mallory, ONE], { from: ACCOUNTS.mallory }), /OnlyBond/);
    });

    test('a draw beyond what the epoch delivered is refused', async () => {
      // The shortfall rule of whitepaper section 4.7 lives in the bond, which
      // reduces the epoch's coupon proportionally. What the ledger enforces is
      // that the shortfall cannot be met from anywhere else.
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 10n * ONE });
      pastWindow(ctx.chain);
      await assert.rejects(() => ctx.ledger.send('draw', [e, ACCOUNTS.bob, 11n * ONE], { from: BOND }), /InsufficientProceeds/);
    });

    test('the drawn amount reaches the recipient', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 10n * ONE });
      pastWindow(ctx.chain);
      const before = await ctx.chain.balanceOf(ACCOUNTS.bob);
      await ctx.ledger.send('draw', [e, ACCOUNTS.bob, 4n * ONE], { from: BOND });
      assert.equal((await ctx.chain.balanceOf(ACCOUNTS.bob)) - before, 4n * ONE);
      assert.equal(await ctx.ledger.call('remainingIn', [e]), 6n * ONE);
      assert.equal(await ctx.ledger.call('isSealed', [e]), true);
    });

    test('proceeds of one epoch are undrawable from the next', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 10n * ONE });
      toNextEpoch(ctx.chain);
      pastWindow(ctx.chain);
      await assert.rejects(() => ctx.ledger.send('draw', [e + 1n, ACCOUNTS.bob, ONE], { from: BOND }), /InsufficientProceeds/);
    });
  });

  describe('a residue is distributed with the following epoch, and nowhere else', () => {
    test('the bond carries a residue into the epoch after it, before that epoch is paid', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 10n * ONE });
      pastWindow(ctx.chain);
      await ctx.ledger.send('draw', [e, ACCOUNTS.bob, 10n * ONE - 7n], { from: BOND });

      const res = await ctx.ledger.send('carryResidue', [e], { from: BOND });
      const [ev] = ctx.ledger.events(res, 'ResidueCarried');
      assert.equal(ev.args.fromEpoch, e);
      assert.equal(ev.args.toEpoch, e + 1n);
      assert.equal(ev.args.amount, 7n);
      assert.equal(await ctx.ledger.call('remainingIn', [e]), 0n);
      assert.equal(await ctx.ledger.call('remainingIn', [e + 1n]), 7n);
    });

    test('only the bond may carry, because only it can tell a residue from a shortfall', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE });
      pastWindow(ctx.chain);
      await assert.rejects(() => ctx.ledger.send('carryResidue', [e], { from: ACCOUNTS.mallory }), /OnlyBond/);
    });

    test('nothing is carried out of an epoch whose proceeds are not final', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE });
      await assert.rejects(() => ctx.ledger.send('carryResidue', [e], { from: BOND }), /NotYetPayable/);
    });

    test('a residue reaches only the next epoch, and not once that epoch has been paid', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 3n * ONE });
      pastWindow(ctx.chain);
      await ctx.ledger.send('draw', [e, ACCOUNTS.bob, ONE], { from: BOND });

      // The next epoch is credited and paid before the bond gets to the carry.
      await ctx.ledger.send('deliver', [e + 1n], { from: SWAP, value: ONE });
      toNextEpoch(ctx.chain);
      pastWindow(ctx.chain);
      await ctx.ledger.send('draw', [e + 1n, ACCOUNTS.bob, ONE], { from: BOND });

      await assert.rejects(() => ctx.ledger.send('carryResidue', [e], { from: BOND }), /EpochSealed/);
      assert.equal(await ctx.ledger.call('remainingIn', [e]), 2n * ONE, 'the residue stays where it was');
    });

    test('a residue distributed late is still carried: the next epoch\'s credit window binds depositors, not the bond (R26)', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 3n * ONE });
      pastWindow(ctx.chain);
      await ctx.ledger.send('draw', [e, ACCOUNTS.bob, ONE], { from: BOND });

      toNextEpoch(ctx.chain);
      pastWindow(ctx.chain);
      await ctx.ledger.send('carryResidue', [e], { from: BOND });
      assert.equal(await ctx.ledger.call('remainingIn', [e]), 0n);
      assert.equal(await ctx.ledger.call('remainingIn', [e + 1n]), 2n * ONE);
    });

    test('nothing to carry is refused rather than recorded as a carry', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      pastWindow(ctx.chain);
      await assert.rejects(() => ctx.ledger.send('carryResidue', [e], { from: BOND }), /ZeroValue/);
    });
  });

  describe('the ledger has no path that is not a delivery', () => {
    test('every wei it holds was delivered against an epoch', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 3n * ONE });
      assert.equal(await ctx.chain.balanceOf(ctx.ledger.address), 3n * ONE);
    });

    test('the ledger exposes no function that could take principal in or send it out', async () => {
      const { ledger } = await fixture();
      const names = ledger.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name).sort();
      assert.deepEqual(names, [
        'bond',
        'carryResidue',
        'carryShortfall',
        'collectForfeits',
        'currentEpoch',
        'deliver',
        'deliveredIn',
        'draw',
        'forfeit',
        'isSealed',
        'recoverShortfall',
        'remainingIn',
        'setBond',
        'setSwap',
        'shortfallCarry',
        'swap',
      ]);
    });
  });

  // Gap items 17 and 18 (CLAUDE.md), whitepaper §4.7, I33, I34.
  describe('forfeited commitment bonds and the shortfall carry', () => {
    test('I33: a forfeited bond joins the proceeds of the epoch it was forfeited against, from the swap alone, until that epoch is drawn', async () => {
      const ctx = await fixture();
      const e = await inWindow(ctx);
      await assert.rejects(() => ctx.ledger.send('forfeit', [e], { from: ACCOUNTS.mallory, value: ONE }), /OnlySwap/);
      await ctx.ledger.send('deliver', [e], { from: SWAP, value: 3n * ONE });
      pastWindow(ctx.chain);
      // Past the credit window of `deliver`, where the forfeit is determined.
      await assert.rejects(() => ctx.ledger.send('deliver', [e], { from: SWAP, value: ONE }), /CreditWindowShut/);
      await ctx.ledger.send('forfeit', [e], { from: SWAP, value: ONE });
      assert.equal(await ctx.ledger.call('deliveredIn', [e]), 4n * ONE);
      await ctx.ledger.send('draw', [e, BOND, ONE], { from: BOND });
      await assert.rejects(() => ctx.ledger.send('forfeit', [e], { from: SWAP, value: ONE }), /EpochSealed/);
      // With no swap contract behind it, collecting is a no-op and never blocks a distribution.
      await ctx.ledger.send('collectForfeits', [e], { from: ACCOUNTS.mallory });
    });

    test('I34: the carry is written and reduced by the swap alone, monotone, never below zero', async () => {
      const { ledger } = await fixture();
      await assert.rejects(() => ledger.send('carryShortfall', [ONE], { from: ACCOUNTS.mallory }), /OnlySwap/);
      await assert.rejects(() => ledger.send('recoverShortfall', [ONE], { from: BOND }), /OnlySwap/);
      await ledger.send('carryShortfall', [5n * ONE], { from: SWAP });
      await ledger.send('recoverShortfall', [2n * ONE], { from: SWAP });
      assert.equal(await ledger.call('shortfallCarry'), 3n * ONE);
      await ledger.send('recoverShortfall', [9n * ONE], { from: SWAP });
      assert.equal(await ledger.call('shortfallCarry'), 0n, 'repaid, never negative, no interest');
    });
  });
});
