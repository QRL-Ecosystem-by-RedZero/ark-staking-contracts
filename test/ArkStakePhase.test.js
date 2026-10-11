/**
 * ArkStakeParams reads the ecosystem phase (QuantumArk-Phases.md §3-4;
 * staking CLAUDE.md item 129, 2026-10-07).
 *
 * The rules this file defends:
 *  1. The set is bound at construction to one phase contract, nonzero, that
 *     counts epochs of this product's length; there is no setter.
 *  2. The threat stage is the phase's, [1, 1, 2*, 4, 1]: in phase 2 a band
 *     2 - 3 that `setThreatStage` moves under its old rules, and nowhere else;
 *     every entry into phase 2 starts at 2.
 *  3. Three fields are per phase (`PhaseRow[5]`): the views that consumers
 *     and the live scenarios read keep their names and answer with the row of
 *     the phase in force, switching at the boundary the phase does.
 *  4. A cell moves by its own key (`<field>@<phase>`), with the CAS, the step,
 *     the ranges and relations on all five rows, and the next-epoch effect of
 *     every other key; the flat keys are gone.
 *  5. The run-off gate still closes on stage 4 (phase 3) and reopens in
 *     phase 4 with no code of its own; `stageStepQueued` covers a phase step
 *     that changes the stage as well as a band step.
 *
 * The phase is a double (`MockArkPhase`): core's `ArkPhase` and its transition
 * rules are tested in contracts/core. Rows are the reference rows of §4 here
 * (`ZERO_ROWS` launches them), unlike the fixture's flat default.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Interface, keccak256, toUtf8Bytes } = require('ethers');
const { Chain, artifact } = require('./harness');
const F = require('./stake-fixture');

const { ACCOUNTS, ONE, EPOCH, TERM, CLASS, REFERENCE_ROWS, ZERO_ROWS, FLAT_ROWS, STAGE_OF_PHASE, PHASE_ROW_FIELDS } = F;
const iface = new Interface(artifact('ArkStakeParams').abi);
const ZERO_ADDR = '0x' + '00'.repeat(20);
/** The Cushion's lane (IArkFlow, ArkLanes.CUSHION). */
const CUSHION = keccak256(toUtf8Bytes('quantumark.lane.cushion.v1'));

async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return { name: e.message, args: e.data ? iface.parseError(e.data)?.args : undefined };
  }
  throw new Error('expected a revert');
}

const op = (ctx) => ({ from: ctx.params.phase.operatorAccount });
/** Phase `p` in force from the next boundary, as core schedules a step. */
const schedule = (ctx, p) => ctx.params.phase.send('setPending', [p, F.epochNow(ctx) + 1n], op(ctx));
/** Phase `p` in force from the next boundary, and the boundary crossed. */
async function toPhase(ctx, p) {
  await schedule(ctx, p);
  F.toNextEpoch(ctx);
}
/** Phase `p` in force now (the double alone does this mid-epoch; a declaration is the real case). */
const setNow = (ctx, p) => ctx.params.phase.send('setPhase', [p], op(ctx));
const band = (ctx, from, to) => ctx.params.send('setThreatStage', [from, to], { from: ACCOUNTS.admin });
const row = async (ctx, p) => [...(await ctx.params.call('phaseRow', [p]))].map(Number);
const stage = async (ctx) => Number(await ctx.params.call('threatStage'));

describe('rule 1: the set is bound to one phase contract at construction', () => {
  test('zero is refused; a phase counting another epoch length is refused; the one named is read back and never replaced', async () => {
    const chain = await Chain.create();
    const types = ['address', 'address', F.PARAMS_TYPE, 'address', F.PHASE_ROW_TYPE];
    const r = await rejection(chain.deploy('ArkStakeParams', types, [ACCOUNTS.admin, ACCOUNTS.admin, F.ZERO_PARAMS, ZERO_ADDR, ZERO_ROWS]));
    assert.match(r.name, /ZeroAddress/);

    const phase = await chain.deploy('MockArkPhase');
    await phase.send('setEpochLength', [BigInt(EPOCH) / 7n * 6n]);
    const m = await rejection(F.deployParams(chain, { phase: phase.address }));
    assert.match(m.name, /PhaseEpochMismatch/);
    assert.equal(m.args.phaseEpochLength, BigInt(EPOCH) / 7n * 6n);
    assert.equal(m.args.epochLength, BigInt(EPOCH));

    await phase.send('setEpochLength', [BigInt(EPOCH)]);
    const params = await F.deployParams(chain, { phase: phase.address, rows: ZERO_ROWS });
    assert.equal((await params.call('arkPhase')).toLowerCase(), phase.address.toLowerCase());
    // No function moves it: the only writes are the governed ones and the one-shot registry.
    const writes = iface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name);
    assert.ok(!writes.some((n) => /phase/i.test(n)), writes.join(', '));
  });

  test('a zero row 0 launches the reference rows of §4, each one read back by phaseRow; a sixth phase has no row', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    for (let p = 0; p < 5; p++) assert.deepEqual(await row(ctx, p), REFERENCE_ROWS[p], `row ${p}`);
    assert.deepEqual(REFERENCE_ROWS, [[7, 500, 1500], [7, 500, 1500], [3, 1000, 2000], [0, 1500, 3000], [7, 500, 1500]]);
    const r = await rejection(ctx.params.call('phaseRow', [5]));
    assert.match(r.name, /UnknownPhase/);
    // Explicit rows are written as given.
    const flat = await F.deployStack({ assets: [] });
    for (let p = 0; p < 5; p++) assert.deepEqual(await row(flat, p), FLAT_ROWS[p], `flat row ${p}`);
  });
});

describe('rule 2: the stage is derived from the phase; the band of phase 2 is the only vote', () => {
  test('each phase carries its compiled stage, rung and levy', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    const rung = { 1: 1850n, 2: 2500n, 3: 3000n, 4: 3700n };
    for (const p of [0, 1, 2, 3, 4]) {
      await setNow(ctx, p);
      assert.equal(await stage(ctx), STAGE_OF_PHASE[p], `phase ${p}`);
      assert.equal(await ctx.params.call('sigmaTargetBps'), rung[STAGE_OF_PHASE[p]], `rung of phase ${p}`);
      // The levy is the stage's (whitepaper §4.2): nothing at the fourth stage, Q-Day.
      assert.equal((await ctx.registry.call('allocation')).levyBps, p === 3 ? 0n : 200n, `levy in phase ${p}`);
    }
    assert.deepEqual(STAGE_OF_PHASE, [1, 1, 2, 4, 1]);
  });

  test('a phase outside 0 - 4 is refused wherever the stage or a row is read', async () => {
    const ctx = await F.deployStack({ assets: [] });
    await setNow(ctx, 5);
    for (const view of ['threatStage', 'sigmaTargetBps', 'admittedTermsMask', 'bondParams', 'params']) {
      assert.match((await rejection(ctx.params.call(view))).name, /UnknownPhase/, view);
    }
  });

  test('outside phase 2 a stage vote is refused naming the phase; inside it only 2 <-> 3', async () => {
    const ctx = await F.deployStack({ assets: [] });
    for (const p of [0, 1, 3, 4]) {
      await setNow(ctx, p);
      const s = STAGE_OF_PHASE[p];
      for (const to of [s - 1, s + 1]) {
        const r = await rejection(band(ctx, s, to));
        assert.match(r.name, /StageFixedByPhase/, `phase ${p}: ${s} -> ${to}`);
        assert.equal(r.args.phase, BigInt(p));
      }
    }
    await setNow(ctx, 2);
    assert.match((await rejection(band(ctx, 2, 1))).name, /ThreatStageStep/);
    await band(ctx, 2, 3);
    F.toNextEpoch(ctx);
    assert.equal(await stage(ctx), 3);
    assert.match((await rejection(band(ctx, 3, 4))).name, /ThreatStageStep/);
  });

  test('re-entering phase 2 starts at stage 2, whatever band the last stay ended at', async () => {
    const ctx = await F.deployStack({ assets: [] });
    await toPhase(ctx, 2);
    await band(ctx, 2, 3);
    F.toNextEpoch(ctx);
    assert.equal(await stage(ctx), 3);
    const lastOfStay = F.epochNow(ctx);
    await toPhase(ctx, 1);
    assert.equal(await stage(ctx), 1);
    await toPhase(ctx, 2);
    assert.equal(await stage(ctx), 2, 'a new stay begins at the bottom of the band');
    assert.equal((await ctx.params.call('runoffParamsAt', [lastOfStay]))[2], 3n, 'the last stay keeps its band in the record');
    // The band moves again from 2, under its rules.
    assert.match((await rejection(band(ctx, 3, 2))).name, /ThreatStageMismatch/);
    await band(ctx, 2, 3);
    F.toNextEpoch(ctx);
    assert.equal(await stage(ctx), 3);
  });

  test('a band step staged for the boundary the phase leaves 2 at changes nothing, and the next stay still starts at 2', async () => {
    const ctx = await F.deployStack({ assets: [] });
    await toPhase(ctx, 2);
    await band(ctx, 2, 3);
    await schedule(ctx, 1);
    // The phase step decides the stage at that boundary.
    const e = F.epochNow(ctx);
    assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [1n, e + 1n]);
    F.toNextEpoch(ctx);
    assert.equal(await stage(ctx), 1);
    await toPhase(ctx, 2);
    assert.equal(await stage(ctx), 2);
  });

  test('a declaration reads as phase 3 in the epoch it is read in: stage 4 and Q-Day\'s row at once', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    const e = F.epochNow(ctx);
    await ctx.params.phase.send('setDeclared', [true], op(ctx));
    assert.equal(await stage(ctx), 4);
    assert.equal(await ctx.params.call('admittedTermsMask'), 0n);
    assert.equal((await ctx.params.call('runoffParamsAt', [e - 1n]))[2], 1n, 'an epoch before the declaration keeps its stage');
  });
});

describe('rule 3: the three per-phase views answer with the row of the phase in force, from its boundary', () => {
  test('admittedTermsMask, bondParams and params switch rows at the boundary, not when the step is scheduled', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    const views = async () => {
      const p = await ctx.params.call('params');
      const b = await ctx.params.call('bondParams');
      const mask = Number(await ctx.params.call('admittedTermsMask'));
      assert.equal(Number(p.admittedTermsMask), mask);
      assert.equal(p.cushionTargetBps, b[6]);
      assert.equal(p.cushionCeilingBps, b[7]);
      return [mask, Number(b[6]), Number(b[7])];
    };
    assert.deepEqual(await views(), REFERENCE_ROWS[0]);
    for (const p of [1, 2, 3, 4]) {
      await schedule(ctx, p);
      assert.deepEqual(await views(), REFERENCE_ROWS[p - 1], `phase ${p} scheduled: the row of ${p - 1} still in force`);
      F.toNextEpoch(ctx);
      assert.deepEqual(await views(), REFERENCE_ROWS[p], `phase ${p} in force`);
    }
  });

  test('the bond issues by the row in force: no three-year term in phase 2, nothing in phase 3, every term again in phase 4', async () => {
    const ctx = await F.deployBondStack({ rows: ZERO_ROWS });
    const buy = (term) => F.subscribe(ctx, { term, value: ONE });
    for (const t of [TERM.QUARTER, TERM.YEAR, TERM.THREE_YEAR]) await buy(t);
    await toPhase(ctx, 2);
    await buy(TERM.YEAR);
    await assert.rejects(() => buy(TERM.THREE_YEAR), /TermNotAdmitted/, 'a position opened from 2030 would mature in the disallowed range');
    await toPhase(ctx, 3);
    for (const t of [TERM.QUARTER, TERM.YEAR, TERM.THREE_YEAR]) {
      await assert.rejects(() => buy(t), /TermNotAdmitted/, `phase 3, term ${t}: settlement only`);
    }
    await toPhase(ctx, 4);
    for (const t of [TERM.QUARTER, TERM.YEAR, TERM.THREE_YEAR]) await buy(t);
  });

  test('the Cushion lane\'s room follows the ceiling of the phase in force, cached at the bond\'s next close', async () => {
    const ctx = await F.deployBondStack({ rows: ZERO_ROWS });
    await F.subscribe(ctx, { value: 10_000n * ONE });
    const room = async () => (await ctx.bond.call('laneInfo', [CUSHION])).room;
    assert.equal(await room(), 1_500n * ONE, 'c_max 1,500 of 10,000 QRL at face in phase 0');
    await toPhase(ctx, 2);
    await ctx.bond.send('closeEpoch');
    assert.equal(await room(), 2_000n * ONE, 'phase 2: c_max 2,000');
  });
});

describe('rule 4: a cell moves by its own key, under every rule a key has', () => {
  test('compare-and-swap against the latest staged cell; two cells of one row in one epoch both land', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    const k = F.paramKey('cushionTargetBps@3');
    assert.equal(await ctx.params.call('paramOf', [k]), 1500n);
    await ctx.params.send('setParamsDiff', [[[k, 1500n, 1800n]]]);
    const r = await rejection(ctx.params.send('setParamsDiff', [[[k, 1500n, 1600n]]]));
    assert.match(r.name, /StaleParameter/);
    assert.equal(r.args.current, 1800n);
    assert.equal(await ctx.params.call('paramOf', [k]), 1800n, 'the latest staged value');
    await F.voteParams(ctx.params, { 'cushionCeilingBps@3': 2500 });
    F.toNextEpoch(ctx);
    assert.deepEqual(await row(ctx, 3), [0, 1800, 2500], 'neither undid the other');
  });

  test('the step is measured from the cell in force; the mask has none', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    let r = await rejection(F.voteParams(ctx.params, { 'cushionTargetBps@2': 1501 }));
    assert.match(r.name, /ParameterStepTooLarge/);
    assert.deepEqual([r.args.current, r.args.maxStep], [1000n, 500n]);
    r = await rejection(F.voteParams(ctx.params, { 'cushionCeilingBps@4': 2251 }));
    assert.deepEqual([r.args.current, r.args.maxStep], [1500n, 750n]);
    // The mask moves its whole range in one change.
    await F.voteParams(ctx.params, { 'admittedTermsMask@2': 7 });
    await F.voteParams(ctx.params, { 'admittedTermsMask@4': 1 });
  });

  test('ranges and relation 10 are checked on the whole draft, every row, whichever cells the diff names', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    // Each change alone is inside its step and range; together they break relation 10 in row 2.
    const r = await rejection(F.voteParams(ctx.params, { 'cushionTargetBps@2': 1500, 'cushionCeilingBps@2': 1400 }));
    assert.match(r.name, /RelationViolated/);
    assert.deepEqual([r.args.relation, r.args.supplied, r.args.bound], ['c_tgt <= c_max <= 3000@2', 1400n, 1500n]);
    // A cell of a phase not in force is checked all the same.
    const m = await rejection(F.voteParams(ctx.params, { 'admittedTermsMask@4': 0 }));
    assert.deepEqual([m.args.name, m.args.supplied], ['admittedTermsMask@4', 0n]);
    // A field diff is checked with the rows as staged: a bad row cannot ride on it.
    await F.voteParams(ctx.params, { 'cushionTargetBps@1': 1000 });
    await F.voteParams(ctx.params, { jurorSlashBps: 2500 });
    F.toNextEpoch(ctx);
    assert.deepEqual(await row(ctx, 1), [7, 1000, 1500]);
  });

  test('a cell of the phase in force takes effect at the next boundary; a cell of another phase waits for its phase', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS });
    await F.voteParams(ctx.params, { 'cushionCeilingBps@0': 2000, 'cushionCeilingBps@1': 750 });
    assert.equal((await ctx.params.call('bondParams'))[7], 1500n, 'staged, not in force');
    const [, effective] = await ctx.params.call('pendingParams');
    assert.equal(effective, F.epochNow(ctx) + 1n);
    assert.equal((await ctx.params.call('pendingParams'))[0].cushionCeilingBps, 2000n, 'the staged row of the phase in force');
    F.toNextEpoch(ctx);
    assert.equal((await ctx.params.call('bondParams'))[7], 2000n);
    await toPhase(ctx, 1);
    assert.equal((await ctx.params.call('bondParams'))[7], 750n);
  });

  test('the three flat keys are refused, and the set\'s own copies of the per-phase fields are never read', async () => {
    const ctx = await F.deployStack({ assets: [], rows: ZERO_ROWS, params: {} });
    for (const f of PHASE_ROW_FIELDS) {
      const r = await rejection(ctx.params.send('setParamsDiff', [[[F.paramKey(f), 0n, 1n]]]));
      assert.match(r.name, /UnknownParameter/, f);
    }
    // A launch set naming other values for the three is not what the views answer.
    const odd = await F.deployStack({ assets: [], rows: ZERO_ROWS, params: { admittedTermsMask: 1, cushionTargetBps: 0, cushionCeilingBps: 0 } });
    assert.deepEqual(await row(odd, 0), REFERENCE_ROWS[0], 'rows given outright win');
    assert.equal(await odd.params.call('admittedTermsMask'), 7n);
  });
});

describe('rule 5: the run-off gate and the queued-step flag', () => {
  test('the gate closes in phase 3 (stage 4) and reopens in phase 4 after two clean epochs, with no code of its own', async () => {
    const ctx = await F.deployBondStack({ rows: ZERO_ROWS });
    await F.subscribe(ctx, { value: ONE });
    await toPhase(ctx, 3);
    assert.equal(await ctx.bond.call('runoffGateClosed'), false, 'nothing runs until the boundary is crossed');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true);
    assert.equal(await ctx.registry.call('premiumCeilingInForceBps'), 8500n, 'the surge ceiling');
    await schedule(ctx, 4);
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true, 'the epoch of the step stood at stage 4');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), true, 'one clean epoch is not two');
    F.toNextEpoch(ctx);
    await ctx.bond.send('closeEpoch');
    assert.equal(await ctx.bond.call('runoffGateClosed'), false, 'Restoration reopens it');
    assert.equal(await stage(ctx), 1);
  });

  test('stageStepQueued: a phase step that changes the stage, a band step, and not a phase step that keeps it', async () => {
    const ctx = await F.deployStack({ assets: [] });
    const queued = async () => (await ctx.registry.call('allocation')).stepQueued;
    assert.equal(await queued(), false);
    await schedule(ctx, 1);
    assert.equal(await ctx.params.call('stageStepQueued'), false, '0 -> 1 keeps stage 1');
    assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [0n, 0n]);
    F.toNextEpoch(ctx);
    await schedule(ctx, 2);
    assert.equal(await queued(), true, '1 -> 2 moves the rung');
    assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [2n, F.epochNow(ctx) + 1n]);
    F.toNextEpoch(ctx);
    assert.equal(await queued(), false);
    await band(ctx, 2, 3);
    assert.equal(await queued(), true, 'a band step staged here');
    assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [3n, F.epochNow(ctx) + 1n]);
    F.toNextEpoch(ctx);
    assert.equal(await queued(), false);
    // Term-committed positions are refused while a step is on its way (the allocation's flag).
    await schedule(ctx, 3);
    assert.equal(await queued(), true, 'into Q-Day');
    assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [4n, F.epochNow(ctx) + 1n]);
  });
});
