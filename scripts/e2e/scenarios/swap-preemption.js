/**
 * Root pre-emption (audit round OC, 2026-10-03, SWAP S5 and S3c; OC-SWAP-01,
 * and OC-SWAP-03 on the history it leaves): two assets on one relay, and a
 * stranger who calls the permissionless `select` for one of them the second
 * its quote window closes.
 *
 * Before the fix the relayer's next tick read the stranger's LotSelected,
 * found a premium lock pending (urgent) and sealed the epoch's only root at
 * once; its housekeeping selected the other asset after that, whose lock
 * waited for the next epoch's root, after its evmExpiry, and stayed pending
 * and urgent to pre-empt the next boundary too (the cascade). Since the fix
 * (OC-SWAP-01) the relayer selects before it scans and seals, holds an
 * urgent root while an offering in the first half of its admission window
 * has a selection not yet scanned, and prunes a lock past its evmExpiry: the
 * scenario asserts all three.
 *
 *   X (first asset)   one lot, selected by the stranger, claimed in time;
 *   Y (second asset)  offering t: one lot, selected by the relayer in the
 *                     same tick, rides root E with X's lock, admitted before
 *                     its evmExpiry; its solver then does not claim (a
 *                     no-show), so the offering fails as specified and its
 *                     bond is forfeited for its own default;
 *                     offering t+1: the stranger selects it at its quote
 *                     close; nothing expired is pending at the boundary, and
 *                     its lock rides root E+1; one honest lot, claimed — a
 *                     success after a failure;
 *                     offering t+2: the reference solver service, first to
 *                     quote, judges t+1 with a one-planck quote and prices
 *                     its lot from views read after that judgement, so the
 *                     lot is selected (OC-SWAP-03; before the fix it priced
 *                     from views read before and was passed over).
 *
 * A manifest with one asset (hoodi) has no second offering to pre-empt: the
 * run notes it and asserts nothing. The rehearsal and local manifests have two.
 *
 * Wall clock, from a fresh epoch: offering t, then the quote windows and
 * selections of t, t+1 and t+2 — about 4.5-5 epochs: ~35 min on the
 * rehearsal chain (rapid profile), ~5.5 h on a two-asset testnet-profile
 * chain (hoodi-vps has one asset and skips it). About two minutes locally.
 */
const { ONE, units } = require('../lib');
const { Solver } = require('../../../ecdsa-stakings/relayer/engine/solver');
const S = require('../helpers/swap');

const { big, lower, sameAccount } = S;

module.exports = {
  description: 'root pre-emption with two assets: a stranger selects one at the close of its quote window, and the relayer selects the other and holds the epoch\'s only root until both locks ride it (OC-SWAP-01); then a no-show, and the stale-view reserve of the reference solver after a success that follows that failure',
  outOfScope: [
    'a manifest with one asset: nothing to pre-empt (hoodi); the single-asset cascade through a pending control leaf is the PoC\'s (relayer-root-preemption.test.js)',
    'the BondMismatch form of OC-SWAP-03 (two failures or more before the success): the failure count here reaches one; the solver\'s retry on BondMismatch is relayer/test/solver.test.js\'s',
    'the run assumes no other solver quotes these offerings (stop ark-solver.service on the host)',
  ],
  async run(ctx, opts) {
    if (ctx.r.assets.length < 2) {
      ctx.note(`${ctx.r.chain} has ${ctx.r.assets.length} asset: root pre-emption needs a second offering on the same relay; nothing asserted`);
      return;
    }
    const X = ctx.asset(ctx.r.assets[0].symbol);
    const Y = ctx.asset(ctx.r.assets[1].symbol);
    const kX = S.swapKit(ctx, X);
    const kY = S.swapKit(ctx, Y);
    const q = kX.q;
    const yieldUnits = units(opts.quantity, 40);
    const qrlFrom = (await ctx.qrl.head()).latest;
    const originFrom = (await ctx.origin.head()).latest;
    const state = () => ctx.r.state.data;
    const quiet = 3n * S.stepOf(ctx);

    /* ------------------------------------------------------------ two offerings, one epoch */
    const { offerings } = await S.openOfferings(ctx, [X, Y], { notional: units(opts.notional, 1000), yieldUnits });
    const t = offerings[0].t;
    ctx.check(offerings[1].t === t, 'both escrows offered their premium for the same epoch, so both offerings close their quote window at the same instant', { X: offerings[0].t, Y: offerings[1].t });
    const T = kX.times(t);
    const E = ctx.clock.epochOf(T.qc);
    ctx.note(`offerings ${t}: quote window closes at ${T.qc}, the start of epoch ${E}; evmExpiry ${T.evmExpiry}`);
    const nowO = await S.nowOn(ctx, 'origin');
    if (Y.mock && ctx.clock.epochOf(nowO) === t + 1n && nowO < ctx.clock.offerOpens(t + 1n)) await ctx.produceYield(Y, yieldUnits / 4n);
    else ctx.note(`no fresh premium put into ${Y.symbol} for epoch ${t + 1n}`);

    const stranger = await S.fund(ctx, 'oc-swap-stranger', S.GAS_QRL);
    const sx = S.rawSolver(ctx, kX, await ctx.actor('oc-swap-pre-X'), '0x' + 'b1'.repeat(20));
    const sy = S.rawSolver(ctx, kY, await ctx.actor('oc-swap-pre-Y'), '0x' + 'b2'.repeat(20));
    const sy1 = S.rawSolver(ctx, kY, await ctx.actor('oc-swap-pre-Y1'), '0x' + 'b3'.repeat(20));

    await S.until(ctx, T.qo);
    const lotX = (await S.quoteLot(ctx, kX, 'oc-swap-pre-X', sx, t, (await kX.available(t)) / 2n)).lot;
    const lotY = (await S.quoteLot(ctx, kY, 'oc-swap-pre-Y', sy, t, await kY.available(t))).lot;

    /* ------------------------------------------------------------ the stranger at the close */
    await S.until(ctx, T.qc, { quiet });
    await stranger.send(q.PremiumSwap, kX.swapAbi, 'select', [kX.chainId, kX.assetArg, t]);
    ctx.check((await kX.status(lotX.lotId)) === 'Selected' && !(await kY.offering(t)).selected, `a stranger selected ${X.symbol}'s offering at the close of its quote window, before the relayer's first tick; ${Y.symbol}'s is not selected yet`);
    await ctx.tick();
    ctx.check(Boolean((await kY.offering(t)).selected) && (await kY.status(lotY.lotId)) === 'Selected', `the relayer selected ${Y.symbol}'s offering in its next tick, before it scans and seals (OC-SWAP-01 fix 2)`);
    if (Y.mock && (await S.nowOn(ctx, 'origin')) < T.evmExpiry) await ctx.produceYield(Y, yieldUnits / 4n);
    await S.waitFine(ctx, `${X.symbol}'s lock sealed into an admitted root`, async () => Boolean(Solver.lockIn(state(), lotX.lotId)), { timeoutEpochs: 1 });
    const lockX = Solver.lockIn(state(), lotX.lotId);
    const admX = await S.lockAdmission(ctx, lockX.item.leaf, originFrom);
    ctx.check(lockX.epoch === E && admX.at !== null && admX.at < T.evmExpiry, `the stranger's lock rode the root of epoch ${E}, admitted in time`, admX);
    ctx.check(await sx.claim(lotX, state()), `${X.symbol}'s lot is paid on the origin chain against its preimage`);

    /* ------------------------------------------------------------ Y rides the same root; its solver does not show */
    const lockY = Solver.lockIn(state(), lotY.lotId);
    const yLeaf = (await kY.swapEvents(qrlFrom)).find((e) => e.name === 'LotSelected' && lower(e.args.lotId) === lower(lotY.lotId)).args.premiumLockLeaf;
    const admY = lockY ? await S.lockAdmission(ctx, lockY.item.leaf, originFrom) : null;
    ctx.check(Boolean(admY && admY.at !== null && admY.at < T.evmExpiry), 'S5, I31.2: a lock selected in the admission window is sealed into a root admitted before its evmExpiry, whoever selected the other assets first (OC-SWAP-01)', {
      asset: Y.symbol,
      leaf: yLeaf,
      evmExpiry: T.evmExpiry,
      rootOfE: { epoch: E, admittedAt: admX.at },
      carriedBy: ctx.epochsCarrying(yLeaf),
      lockEpoch: lockY && lockY.epoch,
    });
    // Y's solver does not claim: a no-show, the one failure the steps below build on.
    ctx.note(`${Y.symbol}'s solver holds a claimable lock and does not claim it: offering ${t} fails by its own default`);
    await S.until(ctx, T.evmExpiry, { leg: 'origin' });

    /* ------------------------------------------------------------ offering t+1 of Y: a success after the failure */
    const t1 = t + 1n;
    const T1 = kY.times(t1);
    await S.waitFine(ctx, `${Y.symbol}'s offer of epoch ${t1} recorded`, async () => Boolean((await kY.offering(t1)).recorded), { timeoutEpochs: 2, throws: false });
    if (!(await kY.offering(t1)).recorded) {
      ctx.note(`${Y.symbol}'s offer of epoch ${t1} opened no offering: the cascade and OC-SWAP-03 are not measured`);
      return;
    }
    await S.until(ctx, T1.qo);
    const failedBefore1 = await kY.failed();
    const q1 = await S.quoteLot(ctx, kY, 'oc-swap-pre-Y1', sy1, t1, await kY.available(t1));
    const lotY1 = q1.lot;
    const failed1 = await kY.failed();
    // Judged on what it sold since OC-SWAP-06: the lot was selected and its solver was a no-show, so its forfeited bond is the whole price of the miss.
    ctx.check(failed1 === failedBefore1, `OC-SWAP-06: the offering whose lot was selected, its solver a no-show, is not judged a failure at the next offering's first quote`, { before: failedBefore1, after: failed1 });
    const reserve1 = await kY.required(t1, lotY1.shares);
    ctx.note(`${Y.symbol} t+1: quoted at ${lotY1.value} from views read before the judgement; the reserve the judgement fixed is ${reserve1} (above it: priced high, still selected)`);

    // The stranger again, at the close of t+1's quote window: the boundary of E+1.
    await S.until(ctx, T1.qc, { quiet });
    const now1 = await S.nowOn(ctx, 'origin');
    ctx.check(!state().pending.some((p) => p.kind === 'premium' && p.evmExpiry !== undefined && big(p.evmExpiry) <= now1), `at the boundary of epoch ${E + 1n} no premium lock past its evmExpiry is pending: none can make that root urgent (the cascade, OC-SWAP-01)`);
    await stranger.send(q.PremiumSwap, kY.swapAbi, 'select', [kY.chainId, kY.assetArg, t1]);
    await S.waitFine(ctx, `${Y.symbol}'s lock of epoch ${t1} sealed`, async () => Boolean(Solver.lockIn(state(), lotY1.lotId)), { timeoutEpochs: 1 });
    const lateY = Solver.lockIn(state(), lotY.lotId);
    const admLate = lateY ? await S.lockAdmission(ctx, lateY.item.leaf, originFrom) : null;
    ctx.check(!(admLate && admLate.at !== null && admLate.at >= T.evmExpiry), 'a premium lock past its evmExpiry is pruned, never sealed, and never makes a root urgent at the next boundary (the cascade, OC-SWAP-01)', {
      lockSealedInto: lateY && lateY.epoch,
      admittedAt: admLate && admLate.at,
      evmExpiry: T.evmExpiry,
    });
    ctx.check(Solver.lockIn(state(), lotY1.lotId).epoch === E + 1n, `selected by the stranger at its quote close, the offering's lock rides the root of epoch ${E + 1n}`);
    if (lateY) {
      await ctx.refuses('S3a: a lock presented at or after its evmExpiry pays nothing on the origin chain', 'PremiumExpired', () => Y.call('claimPremium', sy.claimArgs(lotY, lateY)));
    }
    ctx.check(await sy1.claim(lotY1, state()), `${Y.symbol}'s lot of epoch ${t1} is paid on the origin chain against its preimage`);
    await S.waitFine(ctx, `${Y.symbol}'s lot of epoch ${t1} carried to QRL`, async () => (await kY.status(lotY1.lotId)) === 'Claimed', { timeoutEpochs: 1 });

    // The lot of offering t its solver did not claim: refunded, its bond forfeited.
    await S.waitFine(ctx, `the coupon of epoch ${t} distributed`, async () => big(await ctx.coupon('lastDistributed')) >= t && (await kY.status(lotY.lotId)) === 'Refunded', { timeoutEpochs: 1 });
    const evs = await kY.swapEvents(qrlFrom);
    const refundY = evs.filter((e) => e.name === 'LotRefunded' && lower(e.args.lotId) === lower(lotY.lotId)).map((e) => ({ value: big(e.args.value), bond: big(e.args.bond) }));
    const forfeitT = evs.filter((e) => e.name === 'BondsForfeited' && big(e.args.epoch) === t).reduce((s, e) => s + big(e.args.amount), 0n);
    ctx.check(refundY.length === 1 && refundY[0].value === lotY.value && refundY[0].bond === 0n && forfeitT === lotY.bond, `${Y.symbol}'s lapsed lot of epoch ${t} got its QRL back and its bond went to the epoch's proceeds (the swap as specified)`, { refund: refundY, forfeited: forfeitT, bond: lotY.bond });
    ctx.check(Boolean(admY && admY.at !== null && admY.at < T.evmExpiry), 'I33: the bond forfeited is a no-show\'s: its lock reached a root it could claim against, before its evmExpiry (OC-SWAP-01)', { bond: lotY.bond, forfeited: forfeitT, admittedAt: admY && admY.at, evmExpiry: T.evmExpiry });

    /* ------------------------------------------------------------ offering t+2 of Y: the stale view */
    const t2 = t + 2n;
    const T2 = kY.times(t2);
    await S.waitFine(ctx, `${Y.symbol}'s offer of epoch ${t2} recorded`, async () => Boolean((await kY.offering(t2)).recorded), { timeoutEpochs: 2, throws: false });
    if (!(await kY.offering(t2)).recorded) {
      ctx.note(`${Y.symbol}'s offer of epoch ${t2} opened no offering: OC-SWAP-03 is not measured`);
      return;
    }
    const avail2 = await kY.available(t2);
    const svcFund = ((await kY.required(t2, avail2)) * 20_000n) / S.BPS + 2n * S.GAS_QRL;
    const svcClient = await S.fund(ctx, 'oc-swap-pre-svc', svcFund);
    const svc = new S.SolverProcess(ctx, kY, { name: 'reference solver', qrl: S.crashAfter(svcClient, 'claim'), origin: S.crashAfter(ctx.origin, 'claimPremium'), recipient: '0x' + 'b4'.repeat(20), shareBps: 10_000n, carryAfter: null, fromBlock: originFrom });
    await svc.start();
    ctx.sidecars.push(() => svc.tick());
    try {
      await S.until(ctx, T2.qo);
      const failedBefore2 = await kY.failed();
      const viewReserve = await kY.required(t2, avail2);
      await S.waitFine(ctx, 'the reference solver quoted first in the window', async () => Boolean(svc.lot()), { timeoutEpochs: 1, throws: false });
      const lotS = svc.lot();
      const quotes = (await kY.swapEvents(qrlFrom)).filter((e) => e.name === 'LotQuoted' && big(e.args.epoch) === t2);
      if (!lotS || !lotS.lotId) {
        ctx.note(`the reference solver did not quote epoch ${t2}: ${svc.lines.filter((l) => /no quote|refuse/.test(l)).join(' | ')}`);
        ctx.check(false, 'OC-SWAP-03: after a success that follows a failure the reference solver quotes the next offering at the reserve that offering holds', { skipped: svc.lines.slice(-3) });
        return;
      }
      const judging = quotes[0];
      ctx.check(
        quotes.length >= 2 && sameAccount(judging.args.solver, svcClient.address) && big(judging.args.value) === 1n && lower(judging.args.lotId) !== lower(lotS.lotId),
        'OC-SWAP-03: the reference solver\'s judging quote of one planck is the offering\'s first, the one that judges the offering before it; its lot is quoted after',
        { first: judging && { lotId: judging.args.lotId, solver: judging.args.solver, value: judging.args.value }, lot: lotS.lotId },
      );
      const failedAfter2 = await kY.failed();
      const reserveFixed = await kY.required(t2, lotS.shares);
      await S.until(ctx, T2.qc);
      await S.waitFine(ctx, `${Y.symbol}'s offering of epoch ${t2} selected`, async () => Boolean((await kY.offering(t2)).selected), { timeoutEpochs: 1 });
      const statusS = await kY.status(lotS.lotId);
      ctx.check(statusS === 'Selected' && lotS.value >= reserveFixed, 'OC-SWAP-03: the reference solver\'s lot at the reserve is selected: it prices from views read after the judgement its own judging quote makes (the missed lock no longer counts as a failure since OC-SWAP-06)', {
        status: statusS,
        quotedValue: lotS.value,
        viewReserveBeforeJudgement: viewReserve,
        reserveFixedByItsQuote: reserveFixed,
        failedOfferingsBefore: failedBefore2,
        failedOfferingsAfter: failedAfter2,
        sold: (await kY.offering(t2)).sold,
      });
    } finally {
      svc.close();
      ctx.sidecars.length = 0;
    }
    await ctx.invariants('end of pre-emption');
  },
};
