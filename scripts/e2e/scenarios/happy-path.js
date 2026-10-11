/**
 * The ordinary epoch, end to end: anchor, price, sweep into the pots.
 *
 * The premium's sale for QRL, the proceeds and the coupon are
 * `atomic-yield-flow`: nothing stands in for them any more. The bond is real:
 * the deployment subscribes principal into it.
 */
const { ONE, BPS, units } = require('../lib');
const { iface, qrlBuild, QRL_DEPOSIT_CONTRACT } = require('../../lib/chains');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

module.exports = {
  description: 'anchor, price of cover, sweep into the pots',
  outOfScope: [
    'the sale of the premium and the coupon: atomic-yield-flow',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const epochs = Number(opts.epochs || 2);
    const notional = units(opts.notional, 1000);

    /* ------------------------------------------------------------ wiring */
    const q = ctx.r.q;
    const build = qrlBuild(ctx.r.manifest.profile);
    const at = async (addr, name, m) => toHex((await ctx.qrl.call(addr, iface(name, build), m))[0]);
    // Each link read once and named in the record, so a failure says which.
    const wiring = q.ArkBondDelegation
      ? {
          venue: await at(q.ArkBondStaking, 'ArkBondStaking', 'venue'),
          poolDelegation: await at(q.ArkStakingPool, 'ArkStakingPool', 'delegation'),
          delegationBond: await at(q.ArkBondDelegation, 'ArkBondDelegation', 'BOND'),
          // The chain's own deposit contract, by deploy.js's rule: on a live
          // v3 (QIP-55) node .env names it (`QRL_DEPOSIT_CONTRACT`, 64 bytes);
          // the harness keeps the 20-byte constant whatever .env says.
          deposit: await at(q.ArkBondDelegation, 'ArkBondDelegation', 'DEPOSIT_CONTRACT'),
          expectedDeposit: toHex(ctx.qrl.kind === 'qrl' && ctx.qrl.env && ctx.qrl.env.QRL_DEPOSIT_CONTRACT ? ctx.qrl.env.QRL_DEPOSIT_CONTRACT : QRL_DEPOSIT_CONTRACT),
        }
      : null;
    ctx.check(
      Boolean(wiring)
        && wiring.venue === toHex(q.ArkStakingPool)
        && wiring.poolDelegation === toHex(q.ArkBondDelegation)
        && wiring.delegationBond === toHex(q.ArkStakingPool)
        && wiring.deposit === wiring.expectedDeposit,
      "bond principal reaches QRL staking: the staking contract names a pool whose delegation runs validators on the chain's deposit contract (whitepaper §3.4)",
      { delegation: q.ArkBondDelegation || null, pool: q.ArkStakingPool || null, ...(wiring || {}) },
    );

    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, notional);
    ctx.note(`anchored ${notional / ONE} ${a.symbol} as ${anchored.id.slice(0, 18)}…`, { id: anchored.id });
    await ctx.waitAnchorRecorded(anchored.id);

    /* ------------------------------------------------------------ price */
    const covered = await ctx.registry('coveredBps');
    const target = await ctx.registry('sigmaTargetBps');
    const ceiling = await ctx.registry('premiumCeilingInForceBps');
    // The slope is a ratio of the target in force since 2026-09-30 (EC-07).
    const ratio = (await ctx.qrl.call(ctx.r.q.ArkStakeParams, ctx.r.abi.params, 'params'))[0].premiumSlopeRatioBps;
    const slope = (target * BigInt(ratio)) / BPS;
    const premium = await ctx.registry('premiumShareBps');
    const scaled = target * covered + slope * (BPS - covered);
    const capped = ceiling * covered;
    const expected = covered === 0n ? 0n : (scaled < capped ? scaled : capped) / BPS;
    ctx.check(premium === expected, 'the premium is the target raised with scarcity and scaled by the cover received (whitepaper §4.4)', {
      covered,
      target,
      ceiling,
      premium,
      expected,
    });
    const model = await ctx.model();
    if (model) {
      const fromModel = BigInt(model.ark.premiumShareBps({ ...model.params, sigmaTargetBps: Number(target) }, Number(covered), Number(ceiling)));
      ctx.check(premium === fromModel, 'the live registry and ark-staking.ts price the same book identically', { premium, fromModel });
    } else {
      ctx.note('the specification model was not found beside this repository; the arithmetic comparison is skipped');
    }

    /* ------------------------------------------------------------ epochs */
    for (let i = 0; i < epochs; i += 1) {
      const epoch = await ctx.originEpoch();
      const minted = 40n * ONE;
      // The allocation first, and the snapshot before any yield exists: the
      // relayer sweeps on every tick, so a snapshot taken after the yield was
      // minted would be taken after the sweep it is meant to measure.
      await ctx.waitFor(`the allocation of epoch ${epoch} recorded in the escrow`, async () => BigInt((await a.call('recordedAllocation')).epoch) === epoch, { sealNow: true });
      const alloc = await a.call('recordedAllocation');
      const before = { auction: await a.call('auctionShares'), buffer: await a.call('bufferShares'), position: await a.call('positionShares') };

      const fromBlock = (await ctx.origin.head()).latest;
      // A double is given its yield; a real asset (stETH on Hoodi) earns its
      // own at the next Lido oracle report, about once a day: 26 epochs of 70
      // minutes cover one report and a sweep after it.
      if (a.mock) await ctx.produceYield(a, minted);
      else ctx.note(`${a.symbol} is a real asset: waiting for its own yield (the next oracle rebase)`);
      await ctx.waitFor(`the sweep of the yield of epoch ${epoch}`, async () => (await a.call('auctionShares')) > before.auction, a.mock ? {} : { timeoutEpochs: 26 });
      const after = { auction: await a.call('auctionShares'), buffer: await a.call('bufferShares'), position: await a.call('positionShares') };

      // The gross is what the escrow measured, not what was minted. On the
      // rebasing form they differ on purpose: a rebase also lifts the buffer's
      // own shares, and that part is already the buffer's — only the gain on
      // the positions is yield to be divided (whitepaper §4.2).
      // The Shares form records every pot in shares, because recording units
      // would present the next rebase as yield and the sweep would pay
      // principal away (CLAUDE.md §7.2). So every comparison is made in units,
      // through the escrow's own conversion, and tolerates the truncation each
      // conversion leans — toward the position, by whitepaper §4.1.
      const units = async (shares) => (a.rebasing ? await a.call('toUnits', [shares]) : shares);
      const near = (x, y) => (x > y ? x - y : y - x) <= (a.rebasing ? 1000n : 0n);

      const swept = await ctx.lastEvent(a, 'Swept', fromBlock);
      const held0 = await ctx.lastEvent(a, 'PremiumHeld', fromBlock);
      const gross = BigInt(swept.grossUnits);
      const premiumUnits = BigInt(swept.premiumUnits);
      const opsUnits = BigInt(swept.operationsUnits);
      const jurorUnits = BigInt(held0.jurorFeeUnits);
      const bufferUnits = BigInt(swept.bufferUnits);
      ctx.check(premiumUnits === (gross * BigInt(alloc.sigmaBps)) / BPS, 'the premium share of the sweep is the share the allocation leaf fixed for the epoch (whitepaper §3.5)', { premiumUnits, sigmaBps: Number(alloc.sigmaBps), gross, minted });

      // The stabilization levy is a share of gross yield too, while the stage is below its fourth (gap item 19).
      const levyUnits = (gross * BigInt(alloc.levyBps)) / BPS;
      ctx.check(
        BigInt(swept.stakerUnits) + premiumUnits + opsUnits + bufferUnits + levyUnits === gross,
        'the shares sum to the gross yield, the levy among them, the staker share being the residual (whitepaper §4.2)',
        { gross, staker: BigInt(swept.stakerUnits), premiumUnits, opsUnits, bufferUnits, levyUnits },
      );
      const paid = await ctx.transferredTo(a, ctx.r.manifest.addresses.operationsDestination, fromBlock);
      ctx.check(paid === opsUnits - jurorUnits, 'the operations share less the juror-fee fraction is paid to the immutable destination', { paid, opsUnits, jurorUnits });

      // The pots are measured in units of value. On the rebasing form a pot's
      // existing shares also gain with the rebase, so its value rises by at
      // least its share of the sweep — on the unit form the two are equal.
      const heldGain = (await units(after.auction)) - (await units(before.auction));
      ctx.check(a.rebasing ? heldGain >= premiumUnits + jurorUnits - 1000n : heldGain === premiumUnits + jurorUnits, 'the premium share and the juror-fee fraction are held in the escrow to be swapped for QRL (whitepaper §4.7)', { heldGain, premiumUnits, jurorUnits });
      const bufferGain = (await units(after.buffer)) - (await units(before.buffer));
      ctx.check(a.rebasing ? bufferGain >= bufferUnits - 1000n : bufferGain === bufferUnits, 'the buffer share is retained as first loss (whitepaper §4.2)', { bufferGain, bufferUnits });

      // The escrow's own identity, and the one that says nothing was created
      // or lost in the split: every share it holds belongs to exactly one pot.
      const pots = after.position + after.buffer + after.auction + (await a.call('queuedShares')) + (await a.call('psrShares')) + (await a.call('unclaimedShares'));
      ctx.check(pots === (await a.call('sharesHeld')), 'every share the escrow holds belongs to exactly one of its pots (CLAUDE.md §7.2)', { pots, held: await a.call('sharesHeld') });
    }

    // The sale of the premium and the coupon it funds are scripts/e2e/scenarios/atomic-yield-flow.js.
  },
};
