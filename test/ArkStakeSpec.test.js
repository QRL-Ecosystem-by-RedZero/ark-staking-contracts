/**
 * The integer arithmetic of the Ark Staking whitepaper, checked against the
 * figures the specification signs and against the specification's own model.
 *
 * The one rule this file exists to defend: **every worked figure of the scenario
 * report, and every output of `../quantum-ark/src/lib/ark-staking.ts` on the
 * inputs swept here, is what `ArkStakeMath` computes.**
 *
 * Two kinds of evidence, deliberately. The literal figures are read out of the
 * scenario report (`/docs/staking/scenarios`, revision of 2026-09-17), so a
 * drift in the model and the contract together would still fail here. The
 * sweep calls the model itself beside the contract, so a disagreement anywhere
 * in the input space fails without anyone re-reading either. Every call goes
 * through `StakeMathHarness`, which forwards and adjusts nothing: both
 * libraries are `internal`, and the registry exposes only the pricing path.
 *
 * What this file cannot show is that anything calls the settlement, recovery
 * and class arithmetic in the right order with the right book. `ArkCatBond`
 * does not exist yet, so that test arrives with it.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Chain } = require('./harness');
const { loadModel, MISSING } = require('./spec-model');

const BPS = 10000n;
const UNIT = 10n ** 18n;
const DAY = 24 * 60 * 60;

/** The scenario report's book: ten thousand QRL to one unit of the origin asset. */
const REF_PRICE = 10_000n * UNIT;

/** The origin yield the report models, and the observed one. */
const Y_A = 400n;
const Y_OBS = 220n;

/** The reference values of whitepaper chapter 6 that the arithmetic reads. */
const SIGMA_4 = 3700n;
/** rho, the slope ratio (EC-07): 1,850 bps of slope at the fourth stage's 3,700, the absolute slope it replaced. */
const RATIO = 5000n;
const CEILING = 7400n;
const SURGE = 8500n;
const TAIL_FLOOR = 200n;
const INDEMNITY = 10000n;
const PML_FLOOR = 2000n;
const BUFFER = 250n;
const OPERATIONS = 250n;
const JUNIOR = 7000n;
const SENIOR = 200n;
const MOVE = 2500n;
const STEP = 500n;
const RESERVE_FLOOR = 5000n;
/** d_first, the first offering's rung since 2026-09-30 (EC-03). */
const FIRST = 400n;

/** The book at the loss floor: pml 2,000, indemnity complete, attachment 2,000. */
const PML = 2000n;
const ATTACHMENT = 2000n;

/** Units of the origin asset, exactly; nine digits cover every figure the report prints. */
const units = (value) => (BigInt(Math.round(value * 1e9)) * UNIT) / 1_000_000_000n;
/** Units of the origin asset, converted to QRL at the reference price. */
const asQrl = (u) => units(u * 10_000);

let math;
let chain;
let M;

before(async () => {
  chain = await Chain.create();
  math = await chain.deploy('StakeMathHarness');
  M = await loadModel();
});

const pair = (r) => [BigInt(r[0]), BigInt(r[1])];

/** Covered fraction on the modelled book, at the loss floor. */
const coveredOf = (bondUnits, anchoredUnits) =>
  math.call('coveredBps', [asQrl(bondUnits), REF_PRICE, units(anchoredUnits * 0.2), 0n, 0n]);
const premiumOf = (covered, sigma = SIGMA_4, ceiling = CEILING) =>
  math.call('premiumShareBps', [sigma, RATIO, ceiling, covered]);

/* ==================================================================== */
describe('the scenario report, part 1 — the modelled book and its calibration', () => {
  test('one thousand units anchored require two hundred at the fourth stage', async () => {
    const pml = await math.call('pmlBps', [PML_FLOOR, 0n]);
    const indem = await math.call('effectiveIndemnityBps', [SIGMA_4, INDEMNITY, pml]);
    const att = await math.call('effectiveAttachmentBps', [indem, pml]);
    assert.equal(pml, 2000n);
    assert.equal(indem, 10000n, 'the indemnity is complete at the loss floor');
    assert.equal(att, ATTACHMENT);
    assert.equal(await math.call('requiredCapital', [units(1000), att]), units(200));
  });

  test('the coupon multiple is 1.85 times the origin yield at the loss floor', async () => {
    assert.equal(await math.call('couponMultipleBps', [SIGMA_4, ATTACHMENT]), 18500n);
  });

  test('the sensitivity table holds at every origin yield it states', async () => {
    // Staker return at complete cover is 5,800 bps of the yield; the coupon at
    // exact cover is 1.85 times it. The total return adds the 3.675 per cent
    // staking distribution, which this test adds and the library never sees.
    const rows = [
      [150n, 87n, 277n, 644n],
      [220n, 127n, 407n, 774n],
      [400n, 232n, 740n, 1107n],
      [500n, 290n, 925n, 1292n],
    ];
    const staker = await math.call('stakerShareBps', [BUFFER, OPERATIONS, SIGMA_4]);
    assert.equal(staker, 5800n);
    for (const [y, stakerReturn, coupon, total] of rows) {
      assert.equal((staker * y) / BPS, stakerReturn, `staker at ${y}`);
      const c = await math.call('maxCouponRateBps', [SIGMA_4, ATTACHMENT, y]);
      assert.equal(c, coupon, `coupon at ${y}`);
      assert.equal(c + 367n, total, `total return at ${y}`);
    }
  });

  test('the admission floor of section 4.5 is 1.09 per cent', async () => {
    // y_A >= Delta_min * att_eff / sigma_t, the least integer clearing it.
    assert.equal((TAIL_FLOOR * ATTACHMENT + SIGMA_4 - 1n) / SIGMA_4, 109n);
    assert.ok((await math.call('maxCouponRateBps', [SIGMA_4, ATTACHMENT, 109n])) >= TAIL_FLOOR);
    assert.ok((await math.call('maxCouponRateBps', [SIGMA_4, ATTACHMENT, 108n])) < TAIL_FLOOR);
  });
});

/* ==================================================================== */
describe('part 2 — rollover failure on the bond leg', () => {
  test('successive rollover failures reprice the book as the report states', async () => {
    const rows = [
      // bond units, cover, premium, staker return, coupon
      [300, 15000n, 3700n, 232n, 493n],
      [180, 9000n, 3515n, 239n, 781n],
      [90, 4500n, 2682n, 272n, 1192n],
    ];
    for (const [bond, cover, premium, staker, coupon] of rows) {
      const ratio = await math.call('coverageRatioBps', [asQrl(bond), REF_PRICE, units(200), 0n, 0n]);
      assert.equal(ratio, cover, `cover at ${bond}`);
      const covered = await coveredOf(bond, 1000);
      const sigma = await premiumOf(covered);
      assert.equal(sigma, premium, `premium at ${bond}`);
      const share = await math.call('stakerShareBps', [BUFFER, OPERATIONS, sigma]);
      assert.equal((share * Y_A) / BPS, staker, `staker at ${bond}`);
      assert.equal(await math.call('couponRateBps', [units(1000), units(bond), sigma, Y_A]), coupon, `coupon at ${bond}`);
    }
  });

  test('the failures the maturity ladder admits reprice the book as the report states', async () => {
    const rows = [
      [225, 11250n, 3700n, 657n],
      [168.75, 8437n, 3410n, 808n],
    ];
    for (const [bond, cover, premium, coupon] of rows) {
      assert.equal(await math.call('coverageRatioBps', [asQrl(bond), REF_PRICE, units(200), 0n, 0n]), cover);
      const sigma = await premiumOf(await coveredOf(bond, 1000));
      assert.equal(sigma, premium);
      assert.equal(await math.call('couponRateBps', [units(1000), units(bond), sigma, Y_A]), coupon);
    }
  });

  test('a contracting bond raises the coupon of the principal that remains', async () => {
    let previous = 0n;
    for (const bond of [300, 225, 200, 180, 150, 120, 90, 60, 40]) {
      const sigma = await premiumOf(await coveredOf(bond, 1000));
      const coupon = await math.call('couponRateBps', [units(1000), units(bond), sigma, Y_A]);
      assert.ok(coupon >= previous, `coupon fell at ${bond}`);
      previous = coupon;
    }
  });
});

/* ==================================================================== */
describe('part 3 — a release wave on the anchored leg', () => {
  test('transit is priced out at once: the coupon dilutes to 1.48 per cent on the covered book', async () => {
    // Four fifths in transit leave two hundred units covered, requiring forty,
    // against two hundred units of bond.
    const required = await math.call('requiredCapital', [units(200), ATTACHMENT]);
    assert.equal(required, units(40));
    const covered = await math.call('coveredBps', [asQrl(200), REF_PRICE, required, 0n, 0n]);
    assert.equal(covered, 10000n);
    assert.equal(await premiumOf(covered), 3700n, 'the covered book pays the target share');
    assert.equal(await math.call('couponRateBps', [units(200), units(200), 3700n, Y_A]), 148n);
  });

  test('the conditional release returns 160 units and the 40 that remain earn 7.40 per cent', async () => {
    // No conversion haircut: the capacity conversion is the settlement one (SP-05).
    const released = await math.call('conditionalReleaseQrl', [asQrl(200), REF_PRICE, units(40), 0n]);
    assert.equal(released, asQrl(160));
    assert.equal(await math.call('couponRateBps', [units(200), units(40), 3700n, Y_A]), 740n);
  });

  test('the release of 160 units of 200 does not close the run-off gate: the ground is net of it (B-M3)', async () => {
    // Gross, 200 -> 40 is a contraction of 8,000 bps against a trigger of
    // 2,500. The bond lowers the readings the next two closes compare against
    // by what the release paid, so the ground reads the book as unchanged.
    assert.equal(await math.call('runoffGateGround', [1n, asQrl(40), asQrl(200), 2500n]), true, 'gross, the release trips it');
    assert.equal(await math.call('runoffGateGround', [1n, asQrl(40), asQrl(200) - asQrl(160), 2500n]), false, 'net of the release it does not');
    // Ten units maturing beside the release are 2,500 bps of the forty the
    // release left: exactly the trigger, not past it; eleven are past it.
    assert.equal(await math.call('runoffGateGround', [1n, asQrl(30), asQrl(40), 2500n]), false);
    assert.equal(await math.call('runoffGateGround', [1n, asQrl(29), asQrl(40), 2500n]), true);
  });

  test("utilisation reads 2,000 bps where 40 units are required of 200: part 3's threshold is not reached", async () => {
    // Whitepaper §5.3 releases principal once utilisation stays below 2,500 bps.
    // Arguments: required, bond principal (QRL), its capacity conversion, the buffer.
    assert.equal(await math.call('utilisationBps', [units(40), asQrl(200), units(200), 0n]), 2000n);
    assert.equal(await math.call('utilisationBps', [0n, asQrl(200), units(200), 0n]), 0n, 'a book requiring nothing');
  });

  test('the origin-asset buffer stands beside bond principal in the denominator, never in its place', async () => {
    // Whitepaper §4.3: u = K / (N^cap_30 + buffer_orig). A book with no bond
    // stands nothing behind itself whatever its buffer (§4.7), which the model
    // reports at Number.MAX_SAFE_INTEGER.
    const UNBOUNDED = 9007199254740991n;
    assert.equal(await math.call('utilisationBps', [units(40), asQrl(150), units(150), units(50)]), 2000n);
    assert.equal(await math.call('utilisationBps', [units(40), 0n, 0n, units(1000)]), UNBOUNDED, 'no bond: the buffer covers nothing');
    assert.equal(await math.call('coverageRatioBps', [asQrl(150), REF_PRICE, units(40), 0n, units(50)]), 50000n);
    assert.equal(await math.call('coverageRatioBps', [0n, REF_PRICE, units(40), 0n, units(1000)]), 0n);
    assert.equal(await math.call('capacity', [asQrl(150), units(150), units(50), ATTACHMENT]), units(1000));
    assert.equal(await math.call('capacity', [0n, 0n, units(50), ATTACHMENT]), 0n);
  });

  test('utilisation rounds up, so a book on the threshold is not released on a rounding wei', async () => {
    // Understating utilisation releases principal the book still needs, which is
    // the direction `effectiveAttachmentBps` also refuses.
    assert.equal(await math.call('utilisationBps', [1n, 1n, 3n, 0n]), 3334n);
    for (const [required, bond] of [[7n, 3n], [units(40), units(200) + 1n], [10n ** 21n + 7n, 3n * 10n ** 21n]]) {
      const u = await math.call('utilisationBps', [required, 1n, bond, 0n]);
      assert.ok(u * bond >= required * BPS, `rounds up: ${required}/${bond}`);
      assert.ok((u - 1n) * bond < required * BPS, `and by no more than one: ${required}/${bond}`);
    }
  });

  test('what the conditional release leaves always meets the requirement', async () => {
    // The requirement is converted to QRL rounding up, so an inexact price
    // never releases the wei the book still needs.
    // Since SP-05 it is measured on the capacity conversion, so what is kept
    // meets the requirement at the haircut cover is measured at, the
    // adversarial case the change exists for: at 2,500 bps the unadjusted
    // release left the book at three quarters of its cover.
    for (const [bond, price, required] of [
      [asQrl(200), REF_PRICE, units(40)],
      [1_000_000_000n, 3n * UNIT + 1n, 7n],
      [10n ** 24n, 12_345n * UNIT + 678n, 33_333_333n],
    ]) {
      for (const h of [0n, 1n, 2500n, 3000n]) {
        const released = await math.call('conditionalReleaseQrl', [bond, price, required, h]);
        const kept = bond - released;
        // Exactly: what is kept, less the haircut and valued at the price, is at least K.
        if (released > 0n) assert.ok(kept * UNIT * (BPS - h) >= required * price * BPS, `kept meets K at h ${h}`);
      }
      assert.equal(await math.call('conditionalReleaseQrl', [bond, price, required, BPS]), 0n, 'a whole haircut releases nothing');
    }
  });

  test('the censorship ground widens the base by one factor for every position, 26.66 per cent', async () => {
    // The base of whitepaper §3.6: anchored notional plus the qualifying
    // transit. This factor is still the specification's; what changed on
    // 2026-09-27 is the draw it is applied to (the test below).
    assert.equal(await math.call('censorshipDilutionBps', [units(200), units(550)]), 2666n);
    assert.equal(await math.call('censorshipDilutionBps', [units(200), 0n]), 10000n, 'no transit, no dilution');
    assert.equal(await math.call('censorshipDilutionBps', [0n, 0n]), 0n);
  });

  // The 2026-09-27 triage (CLAUDE.md, item 25b): the censorship ground draws
  // D_0 (6,000 bps of the pool) and no more, the escrow being unimpaired
  // (whitepaper §3.6, §5.2) — 16.00 per cent per unit on the modelled book, not
  // the 26.66 per cent of the WHOLE pool this file used to pin.
  test('the censorship ground draws D_0 only: 16.00 per cent per unit', async () => {
    const drawn = await math.call('censorshipDrawBps', [6000n]);
    assert.equal(drawn, 6000n);
    const perUnit = await math.call('trigger2Share', [(units(200) * drawn) / BPS, units(750), units(1)]);
    assert.equal((perUnit * BPS) / units(1), 1600n);
    // The adversarial case the rule exists for: an arranged censorship forces
    // an advance of the floor and not the whole pool.
    const whole = await math.call('trigger2Share', [units(200), units(750), units(1)]);
    assert.ok(perUnit < whole, 'the whole pool on the widened base is no longer paid');
    assert.equal(await math.call('censorshipDrawBps', [12000n]), 10000n, 'never above the pool');
  });
});

/* ==================================================================== */
describe('part 4 — a first trigger across a vesting differential', () => {
  const window = BigInt(90 * DAY);
  const at = 1_000_000n;

  test('the buffer sits outside the occurrence limit and adds to it', async () => {
    assert.equal(await math.call('availableCapital', [units(1), units(200), units(200)]), units(201));
    assert.equal(await math.call('availableCapital', [units(1), units(300), units(200)]), units(201), 'the bond is capped, the buffer is not');
  });

  test('an event of 150 units settles in full, and 88.50 are never drawn', async () => {
    const vA = await math.call('vestingBps', [at, at + BigInt(45 * DAY), window]);
    const vB = await math.call('vestingBps', [at, at + BigInt(120 * DAY), window]);
    assert.equal(vA, 5000n);
    assert.equal(vB, 10000n);
    const obligation = (units(75) * vA) / BPS + units(75);
    assert.equal(obligation, units(112.5));
    const haircut = await math.call('settlementHaircutBps', [units(201), obligation]);
    assert.equal(haircut, 10000n);
    assert.equal(await math.call('settlementFor', [units(75), INDEMNITY, vA, haircut]), units(37.5));
    assert.equal(await math.call('settlementFor', [units(75), INDEMNITY, vB, haircut]), units(75));
    assert.equal(units(201) - obligation, units(88.5));
  });

  test('the book re-prices at once: cover 52.05, target 5,404, charged 2,812, coupon 10.80', async () => {
    const required = await math.call('requiredCapital', [units(850), ATTACHMENT]);
    assert.equal(required, units(170));
    const covered = await math.call('coveredBps', [asQrl(88.5), REF_PRICE, required, 0n, 0n]);
    assert.equal(covered, 5205n);
    assert.equal(await math.call('premiumTargetBps', [SIGMA_4, RATIO, CEILING, covered]), 5404n);
    const sigma = await premiumOf(covered);
    assert.equal(sigma, 2812n);
    assert.equal(await math.call('couponRateBps', [units(850), units(88.5), sigma, Y_A]), 1080n);
  });

  test('summing after the vesting factor distributes the whole of the capital', async () => {
    const vA = 5000n;
    const after = (units(200) * vA) / BPS + units(200);
    const haircut = await math.call('settlementHaircutBps', [units(201), after]);
    assert.equal(haircut, 6700n);
    const a = await math.call('settlementFor', [units(200), INDEMNITY, vA, haircut]);
    const b = await math.call('settlementFor', [units(200), INDEMNITY, 10000n, haircut]);
    assert.equal(a, units(67));
    assert.equal(b, units(134));
    assert.equal(a + b, units(201));
  });

  test('summing before it withholds a quarter of the capital from its claimants', async () => {
    const haircut = await math.call('settlementHaircutBps', [units(201), units(400)]);
    assert.equal(haircut, 5025n);
    const a = await math.call('settlementFor', [units(200), INDEMNITY, 5000n, haircut]);
    const b = await math.call('settlementFor', [units(200), INDEMNITY, 10000n, haircut]);
    assert.equal(a, units(50.25));
    assert.equal(b, units(100.5));
    assert.equal(units(201) - a - b, units(50.25), 'withheld under the wrong order');
  });
});

/* ==================================================================== */
describe('part 5 — a first trigger under concurrent shocks', () => {
  const carried = 10_000n * UNIT;

  test('the floor after two epochs at a bound of 2,500 bps is 5,625 QRL', async () => {
    assert.equal(await math.call('emergencyPriceFloor', [carried, MOVE, 2n]), 5_625n * UNIT);
    assert.equal(await math.call('emergencyPriceFloor', [carried, MOVE, 0n]), carried);
    assert.equal(await math.call('emergencyPriceFloor', [carried, 10000n, 3n]), 0n);
  });

  test('the price struck in each state is the one the report states', async () => {
    const floor = 5_625n * UNIT;
    assert.equal(await math.call('settlementPrice', [true, carried, carried, 0n, 0n]), carried, 'the event alone');
    assert.equal(await math.call('settlementPrice', [false, carried, 0n, 5_000n * UNIT, floor]), floor, 'a halved print strikes at the floor');
    assert.equal(await math.call('settlementPrice', [false, carried, 0n, 8_000n * UNIT, floor]), 8_000n * UNIT, 'a fall above the floor strikes as printed');
    assert.equal(await math.call('settlementPrice', [true, carried, 12_000n * UNIT, 0n, 0n]), carried, 'a rise never inflates the obligation');
    assert.equal(await math.call('settlementPrice', [false, carried, 0n, 15_000n * UNIT, floor]), carried);
  });

  test('available capital, the haircut and the settlement in each state', async () => {
    // [buffer, bond, limit, covered loss, available, haircut, settled]
    const rows = [
      [1, 200, 200, 400, 201, 5025n, 201],
      [1, 200, 40, 80, 41, 5125n, 41],
      [1, 168.75, 200, 400, 169.75, 4243n, 169.72],
    ];
    for (const [buffer, bond, limit, loss, available, haircut, settled] of rows) {
      const a = await math.call('availableCapital', [units(buffer), units(bond), units(limit)]);
      assert.equal(a, units(available));
      const h = await math.call('settlementHaircutBps', [a, units(loss)]);
      assert.equal(h, haircut);
      assert.equal(await math.call('settlementFor', [units(loss), INDEMNITY, 10000n, h]), units(settled));
    }
  });

  test('the QRL drawn follows the price struck, not the print', async () => {
    const drawn = (price) => (units(200) * price) / UNIT;
    assert.equal(drawn(10_000n * UNIT), asQrl(200));
    assert.equal(drawn(5_625n * UNIT), 1_125_000n * UNIT);
    assert.equal(drawn(8_000n * UNIT), 1_600_000n * UNIT);
  });

  test('a settlement realised in the origin asset bears the market impact', async () => {
    // One unit is paid from the buffer in the origin asset; two hundred are
    // delivered in QRL and bear the impact on sale.
    const rows = [
      [0n, 201],
      [500n, 191],
      [1000n, 181],
      [2000n, 161],
      [5000n, 101],
    ];
    for (const [impact, realised] of rows) {
      const fromBond = await math.call('realisedAfterConversion', [units(200), impact]);
      assert.equal(units(1) + fromBond, units(realised), `impact ${impact}`);
    }
    assert.equal(await math.call('realisedAfterConversion', [units(200), 10000n]), 0n);
  });
});

/* ==================================================================== */
describe('part 6 — a declaration and a later recovery', () => {
  test('the escrow is applied by subrogation, senior before junior', async () => {
    // [paid under trigger 2, recovered, to bond, senior, junior, to anchored]
    const rows = [
      [200, 0, 0, 0, 0, 0],
      [200, 30, 30, 30, 0, 0],
      [200, 200, 200, 60, 140, 0],
      [200, 600, 200, 60, 140, 400],
      [200, 1000, 200, 60, 140, 800],
      [300, 0, 0, 0, 0, 0],
      [300, 300, 300, 90, 210, 0],
      [300, 600, 300, 90, 210, 300],
    ];
    for (const [paid, recovered, toBond, senior, junior, toAnchored] of rows) {
      const [b, a] = pair(await math.call('recoveryAllocation', [units(recovered), units(paid)]));
      assert.equal(b, units(toBond));
      assert.equal(a, units(toAnchored));
      const [dJ, dS] = pair(await math.call('classDraws', [units(paid), units(paid), JUNIOR]));
      const [s, j] = pair(await math.call('classRecovery', [b, dJ, dS]));
      assert.equal(s, units(senior), `senior at ${paid}/${recovered}`);
      assert.equal(j, units(junior), `junior at ${paid}/${recovered}`);
      assert.equal(units(paid) + a, units(Math.max(paid, recovered)), 'the anchored positions hold the greater of the two');
    }
  });

  test('coupons received are not deducted, and the bond never recovers more than it paid', async () => {
    const [b] = pair(await math.call('recoveryAllocation', [units(10_000), units(200)]));
    assert.equal(b, units(200));
  });
});

/* ==================================================================== */
describe('part 7 — the cost of delivering the premium', () => {
  const couponAtExactCover = 407n;

  test('the coupon delivered at each discount within the reserve', async () => {
    const rows = [
      [0n, 407n],
      [500n, 386n],
      [1000n, 366n],
      [2000n, 325n],
      [2500n, 305n],
      [3500n, 264n],
      [4500n, 223n],
      [5000n, 203n],
    ];
    assert.equal(await math.call('maxCouponRateBps', [SIGMA_4, ATTACHMENT, Y_OBS]), couponAtExactCover);
    for (const [discount, coupon] of rows) {
      assert.equal(await math.call('deliveredCouponBps', [couponAtExactCover, discount, 10000n]), coupon);
    }
  });

  test('the coupon delivered where only part of the quantity clears', async () => {
    const rows = [
      [10000n, 305n],
      [7500n, 228n],
      [6553n, 200n],
      [5000n, 152n],
      [2500n, 76n],
      [0n, 0n],
    ];
    for (const [cleared, coupon] of rows) {
      assert.equal(await math.call('deliveredCouponBps', [couponAtExactCover, MOVE, cleared]), coupon);
    }
  });

  test('the discount cap is 5,085 bps on the reference book, and none below the floor', async () => {
    assert.equal(await math.call('discountCapBps', [TAIL_FLOOR, couponAtExactCover]), 5085n);
    assert.equal(await math.call('discountCapBps', [TAIL_FLOOR, TAIL_FLOOR]), 0n);
    assert.equal(await math.call('discountCapBps', [TAIL_FLOOR, 150n]), 0n);
  });

  test('the reserve reaches its floor at the seventh offering, from the first-offering rung, and never falls back', async () => {
    // d_0 = d_first, d_k = m_epoch + (k - 1) * step (EC-03, 2026-09-30).
    assert.equal(await math.call('reserveLadderEpochs', [RESERVE_FLOOR, MOVE, STEP]), 7n);
    const expected = [400n, 2500n, 3000n, 3500n, 4000n, 4500n, 5000n, 5000n, 5000n];
    let previous = 0n;
    for (let k = 0; k < expected.length; k++) {
      const d = await math.call('admittedDiscountBps', [MOVE, FIRST, STEP, RESERVE_FLOOR, TAIL_FLOOR, couponAtExactCover, BigInt(k)]);
      assert.equal(d, expected[k], `after ${k} failures`);
      assert.ok(d >= previous, 'I28: the admitted discount never falls as failures accumulate');
      previous = d;
    }
  });

  test('unsold premium is retained whole at the retention period and not before', async () => {
    for (let offered = 0; offered < 6; offered++) {
      const [retained, again] = pair(await math.call('unsoldRetention', [units(0.93), BigInt(offered), 6n]));
      assert.equal(retained, 0n);
      assert.equal(again, units(0.93));
    }
    const [retained, again] = pair(await math.call('unsoldRetention', [units(0.93), 6n, 6n]));
    assert.equal(retained, units(0.93));
    assert.equal(again, 0n);
  });
});

/* ==================================================================== */
describe('part 11 — the target share across its range', () => {
  test('each stage buys the indemnity section 4.5 gives its value', async () => {
    // [sigma, staker, indemnity, attachment, coupon at 4.00, coupon at 2.20, multiple]
    const rows = [
      [1850n, 7650n, 6166n, 1234n, 599n, 329n, 14991n],
      [2500n, 7000n, 8333n, 1667n, 599n, 329n, 14997n],
      [3000n, 6500n, 10000n, 2000n, 600n, 330n, 15000n],
      [3700n, 5800n, 10000n, 2000n, 740n, 407n, 18500n],
      [4000n, 5500n, 10000n, 2000n, 800n, 440n, 20000n],
    ];
    for (const [sigma, staker, indem, att, c400, c220, multiple] of rows) {
      assert.equal(await math.call('stakerShareBps', [BUFFER, OPERATIONS, sigma]), staker);
      const i = await math.call('effectiveIndemnityBps', [sigma, INDEMNITY, PML]);
      assert.equal(i, indem, `indemnity at ${sigma}`);
      const a = await math.call('effectiveAttachmentBps', [i, PML]);
      assert.equal(a, att, `attachment at ${sigma}`);
      assert.equal(await math.call('maxCouponRateBps', [sigma, a, 400n]), c400);
      assert.equal(await math.call('maxCouponRateBps', [sigma, a, 220n]), c220);
      assert.equal(await math.call('couponMultipleBps', [sigma, a]), multiple);
    }
  });
});

/* ==================================================================== */
describe('part 13 — the two classes', () => {
  test('junior returns 4.95 per cent against 2.00 for senior at the observed yield', async () => {
    const [j, s, short] = await math.call('trancheCoupons', [407n, JUNIOR, SENIOR]);
    assert.equal(BigInt(j), 495n);
    assert.equal(BigInt(s), 200n);
    assert.equal(short, false);
    assert.equal(BigInt(j) + 367n, 862n, 'with the staking distribution, as the status register states');
  });

  test('a pot below the stated senior rate pays senior what it can and junior nothing', async () => {
    const [j, s, short] = await math.call('trancheCoupons', [50n, JUNIOR, SENIOR]);
    assert.equal(BigInt(j), 0n);
    assert.equal(BigInt(s), (50n * BPS) / (BPS - JUNIOR));
    assert.equal(short, true);
  });

  test('junior is drawn to its thickness before senior is reached', async () => {
    assert.deepEqual(pair(await math.call('classDraws', [units(100), units(200), JUNIOR])), [units(100), 0n]);
    assert.deepEqual(pair(await math.call('classDraws', [units(170), units(200), JUNIOR])), [units(140), units(30)]);
    assert.deepEqual(pair(await math.call('classDraws', [units(500), units(200), JUNIOR])), [units(140), units(60)], 'clamped to the pool');
  });
});

/* ==================================================================== */
describe('the invariants of the yellow paper', () => {
  test('I12 — the coupon multiple never falls below 14,990 across the admissible band', async () => {
    // The attachment rounds up, so the 1.5x floor holds within rounding; the
    // report states the bound for a target share from 1,850 to 4,000 bps.
    let worst = { multiple: 10n ** 9n };
    for (let sigma = 1850n; sigma <= 4000n; sigma += 50n) {
      for (let pml = 1500n; pml <= 5000n; pml += 500n) {
        const i = await math.call('effectiveIndemnityBps', [sigma, INDEMNITY, pml]);
        const a = await math.call('effectiveAttachmentBps', [i, pml]);
        const m = await math.call('couponMultipleBps', [sigma, a]);
        assert.ok(3n * a <= 2n * sigma + 3n, `3 att <= 2 sigma + 3 at ${sigma}/${pml}`);
        if (m < worst.multiple) worst = { multiple: m, sigma, pml };
      }
    }
    assert.ok(worst.multiple >= 14990n, `worst ${worst.multiple} at ${worst.sigma}/${worst.pml}`);
  });

  test('I13 and I30 — the share charged never rises as cover falls, under either ceiling', async () => {
    for (const ceiling of [CEILING, SURGE]) {
      let previous = 10n ** 9n;
      for (let covered = 10000n; covered >= 0n; covered -= 250n) {
        const sigma = await premiumOf(covered, SIGMA_4, ceiling);
        assert.ok(sigma <= previous, `rose at ${covered} under ${ceiling}`);
        assert.ok(sigma <= SIGMA_4, 'never above the target share');
        previous = sigma;
      }
    }
  });

  test('the surge ceiling raises the coupon on scarce capital and not the charge at complete cover', async () => {
    assert.equal(await premiumOf(10000n, SIGMA_4, SURGE), await premiumOf(10000n, SIGMA_4, CEILING));
    assert.ok((await premiumOf(2000n, SIGMA_4, SURGE)) > (await premiumOf(2000n, SIGMA_4, CEILING)));
    assert.equal(await math.call('premiumTargetBps', [SIGMA_4, RATIO, CEILING, 3333n]), 7400n, 'the ceiling at a utilisation of three');
  });

  test('I19 — the two class coupons together draw no more than the pool', async () => {
    for (const pool of [0n, 50n, 199n, 200n, 407n, 740n, 1480n]) {
      for (const w of [5000n, 7000n, 9000n]) {
        const [j, s] = await math.call('trancheCoupons', [pool, w, SENIOR]);
        assert.ok(BigInt(j) * w + BigInt(s) * (BPS - w) <= pool * BPS, `pool ${pool} w ${w}`);
      }
    }
  });

  test('I27 — the conversion haircut moves cover and no settlement quantity', async () => {
    const bond = asQrl(200);
    const settlement = await math.call('bondNotionalInOrigin', [bond, REF_PRICE]);
    let previousCover = 10n ** 9n;
    for (let h = 0n; h <= 3000n; h += 500n) {
      const cover = await math.call('coveredBps', [bond, REF_PRICE, units(200), h, 0n]);
      assert.ok(cover <= previousCover, 'cover never rises with the haircut');
      previousCover = cover;
      assert.equal(await math.call('bondNotionalInOrigin', [bond, REF_PRICE]), settlement);
      assert.equal(
        await math.call('bondCapacityInOrigin', [bond, REF_PRICE, h]),
        (settlement * (BPS - h)) / BPS,
      );
    }
    assert.equal(await math.call('coveredBps', [bond, REF_PRICE, units(200), 2500n, 0n]), 7500n);
  });

  test('I24′ — a claim above the verdict bound is heard in pieces that cover it', async () => {
    // kappa = 6,666 bps of the stake the majority forfeits at a slash of 3,000:
    // floor(6,666 * 4,000 * 3,000 / BPS²) = 799.92 units.
    const bound = await math.call('verdictBound', [4n * units(1000), 3000n, 6666n]);
    assert.equal(bound, units(799.92));
    // A purchased verdict costs at least one and a half times what it moves.
    const cost = await math.call('bribeCostFloor', [bound, 6666n]);
    assert.ok(2n * cost >= 3n * bound, `cost ${cost} against a move of ${bound}`);
    // The integer multiple this replaced moved ten times the forfeit, not two thirds of it.
    assert.ok(bound < (4n * units(1000) * 3000n) / BPS);
    for (const claim of [1n, bound, bound + 1n, 7n * bound + 3n]) {
      const n = await math.call('determinationsFor', [claim, bound]);
      assert.ok(n * bound >= claim && (n - 1n) * bound < claim);
    }
    assert.equal(await math.call('determinationsFor', [units(1), 0n]), 0n, 'no bound admits no determination');
  });

  test('I25 — the settlement horizon is seven epochs and the ladder is bounded at 1,428', async () => {
    const horizon = await math.call('settlementHorizonEpochs', [BigInt(21 * DAY), BigInt(7 * DAY), 2500n]);
    assert.equal(horizon, 7n);
    assert.equal(await math.call('maturityLadderMaxBps', [horizon]), 1428n);
    assert.ok((await math.call('runoffHorizonEpochs', [1428n])) >= horizon);
  });

  test('I25 — a whole-book release queue clears in the horizon, because its base is held', async () => {
    // Whitepaper section 3.3: the bound is taken on the holding when the queue
    // opened, held until it empties. Four draining epochs of 250 clear 1,000;
    // on the holding that remains the queue would still hold 316 after four.
    const base = units(1000);
    const slice = await math.call('releaseBoundUnits', [base, 2500n]);
    assert.equal(slice, units(250));
    let queued = base;
    let epochs = 0;
    while (queued > 0n) {
      queued -= queued < slice ? queued : slice;
      epochs += 1;
    }
    assert.equal(epochs, 4);
    const unbonding = 3;
    assert.equal(BigInt(unbonding + epochs), await math.call('settlementHorizonEpochs', [BigInt(21 * DAY), BigInt(7 * DAY), 2500n]));

    let decaying = base;
    for (let k = 0; k < 4; k++) decaying -= await math.call('releaseBoundUnits', [decaying, 2500n]);
    assert.ok(decaying > units(316), 'the geometric reading the whitepaper rules out');
  });

  test('the coupon of an epoch is due when its swap lots expire on QRL, four days into the epoch after next (I31)', async (t) => {
    const e = 2810n;
    const due = await math.call('settlementCloses', [e]);
    assert.equal(due, (e + 2n) * BigInt(7 * DAY) + 4n * BigInt(DAY));
    if (!M) return t.skip(MISSING);
    // The model's own timelocks, from the close of the quote window.
    const tl = M.ark.swapTimelocks(M.params);
    assert.equal(BigInt(tl.qrlExpiryHours) * 3600n, due - (e + 2n) * BigInt(7 * DAY));
    assert.equal(tl.asymmetric, true);
    assert.equal(tl.settlesInsideEpoch, true);
  });

  test('the run-off queue drains in five epochs, returning exactly what entered it', async () => {
    assert.equal(await math.call('runoffDrainEpochs', [2000n]), 5n);
    let queued = asQrl(170);
    let epochs = 0;
    while (queued > 0n) {
      queued -= await math.call('runoffReleaseQrl', [2000n, asQrl(200), queued]);
      epochs += 1;
    }
    assert.equal(epochs, 5);
  });

  test('the run-off gate closes on the fourth stage or a contraction past the trigger', async () => {
    assert.equal(await math.call('runoffGateGround', [4n, asQrl(200), asQrl(200), 2500n]), true);
    assert.equal(await math.call('runoffGateGround', [3n, asQrl(200), asQrl(200), 2500n]), false);
    assert.equal(await math.call('runoffGateGround', [1n, asQrl(149), asQrl(200), 2500n]), true);
    assert.equal(await math.call('runoffGateGround', [1n, asQrl(150), asQrl(200), 2500n]), false, 'exactly at the trigger is not past it');
    assert.equal(await math.call('runoffContractionBps', [asQrl(250), asQrl(200)]), 0n, 'a book that grew contracted by nothing');
  });

  test('the operations share splits into the juror fraction and the rest, summing to itself', async () => {
    const [origin, auctioned] = pair(await math.call('operationsSplit', [250n, 2000n]));
    assert.equal(auctioned, 50n);
    assert.equal(origin + auctioned, 250n);
  });
});

/* ==================================================================== */
describe('agreement with ark-staking.ts over a sweep of its input space', () => {
  const skipUnless = (t) => {
    if (!M) {
      t.skip(MISSING);
      return true;
    }
    return false;
  };

  test('the capital model and the price of cover agree on every book', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    const books = [];
    for (const sigma of [1850, 2500, 3000, 3700, 4000]) {
      for (const floor of [1500, 2000, 3333, 5000]) {
        for (const maxShare of [0, 2000, 4000, 10000]) {
          for (const [anchored, bond] of [
            [units(1000), asQrl(200)],
            [units(1000), asQrl(88.5)],
            [units(333), asQrl(777)],
            [units(1), 3n],
            [0n, asQrl(100)],
            [units(500), 0n],
          ]) {
            for (const haircut of [0, 1234]) {
              for (const gate of [false, true]) {
                // buffer_orig beside bond principal (whitepaper §4.3): none, and a
                // quantity that moves every figure of this book.
                for (const buffer of [0n, units(37.5)]) books.push({ sigma, floor, maxShare, anchored, bond, haircut, gate, buffer });
              }
            }
          }
        }
      }
    }
    // A deterministic thinning keeps the sweep inside a few seconds of harness time.
    const sample = books.filter((_, i) => i % 13 === 0);
    for (const b of sample) {
      const p = { ...params, sigmaTargetBps: b.sigma, pmlFloorBps: b.floor };
      const book = {
        anchoredNotional: b.anchored,
        bondNotional: b.bond,
        refPrice: REF_PRICE,
        maxAssetShareBps: b.maxShare,
        fxHaircutBps: b.haircut,
        bufferOrig: b.buffer,
      };
      const ceiling = ark.premiumCeilingInForceBps(p, b.gate);
      const label = JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

      const pml = await math.call('pmlBps', [BigInt(b.floor), BigInt(b.maxShare)]);
      assert.equal(pml, BigInt(ark.pmlBps(p, book)), `pml ${label}`);
      const indem = await math.call('effectiveIndemnityBps', [BigInt(b.sigma), BigInt(p.indemnityBps), pml]);
      assert.equal(indem, BigInt(ark.effectiveIndemnityBps(p, book)), `indemnity ${label}`);
      const att = await math.call('effectiveAttachmentBps', [indem, pml]);
      assert.equal(att, BigInt(ark.effectiveAttachmentBps(p, book)), `attachment ${label}`);
      const required = await math.call('requiredCapital', [b.anchored, att]);
      assert.equal(required, ark.requiredCapital(p, book), `required ${label}`);
      const h = BigInt(b.haircut);
      assert.equal(await math.call('bondCapacityInOrigin', [b.bond, REF_PRICE, h]), ark.bondCapacityInOrigin(book), `capacity conversion ${label}`);
      assert.equal(await math.call('coverageRatioBps', [b.bond, REF_PRICE, required, h, b.buffer]), BigInt(ark.coverageRatioBps(p, book)), `ratio ${label}`);
      const covered = await math.call('coveredBps', [b.bond, REF_PRICE, required, h, b.buffer]);
      assert.equal(covered, BigInt(ark.coveredBps(p, book)), `covered ${label}`);
      const cap = await math.call('capacity', [b.bond, ark.bondCapacityInOrigin(book), b.buffer, att]);
      assert.equal(cap, ark.capacity(p, book), `capacity ${label}`);
      assert.equal(
        await math.call('utilisationBps', [required, b.bond, ark.bondCapacityInOrigin(book), b.buffer]),
        BigInt(ark.utilisationBps(p, book)),
        `utilisation ${label}`,
      );
      // The slope is a ratio of the stage's target since 2026-09-30 (EC-07).
      assert.equal(Number(await math.call('scarcitySlopeBps', [BigInt(b.sigma), BigInt(p.premiumSlopeRatioBps)])), ark.scarcitySlopeBps(p), `slope ${label}`);
      const sigma = await math.call('premiumShareBps', [BigInt(b.sigma), BigInt(p.premiumSlopeRatioBps), BigInt(ceiling), covered]);
      assert.equal(sigma, BigInt(ark.premiumShareBps(p, Number(covered), ceiling)), `premium ${label}`);
      const target = await math.call('premiumTargetBps', [BigInt(b.sigma), BigInt(p.premiumSlopeRatioBps), BigInt(ceiling), covered]);
      assert.equal(target, BigInt(ark.premiumTargetBps(p, Number(covered), ceiling)), `target ${label}`);
      const staker = await math.call('stakerShareBps', [BigInt(p.bufferBps), BigInt(p.operationsBps), sigma]);
      assert.equal(staker, BigInt(ark.allocate(p, Number(sigma)).stakerBps), `staker ${label}`);
      const inOrigin = ark.bondNotionalInOrigin(book);
      assert.equal(
        await math.call('couponRateBps', [b.anchored, inOrigin, sigma, Y_A]),
        BigInt(ark.couponRateBps(book, Number(sigma), Number(Y_A))),
        `coupon ${label}`,
      );
      assert.equal(await math.call('maxCouponRateBps', [BigInt(b.sigma), att, Y_OBS]), BigInt(ark.maxCouponRateBps(p, book, Number(Y_OBS))), `coupon at exact cover ${label}`);
      assert.equal(await math.call('couponMultipleBps', [BigInt(b.sigma), att]), BigInt(ark.couponMultipleBps(p, book)), `multiple ${label}`);
      // On the capacity conversion, the haircut included (SP-05).
      assert.equal(await math.call('conditionalReleaseQrl', [b.bond, REF_PRICE, required, h]), ark.conditionalReleaseQrl(p, book), `release ${label}`);
    }
  });

  test('settlement, recovery, classes and delivery agree on every input', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    const q = [0n, 1n, units(0.5), units(40), units(200), units(333.333), units(1000)];

    for (const available of q) {
      for (const obligation of q) {
        assert.equal(await math.call('settlementHaircutBps', [available, obligation]), BigInt(ark.settlementHaircutBps(available, obligation)));
      }
    }
    for (const recovered of q) {
      for (const paid of q) {
        const [b, a] = pair(await math.call('recoveryAllocation', [recovered, paid]));
        const m = ark.recoveryAllocation(recovered, paid);
        assert.equal(b, m.bond);
        assert.equal(a, m.anchored);
        for (const w of [5000, 7000, 9000]) {
          const [dJ, dS] = pair(await math.call('classDraws', [paid, recovered, BigInt(w)]));
          const draws = ark.classDraws(paid, recovered, w);
          assert.equal(dJ, draws.junior);
          assert.equal(dS, draws.senior);
          const [s, j] = pair(await math.call('classRecovery', [b, dJ, dS]));
          const r = ark.classRecovery(b, draws);
          assert.equal(s, r.senior);
          assert.equal(j, r.junior);
        }
      }
    }
    for (const pool of [0, 1, 150, 199, 200, 407, 740, 1480, 3000]) {
      for (const w of [0, 5000, 7000, 9000, 10000]) {
        for (const senior of [0, 200, 500]) {
          const [j, s, short] = await math.call('trancheCoupons', [BigInt(pool), BigInt(w), BigInt(senior)]);
          const m = ark.trancheCoupons(pool, w, senior);
          assert.equal(Number(j), m.juniorCouponBps, `junior ${pool}/${w}/${senior}`);
          assert.equal(Number(s), m.seniorCouponBps, `senior ${pool}/${w}/${senior}`);
          assert.equal(short, m.seniorShortfall);
        }
      }
    }
    for (const coupon of [0, 100, 199, 200, 201, 407, 740, 1480]) {
      assert.equal(Number(await math.call('discountCapBps', [TAIL_FLOOR, BigInt(coupon)])), ark.discountCapBps(params, coupon), `cap ${coupon}`);
      for (let k = 0; k < 9; k++) {
        // d_0 = d_first, d_k = m_epoch + (k - 1) * step (EC-03).
        assert.equal(
          Number(await math.call('admittedDiscountBps', [MOVE, FIRST, STEP, RESERVE_FLOOR, TAIL_FLOOR, BigInt(coupon), BigInt(k)])),
          ark.admittedDiscountBps(params, coupon, k),
          `discount ${coupon}/${k}`,
        );
      }
      for (const cost of [0, 2500, 5000, 9999, 10000]) {
        for (const cleared of [0, 3333, 10000, 12000]) {
          assert.equal(
            Number(await math.call('deliveredCouponBps', [BigInt(coupon), BigInt(cost), BigInt(cleared)])),
            ark.deliveredCouponBps(coupon, cost, cleared),
          );
        }
      }
    }
    assert.equal(Number(await math.call('reserveLadderEpochs', [RESERVE_FLOOR, MOVE, STEP])), ark.reserveLadderEpochs(params));
    assert.equal(ark.reserveLadderEpochs(params), 7, 'the first offering, the epoch bound, and five steps (EC-03)');
    for (const [floor, move, step] of [[5000, 2500, 500], [6000, 1500, 250], [2500, 3000, 1000], [5000, 2500, 0], [6000, 1500, 1000]]) {
      assert.equal(
        Number(await math.call('reserveLadderEpochs', [BigInt(floor), BigInt(move), BigInt(step)])),
        ark.reserveLadderEpochs({ ...params, reserveFloorBps: floor, maxEpochMoveBps: move, reserveStepBps: step }),
        `ladder ${floor}/${move}/${step}`,
      );
    }
    for (const epochs of [0, 1, 2, 5, 40]) {
      for (const move of [0, 1500, 2500, 3000, 10000]) {
        assert.equal(await math.call('emergencyPriceFloor', [10_000n * UNIT, BigInt(move), BigInt(epochs)]), ark.emergencyPriceFloor(10_000n * UNIT, move, epochs));
      }
    }
    for (const [anchored, transit] of [[0n, 0n], [units(200), units(550)], [units(1000), 0n], [1n, units(1)]]) {
      assert.equal(Number(await math.call('censorshipDilutionBps', [anchored, transit])), ark.censorshipDilutionBps(anchored, transit));
      assert.equal(await math.call('trigger2Share', [units(200), anchored + transit, anchored]), ark.trigger2Share(units(200), anchored + transit, anchored));
    }
    for (const paid of q) {
      for (const impact of [0, 500, 5000, 9999, 10000]) {
        assert.equal(await math.call('realisedAfterConversion', [paid, BigInt(impact)]), ark.realisedAfterConversion(paid, impact));
      }
    }
    for (const [ops, juror] of [[250, 2000], [1000, 5000], [333, 1], [250, 0]]) {
      const [origin, auctioned] = pair(await math.call('operationsSplit', [BigInt(ops), BigInt(juror)]));
      const m = ark.operationsSplit(ops, juror);
      assert.equal(Number(origin), m.originBps);
      // The model names the juror-fee part `offeredBps` (it is offered in the
      // premium swap); the library still returns it as `auctionedBps`.
      assert.equal(Number(auctioned), m.offeredBps);
    }
    assert.equal(Number(await math.call('determinationsFor', [units(71), units(7)])), ark.determinationsFor(units(71), units(7)));
  });

  test('the progressive trigger-2 settlement agrees with the model: D_0, S, HOLD, junior first (I37, I23′)', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    const pool = units(1000);
    for (const [d0, sFloor] of [[params.trigger2FloorBps, params.severityFloorBps], [7000, 5000], [5000, 5000], [10000, 8000]]) {
      const p = { ...params, trigger2FloorBps: d0, severityFloorBps: sFloor };
      // The clamp of every measured path, 1 - (1 - m_epoch)^W_a (PV-03).
      const ceiling = await math.call('measuredSeverityCeilingBps', [BigInt(p.maxEpochMoveBps), BigInt(p.assessmentWindowEpochs)]);
      assert.equal(Number(ceiling), ark.measuredSeverityCeilingBps(p));
      // null is the model's unavailable reading: the oracle silent or the breaker active.
      for (const measured of [null, -100, 0, 2500, 5000, 6000, 6835, 6836, 7500, 9999, 10000, 10500]) {
        const where = `D0 ${d0} Sfloor ${sFloor} mLoss ${measured}`;
        const [ok, severity] = await math.call('trigger2SeverityBps', [BigInt(sFloor), measured !== null, BigInt(Math.max(0, measured ?? 0)), ceiling]);
        const model = ark.trigger2SeverityBps(p, measured);
        assert.equal(ok, model !== null, `measured ${where}`);
        if (model !== null) assert.equal(Number(severity), model, `severity ${where}`);
        // A severity the court fixes is a finding: bounded by the whole only.
        const [, fixed] = await math.call('trigger2SeverityBps', [BigInt(sFloor), measured !== null, BigInt(Math.max(0, measured ?? 0)), BPS]);
        if (model !== null) assert.equal(Number(fixed), ark.trigger2SeverityBps(p, measured, true), `court-fixed ${where}`);
        const total = await math.call('trigger2DrawTotalBps', [BigInt(d0), ok, severity]);
        assert.equal(Number(total), ark.trigger2DrawTotalBps(p, model), `total ${where}`);
        const held = await math.call('trigger2HeldBps', [BigInt(d0), ok]);
        assert.equal(Number(held), ark.trigger2HeldBps(p, model), `held ${where}`);
        // HOLD (item 25a): a dead oracle pays D_0, holds the rest, releases nothing.
        if (model === null) assert.equal(total + held, BPS, `nothing released under a dead oracle ${where}`);

        // Junior first under trigger 2, on the thickness and on the recorded principals.
        const draw = (pool * total) / BPS;
        for (const w of [5000, 7000, 9000]) {
          const [dJ, dS] = pair(await math.call('classDraws', [draw, pool, BigInt(w)]));
          const m = ark.classDraws(draw, pool, w);
          assert.equal(dJ, m.junior, `junior ${where} w ${w}`);
          assert.equal(dS, m.senior, `senior ${where} w ${w}`);
          assert.ok(dS === 0n || dJ === (pool * BigInt(w)) / BPS, 'senior is reached only once junior is exhausted');
        }
        for (const [j, sn] of [[units(700), units(300)], [units(650), units(350)], [units(100), units(900)], [0n, pool]]) {
          const [dJ, dS] = pair(await math.call('classDrawsOnPrincipal', [draw, j, sn]));
          const m = ark.classDrawsOnPrincipal(draw, j, sn);
          assert.equal(dJ, m.junior, `junior on principal ${where}`);
          assert.equal(dS, m.senior, `senior on principal ${where}`);
        }
      }
      assert.equal(Number(await math.call('censorshipDrawBps', [BigInt(d0)])), ark.censorshipDrawBps(p), `censorship draw D0 ${d0}`);
    }
  });

  test('phase C3b: trigger 2 on the vested obligation, D after the haircut, agrees with the model (papers sync 5, I37)', async (t) => {
    if (skipUnless(t)) return;
    const { ark } = M;
    const price = 10_000n * UNIT;
    const claimants = [
      { notional: units(100), vestingBps: 10000 },
      { notional: units(300), vestingBps: 3333 },
      { notional: units(7.5), vestingBps: 1 },
      { notional: 0n, vestingBps: 10000 },
      { notional: units(1), vestingBps: 12000 },
    ];
    let W = 0n;
    for (const c of claimants) {
      const w = await math.call('trigger2VestedWeight', [c.notional, BigInt(c.vestingBps)]);
      assert.equal(w, ark.trigger2VestedWeight(c), `weight ${c.notional}/${c.vestingBps}`);
      W += w;
    }
    assert.equal(await math.call('trigger2Obligation', [W]), ark.trigger2Obligation(W));
    // K_T on the claimants' recorded principal (EC-02): none, a sliver, the
    // requirement at the first and fourth stages, and the whole.
    const principal = claimants.reduce((s, c) => s + (c.notional > 0n ? c.notional : 0n), 0n);
    for (const att of [0, 1234, 2000, 10000]) {
      const cap = await math.call('trigger2CapUnits', [principal, BigInt(att)]);
      assert.equal(cap, ark.trigger2CapUnits(principal, att), `K_T at ${att}`);
    for (const pool of [0n, 1n, asQrl(1), asQrl(200), asQrl(2_000), asQrl(10_000)]) {
      for (const pr of [0n, 1n, price, 5_625n * UNIT]) {
        const full = await math.call('trigger2FullSettlement', [W, pool, pr, cap]);
        assert.equal(full, ark.trigger2FullSettlement(W, pool, pr, cap), `S_full pool ${pool} price ${pr} cap ${cap}`);
        const draws = [];
        for (const d of [0, 1, 5000, 6000, 7777, 10000, 12000]) {
          const draw = await math.call('trigger2PoolDraw', [W, BigInt(d), pool, pr, cap]);
          assert.equal(draw, ark.trigger2PoolDraw(W, d, pool, pr, cap), `draw D ${d}`);
          draws.push(draw);
          const m = ark.trigger2Settlement(claimants, d, pool, pr, att);
          assert.equal(m.capUnits, cap);
          assert.equal(draw, m.poolDraw);
          assert.equal(full, m.fullSettlement);
          let sum = 0n;
          for (const [i, c] of claimants.entries()) {
            const e = await math.call('trigger2Entitlement', [draw, W, ark.trigger2VestedWeight(c)]);
            assert.equal(e, m.entitlements[i], `entitlement ${i} at D ${d}`);
            sum += e;
          }
          assert.ok(sum <= draw, 'the entitlements never sum above the draw');
        }
        for (let k = 1; k < draws.length; k++) assert.ok(draws[k] >= draws[k - 1], 'non-decreasing in D');
        const held = await math.call('trigger2HeldPrincipal', [W, 6000n, pool, pr, cap]);
        assert.equal(held, ark.trigger2HeldPrincipal(W, 6000, pool, pr, cap));
        assert.equal(held + ark.trigger2PoolDraw(W, 6000, pool, pr, cap), full, 'the floor draw and the held principal sum to S_full');
        assert.ok(full <= ark.trigger2FullSettlement(W, pool, pr, 2n ** 200n), 'the cap never raises S_full');
        for (const c of claimants) {
          const w = ark.trigger2VestedWeight(c);
          assert.equal(
            await math.call('trigger2BalanceEntitlement', [draws[3], draws[5], W, w]),
            ark.trigger2BalanceEntitlement(draws[3], draws[5], W, c),
          );
        }
      }
    }
    }
    // The per-escrow increment of one draw, by vested weight (R-3).
    for (const [j, s] of [[0n, 0n], [units(6), 0n], [units(60), units(15)], [1n, 1n]]) {
      for (const we of [0n, 1n, W / 3n, W, W + 1n]) {
        const [a, b] = pair(await math.call('trigger2EscrowDraws', [j, s, we, W]));
        const m = ark.trigger2EscrowDraws({ junior: j, senior: s }, we, W);
        assert.equal(a, m.junior);
        assert.equal(b, m.senior);
      }
    }
    // The scenario report's floor-draw table (part 6): 1,000 vested units at
    // 10,000 QRL at the fourth stage (att_eff 2,000: K = 200 units); bond
    // principal at complete cover and at one and a half times. Since EC-02 the
    // full settlement is bounded by K_T, so both books draw D_0 of K.
    const vested = ark.trigger2VestedWeight({ notional: units(1000), vestingBps: 10000 });
    const capK = await math.call('trigger2CapUnits', [units(1000), ATTACHMENT]);
    assert.equal(capK, units(200));
    for (const [cover, row] of [[200, [200, 120, 120, 0, 80]], [300, [200, 120, 120, 0, 80]]]) {
      const pool = asQrl(cover);
      const full = await math.call('trigger2FullSettlement', [vested, pool, price, capK]);
      const floor = await math.call('trigger2PoolDraw', [vested, 6000n, pool, price, capK]);
      const [dJ, dS] = pair(await math.call('classDrawsOnPrincipal', [floor, (pool * 7000n) / BPS, (pool * 3000n) / BPS]));
      const held = await math.call('trigger2HeldPrincipal', [vested, 6000n, pool, price, capK]);
      assert.deepEqual([full, floor, dJ, dS, held].map((q) => q / asQrl(1)), row.map(BigInt), `cover ${cover}`);
    }
  });

  test('EC-08: the reserve\'s one rate agrees with the model — auditYieldRate, psrEpochRate, psrTrailingRate, psrCapAtRate, psrCommitmentAdmissibleAtRate — on the escrow itself', async (t) => {
    if (skipUnless(t)) return;
    const { ark } = M;
    // The constructor immutable the deploy scripts pass (scripts/lib/deploy.js).
    const { auditYieldRateOf } = require('../scripts/lib/deploy');
    for (const bps of [1, 150, 220, 400, 10000]) {
      assert.equal(auditYieldRateOf({ auditYieldBps: bps }), ark.auditYieldRate(M.params, bps), `audit rate at ${bps} bps`);
    }
    const AUDIT = ark.auditYieldRate(M.params, 220);
    assert.equal(AUDIT, 421917808219179n);
    // The escrow's close-out and gate, on the origin leg's own build.
    const helpers = require('../ecdsa-stakings/shared/test/helpers');
    if (!fs.existsSync(path.join(helpers.buildDirFor('ethereum'), 'ArkStakeEscrowUnits.json'))) {
      return t.skip('no origin-chain build: run npm run compile:evm');
    }
    const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
    const { ACCOUNTS } = require('./harness');
    const ONE = UNIT;
    const chain = await helpers.originChain();
    const r = await helpers.relayFixture(chain, { treeHeight: 5 });
    const asset = await chain.deploy('MockAsset');
    const escrow = await chain.deploy(
      'ArkStakeEscrowUnits',
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [asset.address, r.relay.address, '0x' + 'ef'.repeat(20), ONE, 20, AUDIT],
    );
    for (const who of [ACCOUNTS.admin, ACCOUNTS.alice, ACCOUNTS.bob]) {
      await asset.send('mint', [who, 10_000n * ONE]);
      await asset.send('approve', [escrow.address, 10n ** 30n], { from: who });
    }
    await escrow.send('seed', [ONE], { from: ACCOUNTS.admin });
    // The leaf's factor 100 bps is psrCapEpochs 1 on a gap of 100; a four-epoch window; a levy above every cap.
    const TERM = 4;
    const p = { ...M.params, psrCapEpochs: 1, threatStage1Bps: 1850, threatStage4Bps: 1950, commitmentTermEpochs: TERM };
    const record = async () => {
      const e = await r.freshEpoch();
      const f = { sigmaBps: 1850, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 0, levyBps: 500, sigmaTargetBps: 1850, coveredBps: 10000, psrCapBps: 100, commitTermEpochs: TERM, stepQueued: false };
      const leaf = ids.allocationLeaf({ escrow: escrow.address, epoch: e, ...f });
      const s = await r.seal(leaf);
      await escrow.send('recordEpochAllocation', [s.epoch, ids.ALLOCATION_FIELDS.map((k) => f[k]), s.proof(leaf)]);
      return e;
    };
    const epochNow = () => BigInt(chain.timestamp) / 604800n;
    let e0 = await record();
    await escrow.send('anchor', ['0x' + '66'.repeat(20), 100n * ONE], { from: ACCOUNTS.alice });
    // Gross yields by epoch: quiet epochs (0) are never touched, and close with the next touch.
    const rates = [];
    let pending = null; // { gross, book } of the epoch in progress
    for (const y of [2n, 0n, 5n, 1n, 0n, 0n, 3n, 4n]) {
      if (y !== 0n) {
        const book = await escrow.call('positionShares');
        await asset.send('mint', [escrow.address, y * ONE]);
        const res = await escrow.send('sweep', []);
        if (pending) {
          // This touch closed the last touched epoch and every quiet one after it.
          const closedAt = pending.epoch;
          // Clamped at four audit rates since the re-audit of 2026-09-30 (ORIGIN-04), as the escrow clamps it.
          rates.push(ark.psrEpochRate(pending.gross, book, AUDIT));
          for (let k = closedAt + 1n; k < epochNow(); k++) rates.push(0n);
          const rate = ark.psrTrailingRate(p, rates, AUDIT);
          const cap = ark.psrCapAtRate(p, book, rate);
          const [ev] = escrow.events(res, 'ReserveCapped');
          assert.ok(ev, 'the levy is always above the cap here');
          assert.equal(ev.args.capShares, cap, `the cap after ${rates.length} closed epochs`);
        }
        pending = { epoch: epochNow(), gross: y * ONE };
      }
      chain.advanceTime(604800);
    }
    void e0;
    // The gate at the shared rate: a commitment whose book with the committed
    // ones is the reserve's exact cover is admitted, one unit less is not.
    await record();
    const book = await escrow.call('positionShares');
    rates.push(ark.psrEpochRate(pending.gross, book, AUDIT));
    for (let k = pending.epoch + 1n; k < epochNow(); k++) rates.push(0n);
    const rate = ark.psrTrailingRate(p, rates, AUDIT);
    // A first commitment of a fresh stake: its book is its deposit, less at most a share.
    await escrow.send('anchor', ['0x' + '66'.repeat(20), ONE], { from: ACCOUNTS.bob }); // closes the last epoch
    const reserve = await escrow.call('psrShares');
    const units = 50n * ONE;
    const admissible = (res) => ark.psrCommitmentAdmissibleAtRate(p, res, 0n, units, rate);
    // Top the reserve up to the least the model admits for `units` (the escrow's book of it is at most that).
    let need = reserve;
    while (!admissible(need)) need += (units * rate * 100n) / (BPS * ONE) + 1n;
    let lo = reserve;
    let hi = need;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (admissible(mid)) hi = mid;
      else lo = mid + 1n;
    }
    if (hi > reserve) await escrow.send('primePsr', [hi - reserve], { from: ACCOUNTS.admin });
    await escrow.send('anchorCommitted', ['0x' + '66'.repeat(20), units], { from: ACCOUNTS.alice });
  });

  test('EC-04: the value slices agree with the model — sliceFraction, slicedDrawTarget, slicedHeldPrincipal — and reduce to the unsliced draw at one slice', async (t) => {
    if (skipUnless(t)) return;
    const { ark } = M;
    const F18 = 10n ** 18n;
    for (const Phi of [F18, F18 / 3n, 7n, 0n]) {
      for (const n of [1, 2, 3, 7, 16]) {
        let sum = 0n;
        for (let i = 0; i < n; i++) {
          const f = await math.call('sliceFraction', [Phi, BigInt(n), BigInt(i)]);
          assert.equal(f, ark.sliceFraction(Phi, n, i), `φ_${i} of ${n}`);
          const lo = Phi / BigInt(n);
          assert.ok(f === lo || f === lo + 1n, 'the floor or the ceiling of Φ / n');
          sum += f;
        }
        assert.equal(sum, Phi, 'invariant 1: the fractions sum to Φ exactly');
        assert.equal(await math.call('sliceFraction', [Phi, BigInt(n), BigInt(n)]), 0n, 'zero outside [0, n)');
      }
    }
    for (const S of [0n, 1n, 12_345n * UNIT, asQrl(60_000)]) {
      for (const d of [0n, 1n, 6000n, 9999n, 10000n, 12000n]) {
        const z = d * F18;
        const target = await math.call('slicedDrawTarget', [S, z]);
        assert.equal(target, ark.slicedDrawTarget(S, z));
        assert.equal(target, ((d > 10000n ? 10000n : d) * S) / BPS, 'at z = D * F: floor(D * S / BPS), trigger2PoolDraw\'s');
      }
      for (const z of [0n, 6000n * F18 + 123n, 7777n * F18 / 3n]) {
        for (const open of [0n, 1n, F18 / 4n, F18]) {
          for (const reach of [0, 4000, 6000, 10000]) {
            const held = await math.call('slicedHeldPrincipal', [S, z, open, BigInt(reach)]);
            assert.equal(held, ark.slicedHeldPrincipal(S, z, open, reach), `held S ${S} z ${z} open ${open} reach ${reach}`);
            assert.ok(ark.slicedDrawTarget(S, z) + held <= S, 'invariant 3: the draw and the hold never pass S');
          }
        }
      }
      // With nothing settled on a balance the hold is trigger2HeldPrincipal's.
      assert.equal(await math.call('slicedHeldPrincipal', [S, 6000n * F18, F18, 4000n]), S - (6000n * S) / BPS);
    }
  });

  test('phase C3b: the settlement price the registry exposes is the model\'s at every breaker state (whitepaper §5.5, yellow paper §4.2)', async (t) => {
    if (skipUnless(t)) return;
    const { ark } = M;
    const carried = 10_000n * UNIT;
    for (const cleared of [true, false]) {
      for (const twap of [0n, 4_000n * UNIT, carried, 12_000n * UNIT]) {
        for (const emergency of [0n, 3_000n * UNIT, 8_000n * UNIT, 15_000n * UNIT]) {
          for (const k of [0, 1, 2, 5]) {
            for (const move of [1500, 2500, 3000]) {
              const floor = ark.emergencyPriceFloor(carried, move, k);
              assert.equal(await math.call('emergencyPriceFloor', [carried, BigInt(move), BigInt(k)]), floor);
              const got = await math.call('settlementPrice', [cleared, carried, twap, emergency, floor]);
              assert.equal(got, ark.settlementPrice({ breakerCleared: cleared, carried, twap30d: twap, emergency, floor }));
              assert.ok(got <= carried, 'every branch is bounded above by the carried price');
            }
          }
        }
      }
    }
    // R-2: the leading run of findings, a null holding back what is behind it.
    assert.deepEqual(ark.applicableRealisations([units(1), null, units(3)]), [units(1)]);
    assert.deepEqual(ark.applicableRealisations([0n, units(2), units(3)]), [0n, units(2), units(3)]);
  });

  test('phase C3: the hold determination, the measured loss, the queue weight and the sequential residual agree with the model', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    // The court may fix m_loss on a held balance 2 x W_a epochs after the window
    // closed, never where the series resumed, and with no later bound.
    for (const wa of [2, 4, 6]) {
      const p = { ...params, assessmentWindowEpochs: wa };
      assert.equal(ark.holdDeterminationOpensAfterEpochs(p), 2 * wa);
      for (let since = 0; since <= 3 * wa + 1; since++) {
        for (const resumed of [false, true]) {
          assert.equal(
            await math.call('holdDeterminationOpen', [BigInt(wa), BigInt(since), resumed]),
            ark.holdDeterminationOpen(p, since, resumed),
            `W_a ${wa} since ${since} resumed ${resumed}`,
          );
        }
      }
    }
    // m_loss (NOT a model function; the model takes it as input): the decline
    // of the series in bps of the reading at the ratification, truncated. Its
    // severity is the model's on that input, so the draw is the model's.
    for (const [pre, post] of [[10_000n, 10_000n], [10_000n, 12_000n], [10_000n, 3_000n], [10_000n, 1n], [3n, 2n], [0n, 5n]]) {
      const [ok, loss] = await math.call('measuredLossBps', [pre, post]);
      assert.equal(ok, pre !== 0n);
      if (!ok) continue;
      const expected = post >= pre ? 0n : ((pre - post) * BPS) / pre;
      assert.equal(loss, expected, `m_loss ${pre} -> ${post}`);
      const clamp = await math.call('measuredSeverityCeilingBps', [BigInt(params.maxEpochMoveBps), BigInt(params.assessmentWindowEpochs)]);
      const [, sev] = await math.call('trigger2SeverityBps', [BigInt(params.severityFloorBps), true, loss, clamp]);
      assert.equal(Number(sev), ark.trigger2SeverityBps(params, Number(loss)));
    }
    // The queue's exposure weight at every clean age, across the admissible
    // decay and floor (relation 9 aside), and the principal at that weight.
    for (const decay of [1000, 1333, 1500, 2000]) {
      for (const floor of [2000, 2500, 4000, 5000]) {
        const p = { ...params, queueDecayBps: decay, queueExposureFloorBps: floor };
        let last = Number(BPS);
        for (let age = 0; age <= 12; age++) {
          const x = Number(await math.call('queueExposureBps', [BigInt(decay), BigInt(floor), BigInt(age)]));
          assert.equal(x, ark.queueExposureBps(p, age), `decay ${decay} floor ${floor} age ${age}`);
          assert.ok(x <= last && x >= floor, 'never rising with age, never below the floor');
          last = x;
          if (age >= 8) assert.equal(x, floor, 'from an age of eight every admissible weight is the floor (QUEUE_AGES)');
          for (const principal of [0n, 1n, units(7), units(1234.5)]) {
            assert.equal(await math.call('queuedAtExposure', [principal, BigInt(x)]), ark.queuedAtExposure(principal, x));
          }
        }
      }
    }
    // The subrogation residual across successors, applied as the bond applies
    // it (recoveryAllocation against P_rem, one opening at a time): the model's
    // sequentialRecovery, and never more than P across every fork (I36).
    for (const P of [0n, units(6), units(60)]) {
      for (const forks of [[units(2)], [units(2), units(3)], [units(50), units(1), units(40)], [0n, units(100), units(1)]]) {
        let rem = P;
        const model = ark.sequentialRecovery(forks, P);
        let total = 0n;
        for (let i = 0; i < forks.length; i++) {
          const [b, a] = pair(await math.call('recoveryAllocation', [forks[i], rem]));
          assert.equal(b, model[i].bond, `fork ${i}`);
          assert.equal(a, model[i].anchored);
          assert.ok(rem - b <= rem, 'P_rem never rises');
          rem -= b;
          total += b;
        }
        assert.ok(total <= P);
      }
    }
  });

  test('the quantities of the papers\' EC revision agree with the model (2026-09-30: EC-01 - EC-07, PV-01 - PV-26)', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    // PV-03: the measured-severity ceiling over the epoch bound and the window.
    for (const move of [0, 1500, 2048, 2500, 3000, 10000]) {
      for (const epochs of [0, 1, 2, 3, 4, 6, 12]) {
        assert.equal(
          Number(await math.call('measuredSeverityCeilingBps', [BigInt(move), BigInt(epochs)])),
          ark.measuredSeverityCeilingBps({ ...params, maxEpochMoveBps: move }, epochs),
          `ceiling m_epoch ${move} over ${epochs}`,
        );
      }
    }
    assert.equal(ark.measuredSeverityCeilingBps(params), 6835);
    // PV-11: the pro-rata freeze of one holding.
    for (const [holding, cls, held] of [[0n, 10n, 5n], [7n, 0n, 1n], [units(70), units(100), units(40)], [units(1), units(3), units(1)], [units(200), units(100), units(300)], [1n, units(1000), 1n]]) {
      assert.equal(await math.call('heldFreezeOfHolding', [holding, cls, held]), ark.heldFreezeOfHolding(holding, cls, held), `freeze ${holding}/${cls}/${held}`);
    }
    // EC-03, PV-13: the batching threshold at the decimals of the asset.
    for (const [multiple, cost] of [[50, 600000], [0, 600000], [50, 0], [100, 10000000], [1, 1]]) {
      for (const scale of [10n ** 18n, 10n ** 6n, 10n ** 8n, 1n]) {
        const p = { ...params, offeringBatchMultiple: multiple, claimCostGwei: cost };
        assert.equal(
          await math.call('offeringBatchThresholdUnits', [BigInt(multiple), BigInt(cost), scale]),
          ark.offeringBatchThresholdUnits(p, scale),
          `threshold ${multiple} x ${cost} at ${scale}`,
        );
      }
    }
    assert.equal(ark.offeringBatchThresholdUnits(params), units(0.03), '0.03 ETH at the reference values');
    // EC-05: the ramp threshold.
    for (const threshold of [500, 1000, 2000]) {
      for (const [buffer, k] of [[0n, 0n], [0n, units(1)], [units(10), units(100)], [units(9.9999), units(100)], [units(20), units(100)]]) {
        assert.equal(
          await math.call('bufferBelowRampThreshold', [BigInt(threshold), buffer, k]),
          ark.bufferBelowRampThreshold({ ...params, bufferRampThresholdBps: threshold }, buffer, k),
          `ramp ${threshold} at ${buffer}/${k}`,
        );
      }
    }
    // EC-05: the seeding deposit the deploy script sizes an escrow at, 500 bps of K_0, rounded up.
    const { seedMinimumOf } = require('../scripts/lib/deploy');
    for (const k0 of [1n, units(200), units(24.68), 10n ** 30n + 7n]) {
      assert.equal(seedMinimumOf({ auditRequirement: k0 }), ark.seedingDepositMinimumUnits(params, k0), `seed at K_0 ${k0}`);
    }
    // EC-04, PV-01, PV-07: value slices, the capacity, V, V_max and the indexed seat.
    for (const value of [0n, 1n, units(7), units(250), units(10_000)]) {
      for (const seat of [0n, units(1), units(10), units(10_000)]) {
        assert.equal(
          Number(await math.call('findingSlices', [value, seat, BigInt(params.jurorSlashBps), BigInt(params.verdictCoverBps)])),
          ark.findingSlices(value, seat, params.jurorSlashBps, params.verdictCoverBps),
          `slices ${value} at ${seat}`,
        );
        assert.equal(Number(await math.call('courtCaseCapacity', [value * 77n, seat])), ark.courtCaseCapacity(value * 77n, seat));
      }
      for (const limit of [0n, units(3), units(250)]) {
        assert.equal(await math.call('lossFindingValue', [value, limit]), ark.lossFindingValue(value, limit));
        for (const base of [0n, units(100), units(10_000)]) {
          assert.equal(
            await math.call('findingValueMax', [BigInt(params.trigger2FloorBps), limit, base]),
            ark.findingValueMax(params, limit, base),
            `V_max ${limit}/${base}`,
          );
        }
      }
      for (const floor of [0n, units(10_000)]) {
        for (const opened of [0n, units(5_000), units(50_000)]) {
          assert.equal(await math.call('indexedMinimumJurorStake', [floor, value, opened]), ark.indexedMinimumJurorStakeArk(floor, value, opened));
        }
      }
    }
  });

  test('the buffer escalator, the levy and the reserve cap agree with the model', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    const cap = Number(await math.call('bufferEscalatorCapBps'));
    for (const [base, hMax] of [[250, 2500], [250, 3000], [1000, 2500], [1500, 2500], [250, 0]]) {
      const p = { ...params, bufferBps: base, fxHaircutMaxBps: hMax, bufferEscalatorCapBps: cap };
      for (const h of [0, 1, 625, 1250, 1800, 2499, 2500, 3000, 4000]) {
        assert.equal(
          Number(await math.call('bufferShareInForceBps', [BigInt(base), BigInt(cap), BigInt(hMax), BigInt(h)])),
          ark.bufferShareInForceBps(p, h),
          `buffer at base ${base} h_max ${hMax} h ${h}`,
        );
      }
    }
    for (const levy of [100, 200, 500]) {
      for (const stage of [1, 2, 3, 4]) {
        assert.equal(
          Number(await math.call('stabilizationLevyInForceBps', [BigInt(levy), BigInt(stage)])),
          ark.stabilizationLevyInForceBps({ ...params, stabilizationLevyBps: levy }, stage),
          `levy ${levy} at stage ${stage}`,
        );
      }
    }
    for (const epochs of [2, 6, 12]) {
      for (const y of [0n, 1n, units(3.7), units(1000)]) {
        const p = { ...params, psrCapEpochs: epochs };
        assert.equal(
          await math.call('psrCapUnits', [BigInt(epochs), BigInt(p.threatStage1Bps), BigInt(p.threatStage4Bps), y]),
          ark.psrCapUnits(p, y),
          `psr cap ${epochs} at ${y}`,
        );
      }
    }
  });

  // Gap items 17, 18 and 19 (CLAUDE.md), implemented 2026-09-28 (phase C2).
  test('the solver bond, the shortfall carry and the reserve top-up agree with the model (I33, I34, I39)', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    const bond = (p, d) =>
      math.call('solverBondBps', [
        BigInt(p.solverBondCeilingBps), BigInt(p.solverBondFloorBps), BigInt(p.maxEpochMoveBps), BigInt(p.reserveFloorBps), BigInt(d),
      ]);
    for (const [ceiling, floor] of [[750, 150], [500, 100], [1500, 300], [600, 700]]) {
      for (const [move, reserveFloor] of [[2500, 5000], [1500, 6000], [3000, 2500], [2500, 2500]]) {
        const p = { ...params, solverBondCeilingBps: ceiling, solverBondFloorBps: floor, maxEpochMoveBps: move, reserveFloorBps: reserveFloor };
        for (const d of [0, 1, 2499, 2500, 2501, 3000, 3500, 4000, 4500, 4999, 5000, 6000, 9999]) {
          assert.equal(Number(await bond(p, d)), ark.solverBondBps(p, d), `bond ${ceiling}/${floor} at ${move}..${reserveFloor}, d ${d}`);
        }
      }
    }
    // Yellow paper §3.5, re-anchored at m_epoch (item 25d): 750, 630, 510, 390, 270, 150 across the ladder.
    const ladder = [];
    for (let k = 0; k < 6; k++) ladder.push(Number(await bond(params, params.maxEpochMoveBps + k * params.reserveStepBps)));
    assert.deepEqual(ladder, [750, 630, 510, 390, 270, 150]);
    for (const lot of [0n, 1n, UNIT, 12_345n * UNIT]) {
      for (const bps of [0, 150, 750, 10_000]) {
        assert.equal(await math.call('solverBondQrl', [lot, BigInt(bps)]), ark.solverBondQrl(lot, bps), `bond qrl ${lot} ${bps}`);
      }
    }
    for (const retained of [0n, 1n, UNIT, units(37.5), units(1000)]) {
      for (const price of [0n, 1n, REF_PRICE, REF_PRICE * 3n]) {
        for (const floor of [0, 2500, 5000, 6000, 10_000]) {
          assert.equal(
            await math.call('shortfallCarryQrl', [retained, price, BigInt(floor)]),
            ark.shortfallCarryQrl(retained, price, floor),
            `carry ${retained} at ${price}, floor ${floor}`,
          );
        }
      }
    }
    const rungs = [params.threatStage1Bps, params.threatStage2Bps, params.threatStage3Bps, params.threatStage4Bps];
    for (const spot of rungs) {
      for (const commit of rungs) {
        for (const covered of [0, 1, 5000, 9999, 10_000]) {
          for (const y of [0n, 1n, units(3.7), units(1000)]) {
            assert.equal(
              await math.call('psrTopUpUnits', [BigInt(spot), BigInt(commit), BigInt(covered), y]),
              ark.psrTopUpUnits(spot, commit, covered, y),
              `top-up ${spot}/${commit} at ${covered}, y ${y}`,
            );
          }
        }
      }
    }
    for (const epochs of [2, 6, 12]) {
      const p = { ...params, psrCapEpochs: epochs };
      const factor = await math.call('psrCapFactorBps', [BigInt(epochs), BigInt(p.threatStage1Bps), BigInt(p.threatStage4Bps)]);
      for (const y of [0n, 1n, units(3.7), units(1000)]) {
        // The escrow's cap is the leaf's factor over BPS: the model's cap exactly.
        assert.equal((factor * y) / BPS, ark.psrCapUnits(p, y), `cap factor ${epochs} at ${y}`);
      }
    }
  });

  // Gap item 23 (CLAUDE.md), implemented 2026-09-28: the bound is κ in basis
  // points over BPS² (κ = 6,666, whitepaper §6.2, yellow paper Eq. 4.1′/4.2′, I24′).
  test('the verdict bound agrees with the model (κ in basis points)', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    assert.equal(
      await math.call('verdictBound', [units(7), 3000n, BigInt(params.verdictCoverBps)]),
      ark.verdictBound(units(7), 3000, params.verdictCoverBps),
    );
    for (const stake of [0n, 1n, units(4), units(333.333)]) {
      for (const slash of [0, 500, 3000, 12000]) {
        for (const kappa of [0, 3333, 6666, 8000]) {
          assert.equal(
            await math.call('verdictBound', [stake, BigInt(slash), BigInt(kappa)]),
            ark.verdictBound(stake, slash, kappa),
            `bound ${stake}/${slash}/${kappa}`,
          );
          assert.equal(await math.call('bribeCostFloor', [stake, BigInt(kappa)]), ark.bribeCostFloor(stake, kappa), `floor ${stake}/${kappa}`);
        }
      }
    }
  });

  test('the exit parity and run-off relations agree with the model', async (t) => {
    if (skipUnless(t)) return;
    const { ark, params } = M;
    for (const releaseBoundBps of [1000, 2000, 2500]) {
      const p = { ...params, releaseBoundBps };
      const horizon = await math.call('settlementHorizonEpochs', [BigInt(21 * DAY), BigInt(7 * DAY), BigInt(releaseBoundBps)]);
      assert.equal(Number(horizon), ark.settlementHorizonEpochs(p));
      assert.equal(Number(await math.call('maturityLadderMaxBps', [horizon])), ark.maturityLadderMaxBps(p));
    }
    for (const ladder of [1000, 1428, 2500]) {
      assert.equal(Number(await math.call('runoffHorizonEpochs', [BigInt(ladder)])), ark.runoffHorizonEpochs({ ...params, maturityLadderBps: ladder }));
    }
    for (const base of [0n, 1n, units(1000), units(333.333)]) {
      for (const bound of [1000, 2500]) {
        assert.equal(await math.call('releaseBoundUnits', [base, BigInt(bound)]), ark.releaseBoundUnits({ ...params, releaseBoundBps: bound }, base));
      }
    }
    for (const bound of [1500, 2000, 2500]) {
      assert.equal(Number(await math.call('runoffDrainEpochs', [BigInt(bound)])), ark.runoffDrainEpochs({ ...params, runoffBoundBps: bound }));
      for (const queued of [0n, units(1), asQrl(170)]) {
        assert.equal(await math.call('runoffReleaseQrl', [BigInt(bound), asQrl(200), queued]), ark.runoffReleaseQrl({ ...params, runoffBoundBps: bound }, asQrl(200), queued));
      }
    }
    for (const stage of [1, 3, 4]) {
      for (const [now, before] of [[asQrl(200), asQrl(200)], [asQrl(149), asQrl(200)], [asQrl(300), asQrl(200)], [0n, 0n]]) {
        assert.equal(await math.call('runoffGateGround', [BigInt(stage), now, before, 2500n]), ark.runoffGateClosed(params, stage, now, before));
      }
    }
    // Net of the conditional release (B-M3): the bond hands the ground the
    // earlier reading less what the release paid, floored at zero, which is
    // the model's `conditionallyReleased` argument.
    for (const [now, before, released] of [
      [asQrl(40), asQrl(200), asQrl(160)],
      [asQrl(30), asQrl(200), asQrl(160)],
      [asQrl(29), asQrl(200), asQrl(160)],
      [asQrl(10), asQrl(200), asQrl(250)],
      [asQrl(149), asQrl(200), 0n],
      [0n, asQrl(1), asQrl(1)],
    ]) {
      const net = before > released ? before - released : 0n;
      assert.equal(
        await math.call('runoffGateGround', [1n, now, net, 2500n]),
        ark.runoffGateClosed(params, 1, now, before, released),
        `${now} after ${before} less ${released}`,
      );
      assert.equal(Number(await math.call('runoffContractionBps', [now, net])), ark.runoffContractionBps(now, before, released));
    }
  });

  test("relation 9 of §6.3, by the drain length, is the model's", async (t) => {
    // queueExposureFloorMaxBps / queueFloorRelationHolds (2026-09-28): the floor
    // is not above BPS - (n_d - 1) x decay, n_d = ceil(BPS / m_B). Replaces the
    // older BPS - 4 x decay, which the model no longer states. Negative where
    // the decay is too steep for the drain, as the model's is.
    if (skipUnless(t)) return;
    const { ark, params } = M;
    for (const bound of [0, 1500, 1666, 1667, 2000, 2499, 2500]) {
      for (const decay of [1000, 1333, 1334, 1500, 1875, 1876, 2000]) {
        const p = { ...params, runoffBoundBps: bound, queueDecayBps: decay };
        const max = await math.call('queueExposureFloorMaxBps', [BigInt(bound), BigInt(decay)]);
        assert.equal(Number(max), ark.queueExposureFloorMaxBps(p), `m_B=${bound} decay=${decay}`);
        for (const floor of [2000, 2500, 4000, 5000]) {
          assert.equal(
            await math.call('queueFloorRelationHolds', [BigInt(floor), BigInt(bound), BigInt(decay)]),
            ark.queueFloorRelationHolds({ ...p, queueExposureFloorBps: floor }),
            `m_B=${bound} decay=${decay} floor=${floor}`,
          );
        }
      }
    }
  });

  test('the reference values in ArkStakeParams are ARK_STAKING', async (t) => {
    if (skipUnless(t)) return;
    const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'ArkStakeParams.hyp'), 'utf8');
    const deployed = {};
    for (const [, k, v] of src.matchAll(/(\w+):\s*(\d+),?\r?\n/g)) deployed[k] = Number(v);
    const { params } = M;
    for (const [key, value] of Object.entries(deployed)) {
      if (key in params) assert.equal(value, params[key], `${key}: contract ${value}, specification ${params[key]}`);
    }
    // The contract's ladder tops out at the value the document is evaluated at.
    assert.equal(deployed.threatStage4Bps, params.sigmaTargetBps);
    assert.equal(deployed.threatStage1Bps, params.threatStage1Bps);
    // The parameters of the 2026-09-26 revision are in the set, not just absent from it.
    for (const k of ['stabilizationLevyBps', 'commitmentTermEpochs', 'psrCapEpochs', 'trigger2FloorBps', 'severityFloorBps',
      'assessmentWindowEpochs', 'queueDecayBps', 'queueExposureFloorBps', 'jurorSlashBps', 'verdictCoverBps',
      // The keys of the timelock's table added 2026-09-28 (phase C1b).
      'bufferEscalatorCapBps', 'solverBondCeilingBps', 'solverBondFloorBps', 'successorLimit',
      'challengeWindowDays', 'evidenceDays', 'commitDays', 'revealDays', 'appealDays',
      // In ARK_STAKING since the JSON export (audit B9, 2026-09-29).
      'admittedTermsMask', 'validatorConcentrationBps']) {
      assert.equal(deployed[k], params[k], k);
    }
    // Nothing the contract's reference set carries is missing from the specification's.
    const reference = src.slice(src.indexOf('function _reference()'));
    const refKeys = [...reference.slice(0, reference.indexOf('});')).matchAll(/(\w+):\s*\d+/g)].map(([, k]) => k);
    assert.ok(refKeys.length > 50, `read ${refKeys.length} reference values`);
    assert.deepEqual(refKeys.filter((k) => !(k in params)), [], 'reference values with no ARK_STAKING field');
    // The escalator's cap is a field since 2026-09-28; its ceiling, the top of
    // the buffer range and the escrow's constant, is ArkStakeMath's. The
    // seeding value is still a constant.
    const math = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'utils', 'ArkStakeMath.hyp'), 'utf8');
    assert.equal(Number(/BUFFER_ESCALATOR_CAP_BPS = (\d+)/.exec(math)[1]), params.bufferEscalatorCapBps);
    // The ranges and relations moved to the module with it (item 128).
    const checks = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'ArkStakeParamsChecks.hyp'), 'utf8');
    assert.equal(Number(/SEED_BUFFER_BPS = (\d+)/.exec(checks)[1]), params.bufferSeedingBps);
    const escrow = fs.readFileSync(path.join(__dirname, '..', 'ecdsa-stakings', 'shared', 'contracts', 'ArkStakeEscrow.sol'), 'utf8');
    assert.equal(Number(/BUFFER_MAX_BPS = ([\d_]+)/.exec(escrow)[1].replace(/_/g, '')), params.bufferEscalatorCapBps,
      'the escrow admits the escalated share up to the cap');
  });

  test('the bond terms are the three of whitepaper §6.3, by the ordinal of the admitted-terms mask', async (t) => {
    if (skipUnless(t)) return;
    const store = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'ArkCatBondStore.hyp'), 'utf8');
    const term = (name) => Number(new RegExp(`${name} = (\\d+);`).exec(store)[1]);
    const epochs = [term('TERM_QUARTER_EPOCHS'), term('TERM_YEAR_EPOCHS'), term('TERM_THREE_YEAR_EPOCHS')];
    assert.deepEqual(epochs, M.config.ARK_STAKING_GOVERNANCE.bondTermEpochs);
    // One bit per term, all admitted at the reference values.
    assert.equal(M.params.admittedTermsMask, (1 << epochs.length) - 1);
  });
});

/* ==================================================================== */
describe('the constants the two legs share', () => {
  // Ark Staking runs on two chains, in two languages, out of two build
  // directories. Several quantities have to be identical in both and there is
  // no compiler, no import and no type that says so — the QRL leg is Hyperion
  // under hypc, the origin leg is Solidity under solc, and the relayer is plain
  // JavaScript. A change to one of them is a silent desynchronisation of the
  // product, so the sources are read as text and compared here. An artifact
  // would not do: an `internal constant` in a library exposes nothing.
  const src = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
  const days = (text, name) => {
    const m = new RegExp(`${name}\\s*=\\s*(\\d+)\\s*days`).exec(text);
    assert.ok(m, `${name} not found`);
    return Number(m[1]);
  };
  const bps = (text, name) => {
    const m = new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(text);
    assert.ok(m, `${name} not found`);
    return Number(m[1].replace(/_/g, ''));
  };

  const ARK_EPOCH = ['contracts', 'utils', 'ArkEpoch.hyp'];
  const EPOCH_LIB = ['ecdsa-stakings', 'shared', 'contracts', 'ArkEpochLib.sol'];
  const ESCROW = ['ecdsa-stakings', 'shared', 'contracts', 'ArkStakeEscrow.sol'];
  const PARAMS = ['contracts', 'ArkStakeParams.hyp'];
  const CHECKS = ['contracts', 'ArkStakeParamsChecks.hyp'];
  const REGISTRY = ['contracts', 'ArkStakeRegistry.hyp'];
  const RELAYER_EPOCH = ['ecdsa-stakings', 'relayer', 'lib', 'epoch.js'];

  test('both chains and the relayer measure an epoch the same way', () => {
    // An epoch number is the key a delivery, a coupon draw, a spent proof and
    // an accepted root are all recorded under. Two legs disagreeing about its
    // length file the same fact under two different numbers, and every
    // cross-chain proof stops resolving.
    const qrl = days(src(...ARK_EPOCH), 'EPOCH_LENGTH');
    const origin = days(src(...EPOCH_LIB), 'EPOCH_LENGTH');
    const relayer = Number(/EPOCH_LENGTH = (\d+)n/.exec(src(...RELAYER_EPOCH))[1]);

    assert.equal(qrl, 7);
    assert.equal(origin, qrl, 'ArkEpochLib disagrees with ArkEpoch');
    assert.equal(relayer, qrl * 24 * 3600, 'the relayer disagrees with both');
  });

  test('both chains carry the same coupon cliff, and the epoch stays under it', () => {
    const qrl = days(src(...ARK_EPOCH), 'COUPON_CLIFF');
    const origin = days(src(...EPOCH_LIB), 'COUPON_CLIFF');
    const relayer = Number(/COUPON_CLIFF = (\d+)n/.exec(src(...RELAYER_EPOCH))[1]);

    assert.equal(qrl, 30);
    assert.equal(origin, qrl);
    assert.equal(relayer, qrl * 24 * 3600);
    assert.ok(days(src(...ARK_EPOCH), 'EPOCH_LENGTH') <= qrl, 'the bound of whitepaper section 6.3');
  });

  test('the escrow serves at least the unbonding period the registry records', () => {
    // A leaf sealed into epoch e is usable from e + RELEASE_EPOCH_DELAY, and a
    // leaf can never be sealed into an epoch earlier than the one it was
    // created in, so the escrow waits more than (delay - 1) epochs. That must
    // cover the twenty-one days the QRL leg states, or the origin chain would
    // release a position the registry still holds in unbonding.
    const unbonding = days(src(...ARK_EPOCH), 'UNBONDING_PERIOD');
    const epoch = days(src(...ARK_EPOCH), 'EPOCH_LENGTH');
    const delay = bps(src(...ESCROW), 'RELEASE_EPOCH_DELAY');
    // Enforced by the relay's copy since 2026-09-29 (`releaseReceipt`, X7):
    // the escrow's figure is the rule, and the relay's must be the same.
    assert.equal(bps(src('ecdsa-stakings', 'shared', 'contracts', 'ArkEpochRootRelay.sol'), 'RELEASE_EPOCH_DELAY'), delay);
    assert.equal(unbonding, 21);
    assert.ok((delay - 1) * epoch >= unbonding, `a delay of ${delay} epochs serves ${(delay - 1) * epoch} days`);
    assert.ok(unbonding > 20, 'the unbonding period exceeds the dispute cycle with its appeal');
  });

  test('neither book may drain faster than the other', () => {
    // The QRL bound enters the exit parity of I25; the escrow's is the one that
    // actually moves the asset. The ceiling is what makes a vote above the
    // escrow's unreachable, and it is worth nothing if somebody edits the
    // escrow's constant alone.
    const escrow = bps(src(...ESCROW), 'RELEASE_BOUND_BPS');
    const ceiling = bps(src(...PARAMS), 'MAX_RELEASE_BOUND_BPS');
    const deployed = Number(/releaseBoundBps:\s*(\d+)/.exec(src(...PARAMS))[1]);

    assert.equal(escrow, 2500, 'the value whitepaper section 6.3 carries');
    assert.equal(ceiling, escrow, 'the QRL ceiling is the escrow constant');
    // The range is checked in the parameter set's module since item 128, which
    // carries the ceiling as a literal of its own.
    assert.equal(bps(src(...CHECKS), 'MAX_RELEASE_BOUND_BPS'), ceiling, 'the checks module checks the same ceiling');
    assert.ok(deployed <= ceiling, 'the deployed default sits inside its own ceiling');
  });

  test('the relay carries the papers\' admission constants: the ratchet is the censorship window, four generations, the [5,000, 9,500) window, the 8,000 horizon (C5)', async (t) => {
    // whitepaper §3.6 and §6.4, yellow paper §2.2: the delay of an extension is
    // the censorship window, so the model's `censorshipWindowEpochs` and the
    // relay's constant are one figure; the threshold rule is the model's.
    const relay = src('ecdsa-stakings', 'shared', 'contracts', 'ArkEpochRootRelay.sol');
    const ratchet = Number(/uint64 public constant RATCHET_EPOCHS = (\d+);/.exec(relay)[1]);
    assert.equal(Number(/uint8 public constant MAX_GENERATIONS = (\d+);/.exec(relay)[1]), 4);
    assert.equal(bps(relay, 'EXTENSION_OPENS_BPS'), 5000);
    assert.equal(bps(relay, 'EXTENSION_CLOSES_BPS'), 9500);
    assert.equal(bps(relay, 'HORIZON_BPS'), 8000);
    const relayer = src('ecdsa-stakings', 'relayer', 'engine', 'relayer.js');
    assert.equal(Number(/const RATCHET_EPOCHS = (\d+);/.exec(relayer)[1]), ratchet, 'the relayer schedules against the same delay');
    if (!M) return t.skip(MISSING);
    assert.equal(ratchet, M.params.censorshipWindowEpochs, 'the ratchet is the censorship window of whitepaper §6.4');
    assert.deepEqual({ ...M.ark.ROOT_SIGNER_SET_REFERENCE }, { k: 2, n: 3 });
    const auth = require('../ecdsa-stakings/relayer/lib/authority');
    for (let n = 1; n <= 16; n += 1) {
      for (let k = 0; k <= n + 1; k += 1) assert.equal(auth.thresholdAdmissible(k, n), M.ark.signerThresholdAdmissible(k, n), `k=${k} n=${n}`);
    }
  });

  test('both legs separate this product from every other leaf in the roots', () => {
    // Without the tag a root sealed to record an anchoring also satisfies the
    // insurance claim path. Whitepaper section 3.5.
    const tag = /ARK_STAKE_V1/;
    assert.match(src(...REGISTRY), tag);
    assert.match(src('ecdsa-stakings', 'shared', 'contracts', 'ArkStakeIds.sol'), tag);
    assert.match(src('ecdsa-stakings', 'relayer', 'lib', 'identifiers.js'), tag);
  });

  test('the allocation leaf carries the same domain on both legs', () => {
    // V4 since 2026-09-30 (stepQueued; QL-25, PV-20). The QRL side builds it in
    // ArkStakeLeaves, which the registry seals from; both legs carry the tag and its hash.
    const tag = /ARK_STAKE_ALLOCATION_V4/;
    const hash = /0x00dea64034af1c14fb698f0f5d5dc90f019a7ebd16e16a20664167d7d7e352fc/;
    for (const file of [['contracts', 'utils', 'ArkStakeLeaves.hyp'], ['ecdsa-stakings', 'shared', 'contracts', 'ArkStakeIds.sol']]) {
      assert.match(src(...file), tag);
      assert.match(src(...file), hash);
    }
    assert.match(src(...REGISTRY), /ArkStakeLeaves.ALLOCATION_DOMAIN/);
  });
});

/* ==================================================================== */
describe('the shared clock', () => {
  test('an epoch is seven days and does not exceed the coupon cliff', async () => {
    const epoch = await math.call('epochLength');
    const cliff = await math.call('couponCliff');
    assert.equal(epoch, BigInt(7 * DAY));
    assert.equal(cliff, BigInt(30 * DAY));
    assert.ok(epoch <= cliff, 'an epoch longer than the cliff would stop the cliff binding');
  });

  test('epochs are numbered from the Unix epoch, not from a deployment', async () => {
    assert.equal(await math.call('epochOf', [0n]), 0n);
    assert.equal(await math.call('epochOf', [BigInt(7 * DAY - 1)]), 0n);
    assert.equal(await math.call('epochOf', [BigInt(7 * DAY)]), 1n);
    assert.equal(await math.call('startOf', [1n]), BigInt(7 * DAY));
  });

  test('the clock follows the chain', async () => {
    const before = await math.call('currentEpoch');
    chain.advanceTime(7 * DAY);
    assert.equal(await math.call('currentEpoch'), before + 1n);
  });
});
