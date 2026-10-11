/**
 * Leg A: the seeding deposit returned after a de-listing (S17,
 * docs/review/audit-2026-10-03/LEG-A/REPORT.md; whitepaper §4.2, re-audit
 * 2026-09-30 ORIGIN-01/03, PV-17).
 *
 * The rule under test: the seed leaves only to the operations destination,
 * only from an escrow whose anchoring is closed and whose stake has all left,
 * only against a seed-return leaf QRL sealed on a request of governance for
 * the epoch in progress or the one before, and only once per leaf.
 *
 * TERMINAL for the asset: it is de-listed and its escrow closed to anchoring
 * for good. Run it on a deployment whose asset is not needed afterwards; it
 * needs an escrow with no stake in it (a fresh deployment) and the deployer as
 * the registry's governance, and records itself out of scope otherwise.
 *
 * Wall-clock: about 5 epochs — on the rehearsal chain (rapid profile,
 * 7-minute epochs) about 35 minutes; on hoodi-vps (testnet profile, 70-minute
 * epochs) about 6 hours, where the registry is governed by the timelock and
 * the scenario stops at its precondition.
 *
 * What stands in: governance, as the deployer calling `requestSeedReturn` and
 * `delistAsset` (the procedure of whitepaper §6.3 is not driven here).
 */
const { ONE } = require('../lib');
const { parseLogs } = require('../../lib/chains');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const H = require('../helpers/leg-a');

const lower = (x) => String(x).toLowerCase();
const STATIC_OUT_OF_SCOPE = ['the governance procedure behind the request and the de-listing (whitepaper §6.3): the deployer votes here'];

module.exports = {
  terminal: true,
  description: 'the seeding deposit returned after a de-listing: refused while anchoring is open, paid once to the operations destination, a replay refused',
  outOfScope: [...STATIC_OUT_OF_SCOPE],
  async run(ctx, opts) {
    const outOfScope = (module.exports.outOfScope = [...STATIC_OUT_OF_SCOPE]);
    const a = ctx.asset(opts.asset);
    const chainId = ctx.r.chainId;
    const escrowArg = ctx.r.evmArg(a.escrow);
    if (!(await H.governs(ctx, ctx.r.q.ArkStakeRegistry, 'ArkStakeRegistry'))) {
      outOfScope.push('S17: the deployer is not governance of ArkStakeRegistry here, so no seed return can be requested from this run');
      ctx.note('S17 not driven: requestSeedReturn and delistAsset are governance calls');
      return;
    }
    await ctx.seedIfNeeded(a);
    if ((await a.call('totalStake')) !== 0n) {
      outOfScope.push('S17: the escrow holds stake; the seed is last out and returns only once every position has left');
      ctx.note('S17 not driven: the escrow holds stake', { totalStake: await a.call('totalStake') });
      return;
    }
    const seeded = await a.call('seededUnits');
    const ops = lower(toHex(ctx.r.manifest.addresses.operationsDestination));
    const leafOf = (n) => H.sealedOrNull(ctx, 'seedReturn', (x) => lower(x.escrow) === lower(a.escrow) && BigInt(x.request) === BigInt(n));

    /* ------------------------------------------------------------ a request while anchoring is open */
    await ctx.registrySend('requestSeedReturn', [chainId, escrowArg]);
    ctx.note('seed return requested on QRL (governance: the deployer)');
    await ctx.waitFor('the seed-return leaf of the first request sealed', async () => Boolean(leafOf(1)), { sealNow: true, timeoutEpochs: 3 });
    const first = leafOf(1);
    ctx.check(first.standIn === undefined || first.standIn === null, 'the seed-return leaf is the relayer\'s from the request recorded on QRL, not a stand-in', { epoch: first.epoch });
    await ctx.refuses('a seed return while the escrow still takes anchors (ORIGIN-01)', 'AnchoringOpen', () => a.call('withdrawSeed', [first.epoch, ctx.proof(first.epoch, first.leaf)]));

    /* ------------------------------------------------------------ the de-listing */
    const key = await ctx.registry('assetKey', [chainId, ctx.r.evmArg(a.asset)]);
    await ctx.registrySend('delistAsset', [key]);
    await ctx.waitFor('the escrow closed to anchoring', async () => (await a.call('anchoringClosed')) === true, { timeoutEpochs: 3 });

    // The first leaf is let go stale, so the freshness rule is seen to bind
    // and a second request is what returns the seed.
    await ctx.waitFor('the first leaf two epochs old', async () => (await ctx.originEpoch()) >= first.epoch + 2n, { timeoutEpochs: 3 });
    await ctx.refuses('a seed-return leaf of an epoch before the last one: it says nothing about a determination opened since', 'SeedReturnStale', () => a.call('withdrawSeed', [first.epoch, ctx.proof(first.epoch, first.leaf)]));
    await ctx.registrySend('requestSeedReturn', [chainId, escrowArg]);
    await ctx.waitFor('the seed-return leaf of the second request sealed', async () => Boolean(leafOf(2)), { sealNow: true, timeoutEpochs: 3 });
    const use = leafOf(2);
    const requests = BigInt(await ctx.registry('seedReturnRequests', [chainId, escrowArg]));
    const sealed = Object.values(ctx.r.state.data.roots).flatMap((r) => r.items).filter((x) => x.kind === 'seedReturn' && lower(x.escrow) === lower(a.escrow)).length;
    ctx.check(BigInt(sealed) === requests, 'one seed-return leaf per request of governance, never one per root (ORIGIN-01)', { requests, sealed });

    /* ------------------------------------------------------------ the return, once */
    const from = (await ctx.origin.head()).latest;
    const proof = ctx.proof(use.epoch, use.leaf);
    const rc = await a.send('withdrawSeed', [use.epoch, proof], { gas: 600_000 });
    const ev = parseLogs(a.abi, rc.logs).find((x) => x.name === 'SeedWithdrawn');
    ctx.check(Boolean(ev) && lower(ev.args.to) === ops, 'the seed returns to the operations destination fixed at construction and to no one else (whitepaper §4.2)', { to: ev && ev.args.to, ops });
    const units = BigInt(ev.args.units);
    ctx.check(units > 0n && units <= seeded, 'what returns is the lesser of the deposit and the buffer: the seed stands last out (whitepaper §4.2)', { units, seeded });
    ctx.check((await a.call('seededUnits')) === 0n, 'the recorded seed goes to zero with the return: none of it remains to open anchoring on (ORIGIN-03)');
    ctx.check((await ctx.transferredTo(a, ops, from)) + (a.rebasing ? 2n : 0n) >= units || (await a.call('owedShares', [ops])) > 0n, 'the units leave the escrow to the destination, or are credited to it where the asset refuses', { units });
    await ctx.refuses('the same seed-return leaf presented again', 'SeedReturnSpent', () => a.call('withdrawSeed', [use.epoch, proof]));
    await ctx.refuses('an anchor into the de-listed escrow', 'AnchoringIsClosed', () => a.call('anchor', [ctx.qrl.address, ONE]));
  },
};
