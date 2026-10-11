/**
 * The one-time signer, checked against itself.
 *
 * Agreement with the deployed verifier — that a signature made here admits a
 * root on chain, byte for byte — is in ecdsa-stakings/shared/test, because it
 * needs compiled artifacts. What is checked here is what the verifier cannot
 * check for us: that the signer derives what it says it derives, refuses to
 * sign twice with one key, and that a signature does not transfer to another
 * message, leaf or path.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, AbiCoder, hexlify } = require('ethers');

const wots = require('../lib/wots');

const SEED = keccak256(toUtf8Bytes('relayer-test-seed'));
const M1 = keccak256(toUtf8Bytes('message one'));
const M2 = keccak256(toUtf8Bytes('message two'));

// Height 3 for everything but the one test that is about height.
const signer = new wots.WotsSigner(SEED, 3);

describe('the one-time signer', () => {
  test('the seed is the whole authority: each secret is keccak256(abi.encode(seed, leaf, chain))', () => {
    const coder = AbiCoder.defaultAbiCoder();
    for (const [leaf, chain] of [[0, 0], [5, 66], [7, 13]]) {
      assert.equal(
        hexlify(signer.secret(leaf, chain)),
        keccak256(coder.encode(['bytes32', 'uint32', 'uint8'], [SEED, leaf, chain])),
      );
    }
  });

  test('the checksum digits are the sum of what the message digits leave, most significant first', () => {
    assert.deepEqual(wots.digits('0x' + '00'.repeat(32)).slice(64), [3, 12, 0]); // 960 = 0x3c0
    assert.deepEqual(wots.digits('0x' + 'ff'.repeat(32)).slice(64), [0, 0, 0]);
    const d = wots.digits('0x' + 'a5'.repeat(32));
    assert.equal(d[0], 0xa);
    assert.equal(d[1], 0x5);
  });

  test('a signature verifies against the committed root at its own leaf', () => {
    const sig = signer.sign(M1, 2);
    assert.equal(sig.length, wots.LEN);
    assert.ok(wots.verify(M1, sig, 2, signer.authPath(2), signer.root));
    assert.equal(wots.publicKeyFromSignature(M1, sig, 2), signer.publicKey(2));
  });

  test('a signature does not verify for another message', () => {
    const sig = signer._signUnchecked(M1, 3);
    assert.ok(!wots.verify(M2, sig, 3, signer.authPath(3), signer.root));
  });

  test('a signature does not verify at another leaf or along another path', () => {
    const sig = signer._signUnchecked(M1, 4);
    assert.ok(!wots.verify(M1, sig, 5, signer.authPath(5), signer.root));
    assert.ok(!wots.verify(M1, sig, 4, signer.authPath(5), signer.root));
  });

  test('changing one element of a signature breaks it', () => {
    const sig = [...signer._signUnchecked(M1, 6)];
    const d = wots.digits(M1);
    sig[64] = wots.chainStep(sig[64], 6, 64, d[64]);
    assert.ok(!wots.verify(M1, sig, 6, signer.authPath(6), signer.root));
  });

  test('a leaf that has signed one message refuses to sign another', () => {
    // Two WOTS signatures under one key are a forgery kit.
    const s = new wots.WotsSigner(SEED, 3);
    s.sign(M1, 0);
    assert.throws(() => s.sign(M2, 0), { name: 'LeafReused' });
    assert.deepEqual(s.sign(M1, 0), s.sign(M1, 0), 'a retry of the same message is the same signature');
  });

  test('a leaf outside the tree is refused rather than wrapped', () => {
    assert.throws(() => signer.sign(M1, 8), { name: 'BadLeaf' });
    assert.throws(() => signer.authPath(-1), { name: 'BadLeaf' });
    assert.throws(() => new wots.WotsSigner(SEED, 0), { name: 'BadTreeHeight' });
    assert.throws(() => new wots.WotsSigner(SEED, 21), { name: 'BadTreeHeight' });
  });

  test('a different seed commits a different root', () => {
    const other = new wots.WotsSigner(keccak256(toUtf8Bytes('other')), 3);
    assert.notEqual(other.root, signer.root);
  });

  test('a tree of height ten is built once and every path reaches its root', () => {
    // 1,024 one-time keys, the height the lib must stay usable at.
    const big = new wots.WotsSigner(SEED, 10);
    const root = big.root;
    for (const leaf of [0, 511, 1023]) {
      assert.equal(big.authPath(leaf).length, 10);
      assert.equal(wots.rootFromPath(big.publicKey(leaf), leaf, big.authPath(leaf)), root);
    }
    const sig = big.sign(M1, 777);
    assert.ok(wots.verify(M1, sig, 777, big.authPath(777), root));
  });
});
