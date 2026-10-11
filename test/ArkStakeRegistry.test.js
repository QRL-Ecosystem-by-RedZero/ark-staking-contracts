/**
 * ArkStakeRegistry: the position record, the bound beneficiary, the price of
 * cover, the admission condition and its periodic review, and the transit of a
 * release.
 *
 * The one rule this file exists to defend: **the address entitled to release a
 * position is part of its identifier, and the price of cover is the
 * specification's function of the book in front of it** — computed here, on the
 * book as it stands, and agreeing with `../quantum-ark/src/lib/ark-staking.ts`
 * wherever both are evaluated.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { loadModel, MISSING } = require('./spec-model');
const {
  ACCOUNTS,
  DAY,
  EPOCH,
  BPS,
  ONE,
  REF_PRICE,
  GROUP_A,
  GROUP_B,
  ASSET_A,
  ASSET_B,
  CHAIN_ID,
  ZERO,
  ESCROW,
  stakeAssetId,
  stakeLeafKey,
  insuranceLeafKey,
  releasePayload,
  releaseLeaf,
  releasedLeaf,
  allocationLeaf,
  bufferLeaf,
  pairHash,
  withParams,
  enactParams,
  assetInput,
  deployStack,
  epochNow,
  anchor,
  REFERENCE_PARAMS,
} = require('./stake-fixture');

let M;
before(async () => {
  M = await loadModel();
});

const FIVE = ['0x' + 'a1'.repeat(20), '0x' + 'a2'.repeat(20), '0x' + 'a3'.repeat(20), '0x' + 'a4'.repeat(20), '0x' + 'a5'.repeat(20)];
const fiveGroups = FIVE.map((asset, i) => ({ asset, group: keccak256(toUtf8Bytes(`group:${i}`)) }));

/**
 * The book the scenario report evaluates: one thousand units, diversified
 * across five correlation groups so the measured share rests on the loss
 * floor. The window is let forget the first anchors — each of which was, when
 * it arrived, a large share of a small book — because a running maximum
 * remembers a young book's concentration for thirteen epochs, which is its job.
 */
async function reportBook({ bondQrl = 2_000_000n * ONE } = {}) {
  const ctx = await deployStack({ bondQrl, stage: 4, assets: fiveGroups });
  for (let i = 0; i < 5; i++) {
    await anchor(ctx, { asset: FIVE[i], nonce: BigInt(i), notional: 200n * ONE });
  }
  ctx.chain.advanceTime(13 * EPOCH);
  return ctx;
}

/** Seal an escrow's buffer report into a one-leaf root and record it. */
async function recordBuffer(ctx, { asset, units, epoch = epochNow(ctx), from = ACCOUNTS.mallory }) {
  await ctx.attest.send('seal', [epoch, bufferLeaf(CHAIN_ID, asset, epoch, units)]);
  return ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, asset, epoch, units, []], { from });
}

/** A governance diff, then the clock moved to the epoch it is in force in (design §6.4). */
const setParams = (ctx, overrides) => enactParams(ctx.chain, ctx.params, overrides);

/** The clock moved `n` epochs forward, to the start of the epoch. */
const F_next = (ctx, n = 1) => {
  const now = BigInt(ctx.chain.timestamp);
  const target = (now / BigInt(EPOCH) + BigInt(n)) * BigInt(EPOCH);
  ctx.chain.advanceTime(Number(target - now));
};

describe('ArkStakeRegistry', () => {
  /* ---------------------------------------------------------------- */
  describe('the entitlement is committed at deposit', () => {
    test('the identifier commits to the beneficiary', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { owner: ACCOUNTS.alice, notional: 100n * ONE });
      assert.equal(await ctx.registry.call('stakeAssetId', [CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n]), id);
      const a = await ctx.registry.call('anchorOf', [id]);
      assert.equal(a.boundQrlOwner.toLowerCase(), ACCOUNTS.alice);
    });

    test('a different beneficiary is a different position, not a rewritten one', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { owner: ACCOUNTS.alice, notional: 100n * ONE });
      const substituted = await ctx.registry.call('stakeAssetId', [CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.mallory, 0n]);
      assert.notEqual(substituted, id);
      assert.equal((await ctx.registry.call('anchorOf', [substituted])).status, 0n);
    });

    test('a deposit naming no beneficiary is rejected, not defaulted', async () => {
      const ctx = await deployStack();
      await assert.rejects(
        () =>
          ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ZERO, 0n, 100n * ONE, ESCROW], epochNow(ctx), []], {
            from: ACCOUNTS.bob,
          }),
        /NoBeneficiary/,
      );
    });

    test('the beneficiary field has no setter', async () => {
      const { registry } = await deployStack();
      const names = registry.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name.toLowerCase());
      assert.ok(!names.some((n) => n.includes('setbound') || n.includes('setbeneficiary') || n.includes('setowner')));
    });

    test('QL-27: an anchor names its escrow, asset and depositor in their one canonical encoding (R2 M-3)', async () => {
      // The harness line's addresses are twenty bytes, where every value is
      // canonical; a dirty high word exists only on a v3 (QIP-55) chain. The
      // refusal is read from the source, before anything else of the record.
      const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'contracts', 'ArkStakeRegistry.hyp'), 'utf8');
      const body = src.slice(src.indexOf('function recordAnchor('), src.indexOf('_consumeProof(epoch, ArkStakeLeaves.stakeLeafKey'));
      for (const field of ['escrow', 'asset', 'depositor']) assert.match(body, new RegExp(`_canonical\\(input\\.${field}\\);`), field);
      assert.match(src, /if \(!EvmWords\.isEvmAddress\(a\)\) revert AnchorNotCanonical\(a\);/);
      // And a canonical anchor is recorded as before.
      const ctx = await deployStack();
      await anchor(ctx, { notional: ONE });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('an anchor is admitted only against a proven leaf', () => {
    test('a leaf outside the sealed root is refused', async () => {
      const ctx = await deployStack();
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [epochNow(ctx), stakeLeafKey(id, 999n * ONE)]);
      await assert.rejects(
        () => ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epochNow(ctx), []], { from: ACCOUNTS.bob }),
        /BadProof/,
      );
    });

    test('an insurance-domain leaf does not verify as a stake leaf', async () => {
      // One leaf construction serves every product in the roots, so without the
      // tag a root sealed for one would authorise a payment in another.
      const ctx = await deployStack();
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [epochNow(ctx), insuranceLeafKey(id, 100n * ONE)]);
      await assert.rejects(
        () => ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epochNow(ctx), []], { from: ACCOUNTS.bob }),
        /BadProof/,
      );
    });

    test('a real membership proof against a two-leaf root is accepted', async () => {
      const ctx = await deployStack();
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      const leaf = stakeLeafKey(id, 100n * ONE);
      const other = keccak256(toUtf8Bytes('some other anchor'));
      await ctx.attest.send('seal', [epochNow(ctx), pairHash(leaf, other)]);
      await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epochNow(ctx), [other]], {
        from: ACCOUNTS.bob,
      });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 1n);
    });

    test('an anchor is recorded once', async () => {
      const ctx = await deployStack();
      const { epoch } = await anchor(ctx, { notional: 100n * ONE });
      await assert.rejects(
        () => ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob }),
        /AnchorExists/,
      );
    });

    test('an asset never admitted cannot be anchored', async () => {
      // It has no correlation group to be measured in. An asset admitted and
      // later de-listed is a different case, below: its deposits are recorded.
      const ctx = await deployStack();
      await assert.rejects(
        () => ctx.registry.send('recordAnchor', [[CHAIN_ID, '0x' + 'cc'.repeat(20), ACCOUNTS.alice, ACCOUNTS.alice, 0n, ONE, ESCROW], epochNow(ctx), []], { from: ACCOUNTS.bob }),
        /AssetNotAdmitted/,
      );
    });

    test('only the quorum seals a root, so nobody else can overwrite one it sealed', async () => {
      // The double stands in for the attester quorum. A seal anyone could call
      // would let any account replace a root the relayer sealed and make every
      // forward proof against it fail.
      const ctx = await deployStack();
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      const leaf = stakeLeafKey(id, 100n * ONE);
      await ctx.attest.send('seal', [epochNow(ctx), leaf]);
      await assert.rejects(
        () => ctx.attest.send('seal', [epochNow(ctx), keccak256(toUtf8Bytes('forged'))], { from: ACCOUNTS.mallory }),
        /NotSealer/,
      );
      assert.equal(await ctx.attest.call('rootOf', [epochNow(ctx)]), leaf);
      // The quorum's own power to reseal an epoch is kept.
      await ctx.attest.send('seal', [epochNow(ctx), leaf]);
      await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epochNow(ctx), []], { from: ACCOUNTS.bob });
    });
  });

  /* ---------------------------------------------------------------- */
  describe('a deposit the escrow has taken is recorded, never refused', () => {
    // The escrow is one-way: a deposit it has taken can leave only through a
    // release, and a release needs the QRL record. Refusing to record a proven
    // deposit strands it on the origin chain. Admission and the group cap
    // shape the inflow, which is the escrow's to stop through the de-listing
    // leaf; the record only states what happened.

    test('an anchor past the group cap is recorded, counted and flagged, and stays releasable', async () => {
      const ctx = await reportBook();
      // Every group sits at the 2,000 bps cap; one more unit into group 0
      // carries it over.
      const { id } = await anchor(ctx, { asset: FIVE[0], nonce: 9n, notional: 100n * ONE });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 1n);
      assert.equal(await ctx.registry.call('totalAnchored'), 1100n * ONE, 'the exposure is real, so it is counted');
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), 2728n, '300 of 1,100, rounded up');
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 2n);
    });

    test('the flag names the group share and the cap it passed', async () => {
      const ctx = await reportBook();
      const epoch = epochNow(ctx);
      const id = stakeAssetId(CHAIN_ID, FIVE[0], ACCOUNTS.alice, ACCOUNTS.alice, 9n);
      await ctx.attest.send('seal', [epoch, stakeLeafKey(id, 100n * ONE)]);
      const res = await ctx.registry.send('recordAnchor', [[CHAIN_ID, FIVE[0], ACCOUNTS.alice, ACCOUNTS.alice, 9n, 100n * ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob });
      const [ev] = ctx.registry.events(res, 'AnchoredOutsideControls');
      assert.equal(ev.args.stakeAssetId, id);
      assert.equal(ev.args.delisted, false);
      assert.equal(ev.args.groupShareBps, 2728n, "300 of 1,100, rounded up");
      assert.equal(ev.args.capBps, 2000n);
    });

    test('a dust anchor that makes the cap satisfiable strands nobody', async () => {
      // Four groups hold the book, so the cap is waived; a dust anchor into a
      // fifth makes it bind, and every group is then far past it.
      const ctx = await deployStack({ stage: 4, assets: fiveGroups });
      for (let i = 0; i < 4; i++) await anchor(ctx, { asset: FIVE[i], nonce: BigInt(i), notional: 250n * ONE });
      await anchor(ctx, { asset: FIVE[4], nonce: 4n, notional: 1n });
      assert.equal(await ctx.registry.call('activeGroups'), 5n);
      const { id } = await anchor(ctx, { asset: FIVE[0], nonce: 10n, notional: 10n * ONE });
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
    });

    test('a deposit made before a de-listing reached the escrow is recorded and releasable', async () => {
      const ctx = await deployStack();
      const key = await ctx.registry.call('assetKey', [CHAIN_ID, ASSET_A]);
      await ctx.registry.send('delistAsset', [key], { from: ACCOUNTS.admin });
      const epoch = epochNow(ctx);
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [epoch, stakeLeafKey(id, 100n * ONE)]);
      const res = await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob });
      assert.equal(ctx.registry.events(res, 'AnchoredOutsideControls')[0].args.delisted, true);
      assert.equal(await ctx.registry.call('totalAnchored'), 100n * ONE);
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 2n);
    });

    test('an anchor inside every control carries no flag', async () => {
      const ctx = await deployStack();
      const epoch = epochNow(ctx);
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [epoch, stakeLeafKey(id, 100n * ONE)]);
      const res = await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob });
      assert.equal(ctx.registry.events(res, 'AnchoredOutsideControls').length, 0);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the price of cover', () => {
    test('no bond outstanding is zero cover, no premium and a 9,500 bps staker share once the buffer is past its ramp', async () => {
      const ctx = await deployStack({ bondQrl: 0n, stage: 4 });
      await anchor(ctx, { notional: 100n * ONE });
      assert.equal(await ctx.registry.call('coveredBps'), 0n);
      assert.equal(await ctx.registry.call('premiumShareBps'), 0n);
      // No buffer yet: the ramp of §4.2 holds the buffer share at its seeding value (EC-05).
      const ramped = await ctx.registry.call('allocation');
      assert.equal(ramped.bufferBps, 1000n);
      assert.equal(ramped.stakerBps, 8750n);
      // A buffer at the threshold, a tenth of K: the share is its base again.
      const k = await ctx.registry.call('requiredCapital');
      await recordBuffer(ctx, { asset: ASSET_A, units: k / 10n });
      const a = await ctx.registry.call('allocation');
      assert.equal(a.stakerBps, 9500n);
    });

    test('an empty book requiring no capital reads as zero cover, not full cover', async () => {
      const ctx = await deployStack({ stage: 4 });
      assert.equal(await ctx.registry.call('requiredCapital'), 0n);
      assert.equal(await ctx.registry.call('coveredBps'), 0n);
      assert.equal(await ctx.registry.call('premiumShareBps'), 0n);
    });

    test('the modelled book: two hundred units required, 3,700 bps charged, 5,800 to the staker', async () => {
      const ctx = await reportBook();
      assert.equal(await ctx.registry.call('pmlBps'), 2000n);
      assert.equal(await ctx.registry.call('effectiveAttachmentBps'), 2000n);
      assert.equal(await ctx.registry.call('requiredCapital'), 200n * ONE);
      assert.equal(await ctx.registry.call('coveredBps'), BPS);
      assert.equal(await ctx.registry.call('premiumShareBps'), 3700n);
      assert.equal(await ctx.registry.call('couponMultipleBps'), 18500n);
      // Before the buffer reaches a tenth of K the ramp runs (EC-05; PV-16):
      // the seeding value, and the staker share 750 below.
      const ramped = await ctx.registry.call('allocation');
      assert.equal(ramped.bufferBps, 1000n);
      assert.equal(ramped.stakerBps, 5050n);
      await recordBuffer(ctx, { asset: FIVE[0], units: 20n * ONE });
      const a = await ctx.registry.call('allocation');
      assert.equal(a.stakerBps + a.premiumBps + a.bufferBps + a.operationsBps + a.levyBps, BPS);
      assert.equal(a.levyBps, 0n, 'no levy at the fourth stage');
      assert.equal(a.stakerBps, 5800n);
    });

    test('the buffer ramp: below a tenth of K the buffer share is at least 1,000, at a tenth its base (whitepaper §4.2, EC-05; adversarial on the threshold)', async () => {
      const ctx = await reportBook();
      const k = await ctx.registry.call('requiredCapital');
      assert.equal(k, 200n * ONE);
      // One wei under the threshold is still below it.
      await recordBuffer(ctx, { asset: FIVE[0], units: k / 10n - 1n });
      assert.equal((await ctx.registry.call('allocation')).bufferBps, 1000n);
      if (M) assert.equal(M.ark.bufferBelowRampThreshold(M.params, k / 10n - 1n, k), true);
      F_next(ctx);
      await recordBuffer(ctx, { asset: FIVE[0], units: k / 10n });
      assert.equal((await ctx.registry.call('allocation')).bufferBps, 250n);
      if (M) assert.equal(M.ark.bufferBelowRampThreshold(M.params, k / 10n, k), false);
      // A vote on the threshold moves the line (a value-transfer key, 30 days).
      await setParams(ctx, { bufferRampThresholdBps: 1375 });
      assert.equal((await ctx.registry.call('allocation')).bufferBps, 1000n, 'below 13.75 per cent of K again');
      // The escalator above the seeding value wins over the ramp.
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 2500n]);
      assert.equal((await ctx.registry.call('allocation')).bufferBps, 1500n);
    });

    test('a scarce book pays along the slope: 3,515 at 90 per cent cover, 2,682 at 45', async () => {
      for (const [bondQrl, covered, premium, target] of [
        [1_800_000n * ONE, 9000n, 3515n, 3905n],
        [900_000n * ONE, 4500n, 2682n, 5961n],
      ]) {
        const ctx = await reportBook({ bondQrl });
        assert.equal(await ctx.registry.call('coveredBps'), covered);
        assert.equal(await ctx.registry.call('premiumShareBps'), premium);
        assert.equal(await ctx.registry.call('premiumTargetBps'), target);
      }
    });

    test('utilisation above one is priced, not refused', async () => {
      // Whitepaper section 4.3: the scarcity slope prices the shortage, so an
      // anchor past complete cover is admitted and dilutes cover at a price.
      const ctx = await deployStack({ bondQrl: 100_000n * ONE, stage: 4 });
      await anchor(ctx, { notional: 1000n * ONE });
      const covered = await ctx.registry.call('coveredBps');
      assert.ok(covered < BPS, 'cover is partial');
      assert.ok((await ctx.registry.call('capacity')) < 1000n * ONE, 'the book is past what the bond carries');
      assert.ok((await ctx.registry.call('premiumTargetBps')) > 3700n, 'the target rose with the shortage');
      assert.ok((await ctx.registry.call('premiumShareBps')) < 3700n, 'the share charged fell with the cover');
    });

    test('the share charged is largest at complete cover (I30)', async () => {
      let previous = 10n ** 9n;
      for (const bondQrl of [4_000_000n, 2_000_000n, 1_500_000n, 1_000_000n, 500_000n, 100_000n]) {
        const ctx = await reportBook({ bondQrl: bondQrl * ONE });
        const sigma = await ctx.registry.call('premiumShareBps');
        assert.ok(sigma <= previous && sigma <= 3700n, `at ${bondQrl}`);
        previous = sigma;
      }
    });

    test('a closed run-off gate raises the ceiling to the surge value and not the charge at complete cover', async () => {
      const full = await reportBook();
      await full.bond.send('setGateClosed', [true]);
      assert.equal(await full.registry.call('premiumCeilingInForceBps'), 8500n);
      assert.equal(await full.registry.call('premiumShareBps'), 3700n);

      const scarce = await reportBook({ bondQrl: 400_000n * ONE });
      const ordinary = await scarce.registry.call('premiumShareBps');
      await scarce.bond.send('setGateClosed', [true]);
      const surge = await scarce.registry.call('premiumShareBps');
      assert.equal(ordinary, 1480n, 'the ordinary ceiling binds at a utilisation of five');
      assert.equal(surge, 1700n);
    });

    test('the bound of section 4.5 reduces the indemnity and leaves the capital standing', async () => {
      // A single-group book measures its whole notional as one event, so the
      // requirement is the whole of it times the reduced indemnity.
      const ctx = await deployStack({ stage: 4, bondQrl: 10_000_000n * ONE });
      await anchor(ctx, { notional: 100n * ONE });
      assert.equal(await ctx.registry.call('pmlBps'), BPS);
      assert.equal(await ctx.registry.call('effectiveIndemnityBps'), 2466n);
      assert.equal(await ctx.registry.call('effectiveAttachmentBps'), 2466n);
      assert.ok((await ctx.registry.call('couponMultipleBps')) >= 15000n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the conversion haircut enters capacity and no settlement quantity', () => {
    test('a measured drawdown reduces cover and capacity and leaves the requirement unmoved', async () => {
      const ctx = await reportBook();
      const required = await ctx.registry.call('requiredCapital');
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 1000n]);
      assert.equal(await ctx.registry.call('fxHaircutBps'), 1000n);
      assert.equal(await ctx.registry.call('coveredBps'), 9000n);
      assert.equal(await ctx.registry.call('bondCapacityInOrigin'), 180n * ONE);
      assert.equal(await ctx.registry.call('requiredCapital'), required, 'I27');
    });

    test('the haircut is capped at h_max', async () => {
      const ctx = await reportBook();
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 4000n]);
      assert.equal(await ctx.registry.call('fxHaircutBps'), 2500n);
    });

    test('the governable window is the one the oracle is asked about', async () => {
      const ctx = await reportBook();
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 1000n]);
      await setParams(ctx, { fxWindowDays: 30 });
      assert.equal(await ctx.registry.call('fxHaircutBps'), 0n, 'a thirty-day window reads the thirty-day drawdown');
      await ctx.oracle.send('setDrawdown', [BigInt(30 * DAY), 700n]);
      assert.equal(await ctx.registry.call('fxHaircutBps'), 700n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the reference price and the circuit breaker', () => {
    test('cover is measured on the settlement series, never on the epoch average (I38)', async () => {
      // Whitepaper §4.3, §5.5: capacity, utilisation and cover convert bond
      // principal at the price a settlement strikes at. This test used to
      // assert the opposite (cover at the epoch average), which left the
      // divergence of the two windows to arbitrage.
      const ctx = await reportBook();
      await ctx.oracle.send('set', [REF_PRICE * 2n, REF_PRICE, REF_PRICE]);
      assert.equal(await ctx.registry.call('referencePrice'), REF_PRICE);
      assert.equal(await ctx.registry.call('epochPrice'), REF_PRICE * 2n);
      assert.equal(await ctx.registry.call('coveredBps'), 10000n, 'a spot print moves no cover');
      // The adversarial direction: an epoch average far below the series would
      // have converted bond principal into twice the origin asset and sold
      // cover the settlement cannot pay.
      await ctx.bond.send('set', [1_000_000n * ONE]);
      await ctx.oracle.send('set', [REF_PRICE / 2n, REF_PRICE, REF_PRICE]);
      assert.equal(await ctx.registry.call('coveredBps'), 5000n, 'cover reads the series, not the print');
      await ctx.oracle.send('set', [REF_PRICE, REF_PRICE * 2n, REF_PRICE * 2n]);
      assert.equal(await ctx.registry.call('coveredBps'), 2500n, 'a rise in the series thins cover');
    });

    test('the bond reads its utilisation on the same series, with the buffer beside it', async () => {
      // One series feeds cover and the conditional release (I38).
      const ctx = await reportBook({ bondQrl: 400_000n * ONE });
      // 200 required against 40 units of bond: five.
      assert.equal(await ctx.registry.call('utilisationBps'), 50000n);
      await ctx.oracle.send('set', [REF_PRICE / 2n, REF_PRICE, REF_PRICE]);
      assert.equal(await ctx.registry.call('utilisationBps'), 50000n, 'the epoch average moves nothing');
      await recordBuffer(ctx, { asset: FIVE[0], units: 160n * ONE });
      assert.equal(await ctx.registry.call('utilisationBps'), 10000n, '200 against 40 + 160');
    });

    test('the settlement price: the series outside the breaker, min(carried, max(twap_e, floor_k)) under it (whitepaper §5.5; R-4)', async (t) => {
      if (!M) return t.skip(MISSING);
      const { ark, params } = M;
      const ctx = await reportBook();
      assert.equal(await ctx.registry.call('settlementPrice'), REF_PRICE, 'no breaker: the carried price is the bounded series itself');
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [carried, e0, fired0] = await ctx.registry.call('carriedPrice');
      assert.equal(carried, REF_PRICE, 'a mark outside the breaker carries the series');
      assert.equal(fired0, 0n);
      const model = (twap30d, emergency, k) => ark.settlementPrice({
        breakerCleared: false,
        carried,
        twap30d,
        emergency,
        floor: ark.emergencyPriceFloor(carried, params.maxEpochMoveBps, k),
      });
      // The thirty-day series falls by two thirds in a day: the breaker fires.
      const twap = REF_PRICE / 3n;
      await ctx.oracle.send('set', [twap, twap, REF_PRICE]);
      await ctx.oracle.send('setEmergency', [REF_PRICE / 4n]);
      assert.equal(await ctx.registry.call('breakerActive'), true);
      assert.equal(await ctx.registry.call('settlementPrice'), model(twap, REF_PRICE / 4n, 0), 'k = 0: the floor is the carried price');
      // A mark sees it active: the firing epoch is recorded, the carried price is not overwritten.
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [c1, , fired1] = await ctx.registry.call('carriedPrice');
      assert.equal(c1, REF_PRICE);
      assert.equal(fired1, e0 + 1n);
      ctx.chain.advanceTime(2 * EPOCH);
      assert.equal(await ctx.registry.call('settlementPrice'), model(twap, REF_PRICE / 4n, 2), 'two epochs on: the floor, 5,625');
      assert.equal(await ctx.registry.call('settlementPrice'), (REF_PRICE * 5625n) / 10000n);
      await ctx.oracle.send('setEmergency', [(REF_PRICE * 7n) / 10n]);
      assert.equal(await ctx.registry.call('settlementPrice'), (REF_PRICE * 7n) / 10n, 'a print above the floor strikes as printed');
      await ctx.oracle.send('setEmergency', [REF_PRICE * 2n]);
      assert.equal(await ctx.registry.call('settlementPrice'), REF_PRICE, 'and never above the carried price');
      ctx.chain.advanceTime(3 * EPOCH);
      await ctx.oracle.send('setEmergency', [0n]);
      assert.equal(await ctx.registry.call('settlementPrice'), model(twap, 0n, 5), 'no emergency valuation yet: the floor');
      // The breaker clears: the series again, and the next mark carries it.
      await ctx.oracle.send('set', [twap, twap, twap]);
      assert.equal(await ctx.registry.call('breakerActive'), false);
      assert.equal(await ctx.registry.call('settlementPrice'), twap);
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [c2, , fired2] = await ctx.registry.call('carriedPrice');
      assert.equal(c2, twap);
      assert.equal(fired2, 0n);
    });

    test('a firing no mark saw counts from the last mark outside the breaker: the most epochs the decline can have run', async (t) => {
      if (!M) return t.skip(MISSING);
      const { ark, params } = M;
      const ctx = await reportBook();
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [carried] = await ctx.registry.call('carriedPrice');
      ctx.chain.advanceTime(3 * EPOCH);
      await ctx.oracle.send('set', [REF_PRICE / 4n, REF_PRICE / 4n, REF_PRICE]);
      await ctx.oracle.send('setEmergency', [REF_PRICE / 10n]);
      const floor = ark.emergencyPriceFloor(carried, params.maxEpochMoveBps, 3);
      assert.equal(await ctx.registry.call('settlementPrice'), ark.settlementPrice({ breakerCleared: false, carried, twap30d: REF_PRICE / 4n, emergency: REF_PRICE / 10n, floor }));
    });

    test('a fall of the thirty-day average by half in a day fires the breaker, and not less', async () => {
      const ctx = await reportBook();
      await ctx.oracle.send('set', [REF_PRICE, REF_PRICE / 2n + 1n, REF_PRICE]);
      assert.equal(await ctx.registry.call('breakerActive'), false);
      await ctx.oracle.send('set', [REF_PRICE, REF_PRICE / 2n, REF_PRICE]);
      assert.equal(await ctx.registry.call('breakerActive'), true, '5,000 bps or more');
    });

    test('while it holds, the premium share last priced is carried rather than repriced', async () => {
      const ctx = await reportBook();
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [, marked] = await ctx.registry.call('premiumMark');
      assert.equal(marked, 3700n);

      // The bond halves and the price collapses: repriced, the share would fall.
      await ctx.bond.send('set', [1_000_000n * ONE]);
      await ctx.oracle.send('set', [REF_PRICE / 3n, REF_PRICE / 3n, REF_PRICE]);
      assert.equal(await ctx.registry.call('breakerActive'), true);
      assert.equal(await ctx.registry.call('premiumShareBps'), 3700n);
      assert.equal((await ctx.registry.call('allocation')).premiumBps, 3700n);
    });

    test('a book never marked before the breaker carries no premium at all', async () => {
      // The failure mode of a missing price is then a coupon shortfall, which
      // section 4.7 answers, rather than an over-charge nothing answers.
      const ctx = await deployStack({ stage: 4 });
      await ctx.oracle.send('set', [REF_PRICE, REF_PRICE / 2n, REF_PRICE]);
      assert.equal(await ctx.registry.call('premiumShareBps'), 0n);
    });

    test('an empty thirty-day series is no fall, and does not pin the premium at a zero mark', async () => {
      // `0 <= 0` used to read as a breaker in force, so an oracle with an epoch
      // average and no thirty-day series yet carried a mark nobody had written.
      // An empty series is no price: it is silent (yellow paper §6.1, I40,
      // "reports zero"), so the last mark is carried, as under the breaker,
      // and the next reading prices the book again (2026-10-05; before, the
      // share fell to zero with no cover measured).
      const ctx = await reportBook();
      await ctx.oracle.send('set', [REF_PRICE, 0n, 0n]);
      assert.equal(await ctx.registry.call('breakerActive'), false);
      const [, marked] = await ctx.registry.call('premiumMark');
      assert.equal(await ctx.registry.call('premiumShareBps'), marked, 'no series: the mark carried');
      await ctx.oracle.send('set', [REF_PRICE, REF_PRICE, 0n]);
      assert.equal(await ctx.registry.call('premiumShareBps'), 3700n, 'no mark was pinned');
      // A series that has fallen to nothing is still a fall.
      await ctx.oracle.send('set', [REF_PRICE, 0n, REF_PRICE]);
      assert.equal(await ctx.registry.call('breakerActive'), true);
    });

    test('a silent series carries the mark: premiumShareBps, allocation and the leaf the relayer seals all answer (I40)', async () => {
      // Yellow paper §6.1, the table of silence: capacity, cover and the
      // premium share carry the last mark. Before 2026-10-05 allocation()
      // reverted OracleSilent, and with it every root the relayer sealed.
      const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
      const ctx = await reportBook();
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [, marked] = await ctx.registry.call('premiumMark');
      assert.equal(marked, 3700n);
      const live = await ctx.registry.call('allocation');
      const [, liveLeaf] = await ctx.registry.call('currentAllocationLeaf', [ESCROW]);

      await ctx.oracle.send('setSilent', [true]);
      await assert.rejects(() => ctx.registry.call('referencePrice'), /OracleSilent/);
      await assert.rejects(() => ctx.registry.call('utilisationBps'), /OracleSilent/, 'the conditional release still leaves the epoch unobserved');
      assert.equal(await ctx.registry.call('premiumShareBps'), 3700n, 'the mark carried');
      const a = await ctx.registry.call('allocation');
      for (const f of [...ids.ALLOCATION_FIELDS.filter((x) => x !== 'sigmaBps'), 'premiumBps', 'stakerBps']) {
        assert.equal(a[f], live[f], `${f}: the carried price is the series the mark read`);
      }
      const [epoch, leaf] = await ctx.registry.call('currentAllocationLeaf', [ESCROW]);
      assert.equal(leaf, liveLeaf);
      // The relayer's check before it seals (relayer.js): the leaf rebuilt from allocation().
      const values = { escrow: ESCROW, epoch, ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, Number(f === 'sigmaBps' ? a.premiumBps : a[f])])) };
      assert.equal(ids.allocationLeaf(values), leaf);

      // The bond halves under silence: the share stays the mark; cover is the
      // book as it stands at the carried price.
      await ctx.bond.send('set', [1_000_000n * ONE]);
      assert.equal(await ctx.registry.call('premiumShareBps'), 3700n);
      const halved = await ctx.registry.call('allocation');
      assert.equal(halved.premiumBps, 3700n);
      assert.ok(halved.coveredBps < a.coveredBps, 'cover on the book as it stands');
      await assert.rejects(() => ctx.registry.send('markPremium', []), /OracleSilent/, 'a mark under silence writes nothing');
      // The series resumes: the book is priced again.
      await ctx.oracle.send('setSilent', [false]);
      assert.notEqual(await ctx.registry.call('premiumShareBps'), 3700n);
    });

    test('a failing valuation oracle blocks no release instruction and no proven deposit', async () => {
      // The release path is the product's exit and must not depend on a price.
      // The mark is refreshed where the oracle answers, and by the
      // permissionless markPremium once it answers again.
      const ctx = await reportBook();
      await ctx.registry.send('markPremium', []);
      await ctx.oracle.send('setReverting', [true]);
      await assert.rejects(() => ctx.registry.send('markPremium', []), /OracleUnavailable/);

      const leaving = stakeAssetId(CHAIN_ID, FIVE[1], ACCOUNTS.alice, ACCOUNTS.alice, 1n);
      await ctx.registry.send('instructRelease', [leaving, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal((await ctx.registry.call('anchorOf', [leaving])).status, 2n);
      const { id } = await anchor(ctx, { asset: FIVE[1], nonce: 9n, notional: ONE });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 1n);

      await ctx.oracle.send('setReverting', [false]);
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
    });

    test('an absurd price cannot block a release either', async () => {
      // An overflow in the pricing arithmetic is a revert like any other.
      const ctx = await reportBook();
      const huge = 2n ** 255n;
      await ctx.oracle.send('set', [huge, huge, huge]);
      const leaving = stakeAssetId(CHAIN_ID, FIVE[2], ACCOUNTS.alice, ACCOUNTS.alice, 2n);
      await ctx.registry.send('instructRelease', [leaving, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal((await ctx.registry.call('anchorOf', [leaving])).status, 2n);
    });

    test('a mark is the price of the book the change produced', async () => {
      const ctx = await deployStack({ stage: 4, bondQrl: 10_000_000n * ONE });
      await anchor(ctx, { notional: 100n * ONE });
      const [, marked] = await ctx.registry.call('premiumMark');
      assert.equal(marked, await ctx.registry.call('premiumShareBps'));
      assert.ok(marked > 0n);
    });

    test('the breaker suspends pricing and nothing else: anchoring and release continue', async () => {
      const ctx = await reportBook();
      await ctx.oracle.send('set', [REF_PRICE, REF_PRICE / 2n, REF_PRICE]);
      // Every group of the modelled book sits at the cap, so a release comes
      // first and the anchor after it lands in a book with room.
      const leaving = stakeAssetId(CHAIN_ID, FIVE[1], ACCOUNTS.alice, ACCOUNTS.alice, 1n);
      await ctx.registry.send('instructRelease', [leaving, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal((await ctx.registry.call('anchorOf', [leaving])).status, 2n);
      const { id } = await anchor(ctx, { asset: FIVE[0], nonce: 9n, notional: ONE });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 1n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the concentration measurement is a running maximum', () => {
    test('a one-epoch dilution does not lower the capital requirement', async () => {
      const ctx = await deployStack({ bondQrl: 5_000_000n * ONE, params: { pmlFloorBps: 1500, maxAssetShareBps: 1500 } });
      await anchor(ctx, { asset: ASSET_A, notional: 100n * ONE });
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
      ctx.chain.advanceTime(EPOCH);
      await anchor(ctx, { asset: ASSET_B, nonce: 5n, notional: 900n * ONE });
      assert.equal(await ctx.registry.call('groupAnchored', [GROUP_A]), 100n * ONE);
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
    });

    test('the window forgets a young book\'s concentration after thirteen epochs, not before', async () => {
      // The first anchor was the whole book when it arrived; the four after it
      // in the same epoch diluted it to one fifth. The high-water mark of that
      // epoch holds for thirteen, and then the book as it stands is measured.
      const ctx = await deployStack({ stage: 4, assets: fiveGroups });
      for (let i = 0; i < 5; i++) await anchor(ctx, { asset: FIVE[i], nonce: BigInt(i), notional: 200n * ONE });
      ctx.chain.advanceTime(EPOCH * 12);
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
      ctx.chain.advanceTime(EPOCH);
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), 2000n);
    });

    test('a quiet epoch carries the book\'s share, so a concentrated book is never forgotten', async () => {
      // Previously asserted zero here: a lane nobody wrote read as an epoch in
      // which the book held no concentration at all, and a book held wholly in
      // one group was measured at the loss floor after thirteen quiet epochs.
      // Whitepaper §4.3: every group's share, at its largest in the window.
      const ctx = await deployStack({ bondQrl: 5_000_000n * ONE });
      await anchor(ctx, { asset: ASSET_A, notional: 100n * ONE });
      ctx.chain.advanceTime(EPOCH * 13);
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
      ctx.chain.advanceTime(EPOCH * 40);
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
      assert.equal(await ctx.registry.call('pmlBps'), BPS);
    });

    test('a release raises the share of the groups that remain, and the measurement follows it', async () => {
      // The escrow is one-way, so releases elsewhere concentrate what is left
      // with no anchoring event at all. Measured only at anchoring, the book
      // below read 2,000 after the release although one group was a quarter.
      const ctx = await reportBook();
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), 2000n);
      const leaving = stakeAssetId(CHAIN_ID, FIVE[4], ACCOUNTS.alice, ACCOUNTS.alice, 4n);
      await ctx.registry.send('instructRelease', [leaving, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), 2500n);
      // And it is a maximum: a later anchor that dilutes the book back does not lower it.
      await anchor(ctx, { asset: FIVE[4], nonce: 9n, notional: 200n * ONE });
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), 2500n);
    });

    test('every group is measured, not only the one anchored into', async () => {
      // The largest group is what the capital is sized from, whichever group
      // moved. Measured only for the group anchored into, the dust anchor below
      // wrote a share of 12 bps into the window and the book read as diversified
      // to nothing while four groups each held a quarter of it.
      const ctx = await reportBook();
      await ctx.registry.send('instructRelease', [stakeAssetId(CHAIN_ID, FIVE[4], ACCOUNTS.alice, ACCOUNTS.alice, 4n), ACCOUNTS.alice], { from: ACCOUNTS.alice });
      ctx.chain.advanceTime(EPOCH);
      await anchor(ctx, { asset: FIVE[4], nonce: 9n, notional: ONE });
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), 2500n);
    });

    test('the list of correlation groups is bounded by governance', async () => {
      const ctx = await deployStack({ assets: [] });
      const max = Number(await ctx.registry.call('MAX_CORRELATION_GROUPS'));
      for (let i = 0; i < max; i++) {
        const asset = '0x' + (i + 1).toString(16).padStart(40, '0');
        await ctx.registry.send('admitAsset', [assetInput({ asset, group: keccak256(toUtf8Bytes(`g${i}`)) })], { from: ACCOUNTS.admin });
      }
      // A further asset in a group already listed is admitted; a new group is not.
      await ctx.registry.send('admitAsset', [assetInput({ asset: '0x' + 'ee'.repeat(20), group: keccak256(toUtf8Bytes('g0')) })], { from: ACCOUNTS.admin });
      await assert.rejects(
        () => ctx.registry.send('admitAsset', [assetInput({ asset: '0x' + 'ef'.repeat(20), group: keccak256(toUtf8Bytes('new')) })], { from: ACCOUNTS.admin }),
        /TooManyCorrelationGroups/,
      );
      assert.equal(await ctx.registry.call('correlationGroupCount'), BigInt(max));
    });

    test('a release does not lower the running maximum inside the window', async () => {
      const ctx = await deployStack({ bondQrl: 5_000_000n * ONE });
      const { id } = await anchor(ctx, { asset: ASSET_A, notional: 100n * ONE });
      await anchor(ctx, { asset: ASSET_B, nonce: 9n, notional: 300n * ONE });
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal(await ctx.registry.call('groupAnchored', [GROUP_A]), 0n, 'group A has left');
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
    });

    test('the admission cap is evaluated per correlation group, and flags rather than refuses', async () => {
      // It used to refuse with GroupCapExceeded, which stranded a deposit the
      // escrow had already taken (see 'a deposit the escrow has taken ...').
      const ctx = await deployStack({ bondQrl: 5_000_000n * ONE, params: { pmlFloorBps: 5000, maxAssetShareBps: 5000 } });
      await anchor(ctx, { asset: ASSET_B, notional: 1000n * ONE });
      await anchor(ctx, { asset: ASSET_A, nonce: 8n, notional: 900n * ONE });
      const epoch = epochNow(ctx);
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 9n);
      await ctx.attest.send('seal', [epoch, stakeLeafKey(id, 300n * ONE)]);
      const res = await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 9n, 300n * ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob });
      const [ev] = ctx.registry.events(res, 'AnchoredOutsideControls');
      assert.equal(ev.args.groupShareBps, 5455n, '1,200 of 2,200, rounded up');
      assert.equal(ev.args.capBps, 5000n);
      assert.equal(await ctx.registry.call('groupAnchored', [GROUP_A]), 1200n * ONE);
    });

    test('the cap does not bind while it is unsatisfiable', async () => {
      const ctx = await deployStack({ bondQrl: 5_000_000n * ONE });
      await anchor(ctx, { asset: ASSET_A, notional: 500n * ONE });
      assert.equal(await ctx.registry.call('activeGroups'), 1n);
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('a release moves the notional into transit at once', () => {
    test('only the bound beneficiary may instruct one', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { owner: ACCOUNTS.alice, notional: 100n * ONE });
      await assert.rejects(
        () => ctx.registry.send('instructRelease', [id, ACCOUNTS.mallory], { from: ACCOUNTS.mallory }),
        /NotBoundOwner/,
      );
    });

    test('the committed leaf changes with the recipient', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      const honest = releaseLeaf(releasePayload(id, ACCOUNTS.alice, 1n, CHAIN_ID));
      const substituted = releaseLeaf(releasePayload(id, ACCOUNTS.mallory, 1n, CHAIN_ID));
      assert.notEqual(honest, substituted);
      const res = await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal(ctx.registry.events(res, 'ReleaseInstructed')[0].args.releaseLeaf, honest);
    });

    test('D10: the anchor leaf binds the escrow it was made in, and the release leaf binds the same escrow', async () => {
      // yellow paper §2.2: every leaf binds the origin-chain address of the
      // escrow that pays it. A position is recorded with the escrow its
      // forward leaf named, and its receipt is payable there and nowhere else
      // — a successor escrow of the same asset numbers positions from the same
      // nonces, so the identifier alone would not separate them.
      const ctx = await deployStack();
      const other = '0x' + 'e6'.repeat(20);
      const epoch = epochNow(ctx);
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [epoch, stakeLeafKey(id, 100n * ONE, ESCROW)]);
      await assert.rejects(
        () => ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, other], epoch, []], { from: ACCOUNTS.bob }),
        /BadProof/,
      );
      await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob });
      assert.equal((await ctx.registry.call('anchorOf', [id])).escrow.toLowerCase(), ESCROW);
      const res = await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      const leaf = ctx.registry.events(res, 'ReleaseInstructed')[0].args.releaseLeaf;
      assert.equal(leaf, releaseLeaf(releasePayload(id, ACCOUNTS.alice, 1n, CHAIN_ID), ESCROW));
      assert.notEqual(leaf, releaseLeaf(releasePayload(id, ACCOUNTS.alice, 1n, CHAIN_ID), other));
    });

    test('D10: a buffer report and a released fact bind the escrow that emitted them', async () => {
      const ctx = await deployStack();
      const other = '0x' + 'e6'.repeat(20);
      const epoch = epochNow(ctx);
      await ctx.attest.send('seal', [epoch, bufferLeaf(CHAIN_ID, ASSET_A, epoch, ONE, other)]);
      await assert.rejects(
        () => ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, ASSET_A, epoch, ONE, []], { from: ACCOUNTS.mallory }),
        /BadProof/,
      );
      assert.notEqual(releasedLeaf('0x' + '11'.repeat(32), 1n, other), releasedLeaf('0x' + '11'.repeat(32), 1n, ESCROW));
    });

    test('the payload is bound to one chain, so a receipt is not portable', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      // The registry's own builder, reached through the harness since 2026-09-29.
      const harness = await ctx.chain.deploy('StakeMathHarness');
      assert.notEqual(
        await harness.call('releasePayload', [id, ACCOUNTS.alice, 1n, CHAIN_ID]),
        await harness.call('releasePayload', [id, ACCOUNTS.alice, 1n, 137n]),
      );
    });

    test('notional in transit is charged no premium and carries no cover (I18)', async () => {
      // Four fifths of the modelled book enters release: the priced book is two
      // hundred units in the same block, not at settlement.
      const ctx = await reportBook();
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(stakeAssetId(CHAIN_ID, FIVE[i], ACCOUNTS.alice, ACCOUNTS.alice, BigInt(i)));
      for (const id of ids) await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });

      assert.equal(await ctx.registry.call('totalAnchored'), 200n * ONE);
      assert.equal(await ctx.registry.call('totalInTransit'), 800n * ONE);
      // The book left is one group, so it is measured whole: pml 10,000, the
      // §4.3 bound reduces the indemnity to 2,466 and the requirement is 49.32
      // units — ark-staking.ts on the same book. This test used to expect 40
      // units and a ratio of 50,000, the figures of a book still measured at
      // the loss floor although four of its five groups had left.
      assert.equal(await ctx.registry.call('observedMaxGroupShareBps'), BPS);
      assert.equal(await ctx.registry.call('requiredCapital'), 4932n * ONE / 100n);
      assert.equal(await ctx.registry.call('premiumShareBps'), 3700n, 'the covered book pays the target share');
      assert.equal(await ctx.registry.call('coverageRatioBps'), 40551n);
    });

    test('an instruction is recorded during the protective freeze; only its settlement waits', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      await ctx.qday.send('setFrozen', [true]);
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      const a = await ctx.registry.call('anchorOf', [id]);
      assert.equal(a.status, 2n);
      assert.equal(a.releasableAt, BigInt(ctx.chain.timestamp) + BigInt(21 * DAY));
    });

    test('the release path closes permanently at the declaration (I15)', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
      await assert.rejects(() => ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice }), /ReleaseClosed/);
    });

    test('a release is recorded as settled only against a proof that the escrow paid it', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });

      const epoch = epochNow(ctx);
      await ctx.attest.send('seal', [epoch, releasedLeaf(id, 2n)]);
      await assert.rejects(() => ctx.registry.send('recordReleaseSettled', [id, epoch, []], { from: ACCOUNTS.bob }), /BadProof/, 'a wrong claim nonce proves nothing');

      await ctx.attest.send('seal', [epoch, releasedLeaf(id, 1n)]);
      const res = await ctx.registry.send('recordReleaseSettled', [id, epoch, []], { from: ACCOUNTS.bob });
      assert.equal(ctx.registry.events(res, 'ReleaseSettled').length, 1);
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 3n);
      assert.equal(await ctx.registry.call('totalInTransit'), 0n);

      await assert.rejects(() => ctx.registry.send('recordReleaseSettled', [id, epoch, []], { from: ACCOUNTS.bob }), /WrongStatus/);
    });

    test('a position that never instructed a release cannot be recorded as released', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      await ctx.attest.send('seal', [epochNow(ctx), releasedLeaf(id, 0n)]);
      await assert.rejects(() => ctx.registry.send('recordReleaseSettled', [id, epochNow(ctx), []], { from: ACCOUNTS.bob }), /WrongStatus/);
    });

    test('the loss and recovery leaves are the yellow paper\'s preimages, each under its own domain', async () => {
      // Built by `ArkStakeLeaves` since 2026-09-28 (the registry sealed none of
      // them and needed the bytes, gap item 19); the harness exposes it.
      const { chain } = await deployStack();
      const registry = await chain.deploy('StakeMathHarness');
      const { AbiCoder } = require('ethers');
      const coder = AbiCoder.defaultAbiCoder();
      const LOSS = keccak256(toUtf8Bytes('ARK_LOSS_V1'));
      const RECOVERY = keccak256(toUtf8Bytes('ARK_RECOVERY_V1'));
      assert.equal(await registry.call('lossDomain'), LOSS);
      assert.equal(await registry.call('recoveryDomain'), RECOVERY);
      const det = keccak256(toUtf8Bytes('determination'));
      const id = keccak256(toUtf8Bytes('a position'));
      assert.equal(
        await registry.call('lossLeaf', [CHAIN_ID, ESCROW, det, id, ACCOUNTS.alice, 7n * ONE]),
        keccak256(coder.encode(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'address', 'uint256'], [LOSS, CHAIN_ID, ESCROW, det, id, ACCOUNTS.alice, 7n * ONE])),
      );
      const rid = keccak256(toUtf8Bytes('recovery'));
      const recipient = keccak256(toUtf8Bytes('senior holder'));
      // The admitted successor state the share is paid on (whitepaper §5.4, I36).
      const SUCCESSOR = keccak256(toUtf8Bytes('successor:1'));
      assert.equal(
        await registry.call('shareLeaf', [CHAIN_ID, ESCROW, SUCCESSOR, rid, recipient, ACCOUNTS.bob, 3n * ONE]),
        keccak256(coder.encode(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32', 'address', 'uint256'], [RECOVERY, CHAIN_ID, ESCROW, SUCCESSOR, rid, recipient, ACCOUNTS.bob, 3n * ONE])),
      );
    });

    test('the released leaf is the one the relayer and the escrow build', async () => {
      // Built by ArkStakeLeaves since phase C3b (the registry's v3 bytes); the harness exposes it.
      const { chain, registry } = await deployStack();
      const harness = await chain.deploy('StakeMathHarness');
      const id = keccak256(toUtf8Bytes('a position'));
      assert.equal(await harness.call('releasedLeaf', [ESCROW, id, 3n]), releasedLeaf(id, 3n));
      assert.equal(await registry.call('RELEASED_DOMAIN'), keccak256(toUtf8Bytes('ARK_STAKE_RELEASED_V1')));
    });
  });

  /* ---------------------------------------------------------------- */
  describe('vesting', () => {
    test('a position anchored thirty days ago settles at one third', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      ctx.chain.advanceTime(30 * DAY);
      assert.equal(await ctx.registry.call('vestingBpsOf', [id]), 3333n);
    });

    test('cover is complete at ninety days and does not exceed it', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      ctx.chain.advanceTime(90 * DAY);
      assert.equal(await ctx.registry.call('vestingBpsOf', [id]), BPS);
      ctx.chain.advanceTime(365 * DAY);
      assert.equal(await ctx.registry.call('vestingBpsOf', [id]), BPS);
    });

    test('a position anchored in this block has no cover yet', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      assert.equal(await ctx.registry.call('vestingBpsOf', [id]), 0n);
    });

    /**
     * Audit 2026-09-22, G6. The record's time was the QRL block that recorded
     * it, so a deposit made before a declaration whose proof reached QRL after
     * the ratification was recorded "after T" and owed nothing. It is now the
     * close of the origin epoch the proving root is labelled with, where that
     * is earlier: never earlier than the deposit, never later than the record.
     */
    test('an anchor proven by an earlier epoch\'s root is anchored at that epoch\'s close, never later than its record (audit 2026-09-22 G6)', async () => {
      const ctx = await deployStack();
      const deposit = epochNow(ctx);
      ctx.chain.advanceTime(EPOCH + 2 * DAY);
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [deposit, stakeLeafKey(id, 100n * ONE)]);
      await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, 100n * ONE, ESCROW], deposit, []], { from: ACCOUNTS.bob });
      const closes = (deposit + 1n) * BigInt(EPOCH);
      const a = await ctx.registry.call('anchorOf', [id]);
      assert.equal(a.anchoredAt, closes);
      assert.ok(closes < BigInt(ctx.chain.timestamp), 'earlier than the record');
      if (M && M.ark.anchoredAtSeconds) {
        assert.equal(a.anchoredAt, M.ark.anchoredAtSeconds(BigInt(ctx.chain.timestamp), deposit, BigInt(EPOCH)), 'the model\'s anchoredAtSeconds');
      }
      // Cover vests from there: thirty days after the close, one third.
      ctx.chain.advanceTime(Number(closes + 30n * BigInt(DAY) - BigInt(ctx.chain.timestamp)));
      assert.equal(await ctx.registry.call('vestingBpsOf', [id]), 3333n);

      // A root of the epoch in progress: the epoch has not closed, so the
      // record's own time stands.
      const now = epochNow(ctx);
      const id2 = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 1n);
      await ctx.attest.send('seal', [now, stakeLeafKey(id2, ONE)]);
      await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 1n, ONE, ESCROW], now, []], { from: ACCOUNTS.bob });
      const b = await ctx.registry.call('anchorOf', [id2]);
      assert.ok(b.anchoredAt >= now * BigInt(EPOCH) && b.anchoredAt <= BigInt(ctx.chain.timestamp));
      if (M && M.ark.anchoredAtSeconds) {
        assert.equal(b.anchoredAt, M.ark.anchoredAtSeconds(b.anchoredAt, now, BigInt(EPOCH)), 'the record\'s own time, where the epoch is still open');
      }
      assert.equal(await ctx.registry.call('vestingBpsOf', [id2]), 0n);
    });

    /**
     * Audit 2026-09-22, G8, resolved in the papers (whitepaper §3.3, §4.3):
     * the covered notional is the one the anchor leaf proved, fixed in units
     * of the origin asset; the retained yield accrues to the position's claim
     * in the escrow and leaves with its release, outside cover. Nothing on QRL
     * moves the record.
     */
    test('the anchored notional is the one the anchor leaf proved, and time moves no quantity measured on it (audit 2026-09-22 G8)', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      ctx.chain.advanceTime(400 * DAY);
      assert.equal((await ctx.registry.call('anchorOf', [id])).anchoredNotional, 100n * ONE);
      assert.equal(await ctx.registry.call('totalAnchored'), 100n * ONE);
      assert.equal(
        await ctx.registry.call('requiredCapital'),
        (100n * ONE * (await ctx.registry.call('effectiveAttachmentBps'))) / BPS,
        'the requirement is the recorded notional at the attachment',
      );
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the admission condition of sections 3.2 and 4.5', () => {
    test('the floor is 1.09 per cent at the fourth stage on a book at the loss floor', async () => {
      const ctx = await deployStack({ stage: 4, assets: [] });
      assert.equal(await ctx.registry.call('admissionYieldFloorBps'), 109n);
    });

    test('the floor moves with the stage, because the coupon an asset funds does', async () => {
      const ctx = await deployStack({ assets: [] });
      // Stage one: attachment 1,234 against a target of 1,850.
      assert.equal(await ctx.registry.call('admissionYieldFloorBps'), 134n);
    });

    test('the boundary is the inequality itself, not a rounded floor', async () => {
      const ctx = await deployStack({ stage: 4, assets: [] });
      await assert.rejects(
        () => ctx.registry.send('admitAsset', [assetInput({ yieldBps: 108 })], { from: ACCOUNTS.admin }),
        /YieldBelowAdmissionFloor/,
      );
      await ctx.registry.send('admitAsset', [assetInput({ yieldBps: 109 })], { from: ACCOUNTS.admin });
    });

    test('the observed liquid staking rate clears the floor with room', async () => {
      const ctx = await deployStack({ stage: 4, assets: [] });
      await ctx.registry.send('admitAsset', [assetInput({ yieldBps: 220 })], { from: ACCOUNTS.admin });
      assert.equal(await ctx.registry.call('couponAtExactCoverBps', [220n]), 407n);
    });

    test('the floor rises as the book concentrates, because the attachment does', async () => {
      const ctx = await deployStack({ stage: 4, bondQrl: 10_000_000n * ONE, assets: [{ asset: ASSET_A, group: GROUP_A }] });
      const before = await ctx.registry.call('admissionYieldFloorBps');
      await anchor(ctx, { notional: 100n * ONE });
      assert.ok((await ctx.registry.call('admissionYieldFloorBps')) > before);
    });

    test('no QRL staking rate reaches the registry at all', async () => {
      // Section 4.5 moved the admission condition from the staking rate to the
      // floor under the tail-risk premium; nothing here takes the rate, so the
      // exclusion of section 4.5 cannot be undone through this contract.
      const { registry } = await deployStack({ assets: [] });
      const inputs = registry.iface.fragments
        .filter((f) => f.type === 'function')
        .flatMap((f) => f.inputs.flatMap((i) => [i.name, ...(i.components || []).map((c) => c.name)]));
      assert.ok(!inputs.some((n) => /qrl.*rate|stakingrate/i.test(n)), inputs.join(','));
    });

    test('the audit figure is kept on the profile and emitted with the decision', async () => {
      const ctx = await deployStack({ stage: 4, assets: [] });
      const res = await ctx.registry.send('admitAsset', [assetInput({ yieldBps: 220 })], { from: ACCOUNTS.admin });
      const [ev] = ctx.registry.events(res, 'AssetAdmitted');
      assert.equal(ev.args.yieldFloorBps, 220n);
      assert.equal(ev.args.couponFloorBps, 109n);
      const profile = await ctx.registry.call('assetProfile', [await ctx.registry.call('assetKey', [CHAIN_ID, ASSET_A])]);
      assert.equal(profile.yieldFloorBps, 220n);
      assert.equal(profile.asset.toLowerCase(), ASSET_A);
    });

    test('an asset the escrow cannot call a transfer on is refused', async () => {
      const ctx = await deployStack({ assets: [] });
      await assert.rejects(
        () => ctx.registry.send('admitAsset', [assetInput({ transferVerified: false })], { from: ACCOUNTS.admin }),
        /TransferNotVerified/,
      );
    });

    test('only governance admits, an asset is admitted once, and it must name a group', async () => {
      const ctx = await deployStack({ assets: [] });
      await assert.rejects(() => ctx.registry.send('admitAsset', [assetInput()], { from: ACCOUNTS.mallory }), /OnlyGovernance/);
      await assert.rejects(
        () => ctx.registry.send('admitAsset', [assetInput({ group: '0x' + '00'.repeat(32) })], { from: ACCOUNTS.admin }),
        /ZeroValue/,
      );
      await ctx.registry.send('admitAsset', [assetInput()], { from: ACCOUNTS.admin });
      await assert.rejects(() => ctx.registry.send('admitAsset', [assetInput()], { from: ACCOUNTS.admin }), /AssetAlreadyAdmitted/);
    });

    test('de-listing closes the inflow and touches nothing already anchored', async () => {
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      const key = await ctx.registry.call('assetKey', [CHAIN_ID, ASSET_A]);
      const res = await ctx.registry.send('delistAsset', [key], { from: ACCOUNTS.admin });
      assert.equal(ctx.registry.events(res, 'AssetDelisted')[0].args.reason, 0n);
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      // The inflow is closed at the escrow, by the de-listing leaf. A deposit
      // the escrow took before that leaf reached it is recorded here all the
      // same (it used to be refused with AssetNotAdmitted and stranded), and
      // it is flagged.
      const late = await anchor(ctx, { nonce: 1n, notional: ONE });
      assert.equal((await ctx.registry.call('anchorOf', [late.id])).status, 1n);
    });

    test('a de-listed asset re-admitted under another group releases its old positions from the old group', async () => {
      // The group is fixed in the record at anchoring. Read from the live
      // profile instead, the release below took 100 units out of GROUP_B,
      // which held none of them, and underflowed.
      const ctx = await deployStack();
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      assert.equal((await ctx.registry.call('anchorOf', [id])).correlationGroup, GROUP_A);
      const key = await ctx.registry.call('assetKey', [CHAIN_ID, ASSET_A]);
      await ctx.registry.send('delistAsset', [key], { from: ACCOUNTS.admin });
      await ctx.registry.send('admitAsset', [assetInput({ group: GROUP_B })], { from: ACCOUNTS.admin });
      await anchor(ctx, { asset: ASSET_B, nonce: 3n, notional: 50n * ONE });
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal(await ctx.registry.call('groupAnchored', [GROUP_A]), 0n);
      assert.equal(await ctx.registry.call('groupAnchored', [GROUP_B]), 50n * ONE);
      assert.equal(await ctx.registry.call('activeGroups'), 1n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the yield condition is re-evaluated each epoch', () => {
    const key = (ctx) => ctx.registry.call('assetKey', [CHAIN_ID, ASSET_A]);

    test('four consecutive failing epochs close the asset to new anchoring', async () => {
      const ctx = await deployStack({ stage: 4 });
      await ctx.oracle.send('setYield', [CHAIN_ID, ASSET_A, 100n]);
      const k = await key(ctx);
      for (let i = 1; i <= 3; i++) {
        await ctx.registry.send('reviewAsset', [k], { from: ACCOUNTS.mallory });
        assert.equal((await ctx.registry.call('assetProfile', [k])).failingEpochs, BigInt(i));
        assert.equal((await ctx.registry.call('assetProfile', [k])).admitted, true);
        ctx.chain.advanceTime(EPOCH);
      }
      const res = await ctx.registry.send('reviewAsset', [k], { from: ACCOUNTS.mallory });
      assert.equal(ctx.registry.events(res, 'AssetDelisted')[0].args.reason, 1n);
      assert.equal((await ctx.registry.call('assetProfile', [k])).admitted, false);
      // Closing the inflow is the escrow's, through the de-listing leaf; a
      // deposit that reached the escrow first is recorded and flagged.
      const epoch = epochNow(ctx);
      const id = stakeAssetId(CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n);
      await ctx.attest.send('seal', [epoch, stakeLeafKey(id, ONE)]);
      const rec = await ctx.registry.send('recordAnchor', [[CHAIN_ID, ASSET_A, ACCOUNTS.alice, ACCOUNTS.alice, 0n, ONE, ESCROW], epoch, []], { from: ACCOUNTS.bob });
      assert.equal(ctx.registry.events(rec, 'AnchoredOutsideControls')[0].args.delisted, true);
    });

    test('an epoch that clears the floor starts the count again', async () => {
      const ctx = await deployStack({ stage: 4 });
      const k = await key(ctx);
      await ctx.oracle.send('setYield', [CHAIN_ID, ASSET_A, 100n]);
      for (let i = 0; i < 3; i++) {
        await ctx.registry.send('reviewAsset', [k]);
        ctx.chain.advanceTime(EPOCH);
      }
      await ctx.oracle.send('setYield', [CHAIN_ID, ASSET_A, 220n]);
      await ctx.registry.send('reviewAsset', [k]);
      assert.equal((await ctx.registry.call('assetProfile', [k])).failingEpochs, 0n);
    });

    test('an unreviewed epoch breaks the run rather than being assumed failed', async () => {
      const ctx = await deployStack({ stage: 4 });
      const k = await key(ctx);
      await ctx.oracle.send('setYield', [CHAIN_ID, ASSET_A, 100n]);
      await ctx.registry.send('reviewAsset', [k]);
      ctx.chain.advanceTime(EPOCH);
      await ctx.registry.send('reviewAsset', [k]);
      ctx.chain.advanceTime(2 * EPOCH);
      await ctx.registry.send('reviewAsset', [k]);
      assert.equal((await ctx.registry.call('assetProfile', [k])).failingEpochs, 1n);
    });

    /**
     * Audit 2026-09-22, G9. The review read the attachment on the book as it
     * stood when the first caller of the epoch chose to call, so the caller
     * chose the verdict: waiting for (or making) an anchor into one group
     * raised the concentration lane of the epoch in progress, the attachment
     * and the floor with it. The verdict is now the epoch's alone.
     */
    test('the verdict is the epoch\'s: the closed epochs\' concentration, never a book the caller waits for (audit 2026-09-22 G9)', async () => {
      // Five groups at 2,000 bps each, the window past their first anchors:
      // the measured share rests on the loss floor. At the fourth stage the
      // attachment is min(pml, 2 sigma / 3), so it moves between 2,000 and
      // 2,467 bps, and the floor with it.
      const ctx = await reportBook();
      const k = await ctx.registry.call('assetKey', [CHAIN_ID, FIVE[0]]);
      const opening = await ctx.registry.call('admissionYieldFloorBps');

      // One anchor into the first group inside the epoch: its lane rises, and
      // with it the floor the book prices at now.
      await anchor(ctx, { asset: FIVE[0], nonce: 7n, notional: 200n * ONE });
      const now = await ctx.registry.call('admissionYieldFloorBps');
      assert.ok(now > opening, `the floor rose within the epoch: ${opening} -> ${now}`);

      // A yield at the opening floor fails the book as it stands and clears
      // the epoch's condition, which is the one reviewed, whoever calls.
      await ctx.oracle.send('setYield', [CHAIN_ID, FIVE[0], opening]);
      const res = await ctx.registry.send('reviewAsset', [k], { from: ACCOUNTS.mallory });
      const [ev] = ctx.registry.events(res, 'AssetReviewed');
      assert.equal(ev.args.yieldFloorBps, opening);
      assert.equal((await ctx.registry.call('assetProfile', [k])).failingEpochs, 0n);

      // The next epoch's opening carries the closed spike, and fails it.
      ctx.chain.advanceTime(EPOCH);
      await ctx.registry.send('reviewAsset', [k]);
      assert.equal((await ctx.registry.call('assetProfile', [k])).failingEpochs, 1n);
    });

    test('an asset is reviewed at most once an epoch, by anyone', async () => {
      const ctx = await deployStack({ stage: 4 });
      const k = await key(ctx);
      await ctx.oracle.send('setYield', [CHAIN_ID, ASSET_A, 220n]);
      await ctx.registry.send('reviewAsset', [k], { from: ACCOUNTS.mallory });
      await assert.rejects(() => ctx.registry.send('reviewAsset', [k], { from: ACCOUNTS.bob }), /AlreadyReviewed/);
    });

    test('a de-listing on yield leaves every position releasable', async () => {
      const ctx = await deployStack({ stage: 4 });
      const { id } = await anchor(ctx, { notional: 100n * ONE });
      const k = await key(ctx);
      await ctx.oracle.send('setYield', [CHAIN_ID, ASSET_A, 0n]);
      for (let i = 0; i < 4; i++) {
        await ctx.registry.send('reviewAsset', [k]);
        ctx.chain.advanceTime(EPOCH);
      }
      await ctx.registry.send('instructRelease', [id, ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal((await ctx.registry.call('anchorOf', [id])).status, 2n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the allocation carried to the escrow', () => {
    test('the shares sum to BPS, the levy among them, and the juror fraction travels with them', async () => {
      const ctx = await reportBook();
      const a = await ctx.registry.call('allocation');
      assert.equal(a.stakerBps + a.premiumBps + a.bufferBps + a.operationsBps + a.levyBps, BPS);
      assert.equal(a.jurorFeeShareBps, 2000n);
      const launch = await deployStack({ stage: 1 });
      await anchor(launch, { notional: 100n * ONE });
      const b = await launch.registry.call('allocation');
      assert.equal(b.levyBps, 200n);
      assert.equal(b.stakerBps + b.premiumBps + b.bufferBps + b.operationsBps + b.levyBps, BPS, 'the staker residual is net of the levy');
    });

    test('gap item 19: the leaf carries the rung, the cover, the reserve cap factor and the commitment term', async () => {
      const ctx = await reportBook({ bondQrl: 1_800_000n * ONE });
      const a = await ctx.registry.call('allocation');
      assert.equal(a.sigmaTargetBps, await ctx.registry.call('sigmaTargetBps'), 'the rung, unscaled');
      assert.equal(a.coveredBps, await ctx.registry.call('coveredBps'));
      assert.ok(a.coveredBps < BPS);
      const p = REFERENCE_PARAMS;
      assert.equal(a.psrCapBps, BigInt(p.psrCapEpochs * (p.threatStage4Bps - p.threatStage1Bps)), 'psrCapEpochs * (sigma_4 - sigma_1)');
      assert.equal(a.commitTermEpochs, BigInt(p.commitmentTermEpochs));
      const [epoch, leaf] = await ctx.registry.call('currentAllocationLeaf', [ESCROW]);
      assert.equal(leaf, allocationLeaf(epoch, a));
    });

    test('the leaf an attester seals is the one computed off chain', async () => {
      const ctx = await reportBook();
      const [epoch, leaf] = await ctx.registry.call('currentAllocationLeaf', [ESCROW]);
      assert.equal(epoch, epochNow(ctx));
      const a = await ctx.registry.call('allocation');
      assert.equal(a.premiumBps, 3700n);
      assert.equal(leaf, allocationLeaf(epoch, a));
    });

    test('the buffer share escalates with the conversion haircut, and the leaf carries it', async () => {
      // Whitepaper §4.2: 250 + 1,250 * h_fx / h_max, inside the range §6.3
      // admits; the leaf's format is unchanged, its buffer field is escalated.
      // The buffer at a tenth of K, so the ramp of EC-05 is not in force.
      const ctx = await reportBook();
      await recordBuffer(ctx, { asset: FIVE[0], units: 20n * ONE });
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 1250n]);
      assert.equal(await ctx.registry.call('bufferShareInForceBps'), 875n);
      const a = await ctx.registry.call('allocation');
      assert.equal(a.bufferBps, 875n);
      assert.equal(a.stakerBps + a.premiumBps + a.bufferBps + a.operationsBps, BPS, 'the staker residual pays for it');
      const [epoch, leaf] = await ctx.registry.call('currentAllocationLeaf', [ESCROW]);
      assert.equal(leaf, allocationLeaf(epoch, { ...a.toObject(), bufferBps: 875 }));
      // At the haircut cap, and past it, the share is the top of the range.
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 4000n]);
      assert.equal(await ctx.registry.call('bufferShareInForceBps'), 1500n);
      await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), 0n]);
      assert.equal(await ctx.registry.call('bufferShareInForceBps'), 250n);
    });

    test('the stabilization levy is in force below the fourth stage and not at it', async () => {
      const launch = await deployStack({ stage: 1 });
      assert.equal(await launch.registry.call('stabilizationLevyInForceBps'), 200n);
      const top = await deployStack({ stage: 4 });
      assert.equal(await top.registry.call('stabilizationLevyInForceBps'), 0n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('the boundary readings and the censorship window (EC-01, PV-03, PV-07)', () => {
    test('the first touch after a boundary records its reading once; a later caller moves nothing, and the breaker records none', async () => {
      const ctx = await reportBook();
      const e = epochNow(ctx);
      F_next(ctx);
      const res = await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      const [ev] = ctx.registry.events(res, 'BoundaryReading');
      assert.equal(ev.args.epoch, e + 1n);
      assert.equal(ev.args.price, REF_PRICE);
      // The series moves inside the epoch: the boundary's reading stands.
      await ctx.oracle.send('set', [REF_PRICE / 2n, REF_PRICE / 2n, REF_PRICE / 2n]);
      const again = await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      assert.equal(ctx.registry.events(again, 'BoundaryReading').length, 0, 'read once per boundary');
      assert.deepEqual([...(await ctx.registry.call('readingFrom', [e + 1n]))], [REF_PRICE, e + 1n]);
      // A boundary first touched under the breaker records no reading, and
      // the first reading after it is the one a later epoch reads.
      await ctx.oracle.send('set', [REF_PRICE / 4n, REF_PRICE / 4n, REF_PRICE]);
      assert.equal(await ctx.registry.call('breakerActive'), true);
      F_next(ctx);
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      assert.deepEqual([...(await ctx.registry.call('readingFrom', [e + 2n]))], [0n, 0n], 'none yet at or after e + 2');
      await ctx.oracle.send('set', [REF_PRICE / 4n, REF_PRICE / 4n, REF_PRICE / 4n]);
      F_next(ctx);
      await ctx.registry.send('markPremium', [], { from: ACCOUNTS.mallory });
      assert.deepEqual([...(await ctx.registry.call('readingFrom', [e + 2n]))], [REF_PRICE / 4n, e + 3n], 'the first later reading');
    });

    test('N_A + N_T,max is the largest anchored notional over the censorship window: a release leaves the level it left behind', async () => {
      const ctx = await deployStack();
      const a = await anchor(ctx, { notional: 100n * ONE });
      await anchor(ctx, { nonce: 1n, notional: 50n * ONE });
      assert.equal(await ctx.registry.call('censorshipNotionalMax'), 150n * ONE);
      F_next(ctx, 2);
      await ctx.registry.send('instructRelease', [a.id, '0x' + '33'.repeat(20)], { from: ACCOUNTS.alice });
      assert.equal(await ctx.registry.call('totalAnchored'), 50n * ONE);
      assert.equal(await ctx.registry.call('censorshipNotionalMax'), 150n * ONE, 'the transit is still inside the window');
      // Six epochs (the window, CENSORSHIP_WINDOW_EPOCHS) after the release the level it left is out of reach.
      F_next(ctx, 5);
      assert.equal(await ctx.registry.call('censorshipNotionalMax'), 150n * ONE);
      F_next(ctx, 1);
      assert.equal(await ctx.registry.call('censorshipNotionalMax'), 50n * ONE);
    });
  });

  describe('the origin-asset buffer, carried forward from the escrow', () => {
    test('a proven buffer stands beside bond principal in cover and capacity', async () => {
      // Whitepaper §4.3: u = K / (N^cap_30 + buffer_orig). 90 units of bond
      // against 200 required is 45 per cent; 45 units of buffer beside it, 67.5.
      const ctx = await reportBook({ bondQrl: 900_000n * ONE });
      assert.equal(await ctx.registry.call('coveredBps'), 4500n);
      const res = await recordBuffer(ctx, { asset: FIVE[0], units: 45n * ONE });
      const [ev] = ctx.registry.events(res, 'BufferRecorded');
      assert.equal(ev.args.bufferOrig, 45n * ONE);
      assert.equal(await ctx.registry.call('bufferOrig'), 45n * ONE);
      assert.equal(await ctx.registry.call('coveredBps'), 6750n);
      assert.equal(await ctx.registry.call('capacity'), 675n * ONE);
      // The requirement does not move: the buffer is capital beside it (I11).
      assert.equal(await ctx.registry.call('requiredCapital'), 200n * ONE);
      // The mark followed the book the report produced.
      const [, marked] = await ctx.registry.call('premiumMark');
      assert.equal(marked, await ctx.registry.call('premiumShareBps'));
    });

    test('the leaf is the one the escrow and the relayer build', async () => {
      const { chain, registry } = await deployStack();
      assert.equal(await registry.call('BUFFER_DOMAIN'), keccak256(toUtf8Bytes('ARK_STAKE_BUFFER_V1')));
      const harness = await chain.deploy('StakeMathHarness');
      assert.equal(await harness.call('bufferLeaf', [CHAIN_ID, ESCROW, ASSET_A, 2900n, 7n * ONE]), bufferLeaf(CHAIN_ID, ASSET_A, 2900n, 7n * ONE));
    });

    test('an unproven buffer is refused, and so is one for an asset never admitted', async () => {
      const ctx = await reportBook({ bondQrl: 900_000n * ONE });
      const epoch = epochNow(ctx);
      await ctx.attest.send('seal', [epoch, bufferLeaf(CHAIN_ID, FIVE[0], epoch, ONE)]);
      await assert.rejects(
        () => ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, FIVE[0], epoch, 1000n * ONE, []], { from: ACCOUNTS.mallory }),
        /BadProof/,
        'a quantity the root does not carry',
      );
      const stranger = '0x' + 'cd'.repeat(20);
      await ctx.attest.send('seal', [epoch, bufferLeaf(CHAIN_ID, stranger, epoch, ONE)]);
      await assert.rejects(
        () => ctx.registry.send('recordBuffer', [CHAIN_ID, ESCROW, stranger, epoch, ONE, []], { from: ACCOUNTS.mallory }),
        /AssetNotAdmitted/,
      );
      assert.equal(await ctx.registry.call('bufferOrig'), 0n);
    });

    test('a report replaces the asset\'s last one and never an older report a newer one', async () => {
      // The adversarial case: a report withheld and replayed after a loss
      // settlement drew the buffer down would restore a buffer the escrow no
      // longer holds and overstate cover.
      const ctx = await reportBook({ bondQrl: 900_000n * ONE });
      const early = epochNow(ctx);
      await recordBuffer(ctx, { asset: FIVE[0], units: 45n * ONE, epoch: early });
      await recordBuffer(ctx, { asset: FIVE[1], units: 5n * ONE, epoch: early });
      assert.equal(await ctx.registry.call('bufferOrig'), 50n * ONE, 'summed across assets');

      ctx.chain.advanceTime(EPOCH);
      await recordBuffer(ctx, { asset: FIVE[0], units: 10n * ONE });
      assert.equal(await ctx.registry.call('bufferOrig'), 15n * ONE, 'replaced, not added');
      const key = await ctx.registry.call('assetKey', [CHAIN_ID, FIVE[0]]);
      const [units, at] = await ctx.registry.call('bufferOf', [key]);
      assert.equal(units, 10n * ONE);
      assert.equal(at, early + 1n);

      await assert.rejects(() => recordBuffer(ctx, { asset: FIVE[0], units: 45n * ONE, epoch: early }), /BufferReportNotNewer/);
      await assert.rejects(() => recordBuffer(ctx, { asset: FIVE[0], units: 45n * ONE, epoch: early + 1n }), /BufferReportNotNewer/, 'nor a second in one epoch');
      assert.equal(await ctx.registry.call('bufferOrig'), 15n * ONE);
    });

    test('a buffer makes no cover on a book with no bond', async () => {
      // Whitepaper §4.7: a position on a book with no bond pays no premium and
      // holds no cover; the buffer stands beside bond principal, never in its place.
      const ctx = await reportBook({ bondQrl: 0n });
      await recordBuffer(ctx, { asset: FIVE[0], units: 1000n * ONE });
      assert.equal(await ctx.registry.call('coveredBps'), 0n);
      assert.equal(await ctx.registry.call('capacity'), 0n);
      assert.equal(await ctx.registry.call('premiumShareBps'), 0n);
      assert.equal(await ctx.registry.call('utilisationBps'), 9007199254740991n);
    });
  });

  /* ---------------------------------------------------------------- */
  describe('wiring', () => {
    test('dependencies are named once, by the deployer', async () => {
      const ctx = await deployStack();
      await assert.rejects(
        () => ctx.registry.send('setDependencies', [ctx.attest.address, ctx.qday.address, ctx.oracle.address, ctx.bond.address], { from: ACCOUNTS.admin }),
        /AlreadySet/,
      );
    });

    test('the parameter set is fixed at construction', async () => {
      const ctx = await deployStack();
      assert.equal((await ctx.registry.call('PARAMS')).toLowerCase(), ctx.params.address.toLowerCase());
      const names = ctx.registry.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
      assert.ok(!names.includes('setParams') && !names.includes('setThreatStage'), 'no parameter setter on the registry');
    });
  });

  /* ---------------------------------------------------------------- */
  describe('agreement with the specification model', () => {
    test('the contract matches ark-staking.ts across stages, books, haircuts and the gate', async (t) => {
      // The single most valuable test here: it catches a divergence between the
      // specification and the implementation without anyone re-reading either.
      if (!M) return t.skip(MISSING);
      const { ark, params } = M;
      const ladder = [1850, 2500, 3000, 3700];
      const books = [
        { anchored: 100n * ONE, bond: 200_000n * ONE },
        { anchored: 500n * ONE, bond: 1_000_000n * ONE },
        { anchored: 500n * ONE, bond: 400_000n * ONE },
        { anchored: 900n * ONE, bond: 1_000_001n * ONE },
        { anchored: 1n * ONE, bond: 3n * ONE },
      ];
      let n = 0;
      for (const stage of [1, 2, 4]) {
        for (const b of books) {
          for (const [haircut, gate, buffer] of [[0, false, 0n], [1800, true, 0n], [700, false, 13n * ONE]]) {
            if (n++ % 2 === 1 && stage !== 4) continue;
            const ctx = await deployStack({ bondQrl: b.bond, stage, assets: [{ asset: ASSET_A, group: GROUP_A }] });
            await anchor(ctx, { notional: b.anchored });
            await ctx.oracle.send('setDrawdown', [BigInt(90 * DAY), BigInt(haircut)]);
            await ctx.bond.send('setGateClosed', [gate]);
            if (buffer > 0n) await recordBuffer(ctx, { asset: ASSET_A, units: buffer });

            const p = { ...params, sigmaTargetBps: ladder[stage - 1] };
            const book = {
              anchoredNotional: b.anchored,
              bondNotional: b.bond,
              refPrice: REF_PRICE,
              maxAssetShareBps: Number(await ctx.registry.call('observedMaxGroupShareBps')),
              fxHaircutBps: haircut,
              bufferOrig: buffer,
            };
            const ceiling = ark.premiumCeilingInForceBps(p, gate);
            const covered = ark.coveredBps(p, book);
            const label = `stage ${stage} anchored ${b.anchored} bond ${b.bond} h ${haircut} gate ${gate} buffer ${buffer}`;
            // The ramp of §4.2 (EC-05): below a tenth of K the buffer share is its seeding value.
            const belowRampThreshold = ark.bufferBelowRampThreshold(p, buffer, ark.requiredCapital(p, book));
            const m = ark.modelBook(p, book, 400, ceiling, { stage, haircutBps: haircut, belowRampThreshold });

            assert.equal(await ctx.registry.call('pmlBps'), BigInt(m.pmlBps), `pml ${label}`);
            assert.equal(await ctx.registry.call('effectiveIndemnityBps'), BigInt(m.indemnityBps), `indemnity ${label}`);
            assert.equal(await ctx.registry.call('effectiveAttachmentBps'), BigInt(ark.effectiveAttachmentBps(p, book)), `att ${label}`);
            assert.equal(await ctx.registry.call('requiredCapital'), ark.requiredCapital(p, book), `required ${label}`);
            assert.equal(await ctx.registry.call('bondCapacityInOrigin'), m.bondCapacityInOrigin, `capacity conversion ${label}`);
            assert.equal(await ctx.registry.call('capacity'), ark.capacity(p, book), `capacity ${label}`);
            assert.equal(await ctx.registry.call('coverageRatioBps'), BigInt(ark.coverageRatioBps(p, book)), `ratio ${label}`);
            assert.equal(await ctx.registry.call('coveredBps'), BigInt(covered), `covered ${label}`);
            assert.equal(await ctx.registry.call('premiumShareBps'), BigInt(ark.premiumShareBps(p, covered, ceiling)), `premium ${label}`);
            assert.equal(await ctx.registry.call('premiumTargetBps'), BigInt(ark.premiumTargetBps(p, covered, ceiling)), `target ${label}`);
            assert.equal(await ctx.registry.call('utilisationBps'), BigInt(ark.utilisationBps(p, book)), `utilisation ${label}`);
            const a = await ctx.registry.call('allocation');
            assert.equal(a.bufferBps, BigInt(m.allocation.bufferBps), `buffer share ${label}`);
            // The levy is in the leaf since phase C2 (gap item 19): the staker
            // share is the residual net of it, `allocate` of the model.
            const levy = await ctx.registry.call('stabilizationLevyInForceBps');
            assert.equal(levy, BigInt(m.allocation.levyBps), `levy ${label}`);
            assert.equal(a.levyBps, levy, `levy in the leaf ${label}`);
            assert.equal(a.stakerBps, BigInt(m.allocation.stakerBps), `staker ${label}`);
            assert.equal(await ctx.registry.call('couponMultipleBps'), BigInt(ark.couponMultipleBps(p, book)), `multiple ${label}`);
          }
        }
      }
    });
  });
});
