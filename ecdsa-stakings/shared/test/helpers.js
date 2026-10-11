/**
 * Fixtures for the origin-chain suite.
 *
 * The local ZVM harness runs stock EVM under `Hardfork.Shanghai`, which is what
 * `scripts/compile-evm.js` targets — so the same harness that executes hypc
 * artifacts executes solc artifacts unmodified. All it needs is to be pointed at
 * the other build directory.
 *
 * One convenient accident worth naming: the harness's `Common` is `Mainnet`, so
 * `block.chainid` inside a test here is 1, which is the chain id
 * `ecdsa-stakings/ethereum/chain.json` declares. An escrow that derives the
 * chain id of its identifiers from `block.chainid` — which it should, so a
 * forged one is unreachable — therefore gets the right value here for free. A
 * suite for a different chain must not silently rely on that.
 */
const path = require('path');
const { keccak256, toUtf8Bytes } = require('ethers');
const { Chain } = require('../../../test/harness');

const ids = require('../../relayer/lib/identifiers');
const { buildTree, proofFor } = require('../../relayer/lib/merkle');
const { WotsSigner } = require('../../relayer/lib/wots');
const { SignerSet, authorityChain, sigsArg } = require('../../relayer/lib/authority');

const STAKINGS = path.join(__dirname, '..', '..');
const CHAIN_ID = 1n;
const EPOCH = 7n * 24n * 60n * 60n;

/** Where scripts/compile-evm.js wrote this chain's artifacts. */
const buildDirFor = (chain) => path.join(STAKINGS, chain, 'build');

/** A chain whose artifacts come from the EVM leg rather than from build/. */
const originChain = (chain = 'ethereum') => Chain.create({ buildDir: buildDirFor(chain) });

/**
 * The test root authority. A seed in a test file is exactly as powerful as the
 * quorum it stands in for, which is the point: every root a test admits is one
 * the authority signed.
 */
const TEST_SEED = keccak256(toUtf8Bytes('ark-stake:test-root-authority'));

/**
 * One signer per (seed, height), built once for the whole run: a tree is every
 * public key, and rebuilding it per test would dominate the suite.
 *
 * Every fixture deploys a fresh relay against the same commitment, so the same
 * leaf signs different messages across tests. That is reuse, and it would be a
 * forgery kit in a deployment — so fixtures sign through `_signUnchecked`, and
 * only fixtures do. The reuse guard itself is tested in the relayer suite.
 */
const signers = new Map();
function signerFor(treeHeight, seed = TEST_SEED) {
  const key = `${seed}:${treeHeight}`;
  if (!signers.has(key)) signers.set(key, new WotsSigner(seed, treeHeight));
  return signers.get(key);
}

/** The test seed of signer `i`: TEST_SEED for signer 0, as the single-signer relay had it. */
const seedOf = (i, base = TEST_SEED) => (i === 0 ? base : keccak256(toUtf8Bytes(`${base}:signer:${i}`)));

/** The authority chain of `n` test signers at a height, built once: four generations of n trees. */
const chains = new Map();
function chainFor(n, treeHeight, base = TEST_SEED) {
  const key = `${base}:${n}:${treeHeight}`;
  if (!chains.has(key)) {
    const seeds = Array.from({ length: n }, (_, i) => seedOf(i, base));
    chains.set(key, { seeds, ...authorityChain(seeds, treeHeight) });
  }
  return chains.get(key);
}

const epochOf = (chain) => BigInt(chain.timestamp) / EPOCH;

/**
 * A relay with its authority, and the means to admit roots to it.
 *
 * The authority is `threshold` of `signers` test trees and the four-generation
 * chain behind them (whitepaper §3.6); the default, one of one, is the phase-1
 * relay of whitepaper §3.7 the suite was written against. `set` signs as
 * generation 1; `setOf(g)` as a later one.
 *
 * `seal(leaves)` is the whole forward path in one call: build a tree over the
 * leaves, move the clock to an epoch no root has taken yet (the relay admits
 * one root per epoch), sign the root with k signers at the next index, admit
 * it, and hand back the epoch and a proof function.
 */
async function relayFixture(chain, { treeHeight = 4, seed = TEST_SEED, threshold = 1, signers: n = 1 } = {}) {
  const authority = chainFor(n, treeHeight, seed);
  const sets = new Map();
  const setOf = (generation) => {
    if (!sets.has(generation)) sets.set(generation, new SignerSet({ seeds: authority.seeds, threshold, treeHeight, generation }));
    return sets.get(generation);
  };
  const set = setOf(1);
  const signer = set.signers[0];
  const relay = await chain.deploy(
    'ArkEpochRootRelay',
    ['bytes32[]', 'uint8', 'uint8', 'bytes32'],
    [authority.generations[0], threshold, treeHeight, authority.commits[0]],
  );

  const activeSet = async () => setOf(Number(await relay.call('generation')));

  // A root message binds the root's leaf count (audit 2026-09-29, OL-01): one, unless the caller built more.
  const signedAdmission = async (epoch, epochRoot, { leaf, which, leafCount = 1 } = {}) => {
    const index = leaf ?? Number(await relay.call('nextLeaf'));
    const message = ids.rootMessage({ chainId: CHAIN_ID, relay: relay.address, epoch, epochRoot, leafCount });
    const sigs = (await activeSet())._signUnchecked(message, index, which);
    return {
      args: [epoch, epochRoot, leafCount, index, sigsArg(sigs)],
      sigs,
      message,
      index,
    };
  };

  const admit = async (epoch, epochRoot, opts = {}) => {
    const { args } = await signedAdmission(epoch, epochRoot, opts);
    return relay.send('admitEpochRoot', args, { from: opts.from });
  };

  /** Advance the clock, if it must, to the first epoch above `lastEpoch`. */
  const freshEpoch = async () => {
    const last = BigInt(await relay.call('lastEpoch'));
    const now = epochOf(chain);
    if (now > last) return now;
    chain.advanceTime(Number((last + 1n) * EPOCH - BigInt(chain.timestamp)));
    return epochOf(chain);
  };

  const seal = async (leaves) => {
    const list = Array.isArray(leaves) ? leaves : [leaves];
    const tree = buildTree(list);
    const epoch = await freshEpoch();
    await admit(epoch, tree.root, { leafCount: tree.leaves.length });
    return { epoch, root: tree.root, proof: (leaf) => proofFor(tree, leaf) };
  };

  /** The declaration, reaching one escrow. */
  const declare = async (escrow) => {
    const leaf = ids.closeLeaf(CHAIN_ID, escrow);
    const s = await seal(leaf);
    await relay.send('close', [escrow, s.epoch, s.proof(leaf)]);
    return s;
  };

  const freeze = async (escrow, frozen) => {
    const leaf = ids.freezeLeaf(CHAIN_ID, escrow, frozen);
    const s = await seal(leaf);
    await relay.send('setFrozen', [escrow, frozen, s.epoch, s.proof(leaf)]);
    return s;
  };

  return { relay, signer, set, setOf, authority, threshold, signedAdmission, admit, seal, freshEpoch, declare, freeze };
}

module.exports = {
  buildDirFor,
  originChain,
  relayFixture,
  signerFor,
  seedOf,
  chainFor,
  epochOf,
  TEST_SEED,
  CHAIN_ID,
  EPOCH,
  DEFAULT_CHAIN: 'ethereum',
};
