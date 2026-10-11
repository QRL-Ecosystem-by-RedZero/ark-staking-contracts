/**
 * Leg A, live: the origin chain's escrow and epoch-root relay as deployed,
 * against the on-chain audit round of 2026-10-03
 * (docs/review/audit-2026-10-03/LEG-A/REPORT.md, "On-chain scenarios needed").
 *
 * Rows: S1 (code and immutables), S5 (allocation, commitment, reserve),
 * S22 (epoch boundaries), S18 (a payee the asset refuses), S9 (a freeze over
 * an outstanding loss, OL-06), and the probes of OC-LEGA-02 (indices consumed
 * against epochs elapsed) and OC-LEGA-04 (the first sweep of an epoch before
 * its allocation). The run asserts the specification; where an open finding
 * predicts a breach it is recorded with `knownIssue` and the run continues.
 *
 * Not terminal: the freeze is lifted, the threat stage stepped back, every
 * loss settled. It leaves a primed reserve, a committed position and an
 * anchored one behind.
 *
 * Wall-clock: about ten epochs end to end — on the rehearsal chain (rapid
 * profile, 7-minute epochs) about 75 minutes; on hoodi-vps (testnet profile,
 * 70-minute epochs) about 12 hours, of which S9 and the stage step are skipped
 * there (they need a double's yield), leaving about 7 epochs, 8 hours.
 *
 * What stands in: the freeze and the two loss leaves of S9 are stand-in
 * leaves (`ctx.r.enqueue`), as in freeze.js; the threat-stage vote is the
 * deployer's where it is governance (the local chain), and skipped otherwise.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { ONE, BPS, units } = require('../lib');
const ids = require('../../../ecdsa-stakings/relayer/lib/identifiers');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const { parseLogs } = require('../../lib/chains');
const deploy = require('../../lib/deploy');
const H = require('../helpers/leg-a');
const { stageKit } = require('../helpers/phase');

const STATIC_OUT_OF_SCOPE = [
  'S20 the authority-chain extension and S21 publishLeaves: the relayer\'s own paths, observed by every scenario (unit suite ecdsa-stakings/shared/test/relay.test.js)',
  'S22 claimPremium at evmExpiry − 1 with a real lock: atomic-yield-flow claims inside the window; here the boundary is probed with an unsealed lock, refused by its proof',
];

const lower = (x) => String(x).toLowerCase();

module.exports = {
  description: 'Leg A as deployed: code and immutables, allocation and commitment, the epoch boundaries, a refused payee, a freeze over an outstanding loss; OC-LEGA-02/04 probes',
  outOfScope: [...STATIC_OUT_OF_SCOPE],
  async run(ctx, opts) {
    const outOfScope = (module.exports.outOfScope = [...STATIC_OUT_OF_SCOPE]);
    const skip = (line) => {
      outOfScope.push(line);
      ctx.note(`out of scope here: ${line}`);
    };
    const m = ctx.r.manifest;
    const rv = H.relayView(ctx);
    const fromBlock = BigInt(m.deployedFromBlock || 0);
    const deployEpoch = ctx.clock.epochOf(await ctx.origin.timestampOf(fromBlock));

    /* ================================================================ OC-LEGA-02, before any tick */
    {
      const lastEpoch = BigInt(await rv('lastEpoch'));
      const now = await ctx.originEpoch();
      const leafCount = BigInt(await rv('LEAF_COUNT'));
      const next = BigInt(await rv('nextLeaf'));
      if (lastEpoch < deployEpoch) {
        // Before any admission: from the fix of OC-LEGA-02 the starting value
        // is the epoch before deployment; from zero, every epoch since 1970
        // read as elapsed and could label a root.
        const burnable = now - lastEpoch < leafCount - next ? now - lastEpoch : leafCount - next;
        ctx.check(lastEpoch + 1n >= deployEpoch, 'the relay starts its forward-only epoch rule at its deployment: no root labelled before it can consume a one-time index (I17, I35)', {
          lastEpoch,
          deployEpoch,
          epochNow: now,
          indicesBurnableAtOneTimestamp: burnable,
          leafCount,
        });
      } else {
        ctx.note(`OC-LEGA-02's starting state is not observable: the relay has admitted since deployment (lastEpoch ${lastEpoch})`);
      }
    }

    /* ================================================================ S1: code and immutables */
    {
      const art = H.originArtifact(ctx, 'ArkEpochRootRelay');
      const code = await ctx.origin.code(ctx.r.relay);
      const imm = {};
      for (const k of ['THRESHOLD', 'SIGNER_COUNT', 'TREE_HEIGHT', 'LEAF_COUNT', 'MIGRATION_HORIZON', 'EXTENSION_OPENS', 'EXTENSION_CLOSES']) imm[k] = BigInt(await rv(k));
      const cmp = H.compareCode(code, art.deployedBytecode, Object.values(imm));
      ctx.check(cmp.ok, 'the relay\'s runtime code is the artifact\'s, byte for byte outside its immutables (I2)', { codeHash: cmp.codeHash, length: cmp.length, artifactLength: cmp.artifactLength, masked: cmp.masked.length, unexpected: cmp.unexpected, outside: cmp.outside.slice(0, 8) });
      const bad = H.forbiddenIn(code);
      ctx.check(bad.length === 0, 'the relay holds no DELEGATECALL, CALLCODE or SELFDESTRUCT: nothing can replace its code (I2)', { found: bad });

      const auth = m.authority || {};
      const g = Number(await rv('generation'));
      ctx.check(
        imm.THRESHOLD === BigInt(auth.threshold) && imm.SIGNER_COUNT === BigInt(auth.signers) && imm.TREE_HEIGHT === BigInt(auth.treeHeight),
        'the relay\'s k, n and tree height are the manifest\'s authority (whitepaper §3.6, I16)',
        { relay: { k: imm.THRESHOLD, n: imm.SIGNER_COUNT, h: imm.TREE_HEIGHT }, manifest: { k: auth.threshold, n: auth.signers, h: auth.treeHeight } },
      );
      ctx.check(imm.LEAF_COUNT === 1n << imm.TREE_HEIGHT && imm.MIGRATION_HORIZON === (imm.LEAF_COUNT * 8000n) / BPS && imm.EXTENSION_OPENS === (imm.LEAF_COUNT * 5000n) / BPS && imm.EXTENSION_CLOSES === (imm.LEAF_COUNT * 9500n) / BPS, 'the leaf set, the migration horizon and the extension window are the fixed ratios of the tree (whitepaper §6.4, I35)', imm);
      const roots = [...(await rv('signerRoots'))].map(lower);
      const want = ((auth.generations || [])[g - 1] || []).map(lower);
      ctx.check(roots.length === want.length && roots.every((x, i) => x === want[i]), `the active signer roots are generation ${g} of the manifest's authority chain (I16, I35)`, { generation: g, roots, manifest: want });
      const commit = lower(await rv('chainCommit'));
      ctx.check(commit === lower((auth.commits || [])[g - 1]), 'the relay commits to the next link the manifest records (I35)', { chainCommit: commit, manifest: (auth.commits || [])[g - 1] });
      for (const [name, slot] of Object.entries(H.EIP1967)) {
        const v = await H.readSlot(ctx, ctx.r.relay, slot);
        if (v === null) continue;
        ctx.check(v === 0n, `the relay's EIP-1967 ${name} slot is empty: it is no proxy (I2)`, { slot, value: v });
      }

      for (const x of ctx.r.assets) {
        const form = deploy.escrowForm(x);
        const abi = ctx.r.escrowAbi(x);
        const v = async (k) => (await ctx.origin.call(x.escrow, abi, k))[0];
        const declared = m.assets.find((y) => lower(toHex(y.escrow)) === lower(x.escrow)) || x;
        const got = {
          ASSET: lower(await v('ASSET')),
          RELAY: lower(await v('RELAY')),
          OPERATIONS_DESTINATION: lower(await v('OPERATIONS_DESTINATION')),
          SEED_MINIMUM: BigInt(await v('SEED_MINIMUM')),
          QRL_OWNER_LENGTH: BigInt(await v('QRL_OWNER_LENGTH')),
          AUDIT_YIELD_RATE: BigInt(await v('AUDIT_YIELD_RATE')),
        };
        const want2 = {
          ASSET: lower(x.asset),
          RELAY: lower(ctx.r.relay),
          OPERATIONS_DESTINATION: lower(toHex(m.addresses.operationsDestination)),
          SEED_MINIMUM: deploy.seedMinimumOf(declared),
          QRL_OWNER_LENGTH: BigInt(deploy.qrlOwnerLengthOf(m)),
          AUDIT_YIELD_RATE: deploy.auditYieldRateOf(declared),
        };
        for (const k of Object.keys(want2)) {
          ctx.check(got[k] === want2[k], `${x.symbol}: ${k}() is the manifest's (I1, I3)`, { escrow: x.escrow, got: got[k], manifest: want2[k] });
        }
        if (want2.QRL_OWNER_LENGTH === 64n) ctx.note(`${x.symbol}: the escrow serves the QIP-55 line (64-byte owners)`);
        const ecode = await ctx.origin.code(x.escrow);
        const share = toHex(x.shareAccounting || x.asset);
        const ecmp = H.compareCode(ecode, H.originArtifact(ctx, form).deployedBytecode, [x.asset, share, ctx.r.relay, toHex(m.addresses.operationsDestination), want2.SEED_MINIMUM, want2.QRL_OWNER_LENGTH, want2.AUDIT_YIELD_RATE]);
        ctx.check(ecmp.ok, `${x.symbol}: the escrow's runtime code is the ${form} artifact's outside its immutables, and every immutable is a manifest value (I1, I2)`, { codeHash: ecmp.codeHash, length: ecmp.length, artifactLength: ecmp.artifactLength, masked: ecmp.masked.length, unexpected: ecmp.unexpected, outside: ecmp.outside.slice(0, 8) });
        const ebad = H.forbiddenIn(ecode);
        ctx.check(ebad.length === 0, `${x.symbol}: the escrow holds no DELEGATECALL, CALLCODE or SELFDESTRUCT (I2)`, { found: ebad });
        let read = 0;
        for (const [name, slot] of Object.entries(H.EIP1967)) {
          const s = await H.readSlot(ctx, x.escrow, slot);
          if (s === null) continue;
          read += 1;
          ctx.check(s === 0n, `${x.symbol}: the escrow's EIP-1967 ${name} slot is empty (I2)`, { slot, value: s });
        }
        if (!read) skip(`S1 EIP-1967 slots of ${x.symbol}: this origin client has no storage read (needs a storageAt on the client); the opcode scan stands in`);
      }
    }

    /* ================================================================ setup */
    const a = ctx.asset(opts.asset);
    const notional = units(opts.notional, 100);
    const owner = toHex(ctx.qrl.address);
    await ctx.seedIfNeeded(a);
    const P = await ctx.anchor(a, notional);
    const R = await ctx.anchor(a, notional / 10n);
    await ctx.waitAnchorRecorded(P.id);
    await ctx.waitAnchorRecorded(R.id);
    // An allocation must exist before the held epoch, so the commitment
    // refused there is refused for its age and not for its absence.
    await ctx.waitFor('an allocation recorded in the escrow', async () => BigInt((await a.call('recordedAllocation')).epoch) === (await ctx.originEpoch()), { sealNow: true, timeoutEpochs: 3 });

    // S18's payee: the asset contract itself, which stETH refuses to pay
    // (TRANSFER_TO_STETH_CONTRACT). Instructed now, so its unbonding runs
    // under the rows below.
    const payee = lower(a.asset);
    await ctx.registrySend('instructRelease', [R.id, ctx.r.evmArg(a.asset)]);
    ctx.note(`S18: position ${R.id.slice(0, 12)}… instructed to release to the asset contract itself`);

    /* ================================================================ S22 + S5: one epoch with its root held */
    const e0 = await ctx.originEpoch();
    await ctx.waitFor('a fresh epoch, its root held back', async () => (await ctx.originEpoch()) > e0, { tickOpts: { seal: false }, timeoutEpochs: 2 });
    const e = await ctx.originEpoch();
    const commitAmount = notional / 10n;
    await ctx.supply(a, commitAmount);
    await a.token.send('approve', [a.escrow, commitAmount]);

    const before = await a.call('recordedAllocation');
    if (BigInt(before.epoch) < e && before.set && BigInt(before.commitTermEpochs) > 0n) {
      await ctx.refuses('a commitment against an earlier epoch\'s allocation: it commits at the rung in force now (whitepaper §4.4)', 'AllocationStale', () => a.call('anchorCommitted', [owner, commitAmount]));
    } else {
      ctx.note('AllocationStale not observable here', { allocEpoch: before.epoch, epoch: e, term: before.commitTermEpochs });
    }

    // claimPremium's expiry, probed with a lock no root carries: the expiry is
    // read before the proof, so the refusal names which check stopped it.
    {
      const secret = keccak256(toUtf8Bytes('ark-e2e-lega:S22'));
      const lock = (expiry) => [[keccak256(toUtf8Bytes('ark-e2e-lega:lot')), ids.hashlockOf(secret), '0x' + '5e'.repeat(20), 1n, expiry, e, 0n], e - 1n, [], secret];
      const head = await ctx.origin.head();
      await ctx.refuses('a lock presented at its evmExpiry: the escrow\'s last instant is evmExpiry − 1 (I31)', 'PremiumExpired', () => a.call('claimPremium', lock(head.timestamp)));
      const later = ctx.origin.advance ? head.timestamp + 1n : head.timestamp + ctx.clock.EPOCH_LENGTH;
      const got = await H.outcome(ctx, () => ctx.origin.call(a.escrow, a.abi, 'claimPremium', lock(later)));
      ctx.check(got !== 'PremiumExpired' && got !== null, `${ctx.origin.advance ? 'one second' : 'an epoch'} before evmExpiry the expiry does not refuse it; the missing proof does (I31)`, { got, headTs: head.timestamp, evmExpiry: later });
    }

    // offerPremium at startOf(e) + 2 days.
    {
      const opens = ctx.clock.offerOpens(e);
      if ((await ctx.origin.head()).timestamp < opens) {
        const t1 = await H.reach(ctx, opens - 1n, { label: `one second before the offer opens in epoch ${e}` });
        if (t1 < opens) {
          await ctx.refuses('an offer before startOf(e) + 2 days, while the earlier offering\'s lots may still be claimed (whitepaper §4.7, I31)', 'OfferNotOpen', () => a.call('offerPremium'));
        } else {
          ctx.note('the head passed the instant before the offer opens between two polls; the refusal was not observed', { t1, opens });
        }
        const t2 = await H.reach(ctx, opens, { label: `the offer opening in epoch ${e}` });
        const got = await H.outcome(ctx, () => a.call('offerPremium'));
        ctx.check(got !== 'OfferNotOpen', 'from startOf(e) + 2 days the offer is open (whitepaper §4.7)', { got, headTs: t2, opens, exact: t2 === opens });
      } else {
        ctx.note('the offer had already opened in this epoch; boundary not observed', { epoch: e });
      }
    }

    // A root labelled with the epoch in progress, in its last moments.
    {
      const end = ctx.clock.endOf(e);
      const margin = ctx.origin.advance ? 1n : BigInt(Math.max(3 * ctx.pollSeconds, 45));
      const at = await H.reach(ctx, end - margin, { label: `the last moments of epoch ${e}` });
      const leafBefore = BigInt(await rv('nextLeaf'));
      const blk = (await ctx.origin.head()).latest;
      await ctx.tick({ sealNow: true });
      const lastEpoch = BigInt(await rv('lastEpoch'));
      const admitted = BigInt(await rv('admittedIn', [e]));
      ctx.check(lastEpoch === e && BigInt(await rv('nextLeaf')) === leafBefore + 1n, 'a root labelled with the epoch in progress is admitted in that epoch\'s last moments, consuming exactly one index (I17)', { epoch: e, headTs: at, end, lastEpoch, leafBefore });
      const adm = (await H.eventsOf(ctx, ctx.r.relay, ctx.r.abi.relay, blk, ['EpochRootAdmitted'])).find((x) => BigInt(x.args.epoch) === e);
      const usable = (admitted > e ? admitted : e) + 4n;
      ctx.check(Boolean(adm) && BigInt(adm.args.usableFromEpoch) === usable, 'its release receipts are usable from max(label, admitted) + 4 (D11)', { admittedIn: admitted, usableFrom: adm && adm.args.usableFromEpoch });
      if (ctx.origin.advance) ctx.check(admitted === e, 'admitted at the last second of its own epoch, the relay\'s clock reading the same epoch (I17)', { admittedIn: admitted, epoch: e });
      const rec = await ctx.lastEvent(a, 'AllocationRecorded', blk).catch(() => null);
      ctx.check(Boolean(rec) && BigInt(rec.epoch) === e && BigInt((await a.call('recordedAllocation')).epoch) === e, 'the epoch\'s allocation is recorded from its root however late in the epoch it arrives (whitepaper §3.5)', { recorded: rec && rec.epoch });
    }

    /* ================================================================ S5: the reserve and a commitment */
    await ctx.waitFor('the next epoch\'s allocation recorded', async () => BigInt((await a.call('recordedAllocation')).epoch) === (await ctx.originEpoch()) && (await ctx.originEpoch()) > e, { sealNow: true, timeoutEpochs: 3 });
    const alloc = await a.call('recordedAllocation');
    let C = null;
    let cohort0 = null;
    {
      const auditRate = BigInt(await a.call('AUDIT_YIELD_RATE'));
      const need = (BigInt(alloc.psrCapBps) * 4n * auditRate * commitAmount) / (BPS * ONE) + 1n;
      const prime = need * 2n + 1000n;
      await ctx.supply(a, prime);
      await a.token.send('approve', [a.escrow, prime]);
      const psr0 = await a.call('psrShares');
      const pu0 = await a.call('primeUnreplaced');
      const rc = await a.send('primePsr', [prime]);
      const ev = parseLogs(a.abi, rc.logs).find((x) => x.name === 'PsrPrimed');
      const shares = ev ? BigInt(ev.args.shares) : 0n;
      ctx.check(shares > 0n && (await a.call('psrShares')) - psr0 === shares && (await a.call('primeUnreplaced')) - pu0 === shares, 'the treasury\'s prime joins the reserve and is counted as prime the levy has not yet replaced (whitepaper §4.4, PV-04)', { prime, shares, psr0, pu0 });

      if (BigInt(alloc.commitTermEpochs) === 0n) {
        await ctx.refuses('a commitment where the allocation names no term', 'CommitmentUnavailable', () => a.call('anchorCommitted', [owner, commitAmount]));
        skip('S5 commitment and top-up: the allocation in force names no commitment term');
      } else if (alloc.stepQueued) {
        await ctx.refuses('a commitment while a stage step is queued (whitepaper §4.4, QL-25)', 'StageStepQueued', () => a.call('anchorCommitted', [owner, commitAmount]));
        skip('S5 commitment and top-up: a threat-stage step was queued in the allocation in force');
      } else {
        await ctx.supply(a, commitAmount);
        await a.token.send('approve', [a.escrow, commitAmount]);
        const rc2 = await a.send('anchorCommitted', [owner, commitAmount], { gas: 900_000 });
        const logs = parseLogs(a.abi, rc2.logs);
        const anchored = logs.find((x) => x.name === 'Anchored');
        const committed = logs.find((x) => x.name === 'Committed');
        C = { id: anchored.args.stakeAssetId };
        const [, c] = await ctx.origin.call(a.escrow, a.abi, 'cohortOf', [C.id]);
        cohort0 = c;
        const now = await ctx.originEpoch();
        ctx.check(
          Boolean(committed) && BigInt(c.mult) === ONE && BigInt(c.sigmaCommitBps) === BigInt(alloc.sigmaTargetBps) && BigInt(c.untilEpoch) === now + BigInt(alloc.commitTermEpochs),
          'a commitment joins the cohort of its epoch at the target rung and for the term in force (whitepaper §4.4, I39)',
          { sigmaCommitBps: c.sigmaCommitBps, target: alloc.sigmaTargetBps, untilEpoch: c.untilEpoch, term: alloc.commitTermEpochs, epoch: now },
        );
        await ctx.waitAnchorRecorded(C.id);
      }
    }

    /* ================================================================ S22 + S18: the release at exactly usableFrom */
    {
      const rel = ctx.sealed('release', (x) => x.id === R.id);
      const admitted = BigInt(await rv('admittedIn', [rel.epoch]));
      const usableFrom = (admitted > rel.epoch ? admitted : rel.epoch) + 4n;
      const due = ctx.clock.startOf(usableFrom);
      const args = [R.id, rel.recipient, rel.claimNonce, rel.epoch, ctx.proof(rel.epoch, rel.leaf)];
      ctx.check((await a.call('transitShares', [R.id])) > 0n, 'the first presentation took the position out of the priced book into transit (X7, I18)', { id: R.id });
      const relFrom = (await ctx.origin.head()).latest;
      if ((await ctx.origin.head()).timestamp < due - 1n) {
        const t1 = await H.reach(ctx, due - 1n, { label: `one second before epoch ${usableFrom}`, tickOpts: {} });
        if (t1 < due) {
          await ctx.refuses('a receipt presented again one second before usableFrom · L', 'UnbondingNotServed', () => a.call('release', args));
        }
        const t2 = await H.reach(ctx, due, { label: `epoch ${usableFrom}, the receipt's usableFrom`, tickOpts: {} });
        const got = await H.outcome(ctx, () => ctx.origin.call(a.escrow, a.abi, 'release', args));
        ctx.check(got === null, 'at usableFrom · L the receipt is consumed: the unbonding is the epoch count and nothing more (whitepaper §3.3, D11)', { got, headTs: t2, due, exact: t2 === due });
      } else {
        ctx.note('the release boundary had already passed; not observed', { due });
      }

      await ctx.waitFor('the refused-payee release paid or credited', async () => (await a.call('owedShares', [payee])) > 0n || (await ctx.transferredTo(a, payee, relFrom)) > 0n, { timeoutEpochs: 4 });
      const owed = await a.call('owedShares', [payee]);
      if (owed > 0n) {
        const deferred = (await H.eventsOf(ctx, a.escrow, a.abi, relFrom, ['PaymentDeferred'])).find((x) => lower(x.args.recipient) === payee);
        ctx.check(Boolean(deferred) && BigInt(deferred.args.shares) === owed, 'a payment the asset refuses is credited to the payee, not reverted: the queue behind it moves (whitepaper §3.3)', { owedShares: owed, event: deferred && deferred.args.shares });
        ctx.check((await a.call('unclaimedShares')) >= owed, 'the credit is counted in unclaimedShares, the fifth term of the holding identity', { unclaimed: await a.call('unclaimedShares') });
        await ctx.refuses('withdrawOwed to a payee the asset still refuses', 'PaymentRefused', () => a.call('withdrawOwed', [payee]));
        ctx.check((await a.call('owedShares', [payee])) === owed, 'a refused withdrawal keeps the credit whole', { owed });
      } else {
        ctx.check((await ctx.transferredTo(a, payee, relFrom)) > 0n, 'the release is paid to the recipient committed on QRL', { payee });
        skip(`S18 refused payment: ${a.symbol} does not refuse its own address (only stETH does), so PaymentDeferred / withdrawOwed are not reached here`);
      }
    }

    /* ================================================================ S5: a stage step tops the cohort up */
    {
      // The stage step: a vote on a parameter set from before item 129, the
      // phase double's next phase (or the band of phase 2) since; never on
      // core's ArkPhase, whose steps are 30-day timelock operations.
      const stages = await stageKit(ctx);
      const mayVote = await stages.may();
      if (!C) {
        // already listed
      } else if (!a.mock || !mayVote) {
        skip(`S5 top-up on a stage step: ${!a.mock ? 'needs a double\'s yield' : stages.kind === 'core' ? 'the stage is core ArkPhase\'s, moved through the timelock' : 'the deployer is not governance of ArkStakeParams here'}`);
      } else {
        const stage = await stages.stage();
        if (stage >= 4) {
          skip('S5 top-up on a stage step: the threat ladder is already at its top');
        } else {
          const effective = await stages.step(stage, stage + 1);
          const eStep = effective - 1n;
          ctx.note(`threat stage ${stage} -> ${stage + 1}, in force from epoch ${effective} (${stages.kind === 'legacy' ? 'the deployer is governance here' : `the ${stages.kind} phase moved`})`);
          await ctx.waitFor('the stepped target in the allocation the escrow holds', async () => {
            const al = await a.call('recordedAllocation');
            return BigInt(al.epoch) > eStep && BigInt(al.sigmaTargetBps) > BigInt(cohort0.sigmaCommitBps);
          }, { sealNow: true, timeoutEpochs: 4 });
          const yFrom = (await ctx.origin.head()).latest;
          await ctx.produceYield(a, notional / 2n);
          const topUp = async () => (await H.eventsOf(ctx, a.escrow, a.abi, yFrom, ['ReserveSwept'])).find((x) => BigInt(x.args.demandUnits) > 0n);
          await ctx.waitFor('a sweep that owed the cohort its top-up', async () => Boolean(await topUp()), { timeoutEpochs: 3 });
          const ev = await topUp();
          ctx.check(BigInt(ev.args.paidUnits) > 0n, 'a step above a committed rung makes the reserve pay the cohort\'s gap to the spot rung (whitepaper §4.4, I39)', { demand: ev.args.demandUnits, paid: ev.args.paidUnits, levy: ev.args.levyUnits });
          const [, c1] = await ctx.origin.call(a.escrow, a.abi, 'cohortOf', [C.id]);
          ctx.check(BigInt(c1.mult) > BigInt(cohort0.mult), 'the top-up reaches the cohort as stake: its multiplier rises, no position is walked (I39)', { before: cohort0.mult, after: c1.mult });
          await ctx.waitFor('an epoch in which the stage may step again', async () => (await ctx.originEpoch()) > eStep, { timeoutEpochs: 2 });
          await stages.step(stage + 1, stage);
          ctx.note(`threat stage stepped back to ${stage}`);
        }
      }
    }

    /* ================================================================ S9: a freeze over an outstanding loss (OL-06) */
    if (!a.mock) {
      skip('S9 freeze over an outstanding loss: needs buffer inflow on demand (a double\'s yield)');
    } else {
      const D1 = '0x' + 'd1'.repeat(20);
      const D2 = '0x' + 'd2'.repeat(20);
      const from = (await ctx.origin.head()).latest;
      const lossTo = async (dest) => (await H.eventsOf(ctx, a.escrow, a.abi, from, ['LossQueued'])).find((x) => lower(x.args.destination) === dest);
      const buffer0 = await a.call('toUnits', [await a.call('bufferShares')]);
      const q1 = buffer0 * 3n + ONE;
      ctx.r.enqueue({ kind: 'loss', stakeAssetId: P.id, asset: a.asset, destination: D1, quantity: q1 });
      await ctx.waitFor('the first loss settled against the buffer', async () => Boolean(await lossTo(D1)), { sealNow: true, timeoutEpochs: 3 });
      const owed1 = await a.call('lossOwedUnits');
      ctx.check(owed1 > 0n && (await a.call('bufferShares')) <= 1n, 'a loss above the buffer takes the buffer and the rest is owed, not refused: an outstanding claim (whitepaper §5.2, D17)', { quantity: q1, buffer: buffer0, lossOwedUnits: owed1 });

      ctx.r.enqueue({ kind: 'freeze', asset: a.asset, frozen: true });
      await ctx.waitFor('the freeze in force', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].frozen === true, { sealNow: true, timeoutEpochs: 3 });

      const inflowFrom = (await ctx.origin.head()).latest;
      await ctx.produceYield(a, notional / 2n);
      await ctx.waitFor('buffer inflow under the freeze', async () => (await a.call('bufferShares')) > 1n || (await a.call('lossOwedUnits')) < owed1, { timeoutEpochs: 2 });
      const inflow = await a.call('toUnits', [await a.call('bufferShares')]);
      const paidOlderFirst = await ctx.transferredTo(a, D1, inflowFrom);
      const q2 = inflow / 2n > 0n ? inflow / 2n : 1n;
      ctx.r.enqueue({ kind: 'loss', stakeAssetId: P.id, asset: a.asset, destination: D2, quantity: q2 });
      await ctx.waitFor('the second loss settled', async () => Boolean(await lossTo(D2)), { sealNow: true, timeoutEpochs: 3 });
      await ctx.waitEpochs(1);
      const paidOlder = await ctx.transferredTo(a, D1, inflowFrom);
      const paidNewer = await ctx.transferredTo(a, D2, inflowFrom);
      const owedNow = await a.call('lossOwedUnits');
      ctx.check(paidNewer === 0n || paidOlder >= owed1 - 2n, 'under a freeze, buffer inflow pays the older outstanding loss claim before a newer loss: losses leave in queue order (I11, D17)', {
        olderOwedAtFreeze: owed1,
        inflowUnits: inflow,
        paidToOlderBeforeNewer: paidOlderFirst,
        paidToOlder: paidOlder,
        paidToNewer: paidNewer,
        newerQuantity: q2,
        lossOwedUnits: owedNow,
      });

      ctx.r.enqueue({ kind: 'freeze', asset: a.asset, frozen: false });
      await ctx.waitFor('the freeze lifted', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].frozen === false, { sealNow: true, timeoutEpochs: 3 });
      const still = await a.call('lossOwedUnits');
      if (still > 0n) {
        const bufferBps = BigInt((await a.call('recordedAllocation')).bufferBps) || 250n;
        await ctx.produceYield(a, (still * BPS * 2n) / bufferBps + ONE);
      }
      await ctx.waitFor('every outstanding loss claim paid from buffer inflow once the freeze lifted', async () => (await a.call('lossOwedUnits')) === 0n, { timeoutEpochs: 4 });
      ctx.check((await ctx.transferredTo(a, D1, from)) >= q1 - 4n && (await ctx.transferredTo(a, D2, from)) >= q2 - 2n, 'every determined loss is paid whole in the end, out of the buffer (whitepaper §5.2)', { q1, q2 });
    }

    /* ================================================================ probes */
    {
      // OC-LEGA-04: in each epoch the first Swept precedes AllocationRecorded.
      const evs = await H.eventsOf(ctx, a.escrow, a.abi, fromBlock, ['Swept', 'AllocationRecorded']);
      const byEpoch = new Map();
      for (let i = 0; i < evs.length; i += 1) {
        const ev = evs[i];
        const ep = ctx.clock.epochOf(await ctx.origin.timestampOf(ev.blockNumber));
        const row = byEpoch.get(ep) || { sweep: null, alloc: null };
        if (ev.name === 'Swept' && row.sweep === null) row.sweep = i;
        if (ev.name === 'AllocationRecorded' && row.alloc === null) row.alloc = i;
        byEpoch.set(ep, row);
      }
      const both = [...byEpoch.entries()].filter(([, r]) => r.sweep !== null && r.alloc !== null);
      // Since the fix the recording settles first, in its own transaction: a
      // Swept there, or nothing accrued to settle. On a non-rebasing double
      // the yield is a mint into the escrow, so "nothing accrued" is checked:
      // no mint since the last settlement (Swept) before the recording.
      const mints = a.mock && !a.rebasing
        ? (await H.eventsOf(ctx, a.asset, ctx.r.tokenAbi(a), fromBlock, ['Transfer'])).filter((x) => /^0x0{40}$/i.test(toHex(x.args.from)) && lower(toHex(x.args.to)) === lower(a.escrow))
        : [];
      const at = (x) => [BigInt(x.blockNumber), Number(x.logIndex || 0)];
      const before = (x, y) => at(x)[0] < at(y)[0] || (at(x)[0] === at(y)[0] && at(x)[1] < at(y)[1]);
      const unsettled = (r) => {
        const rec = evs[r.alloc];
        if (evs.some((x) => x.name === 'Swept' && x.transactionHash === rec.transactionHash && before(x, rec))) return false;
        const last = evs.slice(0, r.alloc).reverse().find((x) => x.name === 'Swept');
        return mints.some((m) => before(m, rec) && (!last || before(last, m)));
      };
      const firstAfter = both.filter(([, r]) => r.sweep > r.alloc);
      const late = firstAfter.filter(([, r]) => unsettled(r)).map(([ep]) => ep);
      ctx.check(late.length === 0, 'in every epoch the yield accrued before the allocation is recorded is settled first, so it is divided at the rates it accrued under (I19, I39)', { epochsWithBoth: both.length, recordedBeforeTheFirstSweep: firstAfter.map(([ep]) => ep), unsettledIn: late, evidence: a.mock && !a.rebasing ? 'mints' : 'its own Swept (no mint evidence on this asset)' });

      // OC-LEGA-02: indices consumed since deployment against epochs elapsed.
      const rel = await H.eventsOf(ctx, ctx.r.relay, ctx.r.abi.relay, fromBlock, ['EpochRootAdmitted', 'ExtensionScheduled', 'ExtensionCancelled']);
      const labels = [...new Set(rel.map((x) => String(x.args.epoch)))].map(BigInt);
      const epochsSince = (await ctx.originEpoch()) - deployEpoch;
      const earliest = labels.length ? labels.reduce((x, y) => (x < y ? x : y)) : null;
      ctx.check(BigInt(labels.length) <= epochsSince + 1n && (earliest === null || earliest >= deployEpoch), 'indices consumed since deployment ≤ epochs since deployment + 1, and no message labelled before the deployment (I17)', { consumed: labels.length, epochsSince, deployEpoch, earliestLabel: earliest });
    }
    await ctx.invariants('leg-a-live');
  },
};
