/**
 * A de-listing on QRL reaches the escrow without an operator.
 *
 * The rule under test: the escrow learns that its asset was closed to new
 * anchoring only from a de-listing leaf, and keeps taking deposits until one is
 * consumed — deposits the registry will then refuse to record, which leaves
 * them in a one-way escrow with no record on QRL to release them from. So the
 * relayer turns the registry's `AssetDelisted` into a delist leaf itself, and
 * seals it at the first moment the relay takes a root rather than at the
 * half-way mark (a control leaf).
 *
 * TERMINAL for the asset: its escrow is closed to anchoring for good. Run it
 * on a deployment whose asset is not needed afterwards.
 *
 * What stands in: governance, as the deployer calling `delistAsset` — the
 * four-stage procedure of whitepaper §6.3 is not written. The leaf itself is
 * the registry's, not a stand-in.
 */
const { ONE, units } = require('../lib');

module.exports = {
  terminal: true,
  description: 'governance de-lists an asset on QRL; the escrow closes to new anchoring with no operator involved',
  outOfScope: ['the four-stage admission procedure and its governor (whitepaper §6.3); the deployer votes here'],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 100));
    await ctx.waitAnchorRecorded(anchored.id);

    const key = await ctx.registry('assetKey', [ctx.r.chainId, ctx.r.evmArg(a.asset)]); // 64-byte slot on v3
    await ctx.registrySend('delistAsset', [key]);
    ctx.note('the asset de-listed on QRL by governance (the deployer stands in)');

    // No sealNow and no enqueue: the relayer must find the event and seal it
    // at the next root the relay will take, which is at most one epoch away.
    await ctx.waitFor('the escrow closed to new anchoring', async () => (await a.call('anchoringClosed')) === true, { timeoutEpochs: 2 });
    const leaf = ctx.sealed('delist', (x) => x.asset === a.asset);
    ctx.check(leaf.standIn === null && /AssetDelisted/.test(leaf.source || ''), 'the delist leaf came from the registry event, not from an operator', { source: leaf.source });
    await ctx.refuses('an anchor into an escrow whose asset was de-listed on QRL', 'AnchoringIsClosed', () => a.call('anchor', [ctx.qrl.address, ONE]));

    // De-listing closes the inflow and touches nothing already anchored.
    const recipient = '0x' + '99'.repeat(20);
    await ctx.registrySend('instructRelease', [anchored.id, ctx.r.evmArg(recipient)]);
    await ctx.waitFor('a position anchored before the de-listing released', async () => (await a.token.call('balanceOf', [recipient])) > 0n, { timeoutEpochs: 8 });
    ctx.check(true, 'a de-listing releases nothing and confiscates nothing: the position leaves by its own release', { recipient });
  },
};
