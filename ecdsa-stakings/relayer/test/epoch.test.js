/**
 * The shared clock. The rule under test throughout: both chains number the same
 * second into the same epoch with nothing configured.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  EPOCH_LENGTH,
  COUPON_CLIFF,
  epochOf,
  startOf,
  endOf,
  isClosed,
  secondsLeftIn,
  withinDeliveryWindow,
} = require('../lib/epoch');

describe('the shared epoch clock', () => {
  test('the constants are the ones ArkEpoch.hyp declares', () => {
    assert.equal(EPOCH_LENGTH, 604800n);
    assert.equal(COUPON_CLIFF, 2592000n);
  });

  test('an epoch is at most as long as the coupon cliff', () => {
    // ArkEpoch keeps EPOCH_LENGTH a constant, but whitepaper §6.3 makes it
    // governable with exactly this bound. Asserting it here means a future
    // change to either number is caught on both sides of the relay.
    assert.ok(EPOCH_LENGTH <= COUPON_CLIFF);
  });

  test('epochs are numbered from the Unix epoch, not from any genesis', () => {
    assert.equal(epochOf(0n), 0n);
    assert.equal(epochOf(EPOCH_LENGTH - 1n), 0n);
    assert.equal(epochOf(EPOCH_LENGTH), 1n);
  });

  test('the boundary belongs to the epoch it opens', () => {
    const e = 2810n;
    assert.equal(epochOf(startOf(e)), e);
    assert.equal(epochOf(endOf(e) - 1n), e);
    assert.equal(epochOf(endOf(e)), e + 1n);
  });

  test('a closed epoch reports no time left rather than a negative one', () => {
    const e = 2810n;
    assert.ok(!isClosed(e, endOf(e) - 1n));
    assert.ok(isClosed(e, endOf(e)));
    assert.equal(secondsLeftIn(e, endOf(e) + 10_000n), 0n);
  });

  test('a delivery inside the closing margin is refused before it is sent', () => {
    // ProceedsLedger.deliver compares the epoch against the clock at inclusion,
    // so a delivery sent near the boundary reverts NotCurrentEpoch after paying
    // gas. The margin turns that into a decision taken before sending.
    const e = 2810n;
    assert.ok(withinDeliveryWindow(e, startOf(e) + 1000n, 900n));
    assert.ok(!withinDeliveryWindow(e, endOf(e) - 900n, 900n));
    assert.ok(!withinDeliveryWindow(e, endOf(e) - 1n, 900n));
  });

  test('a delivery for an epoch that is not the current one is refused', () => {
    const e = 2810n;
    assert.ok(!withinDeliveryWindow(e, startOf(e) - 1n, 900n));
    assert.ok(!withinDeliveryWindow(e, endOf(e) + 1n, 900n));
  });

  test('a Number timestamp and a BigInt timestamp give the same epoch', () => {
    assert.equal(epochOf(1_700_000_000), epochOf(1_700_000_000n));
  });
});
