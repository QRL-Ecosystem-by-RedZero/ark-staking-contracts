/**
 * Address rendering. Every test here defends the same property from a different
 * side: the twenty bytes that reach a preimage do not depend on which chain
 * wrote them down.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toHex, toQ, toChecksum, sameAddress } = require('../lib/addresses');

const BYTES = 'ab'.repeat(20);

describe('address rendering across the two chains', () => {
  test('the Q form and the 0x form are the same twenty bytes', () => {
    assert.equal(toHex(`Q${BYTES}`), toHex(`0x${BYTES}`));
    assert.ok(sameAddress(`Q${BYTES}`, `0x${BYTES}`));
  });

  test("QRL's own casing is normalised rather than rejected", () => {
    // ethers throws a checksum error on this, because QRL's casing is not
    // EIP-55. Rejecting it would push the workaround out to every caller.
    assert.equal(toHex(`Q${BYTES.toUpperCase()}`), `0x${BYTES}`);
    assert.equal(toHex(`0x${BYTES.toUpperCase()}`), `0x${BYTES}`);
  });

  test('a normalised address is lowercase, so a preimage cannot depend on casing', () => {
    assert.equal(toHex(`0xAbAbAB${BYTES.slice(6)}`), `0x${BYTES}`);
  });

  test('the round trip through the Q form loses nothing', () => {
    assert.equal(toHex(toQ(`0x${BYTES}`)), `0x${BYTES}`);
    assert.equal(toQ(toHex(`Q${BYTES}`)), `Q${BYTES}`);
  });

  test('a Z-prefixed address is refused as the stale build it signals', () => {
    // The private Kurtosis network is Q throughout. A Z address means a component
    // is the 2025-08 qrysm build, whose rendering is mutually exclusive with the
    // generator and execution client this project pins — CLAUDE.md §4.2. Accepting
    // the bytes would hide that until the chain sat at block 0 for reasons that
    // look unrelated.
    assert.throws(() => toHex('Z' + BYTES), /Z prefix/);
    assert.throws(() => toHex('z' + BYTES), /Z prefix/);
  });

  test('an address of the wrong length is refused, not padded', () => {
    assert.throws(() => toHex('0xabab'), /bad address/);
    assert.throws(() => toHex(`0x${BYTES}ab`), /bad address/);
    assert.throws(() => toHex(''), /bad address/);
  });

  test('a non-string is refused rather than coerced', () => {
    assert.throws(() => toHex(null), /bad address/);
    assert.throws(() => toHex(0x1234), /bad address/);
  });

  test('an origin-chain address is checksummed, so a manifest typo is caught', () => {
    const checksummed = toChecksum(`0x${BYTES}`);
    assert.notEqual(checksummed, `0x${BYTES}`); // it has mixed case
    assert.equal(toHex(checksummed), `0x${BYTES}`);
  });
});
