/**
 * The declaration: both directions close, the bond settles trigger 2
 * progressively, and the recovery of whitepaper §5.4 is carried by roots
 * sealed afterwards, by subrogation.
 *
 * TERMINAL. Closure is permanent, so this scenario ends the life of the
 * deployment it runs against: run it last, and redeploy both legs afterwards.
 *
 * What stands in: the Q-Day oracle and its ratification (a double where no
 * governance record names contracts/core's). The court's finding that opens
 * the recovery — the escrow realised on an admitted successor — is a bonded
 * assertion to `ArkStakeCourt` since phase C4, standing unchallenged. The
 * trigger-2 settlement, the entitlements, the admission of the successor and
 * the division of the recovery are the contracts' own (phase C3). Since phase
 * C3b the settlement opens on the claimant record — every position recorded
 * as of the ratification, at its vesting then — and the recovery is kept per
 * escrow (`ArkCatBondRecovery`).
 */
const { sha256 } = require('ethers');
const { ONE, units } = require('../lib');

const T2_FLOOR = require('ethers').keccak256(require('ethers').toUtf8Bytes('ARK_T2_FLOOR'));

module.exports = {
  description: 'the declaration closes anchoring and release; the bond draws D_0 and settles the severity; a successor is admitted and the recovery is divided by subrogation',
  terminal: true,
  outOfScope: [
    'the ratification of the declaration (the Q-Day oracle here is a double)',
    'a challenged recovery finding: the jury (test/ArkStakeCourt.test.js); here the assertion stands unchallenged',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 100));
    await ctx.waitAnchorRecorded(anchored.id);
    // An epoch of vesting before the ratification, so the position is owed a
    // part of the draw (whitepaper §5.3: its vesting factor at the ratification).
    await ctx.waitEpochs(1);

    /* ------------------------------------------------------------ the declaration */
    const qdayAbi = ctx.r.abi.qday;
    // Ratified at the QRL chain's own time, as the real oracle's block is: the
    // wall clock is not the harness's, and T now also names the epoch whose
    // forward root the settlement waits for (G6).
    await ctx.qrl.send(ctx.r.q.MockQDayOracle, qdayAbi, 'declare', [(await ctx.qrl.head()).timestamp]);
    ctx.note('Q-Day declared on QRL (the oracle is a double)');
    await ctx.refuses('a release instructed after the declaration', 'ReleaseClosed', () =>
      ctx.registry('instructRelease', [anchored.id, ctx.r.evmArg(ctx.origin.address)]),
    );

    /* ------------------------------------------------------------ trigger 2 */
    // The bond's own settlement (whitepaper §4.6, §5.2): D_0 of the pool at the
    // ratification, junior first, anyone calling it.
    const HOLDING = 1n; // the deployer's junior subscription (scripts/lib/deploy.js)
    await ctx.refuses('bond principal leaving before the trigger-2 settlement has drawn', 'DeclaredPendingSettlement', () =>
      ctx.bondCall('redeem', [HOLDING]),
    );
    // The claimant record (whitepaper §5.2): every position still anchored,
    // recorded as of the ratification, before the settlement opens.
    const live = [];
    for (const id of Object.keys(ctx.r.state.data.anchors)) {
      if (Number((await ctx.registry('anchorOf', [id])).status) === 1) live.push(id);
    }
    await ctx.refuses('the settlement opened before its claimants are recorded', 'ClaimantsIncomplete', () =>
      ctx.qrl.call(ctx.r.q.ArkCatBond, ctx.r.abi.bond, 'settleDeclaration', []),
    );
    await ctx.recoverySend('recordClaimants', [live]);
    // A declaration's settlement waits for every anchor of the forward root
    // of the epoch before the ratification's, counted by that root's own
    // count leaf (whitepaper §5.2; audit 2026-09-22, G6; audit 2026-09-29,
    // QL-05, QL-06). The relayer seals that root, with its count, once the
    // epoch is scanned, records its anchors, proves the count and, as
    // trigger 2's keeper, opens the settlement.
    const declaredAt = BigInt((await ctx.qrl.call(ctx.r.q.MockQDayOracle, qdayAbi, 'declaredAt', []))[0]);
    const prior = ctx.clock.epochOf(declaredAt) - 1n;
    await ctx.waitFor(`the settlement opened by the relayer, once the anchors of epoch ${prior} are on QRL`, async () => Number((await ctx.bond('declaration')).stage) !== 0, { timeoutEpochs: 3 });
    const t2 = await ctx.bond('declaration');
    ctx.check(BigInt(t2.drawn) === (BigInt(t2.fullSettlement) * BigInt(t2.d0)) / 10000n && BigInt(t2.fullSettlement) <= BigInt(t2.pool), 'the floor draw is D_0 of the full settlement, the vested obligation bounded by the pool (whitepaper §5.2, papers sync 5)', { drawn: t2.drawn, full: t2.fullSettlement, pool: t2.pool, d0: t2.d0 });

    // Nobody enqueues the closure: the relayer reads the declaration from the
    // oracle and seals the close leaf at the next root the relay will take.
    await ctx.waitFor('the escrow closed on the origin chain', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].closed === true, { timeoutEpochs: 2 });
    ctx.check(/MockQDayOracle/.test(ctx.sealed('close').standIn || ''), 'the close leaf was read from the declaration on QRL, and is labelled as a stand-in for the declaration procedure', { standIn: ctx.sealed('close').standIn });
    await ctx.refuses('an anchor into a closed escrow', 'ReleaseClosed', () => a.call('anchor', [ctx.qrl.address, ONE]));
    const nowEpoch = await ctx.originEpoch();
    // Since OC-LEGA-03 a lock sealed in a root at or before the close is still
    // paid; only a root after the close is refused. The preimage is checked
    // first, so the claim carries a matching one.
    const closedEpoch = BigInt((await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].closedEpoch);
    const secret = '0x' + '03'.repeat(32);
    await ctx.refuses('a premium lot sealed after closure, claimed', 'SettlementClosed', () =>
      a.call('claimPremium', [['0x' + '01'.repeat(32), sha256(secret), ctx.origin.address, ONE, ctx.clock.startOf(nowEpoch + 3n), closedEpoch + 1n, 0n], closedEpoch + 1n, [], secret]),
    );
    await ctx.refuses('a premium offered after closure', 'SettlementClosed', () => a.call('offerPremium'));

    // The position's share of the floor draw, in QRL, from the epoch after.
    await ctx.waitEpochs(1);
    await ctx.bondSend('claimSettlement', [T2_FLOOR, anchored.id]);
    ctx.check((await ctx.bond('settlementPaidTo', [T2_FLOOR, anchored.id])) > 0n, 'every claimant is paid its entitlement to the draw on its vested weight at the ratification, in QRL (whitepaper §5.2)');

    // The assessment window closes; the series reads no decline, so the
    // severity is the floor and the balance is released (max(D_0, S) = D_0).
    // Nobody calls it by hand: the relayer, as trigger 2's keeper, settles the
    // severity at the close of the window (item 79).
    await ctx.waitFor('the relayer to settle the severity at the close of the window', async () => Number((await ctx.bond('declaration')).stage) === 3, { timeoutEpochs: Number(t2.windowEpochs) + 3 });
    const after = await ctx.bond('declaration');
    ctx.check(Number(after.stage) === 3 && BigInt(after.drawn) === BigInt(t2.drawn), 'the balance the severity does not reach is released back to its class (whitepaper §4.6)', { stage: after.stage, drawn: after.drawn });
    await ctx.refuses('after the settlement the block on exits is lifted: a holding before maturity is refused as such', 'NotMatured', () =>
      ctx.bondCall('redeem', [HOLDING]),
    );

    /* ------------------------------------------------------------ recovery */
    // Root admission continues after closure: the recovery of whitepaper §5.4
    // is carried by roots sealed after the settlement, on an admitted successor.
    const successorId = '0x' + 'a1'.repeat(32);
    await ctx.paramsSend('admitSuccessor', [ctx.r.chainId, successorId]);
    const [pRem] = await ctx.recovery('recoveryResidual', [ctx.r.chainId, ctx.r.evmArg(a.escrow)]);
    const held = await a.call('sharesHeld');
    const realised = await a.call('toUnits', [held]);
    const payload = ctx.encodeQrl(['uint256', 'bytes32', 'address', 'uint256', 'uint256'], [ctx.r.chainId, successorId, ctx.r.evmArg(a.escrow), realised / 2n, anchored.notional]);
    const { caseId: recoveryId, value } = await ctx.assertUnchallenged(4, payload, 'the recovery');
    // Since OC-COURT-05 a recovery is heard at the escrow's residual P_rem, in
    // QRL at the declaration's price, rounded up: a false R moves up to P_rem
    // of the bond's subrogation whichever way it errs.
    const price = BigInt(t2.price);
    const expectedV = (BigInt(pRem) * price + 10n ** 18n - 1n) / 10n ** 18n;
    ctx.check(value === expectedV, "a recovery is valued at the escrow's residual P_rem at the declaration's price, and seated by it (I24′, OC-COURT-05)", { value, pRem, price });
    const r = await ctx.recovery('recoveryOf', [recoveryId]);
    const toBond = BigInt(r.toClass[0]) + BigInt(r.toClass[1]);
    ctx.check(r.applied === true && toBond === (realised / 2n < pRem ? realised / 2n : pRem), 'the bond takes min(R, P_rem) of this escrow: at most what it paid its positions (I36)', { toBond, pRem, realised: realised / 2n });

    const leafBefore = (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'nextLeaf'))[0];
    const holderDest = '0x' + '66'.repeat(20);
    const positionDest = '0x' + '67'.repeat(20);
    if (BigInt(r.toClass[0]) > 0n) await ctx.recoverySend('claimRecovery', [recoveryId, HOLDING, ctx.r.evmArg(holderDest)]);
    await ctx.recoverySend('claimPositionRecovery', [recoveryId, anchored.id, ctx.r.evmArg(positionDest)]);
    await ctx.waitFor('the position\'s recovery share paid on the successor', async () => (await a.token.call('balanceOf', [positionDest])) > 0n, { sealNow: true, timeoutEpochs: 4 });
    const share = ctx.sealed('recovery', (x) => x.destination === positionDest);
    ctx.check(share.standIn === null && share.successorId === successorId, 'the recovery leaf was sealed from the bond\'s division and binds the successor it is paid on (I36)', { source: share.source, successorId: share.successorId });
    if (BigInt(r.toClass[0]) > 0n) {
      await ctx.waitFor('the bond holder\'s recovery share paid', async () => (await a.token.call('balanceOf', [holderDest])) > 0n, { sealNow: true, timeoutEpochs: 4 });
    }
    const leafAfter = (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'nextLeaf'))[0];
    ctx.check(leafAfter > leafBefore, 'root admission continues after closure, because the recovery is carried by later roots (whitepaper §5.4)', { leafBefore, leafAfter });

    // Bounded by the holding outside the buffer and outside what the queue
    // already owes, so one recipient is never paid out of another's settlement.
    // A stand-in leaf on purpose: this is the escrow's bound, not QRL's arithmetic.
    const holding = await a.call('sharesHeld');
    ctx.r.enqueue({ kind: 'recovery', asset: a.asset, destination: positionDest, quantity: holding * 2n, hold: true });
    await ctx.waitFor('an oversized recovery share sealed but not presented', async () => {
      try {
        ctx.sealed('recovery', (x) => x.quantity === holding * 2n);
        return true;
      } catch {
        return false;
      }
    }, { sealNow: true, timeoutEpochs: 3 });
    const big = ctx.sealed('recovery', (x) => x.quantity === holding * 2n);
    await ctx.refuses('a recovery share above the recoverable holding', 'ShareExceedsHolding', () =>
      a.call('releaseShare', [big.successorId, big.recoveryId, big.recipient, big.destination, big.quantity, big.epoch, ctx.proof(big.epoch, big.leaf)]),
    );
  },
};
