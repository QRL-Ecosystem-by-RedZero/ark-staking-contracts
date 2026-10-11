/**
 * A trigger-1 determination settled through the waterfall, end to end: the
 * buffer's part reaches the escrow as a loss settlement, the bond's part is a
 * settlement entitlement paid in QRL.
 *
 * Since phase C4 the finding — which position lost how much — is a bonded
 * assertion to the product's court (`ArkStakeCourt`, whitepaper §6.2), heard
 * on its optimistic path: nobody challenges it, and it stands when its
 * challenge window closes. The jury, the appeal and the terminal step are
 * `test/ArkStakeCourt.test.js`'s. Everything after the finding is the
 * contracts' own (phase C3): the vesting factor, the one haircut, the buffer
 * first, the draw on bond principal junior first, the loss leaf the bound
 * beneficiary names a destination for, and its payment by the escrow.
 */
const { ONE, units } = require('../lib');

module.exports = {
  description: 'a determination through the waterfall: the buffer pays first on the origin chain, the bond the rest in QRL; a leaf sealed twice pays once',
  outOfScope: [
    'a challenged determination: the jury, the appeal and the terminal step (whitepaper §6.2, §6.6) — the unit suite\'s, test/ArkStakeCourt.test.js; here the assertion stands unchallenged',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const notional = units(opts.notional, 100);

    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, notional);
    await ctx.waitAnchorRecorded(anchored.id);

    // The buffer the determination is measured against is the one the escrow
    // reported to QRL (gap item 22's channel). Yield fills it at the buffer
    // share of every sweep, and the relayer reports and records it.
    await ctx.produceYield(a, notional / 2n);
    const key = await ctx.registry('assetKey', [ctx.r.chainId, ctx.r.evmArg(a.asset)]);
    await ctx.waitFor('the escrow\'s buffer recorded on QRL', async () => (await ctx.registry('bufferOf', [key])) > 0n, { sealNow: true });

    // Cover vests over ninety days of the profile's clock (whitepaper §5.3);
    // waiting it out makes the settlement the whole indemnity.
    await ctx.waitEpochs(Number(opts.vestEpochs || 14));
    const vesting = await ctx.registry('vestingBpsOf', [anchored.id]);
    ctx.check(vesting === 10000n, 'past the vesting window the factor is whole (whitepaper §5.3)', { vesting });

    const loss = BigInt(opts.loss || 40) * ONE;
    const bufferBefore = { escrow: await a.call('bufferShares'), qrl: await ctx.registry('bufferOf', [key]) };
    const positions = await a.call('positionShares');
    // The court: a bonded assertion of the loss, unchallenged, standing at the
    // close of its challenge window; the case id is the determination id.
    const payload = ctx.encodeQrl(['bytes32[]', 'uint256[]'], [[anchored.id], [loss]]);
    const { caseId: determinationId, value } = await ctx.assertUnchallenged(1, payload, 'the loss');
    const c = await ctx.court('caseOf', [determinationId]);
    ctx.check(Number(c.stage) === 5 && Number(c.outcome) === 1, 'the court\'s finding stands: the case is final, upheld (whitepaper §6.2)', { stage: c.stage, outcome: c.outcome });
    ctx.check(BigInt(c.seat) > 0n && value > 0n, 'the claim was valued and bounded at its opening (I24′): V and the seat fixed for the case', { value, seat: c.seat });
    const part = await ctx.bond('lossPartOf', [determinationId, anchored.id]);
    const buffered = BigInt(part.bufferUnits);
    const drawn = BigInt(part.qrl);
    ctx.note(`determined: ${buffered} units from the buffer, ${drawn} QRL from bond principal`);
    ctx.check(buffered > 0n, 'the buffer pays first under trigger 1 (whitepaper §5.2)', { buffered, bufferRecorded: bufferBefore.qrl });
    ctx.check(buffered <= bufferBefore.qrl, 'the buffer\'s part is no more than the buffer the escrow reported (I11)', { buffered, reported: bufferBefore.qrl });

    // The bound beneficiary (the QRL account the position named) says where the
    // buffer's part is paid, and the bond seals the loss leaf; the relayer
    // carries it like any return leaf. No stand-in leaf is enqueued here.
    const destination = '0x' + '33'.repeat(20);
    await ctx.bondSend('nameLossDestination', [determinationId, anchored.id, ctx.r.evmArg(destination)]);
    await ctx.waitFor('the loss settlement paid to the beneficiary\'s destination', async () => (await a.token.call('balanceOf', [destination])) >= buffered - 2n, { sealNow: true });
    const item = ctx.sealed('loss');
    ctx.check(item.standIn === null, 'the loss leaf was sealed from the bond\'s own settlement, not injected', { source: item.source });
    ctx.check((await a.call('positionShares')) >= positions, 'a loss settlement takes nothing from the anchored positions', { before: positions, after: await a.call('positionShares') });

    if (drawn > 0n) {
      await ctx.waitEpochs(1);
      await ctx.bondSend('claimSettlement', [determinationId, anchored.id]);
      const paid = await ctx.bond('settlementPaidTo', [determinationId, anchored.id]);
      ctx.check(paid === drawn, 'the bond\'s part is paid in QRL to the bound beneficiary, as the entitlement recorded (yellow paper §1.4)', { paid, drawn });
    }

    await ctx.refuses('a loss settlement restating its quantity', 'BadProof', () =>
      a.call('settleLoss', [determinationId, anchored.id, destination, buffered * 2n, item.epoch, ctx.proof(item.epoch, item.leaf)]),
    );

    // The same leaf in a later root. The escrow consumes the leaf itself
    // rather than the (epoch, leaf) pair a release is keyed by, so a
    // determination sealed again pays once (CLAUDE.md §7.2).
    ctx.r.enqueue({ kind: 'loss', stakeAssetId: anchored.id, asset: a.asset, destination, quantity: buffered, determinationId, standIn: null }, { reseal: true });
    await ctx.waitFor('the same determination sealed into a second root', async () => ctx.epochsCarrying(item.leaf).length > 1, { sealNow: true, timeoutEpochs: 4 });
    const again = ctx.epochsCarrying(item.leaf).sort((x, y) => (x < y ? 1 : -1))[0];
    await ctx.refuses('a determination presented from a second root it was sealed into', 'ProofSpent', () =>
      a.call('settleLoss', [determinationId, anchored.id, destination, buffered, again, ctx.proof(again, item.leaf)]),
    );
  },
};
