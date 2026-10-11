/**
 * The atomic premium swap off its happy path, on both legs (audit round OC,
 * 2026-10-03, docs/review/audit-2026-10-03/SWAP/REPORT.md): every way a
 * selected lot can end other than "claimed in time", and the invariants that
 * must hold across all of them.
 *
 * One offering, five lots, each a solver account of its own:
 *   H  quoted with QRL above what the swap computes, claimed on the origin
 *      chain, carried by the relayer (the reference against which the rest
 *      are measured; S1 itself is atomic-yield-flow and solver-service);
 *   N  selected and never claimed (S2: no-show -> refund + forfeit), and
 *      refused on the origin chain at evmExpiry (S3a);
 *   R  revealed on the origin chain 60 s before evmExpiry with the relayer's
 *      carry withheld past the claim margin (S3b): LotExpired on QRL, its QRL
 *      refunded, the relayer raising ALARM once the preimage reaches it late;
 *   A  the reference solver service, killed right after its origin claim
 *      landed and restarted before evmExpiry (S4a: ProofSpent recognised, the
 *      solver carries its own preimage), then killed between its QRL claim and
 *      the receipt (S4c: Claimed -> bond back once);
 *   B  the same service killed after its origin claim, restarted after
 *      evmExpiry (S4b: the escrow's isSpent tells it its claim landed, and it
 *      carries its preimage; before the fix of OC-SWAP-04 it refunded instead).
 * For R, A and B the relayer's own carry is withheld (the report's "relayer
 * carry off"); the escrow, the relay and the swap are untouched.
 *
 * Then the coupon of the epoch (I7, I33.5 event order), and one epoch more for
 * the batching watch of OC-SWAP-02: the offer two epochs on, made after the
 * offering sold, opens an offering where fresh premium above the threshold
 * arrived (before the fix it was carried).
 *
 * Probes asserted on the way: I31.1-5, I33.1-6, I7.1-5. Open findings are
 * recorded with `knownIssue` (OC-SWAP-01 and -05, the relayer's) so a live
 * run reproduces them and carries on; OC-SWAP-02 and -04 are fixed and
 * checked.
 *
 * Wall clock, from a fresh epoch: the offered epoch t, its quote window at the
 * end of t+1, settlement through t+2 and the offer of t+2 recorded early in
 * t+3 — about 3.5 epochs: ~25-30 min on the rehearsal chain (rapid profile,
 * 7-minute epochs), ~4-4.5 h on hoodi-vps (testnet profile, 70-minute
 * epochs). About two minutes on the local harness.
 */
const { ONE, units } = require('../lib');
const { Solver } = require('../../../ecdsa-stakings/relayer/engine/solver');
const S = require('../helpers/swap');

const { big, lower, sameAccount } = S;

module.exports = {
  description: 'the premium swap off its happy path: a no-show refunded and its bond forfeited, a late preimage expired on both legs, a solver crashed mid-claim and restarted before and after evmExpiry, a crash mid-carry; I31/I33/I7 probes, the coupon, and the batching watch',
  outOfScope: [
    'S1, the happy swap: atomic-yield-flow and solver-service',
    'S5, root pre-emption with two assets, and its cascade: swap-preemption (its cascade would forfeit the bonds of every later offering of this run)',
    'OC-SWAP-03, a reference solver pricing from stale views after a success that follows a failure: swap-preemption, which has that history',
    'SWAPGOV-11, a failed offering carried past the four-epoch bound: needs five offers with no new premium after a failure (about seven epochs)',
    'OC-SWAP-06..09: a strategic default needs a second solver competing over three offerings; a zero epochPrice, a declaration mid-claim and a QRL regeneration are not this run\'s to cause',
    'the run assumes no other solver quotes the offering (stop ark-solver.service on the host): a better outside quote would push the five lots out of what the offering may sell',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const k = S.swapKit(ctx, a);
    const q = k.q;
    const yieldUnits = units(opts.quantity, 40);
    const qrlFrom = (await ctx.qrl.head()).latest;
    const originFrom = (await ctx.origin.head()).latest;
    const state = () => ctx.r.state.data;
    const spent = async (leaf) => Boolean(await a.call('isSpent', [leaf]));
    const tsQ = async (block) => big(await ctx.qrl.timestampOf(block));

    /* ------------------------------------------------------------ the offering */
    const { offerings } = await S.openOfferings(ctx, [a], { notional: units(opts.notional, 1000), yieldUnits });
    const t = offerings[0].t;
    const T = k.times(t);
    ctx.note(`offering ${t}: quote [${T.qo}, ${T.qc}), evmExpiry ${T.evmExpiry}, qrlExpiry ${T.qrlExpiry}`);

    // I31.1: the timetable relations, read from the contract.
    const tt = await k.timetable(t);
    const tn = await k.timetable(t + 1n);
    ctx.check(tt.quoteOpens === T.qo && tt.quoteCloses === T.qc && tt.evmExpiry === T.evmExpiry && tt.qrlExpiry === T.qrlExpiry, 'the relayer and the solvers number the four instants of an offering exactly as the swap does', { contract: tt, clock: T });
    ctx.check(
      tt.evmExpiry < tt.qrlExpiry && tt.qrlExpiry - tt.evmExpiry >= ctx.clock.ADMISSION_WINDOW + ctx.clock.EVM_CLAIM_WINDOW && tt.qrlExpiry < tn.quoteOpens,
      'I31.1: the QRL leg outlasts the origin leg by at least the admission and claim windows, and an offering settles before the next quote window opens',
      { margin: tt.qrlExpiry - tt.evmExpiry, windows: ctx.clock.ADMISSION_WINDOW + ctx.clock.EVM_CLAIM_WINDOW, settles: tt.qrlExpiry, nextQuoteOpens: tn.quoteOpens },
    );
    const carryShares = big(await k.view('carryShares', [await k.key()]));
    if (carryShares !== 0n) ctx.note(`the asset carries ${carryShares} shares of retained yield: the first lots claimed repay the shortfall carry`);

    // Fresh premium for the next offer (t+1), before its escrow offers it.
    const nowO = await S.nowOn(ctx, 'origin');
    if (a.mock && ctx.clock.epochOf(nowO) === t + 1n && nowO < ctx.clock.offerOpens(t + 1n)) await ctx.produceYield(a, yieldUnits / 4n);
    else ctx.note(`no yield put in for the offer of epoch ${t + 1n} (${a.mock ? 'its offer window had opened' : 'not a double'})`);

    /* ------------------------------------------------------------ the solvers */
    const avail0 = await k.available(t);
    const svcValue = await k.required(t, (avail0 * 1_000n) / S.BPS);
    const svcFund = (svcValue * 15_000n) / S.BPS + 2n * S.GAS_QRL;
    const recipients = { H: '0x' + 'a1'.repeat(20), N: '0x' + 'a2'.repeat(20), R: '0x' + 'a3'.repeat(20), A: '0x' + 'a4'.repeat(20), B: '0x' + 'a5'.repeat(20) };
    const procs = {};
    for (const [name, restartWhen] of [
      // A comes back at the next tick, B only once the escrow stopped paying its lot.
      ['A', () => true],
      ['B', (now) => now >= T.evmExpiry],
    ]) {
      const client = await S.fund(ctx, `oc-swap-live-${name}`, svcFund);
      const qrlCrash = S.crashAfter(client, 'claim');
      if (name === 'A') qrlCrash.arm();
      const originCrash = S.crashAfter(ctx.origin, 'claimPremium').arm();
      procs[name] = new S.SolverProcess(ctx, k, { name: `solver ${name}`, qrl: qrlCrash, origin: originCrash, recipient: recipients[name], shareBps: 1_000n, carryAfter: 0n, fromBlock: originFrom, restartWhen });
      await procs[name].start();
    }
    ctx.sidecars.push(() => procs.A.tick(), () => procs.B.tick());
    const raw = {};
    for (const name of ['H', 'N', 'R']) raw[name] = S.rawSolver(ctx, k, await ctx.actor(`oc-swap-live-${name}`), recipients[name]);

    /* ------------------------------------------------------------ the quote window */
    await S.until(ctx, T.qo);
    const avail = await k.available(t);
    const qH = await S.quoteLot(ctx, k, 'oc-swap-live-H', raw.H, t, (avail * 50n) / 100n, { extra: ONE });
    const qN = await S.quoteLot(ctx, k, 'oc-swap-live-N', raw.N, t, (avail * 10n) / 100n);
    const qR = await S.quoteLot(ctx, k, 'oc-swap-live-R', raw.R, t, (avail * 10n) / 100n);
    await S.waitFine(ctx, 'both reference solver services quoted in the window', async () => Boolean(procs.A.lot()) && Boolean(procs.B.lot()), { timeoutEpochs: 1 });
    const lots = { H: qH.lot, N: qN.lot, R: qR.lot, A: { ...procs.A.lot() }, B: { ...procs.B.lot() } };
    for (const x of Object.values(lots)) x.lot = await k.lotOf(x.lotId);

    // I33.1: the bond is the protocol's figure, read after the offering's judgement.
    const bondRows = {};
    for (const [n, x] of Object.entries(lots)) bondRows[n] = { bond: big(x.lot.bond), quoted: big(x.bond), bondFor: await k.bondFor(t, x.value) };
    ctx.check(Object.values(bondRows).every((r) => r.bond === r.bondFor && r.bond === r.quoted && r.bond > 0n), 'I33.1: every lot posts the commitment bond bondFor computes once the offering is judged, and the swap records it as quoted', bondRows);
    if (qH.alone) {
      ctx.check(qH.delta === qH.lot.value + qH.lot.bond, 'I33.1: the swap keeps value + bond of a quote and returns what was sent above them in the same transaction', { kept: qH.delta, value: qH.lot.value, bond: qH.lot.bond, sentAbove: ONE });
    } else ctx.note('another lot moved the swap balance in the same blocks as H\'s quote: the msg.value refund is not asserted');

    // The relayer's carry withheld for R, A and B: their preimages reach QRL only by the solver, late, or never.
    const traps = { R: S.withholdCarry(ctx, lots.R.lotId), A: S.withholdCarry(ctx, lots.A.lotId), B: S.withholdCarry(ctx, lots.B.lotId) };

    // R reveals 60 s before evmExpiry, whatever else the run is waiting on then.
    const late = { at: T.evmExpiry - 60n, done: false, ok: null, when: null };
    ctx.sidecars.push(async () => {
      if (late.done) return;
      const now = await S.nowOn(ctx, 'origin');
      if (now < late.at || now >= T.evmExpiry) return;
      late.done = true;
      late.when = now;
      late.ok = await raw.R.claim(lots.R, state());
    });

    /* ------------------------------------------------------------ selection */
    await S.until(ctx, T.qc);
    await S.waitFine(ctx, `offering ${t} selected`, async () => Boolean((await k.offering(t)).selected), { timeoutEpochs: 1 });
    const statusOf = async () => Object.fromEntries(await Promise.all(Object.entries(lots).map(async ([n, x]) => [n, await k.status(x.lotId)])));
    const selected = await statusOf();
    ctx.check(Object.values(selected).every((s) => s === 'Selected'), 'five lots at the reserve that together fit the offering are all selected', selected);
    const bondSum = Object.values(lots).reduce((s, x) => s + x.bond, 0n);
    ctx.check((await k.bondsAtRisk(t)) === bondSum, 'I33.2: after the selection the bonds at risk for the epoch are exactly the bonds of its selected lots', { bondsAtRisk: await k.bondsAtRisk(t), sum: bondSum });
    let cons = await S.conservation(ctx, k);
    ctx.check(cons.ok, 'I33.6: the swap holds exactly the value and bond of its open lots, the bonds of claimed lots not yet returned and the bonds at risk', cons);

    // Fresh premium for the offer of t+2, made at this offering's evmExpiry.
    if (a.mock && (await S.nowOn(ctx, 'origin')) < T.evmExpiry) await ctx.produceYield(a, yieldUnits / 4n);

    /* ------------------------------------------------------------ the locks */
    await S.waitFine(ctx, 'the five premium locks sealed into an admitted root, or evmExpiry', async () => Object.values(lots).every((x) => Solver.lockIn(state(), x.lotId)) || (await S.nowOn(ctx, 'origin')) >= T.evmExpiry, { timeoutEpochs: 1 });
    const locks = Object.fromEntries(Object.entries(lots).map(([n, x]) => [n, Solver.lockIn(state(), x.lotId)]));
    if (Object.values(locks).some((l) => !l)) {
      ctx.knownIssue('OC-SWAP-01', false, 'I31.2: every selected lot\'s lock is in a root admitted before its evmExpiry', { unsealed: Object.keys(locks).filter((n) => !locks[n]), evmExpiry: T.evmExpiry });
      ctx.note('the locks missed their root (OC-SWAP-01): nothing after this can be claimed; the run stops here');
      for (const p of Object.values(procs)) p.close();
      ctx.sidecars.length = 0;
      return;
    }
    ctx.check(Object.values(locks).every((l) => l.item.standIn === null), 'every lock came from PremiumSwap\'s LotSelected, none from a stand-in');

    /* ------------------------------------------------------------ claims */
    ctx.check(await raw.H.claim(lots.H, state()), 'a selected lot whose lock is in an admitted root is paid on the origin chain against its preimage');

    await S.waitFine(ctx, 'solvers A and B claimed on the origin chain and died before recording it', async () => procs.A.deaths.length >= 1 && procs.B.deaths.length >= 1, { timeoutEpochs: 1 });
    const bLot = procs.B.state.lots.find((x) => x.lotId === lots.B.lotId);
    ctx.check(
      (await spent(locks.A.item.leaf)) && (await spent(locks.B.item.leaf)) && Boolean(bLot && bLot.claiming) && !(bLot && bLot.claimedOrigin),
      'the crash window: the origin claim landed (the escrow spent the leaf) while the state file records only that a claim was being sent',
      { claiming: bLot && bLot.claiming, claimedOrigin: bLot && bLot.claimedOrigin },
    );

    // S4a: A came back before evmExpiry.
    const aBack = procs.A.starts[1];
    if (aBack !== undefined && aBack < T.evmExpiry) {
      await S.waitFine(ctx, "solver A's lot claimed on QRL after its restart", async () => (await k.status(lots.A.lotId)) === 'Claimed', { timeoutEpochs: 1 });
      ctx.check(procs.A.lines.some((l) => /claimed on the origin chain by an earlier run/.test(l)), 'S4a: restarted before evmExpiry, the solver recognises its own landed claim by the escrow\'s refusal (ProofSpent) and does not reveal twice', { restartedAt: aBack, evmExpiry: T.evmExpiry });
      const claimedA = (await k.swapEvents(qrlFrom)).find((e) => e.name === 'LotClaimed' && lower(e.args.lotId) === lower(lots.A.lotId));
      ctx.check(Boolean(claimedA) && sameAccount(claimedA.args.caller, procs.A.qrlCrash.client.address), 'S4a: the solver carries its own preimage to QRL when the relayer has not', { caller: claimedA && claimedA.args.caller });
      // S4c: killed between its QRL claim and the receipt; back again, it finds the lot Claimed.
      await S.waitFine(ctx, 'solver A finished its lot after a second restart', async () => Boolean(procs.A.done(lots.A.lotId)), { timeoutEpochs: 1 });
      const refundsA = (await k.swapEvents(qrlFrom)).filter((e) => e.name === 'LotRefunded' && lower(e.args.lotId) === lower(lots.A.lotId));
      ctx.check(
        procs.A.deaths.length === 2 && procs.A.deaths[1].after === 'qrl' && procs.A.done(lots.A.lotId).outcome === 'claimed; bond back',
        'S4c: killed between its QRL claim and the receipt, the restarted solver reads the lot Claimed and finishes it with its bond back',
        { deaths: procs.A.deaths, outcome: procs.A.done(lots.A.lotId).outcome },
      );
      ctx.check(refundsA.length === 1 && big(refundsA[0].args.value) === 0n && big(refundsA[0].args.bond) === lots.A.bond && big((await k.lotOf(lots.A.lotId)).bond) === 0n, 'I33.3: a claimed lot pays LotRefunded(0, bond) exactly once', { refunds: refundsA.map((e) => ({ value: e.args.value, bond: e.args.bond })) });
    } else {
      ctx.note(`solver A was back only at ${aBack}, at or after evmExpiry ${T.evmExpiry}: S4a and S4c not measured on this chain's timing`);
    }
    procs.A.close();

    // S3b: R revealed late; the relayer read it and, withheld, did not carry it.
    await S.waitFine(ctx, 'R revealed on the origin chain shortly before evmExpiry and the relayer read the preimage', async () => late.done && Boolean(traps.R.seen), { timeoutEpochs: 1, throws: false });
    if (late.ok) {
      ctx.check((await spent(locks.R.item.leaf)) && traps.R.seen === lots.R.secret && (await k.status(lots.R.lotId)) === 'Selected', 'S3b: a preimage revealed shortly before evmExpiry is public on the origin chain while the lot is still Selected on QRL', { revealedAt: late.when, evmExpiry: T.evmExpiry });
    } else ctx.note(`R did not reveal in [evmExpiry - 60, evmExpiry): ${late.done ? 'its claim was refused' : 'no tick fell in that minute'}`);

    /* ------------------------------------------------------------ evmExpiry */
    await S.until(ctx, T.evmExpiry, { leg: 'origin' });
    await ctx.refuses('S3a: the escrow pays no lot at or after its evmExpiry', 'PremiumExpired', () => a.call('claimPremium', raw.N.claimArgs(lots.N, locks.N)));
    const adm = {};
    for (const [n, l] of Object.entries(locks)) adm[n] = await S.lockAdmission(ctx, l.item.leaf, originFrom);
    ctx.knownIssue('OC-SWAP-01', Object.values(adm).every((x) => x && x.at !== null && x.at < T.evmExpiry && x.published), 'I31.2: every LotSelected leaf is published on the origin chain in a root admitted before its evmExpiry', { evmExpiry: T.evmExpiry, admission: adm });

    await S.waitFine(ctx, 'solver B restarted after evmExpiry', async () => procs.B.starts.length >= 2, { timeoutEpochs: 1 });
    ctx.check(procs.B.starts[1] >= T.evmExpiry, 'S4b: solver B is back only after the escrow stopped paying its lot', { restartedAt: procs.B.starts[1], evmExpiry: T.evmExpiry });

    // Asserted only while the QRL clock is still before the expiry: on a live
    // chain the wait for solver B's restart can run past it (hoodi-vps,
    // 2026-10-06: checked 21 s after qrlExpiry, where the release is due and
    // succeeds, as `settlementCloses = evmExpiry + QRL_CLAIM_MARGIN` says).
    if ((await S.nowOn(ctx, 'qrl')) < T.qrlExpiry) {
      await ctx.refuses('S2: the bonds of an offering are not forfeited before its QRL expiry', 'ForfeitsNotDue', () => ctx.qrl.call(q.PremiumSwap, k.swapAbi, 'releaseForfeits', [t]));
    } else ctx.note('S2 (no forfeit before the QRL expiry) not asserted: the QRL clock was already at or past the expiry when the step was reached');

    /* ------------------------------------------------------------ qrlExpiry */
    await S.until(ctx, T.qrlExpiry, { quiet: 3n * S.stepOf(ctx) });
    const atExpiry = await statusOf();
    const atRisk = await k.bondsAtRisk(t);
    const unclaimedBonds = Object.entries(lots).filter(([n]) => atExpiry[n] === 'Selected').reduce((s, [, x]) => s + x.bond, 0n);
    ctx.check(atRisk === unclaimedBonds, 'I33.2: at the QRL expiry the bonds at risk are exactly those of the selected lots never claimed on QRL', { bondsAtRisk: atRisk, unclaimed: unclaimedBonds, status: atExpiry });
    ctx.check(atExpiry.B === 'Claimed', 'OC-SWAP-04, S4b, I31.3: a solver restarted after evmExpiry whose origin claim had landed (isSpent) carries its preimage, so the lot is Claimed on QRL before its QRL expiry', { status: atExpiry.B, isSpent: await spent(locks.B.item.leaf), restartedAt: procs.B.starts[1], evmExpiry: T.evmExpiry, qrlExpiry: T.qrlExpiry });
    if (atExpiry.N === 'Selected') {
      await ctx.refuses('S2: the preimage of a selected lot is refused at its QRL expiry', 'LotExpired', () => ctx.qrl.call(q.PremiumSwap, k.swapAbi, 'claim', [lots.N.lotId, lots.N.secret]));
    } else ctx.note(`N was already ${atExpiry.N} at the QRL expiry: the LotExpired refusal is not asserted`);
    if (atExpiry.R === 'Selected') {
      await ctx.refuses('S3b: a preimage carried after the QRL expiry is refused', 'LotExpired', () => ctx.qrl.call(q.PremiumSwap, k.swapAbi, 'claim', [lots.R.lotId, lots.R.secret]));
    } else ctx.note(`R was already ${atExpiry.R} at the QRL expiry: the LotExpired refusal is not asserted`);

    // R's preimage reaches the relayer now, after the margin, as a late finality would deliver it.
    const relayerLines = [];
    const relayerLog = ctx.r.log;
    ctx.r.log = (...m) => {
      relayerLines.push(m.join(' '));
      relayerLog(...m);
    };
    traps.R.release(lots.R.secret);
    try {
      // B's lot is Claimed (OC-SWAP-04): only a lot still Selected at the QRL expiry lapses.
      await S.waitFine(ctx, `the coupon of epoch ${t} distributed and the lapsed lot N refunded, B's not lapsed`, async () => big(await ctx.coupon('lastDistributed')) >= t && (await k.status(lots.N.lotId)) === 'Refunded' && (await k.status(lots.B.lotId)) !== 'Selected', { timeoutEpochs: 1 });
      if ((await k.status(lots.R.lotId)) === 'Selected') {
        const r = await raw.R.refund(lots.R.lotId);
        ctx.check(r.ok, 'a lapsed lot is refundable by anyone from its QRL expiry', r);
      }
      await ctx.tick();
    } finally {
      ctx.r.log = relayerLog;
    }
    ctx.check(relayerLines.some((l) => /ALARM/.test(l) && l.includes(lots.R.lotId.slice(0, 14))), 'S3b: a preimage the relayer can carry only after the QRL expiry raises ALARM: the lot was paid on the origin chain and its QRL went back', { lines: relayerLines.filter((l) => /ALARM/.test(l)) });

    /* ------------------------------------------------------------ refunds */
    const swapEvs = await k.swapEvents(qrlFrom);
    const refundsOf = (id) => swapEvs.filter((e) => e.name === 'LotRefunded' && lower(e.args.lotId) === lower(id)).map((e) => ({ value: big(e.args.value), bond: big(e.args.bond) }));
    const lapsed = {};
    // The lots still Selected at the QRL expiry: N and R; B no longer, once its solver carried (OC-SWAP-04).
    for (const n of ['N', 'R', 'B'].filter((x) => atExpiry[x] === 'Selected')) lapsed[n] = { refunds: refundsOf(lots[n].lotId), bondOnRecord: big((await k.lotOf(lots[n].lotId)).bond), bond: lots[n].bond, value: lots[n].value, spent: await spent(locks[n].item.leaf) };
    ctx.check(
      Object.values(lapsed).every((x) => x.refunds.length === 1 && x.refunds[0].value === x.value && x.refunds[0].bond === 0n && x.bondOnRecord === x.bond),
      'S2, I33.4: a selected lot unclaimed at its QRL expiry pays back its QRL and not its bond, once, and lotOf keeps the bond it posted',
      lapsed,
    );
    ctx.knownIssue('OC-SWAP-05', !(lapsed.R.spent && lapsed.R.refunds.some((x) => x.value > 0n)), 'I31.4: no lot whose leaf the escrow spent is refunded its QRL', { lot: 'R', induced: 'the relayer carry withheld past the claim margin, as a finality delay beyond it would', ...lapsed.R });
    const refundsB = refundsOf(lots.B.lotId);
    ctx.check(!((await spent(locks.B.item.leaf)) && refundsB.some((x) => x.value > 0n)), 'OC-SWAP-04, I31.4: no lot whose leaf the escrow spent is refunded its QRL', { lot: 'B', refunds: refundsB, status: atExpiry.B });
    await S.waitFine(ctx, 'solver B finished its lot', async () => Boolean(procs.B.done(lots.B.lotId)), { timeoutEpochs: 1, throws: false });
    const outcomeB = procs.B.done(lots.B.lotId);
    ctx.check(Boolean(outcomeB) && (outcomeB.outcome === 'claimed; bond back' || /ALARM/.test(outcomeB.outcome)), 'OC-SWAP-04: a solver whose lot was paid on the origin chain ends it claimed on QRL with its bond back, or reports ALARM — never an ordinary lapse', { outcome: outcomeB && outcomeB.outcome });
    procs.B.close();
    ctx.sidecars.length = 0;

    /* ------------------------------------------------------------ the coupon of t */
    const forfeit = swapEvs.find((e) => e.name === 'BondsForfeited' && big(e.args.epoch) === t);
    ctx.check(
      Boolean(forfeit) && big(forfeit.args.amount) === atRisk && (await k.bondsAtRisk(t)) === 0n && (await tsQ(forfeit.blockNumber)) >= T.qrlExpiry,
      'I33.5: the bonds of the epoch are forfeited at or after its QRL expiry, all that was at risk and nothing else, leaving none at risk',
      { forfeited: forfeit && forfeit.args.amount, atRisk, after: await k.bondsAtRisk(t), at: forfeit && (await tsQ(forfeit.blockNumber)), qrlExpiry: T.qrlExpiry },
    );
    const ledgerEvs = await k.ledgerEvents(qrlFrom);
    const couponEvs = await k.couponEvents(qrlFrom);
    const sameTx = (e) => forfeit && big(e.blockNumber) === big(forfeit.blockNumber) && (e.transactionHash === undefined || e.transactionHash === forfeit.transactionHash);
    const ledgerForfeit = ledgerEvs.find((e) => e.name === 'BondsForfeited' && big(e.args.epoch) === t && sameTx(e));
    const reads = [
      ...ledgerEvs.filter((e) => sameTx(e) && ((e.name === 'ProceedsDrawn' && big(e.args.epoch) === t) || (e.name === 'ResidueCarried' && big(e.args.fromEpoch) === t))),
      ...couponEvs.filter((e) => sameTx(e) && e.name === 'CouponDistributed' && big(e.args.epoch) === t),
    ];
    ctx.check(
      Boolean(ledgerForfeit) && reads.length > 0 && Number(ledgerForfeit.logIndex) > Number(forfeit.logIndex) && reads.every((e) => Number(e.logIndex) > Number(ledgerForfeit.logIndex)),
      'I7.3: in the distribute(t) transaction the forfeited bonds reach the ledger before the epoch is drawn, carried or distributed',
      { order: [forfeit, ledgerForfeit, ...reads].filter(Boolean).map((e) => `${e.name}@${e.logIndex}`) },
    );
    const final = await statusOf();
    let claimedPart = 0n;
    for (const [n, x] of Object.entries(lots)) if (final[n] === 'Claimed') claimedPart += x.value - (await k.feeOf(t, x.value));
    const residueIn = ledgerEvs.filter((e) => e.name === 'ResidueCarried' && big(e.args.toEpoch) === t).reduce((s, e) => s + big(e.args.amount), 0n);
    const delivered = big(await ctx.ledger('deliveredIn', [t]));
    ctx.check(delivered === claimedPart + atRisk + residueIn, 'I7.1: the proceeds of the epoch are its claimed lots less their juror fraction, the bonds forfeited against its offering and the residue carried into it, and nothing else', { delivered, claimedPart, forfeited: atRisk, residueIn, status: final });
    const deliveries = ledgerEvs.filter((e) => e.name === 'ProceedsDelivered' && big(e.args.epoch) === t);
    const inWindow = [];
    for (const e of deliveries) inWindow.push({ from: e.args.from, at: await tsQ(e.blockNumber) });
    ctx.check(
      deliveries.length === Object.values(final).filter((s) => s === 'Claimed').length && inWindow.every((x) => sameAccount(x.from, q.PremiumSwap) && x.at >= ctx.clock.startOf(t + 1n) && x.at < T.qrlExpiry),
      'I7.2: every delivery to the epoch comes from PremiumSwap, one per claimed lot, inside [start(t+1), settlementCloses(t))',
      { deliveries: inWindow },
    );
    const drawn = ledgerEvs.filter((e) => e.name === 'ProceedsDrawn' && big(e.args.epoch) === t).reduce((s, e) => s + big(e.args.amount), 0n);
    ctx.check((await ctx.ledger('remainingIn', [t])) === 0n && drawn <= delivered, 'I7.4: the coupon drew no more than was delivered and left nothing of the epoch behind', { drawn, delivered });

    /* ------------------------------------------------------------ both legs' secrets */
    const premiumClaimed = await k.escrowEvents(originFrom, 'PremiumClaimed');
    const hashRows = [];
    for (const e of premiumClaimed) {
      const name = Object.keys(lots).find((n) => lower(lots[n].lotId) === lower(e.args.lotId));
      if (!name) continue;
      const onQrl = swapEvs.find((x) => x.name === 'LotClaimed' && lower(x.args.lotId) === lower(e.args.lotId));
      hashRows.push({ lot: name, origin: lower(S.hashlockOf(e.args.secret)) === lower(lots[name].hashlock), qrl: onQrl ? lower(S.hashlockOf(onQrl.args.secret)) === lower(lots[name].hashlock) : null, carriedAt: onQrl ? await tsQ(onQrl.blockNumber) : null });
    }
    ctx.check(hashRows.length === 4 && hashRows.every((r) => r.origin && r.qrl !== false), 'I31.5: the secret each leg took hashes, by sha256, to the lot\'s hashlock on both legs', hashRows);
    ctx.check(hashRows.filter((r) => r.lot === 'H' || r.lot === 'A' || r.lot === 'B').every((r) => r.carriedAt !== null && r.carriedAt < T.qrlExpiry), 'I31.3: an origin claim whose preimage was carried reached QRL before the lot\'s QRL expiry', hashRows);

    cons = await S.conservation(ctx, k);
    ctx.check(cons.ok, 'I33.6: after every refund and forfeit the swap holds exactly what its open lots and bonds account for', cons);
    await ctx.invariants(`offering ${t} settled`);

    /* ------------------------------------------------------------ OC-SWAP-02: the batching watch */
    const watched = t + 2n;
    await S.waitFine(ctx, `the offer of epoch ${watched} recorded or carried on QRL`, async () => (await k.swapEvents(qrlFrom)).some((e) => (e.name === 'OfferRecorded' || e.name === 'OfferingCarried') && big(e.args.epoch) === watched), { timeoutEpochs: 2 });
    const offers = await S.offeredUnits(k, originFrom);
    const prevEpoch = Object.keys(offers).map(BigInt).filter((e) => e < watched).sort((x, y) => (x < y ? 1 : -1))[0];
    const unitsPrev = offers[String(prevEpoch)].units;
    const unitsNow = offers[String(watched)] ? offers[String(watched)].units : 0n;
    let paidOut = 0n;
    // Each lot pays a recipient of its own, so what they received is what the claims took out of the pot.
    for (const n of Object.keys(lots)) paidOut += await ctx.transferredTo(a, recipients[n], originFrom);
    const fresh = unitsNow + paidOut - unitsPrev;
    const threshold = await k.batchThreshold();
    const carried = (await k.swapEvents(qrlFrom)).some((e) => e.name === 'OfferingCarried' && big(e.args.epoch) === watched);
    ctx.check(!(carried && fresh >= threshold), 'OC-SWAP-02, I7.5: an offer that brings fresh premium at or above the batching threshold opens an offering; it is not carried', {
      epoch: watched,
      fresh,
      threshold,
      unitsPrev,
      prevEpoch,
      unitsNow,
      paidOutBetween: paidOut,
      grown: unitsNow > unitsPrev ? unitsNow - unitsPrev : 0n,
      carried,
    });
    await ctx.invariants('end of the batching watch');
  },
};
