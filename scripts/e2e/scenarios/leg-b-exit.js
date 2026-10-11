/**
 * Leg B, the way out of QRL staking (OC audit 2026-10-03, LEG-B REPORT.md
 * "On-chain scenarios needed" S11 and S12), and the three open findings of
 * that path driven to their measured effect: OC-LEGB-04 (a dust shortfall
 * forces the exit of any validator and hands its operator bond to the
 * holders), OC-LEGB-03 (a slashing forfeit is paid at once and the loss
 * booked weeks later, so a holder leaving in between takes the gain and none
 * of the loss), OC-LEGB-01 (exited principal forwarded as a provisional
 * distribution leaves the delegation insolvent at the report).
 *
 * TERMINAL, and harness-oriented. On the harness it ends with the delegation
 * insolvent (OC-LEGB-01) and both validators' operator bonds forfeited: pool
 * withdrawals that need idle principal revert for good. Scenario steps assert
 * the specification; where an open finding predicts a breach the rule is
 * recorded with `ctx.knownIssue` and the run carries on.
 *
 * On a live chain nothing here is driven: a validator's exit, a slashing and
 * a withdrawal sweep are beacon-chain facts the harness stands in for
 * (helpers/leg-b.js), and synthetic deposit data would lock 40,000 QRL in a
 * validator that never runs. The live run is the read-only half — the
 * refusals of an exit and a recall without a shortfall, the venue solvency
 * predicate, the QL-13 watch, the QL-11 early warning and the exit-deadline
 * span against the beacon chain's eligibility — and takes minutes.
 *
 * Wall clock on the harness's clock: about 9 epochs — two funding epochs,
 * the exit deadline (2), two reports each standing a challenge window, and
 * one closing epoch. Were it driven at the rapid profile (7-minute epochs)
 * ≈ 65 min; at the testnet profile (70-minute epochs) ≈ 10 h 30 min. The
 * live read-only run: a few minutes at either profile. On the harness the
 * run takes under a minute.
 */
const { ONE } = require('../lib');
const { LegB, STATUS, FORFEIT, VALIDATOR, lower } = require('../helpers/leg-b');

/** The beacon chain's wait between activation and a voluntary exit: SHARD_COMMITTEE_PERIOD of 256 epochs is 16 × 128 × 12 s on the devnet (LEG-B OC-LEGB-04). */
const SHARD_COMMITTEE_PERIOD_SECONDS = 16n * 128n * 12n;

const BASE_OUT = [
  'S11.1 S.recall -> Requested(id, 1, x) and S11.3 placed falls after the claim: a recall needs the bond\'s principal owed now above its liquid cover (maturity redemptions beyond the principal left unplaced, whitepaper §3.4); not reachable in a harness run of reasonable length beside this one. The refusal without a shortfall (NoShortfall) is asserted instead, and the exit itself is driven through pool.requestExit (OC-LEGB-04)',
  'OC-LEGB-02, -05, -06, -12 and S1-S10: leg-b-live.js',
];
const OUT = [...BASE_OUT];

module.exports = {
  description: 'Leg B exit (OC LEG-B S11, S12): a dust shortfall forcing a validator\'s exit (OC-LEGB-04), a slashing paid before its loss is booked (OC-LEGB-03), the staking loss carried to the bond (syncLoss, PrincipalLost), and exited principal forwarded as distribution (OC-LEGB-01)',
  terminal: true,
  outOfScope: OUT,
  async run(ctx) {
    OUT.length = BASE_OUT.length;
    const out = (s) => {
      if (!OUT.includes(s)) OUT.push(s);
    };
    const lb = new LegB(ctx);
    const q = ctx.r.q;
    const E = BigInt(ctx.clock.EPOCH_LENGTH);
    const startEpoch = await lb.epoch();
    const X = BigInt((await lb.view('Pa', 'params')).exitDeadlineEpochs);
    const ELIGIBLE = await lb.big('D', 'ELIGIBLE_EPOCHS');
    ctx.note(`${lb.live ? 'live QRL client' : 'harness'}; epoch ${E} s; exit deadline ${X} epoch(s) from exit eligibility, ${ELIGIBLE} epoch(s) after funding`);

    // The deadline span against the beacon chain's exit eligibility (OC-LEGB-04), both legs: a parameter probe.
    ctx.check((ELIGIBLE + X) * E >= SHARD_COMMITTEE_PERIOD_SECONDS && ELIGIBLE * E >= SHARD_COMMITTEE_PERIOD_SECONDS, 'an exit deadline is never shorter than the beacon chain\'s exit eligibility after activation (SHARD_COMMITTEE_PERIOD)', { deadlineSeconds: (ELIGIBLE + X) * E, eligibleSeconds: ELIGIBLE * E, shardCommitteePeriodSeconds: SHARD_COMMITTEE_PERIOD_SECONDS });

    if (!lb.harness) {
      await liveProbes(ctx, lb, out);
      return;
    }

    /* ================================================== the pool and its two validators */
    lb.installDepositRoot();
    const A = await ctx.actor('legb-holder-a', { fund: 40_001n * ONE });
    const B = await ctx.actor('legb-holder-b', { fund: 40_001n * ONE });
    const M = await ctx.actor('legb-mallory', { fund: ONE });
    const operator = (await ctx.actor('legb-operator')).address;
    ctx.check((await lb.big('D', 'principal')) === 0n, 'a fresh delegation: no principal placed yet', {});
    await lb.send('P', 'deposit', [], { as: A, value: VALIDATOR });
    await lb.send('P', 'deposit', [], { as: B, value: VALIDATOR });
    const d1 = await lb.depositData(0);
    const d2 = await lb.depositData(1);
    await lb.admit(d1, operator, 'leg-b-exit v1');
    await lb.admit(d2, operator, 'leg-b-exit v2');
    const f1 = await lb.delegate(d1);
    await lb.untilEpoch('the next epoch: one deposit check per epoch (OC-LEGB-02)', f1.epoch + 1n);
    const f2 = await lb.delegate(d2);
    await lb.send('P', 'roll', [], { as: A });
    await lb.send('P', 'roll', [], { as: B });
    ctx.check((await lb.big('D', 'idle')) === 0n && (await lb.big('D', 'activeValidators')) === 2n, 'two validators funded from 80,000 QRL of deposits: nothing idle', { idle: await lb.big('D', 'idle'), funded: [f1.epoch, f2.epoch] });

    /* ================================================== S11 the exit (OC-LEGB-04) */
    await ctx.refuses('S11.2 an exit requested while the queue is covered', 'NoShortfall', () => lb.call('P', 'requestExit', [], { from: M.address }));
    await ctx.refuses('S11.1 a recall while the bond\'s principal owed is covered by its own balance', 'NoShortfall', () => lb.call('S', 'recall', [ONE]));
    const dust = 10n ** 9n;
    const rq = await lb.send('P', 'requestWithdrawal', [dust], { as: A });
    const [dustReq] = lb.decode('P', rq.logs, 'WithdrawalRequested');
    const dustId = BigInt(dustReq.args.requestId);
    ctx.check(lb.decode('P', rq.logs, 'WithdrawalSettled').length === 0, 'a request the pool cannot pay from its balance or idle principal waits in the queue', { requestId: dustId, shares: dust });
    // What the waiting request is worth: the pool's own conversion, shares × (value + 1) / (shares + OFFSET).
    const owedDust = (dust * ((await lb.big('P', 'totalValue')) + 1n)) / ((await lb.big('P', 'totalShares')) + (await lb.big('P', 'OFFSET')));
    const dustExit = await lb.outcome(() => lb.call('P', 'requestExit', [], { from: M.address }));
    ctx.check(dustExit !== null && dustExit.includes('NoShortfall'), 'a dust shortfall cannot force the exit of a whole validator, least of all one funded this or the last epoch (the shortfall must reach half a stake; the pool picks the oldest)', {
      requestedShares: dust,
      owedValueWei: owedDust,
      validatorStake: VALIDATOR,
      fundedEpoch: f1.epoch,
      refused: dustExit,
    });
    // Half a stake and more owed: A asks for half its holding (20,000 QRL).
    const rqHalf = await lb.send('P', 'requestWithdrawal', [(await lb.big('P', 'sharesOf', [A.address])) / 2n], { as: A });
    const halfId = BigInt(lb.decode('P', rqHalf.logs, 'WithdrawalRequested')[0].args.requestId);
    const exitEpoch = await lb.epoch();
    const re = await lb.send('P', 'requestExit', [], { as: M });
    const [ex] = lb.decode('D', re.logs, 'ExitRequested');
    const deadline = await lb.big('D', 'exitDeadlineEpoch', [d1.pkh]);
    const eligibleAt = f1.epoch + ELIGIBLE;
    ctx.check(ex && lower(ex.args.pubkeyHash) === lower(d1.pkh) && BigInt(ex.args.epoch) === exitEpoch && deadline === (eligibleAt > exitEpoch ? eligibleAt : exitEpoch) + X && (await lb.big('D', 'exitsPending')) === VALIDATOR, 'S11.2 with a shortfall of half a stake, requestExit exits the oldest validator: ExitRequested, exitDeadlineEpoch = max(e, funded + ELIGIBLE_EPOCHS) + exitDeadlineEpochs, its stake pending exit (OC-LEGB-04)', { epoch: exitEpoch, fundedEpoch: f1.epoch, deadline, exitsPending: await lb.big('D', 'exitsPending') });

    // Capital for the rest of the run: a team deposit leaves principal idle,
    // the queue settles, and a little bond principal joins the pool so the
    // loss has a bond position to reach (S12).
    await lb.send('P', 'deposit', [], { value: 100_000n * ONE });
    await lb.send('P', 'settle', [16n]);
    const dustSettled = (await lb.events('P', 'WithdrawalSettled', rq.blockNumber)).find((x) => BigInt(x.args.requestId) === dustId);
    ctx.check(Boolean(dustSettled), 'once principal is idle the waiting request settles, in order', { requestId: dustId });
    await lb.send('P', 'claimWithdrawal', [dustId], { as: A });
    await lb.send('P', 'claimWithdrawal', [halfId], { as: A });
    const placeWhy = await lb.outcome(() => lb.call('B', 'placeWithStaking', [1_000n * ONE]));
    ctx.check(placeWhy === null, 'the bond can place idle principal with staking (permissionless)', { refused: placeWhy });
    await lb.send('B', 'placeWithStaking', [1_000n * ONE]);
    const placedAt = await lb.epoch();

    /* ================================================== the first report: V1 past its deadline, V2 slashed */
    const r1 = deadline > placedAt + 1n ? deadline : placedAt + 1n;
    await lb.untilEpoch(`the exit deadline (${deadline}), with the bond's placement converted`, r1);
    await lb.send('P', 'roll', []);
    const line1 = await lb.reportOf(r1, d1.pkh, STATUS.active, 0n);
    const line2 = await lb.reportOf(r1, d2.pkh, STATUS.slashed, 0n, { slashed: true });
    const rep1 = await lb.sealReport(r1, [line1, line2]);
    const slashedSince = rep1.noted.blockNumber;
    ctx.note(`report of epoch ${r1} sealed and noted: validator 1 still active at its deadline, validator 2 slashed (public from now)`);
    await lb.untilCleared(r1);
    const vA0 = await lb.poolValue(A.address);
    const vB0 = await lb.poolValue(B.address);
    const rc1 = await lb.send('D', 'reconcile', [line1, rep1.proof(rep1.leaves[0])], { as: M });
    const [ff1] = lb.decode('D', rc1.logs, 'BondForfeited');
    const gainA = (await lb.poolValue(A.address)) - vA0;
    const gainB = (await lb.poolValue(B.address)) - vB0;
    ctx.check(ff1 && Number(ff1.args.reason) === FORFEIT.deadline, 'S11.2 a validator not exited by its deadline forfeits the operator bond to the pool (whitepaper §3.4)', { event: ff1 && ff1.args });
    ctx.check(deadline >= f1.epoch + ELIGIBLE + X && r1 >= deadline, 'the operator is not penalised for a deadline that fell before the validator could exit (activation + SHARD_COMMITTEE_PERIOD); the quorum, not the operator, broadcasts the exit', {
      forfeited: ff1 && ff1.args.amount,
      deadlineEpoch: deadline,
      reportEpoch: r1,
      eligibleEpoch: f1.epoch + ELIGIBLE,
      fundedEpoch: f1.epoch,
      forcingHolderGainWei: gainA,
      otherHolderGainWei: gainB,
    });
    const rc2 = await lb.send('D', 'reconcile', [line2, rep1.proof(rep1.leaves[1])], { as: M });
    const [ff2] = lb.decode('D', rc2.logs, 'BondForfeited');
    const [rl2] = lb.decode('D', rc2.logs, 'Reconciled');
    ctx.check(ff2 && Number(ff2.args.reason) === FORFEIT.slashed && rl2 && Number(rl2.args.status) === STATUS.slashed && (await lb.big('D', 'slashedOpen')) === 1n, 'a slashing report forfeits the slashed validator\'s operator bond, held at the delegation until the close (whitepaper §3.4; OC-LEGB-03)', { event: ff2 && ff2.args });
    ctx.check(lb.decode('D', rc2.logs, 'StakeLost').length === 0, 'the slashing\'s loss is not known until the validator\'s withdrawals are done', {});

    /* ================================================== OC-LEGB-03: a holder leaves before the loss is booked */
    const tvExit = await lb.big('P', 'totalValue');
    const tsExit = await lb.big('P', 'totalShares');
    const sharesA = await lb.big('P', 'sharesOf', [A.address]);
    const ra = await lb.send('P', 'requestWithdrawal', [sharesA], { as: A });
    const [reqA] = lb.decode('P', ra.logs, 'WithdrawalRequested');
    const reqAId = BigInt(reqA.args.requestId);
    ctx.check(lb.decode('P', ra.logs, 'WithdrawalSettled').length === 0, 'a holder\'s withdrawal waits while a slashed validator is open (bunker, OC-LEGB-03): its shares keep bearing loss', { requestId: reqAId });

    /* ================================================== the sweep, forwarded (OC-LEGB-01) */
    const swept = 30_000n * ONE;
    await lb.credit(q.ArkBondDelegation, swept);
    ctx.note(`stand-in: the slashed validator's remaining ${swept / ONE} QRL swept to the delegation (harness credit)`);
    const distributed0 = await lb.big('D', 'distributed');
    const pdWhy = await lb.outcome(() => lb.call('D', 'distributeProvisional', [], { from: M.address }));
    let pd = null;
    if (pdWhy === null) [pd] = lb.decode('D', (await lb.send('D', 'distributeProvisional', [], { as: M })).logs, 'ProvisionallyDistributed');
    ctx.check(!pd, 'exited principal that no report has classified is not forwarded as distribution (I32 covers rewards only)', { forwarded: pd && pd.args.amount, cap: pd && pd.args.cap, refused: pdWhy, by: M.address });

    /* ================================================== S12 the staking loss */
    const r2 = await lb.epoch();
    const line3 = await lb.reportOf(r2, d2.pkh, STATUS.done, swept, { slashed: true, exitInitiated: r1 });
    const rep2 = await lb.sealReport(r2, [line3]);
    await lb.untilCleared(r2);
    const sharesB = await lb.big('P', 'sharesOf', [B.address]);
    const vB1 = await lb.poolValue(B.address);
    const vS1 = await lb.poolValue(q.ArkBondStaking);
    const st0 = await lb.view('B', 'state');
    const placed0 = BigInt((await ctx.qrl.call(q.ArkCatBond, lb.abi('B'), 'placedWithStaking'))[0]);
    const principal0 = await lb.big('D', 'principal');
    const rc3 = await lb.send('D', 'reconcile', [line3, rep2.proof(rep2.leaves[0])], { as: M });
    const [lost] = lb.decode('D', rc3.logs, 'StakeLost');
    const [rl3] = lb.decode('D', rc3.logs, 'Reconciled');
    const loss = lost ? BigInt(lost.args.loss) : 0n;
    ctx.check(
      rl3 && BigInt(rl3.args.principalReturned) === swept && lost && loss === VALIDATOR - swept && (await lb.big('D', 'principal')) === principal0 - loss,
      'S12.1 a short WITHDRAWAL_DONE report books the loss: StakeLost(stake − returned) and principal written down by it (I21)',
      { reconciled: rl3 && rl3.args, loss, principal0, principal1: await lb.big('D', 'principal') },
    );
    const forwarded = (await lb.big('D', 'distributed')) - distributed0;
    const sv = await lb.solvency();
    ctx.check(sv.ok, 'the delegation stays solvent once the report reclassifies the swept amount as principal: balance ≥ idle + bonds + refunds', { ...sv, forwardedSinceSweep: forwarded });
    const wB = await lb.outcome(() => lb.call('P', 'requestWithdrawal', [sharesB], { from: B.address }));
    ctx.check(wB === null, 'a holder\'s withdrawal that needs idle principal still settles after a validator closes', { refused: wB, short: sv.short });

    const vB2 = await lb.poolValue(B.address);
    const vS2 = await lb.poolValue(q.ArkBondStaking);
    // Pro rata: every holder's position falls by the same fraction (to the wei of rounding).
    const dropB = ((vB1 - vB2) * 10n ** 18n) / vB1;
    const dropS = ((vS1 - vS2) * 10n ** 18n) / vS1;
    const near = (x, y) => (x > y ? x - y : y - x) <= 10n ** 9n;
    ctx.check(vB2 < vB1 && near(dropB, dropS), 'S12.3 the loss falls on the pool\'s holders pro rata: the bond\'s position and a holder\'s fall by the same fraction', { holder: { before: vB1, after: vB2 }, bond: { before: vS1, after: vS2 }, dropB, dropS });
    const backing = vS2 + (await lb.big('S', 'principalInFlight'));
    // Carried in the reconcile transaction itself: the pool passes the
    // delegation's syncLoss to the bond's staking contract (OC-LEGB-13).
    const [lr] = lb.decode('S', rc3.logs, 'LossRecorded');
    const [pl] = lb.decode('B', rc3.logs, 'PrincipalLost');
    const st1 = await lb.view('B', 'state');
    const pr = (s) => BigInt(s.juniorPrincipal) + BigInt(s.seniorPrincipal);
    const placed1 = BigInt((await ctx.qrl.call(q.ArkCatBond, lb.abi('B'), 'placedWithStaking'))[0]);
    const sl = await lb.send('S', 'syncLoss', []);
    ctx.check(
      lr && BigInt(lr.args.amount) === placed0 - backing && pl && BigInt(pl.args.amount) === BigInt(lr.args.amount) && pr(st0) - pr(st1) === BigInt(pl.args.amount) && placed0 - placed1 === BigInt(pl.args.amount) && lb.decode('S', sl.logs, 'LossRecorded').length === 0,
      'S12.2 the loss reaches the bond in the reconcile transaction (OC-LEGB-13): LossRecorded(placed − backing), PrincipalLost, bond principal and placed principal lowered by it, and a later syncLoss finds nothing left (whitepaper §3.4)',
      { lossRecorded: lr && lr.args.amount, principalLost: pl && pl.args.amount, bondPrincipal: { before: pr(st0), after: pr(st1) }, placed: { before: placed0, after: placed1 }, backing },
    );

    /* ================================================== OC-LEGB-03 measured */
    // A's request waited out the bunker; it settles now, after the close.
    let setA = (await lb.events('P', 'WithdrawalSettled', ra.blockNumber)).find((x) => BigInt(x.args.requestId) === reqAId);
    if (!setA) {
      await lb.send('P', 'settle', [16n]);
      setA = (await lb.events('P', 'WithdrawalSettled', ra.blockNumber)).find((x) => BigInt(x.args.requestId) === reqAId);
    }
    const paidA = setA ? BigInt(setA.args.amount) : 0n;
    if (setA) await lb.send('P', 'claimWithdrawal', [reqAId], { as: A });
    // Fair: had the loss been booked with the slashing, every share would be
    // worth (value at A's exit − the loss + the forfeit held against it) /
    // shares at A's exit.
    const held = ff2 ? BigInt(ff2.args.amount) : 0n;
    const fairA = (sharesA * (tvExit - loss + held)) / tsExit;
    const perShareA = (paidA * 10n ** 18n) / sharesA;
    const perShareB = (vB2 * 10n ** 18n) / sharesB;
    ctx.check(Boolean(setA) && paidA <= fairA + 10n ** 9n, 'a holder who leaves between a slashing report and the validator\'s close bears its share of the loss: paid no more than its shares are worth once the loss is booked (I21, holder fairness)', {
      paidA,
      fairA,
      excessToA: paidA - fairA,
      perShareA,
      perShareBAfterLoss: perShareB,
      loss,
      forfeitsPaid: (ff1 ? BigInt(ff1.args.amount) : 0n) + (ff2 ? BigInt(ff2.args.amount) : 0n),
    });
    const settledBetween = (await lb.events('P', 'WithdrawalSettled', slashedSince)).filter((x) => x.blockNumber < rc3.blockNumber && x.blockNumber >= rc2.blockNumber);
    ctx.check(settledBetween.length === 0, 'QL-13 watch: no withdrawal settles between a slashed Reconciled and that validator\'s StakeLost (the pool is in bunker mode)', { settledBetween: settledBetween.length, slashedAt: rc2.blockNumber, lostAt: rc3.blockNumber });

    const led = await lb.ledger();
    ctx.check(led.ok, 'D ledger: Σ(stake − returned) over open validators is delegated, their count activeValidators, the exiting part exitsPending', led);

    // The I32 sub-check of invariants.js compares provisionalPaid with the
    // cap read NOW; a validator closing mid-epoch halves the cap after the
    // epoch's forward was made within it. Recorded here as observed, then the
    // run ends in the next epoch so the closing check reads a fresh epoch.
    const paidNow = await lb.big('D', 'provisionalPaid');
    const capNow = await lb.big('D', 'rewardCap');
    if ((await lb.big('D', 'provisionalEpoch')) === (await lb.epoch()) && paidNow > capNow) {
      ctx.note('observation (not a documented finding): provisionalPaid exceeds rewardCap() after a validator closed mid-epoch; the forward was within the cap when made (invariants.js I32 reads the cap at check time)', { provisionalPaid: paidNow, rewardCapNow: capNow, activeValidators: await lb.big('D', 'activeValidators') });
      await ctx.invariants('after the close, same epoch');
      await lb.untilEpoch('the next epoch, whose cap is read at the same validator count it is paid against', (await lb.epoch()) + 1n);
    }
    ctx.note(`ran over epochs ${startEpoch}..${await lb.epoch()} (${(await lb.epoch()) - startEpoch + 1n} epochs)`);
  },
};

/** The read-only half, for a live chain. */
async function liveProbes(ctx, lb, out) {
  out('everything driven (two validators funded, an exit forced by a dust request, a slashing, a sweep and its report): a live chain\'s exits, slashings and sweeps are beacon-chain facts, and synthetic deposit data would lock 40,000 QRL in a validator that never runs; harness only (ARK_E2E_CHAIN=local-*)');
  const funded = await lb.events('D', 'Delegated');
  const open = [];
  for (const x of funded) {
    const v = await lb.view('D', 'validatorOf', [x.args.pubkeyHash]);
    if (!v.closed && BigInt(v.exitRequestedEpoch) === 0n) open.push(x.args.pubkeyHash);
  }
  if (open.length) {
    const got = await lb.outcome(() => lb.call('P', 'requestExit', []));
    ctx.check(got !== null && (got.includes('NoShortfall') || got.includes('OnlyBond')), 'S11.2 an exit is refused unless the pool\'s queue is short (NoShortfall)', { validator: open[0], refused: got });
    if (got === null) ctx.note('the pool is short of its queue: an exit could be requested now (not sent)');
  } else {
    ctx.note('no open validator without an exit request: the requestExit refusal has nothing to name');
  }
  const recall = await lb.outcome(() => lb.call('S', 'recall', [ONE]));
  if (recall !== null) ctx.check(recall.includes('NoShortfall'), 'S11.1 a recall is refused while the bond\'s principal owed is covered by its own balance', { refused: recall });
  else ctx.note('the bond\'s principal owed exceeds its liquid cover: a recall would be accepted now (not sent)');
  const sv = await lb.solvency();
  ctx.check(sv.ok, 'venue solvency: balance ≥ idle + bonds + refunds + reconciled-unpaid', sv);
  if (sv.distributed > sv.distributionReconciled) {
    const withPrincipal = (await lb.events('D', 'Reconciled')).filter((x) => BigInt(x.args.principalReturned) > 0n);
    ctx.note(`QL-11 early warning: distributed exceeds distributionReconciled by ${sv.distributed - sv.distributionReconciled} wei; ${withPrincipal.length} report(s) returned principal`);
  }
  const slashed = (await lb.events('D', 'Reconciled')).filter((x) => [STATUS.slashed, STATUS.exitedSlashed].includes(Number(x.args.status)));
  const lostKeys = new Set((await lb.events('D', 'StakeLost')).map((x) => lower(x.args.pubkeyHash)));
  const settled = await lb.events('P', 'WithdrawalSettled');
  for (const s of slashed) {
    const between = lostKeys.has(lower(s.args.pubkeyHash)) ? [] : settled.filter((w) => w.blockNumber > s.blockNumber);
    ctx.check(between.length === 0, 'QL-13 watch: no withdrawal settles between a slashed Reconciled and that validator\'s StakeLost', { validator: s.args.pubkeyHash, settledSince: between.length });
  }
  if (!slashed.length) ctx.note('QL-13 watch: no slashing reported on this deployment');
  const led = await lb.ledger();
  ctx.check(led.ok, 'D ledger: Σ(stake − returned) over open validators is delegated, their count activeValidators, the exiting part exitsPending', led);
}
