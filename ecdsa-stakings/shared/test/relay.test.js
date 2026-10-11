/**
 * ArkEpochRootRelay: root admission under hash-based one-time signatures of a
 * threshold of committed signers, the authority chain behind them, the
 * publication of every admitted root's leaves, and the per-escrow control
 * leaves that replaced every address-gated power.
 *
 * Every test here defends a property a plausible simplification would remove.
 * The rules are whitepaper §3.6 and yellow paper §2.2 — k of n distinct
 * signers, one shared index per message, forward only, never ahead of the
 * clock, exhaustion terminal per generation, the next generation only from the
 * chain fixed at construction — and invariants I15 to I17 and I35.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const { ACCOUNTS } = require('../../../test/harness');
const { originChain, relayFixture, chainFor, epochOf, CHAIN_ID, EPOCH } = require('./helpers');
const ids = require('../../relayer/lib/identifiers');
const wots = require('../../relayer/lib/wots');
const { buildTree, proofFor, verify: verifyProof } = require('../../relayer/lib/merkle');
const { SignerSet, sigsArg, generationSeed } = require('../../relayer/lib/authority');
const { loadModel, MISSING } = require('../../../test/spec-model');

const ROOT_A = keccak256(toUtf8Bytes('root-a'));
const ROOT_B = keccak256(toUtf8Bytes('root-b'));
const ZERO32 = '0x' + '00'.repeat(32);
/** Two escrows of one relay: the control leaves and every other leaf bind one of them (D10). */
const ESCROW_A = '0x' + 'e1'.repeat(20);
const ESCROW_B = '0x' + 'e2'.repeat(20);
const CTOR = ['bytes32[]', 'uint8', 'uint8', 'bytes32'];

async function fixture(opts) {
  const chain = await originChain();
  const r = await relayFixture(chain, opts);
  return { chain, ...r, epoch: () => epochOf(chain) };
}

const nextEpoch = (ctx) => ctx.chain.advanceTime(Number(EPOCH));

/** A revert of `name` whose arguments are `args`, decoded against the relay ABI. */
async function rejectsWith(ctx, promise, name, args) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected ${name}`);
  const parsed = ctx.relay.iface.parseError(err.data);
  assert.equal(parsed && parsed.name, name);
  assert.deepEqual([...parsed.args].map(String), args.map(String));
}

/** Admit plain roots, one per fresh epoch, until the relay's index is `leaf`. */
async function admitUntil(ctx, leaf) {
  while (Number(await ctx.relay.call('nextLeaf')) < leaf) {
    const e = await ctx.freshEpoch();
    await ctx.admit(e, keccak256(toUtf8Bytes(`filler-${e}`)));
  }
}

/** The arguments of `scheduleExtension` at the next index, signed by the active generation. */
/** The zero word: no root rides with an authority message (V2, PV-18). */
const NO_ROOT = '0x' + '00'.repeat(32);

async function extensionArgs(ctx, { epoch, which, link, epochRoot = NO_ROOT, leafCount = 0 } = {}) {
  const e = epoch ?? (await ctx.freshEpoch());
  const g = Number(await ctx.relay.call('generation'));
  const index = Number(await ctx.relay.call('nextLeaf'));
  const commit = await ctx.relay.call('chainCommit');
  const message = ids.extensionMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, nextGeneration: g + 1, link: commit, epochRoot, leafCount });
  const sigs = ctx.setOf(g)._signUnchecked(message, index, which);
  const next = link || { roots: ctx.authority.generations[g], commit: ctx.authority.commits[g] };
  return { epoch: e, index, args: [next.roots, next.commit, e, epochRoot, leafCount, index, sigsArg(sigs)] };
}

async function cancelArgs(ctx, { which, epochRoot = NO_ROOT, leafCount = 0 } = {}) {
  const e = await ctx.freshEpoch();
  const g = Number(await ctx.relay.call('generation'));
  const index = Number(await ctx.relay.call('nextLeaf'));
  const commit = await ctx.relay.call('chainCommit');
  const message = ids.cancelMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, nextGeneration: g + 1, link: commit, epochRoot, leafCount });
  return { epoch: e, index, args: [e, epochRoot, leafCount, index, sigsArg(ctx.setOf(g)._signUnchecked(message, index, which))] };
}

/** Schedule, wait the ratchet out, activate: one generation further along the chain. */
async function extend(ctx) {
  const opens = Number(await ctx.relay.call('EXTENSION_OPENS'));
  await admitUntil(ctx, opens);
  const { args } = await extensionArgs(ctx);
  await ctx.relay.send('scheduleExtension', args);
  ctx.chain.advanceTime(Number(6n * EPOCH));
  await ctx.relay.send('activateNextGeneration', [], { from: ACCOUNTS.mallory });
}

describe('construction fixes the signer set, the threshold, the chain and the leaf set', () => {
  test('the horizon is 8,000 bps of the leaf set and the extension window [5,000, 9,500) bps, fixed at construction', async () => {
    const ctx = await fixture({ treeHeight: 4 });
    assert.equal(await ctx.relay.call('LEAF_COUNT'), 16n);
    assert.equal(await ctx.relay.call('MIGRATION_HORIZON'), 12n);
    assert.equal(await ctx.relay.call('EXTENSION_OPENS'), 8n);
    assert.equal(await ctx.relay.call('EXTENSION_CLOSES'), 15n);
    assert.deepEqual([...(await ctx.relay.call('signerRoots'))], [ctx.signer.root]);
    assert.equal(await ctx.relay.call('THRESHOLD'), 1n);
    assert.equal(await ctx.relay.call('SIGNER_COUNT'), 1n);
    assert.equal(await ctx.relay.call('generation'), 1n);
    assert.equal(await ctx.relay.call('chainCommit'), ctx.authority.commits[0]);
    assert.equal(await ctx.relay.call('MAX_GENERATIONS'), 4n);
    assert.equal(await ctx.relay.call('RATCHET_EPOCHS'), 6n);
  });

  test('two of three at the reference values: three roots, one per signer', async () => {
    const ctx = await fixture({ treeHeight: 4, threshold: 2, signers: 3 });
    assert.deepEqual([...(await ctx.relay.call('signerRoots'))], ctx.authority.generations[0]);
    assert.equal(await ctx.relay.call('THRESHOLD'), 2n);
    assert.equal(await ctx.relay.call('SIGNER_COUNT'), 3n);
  });

  test('the model reference set is two of three, and the relay admits only n / 2 < k <= n', async (t) => {
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    assert.deepEqual({ ...M.ark.ROOT_SIGNER_SET_REFERENCE }, { k: 2, n: 3 });
    const chain = await originChain();
    const { generations, commits } = chainFor(3, 2);
    for (const [k, n] of [[1, 1], [2, 2], [2, 3], [3, 3], [1, 2], [1, 3], [0, 1], [4, 3], [0, 3]]) {
      const roots = generations[0].slice(0, n).concat(n > 3 ? [] : []);
      const ok = M.ark.signerThresholdAdmissible(k, n);
      const attempt = chain.deploy('ArkEpochRootRelay', CTOR, [roots, k, 2, commits[0]]);
      if (ok) await attempt;
      else await assert.rejects(attempt, /deploy ArkEpochRootRelay failed/, `k=${k} n=${n}`);
    }
  });

  test('a relay committed to nothing, to a repeated tree or to a zero chain cannot be deployed', async () => {
    const chain = await originChain();
    const { generations, commits } = chainFor(3, 2);
    const [a, b] = generations[0];
    for (const [roots, commit] of [[[ZERO32], commits[0]], [[a, a, b], commits[0]], [[a], ZERO32], [[], commits[0]]]) {
      await assert.rejects(
        chain.deploy('ArkEpochRootRelay', CTOR, [roots, roots.length === 3 ? 2 : 1, 2, commit]),
        /deploy ArkEpochRootRelay failed/,
      );
    }
  });

  test('a tree of height zero or above twenty cannot be deployed', async () => {
    const chain = await originChain();
    for (const h of [0, 21]) {
      await assert.rejects(chain.deploy('ArkEpochRootRelay', CTOR, [[ROOT_A], 1, h, ROOT_B]), /deploy ArkEpochRootRelay failed/);
    }
  });
});

describe('a root is admitted on one-time signatures and on nothing else', () => {
  test('a root signed at the next index is admitted, whoever carries it', async () => {
    // Admission does not read the sender, so suppressing a root means excluding
    // every carrier rather than holding one recovered key.
    const ctx = await fixture();
    const e = ctx.epoch();
    const res = await ctx.admit(e, ROOT_A, { from: ACCOUNTS.mallory });
    assert.equal(await ctx.relay.call('acceptedRoot', [e]), ROOT_A);
    assert.equal(await ctx.relay.call('rootOf', [e]), ROOT_A);
    assert.equal(await ctx.relay.call('nextLeaf'), 1n);
    assert.equal(await ctx.relay.call('lastEpoch'), e);
    const [ev] = ctx.relay.events(res, 'EpochRootAdmitted');
    assert.equal(ev.args.leafIndex, 0n);
    assert.equal(ev.args.usableFromEpoch, e + 4n);
  });

  test('the message a key signs is the one the relay reconstructs', async () => {
    // Chain and relay are inside it, so a signature admits one root at one relay.
    const ctx = await fixture();
    const e = ctx.epoch();
    assert.equal(
      await ctx.relay.call('rootMessage', [e, ROOT_A, 1]),
      ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_A, leafCount: 1 }),
    );
  });

  test('a signature over another root does not admit this one', async () => {
    const ctx = await fixture();
    const e = ctx.epoch();
    const { args } = await ctx.signedAdmission(e, ROOT_A);
    args[1] = ROOT_B;
    await assert.rejects(ctx.relay.send('admitEpochRoot', args), /ThresholdNotMet/);
  });

  test('a signature for another epoch does not admit this one', async () => {
    const ctx = await fixture();
    nextEpoch(ctx);
    const e = ctx.epoch();
    const { args } = await ctx.signedAdmission(e - 1n, ROOT_A);
    args[0] = e;
    await assert.rejects(ctx.relay.send('admitEpochRoot', args), /ThresholdNotMet/);
  });

  test('advancing one chain element breaks the signature, because the checksum resists it', async () => {
    // Anyone can hash a published element forward, which raises a message
    // digit. The checksum digits fall when message digits rise, and lowering one
    // needs a preimage, so no advanced signature verifies.
    const ctx = await fixture();
    const e = ctx.epoch();
    const { args, message } = await ctx.signedAdmission(e, ROOT_A);
    const ots = [...args[4][0][1]];
    ots[5] = wots.chainStep(ots[5], 0, 5, wots.digits(message)[5]);
    args[4] = [[args[4][0][0], ots, args[4][0][2]]];
    await assert.rejects(ctx.relay.send('admitEpochRoot', args), /ThresholdNotMet/);
  });

  test('an authentication path that does not reach the signer\'s tree is not counted', async () => {
    const ctx = await fixture();
    const { args } = await ctx.signedAdmission(ctx.epoch(), ROOT_A);
    const path = [...args[4][0][2]];
    path[2] = ROOT_B;
    args[4] = [[args[4][0][0], args[4][0][1], path]];
    await assert.rejects(ctx.relay.send('admitEpochRoot', args), /ThresholdNotMet/);
  });

  test('a path of the wrong length is not counted, so an interior node is not a tree root', async () => {
    const ctx = await fixture();
    const { args } = await ctx.signedAdmission(ctx.epoch(), ROOT_A);
    args[4] = [[args[4][0][0], args[4][0][1], args[4][0][2].slice(0, 3)]];
    await assert.rejects(ctx.relay.send('admitEpochRoot', args), /ThresholdNotMet/);
  });

  test('a key set other than the committed one admits nothing', async () => {
    const ctx = await fixture();
    const other = new SignerSet({ seeds: [keccak256(toUtf8Bytes('not-the-authority'))], threshold: 1, treeHeight: 4 });
    const e = ctx.epoch();
    const message = ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_A, leafCount: 1 });
    await assert.rejects(
      ctx.relay.send('admitEpochRoot', [e, ROOT_A, 1, 0, sigsArg(other._signUnchecked(message, 0))]),
      /ThresholdNotMet/,
    );
  });

  test('a zero root is refused, so the empty proof cannot verify every leaf', async () => {
    const ctx = await fixture();
    await assert.rejects(ctx.admit(ctx.epoch(), ZERO32), /ZeroRoot/);
  });
});

describe('k of n: the threshold of whitepaper §3.6 (D1)', () => {
  const REF = { treeHeight: 5, threshold: 2, signers: 3 };

  test('any two of three distinct signers admit a root', async () => {
    const ctx = await fixture(REF);
    for (const which of [[0, 1], [1, 2], [0, 2], [2, 0]]) {
      const e = await ctx.freshEpoch();
      await ctx.admit(e, keccak256(toUtf8Bytes(`two-of-three-${which}`)), { which });
      assert.equal(await ctx.relay.call('lastEpoch'), e);
    }
  });

  test('one signer alone admits nothing: fewer than k compromised signers direct no payment', async () => {
    const ctx = await fixture(REF);
    for (const which of [[0], [1], [2]]) {
      await rejectsWith(ctx, ctx.admit(ctx.epoch(), ROOT_A, { which }), 'ThresholdNotMet', [1, 2]);
    }
    assert.equal(await ctx.relay.call('nextLeaf'), 0n);
  });

  test('one signer named twice counts once', async () => {
    const ctx = await fixture(REF);
    await rejectsWith(ctx, ctx.admit(ctx.epoch(), ROOT_A, { which: [1, 1] }), 'ThresholdNotMet', [1, 2]);
  });

  test('a signer outside the set is not counted, even with a signature valid on its own tree', async () => {
    // A fourth tree, never committed, signing as index 3 — and as index 0.
    const ctx = await fixture(REF);
    const e = ctx.epoch();
    const message = ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_A, leafCount: 1 });
    const outsider = new SignerSet({ seeds: [keccak256(toUtf8Bytes('outsider'))], threshold: 1, treeHeight: 5 })._signUnchecked(message, 0)[0];
    const good = ctx.set._signUnchecked(message, 0, [1])[0];
    for (const signer of [3, 0]) {
      await rejectsWith(
        ctx,
        ctx.relay.send('admitEpochRoot', [e, ROOT_A, 1, 0, sigsArg([good, { ...outsider, signer }])]),
        'ThresholdNotMet',
        [1, 2],
      );
    }
  });

  test('a bad signature beside k good ones does not stop the root: what does not verify is not counted', async () => {
    const ctx = await fixture(REF);
    const e = ctx.epoch();
    const { sigs } = await ctx.signedAdmission(e, ROOT_A, { which: [0, 2] });
    const bad = { ...ctx.set._signUnchecked(ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_B, leafCount: 1 }), 0, [1])[0] };
    await ctx.relay.send('admitEpochRoot', [e, ROOT_A, 1, 0, sigsArg([bad, ...sigs])]);
    assert.equal(await ctx.relay.call('acceptedRoot', [e]), ROOT_A);
  });

  test('the index is consumed in every tree of the set: a signer silent at a leaf never signs at it', async () => {
    const ctx = await fixture(REF);
    const e0 = await ctx.freshEpoch();
    await ctx.admit(e0, ROOT_A, { which: [0, 1] });
    nextEpoch(ctx);
    const e1 = ctx.epoch();
    // Signer 2 did not sign at leaf 0; its leaf-0 signature, presented at leaf 1, is not counted.
    const m1 = ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e1, epochRoot: ROOT_B, leafCount: 1 });
    const stale = ctx.set._signUnchecked(m1, 0, [2])[0];
    const fresh = ctx.set._signUnchecked(m1, 1, [1])[0];
    await assert.rejects(ctx.relay.send('admitEpochRoot', [e1, ROOT_B, 1, 1, sigsArg([stale, fresh])]), /ThresholdNotMet/);
    await ctx.admit(e1, ROOT_B, { which: [1, 2] });
    assert.equal(await ctx.relay.call('nextLeaf'), 2n);
  });

  test('I16: a set of signatures admits exactly where the model\'s thresholdAdmits says it does', async (t) => {
    const M = await loadModel();
    if (!M) return t.diagnostic(MISSING);
    const ctx = await fixture({ treeHeight: 6, threshold: 2, signers: 3 });
    const outsider = new SignerSet({ seeds: [keccak256(toUtf8Bytes('outsider'))], threshold: 1, treeHeight: 6 });
    // Every multiset of up to three signers from {0, 1, 2, 3}, 3 being outside the set.
    const lists = [];
    const walk = (from, acc) => {
      if (acc.length) lists.push([...acc]);
      if (acc.length === 3) return;
      for (let i = from; i <= 3; i += 1) walk(i, [...acc, i]);
    };
    walk(0, []);
    for (const list of lists) {
      const e = await ctx.freshEpoch();
      const index = Number(await ctx.relay.call('nextLeaf'));
      const root = keccak256(toUtf8Bytes(`agreement-${list.join('-')}`));
      const message = ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: root, leafCount: 1 });
      const sigs = list.map((i) => (i < 3 ? ctx.set._signUnchecked(message, index, [i])[0] : { ...outsider._signUnchecked(message, index)[0], signer: 3 }));
      const want = M.ark.thresholdAdmits(list, 2, 3);
      let admitted = true;
      try {
        await ctx.relay.send('admitEpochRoot', [e, root, 1, index, sigsArg(sigs)]);
      } catch (err) {
        assert.match(err.message, /ThresholdNotMet/);
        admitted = false;
      }
      assert.equal(admitted, want, `signers ${list}`);
    }
  });
});

describe('one message per epoch, forward only, never ahead of the clock', () => {
  test('a second root for the same epoch is refused, so a root is never replaced', async () => {
    const ctx = await fixture();
    const e = ctx.epoch();
    await ctx.admit(e, ROOT_A);
    await assert.rejects(ctx.admit(e, ROOT_B), /EpochNotForward/);
    assert.equal(await ctx.relay.call('acceptedRoot', [e]), ROOT_A);
  });

  test('an epoch before the last admitted is refused, so history cannot be minted', async () => {
    const ctx = await fixture();
    nextEpoch(ctx);
    const e = ctx.epoch();
    await ctx.admit(e, ROOT_A);
    await assert.rejects(ctx.admit(e - 1n, ROOT_B), /EpochNotForward/);
  });

  test('a root cannot be admitted for an epoch that has not begun', async () => {
    // What the escrow's unbonding derivation rests on, and what bounds leaf
    // consumption to one per elapsed epoch (I17).
    const ctx = await fixture();
    await assert.rejects(ctx.admit(ctx.epoch() + 1n, ROOT_A), /FutureEpochRoot/);
  });

  test('only the next index is admitted, so a one-time key signs once', async () => {
    const ctx = await fixture();
    const e = ctx.epoch();
    await assert.rejects(ctx.admit(e, ROOT_A, { leaf: 1 }), /WrongLeafIndex/);
    await ctx.admit(e, ROOT_A);
    nextEpoch(ctx);
    // A replay of leaf 0 on a later epoch is refused against storage.
    await assert.rejects(ctx.admit(ctx.epoch(), ROOT_B, { leaf: 0 }), /WrongLeafIndex/);
  });

  test('OC-LEGA-02: the forward-only rule counts from deployment, so no root labelled before it consumes an index', async () => {
    // OC round 2026-10-03: with `lastEpoch` starting at zero every epoch since
    // 1970 read as elapsed, and an admitting set burned a generation in one
    // block with back-labelled roots (I17, I35).
    const ctx = await fixture({ treeHeight: 5 });
    const deployed = ctx.epoch();
    assert.equal(await ctx.relay.call('lastEpoch'), deployed - 1n, 'the epoch before deployment is the last one elapsed');
    const block = ctx.chain.timestamp;
    for (const e of [1n, deployed - 2n, deployed - 1n]) {
      await rejectsWith(ctx, ctx.admit(e, ROOT_A), 'EpochNotForward', [e, deployed - 1n]);
    }
    // The epoch of deployment is admissible, once; at the same timestamp nothing more is.
    await ctx.admit(deployed, ROOT_A);
    await assert.rejects(ctx.admit(deployed, ROOT_B), /EpochNotForward/);
    assert.equal(ctx.chain.timestamp, block, 'the clock never moved');
    assert.equal(await ctx.relay.call('nextLeaf'), 1n, 'one index for the one epoch elapsed since deployment');
  });

  test('a delay of any length consumes no index, so censorship cannot bring the horizon forward', async () => {
    const ctx = await fixture();
    ctx.chain.advanceTime(Number(20n * EPOCH));
    await ctx.admit(ctx.epoch(), ROOT_A);
    assert.equal(await ctx.relay.call('nextLeaf'), 1n);
  });

  test('exhaustion of the leaf set is terminal for the generation', async () => {
    // Height one: two roots, ever, and an empty extension window.
    const ctx = await fixture({ treeHeight: 1 });
    await ctx.seal(ROOT_A);
    await ctx.seal(ROOT_B);
    assert.equal(await ctx.relay.call('nextLeaf'), 2n);
    const e = await ctx.freshEpoch();
    const message = ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_A, leafCount: 1 });
    // The last key's signature and path, presented at the index past the end.
    await assert.rejects(
      ctx.relay.send('admitEpochRoot', [e, ROOT_A, 1, 2, sigsArg(ctx.set._signUnchecked(message, 1))]),
      /LeafSetExhausted/,
    );
  });
});

describe('publishLeaves: every admitted leaf recoverable from origin-chain state (D15)', () => {
  const leavesOf = (n, tag = 'leaf') => Array.from({ length: n }, (_, i) => keccak256(toUtf8Bytes(`${tag}-${i}`)));

  test('anyone publishes the ordered leaves of an admitted root, and a proof rebuilt from the event verifies', async () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const ctx = await fixture();
      const leaves = leavesOf(n, `n${n}`);
      const s = await ctx.seal(leaves);
      const tree = buildTree(leaves);
      const res = await ctx.relay.send('publishLeaves', [s.epoch, tree.leaves], { from: ACCOUNTS.mallory });
      const [ev] = ctx.relay.events(res, 'LeavesPublished');
      assert.equal(ev.args.epoch, s.epoch);
      const published = [...ev.args.leaves];
      assert.deepEqual(published, tree.leaves);
      assert.equal(await ctx.relay.call('leavesPublished', [s.epoch]), true);
      // A payment's proof, from the chain alone.
      const rebuilt = buildTree(published);
      for (const leaf of leaves) assert.ok(verifyProof(proofFor(rebuilt, leaf), s.root, leaf));
    }
  });

  test('a list that is not the root\'s ordered leaves is refused: reordered, short, padded, repeated', async () => {
    const ctx = await fixture();
    const leaves = leavesOf(4);
    const s = await ctx.seal(leaves);
    const ordered = buildTree(leaves).leaves;
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, [ordered[1], ordered[0], ordered[2], ordered[3]]]), /LeavesNotOrdered/);
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, ordered.slice(0, 3)]), /LeafCountMismatch/);
    const extra = buildTree([...leaves, ROOT_A]).leaves;
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, extra]), /LeafCountMismatch/);
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, [ordered[0], ordered[0], ordered[1], ordered[2]]]), /LeavesNotOrdered/);
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, [ordered[0], ordered[1], ordered[2], ROOT_A].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))]), /LeavesNotRoot/);
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, []]), /LeafCountMismatch/);
    assert.equal(await ctx.relay.call('leavesPublished', [s.epoch]), false);
  });

  test('the root message binds the leaf count: the root\'s interior nodes no longer publish and latch the epoch (audit 2026-09-29, OL-01; PoC R3-01)', async () => {
    for (const n of [3, 4, 5, 8, 13]) {
      const ctx = await fixture();
      const leaves = leavesOf(n, `poc-${n}`);
      const s = await ctx.seal(leaves);
      assert.equal(BigInt(await ctx.relay.call('leafCounts', [s.epoch])), BigInt(n), 'the count the signers signed');
      const tree = buildTree(leaves);
      // Mallory's front-run: the root's two sorted children, and every interior layer.
      for (let k = 1; k < tree.layers.length - 1; k++) {
        const layer = [...tree.layers[k]].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, layer], { from: ACCOUNTS.mallory }), /LeafCountMismatch/, `layer ${k} of n=${n}`);
      }
      assert.equal(await ctx.relay.call('leavesPublished', [s.epoch]), false, 'nothing latched');
      const res = await ctx.relay.send('publishLeaves', [s.epoch, tree.leaves]);
      assert.deepEqual([...ctx.relay.events(res, 'LeavesPublished')[0].args.leaves], tree.leaves, 'the real leaves publish');
    }
  });

  test('a root is admitted only with the leaf count its signers signed; none with no leaves', async () => {
    const ctx = await fixture();
    const e = ctx.epoch();
    const { args } = await ctx.signedAdmission(e, ROOT_A, { leafCount: 3 });
    const forged = [...args];
    forged[2] = 2;
    await assert.rejects(ctx.relay.send('admitEpochRoot', forged), /ThresholdNotMet/, 'another count is another message');
    const zero = await ctx.signedAdmission(e, ROOT_A, { leafCount: 3 });
    const none = [...zero.args];
    none[2] = 0;
    await assert.rejects(ctx.relay.send('admitEpochRoot', none), /ZeroRoot/);
    await ctx.relay.send('admitEpochRoot', args);
    assert.equal(BigInt(await ctx.relay.call('leafCounts', [e])), 3n);
    assert.equal(await ctx.relay.call('rootMessage', [e, ROOT_A, 3]), ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_A, leafCount: 3 }));
  });

  test('no root, no publication; and a root is published once', async () => {
    const ctx = await fixture();
    const leaves = leavesOf(2);
    await assert.rejects(ctx.relay.send('publishLeaves', [ctx.epoch(), leaves]), /NoRootForEpoch/);
    const s = await ctx.seal(leaves);
    const ordered = buildTree(leaves).leaves;
    await ctx.relay.send('publishLeaves', [s.epoch, ordered]);
    await assert.rejects(ctx.relay.send('publishLeaves', [s.epoch, ordered]), /LeavesAlreadyPublished/);
  });
});

describe('the declaration closes one escrow, as a leaf of an admitted root', () => {
  test('anyone may carry the close leaf, and closure is a latch', async () => {
    const ctx = await fixture();
    const leaf = ids.closeLeaf(CHAIN_ID, ESCROW_A);
    const s = await ctx.seal(leaf);
    const res = await ctx.relay.send('close', [ESCROW_A, s.epoch, s.proof(leaf)], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.relay.call('isClosed', [ESCROW_A]), true);
    const c = await ctx.relay.call('controlOf', [ESCROW_A]);
    assert.equal(c.closedEpoch, s.epoch);
    const [ev] = ctx.relay.events(res, 'Closed');
    assert.equal(ev.args.epoch, s.epoch);
    assert.equal(ev.args.escrow.toLowerCase(), ESCROW_A);
    await assert.rejects(ctx.relay.send('close', [ESCROW_A, s.epoch, s.proof(leaf)]), /AlreadyClosed/);
  });

  test('D10: a close leaf binds one escrow, and closes no other escrow of the relay', async () => {
    const ctx = await fixture();
    const leaf = ids.closeLeaf(CHAIN_ID, ESCROW_A);
    const s = await ctx.seal(leaf);
    await assert.rejects(ctx.relay.send('close', [ESCROW_B, s.epoch, s.proof(leaf)]), /BadProof/);
    await ctx.relay.send('close', [ESCROW_A, s.epoch, s.proof(leaf)]);
    assert.equal(await ctx.relay.call('isClosed', [ESCROW_B]), false);
    await ctx.relay.call('requireAnchorable', [ESCROW_B]);
    await assert.rejects(ctx.relay.call('requireAnchorable', [ESCROW_A]), /ReleaseClosed/);
  });

  test('without the close leaf nobody can close, so the escrow is not free to brick', async () => {
    // A bare permissionless close would immobilise every position and trigger
    // no settlement — strictly worse than the event the product is sold against.
    const ctx = await fixture();
    const s = await ctx.seal(ROOT_A);
    await assert.rejects(ctx.relay.send('close', [ESCROW_A, s.epoch, []]), /BadProof/);
    await assert.rejects(ctx.relay.send('close', [ESCROW_A, s.epoch + 5n, []]), /NoRootForEpoch/);
    assert.equal(await ctx.relay.call('isClosed', [ESCROW_A]), false);
  });

  test('a close leaf for another chain does not close this one', async () => {
    const ctx = await fixture();
    const foreign = ids.closeLeaf(8453n, ESCROW_A);
    const s = await ctx.seal(foreign);
    await assert.rejects(ctx.relay.send('close', [ESCROW_A, s.epoch, s.proof(foreign)]), /BadProof/);
  });

  test('roots are still admitted after closure, because recovery is carried by them', async () => {
    // whitepaper §5.4: the recovery is carried by roots sealed after the
    // settlement. A relay that stopped admitting at closure would make recovery
    // impossible by construction.
    const ctx = await fixture();
    await ctx.declare(ESCROW_A);
    const s = await ctx.seal(ROOT_B);
    assert.equal(await ctx.relay.call('acceptedRoot', [s.epoch]), ROOT_B);
  });

  test('there is no staleness closure, so censorship cannot make the escrow immobile', async () => {
    // A censored relay is a court ground (whitepaper §3.6) and the escrow must be
    // recoverable once admission resumes. A long silence closes nothing.
    const ctx = await fixture();
    ctx.chain.advanceTime(Number(52n * EPOCH));
    assert.equal(await ctx.relay.call('isClosed', [ESCROW_A]), false);
    await ctx.seal(ROOT_A);
    assert.equal(await ctx.relay.call('isClosed', [ESCROW_A]), false);
  });
});

describe('the protective freeze of one escrow, as leaves of admitted roots', () => {
  const frozenOf = async (ctx, escrow = ESCROW_A) => (await ctx.relay.call('controlOf', [escrow])).frozen;

  test('a freeze suspends releases and settles nothing, and a later root lifts it', async () => {
    const ctx = await fixture();
    const on = await ctx.freeze(ESCROW_A, true);
    assert.equal(await frozenOf(ctx), true);
    assert.equal((await ctx.relay.call('controlOf', [ESCROW_A])).freezeEpoch, on.epoch);
    assert.equal(await ctx.relay.call('isClosed', [ESCROW_A]), false, 'a freeze is not a closure');
    assert.equal(await frozenOf(ctx, ESCROW_B), false, 'D10: another escrow is not frozen');

    await ctx.freeze(ESCROW_A, false);
    assert.equal(await frozenOf(ctx), false);
  });

  test('D10: a freeze leaf of one escrow does not freeze another', async () => {
    const ctx = await fixture();
    const leaf = ids.freezeLeaf(CHAIN_ID, ESCROW_A, true);
    const s = await ctx.seal(leaf);
    await assert.rejects(ctx.relay.send('setFrozen', [ESCROW_B, true, s.epoch, s.proof(leaf)]), /BadProof/);
  });

  test('an old freeze leaf cannot be replayed over a later lift', async () => {
    // Latest root wins. Without the ordering anyone holding a stale proof could
    // toggle the flag at will.
    const ctx = await fixture();
    const on = await ctx.freeze(ESCROW_A, true);
    await ctx.freeze(ESCROW_A, false);
    await assert.rejects(
      ctx.relay.send('setFrozen', [ESCROW_A, true, on.epoch, on.proof(ids.freezeLeaf(CHAIN_ID, ESCROW_A, true))]),
      /FreezeNotForward/,
    );
    assert.equal(await frozenOf(ctx), false);
  });

  test('a lift leaf does not apply a freeze, nor a freeze leaf lift one', async () => {
    const ctx = await fixture();
    const liftLeaf = ids.freezeLeaf(CHAIN_ID, ESCROW_A, false);
    const s = await ctx.seal([liftLeaf, ROOT_A]);
    await assert.rejects(ctx.relay.send('setFrozen', [ESCROW_A, true, s.epoch, s.proof(liftLeaf)]), /BadProof/);
  });

  test('a leaf restating the current state advances the ordering and leaves the flag and FreezeSet alone', async () => {
    // The restatement is still the latest root's word on the freeze, so it
    // must move `freezeEpoch`; it is not a second freeze or lift, so it emits
    // FreezeRestated rather than a FreezeSet an observer would date one from.
    const ctx = await fixture();
    const liftLeaf = ids.freezeLeaf(CHAIN_ID, ESCROW_A, false);
    const s = await ctx.seal(liftLeaf);
    const res = await ctx.relay.send('setFrozen', [ESCROW_A, false, s.epoch, s.proof(liftLeaf)]);
    assert.equal(await frozenOf(ctx), false);
    assert.equal((await ctx.relay.call('controlOf', [ESCROW_A])).freezeEpoch, s.epoch);
    assert.equal(ctx.relay.events(res, 'FreezeSet').length, 0);
    assert.equal(ctx.relay.events(res, 'FreezeRestated').length, 1);
  });

  test('a stale freeze cannot be applied after a later lift that restated the state', async () => {
    // The PoC: a freeze sealed in epoch e1 and never carried, then a lift in
    // e2 > e1 while the escrow is unfrozen. When a restatement reverted without
    // advancing the ordering, the lift was refused and the stale freeze from
    // e1 then applied, freezing an escrow whose latest root says it is lifted.
    const ctx = await fixture();
    const freezeLeaf = ids.freezeLeaf(CHAIN_ID, ESCROW_A, true);
    const liftLeaf = ids.freezeLeaf(CHAIN_ID, ESCROW_A, false);
    const early = await ctx.seal(freezeLeaf);
    const late = await ctx.seal(liftLeaf);
    await ctx.relay.send('setFrozen', [ESCROW_A, false, late.epoch, late.proof(liftLeaf)]);
    await assert.rejects(
      ctx.relay.send('setFrozen', [ESCROW_A, true, early.epoch, early.proof(freezeLeaf)], { from: ACCOUNTS.mallory }),
      /FreezeNotForward/,
    );
    assert.equal(await frozenOf(ctx), false);
  });

  test('a restatement proves its leaf before it moves the ordering', async () => {
    // Otherwise anyone could advance freezeEpoch past a genuine freeze with
    // no proof at all and make that freeze inapplicable.
    const ctx = await fixture();
    const s = await ctx.seal(ROOT_A);
    await assert.rejects(ctx.relay.send('setFrozen', [ESCROW_A, false, s.epoch, []]), /BadProof/);
    assert.equal((await ctx.relay.call('controlOf', [ESCROW_A])).freezeEpoch, 0n);
  });

  test('a freeze and a lift in the same root: whichever is carried first wins, and the other is refused', async () => {
    // Recorded, not endorsed: one root is one epoch, and the ordering is by
    // epoch, so the relay cannot tell which of two contradictory leaves QRL
    // meant. A root must carry at most one freeze leaf per escrow; the relayer
    // is where that is enforced.
    for (const first of [true, false]) {
      const ctx = await fixture();
      const on = ids.freezeLeaf(CHAIN_ID, ESCROW_A, true);
      const off = ids.freezeLeaf(CHAIN_ID, ESCROW_A, false);
      const s = await ctx.seal([on, off]);
      const leafOf = (v) => (v ? on : off);
      await ctx.relay.send('setFrozen', [ESCROW_A, first, s.epoch, s.proof(leafOf(first))]);
      await assert.rejects(
        ctx.relay.send('setFrozen', [ESCROW_A, !first, s.epoch, s.proof(leafOf(!first))]),
        /FreezeNotForward/,
      );
      assert.equal(await frozenOf(ctx), first);
    }
  });

  test('a freeze cannot move under a closed escrow', async () => {
    const ctx = await fixture();
    const liftLeaf = ids.freezeLeaf(CHAIN_ID, ESCROW_A, false);
    await ctx.freeze(ESCROW_A, true);
    const closeLeaf = ids.closeLeaf(CHAIN_ID, ESCROW_A);
    const s = await ctx.seal([closeLeaf, liftLeaf]);
    await ctx.relay.send('close', [ESCROW_A, s.epoch, s.proof(closeLeaf)]);
    await assert.rejects(ctx.relay.send('setFrozen', [ESCROW_A, false, s.epoch, s.proof(liftLeaf)]), /AlreadyClosed/);
  });

  test('roots are still admitted under a freeze', async () => {
    // The freeze stops releases executing, not the relay relaying — the lift
    // itself arrives in a root.
    const ctx = await fixture();
    await ctx.freeze(ESCROW_A, true);
    const s = await ctx.seal(ROOT_A);
    assert.equal(await ctx.relay.call('acceptedRoot', [s.epoch]), ROOT_A);
  });
});

describe('the authority chain: four generations fixed at construction (I35, gap item 25)', () => {
  test('an extension inside the window, signed by k, activates the next link after six epochs, and only then', async () => {
    const ctx = await fixture({ treeHeight: 4, threshold: 2, signers: 3 });
    await admitUntil(ctx, 8);
    const { args, epoch, index } = await extensionArgs(ctx, { which: [0, 2] });
    const res = await ctx.relay.send('scheduleExtension', args, { from: ACCOUNTS.mallory });
    const [ev] = ctx.relay.events(res, 'ExtensionScheduled');
    assert.equal(ev.args.nextGeneration, 2n);
    const now = epochOf(ctx.chain);
    assert.equal(ev.args.activatesAt, now + 6n);
    // The extension consumed the shared index and the epoch, as a root does (I17).
    assert.equal(await ctx.relay.call('nextLeaf'), BigInt(index + 1));
    assert.equal(await ctx.relay.call('lastEpoch'), epoch);
    const pending = await ctx.relay.call('pendingGeneration');
    assert.deepEqual([...pending[0]], ctx.authority.generations[1]);

    ctx.chain.advanceTime(Number(5n * EPOCH));
    await assert.rejects(ctx.relay.send('activateNextGeneration'), /RatchetRunning/);
    // The old set still admits roots during the delay.
    await ctx.admit(await ctx.freshEpoch(), ROOT_A, { which: [1, 2] });
    ctx.chain.advanceTime(Number(EPOCH));
    await ctx.relay.send('activateNextGeneration', [], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.relay.call('generation'), 2n);
    assert.equal(await ctx.relay.call('nextLeaf'), 0n);
    assert.deepEqual([...(await ctx.relay.call('signerRoots'))], ctx.authority.generations[1]);
    assert.equal(await ctx.relay.call('chainCommit'), ctx.authority.commits[1]);
    assert.equal(await ctx.relay.call('extensionActivatesAt'), 0n);

    // The old generation verifies against nothing; the new one admits from its leaf 0.
    const e = await ctx.freshEpoch();
    const message = ids.rootMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, epochRoot: ROOT_B, leafCount: 1 });
    await assert.rejects(
      ctx.relay.send('admitEpochRoot', [e, ROOT_B, 1, 0, sigsArg(ctx.setOf(1)._signUnchecked(message, 0))]),
      /ThresholdNotMet/,
    );
    await ctx.admit(e, ROOT_B);
    assert.equal(await ctx.relay.call('acceptedRoot', [e]), ROOT_B);
  });

  test('V2: the root of the epoch an extension or a cancellation consumes rides with it, bound by the signatures (PV-18)', async () => {
    const ctx = await fixture({ treeHeight: 4, threshold: 2, signers: 3 });
    await admitUntil(ctx, 8);
    // An extension carrying the epoch's root of two leaves admits that root with it.
    const { args, epoch } = await extensionArgs(ctx, { epochRoot: ROOT_A, leafCount: 2 });
    const res = await ctx.relay.send('scheduleExtension', args, { from: ACCOUNTS.mallory });
    assert.equal(ctx.relay.events(res, 'EpochRootAdmitted')[0].args.epochRoot, ROOT_A);
    assert.equal(await ctx.relay.call('acceptedRoot', [epoch]), ROOT_A, 'the epoch is not left without a root');
    assert.equal(await ctx.relay.call('leafCounts', [epoch]), 2n);
    assert.equal(ctx.relay.events(res, 'ExtensionScheduled').length, 1);

    // Adversarial: a carrier swapping the riding root, or its count, breaks the signatures.
    const cancel = await cancelArgs(ctx, { epochRoot: ROOT_B, leafCount: 3 });
    const [e, , , index, sigs] = cancel.args;
    await assert.rejects(ctx.relay.send('cancelExtension', [e, ROOT_A, 3, index, sigs]), /ThresholdNotMet/);
    await assert.rejects(ctx.relay.send('cancelExtension', [e, ROOT_B, 4, index, sigs]), /ThresholdNotMet/);
    // A nonzero count on a zero root is refused as a root's is.
    const zero = await cancelArgs(ctx, { leafCount: 1 });
    await assert.rejects(ctx.relay.send('cancelExtension', zero.args), /ZeroRoot/);
    const c = await ctx.relay.send('cancelExtension', cancel.args);
    assert.equal(ctx.relay.events(c, 'ExtensionCancelled').length, 1);
    assert.equal(await ctx.relay.call('acceptedRoot', [cancel.epoch]), ROOT_B, 'and with the cancellation');
    // A count of zero admits no root: the epoch waits, as before V2.
    const bare = await extensionArgs(ctx);
    await ctx.relay.send('scheduleExtension', bare.args);
    assert.equal(await ctx.relay.call('acceptedRoot', [bare.epoch]), '0x' + '00'.repeat(32));
  });

  test('outside [5,000, 9,500) bps of the leaf set no extension is scheduled', async () => {
    const ctx = await fixture({ treeHeight: 4 });
    await admitUntil(ctx, 7);
    await assert.rejects(ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args), /OutsideExtensionWindow/);
    await admitUntil(ctx, 15);
    await assert.rejects(ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args), /OutsideExtensionWindow/);
  });

  test('only the next link of the chain: another set of roots, or another commitment after it, is refused', async () => {
    const ctx = await fixture({ treeHeight: 4 });
    await admitUntil(ctx, 8);
    const rogue = new SignerSet({ seeds: [keccak256(toUtf8Bytes('rogue'))], threshold: 1, treeHeight: 4 });
    for (const link of [
      { roots: rogue.roots(), commit: ctx.authority.commits[1] },
      { roots: ctx.authority.generations[1], commit: ids.TERMINAL_COMMIT },
      { roots: ctx.authority.generations[2], commit: ctx.authority.commits[2] },
    ]) {
      await assert.rejects(ctx.relay.send('scheduleExtension', (await extensionArgs(ctx, { link })).args), /NotNextLink/);
    }
  });

  test('an extension is signed under the threshold: one of two of three schedules nothing', async () => {
    const ctx = await fixture({ treeHeight: 4, threshold: 2, signers: 3 });
    await admitUntil(ctx, 8);
    await assert.rejects(ctx.relay.send('scheduleExtension', (await extensionArgs(ctx, { which: [1] })).args), /ThresholdNotMet/);
  });

  test('a cancellation signed by k during the delay voids the schedule; after it, none can', async () => {
    const ctx = await fixture({ treeHeight: 4, threshold: 2, signers: 3 });
    await admitUntil(ctx, 8);
    await ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args);
    await assert.rejects(ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args), /ExtensionPending/);
    await assert.rejects(ctx.relay.send('cancelExtension', (await cancelArgs(ctx, { which: [0] })).args), /ThresholdNotMet/);
    const res = await ctx.relay.send('cancelExtension', (await cancelArgs(ctx, { which: [1, 2] })).args);
    assert.equal(ctx.relay.events(res, 'ExtensionCancelled').length, 1);
    assert.equal(await ctx.relay.call('extensionActivatesAt'), 0n);
    await assert.rejects(ctx.relay.send('activateNextGeneration'), /NoExtensionPending/);
    assert.equal(await ctx.relay.call('generation'), 1n);

    // Scheduled again, it can no longer be cancelled once the delay has run.
    await ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args);
    ctx.chain.advanceTime(Number(6n * EPOCH));
    await assert.rejects(ctx.relay.send('cancelExtension', (await cancelArgs(ctx)).args), /RatchetElapsed/);
    await ctx.relay.send('activateNextGeneration');
    assert.equal(await ctx.relay.call('generation'), 2n);
  });

  test('the chain ends at its fourth generation, and the last commits to the terminal link', async () => {
    const ctx = await fixture({ treeHeight: 2 });
    for (let g = 2; g <= 4; g += 1) {
      await extend(ctx);
      assert.equal(await ctx.relay.call('generation'), BigInt(g));
    }
    assert.equal(await ctx.relay.call('chainCommit'), ids.TERMINAL_COMMIT);
    await admitUntil(ctx, 2);
    const e = await ctx.freshEpoch();
    const message = ids.extensionMessage({ chainId: CHAIN_ID, relay: ctx.relay.address, epoch: e, nextGeneration: 5, link: ids.TERMINAL_COMMIT });
    await assert.rejects(
      ctx.relay.send('scheduleExtension', [[ctx.signer.root], ids.TERMINAL_COMMIT, e, NO_ROOT, 0, 2, sigsArg(ctx.setOf(4)._signUnchecked(message, 2))]),
      /ChainExhausted/,
    );
  });

  test('generations are derived from each signer\'s one seed, and the chain the relay holds is the one they give', async () => {
    const ctx = await fixture({ treeHeight: 2, threshold: 2, signers: 3 });
    const { seeds, generations, commits } = ctx.authority;
    assert.equal(generationSeed(seeds[0], 1), seeds[0]);
    assert.notEqual(generationSeed(seeds[0], 2), seeds[0]);
    assert.equal(commits[3], ids.TERMINAL_COMMIT);
    for (let g = 0; g < 3; g += 1) assert.equal(commits[g], ids.chainLink(generations[g + 1], commits[g + 1]));
  });

  test('the migration horizon is the fallback: anchoring closes at 8,000 bps of the active set and reopens only when a successor is active', async () => {
    const ctx = await fixture({ treeHeight: 4 });
    await admitUntil(ctx, 8);
    await ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args);
    await admitUntil(ctx, 12);
    await assert.rejects(ctx.relay.call('requireAnchorable', [ESCROW_A]), /MigrationHorizonReached/);
    ctx.chain.advanceTime(Number(6n * EPOCH));
    await ctx.relay.send('activateNextGeneration');
    await ctx.relay.call('requireAnchorable', [ESCROW_A]);
  });
});

describe('the relay exposes no address-gated power', () => {
  test('every state change is taken from any caller: a stranger carries admission, extension, activation and publication', async () => {
    const ctx = await fixture({ treeHeight: 2 });
    const leaves = [ROOT_A, ROOT_B];
    const e = await ctx.freshEpoch();
    const tree = buildTree(leaves);
    await ctx.admit(e, tree.root, { from: ACCOUNTS.mallory, leafCount: 2 });
    await ctx.relay.send('publishLeaves', [e, tree.leaves], { from: ACCOUNTS.bob });
    await admitUntil(ctx, 2);
    await ctx.relay.send('scheduleExtension', (await extensionArgs(ctx)).args, { from: ACCOUNTS.alice });
    ctx.chain.advanceTime(Number(6n * EPOCH));
    await ctx.relay.send('activateNextGeneration', [], { from: ACCOUNTS.mallory });
    assert.equal(await ctx.relay.call('generation'), 2n);
  });
});
