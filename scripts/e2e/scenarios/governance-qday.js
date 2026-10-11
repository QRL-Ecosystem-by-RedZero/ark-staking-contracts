/**
 * The whole QRL side as the VPS runs it after a devnet reset, and the
 * declaration through contracts/core's own oracle, end to end.
 *
 * TERMINAL. The declaration closes the escrow for good: this scenario ends
 * the life of the deployment it runs against.
 *
 * The order is the relayer's (`engine/redeploy.js`): contracts/core's
 * governance stack from the vendored artifacts (`scripts/lib/governance.js`,
 * deployed by `e2e-local.js` before the leg because the scenario asks for it),
 * the QRL leg wired to it — core's ARK, veARK, ArkQDayOracle and ArkTimelock —
 * then the relayer loop. The leg comes up governed by the timelock with
 * nothing pending (OC-GOV-03) and the proposer multisig wires the stack; five
 * bonded test attesters
 * raise and certify an advisory (the freeze reaches the escrow as a leaf that
 * is not a stand-in); veARK ratifies it through ArkGovernor's off-round vote;
 * and the relayer, as the keeper, records the claimants, opens the trigger-2
 * settlement and settles the severity at the close of the window — nothing
 * enqueued by hand, no double, no stand-in.
 *
 * What stands in: nothing on the declaration path. The attesters are test
 * keys (phase 1 of the testnet: the private devnet has no independent Q-Day
 * attesters), and the valuation oracle is still `MockPriceOracle` (D2).
 *
 * Every identity is an e2e actor (`ctx.actor`), never a 20-byte address
 * passed as `from`, which a live QRL client ignores (OC-OPS-05): on the
 * harness the governance overrides name the actors' static addresses
 * (`harnessActorAddress`); on a live chain the deployment's multisig owners
 * and attester panel must be the actors' derived addresses (or the
 * deployer), and the run says which keys it holds before it starts.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { ONE, harnessActorAddress, units } = require('../lib');
const H = require('../helpers/governance');
const { iface } = require('../../lib/chains');
const { governanceBuild, scheduleAcceptances, acceptanceStatus, wiringStatus } = require('../../lib/governance');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

const T2_FLOOR = keccak256(toUtf8Bytes('ARK_T2_FLOOR'));
/** Five test attesters, the oracle's quorum (core `ArkQDayOracle.QUORUM`), a proposer and a guardian: e2e actor labels. */
const ATTESTERS = ['gq-attester-0', 'gq-attester-1', 'gq-attester-2', 'gq-attester-3', 'gq-attester-4'];
const PROPOSERS = ['gq-proposer'];
const GUARDIANS = ['gq-guardian'];
const ATTESTER_BOND = 10n * ONE;
/** Gas money for each actor that sends. */
const GAS_FLOAT = 100n * ONE;
/** core `IArkQDayOracle.State`. */
const CERTIFIED = 2;
const DECLARED = 3;

module.exports = {
  description: 'governance deployed from the vendored core artifacts, the leg deployed under its timelock, the wiring by the proposer multisig, an advisory certified five of five and ratified by veARK, and trigger 2 kept by the relayer',
  terminal: true,
  // Read by scripts/e2e-local.js: deploy contracts/core's stack first, with
  // these accounts, and wire the leg to it.
  governance: {
    proposerOwners: PROPOSERS.map(harnessActorAddress),
    proposerThreshold: 1,
    guardianOwners: GUARDIANS.map(harnessActorAddress),
    guardianThreshold: 1,
    attesters: ATTESTERS.map(harnessActorAddress),
    attesterBond: ATTESTER_BOND,
  },
  outOfScope: [
    'the severity above the floor: the series reads no decline here (qday.js and the unit suite cover a measured and a held balance)',
    'the recovery after the declaration (qday.js)',
    'the S1 -> S2 handover of the timelock to the governor (core test/ArkTimelock.test.js)',
  ],
  async run(ctx, opts) {
    const dep = ctx.r.deployment;
    ctx.check(dep.qday && dep.qday.kind === 'real' && dep.governance, 'the leg reads contracts/core\'s ArkQDayOracle from a governance record live on this chain', { qday: dep.qday, governance: dep.governance && dep.governance.record });
    const G = Object.fromEntries(Object.entries(dep.governance.addresses).map(([n, a]) => [n, toHex(a)]));
    const build = governanceBuild({ client: ctx.qrl, profileName: ctx.r.manifest.profile });
    const abi = (n) => iface(n, build);
    const call = async (to, n, m, args = []) => (await ctx.qrl.call(to, abi(n), m, args))[0];
    const send = (to, n, m, args = [], o = {}) => ctx.qrl.send(to, abi(n), m, args, o);
    const now = async () => (await ctx.qrl.head()).timestamp;

    /* ------------------------------------------------------------ the keys this run holds */
    const pOwners = (await call(G.ProposerMultisig, 'ArkMultisig', 'owners')).map(toHex);
    const pK = BigInt(await call(G.ProposerMultisig, 'ArkMultisig', 'threshold'));
    const proposers = await H.signersFor(ctx, pOwners, PROPOSERS, GAS_FLOAT);
    ctx.check(proposers.length >= 1 && pK === 1n, 'this run holds the key of the one-of-one proposer multisig the deployment names (an e2e actor, or the deployer)', { owners: pOwners, threshold: pK, held: proposers.map((x) => x.label) });
    const oracle = G.ArkQDayOracle;
    const required = BigInt(await call(oracle, 'ArkQDayOracle', 'bondRequired'));
    const panel = (await call(oracle, 'ArkQDayOracle', 'attesters')).map(toHex);
    const attesters = await H.signersFor(ctx, panel, ATTESTERS, required + GAS_FLOAT);
    ctx.check(attesters.length >= 5, 'this run holds five attester keys of the oracle panel, its quorum (e2e actors gq-attester-*)', { panel, held: attesters.map((x) => x.label) });
    const stranger = await ctx.actor('gq-stranger');

    /* ------------------------------------------------------------ the handover */
    // deployQrlLeg built the parameter set and the delegation under the
    // timelock and had it accept the registry after admission, in the same
    // run (OC-GOV-03): no deployer window, nothing to accept. The S1 proposer
    // multisig wires the stack, as `scripts/governance-accept.js --schedule`
    // does for an operator. (Changed 2026-10-04: the scenario used to schedule
    // and execute three 48-hour acceptances here.)
    const q = ctx.r.q;
    const status = await acceptanceStatus({ client: ctx.qrl, leg: q });
    ctx.check(Object.values(status).every((x) => x.governance === G.ArkTimelock && /^0x0*$/.test(x.pending || '0x')), 'ArkTimelock governs Ark Staking from the deploying run, nothing pending (whitepaper §6.3, core design §6.1, OC-GOV-03)', status);
    await ctx.refuses('the deployer governs nothing: a stage step from its key is refused', 'OnlyGovernance', () =>
      ctx.qrl.call(q.ArkStakeParams, ctx.r.abi.params, 'setThreatStage', [1, 2]),
    );
    const ops = await scheduleAcceptances({ client: proposers[0].client, build, governance: G, leg: q, log: () => {} });
    const wiring = await wiringStatus({ client: ctx.qrl, build, governance: G, leg: q });
    const lower = (x) => String(x || '').toLowerCase();
    ctx.check(!ops.some((o) => o.kind === 'accept') && ops.filter((o) => o.kind === 'schedule').length === 2 && ops.filter((o) => o.kind === 'schedule').every((o) => o.opId && o.eta > 0n) && lower(wiring.timelockObjectionSource) === lower(toHex(q.ArkCatBond)) && lower(wiring.timelockGovernor) === lower(G.ArkGovernor), 'the proposer multisig wires the stack: the timelock names the bond and the governor, and the governor\'s objection source and court are 30-day operations kept by op id (OC-GOV-04, OC-GOV-05)', { ops: ops.map((o) => ({ name: o.name, opId: o.opId })), wiring });
    await ctx.refuses('the governor\'s wiring waits its 30 profile-days', 'NotReady', () =>
      ctx.qrl.call(G.ArkTimelock, abi('ArkTimelock'), 'execute', [ops.find((o) => o.kind === 'schedule').opId]),
    );

    /* ------------------------------------------------------------ a position */
    const a = ctx.asset(opts.asset);
    await ctx.seedIfNeeded(a);
    const anchored = await ctx.anchor(a, units(opts.notional, 100));
    await ctx.waitAnchorRecorded(anchored.id);
    await ctx.waitEpochs(1);

    /* ------------------------------------------------------------ the advisory */
    const quorum = attesters.slice(0, 5);
    for (const att of quorum) {
      const bond = BigInt(await call(oracle, 'ArkQDayOracle', 'bondOf', [att.owner]));
      if (bond < required) await att.client.send(oracle, abi('ArkQDayOracle'), 'postBond', [], { value: required - bond });
    }
    await ctx.refuses('an account outside the panel raises no advisory', 'NotAttester', () =>
      ctx.qrl.call(oracle, abi('ArkQDayOracle'), 'raiseAdvisory', ['0x' + 'ab'.repeat(32)], { from: stranger.address }),
    );
    const artefact = keccak256(toUtf8Bytes('e2e: a reproducible key-recovery artefact'));
    await quorum[0].client.send(oracle, abi('ArkQDayOracle'), 'raiseAdvisory', [artefact]);
    ctx.check(await call(oracle, 'ArkQDayOracle', 'frozen'), 'one bonded attester\'s advisory freezes at once (core ArkQDayOracle step 1)');
    await ctx.waitFor('the freeze sealed and consumed on the origin chain', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].frozen === true, { timeoutEpochs: 2 });
    const freeze = ctx.sealed('freeze', (x) => x.frozen === true);
    ctx.check(freeze.standIn === null && freeze.source === 'ArkQDayOracle.frozen', 'the freeze leaf was read from core\'s oracle and is not a stand-in (item 74)', { source: freeze.source, standIn: freeze.standIn });

    for (const att of quorum.slice(1)) await att.client.send(oracle, abi('ArkQDayOracle'), 'certify', []);
    ctx.check(Number(await call(oracle, 'ArkQDayOracle', 'state')) === CERTIFIED, 'five of the panel certify the same artefact inside the window: Certified, not yet declared', { state: await call(oracle, 'ArkQDayOracle', 'state') });
    await ctx.refuses('only ArkGovernor resolves a certification', 'OnlyGovernor', () =>
      ctx.qrl.call(oracle, abi('ArkQDayOracle'), 'resolve', [1n, true]),
    );

    /* ------------------------------------------------------------ the ratification */
    // veARK is the only vote source: the deployer holds liquid ARK buckets on
    // this deployment (scripts/lib/governance.js) and locks some of it.
    const epochLen = BigInt(ctx.clock.EPOCH_LENGTH);
    const lock = 100_000n * ONE;
    await send(G.ArkToken, 'ArkToken', 'approve', [G.VeArk, lock]);
    await send(G.VeArk, 'VeArk', 'createLock', [lock, (await now()) + 30n * epochLen]);
    // Since OC-GOV-11 (2026-10-09) a ratification passes only if the votes for
    // reach Q_min of W and exceed the votes against: nobody voting rejects it.
    // The deployer's lock is the only veARK here, so its vote for is all of W.
    const pr = await send(G.ArkGovernor, 'ArkGovernor', 'proposeQDayRatification');
    const pid = await call(G.ArkGovernor, 'ArkGovernor', 'proposalCount');
    await send(G.ArkGovernor, 'ArkGovernor', 'castVote', [pid, 1]);
    const voteEnd = BigInt(await call(G.ArkGovernor, 'ArkGovernor', 'voteEndOf', [pid]));
    await ctx.refuses('the ratification is not resolved while its 48 profile-hours run', 'VotingOpen', () =>
      ctx.qrl.call(G.ArkGovernor, abi('ArkGovernor'), 'resolve', [pid]),
    );
    await ctx.waitFor('the ratification vote to close', async () => (await now()) >= voteEnd, { timeoutEpochs: 2 });
    await send(G.ArkGovernor, 'ArkGovernor', 'resolve', [pid]);
    {
      const [forV, against] = (await ctx.qrl.call(G.ArkGovernor, abi('ArkGovernor'), 'tallyOf', [pid])).map(BigInt);
      const W = BigInt(await call(G.VeArk, 'VeArk', 'totalWeightAt', [BigInt(pr.blockNumber)]));
      const q = BigInt(await call(G.ArkGovernor, 'ArkGovernor', 'qdayQuorumBps'));
      ctx.check(forV > against && forV * 10_000n >= q * W, 'the ratification met G10: votes for >= Q_min of W and > votes against (OC-GOV-11)', { for: forV, against, W, qdayQuorumBps: q });
    }
    ctx.check(Number(await call(oracle, 'ArkQDayOracle', 'state')) === DECLARED && (await call(oracle, 'ArkQDayOracle', 'declared')), 'veARK ratifies the certification and the oracle declares, for good (core design §6.6)', { declaredAt: await call(oracle, 'ArkQDayOracle', 'declaredAt') });
    const declaredEpoch = await ctx.originEpoch();
    if (G.ArkPhase) {
      // The network's ArkPhase reads the declaration as phase 3 at once
      // (phase()); phaseAt(epoch), which the parameter set reads, applies it
      // from the first boundary at or after declaredAt (core §3.6), so the
      // stage is 4 from the next epoch (checked below, after the boundary).
      const phaseNow = Number(await call(G.ArkPhase, 'ArkPhase', 'phase'));
      const stageNow = Number((await ctx.qrl.call(q.ArkStakeParams, ctx.r.abi.params, 'threatStage'))[0]);
      ctx.check(phaseNow === 3, 'the declaration is phase 3 for every reader of phase() at once (core §3.6)', { phase: phaseNow, stageInTheDeclaringEpoch: stageNow });
      ctx.note(`threat stage in the declaring epoch ${declaredEpoch}: ${stageNow} (the parameter set reads phaseAt, which takes the declaration from the next boundary)`);
      await ctx.refuses('nothing but restore moves the phase from Q-Day: setPhase is refused even from the timelock', 'PhaseLocked', () =>
        ctx.qrl.call(G.ArkPhase, abi('ArkPhase'), 'setPhase', [0, 1], { from: G.ArkTimelock }),
      );
    }
    await ctx.refuses('a release instructed after the declaration', 'ReleaseClosed', () =>
      ctx.registry('instructRelease', [anchored.id, ctx.r.evmArg(ctx.origin.address)]),
    );

    /* ------------------------------------------------------------ the keeper */
    // Nobody records a claimant or opens the settlement by hand: the relayer's
    // housekeeping does both, then the close leaf reaches the escrow.
    await ctx.waitFor('the relayer to record the claimants and open trigger 2', async () => Number((await ctx.bond('declaration')).stage) >= 1, { timeoutEpochs: 2 });
    const t2 = await ctx.bond('declaration');
    const claimants = await ctx.recovery('claimants');
    ctx.check(BigInt(claimants.live) === BigInt(await ctx.registry('totalAnchored')), 'the keeper recorded every position still anchored, so the record is complete (whitepaper §5.2)', { live: claimants.live });
    ctx.check(BigInt(t2.drawn) === (BigInt(t2.fullSettlement) * BigInt(t2.d0)) / 10000n && BigInt(t2.drawn) > 0n, 'the keeper opened the settlement: D_0 of the full settlement is drawn (whitepaper §4.6, §5.2)', { drawn: t2.drawn, full: t2.fullSettlement, d0: t2.d0 });
    await ctx.waitFor('the escrow closed on the origin chain', async () => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, 'controlOf', [a.escrow]))[0].closed === true, { timeoutEpochs: 2 });
    const close = ctx.sealed('close');
    ctx.check(close.standIn === null && close.source === 'ArkQDayOracle.declared', 'the close leaf was read from the ratified declaration and is not a stand-in', { source: close.source });

    await ctx.waitEpochs(1);
    if (G.ArkPhase) {
      const stage = Number((await ctx.qrl.call(q.ArkStakeParams, ctx.r.abi.params, 'threatStage'))[0]);
      const at = Number(await call(G.ArkPhase, 'ArkPhase', 'phaseAt', [await ctx.originEpoch()]));
      ctx.check(at === 3 && stage === 4 && (await ctx.originEpoch()) > declaredEpoch, 'from the boundary after the declaration the phase in force is 3 and the threat stage it fixes is 4; no vote moves it (item 129)', { phaseAt: at, stage, declaredEpoch });
    }
    await ctx.bondSend('claimSettlement', [T2_FLOOR, anchored.id]);
    ctx.check((await ctx.bond('settlementPaidTo', [T2_FLOOR, anchored.id])) > 0n, 'the claimant is paid its entitlement to the floor draw in QRL (whitepaper §5.2)');

    await ctx.waitFor('the relayer to settle the severity at the close of the window', async () => Number((await ctx.bond('declaration')).stage) === 3, { timeoutEpochs: Number(t2.windowEpochs) + 3 });
    const after = await ctx.bond('declaration');
    ctx.check(BigInt(after.drawn) === BigInt(t2.drawn), 'with no decline measured the severity is the floor and nothing more is drawn: the balance is released (max(D_0, S) = D_0)', { drawn: after.drawn });
    ctx.note(`keeper record: ${JSON.stringify(ctx.r.state.data.declaration)}`);
  },
};
