/**
 * The relayer engine against both legs as fakes (fake-chains.js).
 *
 * The rule under test throughout is the one the scheme cannot survive
 * breaking: a one-time leaf signs one message, ever — across crashes, a second
 * process over the same state, a second host with its own state, and anyone
 * else carrying a root. Beside it, the leaves that stop something (closure,
 * the freeze, a de-listing) reach the origin chain at the first moment they
 * can, and nothing the relayer carries is lost to a refusal it misread.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ids = require('../lib/identifiers');
const { keccak256, toUtf8Bytes } = require('ethers');
const { hostRefusal, WAIT, FINAL } = require('../engine/relayer');
const { StateConflictError } = require('../engine/state');
const { World, tmpDir, CHAIN_ID, ASSET, ESCROW, ASSET_KEY, ATTESTATION, SWAP, BOND, ZERO32 } = require('./fake-chains');
const { buildTree, proofFor, verify: verifyProof } = require('../lib/merkle');

const E = 4_000_000n;
const LEAF = (n) => '0x' + n.toString(16).padStart(64, '0');

/** An anchor this relayer saw on the origin chain, waiting in a closed forward epoch. */
function seedAnchor(r, world, { epoch = E, id = null, notional = 10n ** 18n } = {}) {
  const s = r.state.data;
  const a = { asset: ASSET, escrow: ESCROW, depositor: '0x' + '0d'.repeat(20), boundQrlOwner: '0x' + '0b'.repeat(20), depositNonce: notional, anchoredNotional: notional, epoch };
  const stakeId = id || ids.stakeAssetId({ chainId: CHAIN_ID, ...a });
  s.anchors[stakeId] = a;
  const f = (s.forward[String(epoch)] ||= { items: [], root: null, sealed: false });
  f.items.push({ kind: 'anchor', id: stakeId, leaf: ids.stakeLeafKey(ESCROW, stakeId, notional), applied: null });
  s.origin.scannedTs = world.clock.endOf(epoch);
  return stakeId;
}

describe('one leaf, one message', () => {
  test('a relayer resubmits the message its leaf signed before a crash, and signs no other', async () => {
    const world = new World();
    const dir = tmpDir();
    world.at(E, 0.6);
    const a = await world.relayer(dir);
    a.enqueue({ kind: 'delist', asset: ASSET });
    world.beforeOriginSend = () => {
      throw new Error('the process died with the transaction unsent');
    };
    await a.tick();
    assert.equal(a.state.data.signed[0].admitted, false, 'the message is on disk before anything was sent');
    a.close();

    world.beforeOriginSend = null;
    world.at(E + 1n, 0.1);
    const b = await world.relayer(dir);
    await b.tick();
    assert.equal(world.relay.nextLeaf, 1);
    assert.equal(world.maxMessagesPerLeaf(), 1, 'leaf 0 signed exactly one message across both processes');
    assert.equal(world.relay.lastEpoch, E, 'the withheld message, for its own epoch, is what was admitted');
  });

  test('a second process over the same state cannot record a second message for a leaf another recorded', async () => {
    // Both start before either signs, so neither has the other's record in
    // memory. The second's save meets the first's record on disk and stops
    // before its signature exists.
    const world = new World();
    const dir = tmpDir();
    world.at(E, 0.6);
    const a = await world.relayer(dir);
    const b = await world.relayer(dir);
    a.enqueue({ kind: 'delist', asset: ASSET });
    world.beforeOriginSend = () => {
      throw new Error('dropped');
    };
    await a.tick();
    world.beforeOriginSend = null;
    // Either the second's save meets the first's record before it signs and
    // it resubmits that same message (the forward path saves before the seal
    // since every closed epoch is sealed, audit 2026-09-29 QL-05), or it
    // records its own and stops: never a second message for the leaf.
    let conflict = null;
    try {
      await b.tick();
    } catch (e) {
      conflict = e;
    }
    if (conflict) assert.ok(conflict instanceof StateConflictError, String(conflict));
    else assert.equal(b.state.data.signed[0].message, a.state.data.signed[0].message, 'the first\'s message, resubmitted');
    assert.equal(world.maxMessagesPerLeaf(), 1);
  });

  test('a state that does not cover the relay history refuses to open for signing (a second host, a restored backup)', async () => {
    const world = new World();
    world.at(E, 0.6);
    const host = await world.relayer(tmpDir());
    await host.tick();
    assert.equal(world.relay.nextLeaf, 1);

    await assert.rejects(() => world.relayer(tmpDir()), /does not cover/);
    // What it may still do: read.
    await assert.doesNotReject(() => world.relayer(tmpDir(), { readOnly: true }));
  });

  test('a running relayer whose relay was advanced by another signer stops signing', async () => {
    const world = new World();
    world.at(E, 0.6);
    const a = await world.relayer(tmpDir());
    const b = await world.relayer(tmpDir());
    await a.tick();
    assert.equal(world.relay.nextLeaf, 1);

    // Leaf 1: A signs a message whose transaction is dropped. B, which has no
    // record of leaf 0, must not sign leaf 1 with a message of its own.
    world.at(E + 1n, 0.6);
    a.enqueue({ kind: 'delist', asset: ASSET });
    world.beforeOriginSend = () => {
      throw new Error('dropped');
    };
    await a.tick();
    world.beforeOriginSend = null;
    const logs = [];
    b.log = (m) => logs.push(m);
    await b.tick();
    assert.equal(world.maxMessagesPerLeaf(), 1, 'no leaf signed two messages');
    assert.equal(b.state.data.signed[1], undefined);
    assert.ok(logs.some((m) => m.includes('REFUSING to sign leaf 1')));
  });

  test('--adopt-state lets an operator take over a state that does not cover the relay, once', async () => {
    const world = new World();
    world.at(E, 0.6);
    await (await world.relayer(tmpDir())).tick();
    const adopted = await world.relayer(tmpDir(), { adoptState: true });
    assert.equal(adopted.state.data.adoptedAt, 1);
    world.at(E + 1n, 0.6);
    await adopted.tick();
    assert.equal(world.relay.nextLeaf, 2);
    assert.equal(world.maxMessagesPerLeaf(), 1);
  });

  test('a relayer runs on the host .env names and nowhere else', () => {
    const env = { HOODI_VPS_RELAYER_HOST: 'qrl-vps' };
    assert.match(hostRefusal(env, 'hoodi-vps', 'dev-box'), /signs from that host only/);
    assert.equal(hostRefusal(env, 'hoodi-vps', 'qrl-vps'), null);
    assert.equal(hostRefusal({}, 'hoodi-vps', 'dev-box'), null, 'unset: no host is named, none is refused');
  });
});

describe('a root carried by someone else', () => {
  test('a front-run admission is recorded, and its leaves consumed', async () => {
    // Admission is permissionless: anyone holding the signed transaction can
    // carry it first. The relayer's own send then fails, and without looking
    // at the relay it would never consume the allocation leaf it sealed.
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    world.beforeOriginSend = (method, args) => {
      world.beforeOriginSend = null;
      world.admit(BigInt(args[0]), args[1], args[2], args[3], args[4], true);
    };
    await r.tick();
    assert.equal(r.state.data.signed[0].admitted, true);
    assert.ok(r.state.data.roots[String(E)], 'the root is recorded as admitted');
    assert.ok(world.escrowCalls.some((c) => c.method === 'recordEpochAllocation' && c.epoch === E), 'its allocation leaf was consumed');
  });

  test('a send that timed out after it was broadcast is recognised on the next tick', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    world.beforeOriginSend = (method, args) => {
      world.beforeOriginSend = null;
      world.admit(BigInt(args[0]), args[1], args[2], args[3], args[4], true);
      throw new Error('timeout waiting for the receipt');
    };
    await r.tick();
    world.at(E, 0.7);
    await r.tick();
    assert.ok(r.state.data.roots[String(E)]);
    assert.ok(world.escrowCalls.some((c) => c.method === 'recordEpochAllocation'));
    assert.equal(world.maxMessagesPerLeaf(), 1);
  });
});

describe('the seed return (whitepaper §4.2, PV-17)', () => {
  test('sealed for an escrow whose stake has left, only while the bond reads nothing open; adversarial: an open determination seals none', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    // No bond named: nothing is sealed.
    assert.deepEqual(await r.seedReturnItems(E), []);
    r.q.ArkCatBond = BOND;
    // Nothing requested: nothing is sealed (re-audit 2026-09-30, ORIGIN-01).
    assert.deepEqual(await r.seedReturnItems(E), []);
    world.seedReturnRequests = 1n;
    const items = await r.seedReturnItems(E);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'seedReturn');
    assert.equal(items[0].leaf, ids.seedReturnLeaf(CHAIN_ID, ESCROW, E));
    // A determination open (or a ground found, or a declaration): the bond
    // says no, and the seed stays whatever the escrow's own state reads.
    world.bond.sealable = false;
    assert.deepEqual(await r.seedReturnItems(E), []);
    // Nothing open, but a position still anchored: nothing to return.
    world.bond.sealable = true;
    world.escrowTotalStake = 1n;
    assert.deepEqual(await r.seedReturnItems(E), []);
    // A loss leaf of this escrow not yet presented holds it too (BOND-03).
    world.escrowTotalStake = 0n;
    r.state.data.pending.push({ kind: 'loss', escrow: ESCROW, asset: ASSET, leaf: '0x' + '4c'.repeat(32) });
    assert.deepEqual(await r.seedReturnItems(E), []);
  });

  test('ORIGIN-01: one leaf per request, sealed in the root of the epoch it is signed in and never again', async () => {
    const world = new World();
    world.deployment.qrl.ArkCatBond = BOND;
    world.seedReturnRequests = 1n;
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick();
    const leaf = ids.seedReturnLeaf(CHAIN_ID, ESCROW, E);
    assert.ok(r.state.data.roots[String(E)].items.some((x) => x.leaf === leaf), 'the requested leaf is sealed');
    world.at(E + 1n, 0.6);
    await r.tick();
    const next = r.state.data.roots[String(E + 1n)];
    assert.ok(!next || !next.items.some((x) => x.kind === 'seedReturn'), 'no second leaf for the one request');
    // A second request seals a second leaf.
    world.seedReturnRequests = 2n;
    world.at(E + 2n, 0.6);
    await r.tick();
    assert.ok(r.state.data.roots[String(E + 2n)].items.some((x) => x.leaf === ids.seedReturnLeaf(CHAIN_ID, ESCROW, E + 2n)));
  });
});

describe('data availability and the escrow each leaf binds', () => {
  test('D15: an admitted root\'s ordered leaves are published on the origin chain in its admission epoch', async () => {
    // whitepaper §3.6: every leaf a payment needs is recoverable from
    // origin-chain state, not from this relayer's file.
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick();
    const root = r.state.data.roots[String(E)];
    assert.ok(root, 'a root was admitted');
    assert.deepEqual(world.relay.published.get(E), buildTree(root.items.map((x) => x.leaf)).leaves);
    assert.equal(root.published, true);
  });

  test('D15: a publication that failed is retried at the next tick', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    world.beforeOriginSend = (method) => {
      if (method === 'publishLeaves') throw new Error('rpc down');
    };
    const origin = r.origin;
    const send = origin.send.bind(origin);
    origin.send = async (to, abi, method, args, opts) => {
      if (method === 'publishLeaves' && world.beforeOriginSend) world.beforeOriginSend(method, args);
      return send(to, abi, method, args, opts);
    };
    await r.tick();
    assert.equal(world.relay.published.size, 0);
    assert.equal(r.state.data.roots[String(E)].published, undefined);
    world.beforeOriginSend = null;
    world.at(E, 0.7);
    await r.tick();
    assert.equal(world.relay.published.size, 1);
  });

  test('D10: the allocation is one leaf per escrow, bound to that escrow and presented to it alone', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick();
    const alloc = r.state.data.roots[String(E)].items.filter((x) => x.kind === 'allocation');
    assert.equal(alloc.length, 1);
    assert.equal(alloc[0].escrow, ESCROW);
    assert.equal(alloc[0].leaf, ids.allocationLeaf(alloc[0]));
    assert.ok(world.escrowCalls.some((c) => c.method === 'recordEpochAllocation' && c.epoch === E));
  });
});

describe('the authority chain (whitepaper §3.6, I35)', () => {
  /** A world whose relay commits to a chain the manifest records, with the window brought near. */
  async function chained() {
    const world = new World();
    const gens = [1, 2, 3, 4].map((g) => [keccak256(toUtf8Bytes(`gen-${g}`))]);
    const commits = ids.chainCommits(gens);
    world.chainCommit = commits[0];
    world.window = { opens: 2, closes: 19, horizon: 16 };
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    r.manifest = { ...r.manifest, authority: { threshold: 1, signers: 1, treeHeight: 4, generations: gens, commits } };
    // The fake signer set has no seeds to derive the next generation from; the
    // generation it signs for is all a test of the engine needs.
    r.signerSetFor = (g) => ({ ...world.signer(), generation: g });
    r.assertSeedsOpen = () => {};
    return { world, r, gens, commits };
  }

  test('an extension to the next link is signed late in the window, two ratchets before the horizon, in place of a root', async () => {
    const { world, r, gens, commits } = await chained();
    // Roots at leaves 0 .. 3: the window opened at 2, the relayer waits for 16 - 12 = 4.
    for (let i = 0n; i < 4n; i += 1n) {
      world.at(E + i, 0.6);
      await r.tick();
    }
    assert.equal(world.relay.nextLeaf, 4);
    assert.equal(world.relay.extensionAt, 0n, 'nothing scheduled while the window is only open');
    world.at(E + 4n, 0.6);
    await r.tick();
    assert.equal(world.relay.extensionAt, E + 4n + 6n, 'scheduled at leaf 4, activating six epochs on');
    assert.deepEqual(world.relay.pending.nextRoots, gens[1]);
    assert.equal(world.relay.pending.nextCommit, commits[1]);
    const rec = r.state.data.signed['4'];
    assert.equal(rec.kind, 'extension');
    assert.equal(rec.admitted, true);
    // V2 (2026-09-30, PV-18): the extension takes the epoch's index, and the
    // epoch's root rides with it, so its return facts are not left rootless.
    assert.ok(rec.leafCount > 0, 'the epoch had return facts');
    assert.equal(world.relay.roots.get(E + 4n), rec.root, 'its root admitted with the extension');
    assert.equal(r.state.data.roots[String(E + 4n)].root, rec.root, 'and recorded as a root is');
  });

  test('once its delay has run the next generation is activated, and signing continues from its leaf 0', async () => {
    const { world, r } = await chained();
    for (let i = 0n; i <= 4n; i += 1n) {
      world.at(E + i, 0.6);
      await r.tick();
    }
    world.at(E + 9n, 0.6);
    await r.tick();
    assert.equal(world.relay.generation, 1, 'not before the ratchet');
    world.at(E + 10n, 0.6);
    await r.tick();
    assert.equal(world.relay.generation, 2);
    assert.equal(r.signers.generation, 2);
    world.at(E + 11n, 0.6);
    await r.tick();
    assert.equal(world.relay.nextLeaf, 1, 'generation 2 signed its leaf 0');
    assert.ok(r.state.data.signed['2:0'], 'recorded under its generation, never over generation 1\'s leaf 0');
  });

  test('a cancellation an operator asked for is signed in place of the next root while the delay runs', async () => {
    const { world, r } = await chained();
    for (let i = 0n; i <= 4n; i += 1n) {
      world.at(E + i, 0.6);
      await r.tick();
    }
    let cancelled = null;
    const send = r.origin.send.bind(r.origin);
    r.origin.send = async (to, abi, method, args, opts) => {
      if (method === 'cancelExtension') {
        cancelled = args;
        world.relay.extensionAt = 0n;
        world.relay.lastEpoch = BigInt(args[0]);
        world.relay.nextLeaf += 1;
        return { gasUsed: 1n, logs: [] };
      }
      return send(to, abi, method, args, opts);
    };
    r.origin.call = ((call) => async (to, abi, method, args = []) => (method === 'cancelExtension' ? [] : call(to, abi, method, args)))(r.origin.call.bind(r.origin));
    r.state.data.cancelExtension = { operator: 'test' };
    world.at(E + 5n, 0.6);
    await r.tick();
    assert.ok(cancelled, 'the cancellation was carried');
    assert.equal(r.state.data.signed['5'].kind, 'cancel');
    assert.equal(r.state.data.cancelExtension, null);
  });
});

describe('a release receipt is presented twice (whitepaper §3.3, I18; audit 2026-09-22, X7)', () => {
  test('at once, taking the position into transit, and again once due, consuming it', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    const id = seedAnchor(r, world, { epoch: E - 1n });
    const recipient = '0x' + '0c'.repeat(20);
    const leaf = ids.releaseLeaf(ESCROW, ids.releasePayload({ id, recipient, claimNonce: 1n, chainId: CHAIN_ID }));
    world.emitQrl('ReleaseInstructed', [id, recipient, 1n, leaf, 0n, 10n ** 18n]);
    await r.tick();
    const [root] = Object.entries(r.state.data.roots).filter(([, x]) => x.items.some((i) => i.leaf === leaf));
    assert.ok(root, 'the receipt was sealed');
    const epoch = BigInt(root[0]);
    assert.ok(world.transit.has(id), 'presented as soon as its root was admitted: the position is in transit');
    assert.deepEqual(world.escrowCalls.filter((c) => c.method === 'release'), [], 'and nothing was consumed');
    const ck = `${leaf}@${ESCROW}`;
    assert.equal(r.state.data.consumed[`${ck}#transit`].outcome, 'transit');
    assert.equal(r.state.data.consumed[ck], undefined);

    // Not presented again while its unbonding runs.
    const calls = world.escrowCalls.length;
    world.at(epoch + 2n, 0.3);
    await r.tick();
    assert.equal(world.escrowCalls.filter((c) => c.method === 'release' || c.method === 'transit').length, 1);

    world.at(epoch + 4n, 0.1);
    await r.tick();
    assert.ok(world.escrowCalls.length > calls);
    assert.equal(world.escrowCalls.filter((c) => c.method === 'release').length, 1, 'consumed once its unbonding ran');
    assert.equal(world.transit.has(id), false);
    assert.equal(r.state.data.consumed[ck].outcome, 'release');
  });
});

describe('control leaves', () => {
  test('a de-listing on the registry becomes a delist leaf, sealed at once and consumed', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick(); // this epoch's root
    world.at(E + 1n, 0.05);
    world.emitQrl('AssetDelisted', [ASSET_KEY, 1]);
    await r.tick();
    assert.equal(world.anchoringClosed, true, 'the escrow closed to new anchoring in the first moments of the next epoch');
    const sealed = Object.values(r.state.data.roots).flatMap((x) => x.items).find((x) => x.kind === 'delist');
    assert.equal(sealed.standIn, null, 'produced by a built procedure, not a stand-in');
  });

  test('a de-listing of an asset of another chain is ignored', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    world.emitQrl('AssetDelisted', ['0x' + '77'.repeat(32), 0]);
    await r.scanQrl();
    assert.equal(r.state.data.pending.length, 0);
  });

  test('a control leaf does not wait for the half-way mark; other leaves do', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick();
    world.at(E + 1n, 0.05);
    r.enqueue({ kind: 'recovery', asset: ASSET, destination: ASSET, quantity: 1n });
    await r.tick();
    assert.equal(world.relay.nextLeaf, 1, 'a recovery share waits for the mark');
    r.enqueue({ kind: 'close' });
    await r.tick();
    assert.equal(world.relay.nextLeaf, 2, 'closure is sealed at once');
    assert.equal(world.relay.closed, true);
  });

  test('a declaration on the Q-Day oracle is read into a closure leaf, labelled a stand-in', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick();
    world.qday.declared = true;
    world.at(E + 1n, 0.05);
    await r.tick();
    assert.equal(world.relay.closed, true);
    const close = Object.values(r.state.data.roots).flatMap((x) => x.items).find((x) => x.kind === 'close');
    assert.match(close.standIn, /MockQDayOracle/);
  });

  test('the oracle freeze is followed by its changes, not its level', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    await r.tick();
    // An operator's freeze while the oracle reads unfrozen is not undone.
    r.enqueue({ kind: 'freeze', frozen: true });
    world.at(E + 1n, 0.05);
    await r.tick();
    assert.equal(world.relay.frozen, true);
    world.at(E + 2n, 0.05);
    await r.tick();
    assert.equal(world.relay.frozen, true, 'the unfrozen oracle did not lift a freeze nobody asked to lift');
    // The oracle freezes and then lifts: each change is carried.
    world.qday.frozen = true;
    world.at(E + 3n, 0.05);
    await r.tick();
    world.qday.frozen = false;
    world.at(E + 4n, 0.05);
    await r.tick();
    assert.equal(world.relay.frozen, false);
  });

  test('at most one freeze leaf is pending, and the latest request stands', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    r.enqueue({ kind: 'freeze', frozen: true });
    r.enqueue({ kind: 'freeze', frozen: false });
    const freezes = r.state.data.pending.filter((x) => x.kind === 'freeze');
    assert.equal(freezes.length, 1);
    assert.equal(freezes[0].frozen, false);
  });

  test('a freeze after a lift is sealed again, though an older root carried the same leaf', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    r.enqueue({ kind: 'freeze', frozen: true });
    await r.tick();
    r.enqueue({ kind: 'freeze', frozen: false });
    world.at(E + 1n, 0.05);
    await r.tick();
    assert.equal(world.relay.frozen, false);
    r.enqueue({ kind: 'freeze', frozen: true });
    world.at(E + 2n, 0.05);
    await r.tick();
    assert.equal(world.relay.frozen, true);
  });

  test('a freeze leaf restating the flag waits rather than being recorded final', () => {
    assert.ok(!FINAL.has('FreezeUnchanged'));
    assert.ok(WAIT.has('FreezeUnchanged'));
  });
});

describe('the allocation leaf', () => {
  test('a leaf and values read across a book change are not sealed together', async () => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    world.allocationDrift = { premiumBps: 3515 };
    await r.tick();
    assert.equal(r.state.data.signed[0], undefined, 'nothing signed on two reads that disagree');
    world.at(E, 0.7);
    await r.tick();
    const item = r.state.data.roots[String(E)].items.find((x) => x.kind === 'allocation');
    assert.equal(item.leaf, ids.allocationLeaf(item), 'the sealed leaf is the one its values reproduce');
    assert.ok(world.escrowCalls.some((c) => c.method === 'recordEpochAllocation'));
  });
});

describe('the forward path', () => {
  test('a 64-byte Q+128 owner crosses whole: Anchored words -> state -> recordAnchor input', async () => {
    // The escrow emits the bound owner as two words; the engine rebuilds the
    // one canonical account string, and the AnchorInput it sends carries the
    // owner at full width while the origin-chain asset and depositor keep
    // their 20 bytes on this (non-v3) leg.
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const owner = 'Q' + 'ab'.repeat(20) + 'cd'.repeat(44);
    const depositor = '0x' + '0d'.repeat(20);
    const id = world.emitAnchored({ boundQrlOwner: owner, depositor, epoch: E });
    assert.equal(id, ids.stakeAssetId({ chainId: CHAIN_ID, asset: ASSET, depositor, boundQrlOwner: owner, depositNonce: 1n }), 'the identifier commits to the 64-byte owner');
    await r.tick();

    assert.equal(r.state.data.anchors[id].boundQrlOwner, owner, 'the state keeps the one canonical Q+128 string');
    assert.equal(world.anchors.get(id)?.status, 1, 'the anchor is on the registry');
    const item = r.state.data.forward[String(E)].items.find((x) => x.kind === 'anchor' && x.id === id);
    assert.equal(item.applied, 'recorded');
    const input = world.recordAnchorInputs.at(-1);
    assert.equal(input[3], '0x' + 'ab'.repeat(20) + 'cd'.repeat(44), 'the owner passes at its own width, hex, all 64 bytes');
    assert.equal(input[1], ASSET, 'the origin asset stays 20 bytes off the v3 leg');
    assert.equal(input[2], depositor, 'so does the depositor');
  });

  test('an escrow buffer is reported once an epoch and carried to recordBuffer; an older report is final, not retried', async () => {
    // buffer_orig of whitepaper §4.3: the escrow states it, the forward path
    // seals it, the registry proves it and only ever takes a newer epoch.
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const leaf = world.emitBufferReported({ epoch: E, units: 42n * 10n ** 18n });
    await r.tick();
    const item = r.state.data.forward[String(E)].items.find((x) => x.kind === 'buffer');
    assert.equal(item.leaf, leaf);
    assert.equal(item.applied, 'recorded');
    assert.equal(world.buffers.get(ASSET.toLowerCase())?.units, 42n * 10n ** 18n);
    assert.deepEqual(world.bufferReports, [E + 1n], 'the housekeeping asked the escrow for this epoch\'s report');
    await r.tick();
    assert.equal(world.bufferReports.length, 1, 'once per epoch');

    // A report of an epoch no newer than the recorded one would roll the buffer back.
    world.buffers.set(ASSET.toLowerCase(), { epoch: E + 5n, units: 1n });
    world.emitBufferReported({ epoch: E + 1n, units: 99n * 10n ** 18n });
    world.at(E + 2n, 0.6);
    await r.tick();
    const stale = r.state.data.forward[String(E + 1n)].items.find((x) => x.kind === 'buffer');
    assert.match(stale.applied, /newer report/);
    assert.equal(world.buffers.get(ASSET.toLowerCase()).units, 1n);
  });

  test('a legacy 20-byte owner arrives as a zero high word and is rebuilt to the 0x+40 form', async () => {
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const owner = '0x' + '0b'.repeat(20);
    const id = world.emitAnchored({ boundQrlOwner: owner, epoch: E });
    await r.tick();
    assert.equal(r.state.data.anchors[id].boundQrlOwner, owner);
    assert.equal(world.anchors.get(id)?.status, 1);
    assert.equal(world.recordAnchorInputs.at(-1)[3], owner, 'a legacy owner passes as 20 bytes on the harness path');
  });

  test('every closed epoch gets a forward root, a quiet one its anchor count of zero, and each root counts its anchors (QL-05, QL-06)', async () => {
    const world = new World();
    world.at(E + 3n, 0.6);
    const r = await world.relayer(tmpDir());
    const s = r.state.data;
    // Two anchors in E, nothing in E + 1 and E + 2: the scan has closed E + 2.
    seedAnchor(r, world, { epoch: E, notional: 1n * 10n ** 18n });
    seedAnchor(r, world, { epoch: E, notional: 2n * 10n ** 18n });
    s.origin.scannedTs = world.clock.endOf(E + 2n);
    await r.forward();
    // The count is cumulative (re-audit 2026-09-30, BOND-02): the two anchors of E carry through the quiet epochs.
    for (const [e, count] of [[E, 2], [E + 1n, 2], [E + 2n, 2]]) {
      const root = world.attestation.get(e);
      assert.ok(root, `epoch ${e} sealed`);
      const leaves = [...s.forward[String(e)].items.map((x) => x.leaf), ids.anchorCountLeaf({ epoch: e, count })];
      const tree = buildTree(leaves);
      assert.equal(root, tree.root, `epoch ${e}'s root carries its count of ${count}`);
      const leaf = ids.anchorCountLeaf({ epoch: e, count });
      assert.ok(verifyProof(proofFor(tree, leaf), root, leaf));
    }
    assert.equal(world.attestation.get(E + 1n), ids.anchorCountLeaf({ epoch: E + 1n, count: 2 }), 'a quiet epoch: the count leaf, cumulative, is the whole root');
    assert.equal(world.attestation.get(E + 3n), undefined, 'the open epoch waits');
  });

  test('an offer another account recorded first is kept, and selected here (QL-16)', async () => {
    const world = new World();
    world.deployment.qrl.PremiumSwap = SWAP;
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const s = r.state.data;
    const leaf = ids.premiumOfferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET, epoch: E, shares: 5n, units: 5n });
    (s.forward[String(E)] ||= { items: [], root: null, sealed: false }).items.push({ kind: 'offer', id: leaf, leaf, asset: ASSET, escrow: ESCROW, epoch: E, shares: 5n, units: 5n, applied: null });
    s.origin.scannedTs = world.clock.endOf(E);
    // Mallory copies the relayer's transaction and lands first.
    world.offers = new Map([[`${ASSET.toLowerCase()}@${E}`, { shares: 5n, units: 5n }]]);
    await r.forward();
    const item = s.forward[String(E)].items.find((x) => x.kind === 'offer');
    assert.equal(item.applied, 'recorded by another account');
    assert.ok(s.offerings[`${ASSET}@${E}`], 'kept for selection, rebuilt from its own forward item');
    world.now = world.clock.quoteCloses(E) + 1n;
    await r.settleSwaps(null, world.now);
    assert.deepEqual(world.selections, [[ASSET.toLowerCase(), E]], 'and selected when its quote window closes');
  });

  test('leaves another account published first are checked against this root; a list that is not its own is an ALARM (OL-01)', async () => {
    const world = new World();
    world.at(E, 0.6);
    const lines = [];
    const r = await world.relayer(tmpDir(), { log: (l) => lines.push(l) });
    await r.tick();
    const root = r.state.data.roots[String(E)];
    assert.ok(root && root.published, 'admitted and published');
    // Replay the publication against a relay that already holds another list.
    root.published = false;
    world.relay.published.set(E, ['0x' + '01'.repeat(32)]);
    const relayIface = new (require('ethers').Interface)(['event LeavesPublished(uint64 indexed epoch, bytes32[] leaves)']);
    r.abi.relay = relayIface;
    const { data, topics } = relayIface.encodeEventLog(relayIface.getEvent('LeavesPublished'), [E, ['0x' + '01'.repeat(32)]]);
    world.originLogs.push({ address: r.relay, topics, data, blockNumber: world.block, transactionHash: '0x', logIndex: 0 });
    await r.publish(E);
    assert.ok(lines.some((l) => /ALARM/.test(l) && /not this root/.test(l)), lines.join('\n'));
  });

  test('an attestation root overwritten by someone else is resealed, and the anchor recorded', async () => {
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const id = seedAnchor(r, world);
    const qrl = r.qrl;
    const send = qrl.send.bind(qrl);
    let overwritten = false;
    qrl.send = async (to, abi, method, args) => {
      const out = await send(to, abi, method, args);
      if (to === ATTESTATION && method === 'seal' && !overwritten) {
        overwritten = true;
        world.attestation.set(BigInt(args[0]), '0x' + 'ba'.repeat(32));
      }
      return out;
    };
    await r.forward();
    assert.ok(overwritten);
    assert.equal(world.anchors.get(id)?.status, 1, 'the anchor is on the registry');
    assert.equal(r.state.data.forward[String(E)].items[0].applied, 'recorded');
  });

  test('BadProof on the forward path is never recorded final', async () => {
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    seedAnchor(r, world);
    const qrl = r.qrl;
    const send = qrl.send.bind(qrl);
    qrl.send = async (to, abi, method, args) => {
      const out = await send(to, abi, method, args);
      if (to === ATTESTATION && method === 'seal') world.attestation.set(BigInt(args[0]), '0x' + 'ba'.repeat(32));
      return out;
    };
    await r.forward();
    assert.equal(r.state.data.forward[String(E)].items[0].applied, null, 'still to be recorded');
  });

  test('a replaced QRL leg does not record again a position that has left, and says why (X5)', async () => {
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const released = seedAnchor(r, world, { notional: 1n });
    const inTransit = seedAnchor(r, world, { notional: 2n });
    const live = seedAnchor(r, world, { notional: 3n });
    const s = r.state.data;
    s.forward[String(E)].items.push({ kind: 'released', id: released, leaf: LEAF(1), applied: 'recorded' });
    s.roots['1'] = { root: ZERO32, leafIndex: 0, items: [{ kind: 'release', id: inTransit, leaf: LEAF(2) }] };
    s.qrlLeg = { registry: 'old', deployedAt: 'yesterday' };
    r.state.save();
    await r.openState({ signing: false });

    await r.forward();
    const byId = Object.fromEntries(s.forward[String(E)].items.filter((x) => x.kind === 'anchor').map((x) => [x.id, x.applied]));
    assert.match(byId[released], /^not recorded: released on the origin chain/);
    assert.match(byId[inTransit], /^not recorded: its release was instructed on the replaced QRL leg/);
    assert.equal(byId[live], 'recorded');
    assert.ok(!world.anchors.has(released) && !world.anchors.has(inTransit), 'neither is live notional on the new registry');
  });

  test('a replaced QRL leg does not record an anchor of an asset the manifest no longer lists', async () => {
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const dropped = seedAnchor(r, world, { notional: 1n });
    const live = seedAnchor(r, world, { notional: 2n });
    const s = r.state.data;
    s.anchors[dropped].asset = '0x' + 'ee'.repeat(20);
    s.qrlLeg = { registry: 'old', deployedAt: 'yesterday' };
    r.state.save();
    await r.openState({ signing: false });

    await r.forward();
    const byId = Object.fromEntries(s.forward[String(E)].items.map((x) => [x.id, x.applied]));
    assert.match(byId[dropped], /^not recorded: asset 0x(ee){20} is not listed/);
    assert.equal(byId[live], 'recorded');
    assert.ok(!world.anchors.has(dropped), 'no notional on the new registry for a dropped asset');
  });

  test('a released fact the leg can never take is final with its reason, not retried for ever', async () => {
    const world = new World();
    world.at(E + 1n, 0.6);
    const r = await world.relayer(tmpDir());
    const id = seedAnchor(r, world);
    r.state.data.forward[String(E)].items.push({ kind: 'released', id, leaf: LEAF(3), applied: null });
    await r.forward();
    const rel = r.state.data.forward[String(E)].items.find((x) => x.kind === 'released');
    assert.match(rel.applied, /^WrongStatus/);
  });
});

describe('the QRL leg, gone or not', () => {
  const state = async (mutate) => {
    const world = new World();
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir(), { signing: false });
    mutate(world, r);
    return (await r.qrlLegState()).state;
  };

  test('present while the registry has code', async () => assert.equal(await state(() => {}), 'present'));
  test('a node behind the deployment is waited for, not redeployed over', async () => {
    assert.equal(await state((w) => (w.registryCode = '0x')), 'lagging');
  });
  test('an RPC on another chain is never redeployed over', async () => {
    assert.equal(await state((w) => { w.registryCode = '0x'; w.qrlChainId = 1n; }), 'foreign');
  });
  test('a devnet regenerated from genesis is', async () => {
    assert.equal(await state((w) => { w.registryCode = '0x'; w.qrlGenesis = { hash: '0x' + '01'.repeat(32), timestamp: 5n }; }), 'regenerated');
  });
  test('code at the old registry address on a new genesis is another contract, and still regenerated', async () => {
    // Nonce replay: the address comes back holding whatever the new genesis
    // deployed at that nonce, so code alone must not read as present.
    assert.equal(await state((w) => { w.qrlGenesis = { hash: '0x' + '01'.repeat(32), timestamp: 5n }; }), 'regenerated');
  });
  test('without a recorded genesis, only a genesis born after the deployment counts as regenerated', async () => {
    assert.equal(await state((w) => { w.registryCode = '0x'; delete w.deployment.qrlGenesisHash; }), 'lagging');
    assert.equal(await state((w) => { w.registryCode = '0x'; delete w.deployment.qrlGenesisHash; w.qrlGenesis = { hash: '0x02', timestamp: 4_000_000_000n }; }), 'regenerated');
  });
  test('a chain with no block yet is waited for', async () => {
    assert.equal(await state((w) => { w.registryCode = '0x'; w.qrlHead = 0n; }), 'waiting');
  });
});

describe('status', () => {
  test('a read-only open writes nothing, even where a signing open would reset the QRL side', async () => {
    const world = new World();
    world.at(E, 0.6);
    const dir = tmpDir();
    const r = await world.relayer(dir);
    r.state.data.qrlLeg = { registry: 'old', deployedAt: 'yesterday' };
    r.state.save();
    r.close();
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const files = fs.readdirSync(dir).sort();
    await world.relayer(dir, { readOnly: true });
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), files);
  });
});


/**
 * The re-audit of 2026-09-30 (docs/review/audit-2026-09-30/ORIGIN): the
 * relayer PoCs of ORIGIN-02 and ORIGIN-06, as regressions.
 */
describe('re-audit 2026-09-30: the extension beside urgent facts, and roots sealed before the V2 count', () => {
  async function chained() {
    const world = new World();
    const gens = [1, 2, 3, 4].map((g) => [keccak256(toUtf8Bytes(`gen-${g}`))]);
    const commits = ids.chainCommits(gens);
    world.chainCommit = commits[0];
    world.window = { opens: 2, closes: 19, horizon: 16 };
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir());
    r.manifest = { ...r.manifest, authority: { threshold: 1, signers: 1, treeHeight: 4, generations: gens, commits } };
    r.signerSetFor = (g) => ({ ...world.signer(), generation: g });
    r.assertSeedsOpen = () => {};
    return { world, r };
  }

  test('ORIGIN-02 (the PoC, now refused): a premium lock pending at every seal no longer keeps the extension from being signed', async () => {
    const { world, r } = await chained();
    for (let i = 0n; i < 6n; i += 1n) {
      world.at(E + i, 0.6);
      r.addPending({ kind: 'premium', leaf: keccak256(toUtf8Bytes(`lock-${i}`)), lotId: keccak256(toUtf8Bytes(`lot-${i}`)), asset: ASSET, standIn: null });
      await r.tick();
    }
    assert.equal(world.relay.extensionAt, E + 4n + 6n, 'signed at leaf 4, as with nothing urgent');
    const kinds = Object.values(r.state.data.signed).map((x) => x.kind);
    assert.ok(kinds.includes('extension'));
  });

  for (const layout of ['pre-QL-06', 'V1']) {
    test(`ORIGIN-06 (the PoC, now refused): a forward root sealed ${layout === 'V1' ? 'with the V1 count leaf' : 'before the count leaf'} still proves its facts after the upgrade`, async () => {
      const world = new World();
      world.at(E + 1n, 0.6);
      const r = await world.relayer(tmpDir());
      const s = r.state.data;
      const notional = 10n ** 18n;
      const a = { asset: ASSET, escrow: ESCROW, depositor: '0x' + '0d'.repeat(20), boundQrlOwner: '0x' + '0b'.repeat(20), depositNonce: 1n, anchoredNotional: notional, epoch: E };
      const id = ids.stakeAssetId({ chainId: CHAIN_ID, ...a });
      s.anchors[id] = a;
      const leaf = ids.stakeLeafKey(ESCROW, id, notional);
      const { AbiCoder } = require('ethers');
      const v1 = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [ids.STAKE_DOMAIN, keccak256(toUtf8Bytes('ARK_STAKE_ANCHOR_COUNT_V1')), E, 1n]));
      const oldRoot = buildTree(layout === 'V1' ? [leaf, v1] : [leaf]).root;
      s.forward[String(E)] = { items: [{ kind: 'anchor', id, leaf, applied: null }], root: oldRoot, sealed: true };
      s.forwardFrom = String(E);
      s.origin.scannedTs = world.clock.endOf(E);
      world.attestation.set(E, oldRoot);
      r.migrateForwardCounts();
      assert.equal(s.forward[String(E)].countLeaf, layout === 'V1' ? v1 : null, 'the layout it was sealed with is recorded');
      await r.tick({ seal: false });
      assert.equal(world.anchors.has(id), true, 'the anchor is recorded on QRL');
      assert.equal(s.forward[String(E)].items[0].applied, 'recorded');
    });
  }
});
