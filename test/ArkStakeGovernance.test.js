/**
 * The Ark Staking side of governance (ArkGovernance-Design.md §6.1 - §6.4,
 * step 1 of §11; 2026-09-28, phase C1b): keyed diffs with compare-and-swap,
 * every range and relation checked on the whole draft, changes in force from
 * the next epoch boundary and never before, the threat stage bound to the
 * stage it moves from, and the quarter-range step on the value-transfer keys.
 *
 * The invariants of design §8 this tree can hold are named here the way
 * `test/ArkStakeSpec.test.js` names I1 - I39: G1 (no vote executes outside a
 * range or relation, checked on the draft), G2 (every setter is one the
 * timelock's compiled table knows, and there is no other way in), G8 (in force
 * at the epoch boundary; nothing already fixed moves) and G9 (the stage moves
 * one step per vote and once per epoch; the ladder cannot be moved around it).
 *
 * contracts/core holds the timelock. The repositories do not import each
 * other, so the G2 and key-table cases read core's sources as text where the
 * umbrella checkout has them, and skip naming the reason where it does not.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Interface, keccak256, toUtf8Bytes } = require('ethers');
const { artifact } = require('./harness');
const { loadModel, MISSING } = require('./spec-model');
const {
  ACCOUNTS,
  EPOCH,
  REFERENCE_PARAMS,
  PARAM_FIELDS,
  PHASE_ROW_FIELDS,
  REFERENCE_ROWS,
  ZERO_ROWS,
  deployStack,
  paramKey,
  voteParams,
  enactParams,
  toNextEpoch,
  epochNow,
} = require('./stake-fixture');

const iface = new Interface(artifact('ArkStakeParams').abi);

async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return { name: e.message, args: e.data ? iface.parseError(e.data)?.args : undefined };
  }
  throw new Error('expected a revert');
}

/** A raw diff, each change naming the value it expects to replace. */
const diff = (ctx, changes, from = ACCOUNTS.admin) =>
  ctx.params.send('setParamsDiff', [changes.map(([name, expected, value]) => [typeof name === 'string' && !name.startsWith('0x') ? paramKey(name) : name, BigInt(expected), BigInt(value)])], { from });

const inForce = async (ctx, name) => BigInt((await ctx.params.call('params'))[name]);

/**
 * The value-transfer keys of design §6.8 and the quarter of each one's
 * governable range (D7): whitepaper §6.3's outer bounds, a quarter truncated.
 * Thirty-nine since 2026-09-30 (EC-06; PV-05, PV-19), the model's
 * `VALUE_TRANSFER_KEYS`, which the case below holds this table to.
 * contracts/core's ArkGovTables carries the same figures; the G2 case below
 * holds the two tables equal.
 */
const RANGES = {
  threatStage1Bps: [1850, 4000],
  threatStage2Bps: [1850, 4000],
  threatStage3Bps: [1850, 4000],
  threatStage4Bps: [1850, 4000],
  verdictCoverBps: [3333, 8000],
  indemnityBps: [5000, 10000],
  pmlFloorBps: [1500, 5000],
  juniorThicknessBps: [5000, 9000],
  seniorCouponBps: [0, 500],
  trigger2FloorBps: [5000, 10000],
  severityFloorBps: [5000, 8000],
  // EC-06, 2026-09-30.
  premiumSlopeRatioBps: [2500, 10000],
  premiumCeilingBps: [1850, 9500],
  surgeCeilingBps: [1850, 8750],
  stabilizationLevyBps: [100, 500],
  commitmentTermEpochs: [4, 26],
  psrCapEpochs: [2, 12],
  tailPremiumFloorBps: [100, 500],
  maxEpochMoveBps: [1500, 3000],
  firstReserveDiscountBps: [300, 500],
  reserveStepBps: [250, 1000],
  reserveFloorBps: [2500, 6000],
  clearingFloorBps: [2500, 7500],
  solverBondCeilingBps: [500, 1500],
  solverBondFloorBps: [100, 300],
  operationsBps: [250, 1000],
  jurorFeeShareBps: [0, 5000],
  queueDecayBps: [1000, 2000],
  queueExposureFloorBps: [2000, 5000],
  runoffTriggerBps: [1500, 5000],
  runoffBoundBps: [1500, 2500],
  assessmentWindowEpochs: [2, 6],
  fxHaircutMaxBps: [0, 3000],
  // PV-05, PV-19.
  unsoldEpochs: [2, 12],
  bufferBps: [250, 1500],
  bufferEscalatorCapBps: [250, 1500],
  bufferRampThresholdBps: [500, 2000],
  offeringBatchMultiple: [0, 100],
  claimCostGwei: [0, 10000000],
  // The Cushion, 2026-10-06 (technical reference §3.2, §3.3).
  cushionTargetBps: [0, 2000],
  cushionCeilingBps: [0, 3000],
};
const STEPS = Object.fromEntries(Object.entries(RANGES).map(([k, [lo, hi]]) => [k, Math.floor((hi - lo) / 4)]));

/**
 * The keys of a field: its name, or since 2026-10-07 (item 129) for the three
 * per-phase fields its five cells, `<field>@0` - `<field>@4`. Core's table
 * names the per-phase fields by their cells; RANGES and STEPS above keep the
 * model's flat names, each cell taking its field's figures.
 */
const PHASES = [0, 1, 2, 3, 4];
const keysOf = (field) => (PHASE_ROW_FIELDS.includes(field) ? PHASES.map((p) => `${field}@${p}`) : [field]);

/* ------------------------------------------------------------------ */
/* contracts/core, read as text                                        */
/* ------------------------------------------------------------------ */

const CORE = process.env.ARK_CORE_DIR || path.join(__dirname, '..', '..', '..', 'ecosystem', 'contracts');
const TABLES = path.join(CORE, 'contracts', 'utils', 'ArkGovTables.hyp');
const coreAbsent = !fs.existsSync(TABLES) && `the ecosystem contracts are not checked out (${CORE}); set ARK_CORE_DIR`;

function coreTables() {
  const src = fs.readFileSync(TABLES, 'utf8');
  const keys = {};
  // A per-phase key's name carries its phase after an at sign (item 129).
  for (const [, id, name] of src.matchAll(/bytes32 internal constant (K_\w+) = keccak256\("([\w@]+)"\);/g)) keys[id] = name;
  const selectors = {};
  for (const [, id, sig] of src.matchAll(/bytes4 internal constant (\w+) =\s*bytes4\(keccak256\("([^"]+)"\)\);/g)) selectors[id] = sig;
  const body = src.slice(src.indexOf('function ruleOfKey'));
  const steps = {};
  const delays = {};
  for (const [, cond, delay, step] of body.matchAll(/if\s*\(([^)]*)\)\s*\{?\s*return\s*\((\w+),\s*(\d+)\)/g)) {
    for (const [id] of cond.matchAll(/K_\w+/g)) {
      steps[keys[id]] = Number(step);
      delays[keys[id]] = delay;
    }
  }
  // Since core's EC phase (2026-09-30) the value-transfer rows are a step
  // table of their own, `_valueTransferStep`, every one at thirty days
  // (`if (step != 0) return (D30, step)` in `ruleOfKey`).
  const vt = src.indexOf('function _valueTransferStep');
  if (vt >= 0) {
    const table = src.slice(vt, src.indexOf('return 0;', vt));
    const vtDelay = /step = _valueTransferStep\(k\);\s*if \(step != 0\) return \((\w+), step\);/.exec(body);
    for (const [, cond, step] of table.matchAll(/if\s*\(([^)]*)\)\s*return\s*(\d+);/g)) {
      for (const [id] of cond.matchAll(/K_\w+/g)) {
        steps[keys[id]] = Number(step);
        delays[keys[id]] = vtDelay ? vtDelay[1] : 'D30';
      }
    }
  }
  return { keys, selectors, steps, delays };
}

describe('the governance side of the parameter set (design §6.1 - §6.4)', () => {
  /* ---------------------------------------------------------------- */
  describe('keys', () => {
    test('every field is reachable by keccak256 of its name, and reads what params() reads', async () => {
      // The keys are hash literals in the contract: one wrong byte would make a
      // field ungovernable or, worse, let one name write another's field.
      const ctx = await deployStack({ assets: [], rows: ZERO_ROWS });
      for (const [name, value] of PARAM_FIELDS) {
        if (PHASE_ROW_FIELDS.includes(name)) continue;
        assert.equal(await ctx.params.call('paramOf', [keccak256(toUtf8Bytes(name))]), BigInt(value), name);
      }
      // The per-phase fields by their cells, each reading its reference row (item 129).
      for (const [i, field] of PHASE_ROW_FIELDS.entries()) {
        for (const p of PHASES) {
          const name = `${field}@${p}`;
          assert.equal(await ctx.params.call('paramOf', [keccak256(toUtf8Bytes(name))]), BigInt(REFERENCE_ROWS[p][i]), name);
        }
      }
    });

    test('a per-phase field has no flat key: the three flat names are refused, as is a sixth phase (item 129)', async () => {
      const ctx = await deployStack({ assets: [] });
      for (const name of [...PHASE_ROW_FIELDS, 'cushionTargetBps@5', 'admittedTermsMask@', 'cushionCeilingBps@01']) {
        const r = await rejection(diff(ctx, [[name, 0, 1]]));
        assert.match(r.name, /UnknownParameter/, name);
        assert.equal(r.args.key, paramKey(name));
        await assert.rejects(() => ctx.params.call('paramOf', [paramKey(name)]), /UnknownParameter/, name);
      }
    });

    test('an unknown key is refused, never ignored', async () => {
      const ctx = await deployStack({ assets: [] });
      for (const name of ['noSuchField', 'ThreatStage1Bps', 'admittedTermsmask']) {
        const r = await rejection(diff(ctx, [[name, 0, 1]]));
        assert.match(r.name, /UnknownParameter/, name);
        assert.equal(r.args.key, paramKey(name));
      }
      await assert.rejects(() => ctx.params.call('paramOf', [paramKey('noSuchField')]), /UnknownParameter/);
    });

    test('a diff moves a key once, is not empty, and cannot smuggle a value past the field width', async () => {
      const ctx = await deployStack({ assets: [] });
      await assert.rejects(() => diff(ctx, [['fxWindowDays', 90, 60], ['fxWindowDays', 60, 30]]), /DuplicateParameter/);
      await assert.rejects(() => diff(ctx, []), /EmptyDiff/);
      // 65,536 + 2,000 truncated to sixteen bits is 2,000, inside every check:
      // refused before the truncation could happen.
      await assert.rejects(() => diff(ctx, [['threatStage1Bps', 1850, 65536 + 2000]]), /ParameterValueTooLarge/);
      // The claim cost is thirty-two bits wide (2026-09-30): a value above
      // sixteen bits is written whole, and one above thirty-two is refused
      // before the narrowing, as above.
      await assert.rejects(() => diff(ctx, [['claimCostGwei', 600000, 2n ** 32n + 600000n]]), /ParameterValueTooLarge/);
      await diff(ctx, [['claimCostGwei', 600000, 3100000]]);
      assert.equal(await ctx.params.call('paramOf', [paramKey('claimCostGwei')]), 3100000n);
      await assert.rejects(() => diff(ctx, [['offeringBatchMultiple', 50, 65536 + 50]]), /ParameterValueTooLarge/);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('compare-and-swap (design §6.2)', () => {
    test('of two diffs written against the same value, the second is refused as stale', async () => {
      // Both proposals were drafted at 7,000; the first executes, and the second
      // would otherwise overwrite it without anyone having voted on the result.
      const ctx = await deployStack({ assets: [] });
      await diff(ctx, [['juniorThicknessBps', 7000, 6500]]);
      const r = await rejection(diff(ctx, [['juniorThicknessBps', 7000, 7500]]));
      assert.match(r.name, /StaleParameter/);
      assert.equal(r.args.expected, 7000n);
      assert.equal(r.args.current, 6500n, 'compared with the value staged, not only the value in force');
      // Still stale once the first is in force.
      toNextEpoch(ctx);
      await assert.rejects(() => diff(ctx, [['juniorThicknessBps', 7000, 7500]]), /StaleParameter/);
      await diff(ctx, [['juniorThicknessBps', 6500, 7500]]);
    });

    test('two diffs of different keys in one epoch both land; neither undoes the other', async () => {
      // The failure of the whole-set setter: the second proposal carried the
      // first key's old value and restored it.
      const ctx = await deployStack({ assets: [] });
      await diff(ctx, [['tailPremiumFloorBps', 200, 300]]);
      await diff(ctx, [['seniorCouponBps', 100, 225]]);
      toNextEpoch(ctx);
      assert.equal(await inForce(ctx, 'tailPremiumFloorBps'), 300n);
      assert.equal(await inForce(ctx, 'seniorCouponBps'), 225n);
    });

    test('a refused diff changes nothing, and one bad change refuses the whole diff', async () => {
      const ctx = await deployStack({ assets: [] });
      await assert.rejects(() => diff(ctx, [['fxWindowDays', 90, 60], ['operationsBps', 999, 300]]), /StaleParameter/);
      const [, pendingEpoch] = await ctx.params.call('pendingParams');
      assert.equal(pendingEpoch, 0n, 'nothing staged');
      assert.equal(await ctx.params.call('paramOf', [paramKey('fxWindowDays')]), 90n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('G1 — no vote executes a value outside a range or a relation; checked on the whole draft', () => {
    test('a diff of one key is refused where it breaks a relation with a key it does not touch', async () => {
      // Relation 8 joins D_0 to the severity floor (whitepaper §6.3): D_0 at
      // 5,500 is below the 6,000 floor the diff does not name. (Relation 9's
      // case, the run-off bound at 1,600, is a step past a quarter of the range
      // since the bound became a value-transfer key on 2026-09-30.)
      const ctx = await deployStack({ assets: [] });
      const r = await rejection(diff(ctx, [['trigger2FloorBps', 6000, 5500]]));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.relation, 'D0 >= severity floor');
      // The same move with its relation restored in the same diff executes.
      await diff(ctx, [['trigger2FloorBps', 6000, 5500], ['severityFloorBps', 6000, 5500]]);
    });

    test('the draft is the latest staged set, so a diff is checked against what will be in force with it', async () => {
      // Two diffs in one epoch: the first raises D_0, the second the severity
      // floor under it. A third lowering D_0 back is checked against the staged
      // floor, not the one in force, and is refused (relation 8). The slope's
      // relation to the first rung (I13) was this case until 2026-09-30; a
      // ratio of the rung holds it at every stage by construction (EC-07).
      const ctx = await deployStack({ assets: [] });
      await diff(ctx, [['trigger2FloorBps', 6000, 7000]]);
      await diff(ctx, [['severityFloorBps', 6000, 6750]]);
      const r = await rejection(diff(ctx, [['trigger2FloorBps', 7000, 6500]]));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.relation, 'D0 >= severity floor');
    });

    test('a vote outside a range is refused on the diff path as at construction', async () => {
      const ctx = await deployStack({ assets: [] });
      // Inside the step, outside the range (every value-transfer key moves at most a quarter first).
      await assert.rejects(() => diff(ctx, [['operationsBps', 250, 249]]), /ParameterOutOfRange/);
      await assert.rejects(() => diff(ctx, [['fxWindowDays', 90, 29]]), /ParameterOutOfRange/);
      await assert.rejects(() => diff(ctx, [['successorLimit', 3, 4]]), /ParameterOutOfRange/);
      await assert.rejects(() => diff(ctx, [['indemnityBps', 10000, 10001]]), /ParameterOutOfRange/, 'inside the step, outside the range');
      await assert.rejects(() => diff(ctx, [['appealDays', 2, 3]]), /RelationViolated/, 'the court cycle reaches the unbonding period');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the quarter-range step on value-transfer keys (design §6.9, D7)', () => {
    // [key, companions that keep the other relations satisfied at the moved value]
    // Every one of the thirty-nine, in a direction its relations admit a
    // whole step in from the reference values.
    const cases = [
      ['threatStage1Bps', 'up', {}],
      ['threatStage2Bps', 'down', {}],
      ['threatStage3Bps', 'up', {}],
      ['threatStage4Bps', 'down', {}],
      ['indemnityBps', 'down', {}],
      ['pmlFloorBps', 'up', {}],
      ['juniorThicknessBps', 'both', {}],
      ['seniorCouponBps', 'up', { tailPremiumFloorBps: 300 }],
      ['trigger2FloorBps', 'up', {}],
      ['severityFloorBps', 'down', {}],
      ['verdictCoverBps', 'both', {}],
      ['premiumSlopeRatioBps', 'both', {}],
      ['premiumCeilingBps', 'down', {}],
      ['surgeCeilingBps', 'down', { premiumCeilingBps: 5500 }],
      ['stabilizationLevyBps', 'up', {}],
      ['commitmentTermEpochs', 'both', {}],
      ['psrCapEpochs', 'both', {}],
      ['tailPremiumFloorBps', 'up', {}],
      ['maxEpochMoveBps', 'up', {}],
      ['firstReserveDiscountBps', 'both', {}],
      ['reserveStepBps', 'up', {}],
      ['reserveFloorBps', 'down', {}],
      ['clearingFloorBps', 'both', {}],
      ['solverBondCeilingBps', 'both', {}],
      ['solverBondFloorBps', 'both', {}],
      ['operationsBps', 'up', {}],
      ['jurorFeeShareBps', 'both', {}],
      ['queueDecayBps', 'both', {}],
      ['queueExposureFloorBps', 'up', {}],
      ['runoffTriggerBps', 'both', {}],
      ['runoffBoundBps', 'both', {}],
      ['assessmentWindowEpochs', 'both', {}],
      ['fxHaircutMaxBps', 'down', {}],
      ['unsoldEpochs', 'up', {}],
      ['bufferBps', 'up', {}],
      ['bufferEscalatorCapBps', 'down', {}],
      ['bufferRampThresholdBps', 'both', {}],
      ['offeringBatchMultiple', 'both', {}],
      ['claimCostGwei', 'up', {}],
      // From 500, a step down would leave the range: up only. The ceiling both ways.
      ['cushionTargetBps', 'up', {}],
      ['cushionCeilingBps', 'both', {}],
    ];
    test('the cases cover every value-transfer key of the model (VALUE_TRANSFER_KEYS), and the steps are its quarters', async (t) => {
      const M = await loadModel();
      if (!M) return t.skip(MISSING);
      const model = M.gov.VALUE_TRANSFER_KEYS;
      assert.equal(model.length, 41);
      assert.deepEqual(model.map((k) => k.key).sort(), Object.keys(STEPS).sort());
      assert.deepEqual(cases.map(([k]) => k).sort(), Object.keys(STEPS).sort());
      for (const { key, lo, hi } of model) {
        assert.deepEqual(RANGES[key], [lo, hi], key);
        assert.equal(STEPS[key], M.gov.stepBound(lo, hi), key);
        assert.equal(M.config.ARK_STAKING_GOVERNANCE.timelockDays[key], M.gov.VALUE_TRANSFER_DELAY_DAYS, `${key} waits thirty days`);
      }
    });
    for (const [key, dir, companions] of cases) {
      const cells = PHASE_ROW_FIELDS.includes(key) ? ', in the cell of every phase' : '';
      test(`${key} moves at most ${STEPS[key]} per change (${dir})${cells}`, async () => {
        const ctx = await deployStack({ assets: [] });
        const from = BigInt(REFERENCE_PARAMS[key]);
        const step = BigInt(STEPS[key]);
        // A per-phase field by each of its cells (item 129); the fixture's rows are flat.
        for (const k of keysOf(key)) {
          for (const sign of dir === 'both' ? [1n, -1n] : [dir === 'up' ? 1n : -1n]) {
            const r = await rejection(voteParams(ctx.params, { ...companions, [k]: from + sign * (step + 1n) }));
            assert.match(r.name, /ParameterStepTooLarge/, `${k} ${sign > 0 ? '+' : '-'}${step + 1n}`);
            assert.equal(r.args.maxStep, step);
            assert.equal(r.args.current, from);
            assert.equal(r.args.key, paramKey(k));
            // Exactly the step executes, and the next step is measured from there.
            await voteParams(ctx.params, { ...companions, [k]: from + sign * step });
            await voteParams(ctx.params, { [k]: from });
          }
        }
      });
    }

    test('a key that transfers no value between the legs moves its whole range in one change', async () => {
      const ctx = await deployStack({ assets: [] });
      await voteParams(ctx.params, { fxWindowDays: 180 });
      await voteParams(ctx.params, { fxWindowDays: 30 });
      // Thirty days in the table, but no step: not a value-transfer key.
      await voteParams(ctx.params, { rewardRateCapBps: 2000 });
      await voteParams(ctx.params, { rewardRateCapBps: 500 });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('G8 — parameters change only at an epoch boundary, and nothing fixed moves', () => {
    test('a diff is not in force before the boundary, is at it, and every view agrees', async () => {
      const ctx = await deployStack({ assets: [] });
      const e = epochNow(ctx);
      const res = await voteParams(ctx.params, { threatStage1Bps: 2300, juniorThicknessBps: 6500 });
      const evs = ctx.params.events(res, 'ParamChangeStaged');
      assert.equal(evs.length, 2);
      for (const ev of evs) assert.equal(ev.args.effectiveEpoch, e + 1n, 'the first epoch that starts after execution');

      const [staged, effective] = await ctx.params.call('pendingParams');
      assert.equal(effective, e + 1n);
      assert.equal(staged.threatStage1Bps, 2300n);
      assert.equal(await ctx.params.call('paramOf', [paramKey('threatStage1Bps')]), 2300n, 'the value a next diff must expect');

      // Up to the last second of the epoch nothing reads the new values.
      const next = (BigInt(ctx.chain.timestamp) / BigInt(EPOCH) + 1n) * BigInt(EPOCH);
      ctx.chain.advanceTime(Number(next - BigInt(ctx.chain.timestamp) - 1n));
      assert.equal(await inForce(ctx, 'threatStage1Bps'), 1850n);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 1850n);
      assert.equal(await ctx.registry.call('sigmaTargetBps'), 1850n);
      assert.equal((await ctx.params.call('bondParams'))[3], 7000n);

      // At the boundary, in every view at once, with no transaction in between.
      ctx.chain.advanceTime(1);
      assert.equal(await inForce(ctx, 'threatStage1Bps'), 2300n);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 2300n);
      assert.equal(await ctx.registry.call('sigmaTargetBps'), 2300n);
      assert.equal((await ctx.params.call('bondParams'))[3], 6500n);
      const [, after] = await ctx.params.call('pendingParams');
      assert.equal(after, 0n, 'nothing waiting');
    });

    test('an epoch already priced keeps its figures: the allocation of the epoch of the vote is unchanged', async () => {
      // The leaf the escrow sweeps an epoch by is read from the set in force
      // during that epoch (whitepaper §4.2). A vote inside the epoch must not
      // reprice it.
      const ctx = await deployStack();
      const read = async () => [...(await ctx.registry.call('allocation'))].map(String);
      const before = await read();
      await voteParams(ctx.params, { bufferBps: 500, operationsBps: 300 });
      assert.deepEqual(await read(), before);
      toNextEpoch(ctx);
      assert.notDeepEqual(await read(), before);
    });

    test('the escalator reads its cap from the set in force (whitepaper §4.2)', async () => {
      const ctx = await deployStack();
      await ctx.oracle.send('setDrawdown', [BigInt(90 * 24 * 3600), 2500n]);
      assert.equal(await ctx.registry.call('bufferShareInForceBps'), 1500n, 'at the haircut cap, the escalator cap');
      await voteParams(ctx.params, { bufferEscalatorCapBps: 1200 });
      assert.equal(await ctx.registry.call('bufferShareInForceBps'), 1500n);
      toNextEpoch(ctx);
      assert.equal(await ctx.registry.call('bufferShareInForceBps'), 1200n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('G9 — the stage moves one step per vote, once per epoch, and not around the rule', () => {
    test('one step of the band, from the stage named, in force from the next epoch; a second vote in the epoch is refused', async () => {
      // The stage is the phase's since 2026-10-07 (item 129); the vote moves
      // the band of phase 2 under the rules it had.
      const ctx = await deployStack({ assets: [] });
      const ph = ctx.params.phase;
      await ph.send('setPending', [2, epochNow(ctx) + 1n], { from: ph.operatorAccount });
      toNextEpoch(ctx);
      const e = epochNow(ctx);
      const res = await ctx.params.send('setThreatStage', [2, 3], { from: ACCOUNTS.admin });
      const [ev] = ctx.params.events(res, 'ThreatStageSet');
      assert.equal(ev.args.effectiveEpoch, e + 1n);
      assert.equal(await ctx.params.call('lastStageEpoch'), e);
      assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [3n, e + 1n]);
      assert.equal(await ctx.params.call('threatStage'), 2n);
      await assert.rejects(() => ctx.params.send('setThreatStage', [2, 3], { from: ACCOUNTS.admin }), /ThreatStageAlreadyStepped/);
      await assert.rejects(() => ctx.params.send('setThreatStage', [3, 2], { from: ACCOUNTS.admin }), /ThreatStageAlreadyStepped/);
      toNextEpoch(ctx);
      assert.equal(await ctx.params.call('threatStage'), 3n);
      assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [0n, 0n]);
      await assert.rejects(() => ctx.params.send('setThreatStage', [2, 3], { from: ACCOUNTS.admin }), /ThreatStageMismatch/, 'wrong from');
      await assert.rejects(() => ctx.params.send('setThreatStage', [3, 4], { from: ACCOUNTS.admin }), /ThreatStageStep/);
    });

    test('the ladder cannot be walked around the stage rule: a rung moves at most a quarter of its range', async () => {
      // Design §6.2's second defect of the whole-set setter: a fourteen-day
      // proposal lifting the first rung to the fourth stage's price repriced the
      // book as three stage votes would. D5 puts the rungs on the stage's delay
      // (the timelock's); D7 bounds each move here.
      const ctx = await deployStack({ assets: [] });
      const r = await rejection(voteParams(ctx.params, {
        threatStage1Bps: 3700, threatStage2Bps: 3800, threatStage3Bps: 3900, threatStage4Bps: 4000,
      }));
      assert.match(r.name, /ParameterStepTooLarge/);
      assert.equal(r.args.key, paramKey('threatStage1Bps'));
    });
  });

  /* ---------------------------------------------------------------- */
  describe('G2 — every governance setter is one the timelock can schedule, and there is no other way in', { skip: coreAbsent }, () => {
    const GOVERNED = {
      // `admitSuccessor` since phase C3 (whitepaper §5.4, §6.3): core's
      // table carried its signature before this tree had the function.
      ArkStakeParams: ['setParamsDiff((bytes32,uint256,uint256)[])', 'setThreatStage(uint8,uint8)', 'proposeGovernance(address)', 'acceptGovernance()', 'admitSuccessor(uint256,bytes32)'],
      // `requestSeedReturn` since the re-audit of 2026-09-30 (ORIGIN-01): 48 hours, voted with the de-listing.
      ArkStakeRegistry: ['admitAsset((uint256,address,bytes32,address,uint16,uint16,bool,bool,bool))', 'delistAsset(bytes32)', 'requestSeedReturn(uint256,address)', 'proposeGovernance(address)', 'acceptGovernance()'],
      ArkBondDelegation: ['admitValidator(bytes,bytes32,bytes32,address)', 'commitExit(bytes32,bytes32)', 'withdrawAdmission(bytes32)', 'proposeGovernance(address)', 'acceptGovernance()'],
    };

    test("each governance-gated function's signature is in core's compiled table", () => {
      const { selectors } = coreTables();
      const known = new Set(Object.values(selectors));
      for (const [name, sigs] of Object.entries(GOVERNED)) {
        const abi = new Interface(artifact(name).abi);
        for (const sig of sigs) {
          assert.ok(abi.getFunction(sig), `${name} has ${sig}`);
          assert.ok(known.has(sig), `${name}.${sig} is not in ArkGovTables: the timelock could never execute it`);
        }
      }
    });

    test('the list above is every governance gate in the three sources', () => {
      // A new `onlyGovernance` setter must reach this list, and so the timelock's
      // table, before it can pass this test.
      for (const [name, sigs] of Object.entries(GOVERNED)) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', `${name}.hyp`), 'utf8');
        const gated = new Set();
        for (const [, fn, rest] of src.matchAll(/function (\w+)\(([\s\S]*?)\{/g)) {
          if (/onlyGovernance/.test(rest)) gated.add(fn);
        }
        // The one gate written as "its operator or governance" rather than a modifier.
        if (/msg\.sender != \w+ && msg\.sender != governance\)/.test(src)) gated.add('withdrawAdmission');
        const listed = new Set(sigs.map((s) => s.slice(0, s.indexOf('('))).filter((f) => f !== 'acceptGovernance'));
        assert.deepEqual([...gated].sort(), [...listed].sort(), name);
      }
    });

    test('the parameter set has no state-changing entry beyond the governed ones and its one-shot wiring', () => {
      const writes = iface.fragments
        .filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))
        .map((f) => f.format('sighash'))
        .sort();
      assert.deepEqual(writes, [...GOVERNED.ArkStakeParams, 'setRegistry(address)'].sort());
    });

    test('every Params field is a key of the table with the same name, and the steps agree', () => {
      const { keys, steps } = coreTables();
      const coreNames = new Set(Object.values(keys));
      // Since 2026-10-07 (item 129) a per-phase field is five keys, one per cell.
      const fields = PARAM_FIELDS.flatMap(([k]) => keysOf(k));
      for (const f of fields) assert.ok(coreNames.has(f), `${f} is a key of the set the timelock cannot schedule`);
      for (const [k, s] of Object.entries(STEPS)) for (const c of keysOf(k)) assert.equal(steps[c], s, `step of ${c}`);
      for (const f of fields) if (!(f.replace(/@\d$/, '') in STEPS)) assert.equal(steps[f], 0, `${f} carries a step in core but not here`);
      // Keys core schedules that no field carries: none since phase C3, which
      // made `admittedTermsMask` a field (whitepaper §6.3, yellow paper §4.5).
      // Any name appearing here is drift, and fails.
      const extra = [...coreNames].filter((n) => !fields.includes(n)).sort();
      assert.deepEqual(extra, []);
    });

    test("every key's timelock in core's table is the one its whitepaper §6.3 row states (B9)", async (t) => {
      // The rows' timelocks live in the site's registry since 2026-09-29
      // (`ARK_STAKING_GOVERNANCE`, carried by the JSON export); core's table is
      // the implementation. The default is the caption's fourteen days.
      const M = await loadModel();
      if (!M) return t.skip(MISSING);
      const G = M.config.ARK_STAKING_GOVERNANCE;
      const src = fs.readFileSync(TABLES, 'utf8');
      const unit = { hours: 1 / 24, days: 1 };
      const constDays = {};
      for (const [, id, n, u] of src.matchAll(/uint64 internal constant (\w+) = (\d+) (hours|days);/g)) constDays[id] = Number(n) * unit[u];
      const { delays } = coreTables();
      // A per-phase field's cells each wait as the field's row states (item 129).
      for (const f of PARAM_FIELDS.map(([k]) => k)) {
        const expected = G.timelockDays[f] ?? G.timelockDefaultDays;
        for (const c of keysOf(f)) assert.equal(constDays[delays[c]], expected, `${c}: core ${delays[c]}, whitepaper §6.3 ${expected} days`);
      }
      // Every override the registry states names a governed field.
      for (const k of Object.keys(G.timelockDays)) assert.ok(keysOf(k).every((c) => c in delays), `${k} has a timelock but is not a key of the table`);
      // The stage vote and the admission procedure (the opening of §6.3).
      const body = src.slice(src.indexOf('function delayOfSelector'), src.indexOf('function ruleOfKey'));
      const bySelector = {};
      for (const [, cond, ret] of body.matchAll(/if\s*\(([^)]*)\)\s*\{?\s*return (\w+);/g)) {
        for (const [, id] of cond.matchAll(/s == (\w+)/g)) bySelector[id] = ret;
      }
      const selectorDelay = (name) => constDays[bySelector[name]];
      assert.equal(selectorDelay('SET_THREAT_STAGE'), G.threatStageTimelockDays);
      assert.equal(selectorDelay('ADMIT_ASSET') * 24, G.admissionTimelockHours);
      const governor = fs.readFileSync(path.join(CORE, 'contracts', 'ArkGovernor.hyp'), 'utf8');
      assert.equal(Number(/AUDIT_PERIOD = (\d+) days/.exec(governor)[1]), G.admissionAuditDays);
      assert.equal(Number(/VOTING_PERIOD = (\d+) days/.exec(governor)[1]), G.admissionVoteDays);
    });

    test("the payload interface is core's, word for word", () => {
      const strip = (s) => s.slice(s.indexOf('interface IArkStakeGovernable')).replace(/\s+/g, ' ').trim();
      const ours = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'interfaces', 'IArkStakeGovernable.hyp'), 'utf8');
      const theirs = fs.readFileSync(path.join(CORE, 'contracts', 'interfaces', 'IArkStakeGovernable.hyp'), 'utf8');
      assert.equal(strip(ours), strip(theirs));
    });
  });

  /* ---------------------------------------------------------------- */
  describe("QL-25 — a stage step queued in core's timelock sets the allocation's stepQueued", () => {
    const { coreBuild, deployCore } = require('./core-build');
    const noTimelock = !coreBuild('ArkTimelock') && 'contracts/core build/ArkTimelock.json is absent (run npm run check in contracts/core)';

    test('from the scheduling of the step, through its staging, to the boundary it takes effect at', { skip: noTimelock }, async () => {
      const ctx = await deployStack({ assets: [] });
      const DAY = 24 * 3600;
      const stepQueued = async () => (await ctx.registry.call('allocation')).stepQueued;
      // Governance an account: no timelock to read, and the allocation still reads.
      assert.equal(await stepQueued(), false);

      const tl = await deployCore(ctx.chain, 'ArkTimelock', ['address', 'address'], [ACCOUNTS.admin, ACCOUNTS.guardian]);
      await ctx.params.send('proposeGovernance', [tl.address], { from: ACCOUNTS.admin });
      const scheduleOp = async (data) => {
        const res = await tl.send('schedule', [ctx.params.address, data]);
        const log = res.logs.map((l) => { try { return tl.iface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === 'Scheduled');
        return log.args.opId;
      };
      const accept = await scheduleOp(iface.encodeFunctionData('acceptGovernance'));
      ctx.chain.advanceTime(2 * DAY + 1);
      await tl.send('execute', [accept]);
      assert.equal((await ctx.params.call('governance')).toLowerCase(), tl.address.toLowerCase());
      assert.equal(await stepQueued(), false, 'a timelock with nothing queued');

      // A rung diff is not a stage step.
      await scheduleOp(iface.encodeFunctionData('setParamsDiff', [[[paramKey('threatStage1Bps'), 1850n, 1900n]]]));
      assert.equal(await stepQueued(), false);

      // The band vote of phase 2 (item 129): the phase moved first, here by the double.
      const ph = ctx.params.phase;
      await ph.send('setPending', [2, epochNow(ctx) + 1n], { from: ph.operatorAccount });
      assert.equal(await stepQueued(), true, 'a phase step that changes the stage is a stage step on its way');
      assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [2n, epochNow(ctx) + 1n]);
      toNextEpoch(ctx);
      assert.equal(await stepQueued(), false, 'phase 2 in force: nothing queued');

      const step = await scheduleOp(iface.encodeFunctionData('setThreatStage', [2, 3]));
      assert.equal(await stepQueued(), true, 'queued in the timelock: the thirty days are covered');
      assert.equal(await ctx.params.call('stageStepQueued'), true);
      assert.deepEqual([...(await ctx.params.call('pendingThreatStage'))], [0n, 0n], 'nothing staged yet');
      ctx.chain.advanceTime(30 * DAY + 1);
      await tl.send('execute', [step]);
      assert.equal(await stepQueued(), true, 'executed and staged for the next boundary');
      toNextEpoch(ctx);
      assert.equal(await ctx.params.call('threatStage'), 3n);
      assert.equal(await stepQueued(), false, 'in force: nothing queued');

      const again = await scheduleOp(iface.encodeFunctionData('setThreatStage', [3, 2]));
      assert.equal(await stepQueued(), true);
      await tl.send('cancel', [again], { from: ACCOUNTS.guardian });
      assert.equal(await stepQueued(), false, 'cancelled by the guardian');
    });
  });
});
