/**
 * The build profiles. The rule under test: a time-compressed build moves every
 * duration of this product by one factor, touches nothing else, and refuses to
 * build rather than leave a duration it cannot scale.
 *
 * Pure source text — no compiler — so it runs against the files `compile.js`
 * and `compile-evm.js` actually read.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { profile, rewriteSource, scaled, ProfileError, DAY } = require('../scripts/lib/profile');
const manifest = require('../ecdsa-stakings/relayer/lib/manifest');
const { clockFor, EPOCH_LENGTH } = require('../ecdsa-stakings/relayer/lib/epoch');
const { loadModel, MISSING } = require('./spec-model');

const ROOT = path.join(__dirname, '..');
const src = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const TESTNET = profile('testnet');

/** `NAME = <expr>;` evaluated, for a constant whose expression is arithmetic only. */
function constantSeconds(text, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*([^;]+);`).exec(text);
  assert.ok(m, `${name} not found`);
  const expr = m[1].replace(/\b(\d+)\s+days\b/g, `($1 * ${DAY})`).replace(/\b(\d+)\s+hours\b/g, '($1 * 3600)');
  assert.match(expr, /^[\d\s*()+]+$/, `${name} is not a plain duration: ${m[1]}`);
  return Function(`return ${expr}`)();
}

const SOURCES = {
  epoch: ['contracts', 'utils', 'ArkEpoch.hyp'],
  epochLib: ['ecdsa-stakings', 'shared', 'contracts', 'ArkEpochLib.sol'],
  params: ['contracts', 'ArkStakeParamsChecks.hyp'],
  registry: ['contracts', 'ArkStakeRegistry.hyp'],
  coupon: ['contracts', 'ArkBondCoupon.hyp'],
};

describe('the testnet profile', () => {
  test('one day becomes ten minutes, so a week-long epoch lasts seventy', () => {
    const at = (key, name) => constantSeconds(rewriteSource(src(...SOURCES[key]), TESTNET).text, name);
    assert.equal(at('epoch', 'EPOCH_LENGTH'), 4200);
    assert.equal(at('epoch', 'UNBONDING_PERIOD'), 12600);
    assert.equal(at('epoch', 'COUPON_CLIFF'), 18000);
    assert.equal(at('epoch', 'QUOTE_WINDOW'), 600);
    assert.equal(at('epoch', 'ADMISSION_WINDOW'), 600);
    assert.equal(at('epoch', 'EVM_CLAIM_WINDOW'), 600);
    // Raised from the factor's 1,200 s to Hoodi's finality bound (D12; see below).
    assert.equal(at('epoch', 'QRL_CLAIM_MARGIN'), 1596);
    assert.equal(at('epochLib', 'ADMISSION_WINDOW'), 600);
    assert.equal(at('epochLib', 'EVM_CLAIM_WINDOW'), 600);
    assert.equal(at('epoch', 'CHALLENGE_WINDOW'), 4200);
    assert.equal(at('epochLib', 'EPOCH_LENGTH'), 4200);
    assert.equal(at('epochLib', 'COUPON_CLIFF'), 18000);
    // The first-round cycle is the court's windows since 2026-09-28, governed
    // in days of this unit: fifteen of them are 9,000 s, as the constant was.
    assert.equal(at('params', 'COURT_DAY'), 600);
    assert.equal(at('registry', 'VESTING_WINDOW'), 54000);
    // The cap on a maturity held against a claim (whitepaper §5.3).
    assert.equal(at('epoch', 'DISPUTE_CYCLE_APPEAL'), 12000);
    // The year the senior coupon is quoted against. Only its ratio to the epoch is
    // ever read, and both moved by the same factor.
    assert.equal(at('coupon', 'YEAR'), 219000);
  });

  test('the bond names no duration of its own, so a profile has nothing in it to get wrong', () => {
    // Its terms are counted in epochs and its cliff and hold cap are read from
    // `ArkEpoch`. A duration literal appearing here later would be scaled
    // silently, and this is the test that would say so.
    const { rewrites } = rewriteSource(src('contracts', 'ArkCatBond.hyp'), TESTNET, 'ArkCatBond.hyp');
    assert.deepEqual(rewrites, []);
  });

  test('every rewritten duration is its spec value divided by the same factor', () => {
    // A ratio between any two durations is therefore what the specification
    // states, which is every time relation of whitepaper §6.3.
    for (const parts of Object.values(SOURCES)) {
      const { rewrites } = rewriteSource(src(...parts), TESTNET, parts.join('/'));
      assert.ok(rewrites.length > 0, `${parts.join('/')} has a duration to scale`);
      for (const r of rewrites) {
        // The one override a profile carries is not a scaled duration; the D12 test holds it.
        if (r.override) continue;
        const spec = constantSeconds(`X = ${r.from};`, 'X');
        const scaledValue = constantSeconds(`X = ${r.to};`, 'X');
        assert.equal(scaledValue * 144, spec, `${r.file}: ${r.from} -> ${r.to}`);
      }
    }
  });

  test('D12: the QRL claim margin is raised to twice origin finality plus a relayer interval, and the settlement still closes inside the epoch (whitepaper §4.7)', async (t) => {
    const { qrlClaimMarginSeconds, HOODI_FINALITY_SECONDS, RELAYER_INTERVAL_SECONDS } = require('../scripts/lib/profile');
    const margin = TESTNET.overrides.QRL_CLAIM_MARGIN;
    assert.equal(margin, qrlClaimMarginSeconds(TESTNET.day, HOODI_FINALITY_SECONDS, RELAYER_INTERVAL_SECONDS));
    assert.ok(margin >= 2 * HOODI_FINALITY_SECONDS + RELAYER_INTERVAL_SECONDS);
    // Every Hoodi manifest the profile serves reveals within it.
    for (const chain of ['hoodi', 'hoodi-vps']) {
      const m = JSON.parse(src('ecdsa-stakings', chain, 'chain.json'));
      assert.equal(m.profile, 'testnet');
      assert.ok(2 * m.confirmations * (m.blockSeconds || 12) + RELAYER_INTERVAL_SECONDS <= margin, chain);
    }
    // I31 still holds: the QRL leg outlasts the origin leg by at least its
    // length, and the settlement of t closes before the quote window offering t + 1 opens.
    const day = TESTNET.day;
    const evm = 2 * day;
    assert.ok(margin >= evm);
    assert.ok(evm + margin + day < 7 * day);
    // The relayer's clock carries the same margin, and its expiry follows it.
    const clock = clockFor(TESTNET.day);
    assert.equal(clock.QRL_CLAIM_MARGIN, BigInt(margin));
    assert.equal(clock.settlementCloses(10n) - clock.evmExpiry(10n), BigInt(margin));
    // The specification's source and the other profiles are untouched.
    assert.match(src(...SOURCES.epoch), /QRL_CLAIM_MARGIN = 2 days;/);
    assert.equal(clockFor().QRL_CLAIM_MARGIN, 2n * 86400n);
    assert.equal(clockFor(60).QRL_CLAIM_MARGIN, 120n);
    // The model's rule, where the sibling repository is present.
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const hours = M.ark.profileQrlClaimMarginHours(M.params, DAY / TESTNET.day, HOODI_FINALITY_SECONDS / 3600, RELAYER_INTERVAL_SECONDS / 3600);
    assert.ok(Math.abs(hours * 3600 - margin) < 1e-6, `model ${hours * 3600} s against ${margin} s`);
  });

  test('a multiplication around a duration keeps its precedence', () => {
    const { text } = rewriteSource('uint256 w = uint256(p.fxWindowDays) * 1 days;', TESTNET);
    assert.equal(text, 'uint256 w = uint256(p.fxWindowDays) * (1 * 600);');
  });

  test('comments and strings keep the durations the specification states', () => {
    const input = '// twenty-one days: 21 days\n/* 30 days */ string s = "7 days"; uint64 x = 7 days;';
    const { text } = rewriteSource(input, TESTNET);
    assert.equal(text, '// twenty-one days: 21 days\n/* 30 days */ string s = "7 days"; uint64 x = (7 * 600);');
  });

  test('a unit the profile cannot scale stops the build', () => {
    for (const unit of ['seconds', 'minutes', 'weeks', 'years']) {
      assert.throws(() => rewriteSource(`uint64 x = 3 ${unit};`, TESTNET), ProfileError);
    }
  });

  test('the spec profile rewrites nothing', () => {
    const text = src(...SOURCES.epoch);
    const r = rewriteSource(text, profile('spec'));
    assert.equal(r.text, text);
    assert.equal(r.rewrites.length, 0);
  });

  test("the escrow's release delay still exceeds the unbonding at the testnet epoch", () => {
    // RELEASE_EPOCH_DELAY is counted in epochs, so it scales with the epoch and
    // is not rewritten: (delay - 1) epochs is the least wait it enforces.
    const escrow = src('ecdsa-stakings', 'shared', 'contracts', 'ArkStakeEscrow.sol');
    const delay = Number(/RELEASE_EPOCH_DELAY = (\d+);/.exec(escrow)[1]);
    const clock = clockFor(TESTNET.day);
    assert.ok(BigInt(delay - 1) * clock.EPOCH_LENGTH >= clock.UNBONDING_PERIOD);
  });

  test('the relayer clock at the testnet day agrees with the rewritten contracts', () => {
    const clock = clockFor(TESTNET.day);
    assert.equal(clock.EPOCH_LENGTH, 4200n);
    assert.equal(clock.EPOCH_LENGTH, scaled(TESTNET, EPOCH_LENGTH));
    assert.equal(clockFor().EPOCH_LENGTH, EPOCH_LENGTH);
  });

  test('the rapid profile is the same rule at a minute to the day', () => {
    // For the private enclave only: an epoch must be longer than the chain's
    // finality lag, and seven minutes is not on a public chain (§4.3).
    const rapid = profile('rapid');
    const at = (key, name) => constantSeconds(rewriteSource(src(...SOURCES[key]), rapid).text, name);
    assert.equal(at('epoch', 'EPOCH_LENGTH'), 420);
    assert.equal(at('epoch', 'UNBONDING_PERIOD'), 1260);
    assert.equal(at('epoch', 'QRL_CLAIM_MARGIN'), 120);
    assert.equal(at('epoch', 'DISPUTE_CYCLE_APPEAL'), 1200);
    assert.equal(clockFor(rapid.day).EPOCH_LENGTH, 420n);
    // Every profile keeps the relation that the escrow's four-epoch delay
    // serves the unbonding, because both are the same factor apart.
    const escrow = src('ecdsa-stakings', 'shared', 'contracts', 'ArkStakeEscrow.sol');
    const delay = Number(/RELEASE_EPOCH_DELAY = (\d+);/.exec(escrow)[1]);
    assert.ok(BigInt(delay - 1) * clockFor(rapid.day).EPOCH_LENGTH >= clockFor(rapid.day).UNBONDING_PERIOD);
  });

  test('a time-compressed manifest is refused on a mainnet chain id', () => {
    const m = JSON.parse(src('ecdsa-stakings', 'ethereum', 'chain.json'));
    assert.throws(() => manifest.validate({ ...m, profile: 'testnet' }), /mainnet/);
    assert.throws(() => manifest.validate({ ...m, profile: 'rapid' }), /mainnet/);
    assert.throws(() => manifest.validate({ ...m, profile: 'fast' }), /profile/);
    assert.doesNotThrow(() => manifest.validate({ ...m, chainId: 560048, profile: 'testnet' }));
  });
});
