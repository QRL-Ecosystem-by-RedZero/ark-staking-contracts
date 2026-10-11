/**
 * The bond through trigger 2 and the recovery, by class (OC audit
 * 2026-10-03, ECON "On-chain scenarios needed" 8–10): the declaration, the
 * floor draw D_0 of the full settlement junior first and into senior, a
 * position's entitlement claimed in QRL, the severity settled at the close
 * of the assessment window, a successor admitted and a recovery found on it,
 * divided senior to the whole of its draw before junior (I23′), each class's
 * part claimed by its holders — and a junior holding split after its claim
 * and claimed again, which OC-ECON-01 says seals more than the class's part
 * (Σ sealed per (recovery, class) ≤ toClass, I23/I36).
 *
 * Senior is reached by a declaration's floor draw only where junior is thin:
 * at issuance junior holds at least its thickness (70%) of the pool, above
 * D_0 (60%). So trigger-1 determinations first draw junior down — junior
 * first, as the waterfall draws (whitepaper §5.2) — to half the senior
 * class, and the floor then exhausts junior and draws senior.
 *
 * TERMINAL. The declaration closes the escrow for good: run it last and
 * redeploy both legs afterwards.
 *
 * What stands in: the Q-Day oracle (the double; a deployment wired to
 * contracts/core's oracle declares through attesters and veARK, see
 * governance-qday). The findings — the loss and the recovery — are bonded
 * assertions to the court, standing unchallenged.
 *
 * Wall clock: 12 epochs measured — ≈ 1 h 25 min at the rapid profile's
 * 7-minute epochs (rehearsal), ≈ 14 h at the testnet profile's 70 minutes
 * (hoodi-vps); most of it is the position vesting far enough for six
 * determinations to carry the draw, and the four-epoch assessment window.
 * On the harness, about a minute. On a live chain the deployer stakes the
 * juror seats of six loss findings (≈ 420,000 ARK) and their deposits.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { ONE, BPS, units } = require('../lib');
const { BondKit, TERM, CLASS, same } = require('../helpers/bond');
const { iface, qrlBuild } = require('../../lib/chains');

const T2_FLOOR = keccak256(toUtf8Bytes('ARK_T2_FLOOR'));

module.exports = {
  description: 'trigger 2 by class: the floor draw through junior into senior, a claimed entitlement, the severity, a recovery divided senior first, and a junior holding split after its claim and claimed again (OC-ECON-01)',
  terminal: true,
  outOfScope: [
    'a declaration through contracts/core\'s ArkQDayOracle (attesters and veARK): governance-qday; here the oracle is the double, and a deployment without one stops after the trigger-1 step',
    'on a live chain whose parameter set the deployer does not govern: admitSuccessor goes through the timelock\'s delay; the recovery steps are skipped',
    'the HOLD path of the severity (a silent series, fixSeverity after 2·W_a): test/ArkCatBondSettlement.test.js; the harness series reads no decline here',
    'a challenged finding: the jury (test/ArkStakeCourt.test.js); here every assertion stands unchallenged',
  ],
  async run(ctx, opts) {
    const a = ctx.asset(opts.asset);
    const b = new BondKit(ctx);
    const escrowArg = ctx.r.evmArg(a.escrow);
    const startEpoch = await ctx.originEpoch();

    /* ------------------------------------------------------------ the book: a position, two classes */
    await ctx.seedIfNeeded(a);
    const position = await ctx.anchor(a, units(opts.notional, 1000));
    await ctx.waitAnchorRecorded(position.id);

    const s0 = await b.state();
    const book = BigInt(s0.juniorPrincipal) + BigInt(s0.seniorPrincipal);
    const juniorQrl = book / 10n;
    const seniorQrl = (3n * book) / 10n;
    const jHolder = await b.holder('rec-junior', juniorQrl);
    const sHolder = await b.holder('rec-senior', seniorQrl);
    const J = await b.subscribe(jHolder, TERM.QUARTER, CLASS.JUNIOR, juniorQrl);
    const S = await b.subscribe(sHolder, TERM.QUARTER, CLASS.SENIOR, seniorQrl);
    ctx.check(Number(J.class_) === CLASS.JUNIOR && Number(S.class_) === CLASS.SENIOR && same(S.owner, sHolder.address), 'a junior and a senior holding, each its subscriber\'s', { junior: J.id, senior: S.id });

    /* ------------------------------------------------------------ junior thinned by a trigger-1 draw */
    const s1 = await b.state();
    const target = BigInt(s1.seniorPrincipal) / 2n;
    const drawQrl = BigInt(s1.juniorPrincipal) - target;
    const price = BigInt(await ctx.registry('settlementPrice'));
    const drawUnits = (drawQrl * ONE) / price;
    // One determination is heard up to the court's verdict bound (I24′): the
    // largest loss it quotes, found by bisection on the quote.
    const findingsAbi = iface('ArkCourtFindings', qrlBuild(ctx.r.manifest.profile));
    const findings = await ctx.court('FINDINGS');
    const lossPayload = (units) => ctx.encodeQrl(['bytes32[]', 'uint256[]'], [[position.id], [units]]);
    const quotes = (units) => ctx.qrl.call(findings, findingsAbi, 'quote', [1, lossPayload(units)]).then(() => true, () => false);
    const notional = BigInt(position.notional);
    let lo = 0n;
    let hi = notional;
    if (await quotes(hi)) lo = hi;
    while (hi - lo > ONE / 100n) {
      const mid = (lo + hi) / 2n;
      if (await quotes(mid)) lo = mid;
      else hi = mid;
    }
    const maxLoss = lo;
    // The claim is the loss at the indemnity in force and the position's
    // vesting (whitepaper §5.3, §4.5), so the draw is heard as several
    // determinations of at most `maxLoss` each, once few enough will do.
    const indemnity = BigInt(await ctx.registry('effectiveIndemnityBps'));
    const MAX_PIECES = 6n;
    const piecesAt = (v) => (drawUnits * BPS * BPS + maxLoss * indemnity * v - 1n) / (maxLoss * indemnity * v);
    await ctx.waitFor(`the position vested enough for at most ${MAX_PIECES} determinations to carry the draw (whitepaper §5.3)`, async () => {
      const v = BigInt(await ctx.registry('vestingBpsOf', [position.id]));
      return v > 0n && piecesAt(v) <= MAX_PIECES;
    }, { timeoutEpochs: 14 });
    const vesting = BigInt(await ctx.registry('vestingBpsOf', [position.id]));
    let lossLeft = (drawUnits * BPS * BPS + indemnity * vesting - 1n) / (indemnity * vesting);
    const payloads = [];
    while (lossLeft > 0n) {
      const l = lossLeft < maxLoss ? lossLeft : maxLoss;
      payloads.push(lossPayload(l));
      lossLeft -= l;
    }
    ctx.note(`junior thinned by ${drawQrl / ONE} QRL: ${payloads.length} determination(s) of up to ${maxLoss} units at indemnity ${indemnity} and vesting ${vesting} bps`);
    const lossIds = await b.assertMany(1, payloads, 'losses that thin junior');
    let drawnT1 = 0n;
    for (const id of lossIds) drawnT1 += BigInt((await ctx.bond('lossPartOf', [id, position.id])).qrl);
    const lossId = lossIds[0];
    const s2 = await b.state();
    ctx.check(drawnT1 > 0n && BigInt(s2.seniorPrincipal) === BigInt(s1.seniorPrincipal) && BigInt(s2.juniorPrincipal) < BigInt(s1.juniorPrincipal), 'a trigger-1 draw takes junior first and leaves senior whole while junior lasts (whitepaper §4.6, §5.2)', { drawn: drawnT1, junior: [s1.juniorPrincipal, s2.juniorPrincipal], senior: s2.seniorPrincipal });
    for (const id of lossIds) {
      if (BigInt((await ctx.bond('lossPartOf', [id, position.id])).bufferUnits) > 0n) await ctx.bondSend('nameLossDestination', [id, position.id, ctx.r.evmArg('0x' + '34'.repeat(20))]);
    }
    await ctx.invariants('junior thinned');

    /* ------------------------------------------------------------ 8. the declaration and the floor draw */
    if (ctx.r.deployment.qday?.kind !== 'mock' || !ctx.r.q.MockQDayOracle) {
      ctx.note('the Q-Day oracle is contracts/core\'s: the declaration goes through its attesters and veARK (governance-qday); stopping here');
      return;
    }
    const juniorAtT = BigInt((await b.state()).juniorPrincipal);
    const fromBlock = (await ctx.qrl.head()).latest;
    await ctx.qrl.send(ctx.r.q.MockQDayOracle, ctx.r.abi.qday, 'declare', [(await ctx.qrl.head()).timestamp]);
    ctx.note('Q-Day declared on QRL (the oracle is a double)');
    await ctx.refuses('bond principal leaving before the trigger-2 settlement has drawn', 'DeclaredPendingSettlement', () => b.callAs(sHolder, 'redeem', [S.id]));
    await ctx.refuses('no subscription after the declaration', 'Declared', () => b.callAs(jHolder, 'subscribe', [TERM.QUARTER, CLASS.JUNIOR], { value: ONE }));
    await ctx.waitFor('the relayer, as trigger 2\'s keeper, recorded the claimants and opened the settlement', async () => Number((await ctx.bond('declaration')).stage) !== 0, { timeoutEpochs: 3 });
    const t2 = await ctx.bond('declaration');
    const drawnJ = BigInt(t2.drawnByClass[0]);
    const drawnS = BigInt(t2.drawnByClass[1]);
    ctx.check(BigInt(t2.drawn) === (BigInt(t2.fullSettlement) * BigInt(t2.d0)) / BPS && BigInt(t2.fullSettlement) <= BigInt(t2.pool), 'the floor draw is D_0 of the full settlement, the vested obligation bounded by the pool (whitepaper §5.2, I37)', { drawn: t2.drawn, full: t2.fullSettlement, pool: t2.pool, d0: t2.d0 });
    ctx.check(drawnS > 0n && drawnJ === juniorAtT, 'junior is drawn to the whole of its principal before senior is reached (whitepaper §4.6)', { drawnJunior: drawnJ, juniorAtT, drawnSenior: drawnS });
    const drawnEv = (await b.eventsSince('Trigger2Drawn', fromBlock)).find((x) => x.args.settlementId === T2_FLOOR);
    ctx.check(Boolean(drawnEv) && BigInt(drawnEv.args.drawJunior) + BigInt(drawnEv.args.drawSenior) === BigInt(t2.drawn), 'the floor draw is announced once, by class (Trigger2Drawn T2_FLOOR)', { event: drawnEv && { junior: drawnEv.args.drawJunior, senior: drawnEv.args.drawSenior } });
    await ctx.invariants('floor drawn');

    // The position's share of the floor draw, in QRL, from the epoch after (yellow paper §1.4).
    await ctx.waitEpochs(1);
    await ctx.bondSend('claimSettlement', [T2_FLOOR, position.id]);
    const paid = BigInt(await ctx.bond('settlementPaidTo', [T2_FLOOR, position.id]));
    ctx.check(paid > 0n, 'the claimant is paid its entitlement to the draw on its vested weight at the ratification, in QRL (whitepaper §5.2)', { paid });
    const [, served, settlePaid] = await ctx.bond('settlementOf', [T2_FLOOR]);
    ctx.check(BigInt(settlePaid) <= BigInt(served), 'the settlements never pay past what the pool has served them (paid ≤ served)', { paid: settlePaid, served });

    /* ------------------------------------------------------------ 9. the severity */
    await ctx.waitFor('the relayer settled the severity at the close of the assessment window', async () => Number((await ctx.bond('declaration')).stage) === 3, { timeoutEpochs: Number(t2.windowEpochs) + 3 });
    const after = await ctx.bond('declaration');
    ctx.check(BigInt(after.drawn) >= BigInt(t2.drawn) && BigInt(after.held) === 0n, 'the severity is judged at the close of its window and nothing stays held (whitepaper §4.6, I37)', { drawn: after.drawn, held: after.held });

    /* ------------------------------------------------------------ 10. the successor and the recovery */
    if (!(await b.governsParams())) {
      ctx.note('the deployer does not govern the parameter set: admitSuccessor is the timelock\'s; stopping here');
      return;
    }
    const successorId = '0x' + 'b2'.repeat(32);
    await ctx.paramsSend('admitSuccessor', [ctx.r.chainId, successorId]);
    const [pRem] = await ctx.recovery('recoveryResidual', [ctx.r.chainId, escrowArg]);
    const realised = (await a.call('toUnits', [await a.call('sharesHeld')])) / 2n;
    const rPayload = ctx.encodeQrl(['uint256', 'bytes32', 'address', 'uint256', 'uint256'], [ctx.r.chainId, successorId, escrowArg, realised, position.notional]);
    const recFrom = (await ctx.qrl.head()).latest;
    const { caseId: rid } = await ctx.assertUnchallenged(4, rPayload, 'the recovery');
    const r = await ctx.recovery('recoveryOf', [rid]);
    const ledger = await ctx.recovery('escrowLedger', [ctx.r.chainId, escrowArg]);
    const toJ = BigInt(r.toClass[0]);
    const toS = BigInt(r.toClass[1]);
    const toBond = toJ + toS;
    const appliedJ = BigInt(ledger.applied[0]);
    const appliedS = BigInt(ledger.applied[1]);
    ctx.check(r.applied === true && toBond === (realised < BigInt(pRem) ? realised : BigInt(pRem)), 'the bond takes min(R, P_rem) of the escrow: at most what it paid its positions (I36)', { toBond, pRem, realised });
    ctx.check(toS === (toBond < appliedS ? toBond : appliedS) && toJ === (toBond - toS < appliedJ ? toBond - toS : appliedJ), 'the recovery goes to senior to the whole of its draw before junior takes any (I23′, whitepaper §5.4)', { toSenior: toS, toJunior: toJ, seniorDrawUnits: appliedS, juniorDrawUnits: appliedJ });
    const opened = (await b.eventsSince('RecoveryOpened', recFrom)).find((x) => x.args.recoveryId === rid);
    ctx.check(Boolean(opened) && BigInt(opened.args.toSenior) === toS && BigInt(opened.args.toJunior) === toJ, 'the division is announced as recorded (RecoveryOpened)', { event: Boolean(opened) });
    await ctx.invariants('recovery opened');

    /* each class claims its part: senior first, then junior */
    const dest = (n) => '0x' + n.repeat(20);
    const sealedBy = async (receipt) => b.events(receipt, 'RecoveryLeafSealed').reduce((t, x) => t + BigInt(x.args.quantity), 0n);
    const claimR = (who, id, d) => who.send(ctx.r.q.ArkCatBond, ctx.recoveryAbi, 'claimRecovery', [rid, id, ctx.r.evmArg(d)]);
    const qS = await sealedBy(await claimR(sHolder, S.id, dest('71')));
    const sharesAt = [BigInt(t2.sharesAt[0]), BigInt(t2.sharesAt[1])];
    ctx.check(qS === (toS * BigInt(S.shares)) / sharesAt[1] && qS > 0n, 'a senior holding is sealed its pro-rata part of senior\'s recovery, by its shares at the draw (whitepaper §5.4)', { sealed: qS, toSenior: toS, shares: S.shares, sharesAt: sharesAt[1] });
    await ctx.refuses('a holding claims a recovery once', 'AlreadyClaimed', () => sHolder.call(ctx.r.q.ArkCatBond, ctx.recoveryAbi, 'claimRecovery', [rid, S.id, ctx.r.evmArg(dest('71'))]));

    const claimJ = claimR;
    let sealedJ = 0n;
    let carvedSealed = 0n;
    if (toJ > 0n) {
      // The deployer's own junior holding of record, where this run holds it.
      const h1 = await b.holding(1n).catch(() => null);
      if (h1 && same(h1.owner, ctx.qrl.address) && Number(h1.class_) === CLASS.JUNIOR) sealedJ += await sealedBy(await claimJ(ctx.qrl, 1n, dest('72')));
      const qJ = await sealedBy(await claimJ(jHolder, J.id, dest('73')));
      sealedJ += qJ;
      ctx.check(qJ === (toJ * BigInt(J.shares)) / sharesAt[0], 'a junior holding is sealed its pro-rata part of junior\'s recovery', { sealed: qJ, toJunior: toJ });

      /* OC-ECON-01: split after the claim, claim again from the carved id */
      let id = J.id;
      let owner = jHolder;
      let lineage = qJ;
      for (let hop = 0; hop < 2; hop++) {
        const accomplice = await b.holder(`rec-carved-${hop}`);
        const h = await b.holding(id);
        if (BigInt(h.shares) < 2n) break;
        id = await b.transfer(owner, id, accomplice.address, BigInt(h.shares) - 1n);
        owner = accomplice;
        // Since OC-ECON-01 the carved record holds no claim of record: its claim
        // is refused, and a claim that went through would count against the rule.
        const d = dest(hop === 0 ? '74' : '75');
        const extra = await claimJ(owner, id, d).then(sealedBy, async () => {
          await ctx.refuses('a record carved out after the draw holds no recovery claim of its own (whitepaper §5.4)', 'NotClaimant', () => owner.call(ctx.r.q.ArkCatBond, ctx.recoveryAbi, 'claimRecovery', [rid, id, ctx.r.evmArg(d)]));
          return 0n;
        });
        lineage += extra;
        carvedSealed += extra;
        sealedJ += extra;
      }
      ctx.check(lineage <= qJ, 'the recovery claim stays with the holding of record at the draw: a split after the claim seals nothing more (whitepaper §5.4)', { firstClaim: qJ, sealedByLineage: lineage });
      ctx.check(sealedJ <= toJ, 'Σ recovery leaves sealed per (recovery, class) ≤ the class\'s part (I23, I36)', { recoveryId: rid, class: 'junior', sealed: sealedJ, toClass: toJ, excess: sealedJ > toJ ? sealedJ - toJ : 0n });
    } else {
      ctx.note('the recovery did not reach junior: senior took the whole of it');
    }
    const allSealed = await b.eventsSince('RecoveryLeafSealed', recFrom);
    const bySenior = allSealed.filter((x) => x.args.recoveryId === rid && BigInt(x.args.recipient) === BigInt(S.id)).reduce((t, x) => t + BigInt(x.args.quantity), 0n);
    ctx.check(bySenior <= toS, 'Σ recovery leaves sealed for senior ≤ senior\'s part (I23)', { sealed: bySenior, toSenior: toS });

    /* the positions' part, and the leaves paid on the successor */
    if (BigInt(r.toPositions) > 0n) await ctx.recoverySend('claimPositionRecovery', [rid, position.id, ctx.r.evmArg(dest('76'))]);
    await ctx.waitFor('the senior holder\'s recovery share paid on the successor', async () => (await a.token.call('balanceOf', [dest('71')])) > 0n, { sealNow: true, timeoutEpochs: 4 });
    ctx.check((await a.token.call('balanceOf', [dest('71')])) >= qS - 2n, 'the senior recovery leaf is paid by the escrow, on the successor it binds (I36)', { paid: await a.token.call('balanceOf', [dest('71')]), sealed: qS });
    // Only where a carved record was sealed a leaf, which OC-ECON-01 refuses.
    if (toJ > 0n && carvedSealed > 0n) {
      try {
        await ctx.waitFor('the carved junior holding\'s leaf paid as well', async () => (await a.token.call('balanceOf', [dest('74')])) > 0n, { sealNow: true, timeoutEpochs: 2 });
        ctx.note(`OC-ECON-01: the escrow paid the carved holding's leaf too (${await a.token.call('balanceOf', [dest('74')])} units), first come, out of the recoverable holding`);
      } catch {
        ctx.note('OC-ECON-01: the carved holding\'s leaf was sealed but not paid within two epochs');
      }
    }
    await ctx.invariants('recovered');
    ctx.note(`steps 8–10 took ${(await ctx.originEpoch()) - startEpoch} epochs`);
  },
};
