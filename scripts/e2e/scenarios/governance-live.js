/**
 * How Ark Staking is governed, on chain: the OC round's governance rows
 * (docs/review/audit-2026-10-03/GOV/REPORT.md, "On-chain scenarios needed"
 * A, B, C, D, E, G and the G-probes; F is governance-qday.js).
 *
 * NOT TERMINAL. Nothing here declares Q-Day or moves a value-transfer key:
 * every S1 operation it queues is cancelled, the Q-Day advisories lapse or are
 * rejected, and the one parameter it changes through a vote is a 7-day key
 * (`exitDeadlineEpochs`, by one).
 *
 *   A  the S1 handover, k of n. Since the fixes of OC-GOV-03/04/05 the leg is
 *      deployed under the timelock with nothing pending (checked at start), and
 *      the proposer multisig (2 of 3 on the harness) wires the stack as an
 *      operator does (scheduleAcceptances / approveAcceptances): the timelock's
 *      objection source and governor at once, the governor's objection source
 *      and court as 30-day operations whose op ids the tooling keeps.
 *   C  Leg B's S1 objection to a value-transfer op (OpContested, second delay).
 *   D  the guardian cancels Queued ops; it schedules nothing.
 *   E  the refusals, each by name, with the fixes of OC-GOV-01
 *      (proposeGovernance, setCourt and the governor's setObjectionSource are
 *      objectable at S1), OC-GOV-02 (`StagePending`), OC-GOV-06
 *      (`NotTimelockProposer`) and GV-03 (`GuardianCannotCancel`).
 *   G  Q-Day, the two non-terminal paths: an advisory that lapses, and a
 *      certification veARK rejects.
 *   B  S2: setObjectionSource, setCourt and handOver run their 30 days; a
 *      veARK round votes a 7-day key into force and a 30-day key that Leg B
 *      contests (C at S2) and the round re-votes at 15% / 75%.
 *
 * Wall-clock (clock-derived waits only). S1 and Q-Day (A, C, D, E, G): rapid
 * (7-min epochs, day 60 s) about 6-15 min; testnet (70-min epochs, day 600 s)
 * about 1-2 h. With S2 (B, after the 30-day operations): rapid about 1 h,
 * testnet about 9.5-10.5 h; start after the 02:00 reset. The harness runs it
 * all in under a minute. At rapid, G's certification must land four certify
 * transactions inside a 60 s window (OC-GOV-08): a miss is recorded against
 * that finding and the advisory lapsed, not failed; prefer testnet for G.
 *
 * LIVE. The client signs only from its own key, so every multisig, guardian
 * and attester step runs only where the deployment names keys this run holds:
 * the deployer, or the e2e actors labelled below (their addresses are printed;
 * name them in GOV_PROPOSER_OWNERS / GOV_GUARDIAN_OWNERS / QDAY_ATTESTERS to
 * run those rows). A row without its keys is skipped with the reason in the
 * report. B hands the timelock to the governor for good (for the rest of that
 * day's deployment), so on a live chain it runs only with ARK_E2E_GOV_S2=1.
 */
const fs = require('fs');
const path = require('path');
const { ONE, harnessActorAddress } = require('../lib');
const { iface, qrlBuild, ROOT } = require('../../lib/chains');
const { scheduleAcceptances, approveAcceptances, acceptanceStatus, wireObjectionSource } = require('../../lib/governance');
const H = require('../helpers/governance');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

const PROPOSERS = ['gov-proposer-0', 'gov-proposer-1', 'gov-proposer-2'];
const GUARDIANS = ['gov-guardian-0'];
const ATTESTERS = ['gov-attester-0', 'gov-attester-1', 'gov-attester-2', 'gov-attester-3', 'gov-attester-4'];
const ATTESTER_BOND = 10n * ONE;
const GAS_FLOAT = 100n * ONE;
const LOCK = 100_000n * ONE;
const BPS = 10_000n;

module.exports = {
  description: 'governance on chain: the S1 handover k of n with its wiring, Leg B objection, guardian cancels, the named refusals, the Q-Day lapse and rejection, and S2 — a veARK round voting a key into force and a contested re-vote',
  terminal: false,
  // Read by scripts/e2e-local.js: core's stack with a 2-of-3 proposer
  // multisig, a guardian and five attesters, all e2e actors.
  governance: {
    proposerOwners: PROPOSERS.map(harnessActorAddress),
    proposerThreshold: 2,
    guardianOwners: GUARDIANS.map(harnessActorAddress),
    guardianThreshold: 1,
    attesters: ATTESTERS.map(harnessActorAddress),
    attesterBond: ATTESTER_BOND,
  },
  outOfScope: [
    'F, the ratified declaration: governance-qday.js (terminal)',
    'OC-GOV-03 beyond its check at start (governance() == timelock, nothing pending, GovernanceAccepted for the registry): the deployer-window PoC is the GOV PoC, closed by the fix',
    'OC-GOV-05 finalize pre-empting a live court vote, and G13 as a whole: needs an escalated court case (court stream)',
    'OC-GOV-07 (two Succeeded proposals on one key, first queue wins): documented at ArkGovernor.queue, not driven',
    'G1 at execute for a value-transfer key: every value-transfer op here is contested or cancelled, none executes',
    'the late-window extension (VotingExtended): no vote here flips the outcome in the last 24 profile-hours',
    'live: multisig, guardian and attester rows need the keys the deployment names (e2e actors gov-proposer-*, gov-guardian-*, gov-attester-*, or the deployer); without them the row is skipped and the reason recorded',
    'live: B (S2) only with ARK_E2E_GOV_S2=1, because the handover to the governor is one-way for the rest of that deployment',
  ],

  async run(ctx) {
    const h = H.stack(ctx);
    ctx.check(h && ctx.r.deployment.qday && ctx.r.deployment.qday.kind === 'real', 'the leg is wired to contracts/core\'s governance stack, live on this chain', { governance: ctx.r.deployment.governance && ctx.r.deployment.governance.record });
    const { G } = h;
    const q = ctx.r.q;
    const live = ctx.qrl.kind === 'qrl';
    const runS2 = !live || process.env.ARK_E2E_GOV_S2 === '1';
    const record = JSON.parse(fs.readFileSync(path.join(ROOT, h.record.record), 'utf8'));
    const deployedFrom = BigInt(ctx.r.deployment.deployedFromBlock || 0);
    const scanFrom = (await ctx.qrl.head()).latest;
    const E = BigInt(ctx.clock.EPOCH_LENGTH);
    const day = BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'GRACE_PERIOD')) / 14n;
    const D30 = 30n * day;
    const me = ctx.qrl.address;
    const stranger = (await ctx.actor('gov-stranger')).address;
    const call = (to, n, m, args = [], from = undefined) => ctx.qrl.call(to, h.abi(n), m, args, from ? { from } : {});
    const params = q.ArkStakeParams;
    const P_ = (fn, args) => h.encode('ArkStakeParams', fn, args);
    const diff = (key, expected, value) => P_('setParamsDiff', [[[H.K(key), expected, value]]]);
    const paramsNow = () => h.call(params, 'ArkStakeParams', 'params');
    const opState = async (op) => Number(await h.call(G.ArkTimelock, 'ArkTimelock', 'stateOf', [op]));
    const propState = async (id) => Number(await h.call(G.ArkGovernor, 'ArkGovernor', 'state', [id]));
    const skip = (row, why) => ctx.note(`SKIPPED ${row}: ${why}`);
    /** The revert name of an eth_call, or null where it succeeds. */
    const outcome = async (fn) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return require('../../../ecdsa-stakings/relayer/engine/errors').revertName(ctx.r.errors, e);
      }
    };
    ctx.note(`profile day ${day} s, epoch ${E} s; 30 days = ${D30} s`);

    /* -------------------------------------------------------- the keys held */
    const msOf = async (address, labels) => {
      const owners = (await h.call(address, 'ArkMultisig', 'owners')).map(toHex);
      const k = BigInt(await h.call(address, 'ArkMultisig', 'threshold'));
      const signers = await H.signersFor(ctx, owners, labels, GAS_FLOAT);
      return { m: H.multisig(h, address, signers, k), owners, k };
    };
    const { m: P, owners: pOwners, k: pK } = await msOf(G.ProposerMultisig, PROPOSERS);
    const { m: GD, owners: gOwners, k: gK } = await msOf(G.GuardianMultisig, GUARDIANS);
    ctx.note(`proposer multisig ${pK} of ${pOwners.length}, keys held ${P.signers.length} (${P.signers.map((s) => s.label).join(', ') || 'none'}); guardian ${gK} of ${gOwners.length}, keys held ${GD.signers.length}`);
    if (live) {
      for (const l of [...PROPOSERS, ...GUARDIANS, ...ATTESTERS]) ctx.note(`e2e actor ${l}: ${(await ctx.actor(l)).address}`);
    }

    /* ------------------------------------------------ before anything moves */
    const st0 = await acceptanceStatus({ client: ctx.qrl, leg: q });
    const timelockGoverns = (st) => Object.values(st).every((x) => H.same(x.governance, G.ArkTimelock) && H.isZero(x.pending));
    ctx.check(timelockGoverns(st0), 'ArkTimelock is the governance of ArkStakeParams, ArkStakeRegistry and ArkBondDelegation from the deploying run, nothing pending: no deployer window (G2, OC-GOV-03)', { at: 'start of the run', ...st0 });
    {
      const accepted = await h.since(G.ArkTimelock, 'ArkTimelock', 'GovernanceAccepted', deployedFrom);
      ctx.check(accepted.length === 1 && H.same(accepted[0].args.target, q.ArkStakeRegistry), 'the registry, governed by the deployer only for its admissions, was accepted by the timelock in the same run (acceptGovernanceOf, OC-GOV-03)', { accepted: accepted.map((e) => e.args.target) });
    }
    const court = q.ArkStakeCourt || null;
    if (court) {
      const named = await h.call(G.ArkGovernor, 'ArkGovernor', 'court');
      ctx.note(`ArkGovernor.court() at start: ${named} (set by the wiring's 30-day setCourt operation, OC-GOV-05)`);
    }
    let handedOver = await h.call(G.ArkTimelock, 'ArkTimelock', 'handedOver');
    const proposer0 = await h.call(G.ArkTimelock, 'ArkTimelock', 'proposer');
    ctx.check(handedOver ? H.same(proposer0, G.ArkGovernor) : H.same(proposer0, G.ProposerMultisig), 'the timelock\'s proposer is the S1 multisig until the one-way handover, ArkGovernor after it (G15)', { proposer: proposer0, handedOver });

    // G11: the protocol-owned accounts can never lock.
    for (const a of (record.parameters && record.parameters.protocolOwned) || []) {
      const owned = await h.call(G.VeArk, 'VeArk', 'isProtocolOwned', [toHex(a)]);
      const lock = await h.call(G.VeArk, 'VeArk', 'lockOf', [toHex(a)]);
      ctx.check(owned && BigInt(lock.amount) === 0n, 'every protocol-owned account is marked so in veARK and holds no lock (G11)', { account: toHex(a), owned, amount: lock.amount });
    }
    await ctx.refuses('a protocol-owned account (the timelock) cannot lock ARK (G11)', 'ProtocolOwned', async () => call(G.VeArk, 'VeArk', 'createLock', [ONE, (await h.now()) + 2n * E], G.ArkTimelock));
    const deployerLock = await h.call(G.VeArk, 'VeArk', 'lockOf', [me]);
    ctx.note(`GV-09: the deployer's veARK lock at start ${deployerLock.amount} (governance-qday relies on it deciding votes)`);

    // G12: no row for the §6.4 constants, no default row.
    for (const name of ['epochDays', 'unbondingDays', 'censorshipWindowEpochs']) {
      await ctx.refuses(`the §6.4 constant ${name} has no key: no delay exists for it (G12)`, 'UnknownKey', () => call(G.ArkTimelock, 'ArkTimelock', 'delayFor', [diff(name, 0n, 1n)]));
    }
    await ctx.refuses('the timelock has no default row: a selector outside its table has no delay (G12)', 'UnknownSelector', () => call(G.ArkTimelock, 'ArkTimelock', 'delayFor', [h.encode('ArkToken', 'approve', [stranger, 1n])]));

    // The deployer's lock: the vote source for G and B.
    const ark = G.ArkToken;
    let canVote = true;
    {
      const want = (await h.now()) + 40n * E;
      const lock = await h.call(G.VeArk, 'VeArk', 'lockOf', [me]);
      if (BigInt(lock.amount) === 0n) {
        if (BigInt(await h.call(ark, 'ArkToken', 'balanceOf', [me])) < LOCK + LOCK / 50n) {
          canVote = false;
          skip('the veARK votes of G and B', 'the deployer holds too little liquid ARK to lock');
        } else {
          await h.send(ark, 'ArkToken', 'approve', [G.VeArk, LOCK]);
          await h.send(G.VeArk, 'VeArk', 'createLock', [LOCK, want]);
        }
      } else if (BigInt(lock.end) < want - 10n * E) {
        await h.send(G.VeArk, 'VeArk', 'extendLock', [want]);
      }
    }

    /* ------------------------------------------- A: the S1 handover, k of n */
    const scheduledMap = async (from) => new Map((await h.since(G.ArkTimelock, 'ArkTimelock', 'Scheduled', from)).map((e) => [String(e.args.opId).toLowerCase(), e]));
    /** G2 on an op: eta − block time == delay == delayFor(payload). */
    const g2 = async (opId, label, expectDelay) => {
      const ev = (await scheduledMap(deployedFrom)).get(String(opId).toLowerCase());
      const op = await h.call(G.ArkTimelock, 'ArkTimelock', 'opOf', [opId]);
      const table = BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'delayFor', [op[3]]));
      const ts = await ctx.qrl.timestampOf(ev.blockNumber);
      const delay = BigInt(ev.args.delay);
      ctx.check(BigInt(ev.args.eta) - ts === delay && delay === table && delay === expectDelay, `${label}: eta − schedule time == delay == the table's delay for the payload (G2)`, { eta: ev.args.eta, scheduledAt: ts, delay, table, expect: expectDelay });
      return { eta: BigInt(ev.args.eta), delay, payload: op[3] };
    };
    const wiring = async () => ({
      timelockObjectionSource: toHex(await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionSource')),
      timelockGovernor: toHex(await h.call(G.ArkTimelock, 'ArkTimelock', 'governor')),
    });
    const wired = (w) => H.same(w.timelockObjectionSource, q.ArkCatBond) && H.same(w.timelockGovernor, G.ArkGovernor);
    const unexecutedSince = async (from) => {
      const to = BigInt(await h.call(G.ProposerMultisig, 'ArkMultisig', 'txCount'));
      const out = [];
      for (let id = from; id < to; id++) if (!(await h.call(G.ProposerMultisig, 'ArkMultisig', 'txOf', [id]))[3]) out.push(id);
      return { submitted: to - from, unexecuted: out };
    };
    const s1 = !handedOver && P.able;

    // A: since OC-GOV-03 the leg is deployed under the timelock, so nothing is
    // left to accept; what the S1 proposer multisig owes, k of n, through the
    // operator's tooling, is the wiring (OC-GOV-04) and the court (OC-GOV-05).
    if (!P.able) {
      skip('A (the wiring)', `this run holds ${P.signers.length} of the ${pK} proposer keys it needs`);
    } else if (handedOver || (wired(await wiring()) && !H.isZero(await h.call(G.ArkGovernor, 'ArkGovernor', 'objectionSource')))) {
      ctx.note('A: the stack is already wired on this deployment; the wiring is not repeated');
    } else {
      const lead = P.signers[0];
      await ctx.refuses('an account that is no owner submits nothing to the proposer multisig', 'NotOwner', () => call(G.ProposerMultisig, 'ArkMultisig', 'submit', [G.ArkTimelock, 0n, '0x00'], stranger));
      const before = BigInt(await h.call(G.ProposerMultisig, 'ArkMultisig', 'txCount'));
      const ops = await scheduleAcceptances({ client: lead.client, build: h.build, governance: G, leg: q, log: () => {} });
      if (pK > 1n) {
        const waiting = ops.find((o) => !o.executed);
        await ctx.refuses(`the proposer multisig executes nothing below its threshold (${pK} of ${pOwners.length})`, 'BelowThreshold', () => call(G.ProposerMultisig, 'ArkMultisig', 'execute', [waiting.multisigTx], lead.owner));
        for (const s of P.signers.slice(1, Number(pK))) await approveAcceptances({ client: s.client, build: h.build, governance: G, ops, log: () => {} });
      }
      ctx.check(!ops.some((o) => o.kind === 'accept'), 'nothing is left to accept: the leg was deployed under the timelock (OC-GOV-03)', { ops: ops.map((o) => o.name) });
      const left = await unexecutedSince(before);
      const w = await wiring();
      const timed = ops.filter((o) => o.kind === 'schedule');
      ctx.check(
        wired(w) && left.unexecuted.length === 0 && timed.length === (court ? 2 : 1) && timed.every((o) => o.opId && o.eta),
        `${pK} of ${pOwners.length} proposer owners complete the wiring with the operator tooling (scheduleAcceptances, approveAcceptances): the timelock's objection source is the bond, its governor is ArkGovernor, no multisig transaction it submitted is left unexecuted, and the governor's 30-day operations are kept by op id (OC-GOV-04, OC-GOV-05, D6, GV-14)`,
        { threshold: pK, ...left, ...w, kept: timed.map((o) => ({ name: o.name, opId: o.opId, eta: o.eta })) },
      );
      for (const o of timed) await g2(o.opId, o.name, D30);
      await ctx.refuses('the governor\'s wiring operations wait their 30 profile-days (A2)', 'NotReady', () => call(G.ArkTimelock, 'ArkTimelock', 'execute', [timed[0].opId]));
      const count = BigInt(await h.call(G.ProposerMultisig, 'ArkMultisig', 'txCount'));
      const again = await scheduleAcceptances({ client: lead.client, build: h.build, governance: G, leg: q, existing: ops, log: () => {} });
      const after = BigInt(await h.call(G.ProposerMultisig, 'ArkMultisig', 'txCount'));
      ctx.check(after === count && again.every((o) => ops.includes(o)), 'a second run of the tooling with its kept entries submits nothing that still stands (SWAPGOV-12)', { submitted: after - count });
    }
    if (!wired(await wiring()) && s1) {
      // A handover made elsewhere without the wiring.
      const before = BigInt(await h.call(G.ProposerMultisig, 'ArkMultisig', 'txCount'));
      await wireObjectionSource({ client: P.signers[0].client, abi: h.abi, governance: G, leg: q, threshold: pK, opts: {}, log: () => {} });
      for (const id of (await unexecutedSince(before)).unexecuted) await P.complete(id);
    }
    {
      const w = await wiring();
      ctx.check(wired(w), 'the timelock\'s objection source is ArkCatBond and its governor is ArkGovernor (A4; D6 from S1; OC-GOV-04)', { after: 'the wiring', ...w });
    }
    if (timelockGoverns(await acceptanceStatus({ client: ctx.qrl, leg: q }))) {
      await ctx.refuses('once the timelock governs, the deployer cannot write a parameter (OC-GOV-03 window closed)', 'OnlyGovernance', async () => call(params, 'ArkStakeParams', 'setParamsDiff', [[[H.K('exitDeadlineEpochs'), BigInt((await paramsNow()).exitDeadlineEpochs), BigInt((await paramsNow()).exitDeadlineEpochs)]]]));
    }
    await ctx.invariants('after the handover');

    /* ----------------- the S2 operations, scheduled first: they take 30 days */
    const s2ops = {};
    const findGovOp = async (sig) => {
      const want = H.selectorOf(sig);
      for (const [opId, ev] of await scheduledMap(deployedFrom)) {
        if (!H.same(ev.args.target, G.ArkGovernor) || (await opState(opId)) !== H.OP.Queued) continue;
        const op = await h.call(G.ArkTimelock, 'ArkTimelock', 'opOf', [opId]);
        if (String(op[3]).slice(0, 10).toLowerCase() === want) return { opId, eta: BigInt(ev.args.eta) };
      }
      return null;
    };
    if (s1) {
      if (H.isZero(await h.call(G.ArkGovernor, 'ArkGovernor', 'objectionSource'))) {
        s2ops.source = await findGovOp('setObjectionSource(address)');
        if (s2ops.source) {
          const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [s2ops.source.opId]);
          ctx.check(objectable, 'at S1 the governor\'s setObjectionSource operation is objectable by Leg B: a false value would kill the S2 chamber for good (G15, D6, OC-GOV-01)', { opId: s2ops.source.opId, objectable });
        }
      }
      if (court && H.isZero(await h.call(G.ArkGovernor, 'ArkGovernor', 'court'))) {
        // Scheduled by the wiring (OC-GOV-05); by hand only where it was not.
        s2ops.court = await findGovOp('setCourt(address)');
        if (!s2ops.court) {
          s2ops.court = await P.schedule(G.ArkGovernor, h.encode('ArkGovernor', 'setCourt', [court]));
          await g2(s2ops.court.opId, 'ArkGovernor.setCourt(ArkStakeCourt)', D30);
        }
        const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [s2ops.court.opId]);
        ctx.check(objectable, 'at S1 ArkGovernor.setCourt is objectable by Leg B (set once: a false court would be for good; OC-GOV-01)', { opId: s2ops.court.opId, objectable });
      }
      if (runS2) {
        const op = await P.schedule(G.ArkTimelock, h.encode('ArkTimelock', 'handOver', [G.ArkGovernor]));
        s2ops.handOver = op;
        await g2(op.opId, 'handOver(ArkGovernor)', D30);
        const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [op.opId]);
        ctx.check(objectable, 'handOver is a 30-day self-operation Leg B can object to at S1 (SWAPGOV-03)', { opId: op.opId });
        await ctx.refuses('the guardian cannot cancel an uncontested handover: it is the proposer\'s to withdraw (GV-03)', 'GuardianCannotCancel', () => call(G.ArkTimelock, 'ArkTimelock', 'cancel', [op.opId], G.GuardianMultisig));
      }
    }

    /* ------------------------------------------------ E: refusals at S1 */
    if (s1) {
      const MS = G.ProposerMultisig;
      const cur = await paramsNow();
      const cc = BigInt(cur.claimCostGwei);
      const [ccDelay, ccStep] = (await h.call(G.ArkTimelock, 'ArkTimelock', 'keyRule', [H.K('claimCostGwei')])).map(BigInt);
      const ccTo = cc + ccStep <= 10_000_000n ? cc + ccStep : cc - ccStep;
      const sched = (target, payload, from = MS) => call(G.ArkTimelock, 'ArkTimelock', 'schedule', [target, payload], from);
      await ctx.refuses('an account that is not the proposer schedules nothing', 'NotProposer', () => sched(params, diff('claimCostGwei', cc, ccTo), me));
      await ctx.refuses('the guardian schedules nothing: it can only cancel (G14)', 'NotProposer', () => sched(params, diff('claimCostGwei', cc, ccTo), G.GuardianMultisig));
      await ctx.refuses('a selector outside the timelock\'s table cannot be scheduled', 'UnknownSelector', () => sched(params, h.encode('ArkToken', 'transfer', [stranger, 1n])));
      await ctx.refuses('a key outside the table cannot be scheduled', 'UnknownKey', () => sched(params, diff('epochDays', 7n, 8n)));
      await ctx.refuses('a value-transfer key moves at most its step per operation (D7)', 'StepTooLarge', () => sched(params, diff('claimCostGwei', cc, cc + ccStep + 1n <= 10_000_000n ? cc + ccStep + 1n : cc - ccStep - 1n)));
      await ctx.refuses('handOver is not callable directly, only as the timelock\'s own operation (SWAPGOV-03)', 'NotProposer', () => call(G.ArkTimelock, 'ArkTimelock', 'handOver', [G.ArkGovernor], MS));
      await ctx.refuses('handOver names only the governor set once (SWAPGOV-03)', 'NotGovernor', () => call(G.ArkTimelock, 'ArkTimelock', 'handOver', [stranger], G.ArkTimelock));
      await ctx.refuses('the timelock\'s governor is set once', 'AlreadySet', () => call(G.ArkTimelock, 'ArkTimelock', 'setGovernor', [stranger], MS));

      /* -------------------------------------------- C at S1: Leg B objects */
      const bondAbi = iface('ArkCatBond', qrlBuild(ctx.r.manifest.profile));
      const principalAt = async (who, e) => BigInt((await ctx.qrl.call(q.ArkCatBond, bondAbi, 'principalAt', [who, e]))[0]);
      const totalAt = async (e) => BigInt((await ctx.qrl.call(q.ArkCatBond, bondAbi, 'totalPrincipalAt', [e]))[0]);
      if ((await principalAt(me, await h.epoch())) === 0n) {
        await h.untilEpoch('a boundary after the bond subscription, so its principal counts', (await h.epoch()) + 1n);
      }
      const op = await P.schedule(params, diff('claimCostGwei', cc, ccTo));
      ctx.check(op.delay === ccDelay && ccDelay === D30 && (ccTo > cc ? ccTo - cc : cc - ccTo) <= ccStep, 'a value-transfer key waits 30 days and moves at most its step from the value it replaces (G1, D7)', { delay: op.delay, step: ccStep, from: cc, to: ccTo });
      await g2(op.opId, 'setParamsDiff(claimCostGwei)', D30);
      const [objectable, , queueEpoch] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [op.opId]);
      ctx.check(objectable && BigInt(queueEpoch) === ctx.clock.epochOf(await ctx.qrl.timestampOf(op.blockNumber)), 'a value-transfer operation scheduled at S1 is objectable, against principal at its queue epoch (D6, EC-06)', { objectable, queueEpoch });
      await ctx.refuses('one queued operation per parameter key (SWAPGOV-04)', 'KeyPending', () => sched(params, diff('claimCostGwei', cc, cc)));
      const mine = await principalAt(me, BigInt(queueEpoch));
      const total = await totalAt(BigInt(queueEpoch));
      const threshold = BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'OBJECTION_THRESHOLD_BPS'));
      if (mine === 0n || mine * BPS < threshold * total) {
        skip('C at S1 (the contest)', `the deployer holds ${mine} of ${total} principal at the queue epoch, under the ${threshold} bps threshold`);
      } else {
        const r = await h.send(G.ArkTimelock, 'ArkTimelock', 'object', [op.opId]);
        const [ev] = h.decode(r.logs, G.ArkTimelock, 'ArkTimelock', 'OpContested');
        const ts = await ctx.qrl.timestampOf(r.blockNumber);
        const [, contested] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [op.opId]);
        ctx.check(ev && contested && BigInt(ev.args.eta) === ts + op.delay && BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'etaOf', [op.opId])) === ts + op.delay, 'Leg B holding at least 20% of principal contests an S1 operation: it waits a second delay from the objection (YP §4.5, contested row)', { principal: mine, total, eta: ev && ev.args.eta, objectedAt: ts });
        await ctx.refuses('a contested operation takes no further objection', 'OpNotObjectable', () => call(G.ArkTimelock, 'ArkTimelock', 'object', [op.opId]));
      }

      /* -------------------------------------------- D: the guardian cancels */
      if (!GD.able) {
        skip('D (guardian cancels)', `this run holds ${GD.signers.length} of the ${gK} guardian keys`);
        await P.cancel(op.opId);
      } else {
        const ev = await GD.cancel(op.opId);
        ctx.check(ev && H.same(ev.by, G.GuardianMultisig) && (await opState(op.opId)) === H.OP.Cancelled, 'the guardian may cancel a contested S1 operation (D, G14)', { by: ev && ev.by });
      }
      await ctx.refuses('only a Queued operation can be cancelled (G14)', 'OpNotQueued', () => call(G.ArkTimelock, 'ArkTimelock', 'cancel', [op.opId], G.GuardianMultisig));
      await ctx.refuses('nobody but the proposer or the guardian cancels', 'NotProposerOrGuardian', () => call(G.ArkTimelock, 'ArkTimelock', 'cancel', [op.opId], stranger));

      /* -------------------------------- OC-GOV-01: proposeGovernance at S1 */
      {
        const pg = await P.schedule(params, P_('proposeGovernance', [G.ArkTimelock]));
        await g2(pg.opId, 'proposeGovernance(ArkTimelock)', D30);
        const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [pg.opId]);
        const got = await outcome(() => call(G.ArkTimelock, 'ArkTimelock', 'object', [pg.opId]));
        ctx.check(objectable, 'at S1 proposeGovernance(x) on a governed contract is objectable by Leg B: once executed, x would govern with no timelock (G2, G15, OC-GOV-01)', { opId: pg.opId, objectable, objectByPrincipalHolder: got || 'accepted' });
        const ev = await P.cancel(pg.opId);
        ctx.check(ev && (await opState(pg.opId)) === H.OP.Cancelled, 'the proposer cancels its own Queued operation; this one never executes', { by: ev && ev.by });
      }

      /* ---------------------------------- OC-GOV-02 and D on stage steps */
      {
        const s = Number(await h.call(params, 'ArkStakeParams', 'threatStage'));
        const next = (a) => (a < 4 ? a + 1 : a - 1);
        const first = [s, next(s)];
        const second = [first[1], next(first[1])];
        for (let n = 1; n <= 4; n++) {
          const [d, st] = (await h.call(G.ArkTimelock, 'ArkTimelock', 'keyRule', [H.K(`threatStage${n}Bps`)])).map(BigInt);
          ctx.check(d === D30 && st === 537n, `the ladder rung threatStage${n}Bps waits 30 days and moves at most 537 bps (G9, D5)`, { delay: d, step: st });
        }
        await ctx.refuses('a stage operation moves exactly one step', 'StageStepInvalid', () => sched(params, P_('setThreatStage', [s, s < 3 ? s + 2 : s - 2])));
        const op1 = await P.schedule(params, P_('setThreatStage', first));
        const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [op1.opId]);
        ctx.check(objectable && op1.delay === D30 && (await h.call(G.ArkTimelock, 'ArkTimelock', 'stageStepQueuedFor', [params])), 'a stage step waits 30 days, is objectable at S1, and is public while queued (G9, QL-25)', { opId: op1.opId, delay: op1.delay });
        await ctx.refuses('at most one setThreatStage operation is Queued per target: a second is refused while one waits (G9; "three rounds and three thirty-day delays in sequence"; OC-GOV-02)', 'StagePending', () => sched(params, P_('setThreatStage', second)));
        const queued = [op1];
        await ctx.refuses('the guardian schedules no stage step either (G14)', 'NotProposer', () => sched(params, P_('setThreatStage', first), G.GuardianMultisig));
        for (const [i, op] of queued.entries()) {
          const ev = GD.able ? await GD.cancel(op.opId) : await P.cancel(op.opId);
          const left = await h.call(G.ArkTimelock, 'ArkTimelock', 'stageStepQueuedFor', [params]);
          ctx.check(ev && (await opState(op.opId)) === H.OP.Cancelled && Boolean(left) === i < queued.length - 1, `${GD.able ? 'the guardian' : 'the proposer'} cancels a Queued stage step: Cancelled, and the queue flag drops with the last one (D, G14)`, { by: ev && ev.by, stageStepQueued: left });
        }
      }

      /* ------------------------ the ecosystem phase (item 129, core §3.6) */
      // One ArkPhase per network, governed by the timelock: a phase step is a
      // timelock operation counted once for every reader, so it holds the
      // parameter set's stage queue too. Scheduled and cancelled here, never
      // executed (30 days). A record from before 2026-10-07 names none.
      if (!G.ArkPhase) {
        skip('the ecosystem phase steps', 'this deployment\'s governance record predates ArkPhase');
      } else {
        const Ph = (fn, args) => h.encode('ArkPhase', fn, args);
        const ph = Number(await h.call(G.ArkPhase, 'ArkPhase', 'phase'));
        ctx.check(H.same(await h.call(params, 'ArkStakeParams', 'arkPhase'), G.ArkPhase) && H.same(await h.call(G.ArkPhase, 'ArkPhase', 'governance'), G.ArkTimelock), 'the parameter set reads the network\'s ArkPhase, and the timelock governs it from construction (core §3.6)', { arkPhase: G.ArkPhase, phase: ph });
        await ctx.refuses('the deployer moves no phase: ArkPhase answers to its governance only', 'OnlyGovernance', () => call(G.ArkPhase, 'ArkPhase', 'setPhase', [ph, ph < 2 ? ph + 1 : ph - 1]));
        if (ph > 2) {
          skip('a phase step through the timelock', `phase ${ph} is in force: only restore moves it`);
        } else {
          await ctx.refuses('a phase operation moves one step within 0..2', 'StageStepInvalid', () => sched(G.ArkPhase, Ph('setPhase', ph === 0 ? [0, 2] : ph === 1 ? [1, 3] : [2, 0])));
          const step = [ph, ph < 2 ? ph + 1 : ph - 1];
          const op = await P.schedule(G.ArkPhase, Ph('setPhase', step));
          const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [op.opId]);
          ctx.check(
            objectable && op.delay === D30 && (await h.call(G.ArkTimelock, 'ArkTimelock', 'phaseStepQueued')) && (await h.call(G.ArkTimelock, 'ArkTimelock', 'stageStepQueuedFor', [params])),
            'a phase step waits 30 days, is objectable at S1, and holds every reader\'s stage queue while it waits (core §4.6, 2026-10-07)',
            { opId: op.opId, delay: op.delay, step },
          );
          await ctx.refuses('one queued phase step for the network: a restore is refused while a setPhase waits', 'StagePending', () => sched(G.ArkPhase, Ph('restore', ['0x' + 'ab'.repeat(32)])));
          const ev = GD.able ? await GD.cancel(op.opId) : await P.cancel(op.opId);
          ctx.check(ev && (await opState(op.opId)) === H.OP.Cancelled && !(await h.call(G.ArkTimelock, 'ArkTimelock', 'phaseStepQueued')), `${GD.able ? 'the guardian' : 'the proposer'} cancels the phase step: nothing is left queued for the network`, { by: ev && ev.by });
        }
      }

      /* --------------------------------------------- E: votes and the oracle */
      await ctx.refuses('only ArkGovernor resolves a Q-Day certification', 'OnlyGovernor', () => call(G.ArkQDayOracle, 'ArkQDayOracle', 'resolve', [1n, true]));
      const propose = (kind, payload, from = me) => call(G.ArkGovernor, 'ArkGovernor', 'propose', [kind, [params], [0n], [payload], 'e2e'], from);
      await ctx.refuses('the Q-Day kind is never proposed on the round track', 'WrongTrack', () => propose(H.KIND.StakingQDayRatification, P_('setThreatStage', [1, 2])));
      if (canVote) {
        const st = Number(await h.call(params, 'ArkStakeParams', 'threatStage'));
        const stagePayload = P_('setThreatStage', [st, st < 4 ? st + 1 : st - 1]);
        await ctx.refuses('a round proposal is refused while the timelock\'s proposer is not the governor: at S1 it can never be queued and would only pin voters (GP-16, OC-GOV-06)', 'NotTimelockProposer', () => propose(H.KIND.StakingThreatStage, stagePayload));
      }
    } else if (!handedOver) {
      skip('C, D, E at S1', 'they need the S1 proposer multisig\'s keys');
    }

    /* ----------------------------------------- G: Q-Day, non-terminal paths */
    await qdayPaths(ctx, h, { canVote, call, skip, me });

    /* ------------------------------------------------- B: S2, a veARK round */
    if (!runS2) {
      skip('B (S2)', 'live runs hand the timelock to the governor only with ARK_E2E_GOV_S2=1');
      return;
    }
    if (!handedOver) {
      if (!s2ops.handOver) {
        skip('B (S2)', 'the handover to the governor could not be scheduled (no proposer keys)');
        return;
      }
      const due = [s2ops.source, s2ops.court, s2ops.handOver].filter(Boolean).reduce((m, o) => (o.eta > m ? o.eta : m), 0n);
      await h.until('the 30-day S2 operations (setObjectionSource, setCourt, handOver)', due);
      for (const o of [s2ops.source, s2ops.court, s2ops.handOver].filter(Boolean)) await h.send(G.ArkTimelock, 'ArkTimelock', 'execute', [o.opId]);
      handedOver = await h.call(G.ArkTimelock, 'ArkTimelock', 'handedOver');
    }
    {
      const proposer = await h.call(G.ArkTimelock, 'ArkTimelock', 'proposer');
      const handovers = await h.since(G.ArkTimelock, 'ArkTimelock', 'ProposerHandedOver', deployedFrom);
      ctx.check(handedOver && H.same(proposer, G.ArkGovernor) && H.same(await h.call(G.ArkTimelock, 'ArkTimelock', 'governor'), G.ArkGovernor) && handovers.length === 1, 'the handover ran once, one way: proposer() == governor(), handedOver stays true (G15)', { proposer, handovers: handovers.length });
      const source = await h.call(G.ArkGovernor, 'ArkGovernor', 'objectionSource');
      ctx.check(H.same(source, q.ArkCatBond), 'ArkGovernor\'s objection source is ArkCatBond: the S2 chamber exists (D6, GV-14, OC-GOV-04)', { objectionSource: source });
      if (court) {
        const named = await h.call(G.ArkGovernor, 'ArkGovernor', 'court');
        ctx.check(H.same(named, court), 'ArkGovernor.court() names ArkStakeCourt at S2, from the wiring\'s operation (G13, OC-GOV-05)', { governorCourt: named });
      }
      await ctx.refuses('after the handover the S1 multisig schedules nothing (G15)', 'NotProposer', () => call(G.ArkTimelock, 'ArkTimelock', 'schedule', [params, diff('exitDeadlineEpochs', 0n, 0n)], G.ProposerMultisig));
    }
    await ctx.invariants('at S2');
    if (!canVote) {
      skip('B (the round)', 'no veARK vote source');
      return;
    }
    await roundAtS2(ctx, h, { call, skip, me, GD, D30, E, diff, paramsNow, opState, propState });
  },
};

/** G: an advisory that lapses, then a certification veARK rejects. */
async function qdayPaths(ctx, h, { canVote, call, skip, me }) {
  const { G } = h;
  const oracle = G.ArkQDayOracle;
  const state = async () => Number(await h.call(oracle, 'ArkQDayOracle', 'state'));
  if ((await state()) !== H.QDAY.Normal) {
    skip('G (Q-Day)', `the oracle is in state ${await state()}, not Normal`);
    return;
  }
  const required = BigInt(await h.call(oracle, 'ArkQDayOracle', 'bondRequired'));
  const window = BigInt(await h.call(oracle, 'ArkQDayOracle', 'CERTIFICATION_WINDOW'));
  const panel = (await h.call(oracle, 'ArkQDayOracle', 'attesters')).map(toHex);
  const signers = await H.signersFor(ctx, panel, ATTESTERS, required + GAS_FLOAT);
  if (!signers.length) {
    skip('G (Q-Day)', 'this run holds no attester key of the panel');
    return;
  }
  for (const s of signers) {
    const bond = BigInt(await h.call(oracle, 'ArkQDayOracle', 'bondOf', [s.owner]));
    if (bond < required) await h.send(oracle, 'ArkQDayOracle', 'postBond', [], { as: s.client, value: required - bond });
  }
  const now = () => h.now();
  const free = async () => {
    const t = await now();
    const out = [];
    for (const s of signers) if (BigInt(await h.call(oracle, 'ArkQDayOracle', 'cooldownUntil', [s.owner])) <= t) out.push(s);
    return out;
  };

  // (1) Advisory -> lapse.
  const [raiser] = await free();
  if (!raiser) {
    skip('G (1) the lapse', 'every attester key held is on cooldown');
  } else {
    await ctx.refuses('nothing lapses while the oracle is Normal', 'InvalidPhase', () => call(oracle, 'ArkQDayOracle', 'lapse'));
    await h.send(oracle, 'ArkQDayOracle', 'raiseAdvisory', [H.K('e2e: an artefact that never gathers five')], { as: raiser.client });
    ctx.check((await state()) === H.QDAY.Advisory && (await h.call(oracle, 'ArkQDayOracle', 'frozen')), 'one bonded attester\'s advisory freezes at once (core ArkQDayOracle step 1)');
    const at = BigInt(await h.call(oracle, 'ArkQDayOracle', 'advisoryAt'));
    await ctx.refuses('an advisory does not lapse inside its 24 profile-hours', 'WindowOpen', () => call(oracle, 'ArkQDayOracle', 'lapse'));
    await h.until('the certification window to close', at + window + 1n);
    const round = BigInt(await h.call(oracle, 'ArkQDayOracle', 'round'));
    const r = await h.send(oracle, 'ArkQDayOracle', 'lapse');
    const [ev] = h.decode(r.logs, oracle, 'ArkQDayOracle', 'AdvisoryLapsed');
    ctx.check(ev && BigInt(ev.args.round) === round && (await state()) === H.QDAY.Normal && !(await h.call(oracle, 'ArkQDayOracle', 'frozen')), 'without five certifications in the window anyone lapses the advisory: AdvisoryLapsed, Normal, the freeze lifted (G row 1)', { round });
    await ctx.refuses('the raiser of a lapsed advisory is on cooldown (griefing bound)', 'OnCooldown', () => call(oracle, 'ArkQDayOracle', 'raiseAdvisory', [H.K('e2e: again')], raiser.owner));
  }

  // (2) Certified -> rejected by veARK.
  const ready = await free();
  const quorum = Number(await h.call(oracle, 'ArkQDayOracle', 'QUORUM'));
  if (signers.length < quorum || !ready.length || !canVote) {
    skip('G (2) the rejection', `needs ${quorum} attester keys (held ${signers.length}), one off cooldown, and a veARK vote source`);
    return;
  }
  const raiser2 = ready[0];
  const raised = await h.send(oracle, 'ArkQDayOracle', 'raiseAdvisory', [H.K('e2e: an artefact veARK refuses')], { as: raiser2.client });
  const raisedAt = await ctx.qrl.timestampOf(raised.blockNumber);
  let late = null;
  for (const s of signers.filter((x) => x !== raiser2).slice(0, quorum - 1)) {
    try {
      await h.send(oracle, 'ArkQDayOracle', 'certify', [], { as: s.client });
    } catch (e) {
      late = require('../../../ecdsa-stakings/relayer/engine/errors').revertName(ctx.r.errors, e);
      break;
    }
  }
  const gap = (await h.now()) - raisedAt;
  // OC-GOV-08: at the rapid profile the window is 60 s, about five slots.
  if (ctx.knownIssue('OC-GOV-08', late === null, `the advisory and ${quorum - 1} certify transactions from distinct keys land inside the ${window} s certification window`, { window, gapSeconds: gap, refused: late })) {
    await h.until('the certification window to close', BigInt(await h.call(oracle, 'ArkQDayOracle', 'advisoryAt')) + window + 1n);
    await h.send(oracle, 'ArkQDayOracle', 'lapse');
    skip('G (2) the rejection', `the certification window closed before ${quorum} certifications (${late}); the advisory was lapsed`);
    return;
  }
  ctx.note(`certification reached ${gap} s after the advisory (window ${window} s)`);
  ctx.check((await state()) === H.QDAY.Certified, `${quorum} of the panel certify inside the window: Certified, not declared (G7)`);
  const round = BigInt(await h.call(oracle, 'ArkQDayOracle', 'round'));
  // The vote against is cast first. Under the rule in force since OC-GOV-11
  // (2026-10-09) a ratification nobody votes for is rejected anyway; a stack
  // deployed before it still ratifies an open ratification with no vote
  // against when resolved, and a run cut short here once left a live devnet
  // one `resolve` away from a declared Q-Day (OC-OPS-24, 2026-10-08). On any
  // failure until the vote lands, the vote is still cast before rethrowing.
  let id = null;
  let vr = null;
  let snap = null;
  // G3: power at the snapshot block is readable from the next block on, so a
  // vote estimated while the snapshot block is the head reverts (it did twice
  // on 2026-10-08). Wait for a later block, then retry over a few blocks.
  const voteAgainst = async (pid) => {
    let last = null;
    for (let i = 0; i < 8; i++) {
      if (snap !== null) await ctx.waitFor('a block after the ratification snapshot', async () => (await ctx.qrl.head()).latest > snap, { timeoutEpochs: 1 });
      try {
        return await h.send(G.ArkGovernor, 'ArkGovernor', 'castVote', [pid, 0]);
      } catch (e) {
        last = e;
        const head = (await ctx.qrl.head()).latest;
        await ctx.waitFor('the next block', async () => (await ctx.qrl.head()).latest > head, { timeoutEpochs: 1 });
      }
    }
    throw last;
  };
  try {
    const pr = await h.send(G.ArkGovernor, 'ArkGovernor', 'proposeQDayRatification');
    snap = BigInt(pr.blockNumber);
    id = BigInt(await h.call(G.ArkGovernor, 'ArkGovernor', 'qdayProposalOf', [round]));
    vr = await voteAgainst(id);
  } catch (e) {
    try {
      const open = id ?? BigInt(await h.call(G.ArkGovernor, 'ArkGovernor', 'qdayProposalOf', [round]));
      if (open !== 0n) await voteAgainst(open);
      ctx.note(`the ratification ${open} was voted against before the run stopped (OC-OPS-24)`);
    } catch (e2) {
      ctx.note(`URGENT: ratification of Q-Day round ${round} may be open with no vote against; vote against it before its end (${e2.message})`);
    }
    throw e;
  }
  const power = BigInt(await h.call(G.VeArk, 'VeArk', 'votingPowerAt', [me, snap]));
  const [vote] = h.decode(vr.logs, G.ArkGovernor, 'ArkGovernor', 'VoteCast');
  ctx.check(vote && BigInt(vote.args.weight) === power && power > 0n, 'a vote counts the voter\'s power at the snapshot block, read from the next block on (G3)', { weight: vote && vote.args.weight, power, snapshot: snap });
  await ctx.refuses('one vote per voter per ballot', 'AlreadyVoted', () => call(G.ArkGovernor, 'ArkGovernor', 'castVote', [id, 1]));
  await ctx.refuses('the ratification is not resolved while its 48 profile-hours run', 'VotingOpen', () => call(G.ArkGovernor, 'ArkGovernor', 'resolve', [id]));
  await h.until('the ratification vote to close', BigInt(await h.call(G.ArkGovernor, 'ArkGovernor', 'voteEndOf', [id])));
  const rr = await h.send(G.ArkGovernor, 'ArkGovernor', 'resolve', [id]);
  const [resolved] = h.decode(rr.logs, G.ArkGovernor, 'ArkGovernor', 'ProposalResolved');
  const [oracleResolved] = h.decode(rr.logs, oracle, 'ArkQDayOracle', 'Resolved');
  const [forV, against] = (await h.call(G.ArkGovernor, 'ArkGovernor', 'tallyOf', [id])).map(BigInt);
  const W = BigInt(await h.call(G.VeArk, 'VeArk', 'totalWeightAt', [snap]));
  const rule = await qdayRule(ctx, h);
  const expected = rule.passes(forV, against, W);
  ctx.check(resolved && resolved.args.passed === expected && expected === false, `the ratification is rejected exactly as G10 says: ${rule.text}`, { for: forV, against, W, [rule.param]: rule.bps, passed: resolved && resolved.args.passed });
  ctx.check(oracleResolved && BigInt(oracleResolved.args.round) === round && oracleResolved.args.ratified === false && (await state()) === H.QDAY.Normal && !(await h.call(oracle, 'ArkQDayOracle', 'frozen')) && !(await h.call(oracle, 'ArkQDayOracle', 'declared')), 'a rejected certification resolves the round false in a tx to ArkGovernor: Normal, not frozen, not declared (G7, G row 2)', { round });
  await ctx.refuses('the raiser of a rejected certification is on cooldown', 'OnCooldown', () => call(oracle, 'ArkQDayOracle', 'raiseAdvisory', [H.K('e2e: again')], raiser2.owner));
}

/**
 * The deployed governor's Q-Day rule (G10). Since OC-GOV-11 (2026-10-09):
 * ratified only if for >= Q_min (`qdayQuorumBps` of W) and for > against. A
 * stack deployed before it has no `qdayQuorumBps` and still runs the old rule
 * (rejected only if against >= O_min of W and against >= for), read through
 * its own getter, which the vendored ABI no longer carries.
 */
async function qdayRule(ctx, h) {
  const gov = h.G.ArkGovernor;
  try {
    const q = BigInt(await h.call(gov, 'ArkGovernor', 'qdayQuorumBps'));
    return { param: 'qdayQuorumBps', bps: q, text: 'ratified only if for >= Q_min of W and for > against (OC-GOV-11)', passes: (f, a, w) => f > a && f * BPS >= q * w };
  } catch (_) {
    const old = new (require('ethers').Interface)(['function qdayOppositionBps() view returns (uint16)']);
    const o = BigInt((await ctx.qrl.call(gov, old, 'qdayOppositionBps'))[0]);
    ctx.note('this governor predates OC-GOV-11: checked against its old Q-Day rule (redeploy the stack to carry Q_min)');
    return { param: 'qdayOppositionBps', bps: o, text: 'rejected only if against >= O_min of W and against >= for (pre-OC-GOV-11 stack)', passes: (f, a, w) => !(a > 0n && a * BPS >= o * w && f <= a) };
  }
}

/** B and C at S2: a 7-day key voted into force; a 30-day key contested by Leg B and re-voted. */
async function roundAtS2(ctx, h, { call, skip, me, GD, D30, E, diff, paramsNow, opState, propState }) {
  const { G } = h;
  const q = ctx.r.q;
  const params = q.ArkStakeParams;
  const gov = G.ArkGovernor;
  const day = D30 / 30n;
  const VOTING = BigInt(await h.call(gov, 'ArkGovernor', 'VOTING_PERIOD'));
  const LATE = BigInt(await h.call(gov, 'ArkGovernor', 'LATE_EXTENSION'));

  const cur = await paramsNow();
  const exit0 = BigInt(cur.exitDeadlineEpochs);
  const exit1 = exit0 < 4n ? exit0 + 1n : exit0 - 1n;
  const cc = BigInt(cur.claimCostGwei);
  const [, ccStep] = (await h.call(G.ArkTimelock, 'ArkTimelock', 'keyRule', [H.K('claimCostGwei')])).map(BigInt);
  const ccTo = cc + ccStep <= 10_000_000n ? cc + ccStep : cc - ccStep;

  const propose = async (payload, label) => {
    const r = await h.send(gov, 'ArkGovernor', 'propose', [H.KIND.StakingParameter, [params], [0n], [payload], label]);
    const [ev] = h.decode(r.logs, gov, 'ArkGovernor', 'ProposalCreated');
    const e = ctx.clock.epochOf(await ctx.qrl.timestampOf(r.blockNumber));
    ctx.check(ev && BigInt(ev.args.round) === e + 1n, `${label}: a proposal made in epoch e is voted in round e+1 (G8)`, { round: ev && ev.args.round, epoch: e });
    return { id: BigInt(ev.args.id), round: BigInt(ev.args.round) };
  };
  // G9 at S2 (moved from S1, where OC-GOV-06 now refuses every round proposal):
  // one live stage proposal at a time; its proposer withdraws it while Pending.
  {
    const st = Number(await h.call(params, 'ArkStakeParams', 'threatStage'));
    const stagePayload = h.encode('ArkStakeParams', 'setThreatStage', [st, st < 4 ? st + 1 : st - 1]);
    const r = await h.send(gov, 'ArkGovernor', 'propose', [H.KIND.StakingThreatStage, [params], [0n], [stagePayload], 'e2e: a stage proposal, cancelled']);
    const [ev] = h.decode(r.logs, gov, 'ArkGovernor', 'ProposalCreated');
    const id = BigInt(ev.args.id);
    await ctx.refuses('one live threat-stage proposal at a time (G9)', 'StageProposalLive', () => call(gov, 'ArkGovernor', 'propose', [H.KIND.StakingThreatStage, [params], [0n], [stagePayload], 'e2e']));
    await h.send(gov, 'ArkGovernor', 'cancel', [id]);
    ctx.check((await propState(id)) === H.PROPOSAL.Cancelled, 'the proposer withdraws its own Pending proposal', { id });
  }
  const p1 = await propose(diff('exitDeadlineEpochs', exit0, exit1), 'e2e: exitDeadlineEpochs, a 7-day key');
  const p2 = await propose(diff('claimCostGwei', cc, ccTo), 'e2e: claimCostGwei, a 30-day value-transfer key');

  // A delegator: its lock votes through the deployer until it overrides (G5).
  const del = await ctx.actor('gov-delegator', { fund: GAS_FLOAT });
  const amount = LOCK / 100n;
  let delegated = false;
  if (BigInt((await h.call(G.VeArk, 'VeArk', 'lockOf', [del.address])).amount) === 0n) {
    await h.send(G.ArkToken, 'ArkToken', 'transfer', [del.address, amount]);
    await h.send(G.ArkToken, 'ArkToken', 'approve', [G.VeArk, amount], { as: del });
    await h.send(G.VeArk, 'VeArk', 'createLock', [amount, (await h.now()) + 2n * E], { as: del });
    await h.send(G.VeArk, 'VeArk', 'delegate', [me], { as: del });
    delegated = true;
  } else {
    skip('the delegator of B', 'gov-delegator already holds a lock on this deployment');
  }

  // The round opens at its boundary: one snapshot for all its proposals.
  const openRound = async (r) => {
    await h.untilEpoch(`round ${r} to begin`, r);
    let opened = null;
    if (BigInt((await h.call(gov, 'ArkGovernor', 'roundOf', [r])).openedAt) === 0n) opened = await h.send(gov, 'ArkGovernor', 'openRound');
    const ro = await h.call(gov, 'ArkGovernor', 'roundOf', [r]);
    return { snap: BigInt(ro.snapshot), openedAt: BigInt(ro.openedAt), receipt: opened };
  };
  const { snap, openedAt, receipt: openR } = await openRound(p1.round);
  if (openR) {
    const [ro] = h.decode(openR.logs, gov, 'ArkGovernor', 'RoundOpened');
    const [hold] = h.decode(openR.logs, G.VeArk, 'VeArk', 'DelegatedHold');
    const until = openedAt + VOTING + LATE + D30 + E;
    ctx.check(ro && BigInt(ro.args.snapshot) === snap && hold && BigInt(hold.args.voteEnd) === openedAt + VOTING + LATE && BigInt(hold.args.until) >= until, 'opening a round snapshots once and holds every delegated lock until the round\'s latest effect horizon (G6)', { snapshot: snap, hold: hold && hold.args, until });
    if (delegated) ctx.check(BigInt(await h.call(G.VeArk, 'VeArk', 'pinOf', [del.address])) >= until, 'while the window is open a lock delegated to someone else cannot leave before the horizon (G6)', { pin: await h.call(G.VeArk, 'VeArk', 'pinOf', [del.address]) });
  }
  const head = (await ctx.qrl.head()).latest;
  await ctx.refuses('a snapshot is unreadable in its own block: a vote reads only blocks already sealed (G3)', 'FutureLookup', () => call(G.VeArk, 'VeArk', 'votingPowerAt', [me, head]));
  const dW = BigInt(await h.call(G.VeArk, 'VeArk', 'votingPowerAt', [me, snap]));
  const xw = delegated ? BigInt(await h.call(G.VeArk, 'VeArk', 'weightAt', [del.address, snap])) : 0n;
  const W = BigInt(await h.call(G.VeArk, 'VeArk', 'totalWeightAt', [snap]));
  const ownMe = BigInt(await h.call(G.VeArk, 'VeArk', 'weightAt', [me, snap]));
  ctx.check(W >= dW && dW >= ownMe + xw, 'W(s) >= the sum of voting power >= the sum of lock weights (G4)', { W, deployerPower: dW, deployerOwn: ownMe, delegatorOwn: xw });

  const vote = async (id, support, as = ctx.qrl) => {
    const r = await h.send(gov, 'ArkGovernor', 'castVote', [id, support], { as });
    const [v] = h.decode(r.logs, gov, 'ArkGovernor', 'VoteCast');
    const [pin] = h.decode(r.logs, G.VeArk, 'VeArk', 'PinRaised');
    return { v: v && v.args, pin: pin && pin.args };
  };
  const a1 = await vote(p1.id, 1);
  const a2 = await vote(p2.id, 1);
  ctx.check(a1.v && BigInt(a1.v.weight) === dW && BigInt(a2.v.weight) === dW, 'a delegatee votes with its power at the snapshot, delegated weight included (G3)', { weight: a1.v && a1.v.weight, power: dW });
  const pinMe = BigInt(await h.call(G.VeArk, 'VeArk', 'pinOf', [me]));
  ctx.check(pinMe >= openedAt + VOTING + LATE + D30 + E, 'every vote pins the voter past the latest time the decision can take effect (G6)', { pin: pinMe, horizon: openedAt + VOTING + LATE + D30 + E });
  await ctx.refuses('one vote per voter per ballot', 'AlreadyVoted', () => call(gov, 'ArkGovernor', 'castVote', [p1.id, 1]));
  if (delegated) {
    const o = await vote(p1.id, 0, del);
    const [f, ag] = (await h.call(gov, 'ArkGovernor', 'tallyOf', [p1.id])).map(BigInt);
    ctx.check(o.v && BigInt(o.v.weight) === xw && H.same(o.v.overrode, me) && f === dW - xw && ag === xw, 'a delegator voting in person takes its own weight back out of its delegatee\'s vote: no unit counted twice (G5)', { weight: o.v && o.v.weight, overrode: o.v && o.v.overrode, for: f, against: ag });
  }

  await h.until('the round\'s vote to close', BigInt(await h.call(gov, 'ArkGovernor', 'voteEndOf', [p1.id])));
  ctx.check((await propState(p1.id)) === H.PROPOSAL.Succeeded && (await propState(p2.id)) === H.PROPOSAL.Succeeded, 'both proposals pass 10% / 66% and are Succeeded');
  const queue = async (id) => {
    const r = await h.send(gov, 'ArkGovernor', 'queue', [id]);
    const [ev] = h.decode(r.logs, G.ArkTimelock, 'ArkTimelock', 'Scheduled');
    const ts = await ctx.qrl.timestampOf(r.blockNumber);
    const op = await h.call(G.ArkTimelock, 'ArkTimelock', 'opOf', [ev.args.opId]);
    const table = BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'delayFor', [op[3]]));
    return { opId: ev.args.opId, eta: BigInt(ev.args.eta), delay: BigInt(ev.args.delay), ts, table, epoch: ctx.clock.epochOf(ts) };
  };
  const o1 = await queue(p1.id);
  ctx.check(o1.delay === 7n * day && o1.delay === o1.table && o1.eta - o1.ts === o1.delay, 'queueing schedules the action with the delay the timelock looks up: 7 days for exitDeadlineEpochs (G2)', o1);
  const o2 = await queue(p2.id);
  ctx.check(o2.delay === D30 && o2.delay === o2.table && o2.eta - o2.ts === o2.delay && (ccTo > cc ? ccTo - cc : cc - ccTo) <= ccStep, 'a value-transfer key queues for 30 days, its step within the table\'s (G1, G2)', { ...o2, step: ccStep });

  /* C at S2: Leg B objects to the queued value-transfer proposal. */
  await ctx.refuses('a proposal that moves no value-transfer key is not objectable (D6)', 'NotObjectable', () => call(gov, 'ArkGovernor', 'object', [p1.id]));
  const bondAbi = iface('ArkCatBond', qrlBuild(ctx.r.manifest.profile));
  const mine = BigInt((await ctx.qrl.call(q.ArkCatBond, bondAbi, 'principalAt', [me, o2.epoch]))[0]);
  const total = BigInt((await ctx.qrl.call(q.ArkCatBond, bondAbi, 'totalPrincipalAt', [o2.epoch]))[0]);
  const objBps = BigInt(await h.call(gov, 'ArkGovernor', 'objectionThresholdBps'));
  let revote = null;
  if (mine === 0n || mine * BPS < objBps * total) {
    skip('C at S2', `the deployer holds ${mine} of ${total} principal at the queue epoch, under ${objBps} bps`);
    if (GD.able) await GD.cancel(o2.opId);
  } else {
    const r = await h.send(gov, 'ArkGovernor', 'object', [p2.id]);
    const [ev] = h.decode(r.logs, gov, 'ArkGovernor', 'ProposalContested');
    revote = ev ? BigInt(ev.args.revoteRound) : null;
    ctx.check(ev && revote === ctx.clock.epochOf(await ctx.qrl.timestampOf(r.blockNumber)) + 1n && (await propState(p2.id)) === H.PROPOSAL.Contested && (await opState(o2.opId)) === H.OP.Cancelled, 'Leg B at its threshold contests a queued value-transfer proposal: its operation is cancelled and it is voted again next round (D6, design §6.8)', { revoteRound: revote, principal: mine, total });
  }

  if (revote !== null) {
    const rv = await openRound(revote);
    const again = await vote(p2.id, 1);
    ctx.check(again.v && BigInt(again.v.weight) === BigInt(await h.call(G.VeArk, 'VeArk', 'votingPowerAt', [me, rv.snap])), 'the re-vote reads the new round\'s snapshot (G3)', { weight: again.v && again.v.weight });
  }

  // The 7-day key: executed, in force from the next boundary.
  await h.until('the 7-day key\'s delay', o1.eta);
  const xr = await h.send(G.ArkTimelock, 'ArkTimelock', 'execute', [o1.opId]);
  const [staged] = h.decode(xr.logs, params, 'ArkStakeParams', 'ParamChangeStaged');
  const xe = ctx.clock.epochOf(await ctx.qrl.timestampOf(xr.blockNumber));
  ctx.check(staged && staged.args.key.toLowerCase() === H.K('exitDeadlineEpochs').toLowerCase() && BigInt(staged.args.previous) === exit0 && BigInt(staged.args.value) === exit1 && BigInt(staged.args.effectiveEpoch) === xe + 1n, 'an executed diff takes effect at the next epoch boundary, never retroactively (G8)', { staged: staged && staged.args, executedIn: xe });
  if (delegated) {
    const lock = await h.call(G.VeArk, 'VeArk', 'lockOf', [del.address]);
    if (BigInt(lock.end) <= (await h.now())) {
      await ctx.refuses('a matured lock whose vote is still pinned cannot be withdrawn (G6)', 'VotePinned', () => call(G.VeArk, 'VeArk', 'withdraw', [], del.address));
    } else {
      skip('VotePinned', `the delegator's lock ends at ${lock.end}, after this point`);
    }
  }

  if (revote !== null) {
    await h.until('the re-vote to close', BigInt(await h.call(gov, 'ArkGovernor', 'voteEndOf', [p2.id])));
    const attempt = Number((await h.call(gov, 'ArkGovernor', 'proposalOf', [p2.id]))[2]);
    ctx.check((await propState(p2.id)) === H.PROPOSAL.Succeeded && attempt === 1, 'the contested proposal passes its one re-vote at 15% / 75%', { attempt });
    const o3 = await queue(p2.id);
    await ctx.refuses('a contested proposal is objected to once only: its re-vote is final (D6)', 'NotObjectable', () => call(gov, 'ArkGovernor', 'object', [p2.id]));
    if (GD.able) {
      const ev = await GD.cancel(o3.opId);
      ctx.check(ev && H.same(ev.by, G.GuardianMultisig) && (await propState(p2.id)) === H.PROPOSAL.Cancelled, 'at S2 the guardian still cancels a Queued operation, and the proposal reads Cancelled (G14)', { by: ev && ev.by });
    } else {
      skip('the guardian cancel at S2', 'no guardian keys; the re-voted claimCostGwei operation stays queued for 30 days');
    }
  }

  await h.untilEpoch('the boundary the 7-day key takes effect at', BigInt(staged.args.effectiveEpoch));
  const now = await paramsNow();
  ctx.check(BigInt(now.exitDeadlineEpochs) === exit1 && (await propState(p1.id)) === H.PROPOSAL.Executed, 'from that boundary the voted value is in force: a veARK round changed a parameter through the timelock, end to end (B)', { exitDeadlineEpochs: now.exitDeadlineEpochs });
}
