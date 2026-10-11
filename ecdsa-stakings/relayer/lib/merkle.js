/**
 * The Merkle tree the two chains agree about.
 *
 * The one rule this module exists to enforce: **a root is a function of the set
 * of leaves and of nothing else — not of the order they arrived in, not of the
 * order they were read back in.**
 *
 * That is what makes a crash-restart safe. A relayer that dies mid-epoch and
 * rescans logs will see the same leaves in a different order; if the root
 * depended on that order it would seal a root contradicting the one already on
 * chain, and an attester cannot unseal. So leaves are sorted before building.
 *
 * The verifier on the other side is OpenZeppelin 4.9's `MerkleProof`, vendored
 * to Hyperion for the registry and imported as Solidity for the escrow — the
 * same source both times. It hashes pairs sorted, does not double-hash leaves,
 * and treats an empty proof as `leaf == root`. Every one of those is load
 * bearing here and each is pinned by a test that runs the real verifier rather
 * than a second copy of this file's arithmetic.
 */
const { keccak256, concat } = require('ethers');

class MerkleError extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function requireLeaf(leaf) {
  if (typeof leaf !== 'string' || !HEX32.test(leaf)) {
    throw new MerkleError(`not a 32-byte hex leaf: ${JSON.stringify(leaf)}`, 'BadLeaf');
  }
  return leaf.toLowerCase();
}

/**
 * OpenZeppelin's `_hashPair`. Compared as unsigned big-endian integers, which is
 * what Solidity's `bytes32 a < b` does — a byte-string comparison happens to
 * agree, but the BigInt form is the one under test.
 */
const pairHash = (a, b) =>
  BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));

/**
 * Build a tree over a set of leaves.
 *
 * Refusals, each of which is a bug upstream rather than a case to handle:
 *
 * - **No leaves.** An empty epoch is not sealed at all. Sealing `bytes32(0)`
 *   would be worse than doing nothing: the verifier reads a zero root as "no
 *   root for this epoch", so a zero seal permanently poisons an epoch with a
 *   commitment that proves nothing and cannot be replaced.
 * - **A duplicate leaf.** `proofFor` would be ambiguous, and the cause is
 *   upstream: two identical `stakeLeafKey`s mean two deposits produced the same
 *   `stakeAssetId`, which `depositNonce` exists to prevent. The second
 *   `recordAnchor` would die on `AnchorExists` and one depositor would be
 *   silently unanchored, so this fails at build time instead.
 *
 * An odd node at a layer is promoted unchanged. The verifier is agnostic to how
 * a tree was built, so that convention is pinned by the on-chain agreement test
 * at three and five leaves rather than assumed here.
 */
function buildTree(leaves) {
  const normalised = leaves.map(requireLeaf);
  if (normalised.length === 0) throw new MerkleError('cannot build a tree over no leaves', 'EmptyTree');

  const seen = new Set();
  for (const leaf of normalised) {
    if (seen.has(leaf)) throw new MerkleError(`duplicate leaf ${leaf}`, 'DuplicateLeaf');
    seen.add(leaf);
  }

  const sorted = [...normalised].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

  const layers = [sorted];
  while (layers[layers.length - 1].length > 1) {
    const below = layers[layers.length - 1];
    const above = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(i + 1 < below.length ? pairHash(below[i], below[i + 1]) : below[i]);
    }
    layers.push(above);
  }

  const index = new Map(sorted.map((leaf, i) => [leaf, i]));
  return { root: layers[layers.length - 1][0], layers, leaves: sorted, index };
}

/** The sibling path. Empty for a one-leaf tree, where the root is the leaf. */
function proofFor(tree, leaf) {
  const target = requireLeaf(leaf);
  let i = tree.index.get(target);
  if (i === undefined) throw new MerkleError(`leaf not in tree: ${target}`, 'UnknownLeaf');

  const proof = [];
  for (let depth = 0; depth < tree.layers.length - 1; depth += 1) {
    const layer = tree.layers[depth];
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < layer.length) proof.push(layer[sibling]);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Mirrors `MerkleProof.verifyCalldata`, for tests that must not call the tree. */
function verify(proof, root, leaf) {
  let computed = requireLeaf(leaf);
  for (const node of proof) computed = pairHash(computed, requireLeaf(node));
  return computed.toLowerCase() === root.toLowerCase();
}

const rootOf = (leaves) => buildTree(leaves).root;

module.exports = { pairHash, buildTree, proofFor, verify, rootOf, MerkleError };
