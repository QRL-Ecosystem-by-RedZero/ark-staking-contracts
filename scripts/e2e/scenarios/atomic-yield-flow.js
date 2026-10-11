/**
 * The premium, from yield to coupon, with no hand anywhere in the path
 * (whitepaper §4.7): the escrow's yield is swept into the premium pot and
 * offered to QRL; solvers quote lots in the quote window; the lots are
 * selected by price at its close and sealed as premium locks; a solver takes
 * its lot on the origin chain against its preimage, which carries the lot's QRL
 * to the delivered-proceeds account; and the coupon of the epoch is paid from
 * it once the settlement window closes — while every principal pot is left
 * untouched.
 *
 * Nothing stands in for the sale. What stands in is what every scenario has:
 * the attester quorum behind the forward roots (MockAttestation) and the
 * valuation oracle the reserve is read from (MockPriceOracle). On the local
 * chain the yield itself is a double's rebase or mint; on Hoodi it is Lido's.
 *
 * Four lots are quoted: one the solver takes, one at a higher price it also
 * takes, one selected and never taken — refunded to its solver at the QRL
 * expiry — and one that does not fit, refunded at once.
 */
const { ONE, units } = require('../lib');
const { iface, qrlBuild } = require('../../lib/chains');
const { Solver } = require('../../../ecdsa-stakings/relayer/engine/solver');

module.exports = {
  description: 'yield to the premium pot, offered, quoted, selected by price, claimed against the preimage, credited to the ledger, paid as coupon; principal untouched',
  outOfScope: [
    'a coupon reaching a holding: the deployment\'s subscription is inside its thirty-day cliff, so the epoch\'s coupon is carried forward (test/ArkCatBond.test.js covers the payment)',
    'the reserve ladder over failed offerings and retention (test/PremiumSwap.test.js)',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const q = ctx.r.q;
    if (!q.PremiumSwap) throw new Error('this QRL leg has no PremiumSwap; redeploy it');
    const build = qrlBuild(ctx.r.manifest.profile);
    const swapAbi = iface('PremiumSwap', build);
    const bondAbi = iface('ArkCatBond', build);
    const swapCall = async (m, args = []) => (await ctx.qrl.call(q.PremiumSwap, swapAbi, m, args))[0];
    const chainId = ctx.r.chainId;
    const escrow = { asset: a.asset, escrow: a.escrow, abi: a.abi };
    // Each solver finds its lock on the origin chain as well, among the leaves
    // the relay published (D15); the relayer's state is only a cache.
    const onChain = { relay: ctx.r.relay, relayAbi: ctx.r.abi.relay, clock: ctx.clock, fromBlock: BigInt(ctx.r.manifest.deployedFromBlock || 0) };
    const solverFor = (recipient) => new Solver({ qrl: ctx.qrl, origin: ctx.origin, swap: q.PremiumSwap, swapAbi, chainId, escrow, recipient, ...onChain, log: (m) => ctx.note(m) });
    const solver = solverFor('0x' + '5a'.repeat(20));
    const rival = solverFor('0x' + '5b'.repeat(20));
    const idle = solverFor('0x' + '5c'.repeat(20));
    const late = solverFor('0x' + '5d'.repeat(20));
    const qrlNow = async () => (await ctx.qrl.head()).timestamp;

    /* ------------------------------------------------------------ yield into the pot */
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 1000));
    await ctx.waitAnchorRecorded(anchored.id);
    const epoch0 = await ctx.originEpoch();
    await ctx.waitFor(`the allocation of epoch ${epoch0} recorded in the escrow`, async () => BigInt((await a.call('recordedAllocation')).epoch) >= epoch0, { sealNow: true });
    const fromBlock = (await ctx.origin.head()).latest;
    await ctx.produceYield(a, 40n * ONE);
    await ctx.waitFor('the yield swept into the premium pot', async () => (await a.call('auctionShares')) > 0n);

    const principal = {
      bond: (await ctx.qrl.call(q.ArkCatBond, bondAbi, 'outstandingPrincipal'))[0],
      anchor: (await ctx.registry('anchorOf', [anchored.id])).anchoredNotional,
    };

    /* ------------------------------------------------------------ the offer */
    const offeredYet = async () => {
      try {
        return await ctx.lastEvent(a, 'PremiumOffered', fromBlock);
      } catch {
        return null;
      }
    };
    await ctx.waitFor('the escrow offered its premium once the earlier lots could no longer be paid', async () => Boolean(await offeredYet()));
    const offered = await offeredYet();
    const t = BigInt(offered.epoch);
    await ctx.waitFor(`the offer of epoch ${t} recorded on QRL`, async () => (await swapCall('offeringOf', [chainId, ctx.r.evmArg(a.asset), t])).recorded);
    ctx.check(BigInt((await swapCall('offeringOf', [chainId, ctx.r.evmArg(a.asset), t])).offered) === BigInt(offered.shares), 'the premium the escrow holds reaches QRL as an attested offer, in shares', { shares: offered.shares, units: offered.units });

    /* ------------------------------------------------------------ the quote window */
    const opens = ctx.clock.quoteOpens(t);
    if ((await qrlNow()) < opens) {
      await ctx.refuses('a quote before the quote window', 'OutsideQuoteWindow', () =>
        ctx.qrl.call(q.PremiumSwap, swapAbi, 'quote', [chainId, ctx.r.evmArg(a.asset), t, 1n, '0x' + '01'.repeat(32), ctx.r.evmArg(solver.recipient), 10n ** 24n], { value: 2n * 10n ** 24n }),
      );
    }
    await ctx.waitFor(`the quote window of epoch ${t}'s offering`, async () => (await qrlNow()) >= opens);
    const avail = await solver.available(t);
    const r1 = await solver.required(t, ONE);
    const overPrice = await solver.required(t, avail + 1n);
    // Any price is accepted since 2026-09-30 (whitepaper §4.7): the reserve
    // binds at the selection, at the reading the last in-window quote took.
    const below = await ctx.qrl
      .call(q.PremiumSwap, swapAbi, 'quote', [chainId, ctx.r.evmArg(a.asset), t, avail / 4n, '0x' + '02'.repeat(32), ctx.r.evmArg(solver.recipient), 1n], { value: 1n })
      .then(() => true, () => false);
    ctx.check(below, 'a quote below the reserve is accepted; the selection passes it over');
    await ctx.refuses('a lot above what the offer may sell', 'ExceedsOffer', () =>
      ctx.qrl.call(q.PremiumSwap, swapAbi, 'quote', [chainId, ctx.r.evmArg(a.asset), t, avail + 1n, '0x' + '03'.repeat(32), ctx.r.evmArg(solver.recipient), overPrice], { value: 2n * overPrice }),
    );
    const lotA = await solver.quote(t, (avail * 4n) / 10n);
    const sharesB = (avail * 3n) / 10n;
    const lotB = await rival.quote(t, sharesB, { value: (sharesB * r1 * 12n) / (10n * ONE) + 1n });
    const lotC = await idle.quote(t, (avail * 3n) / 10n);
    const lotD = await late.quote(t, avail / 2n);

    /* ------------------------------------------------------------ selection */
    await ctx.waitFor('the lots selected at the close of the quote window', async () => (await swapCall('offeringOf', [chainId, ctx.r.evmArg(a.asset), t])).selected);
    const st = async (lot) => solver.status(lot.lotId);
    ctx.check((await st(lotA)) === 'Selected' && (await st(lotB)) === 'Selected' && (await st(lotC)) === 'Selected', 'lots are taken whole, highest price first, down to the reserve and up to the quantity offered');
    ctx.check((await st(lotD)) !== 'Selected', 'a lot that does not fit what is left is passed over');
    await ctx.waitFor('the lot passed over refunded to its solver at once', async () => (await st(lotD)) === 'Refunded');

    /* ------------------------------------------------------------ the claim reveals the secret */
    await ctx.waitFor('the premium locks sealed into an admitted root', async () => Boolean(Solver.lockIn(ctx.r.state.data, lotA.lotId)) && Boolean(Solver.lockIn(ctx.r.state.data, lotB.lotId)), { sealNow: true });
    ctx.check(Solver.lockIn(ctx.r.state.data, lotA.lotId).item.standIn === null, 'the premium lock came from PremiumSwap, not from a stand-in');
    const claimFrom = (await ctx.origin.head()).latest;
    const worth = await a.call('toUnits', [lotA.shares]);
    // The juror fraction of each lot funds the court's fee pool (whitepaper
    // §6.2; phase C3b), in the proportion the offering fixed when recorded.
    const jurorBps = BigInt((await swapCall('offeringOf', [chainId, ctx.r.evmArg(a.asset), t])).jurorBps);
    const feePool = async () => (q.ArkStakeCourt ? (await ctx.qrl.call(q.ArkStakeCourt, ctx.courtAbi, 'feePool'))[0] : 0n);
    const fee = (v) => (q.ArkStakeCourt ? (v * jurorBps) / 10000n : 0n);
    const poolBefore = await feePool();
    await solver.claim(lotA, ctx.r.state.data);
    // The rival holds no copy of any relayer's state: its lock and proof come
    // from the leaves the relay published on the origin chain (D15).
    const published = await rival.lockOnChain(lotB.lotId);
    ctx.check(Boolean(published) && published.item.leaf === Solver.lockIn(ctx.r.state.data, lotB.lotId).item.leaf, 'a premium lock and its proof are recoverable from origin-chain state alone: the relay published the ordered leaves of the root (whitepaper §3.6, D15)');
    await rival.claim(lotB, { roots: {} });
    ctx.check((await ctx.transferredTo(a, ctx.r.evmArg(solver.recipient), claimFrom)) + 2n >= worth, 'the solver is paid its lot, in the shares it quoted', { shares: lotA.shares, worth });
    const lockA = Solver.lockIn(ctx.r.state.data, lotA.lotId);
    await ctx.refuses('the same lot claimed twice', 'ProofSpent', () =>
      a.call('claimPremium', [[lotA.lotId, lotA.hashlock, lockA.item.recipient, lockA.item.shares, lockA.item.evmExpiry, lockA.item.offeredEpoch, lockA.item.bond], lockA.epoch, lockA.proof, lotA.secret]),
    );

    await ctx.waitFor('the relayer carried the revealed preimages to QRL', async () => (await st(lotA)) === 'Claimed' && (await st(lotB)) === 'Claimed');
    const premiumPart = lotA.value + lotB.value - fee(lotA.value) - fee(lotB.value);
    ctx.check((await ctx.ledger('deliveredIn', [t])) === premiumPart, 'the QRL of the claimed lots, less their juror fraction, reaches the delivered proceeds of the epoch whose premium they bought, and nothing else does (whitepaper §4.7)', { t, jurorBps });
    ctx.check((await feePool()) - poolBefore === fee(lotA.value) + fee(lotB.value), 'the juror fraction of each lot funds the court\'s fee pool (whitepaper §6.2)', { jurorBps });

    /* ------------------------------------------------------------ the lot never taken */
    await ctx.waitFor('the selected lot never claimed refunded to its solver at its QRL expiry', async () => (await st(lotC)) === 'Refunded', { timeoutEpochs: 4 });
    ctx.check(lotC.bond > 0n && (await swapCall('lotOf', [lotC.lotId])).bond === lotC.bond, 'its QRL went back and its commitment bond did not (I33)', { bond: lotC.bond });

    /* ------------------------------------------------------------ the coupon */
    await ctx.waitFor(`the coupon of epoch ${t} distributed once its settlement window closed`, async () => BigInt(await ctx.coupon('lastDistributed')) >= t);
    ctx.check((await ctx.ledger('deliveredIn', [t])) === premiumPart + lotC.bond, 'the proceeds of the epoch are the claimed lots\' premium part and the bond forfeited against its offering, and nothing else (whitepaper §4.7, I33)', { t });
    ctx.check((await ctx.ledger('remainingIn', [t])) === 0n, 'the coupon is paid from the swap\'s proceeds for its epoch and from no other account');

    /* ------------------------------------------------------------ principal untouched */
    ctx.check((await ctx.qrl.call(q.ArkCatBond, bondAbi, 'outstandingPrincipal'))[0] === principal.bond, 'bond principal is untouched by the sale of the premium (I8)', principal);
    ctx.check((await ctx.registry('anchorOf', [anchored.id])).anchoredNotional === principal.anchor, 'the anchored notional is untouched');
    await ctx.waitFor('the bonds of the claimed lots returned to their solvers', async () => (await ctx.qrl.balance(q.PremiumSwap)) === 0n);
    ctx.check((await ctx.qrl.balance(q.PremiumSwap)) === 0n, 'the swap holds nothing once every lot is claimed or refunded and every bond returned or forfeited');
  },
};
