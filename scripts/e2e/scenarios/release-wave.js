/**
 * Eighty per cent of the book leaves at once.
 *
 * The rule under test is the one the whitepaper edited on 2026-09-20: the exit
 * queue's budget is 2,500 bps of `queueBase`, the escrow's whole holding when
 * the queue opened, held until the queue empties — so a whole book clears in
 * four draining epochs instead of decaying geometrically (R10).
 */
const { ONE, BPS, units } = require('../lib');

module.exports = {
  description: 'a release wave: unbonding from the epoch number, the fixed queue base, the linear drain',
  outOfScope: ['a cancellation path for a queued release: the whitepaper states none (status item 19)'],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const positions = Number(opts.positions || 10);
    const each = units(opts.notional, 100);
    const leaving = Math.floor((positions * 8) / 10);

    await ctx.seedIfNeeded(a);
    const anchors = [];
    for (let i = 0; i < positions; i += 1) anchors.push(await ctx.anchor(a, each));
    ctx.note(`anchored ${positions} positions of ${each / ONE} ${a.symbol}`);
    for (const x of anchors) await ctx.waitAnchorRecorded(x.id);

    /* ------------------------------------------------------------ instruct */
    const recipients = anchors.map((_, i) => '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20));
    for (let i = 0; i < leaving; i += 1) await ctx.registrySend('instructRelease', [anchors[i].id, ctx.r.evmArg(recipients[i])]);
    ctx.note(`${leaving} of ${positions} beneficiaries instructed a release (whitepaper §3.3)`);
    const inTransit = await ctx.registry('totalInTransit');
    // The anchored notionals, not `each`: a rebasing asset (mREB, stETH) records
    // a wei or so less than it was sent (share rounding), so the exact sum is theirs.
    const leavingNotional = anchors.slice(0, leaving).reduce((sum, x) => sum + BigInt(x.notional), 0n);
    ctx.check(inTransit === leavingNotional, 'a release moves the notional into transit at the instruction, not at settlement (I18)', { inTransit, leavingNotional });

    await ctx.waitFor('every release instruction sealed into an epoch root', async () => {
      const sealed = Object.values(ctx.r.state.data.roots).flatMap((r) => r.items).filter((x) => x.kind === 'release').length;
      return sealed >= leaving;
    }, { sealNow: true });
    const first = ctx.sealed('release');
    const rootEpoch = first.epoch;

    /* ------------------------------------------------------------ unbonding */
    if ((await ctx.originEpoch()) < rootEpoch + 4n) {
      await ctx.refuses('a release before the fourth epoch after the one its leaf was sealed into', 'UnbondingNotServed', () =>
        a.call('release', [first.id, first.recipient, first.claimNonce, rootEpoch, ctx.proof(rootEpoch, first.leaf)]),
      );
    } else {
      ctx.note('the wave was sealed more than four epochs ago already; the unbonding refusal was not observable');
    }

    await ctx.waitFor('the first release consumed into the exit queue', async () => (await a.call('queueTail')) > 0n, { timeoutEpochs: 8 });
    const base = await a.call('queueBase');
    const bound = (base * 2500n) / BPS;
    ctx.note(`the queue opened on a base of ${base} shares; the per-epoch bound is ${bound}`, { base, bound });

    /* ------------------------------------------------------------ the drain */
    const seen = [];
    let epochsDraining = 0;
    await ctx.waitFor('the whole queue paid out', async () => {
      const epoch = await ctx.originEpoch();
      const queued = await a.call('queuedShares');
      const now = await a.call('queueBase');
      if (!seen.length || seen[seen.length - 1].epoch !== epoch) {
        seen.push({ epoch, queued, base: now, remaining: await a.call('releaseBudgetRemaining') });
        epochsDraining += 1;
      }
      if (queued > 0n) {
        ctx.check(now === base, 'the queue base is the holding when the queue opened and is held until it empties (whitepaper §3.3)', { base, now, epoch });
      }
      return queued === 0n && (await a.call('queueHead')) === (await a.call('queueTail'));
    }, { timeoutEpochs: 8 });

    ctx.check(epochsDraining <= 5, 'a queue of eighty per cent of the book clears within the four draining epochs the settlement horizon assumes (I25)', {
      epochsDraining,
      seen: seen.map((s) => ({ epoch: s.epoch, queued: s.queued })),
    });
    for (let i = 0; i < leaving; i += 1) {
      const paid = await a.token.call('balanceOf', [recipients[i]]);
      ctx.check(paid > 0n && paid <= each, 'each release is paid to the recipient committed on QRL before any origin-chain transaction existed', { recipient: recipients[i], paid });
    }
    const settled = await Promise.all(anchors.slice(0, leaving).map(async (x) => Number((await ctx.registry('anchorOf', [x.id])).status)));
    await ctx.waitFor('the forward path closed the transit records the censorship ground is measured from', async () => {
      const states = await Promise.all(anchors.slice(0, leaving).map(async (x) => Number((await ctx.registry('anchorOf', [x.id])).status)));
      return states.every((s) => s === 3);
    }, { timeoutEpochs: 4 });
    ctx.check((await ctx.registry('totalInTransit')) === 0n, 'a release settled on the origin chain closes its transit record on QRL (whitepaper §3.3)', { statusesBefore: settled });
  },
};
