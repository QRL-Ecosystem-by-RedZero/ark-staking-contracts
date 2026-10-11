/**
 * The signer set of root admission, and the authority chain it belongs to.
 * whitepaper §3.6 and §3.7, yellow paper §2.2, I16, I17, I35.
 *
 * The one rule this module exists to enforce: **a root is signed by k distinct
 * signers of the active generation, each from its own tree, at the one leaf
 * index the set shares — and the generations after it are the ones fixed at
 * construction, derived here, never chosen later.**
 *
 * Each signer holds one seed. Its tree of generation 1 grows from that seed;
 * its tree of generation g > 1 from `keccak256(abi.encode(GENERATION_TAG, seed,
 * uint8 g))`, so the four generations the relay's constructor commits to are
 * generated together, as whitepaper §3.6 has them, and a signer carries one
 * secret for all of them. A seed of the single-signer relays deployed before
 * the threshold (`<CHAIN>_OTS_SEED`) is signer 0's seed, and its generation 1
 * is the tree it always was.
 *
 * Pure: no I/O, no chain. The seeds come from the environment by the caller
 * (`seedsFromEnv`), and the one-time rule — a leaf signs one message — is
 * `WotsSigner`'s and the relayer state's.
 */
const { keccak256, AbiCoder, toUtf8Bytes } = require('ethers');
const { WotsSigner } = require('./wots');
const ids = require('./identifiers');

const coder = AbiCoder.defaultAbiCoder();

/** keccak256("ARK_OTS_GENERATION_V1"): the tag a later generation's seed is derived under. */
const GENERATION_TAG = keccak256(toUtf8Bytes('ARK_OTS_GENERATION_V1'));

/** T of yellow paper §2.2: four generations, the first included, as `ArkEpochRootRelay.MAX_GENERATIONS`. */
const MAX_GENERATIONS = 4;

/** As the relay's `MAX_SIGNERS`. */
const MAX_SIGNERS = 16;

/** The reference set of whitepaper §3.6, `ROOT_SIGNER_SET_REFERENCE` of the model. */
const REFERENCE = { threshold: 2, signers: 3 };

/** `n / 2 < k <= n`, the model's `signerThresholdAdmissible`, with the relay's bound on n. */
function thresholdAdmissible(k, n) {
  return Number.isInteger(k) && Number.isInteger(n) && n >= 1 && n <= MAX_SIGNERS && k <= n && 2 * k > n;
}

/** The seed signer `seed` grows its tree of `generation` from. */
function generationSeed(seed, generation) {
  if (!Number.isInteger(generation) || generation < 1 || generation > MAX_GENERATIONS) {
    throw new Error(`generation must be 1..${MAX_GENERATIONS}`);
  }
  if (generation === 1) return seed;
  return keccak256(coder.encode(['bytes32', 'bytes32', 'uint8'], [GENERATION_TAG, seed, generation]));
}

const envKey = (chain) => chain.toUpperCase().replace(/-/g, '_');

/**
 * The seeds of `n` signers from the environment: `<CHAIN>_OTS_SEED_<i>`, and
 * the single-signer `<CHAIN>_OTS_SEED` standing for signer 0 where that is
 * absent. A missing seed is `null`: a host may hold only some of the set, and
 * signs where it holds k.
 */
function seedsFromEnv(env, chain, n) {
  const up = envKey(chain);
  const seeds = [];
  for (let i = 0; i < n; i += 1) seeds.push(env[`${up}_OTS_SEED_${i}`] || (i === 0 ? env[`${up}_OTS_SEED`] : null) || null);
  return seeds;
}

/**
 * One generation of the set, as this host holds it: a tree per seed it has,
 * `null` for a signer whose seed it does not.
 */
class SignerSet {
  constructor({ seeds, threshold, treeHeight, generation = 1 }) {
    if (!thresholdAdmissible(threshold, seeds.length)) {
      throw new Error(`a threshold of ${threshold} over ${seeds.length} signers is not admissible (n / 2 < k <= n, n <= ${MAX_SIGNERS})`);
    }
    this.threshold = threshold;
    this.treeHeight = treeHeight;
    this.generation = generation;
    this.signers = seeds.map((s) => (s ? new WotsSigner(generationSeed(s, generation), treeHeight) : null));
  }

  get size() {
    return this.signers.length;
  }

  /** The indices this host can sign for. */
  held() {
    return this.signers.flatMap((s, i) => (s ? [i] : []));
  }

  /** Whether this host holds k of the set. */
  canSign() {
    return this.held().length >= this.threshold;
  }

  /** The tree roots of the signers held, by index; `null` where the seed is not held. */
  roots() {
    return this.signers.map((s) => (s ? s.root : null));
  }

  /**
   * k signatures over `message` at `leaf`, as `admitEpochRoot` takes them:
   * `[{ signer, ots, authPath }]`. Each signer's own reuse guard refuses a
   * second message at a leaf it has signed; the relayer's state is what
   * carries that across restarts (`prime`).
   */
  sign(message, leaf) {
    const held = this.held();
    if (held.length < this.threshold) {
      throw new Error(`this host holds ${held.length} of the ${this.size} signers; ${this.threshold} must sign`);
    }
    return held.slice(0, this.threshold).map((i) => ({
      signer: i,
      ots: this.signers[i].sign(message, leaf),
      authPath: this.signers[i].authPath(leaf),
    }));
  }

  /** As `sign`, without the reuse guard and over the named signers. Test fixtures only. */
  _signUnchecked(message, leaf, which = null) {
    const idx = which || this.held().slice(0, this.threshold);
    return idx.map((i) => ({
      signer: i,
      ots: this.signers[i]._signUnchecked(message, leaf),
      authPath: this.signers[i].authPath(leaf),
    }));
  }

  /** Record, in every held signer's guard, a message a leaf signed before this process. */
  prime(leaf, message) {
    for (const s of this.signers) if (s) s._signed.set(leaf, String(message).toLowerCase());
  }
}

/**
 * The whole chain from every signer's seed: `generations[g]` the roots of
 * generation g + 1 in signer order, `commits[g]` the commitment that
 * generation holds while active. The relay is constructed with
 * `generations[0]`, the threshold, the height and `commits[0]`. Every seed
 * must be present: a chain is committed by whoever generated all of it.
 */
function authorityChain(seeds, treeHeight, generations = MAX_GENERATIONS) {
  if (seeds.some((s) => !s)) throw new Error('an authority chain is generated from every signer seed');
  const gens = [];
  for (let g = 1; g <= generations; g += 1) {
    gens.push(seeds.map((s) => new WotsSigner(generationSeed(s, g), treeHeight).root));
  }
  return { generations: gens, commits: ids.chainCommits(gens) };
}

/** A [{ signer, ots, authPath }] as the ABI tuple array `(uint8,bytes32[67],bytes32[])[]`. */
const sigsArg = (sigs) => sigs.map((s) => [s.signer, s.ots, s.authPath]);

module.exports = {
  GENERATION_TAG,
  MAX_GENERATIONS,
  MAX_SIGNERS,
  REFERENCE,
  thresholdAdmissible,
  generationSeed,
  seedsFromEnv,
  SignerSet,
  authorityChain,
  sigsArg,
};
