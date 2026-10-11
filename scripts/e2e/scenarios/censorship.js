/**
 * Six epochs with no root carried.
 *
 * The rule under test is a removal: nothing closes on staleness any more. A
 * permissionless staleness latch would turn censorship — which an adversary can
 * always buy — into permanent immobility, so non-admission for the censorship
 * window is a ground put to the court and nothing else (whitepaper §3.6).
 */
const { ONE, units } = require('../lib');

module.exports = {
  description: 'the censorship window passes: nothing closes, no leaf is consumed, and the relay resumes',
  outOfScope: ['the court that hears the censorship ground, and the settlement it would order (whitepaper §6.2)'],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const windowEpochs = Number(opts.epochs || 6);
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 100));
    await ctx.waitAnchorRecorded(anchored.id);

    const recipient = '0x' + '77'.repeat(20);
    await ctx.registrySend('instructRelease', [anchored.id, ctx.r.evmArg(recipient)]);
    const rv = async (m) => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, m))[0];
    const leafBefore = await rv('nextLeaf');
    const lastEpochBefore = await rv('lastEpoch');
    ctx.note(`withholding every root for ${windowEpochs} epochs, the censorship window`, { leafBefore, lastEpochBefore });

    // `seal: false` is the censorship: the relayer keeps scanning and keeps the
    // forward path running, and carries no root back.
    await ctx.waitEpochs(windowEpochs, { seal: false });

    const control = async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0];
    ctx.check((await control()).closed === false, 'nothing closes on staleness: censorship is a ground for the court, not a latch (whitepaper §3.6)', { epochs: windowEpochs });
    ctx.check((await control()).frozen === false, 'no freeze is reached by the passage of time either');
    ctx.check((await rv('nextLeaf')) === leafBefore, 'a censored root consumes no one-time leaf', { leafBefore, now: await rv('nextLeaf') });
    ctx.check((await rv('lastEpoch')) === lastEpochBefore, 'the relay admitted nothing while the return path was withheld', { lastEpochBefore });
    ctx.check(Number((await ctx.registry('anchorOf', [anchored.id])).status) === 2, 'the position stays in transit, which is the evidence the censorship ground is measured from (whitepaper §3.6)');
    const inTransit = await ctx.registry('totalInTransit');
    ctx.check(inTransit > 0n, 'transit is recorded on QRL throughout, with no admitted root to settle it', { inTransit });

    /* ------------------------------------------------------------ resume */
    await ctx.waitFor('the next root admitted once the censorship lifted', async () => (await rv('nextLeaf')) > leafBefore, { sealNow: true, timeoutEpochs: 3 });
    ctx.check((await rv('nextLeaf')) === leafBefore + 1n, 'the one-time key set advances by exactly one leaf per admitted root (I16, I17)', { leafBefore, now: await rv('nextLeaf') });
    await ctx.waitFor('the withheld release settled after the resumption', async () => (await a.token.call('balanceOf', [recipient])) > 0n, { timeoutEpochs: 8 });
    ctx.check(true, 'a release withheld by censorship is delayed, never destroyed: the leaf is still admissible afterwards', { recipient });
  },
};
