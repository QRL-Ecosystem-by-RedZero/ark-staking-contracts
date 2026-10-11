/**
 * ArkStakeParams: the governable parameters of whitepaper section 6.3, their
 * ranges, the relations that bind them jointly, and the threat stage.
 *
 * The one rule this file exists to defend: **a vote outside a range, or a pair
 * outside a relation, does not execute** — so control of the governance
 * process does not confer control of the arithmetic. Each relation is tested at
 * its boundary from both sides, because a relation checked one basis point off
 * is a relation that admits the value it exists to refuse.
 *
 * Since 2026-09-28 (phase C1b) a whole set is written once, at construction,
 * and every later change is a keyed diff in force from the next epoch. The
 * ranges and relations are one piece of code on both paths, so the boundaries
 * are walked here through the constructor, where one call states one set;
 * `test/ArkStakeGovernance.test.js` holds the diff path to the same checks and
 * tests what is particular to it (compare-and-swap, the step bound, the epoch
 * boundary).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { Chain, artifact } = require('./harness');
const {
  ACCOUNTS,
  EPOCH,
  ONE,
  ASSET_A,
  ASSET_B,
  GROUP_A,
  GROUP_B,
  REFERENCE_PARAMS,
  PARAM_FIELDS,
  withParams,
  assetInput,
  deployStack,
  deployParams,
  voteParams,
  enactParams,
  toNextEpoch,
  epochNow,
} = require('./stake-fixture');

const iface = new Interface(artifact('ArkStakeParams').abi);

/** The decoded arguments of a custom error, so a test can read the bound it broke. */
async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return { name: e.message, args: e.data ? iface.parseError(e.data)?.args : undefined };
  }
  throw new Error('expected a revert');
}

/**
 * One chain for a test's constructions: `set(overrides)` deploys a parameter
 * set launched on the reference values with `overrides`, and rejects exactly
 * where the constructor's checks refuse it.
 */
async function constructions() {
  const chain = await Chain.create();
  return (overrides) => deployParams(chain, { params: overrides });
}

const stage = (ctx, from, to, sender = ACCOUNTS.admin) => ctx.params.send('setThreatStage', [from, to], { from: sender });

/** Put phase `p` in force from the next boundary, as core's ArkPhase does, and cross it (item 129). */
async function toPhase(ctx, p) {
  const ph = ctx.params.phase;
  await ph.send('setPending', [p, epochNow(ctx) + 1n], { from: ph.operatorAccount });
  toNextEpoch(ctx);
}

describe('ArkStakeParams', () => {
  describe('the reference values of chapter 6', () => {
    test('are deployed as the set of record and pass their own checks', async () => {
      const ctx = await deployStack({ assets: [] });
      const p = await ctx.params.call('params');
      for (const [k, v] of Object.entries(REFERENCE_PARAMS)) assert.equal(Number(p[k]), v, k);
      // The same fifty-six values passed explicitly construct the same set
      // (fifty-two until the four fields of 2026-09-30).
      const set = await constructions();
      const explicit = await set({});
      const q = await explicit.call('params');
      for (const [k] of PARAM_FIELDS) assert.equal(q[k], p[k], k);
      assert.equal(PARAM_FIELDS.length, 58);
    });

    test('the registry and the swap read narrow views that are the set of record, field for field, and follow a vote', async () => {
      // The registry and the swap decode these and never params(): the decoder
      // of every field was more than the registry's v3 room (2026-09-30). A
      // narrow view that drifted from the set would price on figures
      // governance never set, so each is held to the full struct.
      const ctx = await deployStack({ assets: [] });
      const check = async () => {
        const p = await ctx.params.call('params');
        for (const view of ['registryParams', 'swapParams']) {
          const narrow = await ctx.params.call(view);
          const names = iface.getFunction(view).outputs[0].components.map((c) => c.name);
          assert.ok(names.length >= 13, view);
          for (const k of names) assert.equal(narrow[k], p[k], `${view}.${k}`);
        }
      };
      await check();
      await voteParams(ctx.params, { premiumSlopeRatioBps: 6000, firstReserveDiscountBps: 450, claimCostGwei: 700000, bufferRampThresholdBps: 1200 });
      toNextEpoch(ctx);
      await check();
    });

    test('the launch set is checked like any other: a construction outside a range does not deploy', async () => {
      const set = await constructions();
      await assert.rejects(() => set({ premiumSlopeRatioBps: 2499 }), /ParameterOutOfRange/);
      await assert.rejects(() => set({ successorLimit: 4 }), /ParameterOutOfRange/);
    });

    test("the bond's narrow view reads the same eight figures as the set of record, and follows a vote", async () => {
      // `bondParams` exists so the bond need not decode fifty-eight fields to read
      // eight. A narrow view that drifted from the set of record would price the
      // bond on figures governance never set, so it is held to the full struct.
      // The Cushion's target and ceiling are the last two (2026-10-06).
      const ctx = await deployStack({ assets: [] });
      const fields = ['maturityLadderBps', 'runoffTriggerBps', 'runoffBoundBps',
        'juniorThicknessBps', 'seniorCouponBps', 'tailPremiumFloorBps', 'cushionTargetBps', 'cushionCeilingBps'];
      const check = async () => {
        const p = await ctx.params.call('params');
        const narrow = await ctx.params.call('bondParams');
        fields.forEach((k, i) => assert.equal(narrow[i], p[k], k));
      };
      await check();
      await voteParams(ctx.params, { juniorThicknessBps: 6000, seniorCouponBps: 150 });
      await check();
      assert.equal((await ctx.params.call('bondParams'))[3], 7000n, 'staged, not yet in force');
      toNextEpoch(ctx);
      await check();
      assert.equal((await ctx.params.call('bondParams'))[3], 6000n);
    });

    test('the product launches at the first stage of the threat ladder', async () => {
      const ctx = await deployStack({ assets: [] });
      assert.equal(await ctx.params.call('threatStage'), 1n);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 1850n);
      assert.equal(await ctx.params.call('lastStageEpoch'), 0n);
    });
  });

  describe('every parameter has a range fixed in code', () => {
    // [field, below the range, above the range]
    const ranges = [
      ['threatStage1Bps', 1849, null],
      ['indemnityBps', 4999, 10001],
      ['pmlFloorBps', 1499, 5001],
      ['bufferBps', 249, 1501],
      ['operationsBps', 249, 1001],
      ['jurorFeeShareBps', null, 5001],
      ['tailPremiumFloorBps', 99, 501],
      ['maxEpochMoveBps', 1499, 3001],
      ['fxHaircutMaxBps', null, 3001],
      ['fxWindowDays', 29, 181],
      ['releaseBoundBps', 0, 2501],
      ['runoffTriggerBps', 1499, 5001],
      ['runoffBoundBps', 1499, 2501],
      ['juniorThicknessBps', 4999, 9001],
      ['reserveStepBps', 249, 1001],
      ['reserveFloorBps', 2499, 6001],
      ['clearingFloorBps', 2499, 7501],
      ['validatorConcentrationBps', 0, 1001],
      ['exitDeadlineEpochs', 0, 5],
      ['operatorBondBps', 499, 2501],
      ['rewardRateCapBps', 499, 2001],
      // The 2026-09-26 remediation and the 2026-09-27 triage (whitepaper §6.3).
      ['stabilizationLevyBps', 99, 501],
      ['commitmentTermEpochs', 3, 27],
      ['psrCapEpochs', 1, 13],
      ['severityFloorBps', 4999, 8001],
      ['assessmentWindowEpochs', 1, 7],
      ['queueDecayBps', 999, 2001],
      ['queueExposureFloorBps', 1999, 5001],
      ['jurorSlashBps', 499, 3001],
      ['verdictCoverBps', 3332, 8001],
      // The keys of the timelock's table added 2026-09-28 (phase C1b).
      ['bufferEscalatorCapBps', 249, 1501],
      ['solverBondCeilingBps', 499, 1501],
      ['solverBondFloorBps', 99, 301],
      ['successorLimit', 0, 4],
      ['challengeWindowDays', 0, null],
      ['evidenceDays', 0, null],
      ['commitDays', 0, null],
      ['revealDays', 0, null],
      ['appealDays', 0, null],
    ];
    for (const [field, below, above] of ranges) {
      test(`${field} outside its range does not execute`, async () => {
        const set = await constructions();
        for (const bad of [below, above]) {
          if (bad === null) continue;
          await assert.rejects(() => set({ [field]: bad }), /ParameterOutOfRange|RelationViolated/, `${field} ${bad}`);
        }
      });
    }

    test('the threat ladder is strictly ascending and tops out at 4,000', async () => {
      const set = await constructions();
      await assert.rejects(() => set({ threatStage2Bps: 1850 }), /ParameterOutOfRange/, 'two stages at one value');
      await assert.rejects(() => set({ threatStage3Bps: 2400 }), /ParameterOutOfRange/, 'a descending pair');
      await assert.rejects(() => set({ threatStage4Bps: 4001 }), /ParameterOutOfRange/);
      await set({ threatStage4Bps: 4000 });
    });

    test('only governance may vote a change, and no whole-set setter exists', async () => {
      const ctx = await deployStack({ assets: [] });
      await assert.rejects(() => voteParams(ctx.params, { fxWindowDays: 60 }, { from: ACCOUNTS.mallory }), /OnlyGovernance/);
      // A whole-set write lets a proposal queued behind another restore every key
      // the first changed (design §6.2); it survives only as the constructor.
      assert.ok(!iface.fragments.some((f) => f.type === 'function' && f.name === 'setParams'), 'setParams is gone');
      assert.ok(!iface.fragments.some((f) => f.type === 'function' && f.format('sighash') === 'setThreatStage(uint8)'),
        'the one-argument stage setter is gone');
    });
  });

  describe('the relations of section 6.3 are checked where either term is written', () => {
    test('I13 — the slope is a ratio of the stage in force, 2,500 - 10,000, never above the target share at any stage (EC-07)', async () => {
      // alpha_t = floor(sigma_t * rho / BPS): a ratio at or below BPS is I13 at
      // every stage at once, so the relation to the first rung is gone and the
      // range is the whole of the check.
      const set = await constructions();
      await set({ premiumSlopeRatioBps: 2500 });
      await set({ premiumSlopeRatioBps: 10000, threatStage1Bps: 1850 });
      const r = await rejection(set({ premiumSlopeRatioBps: 10001 }));
      assert.match(r.name, /ParameterOutOfRange/);
      assert.equal(r.args.name, 'premiumSlopeRatioBps');
      await assert.rejects(() => set({ premiumSlopeRatioBps: 2499 }), /ParameterOutOfRange/, 'a slope below a quarter of the target prices scarcity too cheaply');
      await assert.rejects(() => set({ premiumSlopeRatioBps: 0 }), /ParameterOutOfRange/, 'a slope of zero prices no scarcity');
    });

    test('the fields of 2026-09-30 are held to their ranges: d_first, batching, the claim cost, the ramp threshold', async () => {
      const set = await constructions();
      for (const [k, lo, hi] of [
        ['firstReserveDiscountBps', 300, 500],
        ['offeringBatchMultiple', 0, 100],
        ['claimCostGwei', 0, 10000000],
        ['bufferRampThresholdBps', 500, 2000],
      ]) {
        await set({ [k]: lo });
        await set({ [k]: hi });
        const r = await rejection(set({ [k]: hi + 1 }));
        assert.match(r.name, /ParameterOutOfRange/, k);
        assert.equal(r.args.name, k);
        if (lo > 0) await assert.rejects(() => set({ [k]: lo - 1 }), /ParameterOutOfRange/, k);
      }
      // The claim cost's range is above sixteen bits: the field is thirty-two.
      const wide = await set({ claimCostGwei: 9999999 });
      assert.equal((await wide.call('params')).claimCostGwei, 9999999n);
    });

    test('I42 relation 10 — the Cushion target is 0 - 2,000 and not above its ceiling, the ceiling 0 - 3,000 (technical reference §3.2)', async () => {
      const set = await constructions();
      await set({ cushionTargetBps: 0, cushionCeilingBps: 0 });
      await set({ cushionTargetBps: 2000, cushionCeilingBps: 3000 });
      await set({ cushionTargetBps: 1500, cushionCeilingBps: 1500 });
      let r = await rejection(set({ cushionTargetBps: 2001, cushionCeilingBps: 3000 }));
      assert.match(r.name, /ParameterOutOfRange/);
      assert.equal(r.args.name, 'cushionTargetBps@0', 'per phase since item 129: the cell of row 0, refused first');
      r = await rejection(set({ cushionTargetBps: 500, cushionCeilingBps: 3001 }));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.bound, 3000n);
      r = await rejection(set({ cushionTargetBps: 1000, cushionCeilingBps: 999 }));
      assert.match(r.name, /RelationViolated/, 'relation 10: the target above the ceiling');
      assert.equal(r.args.bound, 1000n);
    });

    test('I22 — the ceiling sits above every stage and within the yield the fixed shares leave', async () => {
      const set = await constructions();
      await assert.rejects(() => set({ premiumCeilingBps: 3700 }), /RelationViolated/, 'not above the fourth stage');
      await set({ premiumCeilingBps: 3701, surgeCeilingBps: 8500 });
      // BPS - buffer - operations at the reference shares is 9,500.
      await assert.rejects(() => set({ premiumCeilingBps: 9501, surgeCeilingBps: 9502 }), /RelationViolated/);
      // Raising a fixed share lowers the ceiling's room: written from that side.
      await assert.rejects(() => set({ bufferBps: 1500, premiumCeilingBps: 8300 }), /RelationViolated/);
      await set({ bufferBps: 1500, premiumCeilingBps: 8250, surgeCeilingBps: 8500 });
    });

    test('the surge ceiling is above the ceiling and within the yield at the seeding buffer', async () => {
      const set = await constructions();
      await assert.rejects(() => set({ surgeCeilingBps: 7400 }), /RelationViolated/);
      // BPS - operations - the 1,000 bps seeding buffer is 8,750.
      await set({ surgeCeilingBps: 8750 });
      await assert.rejects(() => set({ surgeCeilingBps: 8751 }), /RelationViolated/);
    });

    test('the buffer share is not above the escalator cap, and the cap not above the escrow ceiling', async () => {
      // Whitepaper §4.2, §6.3: the escalator moves the share from its base to
      // its cap, both inside the range; a base above the cap would make a rising
      // haircut lower the buffer.
      const set = await constructions();
      await set({ bufferEscalatorCapBps: 1000, bufferBps: 1000 });
      await assert.rejects(() => set({ bufferEscalatorCapBps: 1000, bufferBps: 1001 }), /ParameterOutOfRange/);
      await assert.rejects(() => set({ bufferEscalatorCapBps: 1501 }), /ParameterOutOfRange/, 'the escrow admits no more than 1,500');
    });

    test('I25 — the maturity ladder is bounded by the settlement horizon of the anchored book', async () => {
      const set = await constructions();
      // Three epochs of unbonding and four of the release bound: seven.
      await set({ maturityLadderBps: 1428 });
      const r = await rejection(set({ maturityLadderBps: 1429 }));
      assert.equal(r.args.bound, 1428n);
      // Narrowing the release bound lengthens the horizon, so the same ladder
      // stops being admissible: the relation is checked when the other term moves.
      await assert.rejects(() => set({ releaseBoundBps: 2000 }), /RelationViolated/);
      await set({ releaseBoundBps: 2000, maturityLadderBps: 1250 });
    });

    test('the run-off queue drains in no fewer epochs than one and a half unbondings', async () => {
      // 2,500 bps drains in four epochs, twenty-eight days, short of 31.5.
      const set = await constructions();
      await assert.rejects(() => set({ runoffBoundBps: 2500 }), /RelationViolated/);
      await set({ runoffBoundBps: 2499 });
      await set({ runoffBoundBps: 2000 });
    });

    test('the senior coupon is never above the floor under the tail-risk premium', async () => {
      const set = await constructions();
      await assert.rejects(() => set({ seniorCouponBps: 201 }), /RelationViolated/);
      await set({ seniorCouponBps: 300, tailPremiumFloorBps: 300 });
      await assert.rejects(() => set({ seniorCouponBps: 300, tailPremiumFloorBps: 299 }), /RelationViolated/);
      await set({ seniorCouponBps: 0 });
    });

    test('I28 — the retention period is not below the offerings the reserve needs to reach its floor, first rung included', async () => {
      // 2 + ceil((floor - m_epoch) / step) since the first-offering rung (EC-03):
      // the first offering, the offering at the epoch bound, and one per step.
      const set = await constructions();
      const r = await rejection(set({ unsoldEpochs: 6 }));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.bound, 7n, 'seven offerings reach the floor at the reference values');
      // A larger step reaches the floor sooner, so a shorter retention becomes admissible.
      await set({ reserveStepBps: 1000, unsoldEpochs: 5 });
      await assert.rejects(() => set({ reserveStepBps: 1000, unsoldEpochs: 4 }), /RelationViolated/);
      // The range is 2 - 12 since PV-24.
      await set({ unsoldEpochs: 12 });
      await assert.rejects(() => set({ unsoldEpochs: 13 }), /RelationViolated/);
      // At the widest span the ranges admit (floor 6,000, epoch bound 1,500) and a
      // step of 500 the ladder is 11, inside the range.
      await set({ reserveFloorBps: 6000, maxEpochMoveBps: 1500, unsoldEpochs: 11 });
    });

    test('relation 8 — the immediate trigger-2 draw is not below the severity floor', async () => {
      // Otherwise the assessment could settle below what was already paid at
      // the ratification and would have to claw it back (whitepaper §4.6, §6.3).
      const set = await constructions();
      const r = await rejection(set({ severityFloorBps: 6001 }));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.bound, 6001n, 'the bound reported is the severity floor');
      // Written from the other side: lowering D_0 under the floor.
      await assert.rejects(() => set({ trigger2FloorBps: 5999 }), /RelationViolated/);
      await set({ severityFloorBps: 7000, trigger2FloorBps: 7000 });
      await set({ severityFloorBps: 5000, trigger2FloorBps: 10000 });
      await assert.rejects(() => set({ trigger2FloorBps: 10001 }), /RelationViolated/, 'no draw above the obligation');
    });

    test('relation 9 — the queue exposure floor is not above BPS less (n_d - 1) decays, n_d the drain length', async () => {
      // Whitepaper §6.3 since the 2026-09-28 revision: the last principal of a
      // clean queue leaves at a clean age of n_d - 1, n_d = ceil(BPS / m_B), and
      // its weight must not be below the floor then. At the reference bound of
      // 2,000 the queue drains in five epochs and the bound is BPS - 4 x decay.
      const set = await constructions();
      const r = await rejection(set({ queueDecayBps: 2000 }));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.bound, 2000n, 'BPS - 4 x 2,000');
      await set({ queueDecayBps: 2000, queueExposureFloorBps: 2000 });
      // At the reference floor of 2,500 the largest admissible decay is 1,875.
      await set({ queueDecayBps: 1875 });
      await assert.rejects(() => set({ queueDecayBps: 1876 }), /RelationViolated/);
      // Written from the floor's side at the reference decay of 1,500: BPS - 6,000.
      await set({ queueExposureFloorBps: 4000 });
      await assert.rejects(() => set({ queueExposureFloorBps: 4001 }), /RelationViolated/);
    });

    test('relation 9 binds the run-off bound too: a slower drain leaves more clean age before the floor', async () => {
      // The old form (BPS - 4 x decay) could not see the bound. At 1,666 bps the
      // queue drains in seven epochs, not five: BPS - 6 x 1,500 = 1,000, below any
      // floor the range admits.
      const set = await constructions();
      await set({ runoffBoundBps: 1667 }); // six epochs: BPS - 5 x 1,500 = 2,500
      const r = await rejection(set({ runoffBoundBps: 1666 }));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.bound, 1000n);
      // At the bottom of the bound's range the whitepaper's figure: a decay of at
      // most 1,333 at the bottom of the floor range.
      await set({ runoffBoundBps: 1500, queueDecayBps: 1333, queueExposureFloorBps: 2000 });
      await assert.rejects(() => set({ runoffBoundBps: 1500, queueDecayBps: 1334, queueExposureFloorBps: 2000 }), /RelationViolated/);
      // Where the decay is too steep for the drain no floor satisfies it; the bound reads zero.
      const steep = await rejection(set({ runoffBoundBps: 1500, queueDecayBps: 2000, queueExposureFloorBps: 2000 }));
      assert.equal(steep.args.bound, 0n);
    });

    test('the verdict cover is in bps of the forfeitable stake, 3,333 to 8,000', async () => {
      // Whitepaper §6.2, §6.3: at the top a purchased verdict still costs five
      // quarters of what it moves; the reference 6,666 is two thirds rounded down.
      const set = await constructions();
      const p = await set({});
      assert.equal((await p.call('params')).verdictCoverBps, 6666n);
      await set({ verdictCoverBps: 3333 });
      await set({ verdictCoverBps: 8000 });
      assert.ok(!iface.fragments.some((f) => /verdictCoverMultiple/i.test(f.format('full'))), 'the integer multiple k is retired');
    });

    test('the court cycle with its appeal stays below the unbonding period', async () => {
      // Whitepaper §6.2: challenge 7, evidence 3, commit 2, reveal 1, appeal 2 —
      // fifteen days, twenty with the one appeal round, below twenty-one. A
      // longer cycle would let a release outrun a determination open against it.
      const set = await constructions();
      await set({ challengeWindowDays: 7 });
      const r = await rejection(set({ challengeWindowDays: 8 }));
      assert.match(r.name, /RelationViolated/);
      assert.equal(r.args.supplied, 21n, 'a twenty-one day cycle reaches the unbonding period');
      // An appeal-round window counts twice: once in the first round, once on appeal.
      await assert.rejects(() => set({ challengeWindowDays: 6, appealDays: 3 }), /RelationViolated/);
      await set({ challengeWindowDays: 5, appealDays: 3 });
    });

    test('the grace period stays inside the first-round dispute cycle', async () => {
      const set = await constructions();
      await set({ graceEpochs: 2 });
      await assert.rejects(() => set({ graceEpochs: 3 }), /RelationViolated/);
      // The cycle is the court's windows now, not a constant: fourteen days still
      // admit two epochs of grace, thirteen do not.
      await set({ challengeWindowDays: 6 });
      await assert.rejects(() => set({ challengeWindowDays: 5 }), /RelationViolated/);
    });

    test('the release bound is not below any admitted asset exit path, and a de-listing does not lower that', async () => {
      // Through a vote: the floor is the registry's, and the registry is named
      // after construction.
      const ctx = await deployStack({ assets: [] });
      await ctx.registry.send('admitAsset', [assetInput({ asset: ASSET_A, group: GROUP_A, exitBoundBps: 2200 })], {
        from: ACCOUNTS.admin,
      });
      await assert.rejects(
        () => voteParams(ctx.params, { releaseBoundBps: 2100, maturityLadderBps: 1250 }),
        /ReleaseBoundBelowAssetExit/,
      );
      await ctx.registry.send('delistAsset', [await ctx.registry.call('assetKey', [1n, ASSET_A])], { from: ACCOUNTS.admin });
      await assert.rejects(
        () => voteParams(ctx.params, { releaseBoundBps: 2100, maturityLadderBps: 1250 }),
        /ReleaseBoundBelowAssetExit/,
        'the positions anchored under it still leave through its exit path',
      );
      await voteParams(ctx.params, { releaseBoundBps: 2200, maturityLadderBps: 1250 });
    });

    test('the release bound cannot be voted above what the origin-chain escrow will move', async () => {
      const ctx = await deployStack({ assets: [] });
      assert.equal(await ctx.params.call('MAX_RELEASE_BOUND_BPS'), 2500n);
      await assert.rejects(() => voteParams(ctx.params, { releaseBoundBps: 2501 }), /ParameterOutOfRange/);
    });

    test('an asset whose exit path is wider than the bound is refused at admission', async () => {
      const ctx = await deployStack({ assets: [] });
      await enactParams(ctx.chain, ctx.params, { releaseBoundBps: 2000, maturityLadderBps: 1250 });
      await assert.rejects(
        () => ctx.registry.send('admitAsset', [assetInput({ asset: ASSET_B, group: GROUP_B, exitBoundBps: 2001 })], { from: ACCOUNTS.admin }),
        /ReleaseBoundBelowAssetExit/,
      );
    });
  });

  describe("the threat stage is the phase's; a vote moves only the band of phase 2, one step, from the next epoch (item 129)", () => {
    test('up the ladder by phase and band: phase 2 is stage 2, its band 3, phase 3 stage 4, each in force from the next epoch', async () => {
      const ctx = await deployStack({ assets: [] });
      assert.equal(await ctx.params.call('sigmaTargetBps'), 1850n, 'phase 0, stage 1');
      await toPhase(ctx, 2);
      assert.equal(await ctx.params.call('threatStage'), 2n);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 2500n);
      const res = await stage(ctx, 2, 3);
      const [ev] = ctx.params.events(res, 'ThreatStageSet');
      assert.equal(ev.args.toStage, 3n);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 2500n, 'the vote is not in force inside its own epoch');
      toNextEpoch(ctx);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 3000n);
      await toPhase(ctx, 3);
      assert.equal(await ctx.params.call('threatStage'), 4n);
      assert.equal(await ctx.params.call('sigmaTargetBps'), 3700n);
      const r = await rejection(stage(ctx, 4, 3));
      assert.match(r.name, /StageFixedByPhase/, 'no vote moves the stage out of Q-Day');
      assert.equal(r.args.phase, 3n);
    });

    test('a vote cannot skip a stage, nor leave the band 2 - 3, nor move the stage outside phase 2', async () => {
      const ctx = await deployStack({ assets: [] });
      for (const [from, to] of [[1, 2], [1, 3], [2, 3]]) {
        const r = await rejection(stage(ctx, from, to));
        assert.match(r.name, /StageFixedByPhase/, `${from} -> ${to} in phase 0`);
        assert.equal(r.args.phase, 0n);
      }
      await toPhase(ctx, 2);
      await assert.rejects(() => stage(ctx, 2, 4), /ThreatStageStep/);
      await assert.rejects(() => stage(ctx, 2, 1), /ThreatStageStep/, 'stage 1 is reached by moving the phase');
      await assert.rejects(() => stage(ctx, 2, 2), /ThreatStageStep/, 'no no-op vote');
      await stage(ctx, 2, 3);
      toNextEpoch(ctx);
      await assert.rejects(() => stage(ctx, 3, 4), /ThreatStageStep/, 'stage 4 is reached by moving the phase');
      await stage(ctx, 3, 2);
      toNextEpoch(ctx);
      assert.equal(await ctx.params.call('threatStage'), 2n);
    });

    test('only governance moves it', async () => {
      const ctx = await deployStack({ assets: [] });
      await toPhase(ctx, 2);
      await assert.rejects(() => stage(ctx, 2, 3, ACCOUNTS.mallory), /OnlyGovernance/);
    });

    test('a vote names the stage it moves from, and does not execute against another (design §6.3)', async () => {
      // A proposal written at one band value and executed after another vote
      // moved it would otherwise step from wherever the band then is.
      const ctx = await deployStack({ assets: [] });
      await toPhase(ctx, 2);
      const r = await rejection(stage(ctx, 3, 2));
      assert.match(r.name, /ThreatStageMismatch/);
      assert.equal(r.args.current, 2n);
      await stage(ctx, 2, 3);
      toNextEpoch(ctx);
      await assert.rejects(() => stage(ctx, 2, 3), /ThreatStageMismatch/, 'the stale proposal of 2 -> 3');
      await stage(ctx, 3, 2);
    });

    test('at most one step per epoch, in either direction: no run of calls walks the band at once (D9)', async () => {
      const ctx = await deployStack({ assets: [] });
      await toPhase(ctx, 2);
      await stage(ctx, 2, 3);
      await assert.rejects(() => stage(ctx, 3, 2), /ThreatStageAlreadyStepped/);
      await assert.rejects(() => stage(ctx, 2, 3), /ThreatStageAlreadyStepped/);
      // Late in the same epoch is still the same epoch.
      const now = BigInt(ctx.chain.timestamp);
      const next = (now / BigInt(EPOCH) + 1n) * BigInt(EPOCH);
      ctx.chain.advanceTime(Number(next - now - 1n));
      await assert.rejects(() => stage(ctx, 2, 3), /ThreatStageAlreadyStepped/);
      assert.equal(await ctx.params.call('threatStage'), 2n, 'nor in force, one second before the boundary');
      ctx.chain.advanceTime(1);
      assert.equal(await ctx.params.call('threatStage'), 3n, 'in force at the boundary');
      await stage(ctx, 3, 2);
      toNextEpoch(ctx);
      assert.equal(await ctx.params.call('threatStage'), 2n);
    });

    test('a lower stage is thinner cover at a lower price, not the same cover for less', async () => {
      const ctx = await deployStack({ bondQrl: 10_000_000n * ONE });
      assert.equal(await ctx.registry.call('effectiveIndemnityBps'), 6166n);
      assert.equal(await ctx.registry.call('effectiveAttachmentBps'), 1234n);
      await toPhase(ctx, 2);
      await stage(ctx, 2, 3);
      toNextEpoch(ctx);
      await toPhase(ctx, 3);
      assert.equal(await ctx.registry.call('effectiveIndemnityBps'), 10000n);
      assert.equal(await ctx.registry.call('effectiveAttachmentBps'), 2000n);
    });
  });

  describe('governance is handed over in two steps (whitepaper §6.3)', () => {
    // The same two functions on the registry and the delegation; each contract
    // is exercised here so a regression in any one of them is caught by name.
    const handover = async (contract, gated) => {
      assert.equal((await contract.call('governance')).toLowerCase(), ACCOUNTS.admin.toLowerCase());
      await assert.rejects(() => contract.send('proposeGovernance', [ACCOUNTS.bob], { from: ACCOUNTS.mallory }), /OnlyGovernance/);
      const res = await contract.send('proposeGovernance', [ACCOUNTS.bob], { from: ACCOUNTS.admin });
      assert.equal(contract.events(res, 'GovernanceProposed').length, 1);
      assert.equal((await contract.call('pendingGovernance')).toLowerCase(), ACCOUNTS.bob.toLowerCase());
      // Proposing moves nothing: the incumbent governs until the successor accepts.
      assert.equal((await contract.call('governance')).toLowerCase(), ACCOUNTS.admin.toLowerCase());
      await assert.rejects(() => contract.send('acceptGovernance', [], { from: ACCOUNTS.mallory }), /NotPendingGovernance/);
      await assert.rejects(() => contract.send('acceptGovernance', [], { from: ACCOUNTS.admin }), /NotPendingGovernance/);
      const acc = await contract.send('acceptGovernance', [], { from: ACCOUNTS.bob });
      assert.equal(contract.events(acc, 'GovernanceTransferred').length, 1);
      assert.equal((await contract.call('governance')).toLowerCase(), ACCOUNTS.bob.toLowerCase());
      assert.equal(BigInt(await contract.call('pendingGovernance')), 0n);
      // The old account has lost every governance-gated call, and the new one holds them.
      await assert.rejects(() => gated(ACCOUNTS.admin), /OnlyGovernance/);
      await gated(ACCOUNTS.bob);
      // Accepted once: there is nothing left to accept.
      await assert.rejects(() => contract.send('acceptGovernance', [], { from: ACCOUNTS.bob }), /NotPendingGovernance/);
    };

    test('the parameter set: propose, accept, and only the successor votes after', async () => {
      const ctx = await deployStack({ assets: [] });
      // The band vote, inside phase 2 where one is admitted (item 129).
      await toPhase(ctx, 2);
      await handover(ctx.params, (from) => ctx.params.send('setThreatStage', [2, 3], { from }));
    });

    test('the registry: propose, accept, and only the successor admits after', async () => {
      const ctx = await deployStack({ assets: [] });
      await handover(ctx.registry, (from) =>
        ctx.registry.send('admitAsset', [assetInput({ asset: ASSET_A, group: GROUP_A })], { from }),
      );
    });

    test('a proposal is withdrawn by proposing zero, and never accepted by the zero account', async () => {
      const ctx = await deployStack({ assets: [] });
      await ctx.params.send('proposeGovernance', [ACCOUNTS.bob], { from: ACCOUNTS.admin });
      await ctx.params.send('proposeGovernance', ['0x' + '00'.repeat(20)], { from: ACCOUNTS.admin });
      await assert.rejects(() => ctx.params.send('acceptGovernance', [], { from: ACCOUNTS.bob }), /NotPendingGovernance/);
      assert.equal((await ctx.params.call('governance')).toLowerCase(), ACCOUNTS.admin.toLowerCase());
    });
  });

  describe('wiring', () => {
    test('the registry is named once, by the deployer', async () => {
      const ctx = await deployStack({ assets: [] });
      await assert.rejects(
        () => ctx.params.send('setRegistry', [ACCOUNTS.mallory], { from: ACCOUNTS.admin }),
        /AlreadySet/,
      );
    });

    test('the account that names the registry is the one named at construction, not msg.sender', async () => {
      // Created through ChunkedDeployer, msg.sender is a contract that can make
      // no call with the right; the deployer is therefore an argument (CLAUDE.md §3.1).
      const chain = await Chain.create();
      const p = await deployParams(chain, { deployer: ACCOUNTS.bob });
      await assert.rejects(() => p.send('setRegistry', [ACCOUNTS.alice], { from: ACCOUNTS.admin }), /OnlyDeployer/);
      await p.send('setRegistry', [ACCOUNTS.alice], { from: ACCOUNTS.bob });
      await assert.rejects(() => deployParams(chain, { deployer: '0x' + '00'.repeat(20) }), /ZeroAddress/);
    });
  });
});
