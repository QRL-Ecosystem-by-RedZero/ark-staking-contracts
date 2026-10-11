/**
 * The protective freeze: what it stops, what it does not, and that an old
 * freeze leaf cannot be replayed over a later lift.
 *
 * What stands in: the Q-Day oracle's protective freeze — here a sealed freeze
 * leaf, which is what the declaration procedure would produce.
 */
const { ONE, units } = require('../lib');

module.exports = {
  description: 'a freeze stops a release and not a determined settlement; freeze leaves are ordered by epoch',
  outOfScope: ['the oracle and its quorum: the freeze arrives here as a sealed leaf (whitepaper §3.5)'],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 100));
    await ctx.waitAnchorRecorded(anchored.id);
    await ctx.produceYield(a, 40n * ONE);
    await ctx.waitFor('a sweep filling the buffer', async () => (await a.call('bufferShares')) > ONE, { sealNow: true });

    /* ------------------------------------------------------------ instruct, then freeze */
    const recipient = '0x' + '44'.repeat(20);
    await ctx.registrySend('instructRelease', [anchored.id, ctx.r.evmArg(recipient)]);
    ctx.note('a release instruction is recorded during the freeze; only its settlement waits (yellow paper §1.4)');
    await ctx.waitFor('the release instruction sealed', async () => {
      try {
        ctx.sealed('release');
        return true;
      } catch {
        return false;
      }
    }, { sealNow: true });
    const release = ctx.sealed('release');

    ctx.r.enqueue({ kind: 'freeze', frozen: true });
    await ctx.waitFor('the freeze in force on the origin chain', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].frozen === true, { sealNow: true });
    const frozenAt = ctx.sealed('freeze', (x) => x.frozen === true && x.escrow === a.escrow).epoch;

    /* ------------------------------------------------------------ what it stops */
    await ctx.waitFor('the release leaf past its unbonding', async () => (await ctx.originEpoch()) >= release.epoch + 4n, { timeoutEpochs: 6 });
    await ctx.refuses('a release settled while the escrow is frozen', 'ReleaseFrozen', () =>
      a.call('release', [release.id, release.recipient, release.claimNonce, release.epoch, ctx.proof(release.epoch, release.leaf)]),
    );

    /* ------------------------------------------------------------ what it does not */
    const destination = '0x' + '55'.repeat(20);
    const quantity = ONE;
    ctx.r.enqueue({ kind: 'loss', stakeAssetId: anchored.id, asset: a.asset, destination, quantity });
    // A rebasing asset loses a wei or two to share rounding on every transfer,
    // as stETH does (loss.js allows the same); an exact match never arrives on
    // mREB or stETH (OC-OPS-03: the rehearsal FAIL of 2026-09-22).
    await ctx.waitFor('a determined loss settlement paid through the freeze', async () => (await a.token.call('balanceOf', [destination])) >= quantity - 2n, { sealNow: true, timeoutEpochs: 4 });
    ctx.check(true, 'a determined settlement is not reduced and pays through a freeze (whitepaper §4.7)', { quantity });

    /* ------------------------------------------------------------ the lift, and the replay */
    ctx.r.enqueue({ kind: 'freeze', frozen: false });
    await ctx.waitFor('the freeze lifted', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].frozen === false, { sealNow: true, timeoutEpochs: 4 });
    await ctx.refuses('an old freeze leaf replayed over a later lift', 'FreezeNotForward', () =>
      ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'setFrozen', [a.escrow, true, frozenAt, ctx.proof(frozenAt, ctx.sealed('freeze', (x) => x.frozen === true && x.escrow === a.escrow).leaf)]),
    );

    await ctx.waitFor('the release settled once the freeze was lifted', async () => (await a.token.call('balanceOf', [recipient])) > 0n, { timeoutEpochs: 6 });
    ctx.check(true, 'a leaf refused during the freeze stays usable afterwards: the freeze holds settlement, it does not consume the leaf', { recipient });
  },
};
