/**
 * The relayer dies with a leaf already committed to a message.
 *
 * The rule under test is the one that cannot be recovered from if it is wrong:
 * a Winternitz leaf signs **one** message, ever. The relayer writes the message
 * to disk before signing it, so a relayer that dies between the write and the
 * admission — or whose admitting transaction is simply dropped — resubmits that
 * same message on restart rather than signing a second one from the leaf.
 * Nothing but an admission advances `lastEpoch`, so the withheld message is
 * still admissible however long the gap.
 *
 * The fault is injected where it really happens: the signing succeeds and the
 * transaction carrying it does not.
 */
const { ONE, units } = require('../lib');

module.exports = {
  description: 'a root signed and never admitted: the restarted relayer resubmits that message, and signs no other',
  outOfScope: ['a relayer whose seed is lost: there is no recovery from that, by construction'],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 100));
    await ctx.waitAnchorRecorded(anchored.id);

    const rv = async (m) => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, m))[0];
    const leafBefore = Number(await rv('nextLeaf'));

    /* ------------------------------------------------------------ the dropped transaction */
    const realSend = ctx.origin.send.bind(ctx.origin);
    let dropped = 0;
    ctx.origin.send = async (to, abi, method, args, o) => {
      if (method === 'admitEpochRoot') {
        dropped += 1;
        throw new Error('the transaction carrying the root was dropped');
      }
      return realSend(to, abi, method, args, o);
    };
    const recipient = '0x' + '88'.repeat(20);
    await ctx.registrySend('instructRelease', [anchored.id, ctx.r.evmArg(recipient)]);
    await ctx.tick({ sealNow: true });
    ctx.origin.send = realSend;

    ctx.check(dropped > 0, 'the admitting transaction was dropped after the leaf had signed', { dropped });
    const record = ctx.r.state.data.signed[leafBefore];
    ctx.check(record && record.admitted === false, 'the message the leaf signed is on disk, recorded before the signature existed', { leaf: leafBefore, epoch: record && record.epoch });
    ctx.check(Number(await rv('nextLeaf')) === leafBefore, 'the relay consumed no leaf, because it admitted nothing', { leafBefore });

    /* ------------------------------------------------------------ the restart */
    const revived = await ctx.restart();
    ctx.check(revived.state.data.signed[leafBefore].message === record.message, 'a restarted relayer reads back the one message that leaf may sign', { message: record.message });

    await ctx.waitFor('the withheld root admitted after the restart', async () => Number(await rv('nextLeaf')) > leafBefore, { timeoutEpochs: 6 });
    ctx.check(Number(await rv('nextLeaf')) === leafBefore + 1, 'exactly one leaf is consumed: the same message, resubmitted, not a second signature', { leafBefore });
    const admitted = revived.state.data.signed[leafBefore];
    ctx.check(admitted.message === record.message && admitted.admitted === true, 'what was admitted is the message that was signed before the crash, unchanged', { epoch: admitted.epoch });
    ctx.check(BigInt(await rv('lastEpoch')) === BigInt(record.epoch), 'a message signed for an epoch stays admissible: nothing but an admission moves the relay forward', { epoch: record.epoch });

    /* ------------------------------------------------------------ and it keeps working */
    await ctx.waitFor('the release settled by the restarted relayer', async () => (await a.token.call('balanceOf', [recipient])) > 0n, { timeoutEpochs: 8 });
    ctx.check(true, 'the leaves the withheld root carried are consumed as usual once it is admitted', { recipient });
  },
};
