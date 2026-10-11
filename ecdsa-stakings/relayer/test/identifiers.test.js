/**
 * The cross-chain preimages, checked against themselves.
 *
 * Agreement with the two contracts is a separate test and lives in
 * test/ArkStakeRelayMerkle.test.js, because it needs compiled artifacts. What is
 * checked here is the structure the contracts cannot check for us: that the
 * beneficiary and the chain id are inside the identifier, that the domain tag
 * separates the two products, and that a substituted recipient is a different
 * leaf.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const ids = require('../lib/identifiers');

const ASSET = `0x${'aa'.repeat(20)}`;
const ALICE = `0x${'44'.repeat(20)}`;
const BOB = `0x${'55'.repeat(20)}`;
const QRL_OWNER = `Q${'66'.repeat(20)}`;
const NOTIONAL = 100n * 10n ** 18n;
/** The escrow every leaf binds (D10), and another of the same relay. */
const ESCROW = `0x${'e5'.repeat(20)}`;
const OTHER_ESCROW = `0x${'e6'.repeat(20)}`;

const base = {
  chainId: 1n,
  asset: ASSET,
  depositor: ALICE,
  boundQrlOwner: QRL_OWNER,
  depositNonce: 0n,
};

describe('the cross-chain identifiers', () => {
  test('the domain tag is the hash of the string it claims to be', () => {
    assert.equal(ids.STAKE_DOMAIN, keccak256(toUtf8Bytes('ARK_STAKE_V1')));
  });

  test('a different beneficiary is a different position, not a rewritten one', () => {
    // whitepaper §3.2. This is the whole of the entitlement guarantee: an
    // adversary holding every origin-chain key has no field to change.
    const mine = ids.stakeAssetId(base);
    const theirs = ids.stakeAssetId({ ...base, boundQrlOwner: `Q${'77'.repeat(20)}` });
    assert.notEqual(mine, theirs);
  });

  test('the same asset on two chains is two positions', () => {
    assert.notEqual(ids.stakeAssetId(base), ids.stakeAssetId({ ...base, chainId: 8453n }));
    assert.notEqual(ids.assetKey(1n, ASSET), ids.assetKey(8453n, ASSET));
  });

  test('a repeated deposit by one depositor is a different position', () => {
    assert.notEqual(ids.stakeAssetId(base), ids.stakeAssetId({ ...base, depositNonce: 1n }));
  });

  test('an identifier does not depend on how an address was written down', () => {
    // A mis-cased address here yields an identifier corresponding to no
    // position, which is a correctness bug and not a formatting one.
    const asQ = ids.stakeAssetId({ ...base, boundQrlOwner: QRL_OWNER });
    const asHex = ids.stakeAssetId({ ...base, boundQrlOwner: `0x${'66'.repeat(20)}` });
    const asUpper = ids.stakeAssetId({ ...base, boundQrlOwner: QRL_OWNER.toUpperCase() });
    assert.equal(asQ, asHex);
    assert.equal(asQ, asUpper);
  });

  test('an anchoring leaf does not verify as an insurance claim leaf', () => {
    // whitepaper §3.5. Without the domain tag a root sealed to record an
    // anchoring would also satisfy the insurance claim path and authorise an
    // indemnity against an attestation that was never about a loss.
    const id = ids.stakeAssetId(base);
    assert.notEqual(ids.stakeLeafKey(ESCROW, id, NOTIONAL), ids.insuranceLeafKey(id, NOTIONAL));
  });

  test('a leaf commits to the notional, so a restated amount is a different leaf', () => {
    const id = ids.stakeAssetId(base);
    assert.notEqual(ids.stakeLeafKey(ESCROW, id, NOTIONAL), ids.stakeLeafKey(ESCROW, id, NOTIONAL + 1n));
  });

  test('a proof is consumed against the epoch and the leaf together', () => {
    const leaf = ids.stakeLeafKey(ESCROW, ids.stakeAssetId(base), NOTIONAL);
    assert.notEqual(ids.spendKey(2810n, leaf), ids.spendKey(2811n, leaf));
  });

  test('substituting the recipient produces a different leaf', () => {
    // whitepaper §3.5. The destination is committed on QRL before any
    // origin-chain transaction carrying it exists, so an observer resubmitting
    // at a higher fee with another destination has no membership proof.
    const id = ids.stakeAssetId(base);
    const mine = ids.releaseLeaf(ESCROW, 
      ids.releasePayload({ id, recipient: ALICE, claimNonce: 1n, chainId: 1n }),
    );
    const theirs = ids.releaseLeaf(ESCROW, 
      ids.releasePayload({ id, recipient: BOB, claimNonce: 1n, chainId: 1n }),
    );
    assert.notEqual(mine, theirs);
  });

  test('a release receipt sealed for another chain does not name this position', () => {
    const id = ids.stakeAssetId(base);
    const here = ids.releasePayload({ id, recipient: ALICE, claimNonce: 1n, chainId: 1n });
    const elsewhere = ids.releasePayload({ id, recipient: ALICE, claimNonce: 1n, chainId: 8453n });
    assert.notEqual(here, elsewhere);
  });

  test('every domain literal is the hash of the string it claims to be', () => {
    for (const [name, [preimage, literal]] of Object.entries(ids.DOMAINS)) {
      assert.equal(literal, keccak256(toUtf8Bytes(preimage)), name);
      assert.equal(ids[name], literal, name);
    }
  });

  test('applying and lifting the freeze are different leaves', () => {
    // Otherwise a proof sealed to lift a freeze would also apply one.
    assert.notEqual(ids.freezeLeaf(1n, ESCROW, true), ids.freezeLeaf(1n, ESCROW, false));
  });

  test('a control leaf for one chain does not act on another', () => {
    assert.notEqual(ids.closeLeaf(1n, ESCROW), ids.closeLeaf(8453n, ESCROW));
    assert.notEqual(ids.freezeLeaf(1n, ESCROW, true), ids.freezeLeaf(8453n, ESCROW, true));
    assert.notEqual(ids.delistLeaf(1n, ESCROW, ASSET), ids.delistLeaf(8453n, ESCROW, ASSET));
  });

  test('a de-listing names one asset and closes no other', () => {
    assert.notEqual(ids.delistLeaf(1n, ESCROW, ASSET), ids.delistLeaf(1n, ESCROW, ALICE));
  });

  test('a premium offer commits to the chain, the asset, the epoch and the shares held', () => {
    const o = { chainId: 1n, escrow: ESCROW, asset: ASSET, epoch: 2810n, shares: NOTIONAL, units: NOTIONAL + 5n };
    const base = ids.premiumOfferLeaf(o);
    for (const change of [{ chainId: 8453n }, { escrow: OTHER_ESCROW }, { asset: ALICE }, { epoch: 2811n }, { shares: NOTIONAL + 1n }, { units: NOTIONAL }]) {
      assert.notEqual(ids.premiumOfferLeaf({ ...o, ...change }), base, Object.keys(change)[0]);
    }
  });

  test('a buffer report commits to the chain, the asset, the epoch and the units held', () => {
    const b = { chainId: 1n, escrow: ESCROW, asset: ASSET, epoch: 2810n, units: NOTIONAL };
    const base = ids.bufferLeaf(b);
    for (const change of [{ chainId: 8453n }, { escrow: OTHER_ESCROW }, { asset: ALICE }, { epoch: 2811n }, { units: NOTIONAL + 1n }]) {
      assert.notEqual(ids.bufferLeaf({ ...b, ...change }), base, Object.keys(change)[0]);
    }
    // A buffer report is never an offer of the same quantity.
    assert.notEqual(base, ids.premiumOfferLeaf({ ...b, shares: NOTIONAL }));
  });

  test('a premium lock commits to the lot, the hashlock, the solver, the shares, the expiry, the offered epoch and the bond', () => {
    // A claim naming any other recipient, share count or expiry has no proof,
    // so each is inside the leaf; the lot id ties it to one QRL lock.
    const w = { chainId: 1n, escrow: ESCROW, asset: ASSET, lotId: '0x' + '31'.repeat(32), hashlock: ids.hashlockOf('0x' + '01'.repeat(32)), recipient: BOB, shares: NOTIONAL, evmExpiry: 1_700_000_000n, epoch: 2810n, bond: NOTIONAL / 40n };
    const base = ids.premiumLockLeaf(w);
    for (const change of [
      { recipient: ALICE },
      { shares: NOTIONAL + 1n },
      { evmExpiry: 1_700_000_001n },
      { lotId: '0x' + '32'.repeat(32) },
      { hashlock: ids.hashlockOf('0x' + '02'.repeat(32)) },
      { asset: ALICE },
      { escrow: OTHER_ESCROW },
      { chainId: 8453n },
      { epoch: 2811n },
      { bond: NOTIONAL / 40n + 1n },
    ]) {
      assert.notEqual(ids.premiumLockLeaf({ ...w, ...change }), base, Object.keys(change)[0]);
    }
  });

  test('the hashlock is sha256 of the 32-byte preimage, the hash QuantaSwap locks under', () => {
    assert.equal(
      ids.hashlockOf('0x' + '00'.repeat(32)),
      '0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
  });

  test('the allocation leaf commits to every transmitted rate and its epoch', () => {
    const a = { escrow: ESCROW, epoch: 2810n, sigmaBps: 3000, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 2000, levyBps: 200, sigmaTargetBps: 3000, coveredBps: 10000, psrCapBps: 11100, commitTermEpochs: 13 };
    const base = ids.allocationLeaf(a);
    for (const change of [
      { escrow: OTHER_ESCROW },
      { epoch: 2811n },
      { sigmaBps: 2999 },
      { bufferBps: 251 },
      { operationsBps: 251 },
      { jurorFeeShareBps: 0 },
      { levyBps: 0 },
      { sigmaTargetBps: 2500 },
      { coveredBps: 9999 },
      { psrCapBps: 11101 },
      { commitTermEpochs: 12 },
    ]) {
      assert.notEqual(ids.allocationLeaf({ ...a, ...change }), base);
    }
  });

  test('a completed release names one release of one position', () => {
    const id = ids.stakeAssetId(base);
    assert.notEqual(ids.releasedLeaf(ESCROW, id, 1n), ids.releasedLeaf(ESCROW, id, 2n));
    assert.notEqual(ids.releasedLeaf(ESCROW, id, 1n), ids.releaseLeaf(ESCROW, ids.releasePayload({ id, recipient: ALICE, claimNonce: 1n, chainId: 1n })));
  });

  test('a root message binds the chain, the relay, the epoch, the root and its leaf count (OL-01)', () => {
    const m = { chainId: 1n, relay: ALICE, epoch: 2810n, epochRoot: keccak256(toUtf8Bytes('r')), leafCount: 3 };
    const baseMsg = ids.rootMessage(m);
    for (const change of [{ chainId: 8453n }, { relay: BOB }, { epoch: 2811n }, { epochRoot: keccak256(toUtf8Bytes('s')) }, { leafCount: 2 }]) {
      assert.notEqual(ids.rootMessage({ ...m, ...change }), baseMsg);
    }
  });

  test('a release leaf is not an anchoring leaf, though both carry the domain tag', () => {
    const id = ids.stakeAssetId(base);
    const payload = ids.releasePayload({ id, recipient: ALICE, claimNonce: 1n, chainId: 1n });
    assert.notEqual(ids.releaseLeaf(ESCROW, payload), ids.stakeLeafKey(ESCROW, id, NOTIONAL));
  });

  test('a loss settlement commits to the determination, the position, the destination and the quantity', () => {
    // whitepaper §3.5: a payment naming any other quantity, source or
    // destination fails, so each is inside the leaf.
    const l = {
      chainId: 1n,
      escrow: ESCROW,
      determinationId: keccak256(toUtf8Bytes('determination-1')),
      stakeAssetId: ids.stakeAssetId(base),
      destination: BOB,
      quantity: NOTIONAL,
    };
    const leaf = ids.lossLeaf(l);
    for (const change of [
      { chainId: 8453n },
      { escrow: OTHER_ESCROW },
      { determinationId: keccak256(toUtf8Bytes('determination-2')) },
      { stakeAssetId: ids.stakeAssetId({ ...base, depositNonce: 1n }) },
      { destination: ALICE },
      { quantity: NOTIONAL + 1n },
    ]) {
      assert.notEqual(ids.lossLeaf({ ...l, ...change }), leaf);
    }
  });

  test('a recovery share commits to the recovery, the recipient, the destination and the quantity', () => {
    const r = {
      chainId: 1n,
      escrow: ESCROW,
      successorId: keccak256(toUtf8Bytes('successor-1')),
      recoveryId: keccak256(toUtf8Bytes('recovery-1')),
      recipient: keccak256(toUtf8Bytes('holder-1')),
      destination: BOB,
      quantity: NOTIONAL,
    };
    const leaf = ids.shareLeaf(r);
    for (const change of [
      { chainId: 8453n },
      { escrow: OTHER_ESCROW },
      { successorId: keccak256(toUtf8Bytes('successor-2')) },
      { recoveryId: keccak256(toUtf8Bytes('recovery-2')) },
      { recipient: keccak256(toUtf8Bytes('holder-2')) },
      { destination: ALICE },
      { quantity: NOTIONAL + 1n },
    ]) {
      assert.notEqual(ids.shareLeaf({ ...r, ...change }), leaf);
    }
  });

  test('a loss settlement and a recovery share over the same words are different leaves', () => {
    // The two preimages have the same shape — a tag, the chain, a bytes32, a
    // bytes32, an address and a quantity — so only the tag separates them.
    const a = keccak256(toUtf8Bytes('a'));
    const b = keccak256(toUtf8Bytes('b'));
    assert.notEqual(
      ids.lossLeaf({ chainId: 1n, escrow: ESCROW, determinationId: a, stakeAssetId: b, destination: BOB, quantity: NOTIONAL }),
      ids.shareLeaf({ chainId: 1n, escrow: ESCROW, recoveryId: a, recipient: b, destination: BOB, quantity: NOTIONAL }),
    );
  });

  test('the loss and recovery leaves are written under their own domain, as the yellow paper lists them', () => {
    // yellow paper §2.2: `keccak256(abi.encode(LOSS_DOMAIN, chainId, ...))`, with
    // no STAKE_DOMAIN in front. The registry seals exactly that.
    const { AbiCoder } = require('ethers');
    const d = keccak256(toUtf8Bytes('d'));
    const id = ids.stakeAssetId(base);
    const expected = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'address', 'uint256'],
        [keccak256(toUtf8Bytes('ARK_LOSS_V1')), 1n, ESCROW, d, id, BOB, 5n],
      ),
    );
    assert.equal(ids.lossLeaf({ chainId: 1n, escrow: ESCROW, determinationId: d, stakeAssetId: id, destination: BOB, quantity: 5n }), expected);
  });

  test('D10: every leaf an escrow acts on or emits binds that escrow', () => {
    // yellow paper §2.2, I6: a leaf admitted for one escrow of a relay verifies
    // at no other. Each builder, over two escrows and otherwise the same words.
    const id = ids.stakeAssetId(base);
    const payload = ids.releasePayload({ id, recipient: ALICE, claimNonce: 1n, chainId: 1n });
    const q = { chainId: 1n, asset: ASSET, epoch: 2810n, shares: NOTIONAL, units: NOTIONAL };
    const alloc = { epoch: 2810n, sigmaBps: 3000, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 0, levyBps: 0, sigmaTargetBps: 0, coveredBps: 0, psrCapBps: 0, commitTermEpochs: 0 };
    const lock = { chainId: 1n, asset: ASSET, epoch: 5n, lotId: '0x' + '31'.repeat(32), hashlock: '0x' + '41'.repeat(32), recipient: BOB, shares: NOTIONAL, bond: 1n, evmExpiry: 9n };
    const loss = { chainId: 1n, determinationId: keccak256(toUtf8Bytes('d')), stakeAssetId: id, destination: BOB, quantity: NOTIONAL };
    const share = { chainId: 1n, recoveryId: keccak256(toUtf8Bytes('r')), recipient: keccak256(toUtf8Bytes('h')), destination: BOB, quantity: NOTIONAL };
    const builders = {
      stakeLeafKey: (e) => ids.stakeLeafKey(e, id, NOTIONAL),
      releaseLeaf: (e) => ids.releaseLeaf(e, payload),
      releasedLeaf: (e) => ids.releasedLeaf(e, id, 1n),
      closeLeaf: (e) => ids.closeLeaf(1n, e),
      freezeLeaf: (e) => ids.freezeLeaf(1n, e, true),
      delistLeaf: (e) => ids.delistLeaf(1n, e, ASSET),
      premiumOfferLeaf: (e) => ids.premiumOfferLeaf({ ...q, escrow: e }),
      bufferLeaf: (e) => ids.bufferLeaf({ ...q, escrow: e }),
      premiumLockLeaf: (e) => ids.premiumLockLeaf({ ...lock, escrow: e }),
      allocationLeaf: (e) => ids.allocationLeaf({ ...alloc, escrow: e }),
      lossLeaf: (e) => ids.lossLeaf({ ...loss, escrow: e }),
      shareLeaf: (e) => ids.shareLeaf({ ...share, escrow: e }),
    };
    for (const [name, build] of Object.entries(builders)) assert.notEqual(build(ESCROW), build(OTHER_ESCROW), name);
  });

  test('I36: a share defaults to the origin chain as its successor state, and a successor is part of the leaf', () => {
    const r = { chainId: 1n, escrow: ESCROW, recoveryId: keccak256(toUtf8Bytes('r')), recipient: keccak256(toUtf8Bytes('h')), destination: BOB, quantity: NOTIONAL };
    assert.equal(ids.shareLeaf(r), ids.shareLeaf({ ...r, successorId: '0x' + '00'.repeat(32) }));
    assert.notEqual(ids.shareLeaf(r), ids.shareLeaf({ ...r, successorId: keccak256(toUtf8Bytes('fork')) }));
  });

  test('the authority chain: an extension and a cancellation are different messages, and each binds the link', () => {
    const m = { chainId: 1n, relay: ALICE, epoch: 2810n, nextGeneration: 2, link: keccak256(toUtf8Bytes('l')) };
    assert.notEqual(ids.extensionMessage(m), ids.cancelMessage(m));
    // V2 (PV-18): the riding root and its count are part of the message.
    for (const change of [{ chainId: 8453n }, { relay: BOB }, { epoch: 2811n }, { nextGeneration: 3 }, { link: keccak256(toUtf8Bytes('k')) }, { epochRoot: keccak256(toUtf8Bytes('root')) }, { leafCount: 3 }]) {
      assert.notEqual(ids.extensionMessage({ ...m, ...change }), ids.extensionMessage(m), Object.keys(change)[0]);
    }
    // Four generations: each commitment is the link of the next, the last the terminal one.
    const gens = [1, 2, 3, 4].map((g) => [keccak256(toUtf8Bytes(`g${g}a`)), keccak256(toUtf8Bytes(`g${g}b`))]);
    const commits = ids.chainCommits(gens);
    assert.equal(commits[3], ids.TERMINAL_COMMIT);
    for (let g = 0; g < 3; g += 1) assert.equal(commits[g], ids.chainLink(gens[g + 1], commits[g + 1]));
  });
});
