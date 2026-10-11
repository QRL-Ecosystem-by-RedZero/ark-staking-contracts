/**
 * The one-time signer that admits epoch roots on the origin chain.
 * whitepaper §3.6, yellow paper §2.2.
 *
 * The one rule this module exists to enforce: **a signature made here verifies
 * under ecdsa-stakings/shared/contracts/WotsVerifier.sol byte for byte, and a
 * one-time key is never asked to sign twice.**
 *
 * THE SEED IS THE WHOLE AUTHORITY
 * -------------------------------
 * Every one-time secret is derived from one 32-byte seed:
 *
 *     sk[leaf][chain] = keccak256(abi.encode(seed, uint32 leaf, uint8 chain))
 *
 * so whoever holds the seed can sign a root for every unused leaf of every
 * relay committed to its tree, and nothing on the origin chain can revoke it —
 * rotating the authority is a new relay and a re-anchoring. On QRL the seed is
 * held under the attester quorum's threshold arrangement (whitepaper §3.6);
 * this module is the arithmetic, not the custody, and a test fixture that
 * hard-codes a seed is exactly as powerful as the quorum it stands in for.
 *
 * A second signature from one leaf is a forgery kit: two WOTS signatures under
 * one key reveal chain elements at two positions per chain, from which a third
 * message's signature can often be assembled. The relay refuses any index but
 * the next, so reuse needs a leaf the relay has not consumed — which is what
 * `sign` refuses locally, by remembering what it has signed.
 *
 * THE CONSTRUCTION
 * ----------------
 * Stated once, in the verifier's header. n = 32, keccak256, w = 16, 64 message
 * digits most significant nibble first, a three-digit checksum of
 * sum(15 - d_i), 67 chains, F(x, leaf, chain, step) over the packed 38 bytes,
 * pk = keccak256 of the 67 chain ends, leaf node 0x00 || pk, interior node
 * 0x01 || left || right, positional path.
 */
const { keccak256: ethersKeccak, getBytes, hexlify } = require('ethers');

/**
 * keccak256 over raw bytes, returning raw bytes.
 *
 * `@noble/hashes` is the implementation ethers itself wraps; called directly
 * it skips the hex round trip and is about twice as fast, which matters when a
 * height-10 tree is 1.1 million hashes. It is not a declared dependency of this
 * package, so when it does not resolve the ethers path is used. Both are the
 * same function; the choice affects time and nothing else.
 */
let keccakBytes;
try {
  // eslint-disable-next-line global-require
  const { keccak_256: k } = require('@noble/hashes/sha3.js');
  keccakBytes = (bytes) => k(bytes);
} catch {
  keccakBytes = (bytes) => getBytes(ethersKeccak(bytes));
}

const W = 16;
const MSG_DIGITS = 64;
const LEN = 67;
const MAX_TREE_HEIGHT = 20;

class WotsError extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
}

const toBytes32 = (hex, what) => {
  const b = getBytes(hex);
  if (b.length !== 32) throw new WotsError(`${what} must be 32 bytes`, 'BadLength');
  return b;
};

/** The 67 base-16 digits of a 32-byte message, as WotsVerifier.digits. */
function digits(message) {
  const m = toBytes32(message, 'message');
  const d = new Array(LEN);
  let checksum = 0;
  for (let j = 0; j < 32; j += 1) {
    d[2 * j] = m[j] >> 4;
    d[2 * j + 1] = m[j] & 0x0f;
    checksum += W - 1 - d[2 * j] + (W - 1 - d[2 * j + 1]);
  }
  d[MSG_DIGITS] = (checksum >> 8) & 0x0f;
  d[MSG_DIGITS + 1] = (checksum >> 4) & 0x0f;
  d[MSG_DIGITS + 2] = checksum & 0x0f;
  return d;
}

/** F(x, leaf, chain, step), as WotsVerifier.chainStep. Bytes in, bytes out. */
const stepBuf = new Uint8Array(38);
function chainStep(x, leaf, chain, step) {
  stepBuf.set(x, 0);
  stepBuf[32] = (leaf >>> 24) & 0xff;
  stepBuf[33] = (leaf >>> 16) & 0xff;
  stepBuf[34] = (leaf >>> 8) & 0xff;
  stepBuf[35] = leaf & 0xff;
  stepBuf[36] = chain;
  stepBuf[37] = step;
  return keccakBytes(stepBuf);
}

/** F applied from step `from` up to (not including) step `to`. */
function advance(x, leaf, chain, from, to) {
  let v = x;
  for (let s = from; s < to; s += 1) v = chainStep(v, leaf, chain, s);
  return v;
}

const leafNode = (pk) => {
  const b = new Uint8Array(33);
  b[0] = 0x00;
  b.set(pk, 1);
  return keccakBytes(b);
};

const interiorNode = (left, right) => {
  const b = new Uint8Array(65);
  b[0] = 0x01;
  b.set(left, 1);
  b.set(right, 33);
  return keccakBytes(b);
};

function pkFromEnds(ends) {
  const b = new Uint8Array(32 * LEN);
  ends.forEach((e, i) => b.set(e, 32 * i));
  return keccakBytes(b);
}

/**
 * A signer over one seed and one tree.
 *
 * The tree is built on first use and cached: the root and every
 * authentication path need every public key, and a public key is 1,072 hashes,
 * so a height-10 tree is a few seconds once and free afterwards.
 */
class WotsSigner {
  constructor(seed, treeHeight) {
    this.seed = toBytes32(seed, 'seed');
    if (!Number.isInteger(treeHeight) || treeHeight < 1 || treeHeight > MAX_TREE_HEIGHT) {
      throw new WotsError(`tree height must be 1..${MAX_TREE_HEIGHT}`, 'BadTreeHeight');
    }
    this.treeHeight = treeHeight;
    this.leafCount = 2 ** treeHeight;
    this._layers = null;
    this._signed = new Map();
  }

  _checkLeaf(leaf) {
    if (!Number.isInteger(leaf) || leaf < 0 || leaf >= this.leafCount) {
      throw new WotsError(`leaf ${leaf} outside 0..${this.leafCount - 1}`, 'BadLeaf');
    }
  }

  /**
   * sk[leaf][chain] = keccak256(abi.encode(seed, uint32 leaf, uint8 chain)).
   *
   * Laid out by hand — three 32-byte words, the two integers right-aligned —
   * because the ABI coder costs more than the hash at this volume. The test
   * suite checks the layout against `AbiCoder` so the shortcut cannot drift.
   */
  secret(leaf, chain) {
    const b = new Uint8Array(96);
    b.set(this.seed, 0);
    b[60] = (leaf >>> 24) & 0xff;
    b[61] = (leaf >>> 16) & 0xff;
    b[62] = (leaf >>> 8) & 0xff;
    b[63] = leaf & 0xff;
    b[95] = chain;
    return keccakBytes(b);
  }

  /** The one-time public key at `leaf`, as a hex string. */
  publicKey(leaf) {
    this._checkLeaf(leaf);
    return hexlify(this._publicKeyBytes(leaf));
  }

  _publicKeyBytes(leaf) {
    const ends = [];
    for (let i = 0; i < LEN; i += 1) ends.push(advance(this.secret(leaf, i), leaf, i, 0, W - 1));
    return pkFromEnds(ends);
  }

  _tree() {
    if (this._layers) return this._layers;
    let layer = [];
    for (let leaf = 0; leaf < this.leafCount; leaf += 1) {
      layer.push(leafNode(this._publicKeyBytes(leaf)));
    }
    const layers = [layer];
    while (layer.length > 1) {
      const up = [];
      for (let i = 0; i < layer.length; i += 2) up.push(interiorNode(layer[i], layer[i + 1]));
      layers.push(up);
      layer = up;
    }
    this._layers = layers;
    return layers;
  }

  /** The commitment the relay is constructed with: `rootAuthority`. */
  get root() {
    const layers = this._tree();
    return hexlify(layers[layers.length - 1][0]);
  }

  /** The positional authentication path for `leaf`, bottom level first. */
  authPath(leaf) {
    this._checkLeaf(leaf);
    const layers = this._tree();
    const path = [];
    let i = leaf;
    for (let k = 0; k < this.treeHeight; k += 1) {
      path.push(hexlify(layers[k][i ^ 1]));
      i >>= 1;
    }
    return path;
  }

  /**
   * Sign a 32-byte message with the one-time key at `leaf`: 67 bytes32.
   *
   * Refuses a second, different message at the same leaf. Re-signing the same
   * message returns the same signature and reveals nothing new, so it is
   * allowed: a carrier retrying a submission needs it.
   */
  sign(message, leaf) {
    this._checkLeaf(leaf);
    const msg = hexlify(toBytes32(message, 'message')).toLowerCase();
    const prior = this._signed.get(leaf);
    if (prior !== undefined && prior !== msg) {
      throw new WotsError(`leaf ${leaf} has already signed another message`, 'LeafReused');
    }
    this._signed.set(leaf, msg);
    return this._signUnchecked(msg, leaf);
  }

  /**
   * Sign without the reuse guard. For tests that must show the relay refusing
   * a reused leaf; a relayer never calls this.
   */
  _signUnchecked(message, leaf) {
    const d = digits(message);
    const sig = [];
    for (let i = 0; i < LEN; i += 1) sig.push(hexlify(advance(this.secret(leaf, i), leaf, i, 0, d[i])));
    return sig;
  }
}

/**
 * The public key a signature continues to, as WotsVerifier.publicKey. For
 * checking a signature off chain before paying to submit it.
 */
function publicKeyFromSignature(message, sig, leaf) {
  if (!Array.isArray(sig) || sig.length !== LEN) {
    throw new WotsError(`a signature is ${LEN} bytes32`, 'BadSignature');
  }
  const d = digits(message);
  const ends = sig.map((s, i) => advance(toBytes32(s, 'signature element'), leaf, i, d[i], W - 1));
  return hexlify(pkFromEnds(ends));
}

/** The root a public key reaches by a positional path, as WotsVerifier.merkleRoot. */
function rootFromPath(pk, leaf, authPath) {
  let node = leafNode(toBytes32(pk, 'public key'));
  let i = leaf;
  for (const sibling of authPath) {
    const s = toBytes32(sibling, 'path element');
    node = (i & 1) === 0 ? interiorNode(node, s) : interiorNode(s, node);
    i >>= 1;
  }
  return hexlify(node);
}

/** Whether a signature over `message` at `leaf` reaches `root`. */
function verify(message, sig, leaf, authPath, root) {
  return rootFromPath(publicKeyFromSignature(message, sig, leaf), leaf, authPath).toLowerCase()
    === root.toLowerCase();
}

module.exports = {
  W,
  LEN,
  MAX_TREE_HEIGHT,
  WotsSigner,
  WotsError,
  digits,
  chainStep: (x, leaf, chain, step) =>
    hexlify(chainStep(toBytes32(x, 'x'), leaf, chain, step)),
  publicKeyFromSignature,
  rootFromPath,
  verify,
};
