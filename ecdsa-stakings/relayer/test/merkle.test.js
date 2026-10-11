/**
 * The tree builder. Every test here defends the property that makes a
 * crash-restart safe: a root is a function of the set of leaves and nothing else.
 *
 * Agreement with the real on-chain verifier is a separate test and lives in
 * test/ArkStakeRelayMerkle.test.js, because it needs compiled artifacts. This
 * file must not be taken as evidence for that agreement.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const { buildTree, proofFor, verify, rootOf, pairHash } = require('../lib/merkle');

const leaves = (n) => [...Array(n)].map((_, i) => keccak256(toUtf8Bytes(`leaf-${i}`)));

describe('the epoch Merkle tree', () => {
  test('a root does not depend on the order the leaves arrived in', () => {
    // The whole reason leaves are sorted. A relayer that dies mid-epoch rescans
    // logs in a different order; a root that moved with that order would
    // contradict one already sealed, and an attester cannot unseal.
    const ls = leaves(7);
    const forwards = rootOf(ls);
    const backwards = rootOf([...ls].reverse());
    const shuffled = rootOf([ls[3], ls[0], ls[6], ls[1], ls[5], ls[2], ls[4]]);
    assert.equal(forwards, backwards);
    assert.equal(forwards, shuffled);
  });

  test('a one-leaf tree is its own root and proves with an empty proof', () => {
    // ArkStakeRegistry._consumeProof calls attestation.verify(epoch, leaf, []),
    // and OpenZeppelin reads an empty proof as leaf == root.
    const [only] = leaves(1);
    const tree = buildTree([only]);
    assert.equal(tree.root, only);
    assert.deepEqual(proofFor(tree, only), []);
    assert.ok(verify([], tree.root, only));
  });

  test('every leaf in a tree proves against its root', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 9, 16, 17]) {
      const ls = leaves(n);
      const tree = buildTree(ls);
      for (const leaf of ls) {
        assert.ok(verify(proofFor(tree, leaf), tree.root, leaf), `n=${n} leaf ${leaf}`);
      }
    }
  });

  test('a leaf outside the tree does not prove against its root', () => {
    const tree = buildTree(leaves(5));
    const outsider = keccak256(toUtf8Bytes('leaf-outside'));
    assert.ok(!verify([], tree.root, outsider));
    assert.throws(() => proofFor(tree, outsider), /leaf not in tree/);
  });

  test('a proof from one tree does not prove a leaf in another', () => {
    const a = buildTree(leaves(5));
    const b = buildTree(leaves(6));
    const leaf = a.leaves[2];
    assert.ok(!verify(proofFor(a, leaf), b.root, leaf));
  });

  test('an empty epoch is not sealed at all, rather than sealed as zero', () => {
    // A zero root reads as "no root for this epoch" to the verifier, so sealing
    // one poisons the epoch permanently with a commitment proving nothing.
    assert.throws(() => buildTree([]), /no leaves/);
  });

  test('a duplicate leaf is refused at build time, not at submission', () => {
    // Two identical stakeLeafKeys mean two deposits produced one stakeAssetId,
    // which depositNonce exists to prevent. The second recordAnchor would die on
    // AnchorExists and one depositor would be silently unanchored.
    const [a, b] = leaves(2);
    assert.throws(() => buildTree([a, b, a]), /duplicate leaf/);
  });

  test('something that is not a 32-byte hash is not a leaf', () => {
    assert.throws(() => buildTree(['0xabcd']), /not a 32-byte hex leaf/);
    assert.throws(() => buildTree([null]), /not a 32-byte hex leaf/);
  });

  test('pair hashing is sorted, so sibling order does not change a node', () => {
    const [a, b] = leaves(2);
    assert.equal(pairHash(a, b), pairHash(b, a));
  });

  test('leaves are not double-hashed, so the one-leaf root is the leaf itself', () => {
    // OpenZeppelin 4.9 does not double-hash. The registry's MockAttestation
    // verifies with that library, so a builder that double-hashed here would
    // produce roots nothing on chain accepts.
    const [only] = leaves(1);
    assert.equal(rootOf([only]), only);
  });
});
