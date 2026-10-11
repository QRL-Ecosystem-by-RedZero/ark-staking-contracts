/**
 * Leg B, the QRL leg's core, as it runs (OC audit 2026-10-03, LEG-B
 * REPORT.md "On-chain scenarios needed" S1–S10): the wiring and handover,
 * an anchor recorded and released, the buffer channel, parameter governance,
 * a pool deposit, a validator funded, the provisional distribution, a
 * reconciliation report and the harvest of the bond's staking gain.
 *
 * Scenario steps assert the specification. Where an open finding of the
 * round predicts a breach the rule is recorded with `ctx.knownIssue` and the
 * run carries on: OC-LEGB-02 (the deposit check burns the report slot of its
 * epoch, so a second funding in it is refused), OC-LEGB-05 (a diff executed
 * in the epoch the previous one took effect rewrites the set read for the
 * epoch before), OC-LEGB-06 (no live component seals reconciliation
 * reports), OC-LEGB-12 (the deployed code cannot be matched to a build on
 * disk), OC-GOV-03 (the deployer governs until the handover).
 *
 * NOT TERMINAL. What it changes it restores or leaves as a holder would:
 * the senior coupon moves 100 -> 99 and back, the threat stage one step and
 * back (only where this run governs directly), one release is instructed and
 * paid, one small pool deposit stays with its actor.
 *
 * Harness-only stand-ins, each refused on a live chain by name (helpers/
 * leg-b.js): a validator funded from fixture keys with deposit data written
 * for the delegation's own credentials (S7), value arriving at the
 * delegation as a withdrawal would (S8, S9), and the attester quorum's
 * report (S9). On a live chain those rows are read-only probes.
 *
 * Wall clock (clock-derived waits only): about 10 epochs on the harness's
 * clock — the anchor and buffer records (1–2), the two parameter epochs (2),
 * the funding epoch and the report's challenge window (3), the rest of the
 * release's unbonding and queue (2–3). Rapid profile (rehearsal, 7-minute
 * epochs): ≈ 70–80 min. Testnet profile (hoodi-vps, 70-minute epochs):
 * ≈ 12 h; on hoodi-vps the timelock governs and S7–S9 are read-only, so the
 * run is bounded by the release (≈ 7–8 epochs, ≈ 9 h). On the harness the
 * whole run takes under a minute.
 */
const { ONE, BPS, units } = require('../lib');
const { qrlBuild, parseLogs } = require('../../lib/chains');
const { qrlLegBuild } = require('../../lib/deploy');
const { buildTree, proofFor } = require('../../../ecdsa-stakings/relayer/lib/merkle');
const { LegB, STATUS, KIND, VALIDATOR, K, same, sameEvm, isZero, lower } = require('../helpers/leg-b');
const { stageKit } = require('../helpers/phase');

const BASE_OUT = [
  'S11 recall and exit, S12 the staking loss, OC-LEGB-01/03/04: leg-b-exit.js (terminal, harness-oriented)',
  'OC-LEGB-07..11 (in-flight valuation, buffer keyed by asset, the allocation leaf window, Batch truncation, markPremium gas): read-only findings with no scenario row',
];
const OUT = [...BASE_OUT];

/** On-chain code against an artifact's runtime: equal, but where the artifact byte is zero (an immutable's placeholder). */
function codeMatches(onchain, artifact) {
  const a = String(onchain).replace(/^0x/, '').toLowerCase();
  const b = String(artifact).replace(/^0x/, '').toLowerCase();
  if (a.length !== b.length) return { ok: false, onchainBytes: a.length / 2, artifactBytes: b.length / 2 };
  let differs = 0;
  for (let i = 0; i < b.length; i += 2) {
    const x = a.slice(i, i + 2);
    const y = b.slice(i, i + 2);
    if (x === y) continue;
    if (y !== '00') return { ok: false, firstMismatchAt: i / 2, onchain: x, artifact: y, bytes: b.length / 2 };
    differs += 1;
  }
  return { ok: true, bytes: b.length / 2, immutableBytes: differs };
}

/** The value of a key in force IN epoch `x`, replayed from its ParamChangeStaged history. */
function historyAt(history, key, x, fallback) {
  const mine = history.filter((h) => lower(h.args.key) === lower(key));
  const inForce = mine.filter((h) => BigInt(h.args.effectiveEpoch) <= x);
  if (inForce.length) return BigInt(inForce[inForce.length - 1].args.value);
  const later = mine.find((h) => BigInt(h.args.effectiveEpoch) > x);
  return later ? BigInt(later.args.previous) : BigInt(fallback);
}

module.exports = {
  description: 'Leg B live (OC LEG-B S1–S10): wiring and handover, an anchor recorded and released with its refusals, the buffer channel, parameter governance (OC-LEGB-05), a pool deposit (D16), a validator funded (OC-LEGB-02), the provisional distribution (I32), a reconciliation report (OC-LEGB-06) and the harvest',
  terminal: false,
  outOfScope: OUT,
  async run(ctx, opts) {
    OUT.length = BASE_OUT.length;
    const out = (s) => {
      if (!OUT.includes(s)) OUT.push(s);
    };
    const lb = new LegB(ctx);
    const q = ctx.r.q;
    const dep = ctx.r.deployment;
    const me = ctx.qrl.address;
    const live = lb.live;
    const E = BigInt(ctx.clock.EPOCH_LENGTH);
    const startBlock = await lb.head();
    const startEpoch = await lb.epoch();
    const originStart = (await ctx.origin.head()).latest;
    ctx.note(`${live ? 'live QRL client' : 'harness'}; epoch ${E} s; start block ${startBlock}, epoch ${await lb.epoch()}`);

    /* ================================================== S1 wiring and handover */
    const timelock = dep.governance && dep.governance.addresses && dep.governance.addresses.ArkTimelock;
    for (const k of ['Pa', 'R', 'D']) {
      const g = await lb.view(k, 'governance');
      const p = await lb.view(k, 'pendingGovernance');
      if (timelock) {
        ctx.knownIssue('OC-GOV-03', same(g, timelock) && isZero(p), `S1.1 ${k === 'Pa' ? 'ArkStakeParams' : k === 'R' ? 'ArkStakeRegistry' : 'ArkBondDelegation'}: ArkTimelock governs and nothing is pending (G2)`, { governance: g, pending: p, timelock });
      } else {
        ctx.check(same(g, dep.roles.governance) && isZero(p), `S1.1 ${k}: governance is the account the deployment named and nothing is pending (no governance stack on this deployment)`, { governance: g, pending: p, named: dep.roles.governance });
      }
    }
    if (!timelock) out('S1.1 governance() == ArkTimelock: this deployment has no governance stack (harness default); governance-qday.js and governance-live.js run the handover');
    ctx.check(same(await lb.view('Pa', 'registry'), q.ArkStakeRegistry), 'S1.2 the parameter set reads the registry it was wired to');
    const deps = { attestation: await lb.view('R', 'attestation'), qday: await lb.view('R', 'qday'), priceOracle: await lb.view('R', 'priceOracle'), bond: await lb.view('R', 'bond') };
    ctx.check(
      same(deps.attestation, q.MockAttestation) && same(deps.qday, dep.qday.address) && same(deps.priceOracle, q.ArkReferenceOracle || q.MockPriceOracle) && same(deps.bond, q.ArkCatBond),
      'S1.3 the registry reads the attestation, the Q-Day oracle, the price oracle and the bond the deployment record names',
      { ...deps },
    );
    ctx.check(
      same(await lb.view('S', 'venue'), q.ArkStakingPool) && same(await lb.view('P', 'delegation'), q.ArkBondDelegation) && same(await lb.view('D', 'BOND'), q.ArkStakingPool) && (await lb.big('D', 'CONCENTRATION_BPS')) === 10_000n,
      "S1.4 bond principal's path: the staking contract's venue is the pool, the pool's delegation names the pool as its counterparty, concentration 10,000 bps",
    );
    const creds = lower(await lb.view('D', 'withdrawalCredentials'));
    const dAddr = lower(q.ArkBondDelegation);
    ctx.check(creds === dAddr || creds === `0x${'0'.repeat(24)}${dAddr.slice(2)}`, "S1.5 the delegation's withdrawal credentials are its own address: every withdrawal comes back to it", { credentials: creds, delegation: dAddr });
    {
      const build = qrlLegBuild(ctx.qrl, ctx.r.manifest);
      const fs = require('fs');
      const path = require('path');
      for (const name of ['ArkStakeParams', 'ArkStakeRegistry', 'ArkBondDelegation', 'ArkStakingPool', 'ArkBondStaking']) {
        const art = JSON.parse(fs.readFileSync(path.join(build, `${name}.json`), 'utf8'));
        const m = codeMatches(await ctx.qrl.code(q[name]), art.deployedBytecode);
        const rule = `S1.6 ${name}: the deployed code is the build on disk (${path.basename(build)}), immutables aside`;
        if (live) ctx.knownIssue('OC-LEGB-12', m.ok, rule, m);
        else ctx.check(m.ok, rule, m);
      }
    }

    /* ================================================== S2 the anchor record (I4, I6) */
    const a = ctx.asset(opts.asset);
    await ctx.seedIfNeeded(a);
    const chainId = ctx.r.chainId;
    const key = await ctx.registry('assetKey', [chainId, ctx.r.evmArg(a.asset)]);
    const group = (await lb.view('R', 'assetProfile', [key])).correlationGroup;
    // Read before the totals, so every Anchored after it is in the S2.7 sum.
    const anchorBlock = await lb.head();
    const total0 = BigInt(await ctx.registry('totalAnchored'));
    const transit0 = BigInt(await ctx.registry('totalInTransit'));
    const group0 = BigInt(await ctx.registry('groupAnchored', [group]));
    const notional = units(opts.notional, 100);
    const anchored = await ctx.anchor(a, notional);
    ctx.check(Boolean(anchored.id), 'S2.1 the escrow emits Anchored for a deposit (whitepaper §3.2)', { id: anchored.id, epoch: anchored.epoch });
    await ctx.waitAnchorRecorded(anchored.id);
    const id = lower(anchored.id);
    const recEv = (await lb.events('R', 'Anchored', anchorBlock)).find((x) => lower(x.args.stakeAssetId) === id);
    ctx.check(
      recEv && same(recEv.args.boundQrlOwner, anchored.boundQrlOwner) && lower(recEv.args.assetKey) === lower(key) && BigInt(recEv.args.anchoredNotional) === BigInt(anchored.notional) && BigInt(recEv.args.epoch) === anchored.epoch,
      'S2.2 recordAnchor emits Anchored(id, owner, assetKey, notional, epoch) for the escrow\'s deposit, as the escrow stated it',
      { event: recEv && recEv.args },
    );
    const rec = await lb.view('R', 'anchorOf', [anchored.id]);
    const recordTs = await ctx.qrl.timestampOf(recEv.blockNumber);
    const boundary = ctx.clock.startOf(anchored.epoch + 1n);
    const expectAt = boundary < recordTs ? boundary : recordTs;
    ctx.check(
      Number(rec.status) === 1 && same(rec.boundQrlOwner, anchored.boundQrlOwner) && sameEvm(rec.escrow, a.escrow) && BigInt(rec.anchoredAt) === expectAt,
      'S2.3 the record is anchored, bound to its owner and escrow, anchoredAt = min(startOf(epoch + 1), record time) (I4, I6, G6)',
      { status: rec.status, escrow: rec.escrow, anchoredAt: rec.anchoredAt, expected: expectAt },
    );
    const st = ctx.r.state.data.anchors[anchored.id] || ctx.r.state.data.anchors[id];
    const input = [chainId, ctx.r.evmArg(st.asset), ctx.r.evmArg(st.depositor), ctx.r.ownerArg(st.boundQrlOwner), BigInt(st.depositNonce), BigInt(st.anchoredNotional), ctx.r.evmArg(st.escrow || a.escrow)];
    const recomputed = await ctx.registry('stakeAssetId', [chainId, input[1], input[2], input[3], input[4]]);
    ctx.check(lower(recomputed) === id, 'S2.4 the identifier is stakeAssetId(chainId, asset, depositor, owner, nonce): the beneficiary is inside it (I4)', { id, recomputed });
    const f = ctx.r.state.data.forward[String(anchored.epoch)];
    const item = f.items.find((x) => x.kind === 'anchor' && lower(x.id) === id);
    const proof = proofFor(buildTree(ctx.r.forwardLeaves(anchored.epoch, f)), item.leaf);
    await ctx.refuses('S2.5 a replay of the recorded anchor (I6)', 'AnchorExists', () => lb.call('R', 'recordAnchor', [input, anchored.epoch, proof]));
    if (live && String(input[6]).length === 130) {
      const high = `0x01${String(input[6]).slice(4)}`;
      await ctx.refuses('S2.6 a copy of the call with a nonzero high word in the escrow (QL-27)', 'AnchorNotCanonical', () => lb.call('R', 'recordAnchor', [[...input.slice(0, 6), high], anchored.epoch, proof]));
    } else {
      out('S2.6 AnchorNotCanonical: needs the 64-byte (v3) address slot; the harness leg is 20 bytes');
    }
    const total1 = BigInt(await ctx.registry('totalAnchored'));
    const group1 = BigInt(await ctx.registry('groupAnchored', [group]));
    // On a shared chain other anchors land in the same window (on hoodi-vps,
    // earlier runs' positions the relayer recorded meanwhile): the totals grow
    // by every notional the registry recorded since, this one included.
    const recordedSince = (await lb.events('R', 'Anchored', anchorBlock)).map((x) => x.args);
    const grewBy = recordedSince.reduce((t, x) => t + BigInt(x.anchoredNotional), 0n);
    const grewByGroup = recordedSince.filter((x) => lower(x.assetKey) === lower(key)).reduce((t, x) => t + BigInt(x.anchoredNotional), 0n);
    ctx.check(
      recordedSince.some((x) => lower(x.stakeAssetId) === id) && total1 - total0 === grewBy && group1 - group0 === grewByGroup,
      "S2.7 totalAnchored and the group's anchored notional grow by exactly the notionals recorded since, this anchor's among them (I18)",
      { total0, total1, group0, group1, notional: rec.anchoredNotional, recordedSince: recordedSince.length, grewBy, grewByGroup },
    );

    /* ================================================== S4 the buffer channel */
    await ctx.waitFor(`a buffer report of ${a.symbol} recorded on QRL`, async () => (await lb.events('R', 'BufferRecorded', startBlock)).some((x) => lower(x.args.assetKey) === lower(key)), { timeoutEpochs: 3 });
    {
      const recs = (await lb.events('R', 'BufferRecorded', startBlock)).filter((x) => lower(x.args.assetKey) === lower(key));
      const last = recs[recs.length - 1].args;
      const head = await ctx.origin.head();
      // From the deployment, not the scenario's start: on a live chain the relayer
      // reports every epoch, so the report QRL recorded can predate originStart.
      const reported = parseLogs(a.abi, await ctx.origin.logs(a.escrow, BigInt(ctx.r.manifest.deployedFromBlock || 0), head.latest)).filter((x) => x.name === 'BufferReported' && BigInt(x.args.epoch) === BigInt(last.epoch));
      const bof = await lb.view('R', 'bufferOf', [key]);
      ctx.check(
        reported.length === 1 && BigInt(reported[0].args.units) === BigInt(last.units) && BigInt(bof.units) === BigInt(last.units) && BigInt(bof.epoch) === BigInt(last.epoch),
        "S4.1 the escrow's reportBuffer reaches the registry as BufferRecorded, and bufferOf holds the escrow's figure for its epoch (whitepaper §4.3)",
        { epoch: last.epoch, units: last.units, origin: reported.map((x) => x.args.units), bufferOf: bof },
      );
      let sum = 0n;
      for (const x of dep.assets) sum += BigInt((await lb.view('R', 'bufferOf', [x.assetKey])).units);
      const orig = await lb.big('R', 'bufferOrig');
      ctx.check(orig === sum, 'S4.1 bufferOrig is the sum of the assets\' recorded buffers', { bufferOrig: orig, sum });
      const fb = ctx.r.state.data.forward[String(last.epoch)];
      const bItem = fb && fb.items.find((x) => x.kind === 'buffer' && sameEvm(x.escrow || a.escrow, a.escrow) && BigInt(x.epoch) === BigInt(last.epoch));
      if (bItem) {
        const bProof = proofFor(buildTree(ctx.r.forwardLeaves(BigInt(last.epoch), fb)), bItem.leaf);
        await ctx.refuses('S4.2 the same buffer report presented again', 'BufferReportNotNewer', () =>
          lb.call('R', 'recordBuffer', [chainId, ctx.r.evmArg(a.escrow), ctx.r.evmArg(a.asset), BigInt(last.epoch), BigInt(bItem.units), bProof]),
        );
        if (BigInt(last.epoch) > 0n) {
          await ctx.refuses('S4.2 an older buffer report', 'BufferReportNotNewer', () =>
            lb.call('R', 'recordBuffer', [chainId, ctx.r.evmArg(a.escrow), ctx.r.evmArg(a.asset), BigInt(last.epoch) - 1n, BigInt(bItem.units), bProof]),
          );
        }
      } else {
        out('S4.2 the replay refusal: the forward item of the latest buffer report is not in this relayer\'s state');
      }
      const bondCap = await lb.big('R', 'bondCapacityInOrigin');
      const attach = await lb.big('R', 'effectiveAttachmentBps');
      const required = await lb.big('R', 'requiredCapital');
      const cap = await lb.big('R', 'capacity');
      const util = await lb.big('R', 'utilisationBps');
      const standing = bondCap + orig;
      const capExpected = attach === 0n || bondCap === 0n ? cap : (standing * BPS) / attach;
      // As the kernel and the model: with no bond outstanding nothing stands
      // behind the requirement, the buffer included (`ArkStakeMath.utilisationBps`,
      // `ark-staking.ts` utilisationBps); utilisation is unbounded. A live book
      // with no subscription yet (hoodi-vps, 2026-10-05) is that case.
      const standingForUse = bondCap === 0n ? 0n : standing;
      const raw = required === 0n ? 0n : standingForUse === 0n ? 9007199254740991n : (required * BPS + standingForUse - 1n) / standingForUse;
      const utilExpected = raw > 9007199254740991n ? 9007199254740991n : raw;
      ctx.check(cap === capExpected && util === utilExpected, 'S4.3 capacity and utilisation count the recorded buffer beside the bond: capacity = (N_cap + buffer_orig)·BPS/attachment, utilisation = ⌈K·BPS/(N_cap + buffer_orig)⌉ (whitepaper §4.3)', { bondCapacityInOrigin: bondCap, bufferOrig: orig, attachmentBps: attach, capacity: cap, capExpected, requiredCapital: required, utilisationBps: util, utilExpected });
    }
    await ctx.invariants('S2 S4');

    /* ================================================== S3 release (I15, I18): instruct now, settle at the end */
    const recipient = '0x' + '5e'.repeat(20);
    const rArg = ctx.r.evmArg(recipient);
    const stranger = (await ctx.actor('legb-stranger')).address;
    await ctx.refuses('S3.1 a release instructed by an account that is not the bound owner (I15)', 'NotBoundOwner', () => lb.call('R', 'instructRelease', [anchored.id, rArg], { from: stranger }));
    if (live) {
      await ctx.refuses('S3.1 a release to a recipient wider than an origin-chain account (D14)', 'RecipientNotOriginAddress', () => lb.call('R', 'instructRelease', [anchored.id, '0x' + 'ab'.repeat(64)]));
    } else {
      out('S3.1 RecipientNotOriginAddress: needs the 64-byte (v3) address slot; the harness leg is 20 bytes');
    }
    const relTotal0 = BigInt(await ctx.registry('totalAnchored'));
    const relTransit0 = BigInt(await ctx.registry('totalInTransit'));
    const instr = await ctx.registrySend('instructRelease', [anchored.id, rArg]);
    const instrTs = await ctx.qrl.timestampOf(instr.blockNumber);
    const [rel] = lb.decode('R', instr.logs, 'ReleaseInstructed');
    const unbonding = await lb.big('R', 'UNBONDING_PERIOD');
    const rec2 = await lb.view('R', 'anchorOf', [anchored.id]);
    const n = BigInt(rec2.anchoredNotional);
    ctx.check(
      rel && lower(rel.args.stakeAssetId) === id && BigInt(rel.args.releasableAt) === instrTs + unbonding && BigInt(rec2.releasableAt) === instrTs + unbonding && Number(rec2.status) === 2,
      'S3.2 the owner\'s instruction emits ReleaseInstructed and the position is releasable twenty-one days on (whitepaper §3.3)',
      { releasableAt: rec2.releasableAt, instructedAt: instrTs, unbonding },
    );
    ctx.check(relTotal0 - BigInt(await ctx.registry('totalAnchored')) === n && BigInt(await ctx.registry('totalInTransit')) - relTransit0 === n, 'S3.2 the notional leaves the priced book and enters transit at the instruction (I18)', { notional: n });
    await ctx.refuses('S3.4 a second instruction for a position in transit', 'WrongStatus', () => lb.call('R', 'instructRelease', [anchored.id, rArg]));

    /* ================================================== S5 parameter governance (G1, G8, I13/22/25/28) */
    const Pa = (m, args) => lb.view('Pa', m, args);
    const paramGov = await lb.view('Pa', 'governance');
    const direct = same(paramGov, me);
    const SC = K('seniorCouponBps');
    {
      const exitNow = BigInt(await Pa('paramOf', [K('exitDeadlineEpochs')]));
      await ctx.refuses('S5.3 a diff that takes a key out of its range (exitDeadlineEpochs = 5)', 'ParameterOutOfRange', () => lb.call('Pa', 'setParamsDiff', [[[K('exitDeadlineEpochs'), exitNow, 5n]]], { from: paramGov }));
      const scNow = BigInt(await Pa('paramOf', [SC]));
      await ctx.refuses('S5.3 a value-transfer key moved more than its step (D7)', 'ParameterStepTooLarge', () => lb.call('Pa', 'setParamsDiff', [[[SC, scNow, scNow + 400n]]], { from: paramGov }));
    }
    let e0 = null;
    // Since item 129 the stage is the ecosystem phase's and a vote moves only
    // the band of phase 2: on the phase double the run enters phase 2 first
    // (and leaves it after S5); a parameter set from before then votes from
    // the stage it finds. On core's ArkPhase the parameter set is the
    // timelock's, so `direct` is false.
    const stages = direct ? await stageKit(ctx) : null;
    const enteredBand = direct && stages.kind === 'mock' && (await stages.may()) ? await stages.enterBand() : false;
    if (direct) {
      const sc0 = BigInt((await Pa('params')).seniorCouponBps);
      const to = sc0 > 0n ? sc0 - 1n : 1n;
      // A diff and a stage step in one epoch, early in it, so the second
      // diff lands in the epoch the first took effect (OC-LEGB-05).
      e0 = await lb.epoch();
      const rA = await lb.send('Pa', 'setParamsDiff', [[[SC, BigInt(await Pa('paramOf', [SC])), to]]]);
      const [stA] = lb.decode('Pa', rA.logs, 'ParamChangeStaged');
      ctx.check(
        stA && lower(stA.args.key) === lower(SC) && BigInt(stA.args.previous) === sc0 && BigInt(stA.args.value) === to && BigInt(stA.args.effectiveEpoch) === e0 + 1n && BigInt(await Pa('paramOf', [SC])) === to,
        'S5.1 a keyed diff stages its value for the next boundary: ParamChangeStaged(key, old, new, e + 1), paramOf reads the new value (G1)',
        { event: stA && stA.args, epoch: e0 },
      );
      ctx.check(BigInt((await Pa('params')).seniorCouponBps) === sc0 && BigInt(await Pa('seniorCouponBpsAt', [e0])) === sc0, 'S5.2 the set in force is unchanged until the boundary', { inForce: (await Pa('params')).seniorCouponBps });
      const stage0 = Number(await Pa('threatStage'));
      const stageTo = stage0 < 4 ? stage0 + 1 : stage0 - 1;
      const rS = await lb.send('Pa', 'setThreatStage', [stage0, stageTo]);
      ctx.check(lb.decode('Pa', rS.logs, 'ThreatStageSet').length === 1, 'S5.4 governance steps the threat stage one stage, from the next boundary (whitepaper §4.4)', { from: stage0, to: stageTo });
      await ctx.refuses('S5.4 a second threat-stage vote in the same epoch (D9)', 'ThreatStageAlreadyStepped', () => lb.call('Pa', 'setThreatStage', [stageTo, stageTo < 4 ? stageTo + 1 : stageTo - 1]));
      const alloc = await lb.view('R', 'allocation');
      ctx.check((await Pa('stageStepQueued')) === true && alloc.stepQueued === true, 'S5.5 while a stage step is queued the parameter set and the allocation leaf say so (QL-25)', { stageStepQueued: true, allocationStepQueued: alloc.stepQueued });

      await lb.untilEpoch('the boundary the diff takes effect at', e0 + 1n);
      ctx.check(BigInt((await Pa('params')).seniorCouponBps) === to && Number(await Pa('threatStage')) === stageTo, 'S5.2 from e + 1 the staged value and the stage are in force', { seniorCouponBps: (await Pa('params')).seniorCouponBps, stage: await Pa('threatStage') });
      // Diff B, in the epoch diff A took effect: the restore. Permissionless
      // execution makes this order reachable on any timelock (OC-LEGB-05).
      await lb.send('Pa', 'setParamsDiff', [[[SC, to, sc0]]]);
      await lb.send('Pa', 'setThreatStage', [stageTo, stage0]);
      const atE0 = BigInt(await Pa('seniorCouponBpsAt', [e0]));
      const atE1 = BigInt(await Pa('seniorCouponBpsAt', [e0 + 1n]));
      const runoffE0 = await Pa('runoffParamsAt', [e0]);
      ctx.check(atE1 === to, 'S5.6 seniorCouponBpsAt(e + 1) is the value in force in e + 1 (G8)', { atE1, expected: to });
      ctx.check(atE0 === sc0, 'S5.6 after a diff in e and another in e + 1, seniorCouponBpsAt(e) still reads the value in force in e (G8)', { epoch: e0, read: atE0, inForce: sc0 });
      ctx.check(Number(runoffE0[2]) === stage0, 'S5.6 runoffParamsAt(e) reads the threat stage in force in e', { stage: runoffE0[2], expected: stage0 });
      await lb.untilEpoch('the restore in force', e0 + 2n);
      ctx.check(BigInt((await Pa('params')).seniorCouponBps) === sc0 && Number(await Pa('threatStage')) === stage0, 'S5 the senior coupon and the stage are back where the run found them', { seniorCouponBps: (await Pa('params')).seniorCouponBps, stage: await Pa('threatStage') });
      if (enteredBand) {
        const back = await stages.restore();
        ctx.note(`S5 left the band: phase ${stages.home} in force again from epoch ${back}`);
      }
    } else {
      out(`S5.1/2/4/5/6 driven: parameters are governed by ${paramGov}, not this run's account; a value-transfer key waits 30 days in the timelock with one operation per key, so two diffs in consecutive epochs cannot be driven through it (governance-live.js drives the timelock); the G8 history probe below runs instead`);
    }
    {
      // G8 probe (OC-LEGB-05): the views against the ParamChangeStaged history.
      const history = await lb.events('Pa', 'ParamChangeStaged');
      const now = await lb.epoch();
      const probe = e0 !== null ? [e0, e0 + 1n] : [now - 1n];
      const inForce = await Pa('params');
      for (const x of probe) {
        const want = historyAt(history, SC, x, inForce.seniorCouponBps);
        const got = BigInt(await Pa('seniorCouponBpsAt', [x]));
        const ro = await Pa('runoffParamsAt', [x]);
        const roWant = [historyAt(history, K('runoffTriggerBps'), x, inForce.runoffTriggerBps), historyAt(history, K('runoffBoundBps'), x, inForce.runoffBoundBps), historyAt(history, K('queueDecayBps'), x, inForce.queueDecayBps), historyAt(history, K('queueExposureFloorBps'), x, inForce.queueExposureFloorBps)];
        const roGot = [BigInt(ro[0]), BigInt(ro[1]), BigInt(ro[3]), BigInt(ro[4])];
        ctx.check(got === want && roGot.every((v, i) => v === roWant[i]), `G8 probe: seniorCouponBpsAt(${x}) and runoffParamsAt(${x}) equal the ParamChangeStaged history's values in force in ${x}`, { epoch: x, seniorCoupon: { read: got, history: want }, runoff: { read: roGot, history: roWant }, changes: history.length });
      }
    }
    await ctx.invariants('S5');

    /* ================================================== S7 validator funding, S6 deposit, S8 provisional */
    const placed0 = BigInt((await ctx.qrl.call(q.ArkCatBond, lb.abi('B'), 'placedWithStaking'))[0]);
    if (placed0 === 0n) {
      const why = await lb.outcome(() => lb.call('B', 'placeWithStaking', [10n * ONE]));
      if (why === null) {
        await lb.send('B', 'placeWithStaking', [10n * ONE]);
        ctx.note('placed 10 QRL of bond principal with staking (permissionless), so the bond has a position to harvest');
      } else {
        ctx.note(`no bond principal placed with staking: ${why}`);
      }
    }
    let pkh = null;
    let e7 = null;
    if (lb.harness) {
      lb.installDepositRoot();
      const idle = await lb.big('D', 'idle');
      if (idle < VALIDATOR) await lb.send('P', 'deposit', [], { value: VALIDATOR - idle });
      const d = await lb.depositData(0);
      pkh = d.pkh;
      const operator = (await ctx.actor('legb-operator')).address;
      const ad = await lb.admit(d, operator);
      const [adm] = lb.decode('D', ad.receipt.logs, 'ValidatorAdmitted');
      ctx.check(adm && lower(adm.args.pubkeyHash) === lower(pkh) && BigInt(adm.args.bond) === ad.bond && lower(adm.args.depositDataRoot) === lower(d.root), 'S7.1 governance admits a validator behind the operator bond: ValidatorAdmitted (whitepaper §3.4)', { bond: ad.bond });
      const before = { count: await lb.depositCount(), delegated: await lb.big('D', 'delegated'), active: await lb.big('D', 'activeValidators') };
      const fund = await lb.delegate(d);
      e7 = fund.epoch;
      const [dl] = lb.decode('D', fund.receipt.logs, 'Delegated');
      const after = { count: await lb.depositCount(), delegated: await lb.big('D', 'delegated'), active: await lb.big('D', 'activeValidators') };
      ctx.check(
        dl && BigInt(dl.args.amount) === VALIDATOR && after.count === before.count + 1n && after.delegated === before.delegated + VALIDATOR && after.active === before.active + 1n,
        'S7.2 with the quorum\'s deposit check sealed, delegate deposits 40,000 QRL: Delegated, one deposit more at the deposit contract, delegated +40,000, one validator more',
        { before, after },
      );
      // OC-LEGB-02: the second validator's check, in the same epoch, as the relayer would seal it.
      const d2 = await lb.depositData(1);
      const leaf2 = await lb.view('D', 'depositCheckLeaf', [d2.pkh, await lb.depositRoot()]);
      const sealer = ctx.r.sealer.address;
      const got = await lb.outcome(async () => lb.call('A', 'seal', [await lb.big('D', 'depositCheckKey'), leaf2], { from: sealer }));
      ctx.check(got === null, 'S7.3 a second validator can be funded in the epoch of the first: its deposit check is sealed under a key of its own', { epoch: e7, secondSeal: got });
    } else {
      out('S7 driven (admit, seal, delegate): live chains keep it read-only — synthetic deposit data would lock 40,000 QRL in a validator that never runs; the relayer\'s bring-up funds the real one (pool-validator.js)');
    }
    {
      // OC-LEGB-02 / I32 probe, both legs: the report slot of every funding epoch.
      const funded = await lb.events('D', 'Delegated');
      for (const x of funded) {
        const fe = ctx.clock.epochOf(await ctx.qrl.timestampOf(x.blockNumber));
        const slot = await lb.view('A', 'rootOf', [await lb.big('D', 'reportKey', [fe])]);
        const check = await lb.view('D', 'depositCheckLeaf', [x.args.pubkeyHash, x.args.depositRoot]);
        ctx.check(lower(slot) !== lower(check), 'S7 probe: the reconciliation report of a funding epoch can still be sealed (the deposit check does not occupy reportKey(e))', { epoch: fe, slot, depositCheck: check });
      }
      if (!funded.length) ctx.note('no validator funded on this deployment yet; the funding-epoch probe found nothing to read');
    }

    // S6: a holder's deposit, in the epoch in progress.
    const v = lb.harness ? 10n * ONE : ONE;
    const depositor = await ctx.actor('legb-depositor', { fund: v + ONE });
    const e6 = await lb.epoch();
    const shares0 = await lb.big('P', 'sharesOf', [depositor.address]);
    const value0 = await lb.poolValue(depositor.address);
    const rd = await lb.send('P', 'deposit', [], { as: depositor, value: v });
    const [dpe] = lb.decode('P', rd.logs, 'Deposited');
    const funded6 = lb.decode('D', rd.logs, 'Funded');
    ctx.check(dpe && same(dpe.args.account, depositor.address) && BigInt(dpe.args.amount) === v && BigInt(dpe.args.shares) === 0n, 'S6.1 a deposit is recorded as Deposited(account, v, 0): no shares in the epoch it is made (D16)', { event: dpe && dpe.args });
    const shares1 = await lb.big('P', 'sharesOf', [depositor.address]);
    const value1 = await lb.poolValue(depositor.address);
    ctx.check(shares1 === shares0 && value1 - value0 >= v - 1n && value1 - value0 <= v, 'S6.1 the deposit holds no shares yet and is valued at what was sent', { shares0, shares1, value0, value1, v });
    const queued6 = await lb.big('P', 'lockedShares');
    ctx.check((funded6.length === 1 && BigInt(funded6[0].args.amount) > 0n) || (lb.live && queued6 > 0n), 'S6.2 the pool stakes what its queue is not owed: the delegation emits Funded', { funded: funded6.map((x) => x.args.amount), lockedShares: queued6 });

    // S8: the provisional distribution, against the epoch's reward cap (I32).
    const cap = await lb.big('D', 'rewardCap');
    if (lb.harness) {
      const credit8 = 2n * cap + ONE;
      await lb.credit(q.ArkBondDelegation, credit8);
      ctx.note(`stand-in: ${credit8} wei of validator rewards swept to the delegation (harness credit)`);
      const r8 = await lb.send('D', 'distributeProvisional', []);
      const [pd] = lb.decode('D', r8.logs, 'ProvisionallyDistributed');
      ctx.check(pd && same(pd.args.to, q.ArkStakingPool) && BigInt(pd.args.epoch) === e6 && BigInt(pd.args.amount) <= BigInt(pd.args.cap) && BigInt(pd.args.cap) === cap && BigInt(pd.args.amount) > 0n, 'S8.1 distributeProvisional forwards receipts to the pool, at most the epoch\'s reward cap (I32)', { event: pd && pd.args, cap });
      const s1 = await lb.solvency();
      ctx.check(s1.ok, 'S8.3 the delegation stays solvent after a provisional forward: balance ≥ idle + bonds + refunds + reconciled-unpaid', s1);
      await ctx.refuses('S8.2 a second forward in the same epoch once the cap is used', 'NothingToDistribute', () => lb.call('D', 'distributeProvisional', []));
      ctx.check((await lb.big('D', 'provisionalPaid')) <= cap, 'S8.2 what was forwarded in the epoch is within its cap (I32)', { provisionalPaid: await lb.big('D', 'provisionalPaid'), cap });
      if ((await lb.epoch()) === e6) {
        const value2 = await lb.poolValue(depositor.address);
        ctx.check(value2 === value1, 'S6.4 a provisional forward in the deposit\'s own epoch does not raise its value (D16)', { before: value1, after: value2 });
      }
    } else {
      out('S8.1/2 driven and S6.4: value arriving at the delegation is a validator\'s on a live chain (the harness credits it); the I32 probe below reads every forward instead');
      const pe = await lb.big('D', 'provisionalEpoch');
      if (pe === (await lb.epoch())) {
        const left = cap - (await lb.big('D', 'provisionalPaid'));
        const got = await lb.outcome(async () => {
          const res = await lb.call('D', 'distributeProvisional', []);
          if (BigInt(res[0]) > left) throw new Error(`forwards ${res[0]} > ${left}`);
        });
        ctx.check(got === null || got.includes('NothingToDistribute'), 'S8.2 another forward in the epoch forwards at most cap − provisionalPaid (I32)', { left, got });
      }
      const s1 = await lb.solvency();
      ctx.check(s1.ok, 'S8.3 the delegation is solvent: balance ≥ idle + bonds + refunds + reconciled-unpaid', s1);
    }
    {
      const forwards = await lb.events('D', 'ProvisionallyDistributed');
      const byEpoch = new Map();
      for (const x of forwards) {
        const k = String(x.args.epoch);
        const c = byEpoch.get(k) || { sum: 0n, cap: 0n };
        c.sum += BigInt(x.args.amount);
        if (BigInt(x.args.cap) > c.cap) c.cap = BigInt(x.args.cap);
        byEpoch.set(k, c);
      }
      const over = [...byEpoch.entries()].filter(([, c]) => c.sum > c.cap);
      ctx.check(over.length === 0, 'I32 probe: in every epoch the provisional forwards sum to at most that epoch\'s cap', { epochs: byEpoch.size, over: over.map(([e, c]) => ({ epoch: e, ...c })) });
    }
    await ctx.invariants('S6 S7 S8');

    // S6.3: the next boundary converts the batch, whoever touches the pool first.
    await lb.untilEpoch('the boundary after the deposit', e6 + 1n);
    const converted = (await lb.events('P', 'DepositsConverted', rd.blockNumber)).find((x) => BigInt(x.args.epoch) === e6);
    if (!converted) await lb.send('P', 'roll', [], { as: depositor });
    const conv = converted || (await lb.events('P', 'DepositsConverted', rd.blockNumber)).find((x) => BigInt(x.args.epoch) === e6);
    await lb.send('P', 'roll', [], { as: depositor });
    const shares2 = await lb.big('P', 'sharesOf', [depositor.address]);
    ctx.check(conv && BigInt(conv.args.deposits) >= v && BigInt(conv.args.shares) > 0n && shares2 > shares0, 'S6.3 at the next boundary the epoch\'s deposits convert (DepositsConverted) and roll() gives the depositor its shares (D16)', { converted: conv && conv.args, shares: shares2 });

    /* ================================================== S9 the reconciliation report */
    {
      const noted = await lb.events('D', 'RootNoted');
      const reconciled = await lb.events('D', 'Reconciled');
      ctx.knownIssue('OC-LEGB-06', noted.length > 0 || (await lb.events('D', 'Delegated')).length === 0, 'S9 a deployment with validators has reconciliation reports sealed and noted (I32, I21)', { rootsNoted: noted.length, reconciled: reconciled.length, validators: (await lb.events('D', 'Delegated')).length });
    }
    let distributedTo = null;
    if (lb.harness) {
      if ((await lb.epoch()) === e7) await lb.untilEpoch('an epoch whose report slot the deposit check did not take', e7 + 1n);
      const e9 = await lb.epoch();
      // Larger than the cap times the epochs the window spans: the relayer
      // forwards up to the cap of it provisionally every epoch meanwhile.
      const w2 = 1000n * ONE;
      const fees = 2n * ONE;
      await lb.credit(q.ArkBondDelegation, w2 + fees);
      ctx.note(`stand-in: ${w2 / ONE} QRL of partial withdrawals and ${fees / ONE} QRL of fees reach the delegation (harness credit)`);
      // Every reward credited so far, as the beacon chain would report it cumulatively.
      const withdrawn = 2n * cap + ONE + w2;
      const line = await lb.reportOf(e9, pkh, STATUS.active, withdrawn);
      const rep = await lb.sealReport(e9, [line], fees);
      const [rn] = lb.decode('D', rep.noted.logs, 'RootNoted');
      ctx.check(rn && BigInt(rn.args.epoch) === e9 && lower(rn.args.root) === lower(rep.root), 'S9.1 a report root sealed at reportKey(e) is noted: RootNoted(e, root)', { epoch: e9, root: rep.root });
      await ctx.refuses('S9.2 a report applied inside its challenge window', 'ReportNotCleared', () => lb.call('D', 'reconcile', [line, rep.proof(rep.leaves[0])]));
      await lb.untilCleared(e9);
      // Back to back: the relayer distributes on every tick.
      const r1 = await lb.send('D', 'reconcile', [line, rep.proof(rep.leaves[0])]);
      const [rc] = lb.decode('D', r1.logs, 'Reconciled');
      ctx.check(rc && lower(rc.args.pubkeyHash) === lower(pkh) && BigInt(rc.args.reportEpoch) === e9 && Number(rc.args.status) === STATUS.active && BigInt(rc.args.distribution) === withdrawn && BigInt(rc.args.principalReturned) === 0n, 'S9.3 past the window the report applies: Reconciled, an active validator\'s withdrawals all distribution', { event: rc && rc.args });
      const r2 = await lb.send('D', 'reconcileFees', [e9, fees, rep.proof(rep.feesLeaf)]);
      const [fr] = lb.decode('D', r2.logs, 'FeesReconciled');
      ctx.check(fr && BigInt(fr.args.fees) === fees, 'S9.4 the fees line of the same root applies: FeesReconciled', { event: fr && fr.args });
      const sv = await lb.solvency();
      const room = sv.balance > sv.idle + sv.bondsHeld + sv.refundsOwed ? sv.balance - (sv.idle + sv.bondsHeld + sv.refundsOwed) : 0n;
      const due = sv.distributionReconciled - sv.distributed;
      const expect = due < room ? due : room;
      const r3 = await lb.send('D', 'distribute', []);
      const [ds] = lb.decode('D', r3.logs, 'Distributed');
      ctx.check(ds && same(ds.args.to, q.ArkStakingPool) && BigInt(ds.args.amount) === expect && expect > 0n, 'S9.5 distribute pays the pool what reports cleared and provisional forwards did not, within the balance above what ranks ahead', { amount: ds && ds.args.amount, expected: expect, ...sv });
      ctx.check((await lb.solvency()).ok, 'S9.5 the delegation is solvent after the distribution', await lb.solvency());
      distributedTo = r3.blockNumber;
    } else {
      out('S9.1–9.5 driven: a report on a live chain is the attester quorum\'s statement of beacon-chain facts; no live component seals one (OC-LEGB-06, recorded above)');
    }

    /* ================================================== S10 the harvest */
    {
      const placed = async () => BigInt((await ctx.qrl.call(q.ArkCatBond, lb.abi('B'), 'placedWithStaking'))[0]);
      const pBefore = await placed();
      const can = await lb.outcome(() => lb.call('S', 'harvest', []));
      if (can === null) {
        const backing = (await lb.poolValue(q.ArkBondStaking)) + (await lb.big('S', 'principalInFlight'));
        const rh = await lb.send('S', 'harvest', []);
        const [rq] = lb.decode('S', rh.logs, 'Requested');
        ctx.check(rq && Number(rq.args.kind) === KIND.distribution && BigInt(rq.args.amount) === backing - pBefore, 'S10.1 harvest asks the pool for the gain above placed principal: Requested(id, 2, gain)', { event: rq && rq.args, backing, placed: pBefore });
        const reqId = BigInt(rq.args.requestId);
        let settled = lb.decode('P', rh.logs, 'WithdrawalSettled').find((x) => BigInt(x.args.requestId) === reqId);
        if (!settled) {
          const rs = await lb.send('P', 'settle', [16n]);
          settled = lb.decode('P', rs.logs, 'WithdrawalSettled').find((x) => BigInt(x.args.requestId) === reqId);
        }
        ctx.check(Boolean(settled) && BigInt(settled.args.amount) > 0n, 'S10.2 the pool settles the request: WithdrawalSettled', { requestId: reqId, amount: settled && settled.args.amount });
        const rcl = await lb.send('S', 'claim', [reqId]);
        const [sd] = lb.decode('S', rcl.logs, 'Distributed');
        const credited = lb.decode('B', rcl.logs, 'DistributionCredited');
        ctx.check(sd && BigInt(sd.args.amount) === BigInt(settled.args.amount) && credited.length === 1, 'S10.3 claim passes it to the bond as the holders\' distribution: Distributed and the bond\'s DistributionCredited (whitepaper §3.4)', { distributed: sd && sd.args.amount, credited: credited.map((x) => x.args.amount) });
        ctx.check((await placed()) === pBefore, 'S10.4 a harvest leaves placed principal unchanged', { before: pBefore, after: await placed() });
      } else {
        ctx.note(`S10: nothing to harvest now (${can})`);
        if (lb.harness) ctx.check(false, 'S10 the distribution of S9 left the bond a gain to harvest', { refused: can, distributedAt: distributedTo });
        out('S10 driven: no gain above placed principal at the time of the run (the relayer harvests on every tick)');
      }
    }
    await ctx.invariants('S9 S10');

    /* ================================================== S3.3 the release settles */
    await ctx.waitFor('the release paid on the origin chain and its settlement recorded on QRL', async () => Number((await lb.view('R', 'anchorOf', [anchored.id])).status) === 3, { timeoutEpochs: 12 });
    const settledEv = (await lb.events('R', 'ReleaseSettled', instr.blockNumber)).find((x) => lower(x.args.stakeAssetId) === id);
    ctx.check(settledEv && BigInt(settledEv.args.notional) === n && BigInt(await ctx.registry('totalInTransit')) === relTransit0, 'S3.3 recordReleaseSettled closes the transit record: status 3, ReleaseSettled, transit lowered by the notional (I18)', { event: settledEv && settledEv.args, totalInTransit: await ctx.registry('totalInTransit') });
    await ctx.refuses('S3.4 an instruction for a settled position', 'WrongStatus', () => lb.call('R', 'instructRelease', [anchored.id, rArg]));

    /* ================================================== probes */
    const led = await lb.ledger();
    ctx.check(led.ok, 'D ledger: Σ(stake − returned) over open validators is delegated, their count activeValidators, the exiting part exitsPending', led);
    const sv = await lb.solvency();
    ctx.check(sv.ok, 'venue solvency at the end of the run', sv);
    ctx.note(`S1–S10 done; ${ctx.checks} rules asserted over epochs ${startEpoch}..${await lb.epoch()} (${(await lb.epoch()) - startEpoch + 1n} epochs)`);
  },
};
