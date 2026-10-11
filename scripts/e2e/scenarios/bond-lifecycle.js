/**
 * The bond over its life, as its holders meet it (OC audit 2026-10-03, ECON
 * "On-chain scenarios needed" 1–6, 11, 12): bought junior and senior by
 * holders with keys of their own, past the thirty-day cliff, a coupon
 * distributed from the swap's proceeds and paid to a holding, a holding
 * moved with its cliff and cursor (I20) and the seller's coupon withheld for
 * it, a redemption at maturity with its coupon tail, the run-off gate closed
 * and a maturity cohort drawn from the queue over several epochs around a
 * staking distribution and a trigger draw, the conditional release once the
 * gate reopens, and a keeper gap longer than the bond's close batch.
 *
 * Scenario steps assert the specification. Where an open finding of the
 * round predicts a breach the rule is recorded with `ctx.knownIssue` and the
 * run carries on: OC-ECON-03 (a partial queue draw strands the holding's
 * later staking distribution), OC-ECON-02 (a holding carved after a relief
 * takes it again, short-paying the queue). OC-ECON-05 (a gap of more than 32
 * epochs) is asserted fixed: the relayer closes it with `closeEpochs` itself.
 *
 * Wall clock: 23 epochs measured for steps 1–6 and 11 (the ECON report
 * estimated ≈ 20) — ≈ 2 h 45 min at the rapid profile's 7-minute epochs
 * (rehearsal), ≈ 27 h at the testnet profile's 70 minutes (hoodi-vps). The
 * keeper gap adds 34 epochs and runs on the harness only (≈ 4 h rapid /
 * ≈ 40 h testnet with the relayer stopped, by hand). On the harness the
 * whole run takes about a minute.
 *
 * Non-terminal, but on a live deployment it moves real state: the threat
 * stage walks to 4 and back (governance only), the cohort it queues is
 * three holdings of 1.5 times the book each (`--quantity` QRL per queued
 * holder overrides; smaller, the queue serves the cohort before the draw
 * and the partial-draw rules fail by sizing), and the conditional release
 * returns every principal above the requirement, the deployer's included.
 */
const { ONE, BPS, units } = require('../lib');
const { BondKit, TERM, CLASS, same } = require('../helpers/bond');

const EPOCH_GAP = 34;

module.exports = {
  description: 'bond lifecycle: subscribe junior and senior, past the cliff a coupon is paid, a transfer keeps cliff and cursor (I20), redemption with its tail, the run-off queue drawn over epochs (OC-ECON-02, -03), the conditional release, and a keeper gap (OC-ECON-05)',
  outOfScope: [
    'on a live chain whose parameter set the deployer does not govern (the timelock does): the threat-stage walk, so the run-off gate, the queue and OC-ECON-02/03 are skipped; a vote through the timelock takes its delay',
    'on a live chain: the staking reward is a validator\'s (the harness credits the pool by hand); OC-ECON-03 is measured only where one arrives',
    'on a live chain: the keeper gap of 33+ epochs (OC-ECON-05): ≈ 4 h rapid / 40 h testnet with the relayer stopped, by hand; the harness runs it',
    'I19 per class (paidS ≤ the stated senior rate): the coupon account\'s base by class is not readable, test/ArkCatBond.test.js covers it',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const b = new BondKit(ctx);
    const harness = b.harness;
    const epoch = () => ctx.originEpoch();
    const startEpoch = await epoch();

    /* ------------------------------------------------------------ the book */
    // A position to cover, small against the book so utilisation stays low
    // enough for the conditional release (whitepaper §5.3), and the trigger
    // draw of step 6 has something to determine against.
    await ctx.seedIfNeeded(a);
    const position = await ctx.anchor(a, units(opts.notional, 10));
    await ctx.waitAnchorRecorded(position.id);
    const stopMarket = await b.startPremiumMarket(a, { units: ONE / 2n });

    // The bond refuses issuance while the reference oracle is silent (warm-up,
    // heartbeat, pause; CLAUDE.md item 122): on a fresh live deployment the
    // run waits for the series to answer before subscribing (2026-10-09).
    {
      const o = require('../helpers/oracle').oracleOf(ctx);
      if (o.kind === 'real' && !harness) {
        const zero = ctx.qrl.kind === 'qrl' ? `Q${'00'.repeat(64)}` : `0x${'00'.repeat(20)}`;
        await ctx.waitFor('the reference oracle answering (warm-up over), so subscriptions are open', async () => !(await ctx.qrl.call(o.address, o.abi, 'silent', [0n, zero]))[0], { timeoutEpochs: 8 });
      }
    }
    let s0 = await b.state();
    if (BigInt(s0.juniorPrincipal) + BigInt(s0.seniorPrincipal) === 0n) {
      // A live deployment subscribes no principal unless its manifest names
      // one (deploy.js `bondPrincipalOf`); the run brings its own junior seed,
      // large against the position so utilisation stays low.
      const seedQrl = BigInt(opts.seed || 1000) * ONE;
      const seed = await b.holder('bond-seed', seedQrl);
      await b.subscribe(seed, TERM.YEAR, CLASS.JUNIOR, seedQrl);
      ctx.note(`the book was empty: ${seedQrl / ONE} QRL of junior principal subscribed by the run's own holder (bond-seed)`);
      s0 = await b.state();
    }
    const book = BigInt(s0.juniorPrincipal) + BigInt(s0.seniorPrincipal);
    ctx.check(book > 0n, 'the book has principal to price cover against', { book });
    const seniorQrl = book / 10n;
    const yearQrl = book / 20n;
    // Each queued holder: one and a half times the book, so a slice of the
    // run-off bound (20% of the book at the gate's close) serves the cohort
    // of three over five closes and a draw two closes in finds it partly served.
    const queuedQrl = opts.quantity ? BigInt(opts.quantity) * ONE : (3n * (book + yearQrl)) / 2n;

    /* ------------------------------------------------------------ 1. subscribe, two classes, two holders */
    const sHolder = await b.holder('bond-senior', seniorQrl);
    const yHolder = await b.holder('bond-year', yearQrl);
    const e0 = await epoch();
    const S = await b.subscribe(sHolder, TERM.QUARTER, CLASS.SENIOR, seniorQrl);
    const Y = await b.subscribe(yHolder, TERM.YEAR, CLASS.JUNIOR, yearQrl);
    // Live, the proceeds of a test-sized book do not cover the senior rate,
    // so junior is paid nothing (the waterfall, whitepaper §4.6): a second,
    // smaller senior holding is the one claimed in step 3, the first kept
    // unclaimed for the transfer of step 4 (2026-10-07).
    const sHolder2 = harness ? null : await b.holder('bond-senior-b', seniorQrl / 2n);
    const S2 = harness ? null : await b.subscribe(sHolder2, TERM.QUARTER, CLASS.SENIOR, seniorQrl / 2n);
    // The block's own time is between the head read before the send and the one after.
    const cliffOf = (t) => ctx.clock.epochOf(t + ctx.clock.COUPON_CLIFF) + 1n;
    const after = (await ctx.qrl.head()).timestamp;
    for (const [name, h, term, who] of [['senior quarter', S, 13n, sHolder], ['junior year', Y, 52n, yHolder]]) {
      const c = BigInt(h.cliffEpoch);
      ctx.check(
        c >= cliffOf(h.at) && c <= cliffOf(after) && BigInt(h.claimedThrough) === c - 1n && BigInt(h.maturityEpoch) === e0 + term && same(h.owner, who.address),
        `a subscription (${name}) is the subscriber's, with its cliff at epochOf(now + 30 days) + 1 and its cursor the epoch before (I20, whitepaper §5.3)`,
        { id: h.id, cliff: c, expected: cliffOf(h.at), maturity: h.maturityEpoch, claimedThrough: h.claimedThrough },
      );
    }
    {
      // Junior must stay at its thickness of the pool after a senior subscription (whitepaper §4.6).
      const st = await b.state();
      const pj = BigInt(st.juniorPrincipal);
      const pool = pj + BigInt(st.seniorPrincipal);
      const thick = (pj * BPS) / 7000n - pool + ONE;
      if (BigInt(await ctx.qrl.balance(ctx.qrl.address)) > thick + 10n * ONE) {
        await ctx.refuses('a senior subscription that would take junior below its thickness', 'JuniorTooThin', () =>
          ctx.qrl.call(b.q.ArkCatBond, b.abi.bond, 'subscribe', [TERM.QUARTER, CLASS.SENIOR], { value: thick }),
        );
      }
    }

    // A little principal with staking, so a reward has a position to accrue to.
    if (BigInt(await b.view('placedWithStaking')) === 0n) await ctx.qrl.send(b.q.ArkCatBond, b.abi.bond, 'placeWithStaking', [10n * ONE]);

    // The queued cohort matures one epoch after the senior holding, so the
    // gate can be open at the one maturity and shut at the other.
    await ctx.waitEpochs(1);
    const queued = [];
    for (const label of ['bond-queue-a', 'bond-queue-c', 'bond-queue-q']) {
      const who = await b.holder(label, queuedQrl);
      queued.push({ who, label, ...(await b.subscribe(who, TERM.QUARTER, CLASS.JUNIOR, queuedQrl)) });
    }
    const [A, C, Q] = queued;
    const m = BigInt(A.maturityEpoch);
    ctx.check(m === BigInt(S.maturityEpoch) + 1n && A.shares === Q.shares, 'the queued cohort matures the epoch after the senior holding, its holdings alike', { senior: S.maturityEpoch, cohort: m });
    await ctx.invariants('subscribed');

    /* ------------------------------------------------------------ a staking distribution, before any queue draw */
    let rewards = harness;
    if (harness) {
      const before = BigInt((await b.state()).freePool);
      await b.creditPoolReward(100n * ONE);
      const rise = await b.awaitDistribution('the first staking distribution credited to the holders (whitepaper §3.4)', before);
      ctx.check(rise > 0n, 'a staking reward reaches the holders as the distribution, not the coupon (whitepaper §3.4, I8)', { rise });
    } else {
      ctx.note('live: the staking distribution is whatever the pool\'s validators pay; not forced');
    }

    /* ------------------------------------------------------------ 2–3. past the cliff, the coupon distributed and paid */
    const cliff = BigInt(Y.cliffEpoch);
    let paidEpoch = null;
    let P = { id: Y.id, holder: yHolder, label: 'junior year' };
    await ctx.waitFor(`a coupon epoch at or past the cliff (${cliff}) distributed with proceeds`, async () => {
      const last = BigInt(await b.couponView('lastDistributed'));
      for (let e = cliff; e <= last; e++) {
        if ((await ctx.ledger('deliveredIn', [e])) > 0n) {
          paidEpoch = e;
          if ((await b.couponView('owed', [CLASS.JUNIOR, BigInt(Y.claimedThrough), BigInt(Y.shares)])) > 0n) return true;
          if (S2 && (await b.couponView('owed', [CLASS.SENIOR, BigInt(S2.claimedThrough), BigInt(S2.shares)])) > 0n) {
            P = { id: S2.id, holder: sHolder2, label: 'second senior' };
            return true;
          }
          return false;
        }
      }
      return false;
    }, { timeoutEpochs: Number(cliff - (await epoch())) + (harness ? 6 : 12) });
    if (P.id !== Y.id) ctx.note('live: the proceeds did not reach junior past the senior rate; the coupon is claimed on the second senior holding', { paidEpoch });
    const [baseShares] = await ctx.qrl.call(b.q.ArkBondCoupon, b.abi.coupon, 'baseAt', [paidEpoch]);
    ctx.check(BigInt(baseShares) > 0n, 'the epoch\'s coupon divides over the shares eligible at its boundary, past their cliff (whitepaper §3.4)', { epoch: paidEpoch, baseShares });
    const lastDist = BigInt(await b.couponView('lastDistributed'));
    const y1 = await b.payout(P.holder, 'claim', [P.id]);
    const yAfter = await b.holding(P.id);
    ctx.check(y1.coupon > 0n && BigInt(yAfter.claimedThrough) === lastDist, 'a holding past its cliff is paid the coupon of every distributed epoch since its cursor, and its cursor stands at the last distributed (whitepaper §4.6, I7)', { coupon: y1.coupon, claimedThrough: yAfter.claimedThrough, lastDistributed: lastDist });
    await ctx.refuses('a holding claimed by another account', 'NotHolder', () => b.callAs(sHolder, 'claim', [P.id]));
    await ctx.refuses('principal before maturity: no redemption at par on demand (I9)', 'NotMatured', () => b.callAs(sHolder, 'redeem', [S.id]));

    /* ------------------------------------------------------------ 4. a transfer keeps the cliff and the cursor (I20) */
    const dHolder = await b.holder('bond-buyer');
    const sBefore = await b.holding(S.id);
    const withheld0 = BigInt(await b.couponView('withheldOf', [sHolder.address]));
    const half = BigInt(sBefore.shares) / 2n;
    const D = await b.transfer(sHolder, S.id, dHolder.address, half);
    const sSplit = await b.holding(S.id);
    const dRec = await b.holding(D);
    ctx.check(
      BigInt(dRec.cliffEpoch) === BigInt(sBefore.cliffEpoch) && BigInt(dRec.claimedThrough) === BigInt(sSplit.claimedThrough) && BigInt(dRec.maturityEpoch) === BigInt(sBefore.maturityEpoch) && Number(dRec.class_) === CLASS.SENIOR && same(dRec.owner, dHolder.address),
      'a transfer carries the class, the maturity, the cliff and the coupon cursor; it does not reset the cliff (I20)',
      { cliff: [sBefore.cliffEpoch, dRec.cliffEpoch], claimedThrough: [sSplit.claimedThrough, dRec.claimedThrough] },
    );
    ctx.check(BigInt(dRec.shares) + BigInt(sSplit.shares) === BigInt(sBefore.shares), 'a split moves shares and creates none', { before: sBefore.shares, kept: sSplit.shares, moved: dRec.shares });
    const withheld = BigInt(await b.couponView('withheldOf', [sHolder.address])) - withheld0;
    ctx.check(withheld > 0n, 'the seller\'s coupon earned before the transfer is withheld for it, not lost and not passed to the buyer (whitepaper §3.4)', { withheld });
    await sHolder.send(b.q.ArkBondCoupon, b.abi.coupon, 'withdraw', []);
    ctx.check(BigInt(await b.couponView('withheldOf', [sHolder.address])) === 0n, 'the seller takes the withheld coupon by withdraw', { withheld });

    /* ------------------------------------------------------------ the gate, by the threat stage (governance) */
    const governs = await b.governsParams();
    if (!governs) ctx.note('the deployer does not govern the parameter set: the threat-stage walk, the run-off gate and its queue are out of scope here');
    if (governs) {
      // Stage 4 in force in the cohort's maturity epoch and not in the
      // senior holding's: one vote per epoch, each in force at the next.
      for (const [from, to, at] of [[1, 2, m - 3n], [2, 3, m - 2n], [3, 4, m - 1n]]) {
        if ((await epoch()) < at) await ctx.waitEpochs(Number(at - (await epoch())));
        ctx.check((await epoch()) === at, `the stage vote ${from} -> ${to} lands in epoch ${at}`, { epoch: await epoch() });
        await b.stepStage(from, to);
      }
    }

    /* ------------------------------------------------------------ 5. redemption at maturity, and its coupon tail */
    const sm = BigInt(S.maturityEpoch);
    if ((await epoch()) <= sm) await ctx.refuses('a holding in its maturity epoch is not yet redeemable', 'NotMatured', () => b.callAs(dHolder, 'redeem', [D]));
    await ctx.waitFor(`the senior holding matured (epoch ${sm} closed)`, async () => (await epoch()) > sm, { timeoutEpochs: Number(sm - (await epoch())) + 3 });
    ctx.check(!(await b.state()).gateClosed, 'the gate is open at the close of the senior holding\'s maturity epoch (stage 3 there)', { gate: (await b.state()).gateClosed });
    const sPrincipal = BigInt(await b.view('principalOf', [S.id]));
    const r1 = await b.payout(sHolder, 'redeem', [S.id]);
    ctx.check(r1.principal === sPrincipal && r1.principal > 0n, 'a matured holding redeems its principal at par of what it is worth (whitepaper §5.3)', { paid: r1.principal, principalOf: sPrincipal });
    const r2 = await b.payout(dHolder, 'redeem', [D]);
    ctx.check(r2.principal > 0n, 'the bought half redeems on the seller\'s maturity (I20)', { paid: r2.principal });
    const tail = r1.tails[0];
    ctx.check(Boolean(tail) && tail.through > tail.from, 'the coupon of the epochs still in their settlement windows stays with the redeemed holder, as a tail (whitepaper §4.7)', { tail });
    await ctx.waitFor('the next coupon distribution reaching into the tail', async () => BigInt(await b.couponView('lastDistributed')) > tail.from, { timeoutEpochs: 4 });
    const t1 = await b.payout(sHolder, 'claimTail', [tail.tailId]);
    const tailNow = await b.view('tailOf', [tail.tailId]);
    ctx.check(BigInt(tailNow.shares) === 0n || BigInt(tailNow.fromEpoch) > tail.from, 'a tail is paid as far as distributed and kept for the rest', { paid: t1.coupon, from: tailNow.fromEpoch, through: tailNow.throughEpoch });
    await ctx.invariants('redeemed');

    /* ------------------------------------------------------------ 6. the run-off gate, the queue, a draw */
    let relief = null;
    if (governs) {
      // The cohort enters the queue at the close of its maturity epoch.
      await ctx.waitFor(`the gate closed at the close of epoch ${m} and the cohort queued`, async () => {
        const st = await b.state();
        return st.gateClosed && BigInt(st.queueTotal) > 0n;
      }, { timeoutEpochs: 3 });
      const st = await b.state();
      ctx.check(st.gateClosed && BigInt(st.atGateClose) > 0n, "stage 4 in force closes the run-off gate at the epoch's close (whitepaper §5.3)", { gate: st.gateClosed, atGateClose: st.atGateClose });
      const cohortGate = await b.eventsSince('Queued', BigInt(ctx.r.deployment.deployedFromBlock || 0));
      ctx.check(cohortGate.some((x) => BigInt(x.args.maturityEpoch) === m) && BigInt(st.queueServed) < BigInt(st.queueTotal), 'principal maturing while the gate is shut enters the queue, served by the bound per epoch (whitepaper §5.3, I26)', { queueTotal: st.queueTotal, served: st.queueServed });
      await ctx.refuses('a queued holding is not redeemed at maturity', 'InRunoffQueue', () => b.callAs(A.who, 'redeem', [A.id]));

      // A trigger-1 draw on the cohort once it has one clean epoch of age
      // (weight 1 - decay): at age zero the queue weighs in full and owes no
      // relief. Asserted after the close of epoch m + 1, so the court's open
      // determination does not stop that tick of the clean-age clock.
      const key = await ctx.registry('assetKey', [ctx.r.chainId, ctx.r.evmArg(a.asset)]);
      const lossPayload = async (extra) => {
        const [bufferUnits] = await ctx.qrl.call(ctx.r.q.ArkStakeRegistry, ctx.r.abi.registry, 'bufferOf', [key]);
        const vesting = BigInt(await ctx.registry('vestingBpsOf', [position.id]));
        // `extra` units of bond draw beyond the buffer, at the position's vesting.
        const lossUnits = ((BigInt(bufferUnits) + extra) * BPS + vesting - 1n) / vesting;
        return ctx.encodeQrl(['bytes32[]', 'uint256[]'], [[position.id], [lossUnits]]);
      };
      // The juror pool opened ahead, so the assertion itself waits on nothing but its window.
      {
        const findings = await ctx.court('FINDINGS');
        const fAbi = require('../../lib/chains').iface('ArkCourtFindings', require('../../lib/chains').qrlBuild(ctx.r.manifest.profile));
        const qt = await ctx.qrl.call(findings, fAbi, 'quote', [1, await lossPayload(10n * ONE)]);
        await ctx.openJurorPool(BigInt(qt[2]) * BigInt(qt[4]));
      }
      await ctx.waitFor(`the clean close of epoch ${m + 1n} with the cohort queued`, async () => BigInt((await b.state()).lastClosedEpoch) >= m + 1n, { timeoutEpochs: 3 });
      const { caseId } = await ctx.assertUnchallenged(1, await lossPayload(5n * ONE), 'a trigger-1 loss drawn on the queue');
      const part = await ctx.bond('lossPartOf', [caseId, position.id]);
      ctx.check(BigInt(part.qrl) > 0n, 'the determination draws on bond principal beyond the buffer, junior first (whitepaper §5.2)', { qrl: part.qrl, bufferUnits: part.bufferUnits });

      /* the first draws: A and C, partial; C split after its relief */
      const a1 = await b.payout(A.who, 'claimQueued', [A.id]);
      const aMid = await b.holding(A.id);
      ctx.check(a1.principal > 0n && BigInt(aMid.shares) > 0n, 'a queued holding draws its part of the cohort as far as the queue has reached it, partly (whitepaper §5.3)', { paid: a1.principal, sharesLeft: aMid.shares });
      ctx.check(a1.relief > 0n, 'a draw that found its cohort queued owes the queued holding the part its weight exempts, paid at its next queue draw (I26′)', { relief: a1.relief });
      const c1 = await b.payout(C.who, 'claimQueued', [C.id]);
      ctx.check(c1.relief > 0n && a1.relief === c1.relief, 'two like holdings of one cohort take one relief per share', { a: a1.relief, c: c1.relief });
      const cMid = await b.holding(C.id);
      const nHolder = await b.holder('bond-carved');
      const N = await b.transfer(C.who, C.id, nHolder.address, BigInt(cMid.shares) - 1n);
      const nRec = await b.holding(N);
      ctx.check(BigInt(nRec.reliefCursor) === BigInt(cMid.reliefCursor), 'a carved holding inherits its parent\'s relief cursor: a relief taken is not owed again (I26′)', { parentCursor: cMid.reliefCursor, carvedCursor: nRec.reliefCursor });
      relief = { per: a1.relief, shares: BigInt(A.shares) };

      /* a staking distribution between A's two draws (OC-ECON-03) */
      let rewardRise = 0n;
      if (rewards) {
        await b.payout(yHolder, 'claim', [Y.id]).catch(() => {});
        const before = BigInt((await b.state()).freePool);
        await b.creditPoolReward(100n * ONE);
        rewardRise = await b.awaitDistribution('a second staking distribution, after the partial queue draw', before);
      }

      /* the next epoch's service */
      const servedNow = BigInt((await b.state()).queueServed);
      await ctx.waitFor('the queue served a further slice', async () => BigInt((await b.state()).queueServed) > servedNow, { timeoutEpochs: 3 });
      const n1 = await b.payout(nHolder, 'claimQueued', [N]);
      ctx.check(n1.relief === 0n, 'a holding carved after its parent took the relief takes none of it again (conservation of the relief pot)', { carvedRelief: n1.relief, parentRelief: c1.relief });
      const a2 = await b.payout(A.who, 'claimQueued', [A.id]);
      if (rewards) {
        const y2 = await b.payout(yHolder, 'claim', [Y.id]);
        const yNow = await b.holding(Y.id);
        const fair = (y2.free * BigInt(aMid.shares)) / BigInt(yNow.shares);
        ctx.check(y2.free > 0n, 'the holding that never queued is paid its part of the distribution', { free: y2.free, rise: rewardRise });
        ctx.check(a2.free + fair / 100n >= fair, 'a queued holding after a partial draw earns the staking distribution on the shares it keeps, per share as any other (whitepaper §3.4; conservation of the free pool)', { queuedFree: a2.free, fair, queuedShares: aMid.shares, yShares: yNow.shares, freePool: (await b.state()).freePool });
      }
      const q1 = await b.payout(Q.who, 'claimQueued', [Q.id]);
      const expected = (relief.per * BigInt(Q.shares)) / relief.shares;
      ctx.check(q1.relief + 2n >= expected, 'every queued holding is paid its own relief in full: another holding\'s second take does not come out of it (I26′)', { relief: q1.relief, expected, shortBy: expected - q1.relief });
      await ctx.invariants('queue drawn');

      // The rest of the cohort, so nothing of it is left owed.
      for (const [who, id] of [[A.who, A.id], [C.who, C.id], [nHolder, N], [Q.who, Q.id]]) await b.send(who, 'claimQueued', [id]).catch(() => {});

      /* the gate reopens: stage 4 -> 3, two clear closes */
      await b.stepStage(4, 3);
      await ctx.waitFor('the gate reopened after two clear closes with nothing open (whitepaper §5.3)', async () => !(await b.state()).gateClosed, { timeoutEpochs: 5 });
    }

    /* ------------------------------------------------------------ 11. the conditional release */
    await ctx.waitFor('two closes at low utilisation since the last release (whitepaper §5.3)', async () => Number((await b.state()).belowEpochs) >= 2, { timeoutEpochs: 4 });
    const util = BigInt(await b.view('utilisationBps'));
    ctx.check(util > 0n && util <= 2500n, 'utilisation is measured and below the release threshold', { utilisationBps: util });
    const outBefore = BigInt(await b.view('outstandingPrincipal'));
    // R27: an operating epoch is one whose coupon was paid without a shortfall.
    // A test-sized live book never covers the senior rate, so every epoch has a
    // shortfall and the release is refused NoOperatingEpoch, the safe direction
    // (hoodi-vps, 2026-10-11). Asserted as that refusal live; the release
    // itself is the harness's.
    if (!harness) {
      const r27 = await ctx.qrl.call(b.q.ArkCatBond, b.abi.bond, 'conditionalRelease', []).then(() => null, (e) => e);
      if (r27 && /NoOperatingEpoch|0x4a752756/.test(String(r27.message) + JSON.stringify(r27.data || ''))) {
        ctx.check(true, 'live: no epoch closed in the operating range (coupon paid without a shortfall, R27), so the conditional release is refused NoOperatingEpoch', { lastOperatingEpoch: String(await b.couponView('lastOperatingEpoch')) });
        ctx.note('out of scope live: the conditional release itself (a test-sized book pays every coupon short of the senior rate, so R27 never holds); test/ArkCatBond.test.js covers it');
        return;
      }
    }
    const rel = await ctx.qrl.send(b.q.ArkCatBond, b.abi.bond, 'conditionalRelease', []);
    const [ev] = b.events(rel, 'ConditionalReleased');
    ctx.check(Boolean(ev), 'the conditional release runs once the measured condition holds, never on request of an amount (whitepaper §5.3, I10)');
    const released = BigInt(ev.args.junior) + BigInt(ev.args.senior);
    const outAfter = BigInt(await b.view('outstandingPrincipal'));
    ctx.check(released > 0n && outBefore - outAfter <= released, 'principal above the requirement is returned pro rata, and principal falls by no more than it', { released, outBefore, outAfter });
    await ctx.refuses('a second release before two more low closes', 'UtilisationNotLow', () => ctx.qrl.call(b.q.ArkCatBond, b.abi.bond, 'conditionalRelease', []));
    const y3 = await b.payout(yHolder, 'claim', [Y.id]);
    ctx.check(y3.release > 0n, 'a holder takes its released principal by claim', { release: y3.release });
    await ctx.invariants('released');

    /* ------------------------------------------------------------ 12. a keeper gap longer than the close batch */
    stopMarket();
    ctx.note(`steps 1–6 and 11 took ${(await epoch()) - startEpoch} epochs`);
    if (!harness) {
      ctx.note('live: the keeper gap is run by hand with the relayer stopped; skipped');
      return;
    }
    const before = BigInt(await b.couponView('lastDistributed'));
    await ctx.sleep(Number(ctx.clock.EPOCH_LENGTH) * EPOCH_GAP);
    ctx.note(`the keeper was off for ${EPOCH_GAP} epochs (harness clock)`);
    const next = before + 1n;
    await ctx.refuses('after a gap longer than 32 epochs a distribution cannot close the book in one batch', 'EpochGapTooLong', () =>
      ctx.qrl.call(b.q.ArkBondCoupon, b.abi.coupon, 'distribute', [next]),
    );
    await ctx.refuses('and every exit waits on it: a claim of the queue, a transfer, a redemption', 'EpochGapTooLong', () => b.callAs(yHolder, 'transferHolding', [Y.id, yHolder.address, 1n]));
    await ctx.invariants('keeper gap');
    await ctx.tick();
    const afterTick = BigInt(await b.couponView('lastDistributed'));
    ctx.check(afterTick > before, 'the keeper recovers a gap longer than the close batch by itself (closeEpochs while behind, OC-ECON-05)', { lastDistributed: afterTick, before });
    while ((await epoch()) - BigInt((await b.state()).lastClosedEpoch) > 1n) await ctx.qrl.send(b.q.ArkCatBond, b.abi.bond, 'closeEpochs', [32n]);
    ctx.check(BigInt((await b.state()).lastClosedEpoch) + 1n === (await epoch()), 'closeEpochs closes the gap in batches, by anyone', { lastClosed: (await b.state()).lastClosedEpoch });
    await ctx.waitFor('the coupon distributed again once the book is closed', async () => BigInt(await b.couponView('lastDistributed')) > before, { timeoutEpochs: 2 });
    ctx.check(BigInt(await b.couponView('lastDistributed')) > before, 'after closeEpochs the keeper distributes again', { lastDistributed: await b.couponView('lastDistributed') });
  },
};
