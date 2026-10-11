/**
 * Leg A, to the close: the censorship ground and its recovery on the origin
 * chain (S15, OC-LEGA-01), then a premium claim racing the declaration's
 * close (S12, OC-LEGA-03) — docs/review/audit-2026-10-03/LEG-A/REPORT.md.
 *
 * TERMINAL. The censorship ground settles trigger 2 and the declaration closes
 * the escrow for good: redeploy both legs afterwards. The seed return (S17)
 * needs an escrow neither closed nor under a ground, so it is
 * leg-a-seed-return.js.
 *
 * S15: two equal positions are both claimants of the censorship ground and
 * both paid D_0 by the bond. One instructs a release after the finding (QRL
 * does not refuse it: OC-LEGA-01's QRL half) and is in transit when the
 * bond's recovery share lands on the origin chain (`releaseShare`, successor
 * 0); the share is drawn on the positions still in the book, so the one that
 * stayed bears the whole of it. The spec (fix proposed by the round) has the
 * recovery borne pro rata, so the measured dilution is recorded as
 * OC-LEGA-01.
 *
 * S12: a lot is quoted, selected and locked; the declaration lands between
 * the selection and the lock's root, so the close rides in the same root and
 * is carried in front of any claim. Since the fix of OC-LEGA-03 the escrow
 * still pays a lock sealed no later than the root that carried the close, so
 * the claim pays and the preimage it publishes claims the lot on QRL: the
 * solver pays QRL only for shares it was paid (I33). A lock sealed after the
 * close is refused `SettlementClosed`; its QRL side is the solver's and the
 * relayer's (OC-LEGA-03's other half).
 *
 * Wall-clock: about 17 epochs — on the rehearsal chain (rapid profile,
 * 7-minute epochs) about 2 hours; on hoodi-vps (testnet profile, 70-minute
 * epochs) about 20 hours.
 *
 * What stands in: the court's findings stand unchallenged (the jury is
 * test/ArkStakeCourt.test.js); the Q-Day oracle is the double where the
 * deployment has one, and a stand-in close leaf where it has not.
 */
const { ONE, units } = require('../lib');
const { iface, qrlBuild } = require('../../lib/chains');
const { Solver } = require('../../../ecdsa-stakings/relayer/engine/solver');
const H = require('../helpers/leg-a');

const ZERO32 = '0x' + '00'.repeat(32);
/** The deployer's junior subscription (scripts/lib/deploy.js). */
const HOLDING = 1n;
const lower = (x) => String(x).toLowerCase();

const STATIC_OUT_OF_SCOPE = [
  'a challenged finding: the jury, the appeal and the terminal step (test/ArkStakeCourt.test.js); every finding here stands unchallenged',
  'the ratification of the declaration (the Q-Day oracle is a double, or a stand-in close leaf)',
  'OC-LEGA-01c (every claimant gone before the recovery, ShareExceedsHolding) and OC-LEGA-03b (a recovery draining the pot under a selected lot): their PoCs in docs/review/audit-2026-10-03/LEG-A',
];

module.exports = {
  terminal: true,
  description: 'the censorship ground and its recovery on the origin chain (OC-LEGA-01), then a premium claim racing the declaration\'s close (OC-LEGA-03)',
  outOfScope: [...STATIC_OUT_OF_SCOPE],
  async run(ctx, opts) {
    module.exports.outOfScope = [...STATIC_OUT_OF_SCOPE];
    const a = ctx.asset(opts.asset);
    const q = ctx.r.q;
    const rv = H.relayView(ctx);
    const chainId = ctx.r.chainId;
    const notional = units(opts.notional, 100);
    const windowEpochs = Number(opts.epochs || 6);
    if (!q.ArkStakeCourt) throw new Error('this deployment has no ArkStakeCourt; the censorship ground is a court finding');

    /* ================================================================ S15: the censorship ground */
    await ctx.seedIfNeeded(a);
    const alice = await ctx.anchor(a, notional);
    const bob = await ctx.anchor(a, notional);
    await ctx.waitAnchorRecorded(alice.id);
    await ctx.waitAnchorRecorded(bob.id);
    // An epoch of vesting, so both are owed a part of the draw (whitepaper §5.3).
    await ctx.waitEpochs(1);

    const leafBefore = BigInt(await rv('nextLeaf'));
    const lastBefore = BigInt(await rv('lastEpoch'));
    ctx.note(`withholding every root for ${windowEpochs} epochs, the censorship window (whitepaper §3.6)`);
    await ctx.waitEpochs(windowEpochs, { seal: false });
    const control = async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0];
    ctx.check((await control()).closed === false && (await control()).frozen === false, 'nothing closes or freezes on staleness: censorship is a ground for the court (whitepaper §3.6)');
    ctx.check(BigInt(await rv('nextLeaf')) === leafBefore && BigInt(await rv('lastEpoch')) === lastBefore, 'a withheld root consumes no index and admits nothing (I17)', { leafBefore, lastBefore });

    const { caseId: groundId } = await ctx.assertUnchallenged(2, ctx.encodeQrl(['uint256'], [0n]), 'the censorship ground');
    await ctx.waitFor('the censorship ground settled by the relayer (claimants recorded, D_0 drawn)', async () => {
      const d = await ctx.bond('declaration');
      return Number(d.stage) === 3 && Boolean(d.censorship);
    }, { timeoutEpochs: 3 });
    const t2 = await ctx.bond('declaration');
    ctx.check(BigInt(t2.drawn) > 0n, 'the ground draws D_0 of the full settlement for the claimants (whitepaper §3.6, §5.2)', { ground: String(groundId).slice(0, 18), drawn: t2.drawn, d0: t2.d0 });

    // OC-LEGA-01, QRL half: nothing holds a claimant between the draw and the recovery.
    const aliceDest = '0x' + 'a2'.repeat(20);
    const refusal = await H.outcome(ctx, () => ctx.registry('instructRelease', [alice.id, ctx.r.evmArg(aliceDest)]));
    ctx.knownIssue('OC-LEGA-01', refusal !== null, 'a censorship-ground claimant cannot release before its escrow\'s recovery is applied or lapses (I36, I23)', { claimant: alice.id, refusal });
    if (refusal !== null) {
      ctx.note('the release was refused; the dilution below is not measurable', { refusal });
      return;
    }
    await ctx.registrySend('instructRelease', [alice.id, ctx.r.evmArg(aliceDest)]);
    // OC-LEGA-01, relayer half: the release is sealed, and its presentation
    // withheld until the escrow's recovery is applied and drawn there.
    await ctx.waitFor('the claimant\'s release sealed into an admitted root', async () => Boolean(H.sealedOrNull(ctx, 'release', (x) => x.id === alice.id)), { sealNow: true, timeoutEpochs: 3 });
    await ctx.tick({ sealNow: true });
    const aliceLeaf = H.sealedOrNull(ctx, 'release', (x) => x.id === alice.id).leaf;
    ctx.check((await a.call('transitShares', [alice.id])) === 0n && Boolean((ctx.r.state.data.claimantHold || {})[aliceLeaf]), 'the relayer withholds a censorship-ground claimant\'s sealed release until its escrow\'s recovery is applied (OC-LEGA-01, relayer half)', { hold: (ctx.r.state.data.claimantHold || {})[aliceLeaf] });

    const value = async (id) => a.call('toUnits', [await a.call('transitShares', [id])]);
    const aliceBefore = await a.call('claimOf', [alice.id]);
    const bobBefore = await a.call('claimOf', [bob.id]);

    // The court's realisation of the escrow on the origin chain itself
    // (successor 0, the censorship ground): the book as it stands.
    const [pRem] = await ctx.recovery('recoveryResidual', [chainId, ctx.r.evmArg(a.escrow)]);
    const realised = await a.call('toUnits', [await a.call('positionShares')]);
    const payload = ctx.encodeQrl(['uint256', 'bytes32', 'address', 'uint256', 'uint256'], [chainId, ZERO32, ctx.r.evmArg(a.escrow), realised, alice.notional + bob.notional]);
    const { caseId: recoveryId } = await ctx.assertUnchallenged(4, payload, 'the recovery on the origin chain');
    const r = await ctx.recovery('recoveryOf', [recoveryId]);
    const toBond = BigInt(r.toClass[0]) + BigInt(r.toClass[1]);
    ctx.check(Boolean(r.applied) && toBond === (realised < BigInt(pRem) ? realised : BigInt(pRem)), 'the bond takes min(R, P_rem) of this escrow: at most what it paid the claimants (I36)', { toBond, pRem, realised });

    const holderDest = '0x' + 'bd'.repeat(20);
    const shareFrom = (await ctx.origin.head()).latest;
    if (BigInt(r.toClass[0]) > 0n) await ctx.recoverySend('claimRecovery', [recoveryId, HOLDING, ctx.r.evmArg(holderDest)]);
    const queued = async () => (await H.eventsOf(ctx, a.escrow, a.abi, shareFrom, ['ShareQueued'])).find((x) => lower(x.args.destination) === holderDest);
    await ctx.waitFor('the bond\'s recovery share drawn on the origin chain (releaseShare, successor 0)', async () => Boolean(await queued()), { sealNow: true, timeoutEpochs: 4 });
    const share = H.sealedOrNull(ctx, 'recovery', (x) => lower(x.destination) === holderDest);
    ctx.check(Boolean(share) && share.standIn === null && share.successorId === ZERO32, 'the share was sealed from the bond\'s division, on the origin chain itself (successor 0)', { source: share && share.source });

    // The hold ends once the share is drawn: the claimant leaves after it.
    await ctx.waitFor('the claimant\'s release presented once the recovery is drawn: in transit, out of the book', async () => (await a.call('transitShares', [alice.id])) > 0n, { sealNow: true, timeoutEpochs: 3 });
    const aliceAfter = await value(alice.id);
    const bobAfter = await a.call('claimOf', [bob.id]);
    const aliceLoss = H.lossBps(aliceBefore, aliceAfter);
    const bobLoss = H.lossBps(bobBefore, bobAfter);
    const gap = aliceLoss > bobLoss ? aliceLoss - bobLoss : bobLoss - aliceLoss;
    ctx.knownIssue('OC-LEGA-01', gap <= 1n, 'the recovery of the D_0 draw falls pro rata on every claimant the draw paid: one that left the book first is not undiluted (I36, I23, I21)', {
      recovered: (await queued()).args.quantity,
      released: { before: aliceBefore, after: aliceAfter, lossBps: aliceLoss },
      stayed: { before: bobBefore, after: bobAfter, lossBps: bobLoss },
    });

    /* ================================================================ S12: a claim racing the close */
    const swapAbi = iface('PremiumSwap', qrlBuild(ctx.r.manifest.profile));
    const swapCall = async (m, args = []) => (await ctx.qrl.call(q.PremiumSwap, swapAbi, m, args))[0];
    const solver = new Solver({
      qrl: ctx.qrl,
      origin: ctx.origin,
      swap: q.PremiumSwap,
      swapAbi,
      chainId,
      escrow: { asset: a.asset, escrow: a.escrow, abi: a.abi },
      recipient: '0x' + '5a'.repeat(20),
      relay: ctx.r.relay,
      relayAbi: ctx.r.abi.relay,
      clock: ctx.clock,
      fromBlock: BigInt(ctx.r.manifest.deployedFromBlock || 0),
      log: (m) => ctx.note(m),
    });
    const potFrom = (await ctx.origin.head()).latest;
    if (a.mock) await ctx.produceYield(a, notional / 2n);
    await ctx.waitFor('premium in the pot', async () => (await a.call('auctionShares')) > 0n, { timeoutEpochs: 3 });
    const offered = async () => (await H.eventsOf(ctx, a.escrow, a.abi, potFrom, ['PremiumOffered']))[0];
    await ctx.waitFor('the escrow\'s offer', async () => Boolean(await offered()), { timeoutEpochs: 3 });
    const t = BigInt((await offered()).args.epoch);
    await ctx.waitFor(`the offer of epoch ${t} recorded on QRL`, async () => (await swapCall('offeringOf', [chainId, a.asset, t])).recorded, { timeoutEpochs: 2 });
    await ctx.waitFor(`the quote window of epoch ${t}'s offering`, async () => (await ctx.qrl.head()).timestamp >= ctx.clock.quoteOpens(t), { timeoutEpochs: 3 });
    const avail = await solver.available(t);
    const lot = await solver.quote(t, (avail * 4n) / 10n);

    // The declaration, before the lock's root. Declared once the lot is
    // quoted and before its quote window closes: since OC-SWAP-01 the relayer
    // selects before it scans and seals, so a lock is sealed in the tick that
    // selects it, and a declaration after that tick would close the escrow
    // only at the next root. The close reaches the escrow at or before the
    // lock's root, inside the lock's claim window.
    const oracle = q.MockQDayOracle;
    if (oracle) {
      await ctx.qrl.send(oracle, ctx.r.abi.qday, 'declare', [(await ctx.qrl.head()).timestamp]);
      ctx.note('Q-Day declared on QRL (the oracle is a double); the relayer seals the close leaf at the next root');
    } else {
      ctx.r.enqueue({ kind: 'close', asset: a.asset });
      module.exports.outOfScope.push('S12 declaration: no Q-Day double here, so the close is a stand-in leaf');
    }
    await ctx.waitFor('the lot selected at the close of the quote window', async () => (await solver.status(lot.lotId)) === 'Selected', { timeoutEpochs: 3 });
    await ctx.waitFor('the lock sealed and the escrow closed', async () => Boolean(Solver.lockIn(ctx.r.state.data, lot.lotId)) && (await control()).closed === true, { sealNow: true, timeoutEpochs: 3 });
    const found = Solver.lockIn(ctx.r.state.data, lot.lotId);
    const closedEpoch = BigInt((await control()).closedEpoch);
    ctx.note(`the lock rides the root of epoch ${found.epoch}; the close was carried from the root of ${closedEpoch}`);
    const claimFrom = (await ctx.origin.head()).latest;
    const head = await ctx.origin.head();
    ctx.check(head.timestamp < BigInt(found.item.evmExpiry), 'the lock is still inside its claim window: only the close can refuse it', { now: head.timestamp, evmExpiry: found.item.evmExpiry });
    const lockEpoch = BigInt(found.epoch);
    if (lockEpoch <= closedEpoch) {
      // OC-LEGA-03: sealed no later than the close, so paid for on QRL before the declaration reached the escrow.
      await a.send('claimPremium', solver.claimArgs(lot, found));
    } else {
      await ctx.refuses('a premium claim on a lock sealed after the close (whitepaper §4.7: the pot joins the recovered pool)', 'SettlementClosed', () => a.call('claimPremium', solver.claimArgs(lot, found)));
    }

    // In the race the solver's claim was already broadcast: its preimage is
    // public. Anyone presents it on QRL.
    const third = await ctx.actor('lega-third-party', { fund: ctx.qrl.kind === 'qrl' ? 10n * ONE : 0n });
    const delivered0 = BigInt(await ctx.ledger('deliveredIn', [t]));
    const qrlClaim = await H.outcome(ctx, () => third.send(q.PremiumSwap, swapAbi, 'claim', [lot.lotId, lot.secret]));
    const status = await solver.status(lot.lotId);
    const paid = await ctx.transferredTo(a, solver.recipient, claimFrom);
    const delivered = BigInt(await ctx.ledger('deliveredIn', [t])) - delivered0;
    (lockEpoch <= closedEpoch ? ctx.check.bind(ctx) : ctx.knownIssue.bind(ctx, 'OC-LEGA-03'))(qrlClaim !== null || paid > 0n, 'a lot claimed on QRL with its preimage was paid on the origin chain, the close carried in front of the claim or not: the solver never pays for shares it was not paid (I31, I33)', {
      lockEpoch,
      closedEpoch,
      qrlClaim: qrlClaim === null ? 'succeeded' : qrlClaim,
      status,
      lotValue: lot.value,
      deliveredToLedger: delivered,
      sharesPaidToSolver: paid,
    });
    ctx.check((await control()).closed === true, 'the escrow stays closed: closure is permanent (I15)');
  },
};
