/**
 * The reference solver as an independent market maker (2026-09-29): a
 * process of its own, with accounts of its own, beside the relayer — what
 * `ark-solver.service` runs on qrl-vps.
 *
 * The solver's QRL account is funded the way the relayer's redeploy funds it
 * at a fresh genesis (`fundingPlan` with `SOLVER_ADDRESS`). It quotes the
 * offering at the reserve from its own account; the relayer selects the lots
 * and seals the lock; the solver finds its lock among the leaves the relay
 * published on the origin chain (D15) — it holds no copy of any relayer's
 * state — and claims on the origin chain from its own account, which
 * publishes the secret; the relayer carries the secret to QRL; the lot's QRL
 * reaches the delivered proceeds; the coupon of the epoch is distributed from
 * them; the solver's bond comes back. Midway the solver is restarted from its
 * state file and quotes nothing twice.
 *
 * What stands in is what every scenario has: the attester quorum
 * (MockAttestation) and the valuation oracle (MockPriceOracle).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ONE, units } = require('../lib');
const { iface, qrlBuild, parseLogs, harnessAccount } = require('../../lib/chains');
const gov = require('../../lib/governance');
const { revealBudgetSeconds } = require('../../../ecdsa-stakings/relayer/lib/epoch');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const { Solver, SolverService } = require('../../../ecdsa-stakings/relayer/engine/solver');

/** The solver's account: not the relayer's, not any role's. */
const SOLVER = '0x' + '5e'.repeat(20);

module.exports = {
  description: 'the reference solver with keys of its own beside the relayer: funded at genesis, quotes, is selected, claims on the origin chain from the published leaves, the relayer carries the secret, the coupon is paid; restart-safe',
  outOfScope: [
    'the separation refusal on a shared manifest and the crash windows of a quote or a claim (relayer/test/solver.test.js)',
    'a coupon reaching a holding: the subscription is inside its cliff (test/ArkCatBond.test.js)',
  ],
  async run(ctx, opts) {
    if (ctx.qrl.kind === 'qrl') {
      // Harness-only: it impersonates a fixed 20-byte solver and funds it with
      // 1,000,000 QRL. On a live v3 chain the reference solver runs as an e2e
      // actor in swap-live.js and swap-preemption.js (audit 2026-10-03).
      module.exports.outOfScope = [...(module.exports.outOfScope || []), 'on a live chain: covered by swap-live.js with a real solver account (this scenario impersonates a 20-byte harness address)'];
      ctx.note('solver-service is harness-only; on a live chain swap-live covers the solver service');
      return;
    }
    const a = ctx.asset(opts.asset);
    const q = ctx.r.q;
    if (!q.PremiumSwap) throw new Error('this QRL leg has no PremiumSwap; redeploy it');
    const build = qrlBuild(ctx.r.manifest.profile);
    const swapAbi = iface('PremiumSwap', build);
    const swapCall = async (m, args = []) => (await ctx.qrl.call(q.PremiumSwap, swapAbi, m, args))[0];
    const chainId = ctx.r.chainId;
    const relayer = toHex(ctx.qrl.address);
    ctx.check(toHex(SOLVER) !== relayer, "the solver's account is not the relayer's (one account per running process)", { solver: SOLVER, relayer });

    /* ------------------------------------------------------------ funded as the redeploy funds it */
    const plan = gov.fundingPlan({ env: { SOLVER_ADDRESS: SOLVER, SOLVER_QRL_FUNDING: '1000000' }, me: relayer, chain: ctx.r.chain });
    await gov.fundAccounts({ client: ctx.qrl, plan, log: () => {} });
    const funded = await ctx.qrl.balance(SOLVER);
    ctx.check(funded === 1_000_000n * ONE, "the relayer's funding plan tops up SOLVER_ADDRESS from the deployer, as its redeploy does at a fresh genesis", { funded });
    ctx.check((await gov.fundingShortfall({ client: ctx.qrl, plan })) === 0n, 'a second run of the plan sends nothing');

    /* ------------------------------------------------------------ the service, its own accounts */
    const account = harnessAccount(ctx.qrl, SOLVER);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-solver-'));
    const lines = [];
    const log = (m) => {
      lines.push(m);
      if (opts.verbose) console.log(m);
    };
    const makeService = () =>
      new SolverService({
        chain: ctx.r.chain,
        qrl: account,
        origin: account,
        assets: [{ symbol: a.symbol, address: a.asset, escrow: a.escrow }],
        deployment: () => ({ qrl: ctx.r.q, qrlGenesisHash: ctx.r.deployment.qrlGenesisHash }),
        makeSolver: (asset, swap) =>
          new Solver({
            qrl: account,
            origin: account,
            swap,
            swapAbi,
            chainId,
            escrow: { asset: a.asset, escrow: a.escrow, abi: a.abi },
            recipient: SOLVER,
            clock: ctx.clock,
            revealBudget: revealBudgetSeconds(ctx.r.manifest, 60),
            relay: ctx.r.relay,
            relayAbi: ctx.r.abi.relay,
            errors: ctx.r.errors,
            log,
          }),
        clock: ctx.clock,
        dir,
        relay: ctx.r.relay,
        relayAbi: ctx.r.abi.relay,
        lookbackBlocks: 1_000_000n,
        maxLotValue: null,
        // The relayer carries the preimage here; the solver's own carry is the unit suite's.
        carryAfter: ctx.clock.day,
        errors: ctx.r.errors,
        log,
        warn: log,
      }).lock();
    let svc = makeService();
    ctx.sidecars.push(() => svc.tick());

    /* ------------------------------------------------------------ yield into the pot, offered */
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 1000));
    await ctx.waitAnchorRecorded(anchored.id);
    const epoch0 = await ctx.originEpoch();
    await ctx.waitFor(`the allocation of epoch ${epoch0} recorded in the escrow`, async () => BigInt((await a.call('recordedAllocation')).epoch) >= epoch0, { sealNow: true });
    const fromBlock = (await ctx.origin.head()).latest;
    await ctx.produceYield(a, 40n * ONE);
    await ctx.waitFor('the yield swept into the premium pot', async () => (await a.call('auctionShares')) > 0n);
    const offeredYet = async () => {
      try {
        return await ctx.lastEvent(a, 'PremiumOffered', fromBlock);
      } catch {
        return null;
      }
    };
    await ctx.waitFor('the escrow offered its premium', async () => Boolean(await offeredYet()));
    const t = BigInt((await offeredYet()).epoch);
    await ctx.waitFor(`the offer of epoch ${t} recorded on QRL`, async () => (await swapCall('offeringOf', [chainId, a.asset, t])).recorded);

    /* ------------------------------------------------------------ the quote, from its own account */
    const ours = () => svc.state.lots.find((l) => BigInt(l.epoch) === t) || svc.state.done.find((l) => BigInt(l.epoch) === t);
    await ctx.waitFor(`the solver quoted epoch ${t}'s offering in its window`, async () => Boolean(ours()));
    const lot = { ...ours() };
    const onSwap = await swapCall('lotOf', [lot.lotId]);
    ctx.check(toHex(onSwap.solver) === toHex(SOLVER), "the lot is the solver's own account's, not the relayer's", { solver: onSwap.solver });
    ctx.check(BigInt(onSwap.value) >= (await swapCall('required', [chainId, a.asset, t, lot.shares])) && BigInt(onSwap.bond) === lot.bond && lot.bond > 0n, 'quoted at the reserve with the commitment bond the swap computes (I33)', { value: onSwap.value, bond: onSwap.bond });
    const avail = BigInt((await swapCall('offeringOf', [chainId, a.asset, t])).offered);
    ctx.check(lot.shares * 32n >= avail || lot.shares === avail, 'the lot is at least the D4 minimum', { shares: lot.shares, offered: avail });

    // A restart: a second process from the same state file.
    svc.close();
    svc = makeService();
    await svc.tick();
    await svc.tick();
    // Beside its lot the book may hold the solver's one-planck judging quote, made where nobody had
    // judged the offering yet (OC-SWAP-03): never selected, and never a second lot.
    const book = [];
    for (const id of await swapCall('lotsOf', [chainId, a.asset, t])) book.push(await swapCall('lotOf', [id]));
    const priced = book.filter((l) => BigInt(l.value) > 1n).length;
    const judging = book.filter((l) => BigInt(l.value) === 1n).length;
    ctx.check(priced === 1 && judging <= 1, 'restarted from its state file, the solver quotes the offering no second time', { lots: priced, judging });

    /* ------------------------------------------------------------ selected, claimed on the origin chain */
    // From before the selection: since OC-SWAP-01 the relayer selects before
    // it scans and seals, so the lock can be sealed, published and claimed in
    // the tick that selects it, and the lot finished before the next wait.
    const claimFrom = (await ctx.origin.head()).latest;
    await ctx.waitFor('the lot selected at the close of the quote window', async () => Number((await swapCall('lotOf', [lot.lotId])).status) >= 2);
    const worth = await a.call('toUnits', [lot.shares]);
    let leaf = null;
    await ctx.waitFor('the solver claimed its lot on the origin chain, from the leaves the relay published (D15)', async () => {
      const l = svc.state.lots.find((x) => x.lotId === lot.lotId) || svc.state.done.find((x) => x.lotId === lot.lotId);
      if (l && (l.leaf || (l.item && l.item.leaf))) leaf = l.leaf || l.item.leaf;
      return Boolean(l && l.claimedOrigin);
    }, { sealNow: true });
    ctx.check(Boolean(leaf) && Object.values(svc.state.published).some((leaves) => leaves.some((x) => x.toLowerCase() === leaf.toLowerCase())), 'the lock was found among the leaves the relay published on the origin chain, not in a relayer state file', { leaf });
    ctx.check((await ctx.transferredTo(a, SOLVER, claimFrom)) + 2n >= worth, "the escrow paid the solver's own origin account its lot, in the shares it quoted", { shares: lot.shares, worth });

    /* ------------------------------------------------------------ the secret carried to QRL */
    await ctx.waitFor('the relayer carried the revealed preimage to QRL', async () => Number((await swapCall('lotOf', [lot.lotId])).status) === 3);
    const head = await ctx.qrl.head();
    const claimed = parseLogs(swapAbi, await ctx.qrl.logs(q.PremiumSwap, 0n, head.latest)).find((e) => e.name === 'LotClaimed' && e.args.lotId === lot.lotId);
    ctx.check(Boolean(claimed) && toHex(claimed.args[2]) === relayer, 'the preimage reached QRL from the relayer, which read it from the origin chain (PremiumClaimed)', { by: claimed && claimed.args[2] });
    const jurorBps = BigInt((await swapCall('offeringOf', [chainId, a.asset, t])).jurorBps);
    const fee = q.ArkStakeCourt ? (lot.value * jurorBps) / 10000n : 0n;
    ctx.check((await ctx.ledger('deliveredIn', [t])) === lot.value - fee, "the lot's QRL, less its juror fraction, is the delivered proceeds of the epoch whose premium it bought", { t, value: lot.value, fee });

    /* ------------------------------------------------------------ the coupon, and the bond */
    await ctx.waitFor(`the coupon of epoch ${t} distributed from the solver's premium`, async () => BigInt(await ctx.coupon('lastDistributed')) >= t);
    ctx.check((await ctx.ledger('remainingIn', [t])) === 0n, "the coupon drew the epoch's proceeds — the premium the solver bought — and nothing else");
    await ctx.waitFor("the solver's lot finished with its bond back", async () => svc.state.done.some((x) => x.lotId === lot.lotId));
    const done = svc.state.done.find((x) => x.lotId === lot.lotId);
    ctx.check(done.outcome === 'claimed; bond back' && BigInt((await swapCall('lotOf', [lot.lotId])).bond) === 0n, 'claimed before its QRL expiry, the lot\'s commitment bond went back to its solver (I33)', { outcome: done.outcome });
    ctx.check(done.secret === undefined, 'a finished lot keeps no secret in the state file');
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'solver-status.json'), 'utf8'));
    ctx.check(status.ready === true && status.swap.toLowerCase() === toHex(q.PremiumSwap).toLowerCase(), 'the service reports ready on this genesis, for devnet:up to wait on', { ready: status.ready });

    svc.close();
    ctx.sidecars.length = 0;
    fs.rmSync(dir, { recursive: true, force: true });
    ctx.note(`solver log: ${lines.filter((l) => !/^solver   epoch/.test(l)).length} lines`);
  },
};
