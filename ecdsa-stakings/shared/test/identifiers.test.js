/**
 * The three implementations of the cross-chain preimages, compared.
 *
 * The one rule this file exists to defend: **Hyperion on QRL, Solidity on the
 * origin chain and JavaScript in the relayer compute the same bytes.**
 *
 * A divergence between any two of them raises no error anywhere. It produces an
 * identifier corresponding to no position, or a proof that quietly fails to
 * verify, and the symptom appears as a stuck deposit rather than as a fault. So
 * the agreement is asserted over a table rather than trusted to three careful
 * transcriptions.
 *
 * Two `Chain` instances, one per build directory. That is not an artefact of the
 * harness — it is the shape of the thing being tested. The two legs share no
 * state and no value: what crosses between them is a hash and a Merkle proof,
 * and this file is the check that the crossing is well defined.
 *
 * The one-time signature that admits a root is checked here too, against the
 * verifier the relay links, because it is hashing only and runs on stock EVM
 * exactly as it runs on the origin chain. What the fiction still hides: both
 * chains are stock EVM in one process, so no account signature (secp256k1 or
 * ML-DSA-87) is made and nothing finalises. Those are exercised only on a real
 * network.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const { Chain, ACCOUNTS } = require('../../../test/harness');
const { deployParams } = require('../../../test/stake-fixture');
const { originChain, signerFor } = require('./helpers');

const ids = require('../../relayer/lib/identifiers');
const { buildTree, proofFor } = require('../../relayer/lib/merkle');
const epochLib = require('../../relayer/lib/epoch');
const wots = require('../../relayer/lib/wots');

const ONE = 10n ** 18n;
const PRICE_SCALE = 10n ** 18n;
const REF_PRICE = 10_000n * PRICE_SCALE;
const CHAIN_ID = 1n;
const ASSET_A = '0x' + 'aa'.repeat(20);
/** The escrow every leaf binds since D10 (2026-09-28), and a second one on the same relay. */
const ESCROW_A = '0x' + 'e5'.repeat(20);
const ESCROW_B = '0x' + 'e6'.repeat(20);
const ZERO32 = '0x' + '00'.repeat(32);
const GROUP_A = keccak256(toUtf8Bytes('group:lido-like'));

/** The QRL leg, as test/ArkStakeRegistry.test.js builds it. */
async function qrlLeg() {
  const chain = await Chain.create();
  const params = await deployParams(chain);
  const registry = await chain.deploy(
    'ArkStakeRegistry',
    ['address', 'address', 'address'],
    [ACCOUNTS.admin, params.address, ACCOUNTS.admin],
  );
  await params.send('setRegistry', [registry.address], { from: ACCOUNTS.admin });
  const attest = await chain.deploy('MockAttestation');
  const qday = await chain.deploy('MockQDayOracle');
  const oracle = await chain.deploy('MockPriceOracle');
  const bond = await chain.deploy('MockBond');
  const math = await chain.deploy('StakeMathHarness');

  await oracle.send('set', [REF_PRICE, REF_PRICE, REF_PRICE]);
  await bond.send('set', [10_000_000n * ONE]);
  await registry.send(
    'setDependencies',
    [attest.address, qday.address, oracle.address, bond.address],
    { from: ACCOUNTS.admin },
  );
  await registry.send(
    'admitAsset',
    [[CHAIN_ID, ASSET_A, GROUP_A, '0x' + '00'.repeat(20), 2500, 800, false, true, true]],
    { from: ACCOUNTS.admin },
  );
  return { chain, registry, attest, math };
}

/** The origin leg: the same libraries, compiled by solc. */
async function originLeg() {
  const chain = await originChain();
  return { chain, hash: await chain.deploy('ArkStakeIdsHarness') };
}

describe('the two chains and the relayer agree on every preimage', () => {
  let qrl;
  let origin;

  before(async () => {
    qrl = await qrlLeg();
    origin = await originLeg();
  });

  /**
   * A table rather than one case. A transcription error in an `abi.encode`
   * argument *type* is invisible for most values — a `uint64` and a `uint256`
   * pad to the same 32 bytes for a small nonce, and only a large one separates
   * them — so the extremes are here for that reason and not for coverage.
   */
  const rows = [
    { label: 'the modelled position', asset: ASSET_A, depositor: ACCOUNTS.alice, owner: ACCOUNTS.bob, nonce: 0n, notional: 100n * ONE },
    { label: 'a repeated deposit', asset: ASSET_A, depositor: ACCOUNTS.alice, owner: ACCOUNTS.bob, nonce: 1n, notional: 100n * ONE },
    { label: 'a nonce above 32 bits', asset: ASSET_A, depositor: ACCOUNTS.alice, owner: ACCOUNTS.bob, nonce: 2n ** 40n, notional: 1n },
    { label: 'the largest nonce a uint64 holds', asset: '0x' + 'bb'.repeat(20), depositor: ACCOUNTS.mallory, owner: ACCOUNTS.alice, nonce: 2n ** 64n - 1n, notional: 2n ** 128n },
    { label: 'the zero address as depositor', asset: ASSET_A, depositor: '0x' + '00'.repeat(20), owner: ACCOUNTS.guardian, nonce: 3n, notional: 5n },
  ];

  for (const row of rows) {
    test(`stakeAssetId agrees three ways on ${row.label}`, async () => {
      const args = [CHAIN_ID, row.asset, row.depositor, row.owner, row.nonce];
      const onQrl = await qrl.registry.call('stakeAssetId', args);
      const onOrigin = await origin.hash.call('stakeAssetId', args);
      const offChain = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      assert.equal(onOrigin, onQrl, 'Solidity disagrees with Hyperion');
      assert.equal(offChain, onQrl, 'the relayer disagrees with Hyperion');
    });

    test(`stakeLeafKey agrees three ways on ${row.label}`, async () => {
      const id = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      const onQrl = await qrl.math.call('stakeLeafKey', [ESCROW_A, id, row.notional]);
      assert.equal(await origin.hash.call('stakeLeafKey', [ESCROW_A, id, row.notional]), onQrl);
      assert.equal(ids.stakeLeafKey(ESCROW_A, id, row.notional), onQrl);
      assert.notEqual(ids.stakeLeafKey(ESCROW_B, id, row.notional), onQrl, 'D10: the anchor leaf binds its escrow');
    });

    test(`the release payload and leaf agree three ways on ${row.label}`, async () => {
      const id = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      const args = [id, row.owner, 1n, CHAIN_ID];
      const onQrl = await qrl.math.call('releasePayload', args);
      assert.equal(await origin.hash.call('releasePayload', args), onQrl);
      assert.equal(
        ids.releasePayload({ id, recipient: row.owner, claimNonce: 1n, chainId: CHAIN_ID }),
        onQrl,
      );

      const leafOnQrl = await qrl.math.call('releaseLeaf', [ESCROW_A, onQrl]);
      assert.equal(await origin.hash.call('releaseLeaf', [ESCROW_A, onQrl]), leafOnQrl);
      assert.equal(ids.releaseLeaf(ESCROW_A, onQrl), leafOnQrl);
      assert.notEqual(ids.releaseLeaf(ESCROW_B, onQrl), leafOnQrl, 'D10: a receipt binds the escrow that pays it');
    });
  }

  test('assetKey agrees three ways, including across two chains', async () => {
    for (const chainId of [1n, 8453n, 2n ** 64n]) {
      const onQrl = await qrl.registry.call('assetKey', [chainId, ASSET_A]);
      assert.equal(await origin.hash.call('assetKey', [chainId, ASSET_A]), onQrl);
      assert.equal(ids.assetKey(chainId, ASSET_A), onQrl);
    }
  });

  test('spendKey agrees three ways, so a proof is consumed against one pair', async () => {
    const leaf = keccak256(toUtf8Bytes('some-leaf'));
    for (const epoch of [0n, 2810n, 2n ** 64n]) {
      const onQrl = await qrl.math.call('spendKey', [epoch, leaf]);
      assert.equal(await origin.hash.call('spendKey', [epoch, leaf]), onQrl);
      assert.equal(ids.spendKey(epoch, leaf), onQrl);
    }
  });

  test('the domain tag is one constant on all three sides', async () => {
    const onQrl = await qrl.registry.call('STAKE_DOMAIN');
    assert.equal(await origin.hash.call('stakeDomain'), onQrl);
    assert.equal(ids.STAKE_DOMAIN, onQrl);
    assert.equal(onQrl, keccak256(toUtf8Bytes('ARK_STAKE_V1')));
  });

  test('the allocation and released tags are one constant on all three sides', async () => {
    const domains = await origin.hash.call('domains');
    assert.equal(await qrl.registry.call('ALLOCATION_DOMAIN'), ids.ALLOCATION_DOMAIN);
    assert.equal(domains[8], ids.ALLOCATION_DOMAIN);
    assert.equal(await qrl.registry.call('RELEASED_DOMAIN'), ids.RELEASED_DOMAIN);
    assert.equal(domains[7], ids.RELEASED_DOMAIN);
  });

  /**
   * The allocation leaf is the one message whose rates are computed on QRL and
   * enforced on the origin chain, so a disagreement would leave every epoch's
   * premium unrecordable — and the escrow would then charge none, silently.
   */
  const V3 = (o) => ({ levyBps: 0, sigmaTargetBps: 0, coveredBps: 0, psrCapBps: 0, commitTermEpochs: 0, stepQueued: false, ...o });
  const allocations = [
    ['the reference allocation', V3({ epoch: 2810n, sigmaBps: 1850, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 2000, levyBps: 200, sigmaTargetBps: 1850, coveredBps: 10000, psrCapBps: 11100, commitTermEpochs: 13 })],
    ['no cover sold', V3({ epoch: 0n, sigmaBps: 0, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 0 })],
    ['every share at its ceiling', V3({ epoch: 2n ** 64n, sigmaBps: 4000, bufferBps: 1500, operationsBps: 1000, jurorFeeShareBps: 5000, levyBps: 500, sigmaTargetBps: 4000, coveredBps: 10000, psrCapBps: 25800, commitTermEpochs: 26 })],
    ['the largest uint16 in every field, a step queued', { epoch: 1n, ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, f === 'stepQueued' ? true : 65535])) }],
    ['a step queued (V4, QL-25)', V3({ epoch: 7n, sigmaBps: 1850, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 2000, stepQueued: true })],
  ];
  /** The QRL side's Allocation struct: staker first, then the leaf's fields in their order. */
  const qrlAllocation = (a) => [0, a.sigmaBps, a.bufferBps, a.operationsBps, a.jurorFeeShareBps, a.levyBps, a.sigmaTargetBps, a.coveredBps, a.psrCapBps, a.commitTermEpochs, Boolean(a.stepQueued)];
  for (const [label, a] of allocations) {
    test(`allocationLeaf agrees three ways on ${label}`, async () => {
      const onQrl = await qrl.math.call('allocationLeaf', [ESCROW_A, a.epoch, qrlAllocation(a)]);
      const rates = ids.ALLOCATION_FIELDS.map((f) => (f === 'stepQueued' ? Boolean(a[f]) : a[f]));
      assert.equal(await origin.hash.call('allocationLeaf', [ESCROW_A, a.epoch, rates]), onQrl, 'Solidity disagrees with Hyperion');
      assert.equal(ids.allocationLeaf({ escrow: ESCROW_A, ...a }), onQrl, 'the relayer disagrees with Hyperion');
      assert.notEqual(ids.allocationLeaf({ escrow: ESCROW_B, ...a }), onQrl, 'D10: one allocation leaf per escrow');
    });
  }

  test('the registry seals the V3 allocation leaf of its own allocation, per escrow, the levy and the commitment terms included', async () => {
    const [epoch, leaf] = await qrl.registry.call('currentAllocationLeaf', [ESCROW_A]);
    const a = await qrl.registry.call('allocation');
    const values = { escrow: ESCROW_A, epoch, ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, Number(f === 'sigmaBps' ? a.premiumBps : a[f])])) };
    assert.equal(ids.allocationLeaf(values), leaf);
    assert.notEqual((await qrl.registry.call('currentAllocationLeaf', [ESCROW_B]))[1], leaf);
    assert.equal(values.levyBps, 200, 'the levy in force below stage 4');
    assert.equal(values.commitTermEpochs, 13);
  });

  test('the loss and recovery tags are one constant on all three sides', async () => {
    const domains = await origin.hash.call('domains');
    assert.equal(await qrl.math.call('lossDomain'), ids.LOSS_DOMAIN);
    assert.equal(domains[9], ids.LOSS_DOMAIN);
    assert.equal(ids.LOSS_DOMAIN, keccak256(toUtf8Bytes('ARK_LOSS_V1')));
    assert.equal(await qrl.math.call('recoveryDomain'), ids.RECOVERY_DOMAIN);
    assert.equal(domains[10], ids.RECOVERY_DOMAIN);
    assert.equal(ids.RECOVERY_DOMAIN, keccak256(toUtf8Bytes('ARK_RECOVERY_V1')));
  });

  /**
   * The two messages that name a quantity. The registry seals them and the
   * escrow pays on them, so a disagreement is a determined settlement that no
   * proof can ever carry. The extremes separate a mistyped width: a quantity
   * above 2^128 and a chain id above 2^64 are where a uint128 or a uint64 in
   * one transcription would part from the uint256 in the other.
   */
  const settlements = [
    ['the modelled settlement', { chainId: CHAIN_ID, quantity: 25n * ONE, dest: ACCOUNTS.bob }],
    ['one wei', { chainId: CHAIN_ID, quantity: 1n, dest: ACCOUNTS.alice }],
    ['a quantity above 2^128 on a chain id above 2^64', { chainId: 2n ** 64n + 1n, quantity: 2n ** 200n, dest: ACCOUNTS.mallory }],
  ];
  for (const [label, row] of settlements) {
    test(`lossLeaf agrees three ways on ${label}`, async () => {
      const determinationId = keccak256(toUtf8Bytes(`determination:${label}`));
      const id = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: ASSET_A,
        depositor: ACCOUNTS.alice,
        boundQrlOwner: ACCOUNTS.bob,
        depositNonce: 0n,
      });
      const args = [row.chainId, ESCROW_A, determinationId, id, row.dest, row.quantity];
      const onQrl = await qrl.math.call('lossLeaf', args);
      assert.equal(await origin.hash.call('lossLeaf', args), onQrl, 'Solidity disagrees with Hyperion');
      assert.notEqual(await origin.hash.call('lossLeaf', [row.chainId, ESCROW_B, ...args.slice(2)]), onQrl, 'D10');
      assert.equal(
        ids.lossLeaf({
          chainId: row.chainId,
          escrow: ESCROW_A,
          determinationId,
          stakeAssetId: id,
          destination: row.dest,
          quantity: row.quantity,
        }),
        onQrl,
        'the relayer disagrees with Hyperion',
      );
    });

    test(`shareLeaf agrees three ways on ${label}`, async () => {
      const recoveryId = keccak256(toUtf8Bytes(`recovery:${label}`));
      const recipient = keccak256(toUtf8Bytes(`holder:${label}`));
      for (const successorId of [ZERO32, keccak256(toUtf8Bytes(`successor:${label}`))]) {
        const args = [row.chainId, ESCROW_A, successorId, recoveryId, recipient, row.dest, row.quantity];
        const onQrl = await qrl.math.call('shareLeaf', args);
        assert.equal(await origin.hash.call('shareLeaf', args), onQrl, 'Solidity disagrees with Hyperion');
        assert.equal(
          ids.shareLeaf({ chainId: row.chainId, escrow: ESCROW_A, successorId, recoveryId, recipient, destination: row.dest, quantity: row.quantity }),
          onQrl,
          'the relayer disagrees with Hyperion',
        );
        assert.notEqual(await origin.hash.call('shareLeaf', [row.chainId, ESCROW_B, ...args.slice(2)]), onQrl, 'D10');
      }
      // I36: one share on two successor states is two leaves.
      assert.notEqual(
        ids.shareLeaf({ chainId: row.chainId, escrow: ESCROW_A, successorId: ZERO32, recoveryId, recipient, destination: row.dest, quantity: row.quantity }),
        ids.shareLeaf({ chainId: row.chainId, escrow: ESCROW_A, successorId: keccak256(toUtf8Bytes('fork')), recoveryId, recipient, destination: row.dest, quantity: row.quantity }),
      );
    });
  }

  /**
   * The QIP-55 width. On this harness the Hyperion registry is compiled by
   * the v2 line, whose `address` holds 20 bytes, so a 64-byte owner cannot
   * reach it here: this agreement is two ways — the relayer's transcription
   * against the Solidity library — and the Hyperion side of the same rule
   * (`EvmWords.ownerWords`) is proven against the v3 chain, not here.
   */
  test('stakeAssetId agrees two ways on a 64-byte QIP-55 owner', async () => {
    const owner128 = 'Q' + 'ab'.repeat(32) + 'cd'.repeat(32);
    const onOrigin = await origin.hash.call('stakeAssetId', [
      CHAIN_ID, ASSET_A, ACCOUNTS.alice, '0x' + 'ab'.repeat(32) + 'cd'.repeat(32), 7n,
    ]);
    assert.equal(
      ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: ASSET_A,
        depositor: ACCOUNTS.alice,
        boundQrlOwner: owner128,
        depositNonce: 7n,
      }),
      onOrigin,
    );
    // The two widths can never collide: they differ in the high word.
    const words = await origin.hash.call('qrlOwnerWords', ['0x' + 'ab'.repeat(32) + 'cd'.repeat(32)]);
    assert.equal(words[0], '0x' + 'ab'.repeat(32));
    assert.equal(words[1], '0x' + 'cd'.repeat(32));
    const legacy = await origin.hash.call('qrlOwnerWords', ['0x' + '66'.repeat(20)]);
    assert.equal(legacy[0], '0x' + '00'.repeat(32));
    assert.equal(legacy[1], '0x' + '00'.repeat(12) + '66'.repeat(20));
  });

test('seedReturnLeaf agrees three ways, and binds the chain, the escrow and the epoch (PV-17)', async () => {
    const escrow = '0x' + 'e5'.repeat(20);
    for (const [chainId, epoch] of [[1n, 0n], [CHAIN_ID, 2810n], [8453n, 2n ** 64n - 1n]]) {
      const onQrl = await qrl.math.call('seedReturnLeaf', [chainId, escrow, epoch]);
      assert.equal(await origin.hash.call('seedReturnLeaf', [chainId, escrow, epoch]), onQrl);
      assert.equal(ids.seedReturnLeaf(chainId, escrow, epoch), onQrl);
    }
    const base = ids.seedReturnLeaf(CHAIN_ID, escrow, 2810n);
    assert.notEqual(ids.seedReturnLeaf(CHAIN_ID, escrow, 2811n), base, 'another epoch');
    assert.notEqual(ids.seedReturnLeaf(CHAIN_ID, '0x' + 'e6'.repeat(20), 2810n), base, 'another escrow');
    assert.notEqual(ids.seedReturnLeaf(8453n, escrow, 2810n), base, 'another chain');
    // Not the close leaf's word with an epoch appended, nor any other kind's.
    assert.notEqual(base, ids.closeLeaf(CHAIN_ID, escrow));
  });

  test('anchorCountLeaf agrees three ways, so a forward root says how many deposits it proves (QL-05, QL-06)', async () => {
    for (const [epoch, count] of [[0n, 0n], [2810n, 1n], [2n ** 64n - 1n, 2n ** 32n]]) {
      const onQrl = await qrl.math.call('anchorCountLeaf', [epoch, count]);
      assert.equal(await origin.hash.call('anchorCountLeaf', [epoch, count]), onQrl);
      assert.equal(ids.anchorCountLeaf({ epoch, count }), onQrl);
    }
    assert.notEqual(ids.anchorCountLeaf({ epoch: 1n, count: 0n }), ids.anchorCountLeaf({ epoch: 1n, count: 1n }));
  });

  test('bufferLeaf agrees three ways, so QRL can learn the buffer that stands beside bond principal', async () => {
    // Whitepaper §4.3: buffer_orig enters the denominator of utilisation on
    // QRL; the escrow states it, the relayer carries it, the registry proves it.
    assert.equal(await qrl.registry.call('BUFFER_DOMAIN'), ids.BUFFER_DOMAIN);
    for (const [chainId, epoch, units] of [[1n, 0n, 1n], [CHAIN_ID, 2810n, 37n * ONE], [8453n, 2n ** 64n - 1n, 2n ** 200n]]) {
      // Built by ArkStakeLeaves since phase C3b (the registry's v3 bytes); the harness exposes it.
      const onQrl = await qrl.math.call('bufferLeaf', [chainId, ESCROW_A, ASSET_A, epoch, units]);
      assert.equal(await origin.hash.call('bufferLeaf', [chainId, ESCROW_A, ASSET_A, epoch, units]), onQrl);
      assert.equal(ids.bufferLeaf({ chainId, escrow: ESCROW_A, asset: ASSET_A, epoch, units }), onQrl);
      assert.notEqual(ids.bufferLeaf({ chainId, escrow: ESCROW_B, asset: ASSET_A, epoch, units }), onQrl);
    }
  });

  test('releasedLeaf agrees three ways, so QRL can learn a release completed', async () => {
    for (const row of rows) {
      const id = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      for (const nonce of [1n, 2n ** 64n - 1n]) {
        const onQrl = await qrl.math.call('releasedLeaf', [ESCROW_A, id, nonce]);
        assert.equal(await origin.hash.call('releasedLeaf', [ESCROW_A, id, nonce]), onQrl);
        assert.equal(ids.releasedLeaf(ESCROW_A, id, nonce), onQrl);
      }
    }
  });
});

describe('the origin chain and the relayer agree on the messages only the origin chain reads', () => {
  // Root messages and the control leaves are built on QRL by the attester
  // quorum and checked only here. The registry does not compute them, so this
  // agreement is two ways: the relayer's transcription against the Solidity
  // the relay and the escrow link. The two premium swap leaves are computed by
  // PremiumSwap on QRL too; test/PremiumSwap.test.js holds the third
  // side to them.
  let origin;
  before(async () => {
    origin = await originLeg();
  });

  const NAMES = [
    'STAKE_DOMAIN',
    'ROOT_DOMAIN',
    'CLOSE_DOMAIN',
    'FREEZE_DOMAIN',
    'DELIST_DOMAIN',
    'OFFER_DOMAIN',
    'PREMIUM_DOMAIN',
    'RELEASED_DOMAIN',
    'ALLOCATION_DOMAIN',
    'LOSS_DOMAIN',
    'RECOVERY_DOMAIN',
    'BUFFER_DOMAIN',
    'EXTENSION_DOMAIN',
    'CANCEL_DOMAIN',
    'ANCHOR_COUNT_DOMAIN',
    'SEED_RETURN_DOMAIN',
  ];

  test('every domain tag is the hash of its string on both sides, and no two kinds share one', async () => {
    const onChain = await origin.hash.call('domains');
    NAMES.forEach((name, i) => {
      assert.equal(onChain[i], ids[name], name);
      assert.equal(onChain[i], keccak256(toUtf8Bytes(ids.DOMAINS[name][0])), name);
    });
    assert.equal(new Set(NAMES.map((n) => ids[n])).size, NAMES.length);
  });

  test('rootMessage agrees, and binds the chain, the relay and the leaf count (OL-01)', async () => {
    const relay = '0x' + 'cd'.repeat(20);
    const root = keccak256(toUtf8Bytes('root'));
    for (const [chainId, epoch, leafCount] of [[1n, 2810n, 1n], [8453n, 2n ** 64n - 1n, 2n ** 32n - 1n]]) {
      assert.equal(
        await origin.hash.call('rootMessage', [chainId, relay, epoch, root, leafCount]),
        ids.rootMessage({ chainId, relay, epoch, epochRoot: root, leafCount }),
      );
    }
    assert.notEqual(
      ids.rootMessage({ chainId: 1n, relay, epoch: 1n, epochRoot: root, leafCount: 1 }),
      ids.rootMessage({ chainId: 1n, relay: '0x' + 'ce'.repeat(20), epoch: 1n, epochRoot: root, leafCount: 1 }),
    );
    assert.notEqual(
      ids.rootMessage({ chainId: 1n, relay, epoch: 1n, epochRoot: root, leafCount: 2 }),
      ids.rootMessage({ chainId: 1n, relay, epoch: 1n, epochRoot: root, leafCount: 4 }),
      'the count is signed',
    );
    assert.throws(() => ids.rootMessage({ chainId: 1n, relay, epoch: 1n, epochRoot: root }), /leaf count/);
  });

  test('closeLeaf, freezeLeaf and delistLeaf agree, and each binds its escrow', async () => {
    for (const chainId of [1n, 8453n]) {
      assert.equal(await origin.hash.call('closeLeaf', [chainId, ESCROW_A]), ids.closeLeaf(chainId, ESCROW_A));
      assert.notEqual(ids.closeLeaf(chainId, ESCROW_B), ids.closeLeaf(chainId, ESCROW_A));
      for (const frozen of [true, false]) {
        assert.equal(await origin.hash.call('freezeLeaf', [chainId, ESCROW_A, frozen]), ids.freezeLeaf(chainId, ESCROW_A, frozen));
        assert.notEqual(ids.freezeLeaf(chainId, ESCROW_B, frozen), ids.freezeLeaf(chainId, ESCROW_A, frozen));
      }
      assert.equal(await origin.hash.call('delistLeaf', [chainId, ESCROW_A, ASSET_A]), ids.delistLeaf(chainId, ESCROW_A, ASSET_A));
      assert.notEqual(ids.delistLeaf(chainId, ESCROW_B, ASSET_A), ids.delistLeaf(chainId, ESCROW_A, ASSET_A));
    }
  });

  test('the authority chain\'s messages and links agree: extension, cancellation, chainLink', async () => {
    const relay = '0x' + 'cd'.repeat(20);
    const link = keccak256(toUtf8Bytes('link'));
    // V2 (2026-09-30, PV-18): the epoch's root and its leaf count ride, zero and zero where none does.
    const zero = '0x' + '00'.repeat(32);
    for (const [chainId, epoch, g, epochRoot, leafCount] of [[1n, 2810n, 2, zero, 0], [8453n, 2n ** 64n - 1n, 4, keccak256(toUtf8Bytes('root')), 7], [1n, 3n, 2, keccak256(toUtf8Bytes('r')), 2 ** 32 - 1]]) {
      const m = { chainId, relay, epoch, nextGeneration: g, link, epochRoot, leafCount };
      assert.equal(await origin.hash.call('extensionMessage', [chainId, relay, epoch, g, link, epochRoot, leafCount]), ids.extensionMessage(m));
      assert.equal(await origin.hash.call('cancelMessage', [chainId, relay, epoch, g, link, epochRoot, leafCount]), ids.cancelMessage(m));
      assert.notEqual(ids.extensionMessage(m), ids.cancelMessage(m));
      assert.notEqual(ids.extensionMessage(m), ids.rootMessage({ chainId, relay, epoch, epochRoot: link, leafCount: g }));
      assert.notEqual(ids.extensionMessage(m), ids.extensionMessage({ ...m, leafCount: leafCount === 0 ? 1 : leafCount - 1 }), 'the count is bound');
      assert.notEqual(ids.extensionMessage(m), ids.extensionMessage({ ...m, epochRoot: link }), 'the root is bound');
    }
    const roots = [keccak256(toUtf8Bytes('a')), keccak256(toUtf8Bytes('b')), keccak256(toUtf8Bytes('c'))];
    for (const n of [1, 3]) {
      assert.equal(await origin.hash.call('chainLink', [roots.slice(0, n), ids.TERMINAL_COMMIT]), ids.chainLink(roots.slice(0, n), ids.TERMINAL_COMMIT));
    }
    assert.equal(ids.TERMINAL_COMMIT, keccak256(ZERO32));
  });

  test('premiumOfferLeaf and premiumLockLeaf agree, including at the widths a small value hides', async () => {
    for (const [shares, epoch] of [[1n, 0n], [ONE, 2810n], [2n ** 200n, 2n ** 64n - 1n]]) {
      const o = { chainId: CHAIN_ID, escrow: ESCROW_A, asset: ASSET_A, epoch, shares, units: shares + 7n };
      assert.equal(await origin.hash.call('premiumOfferLeaf', [o.chainId, ESCROW_A, o.asset, epoch, shares, o.units]), ids.premiumOfferLeaf(o));
      const hashlock = ids.hashlockOf(keccak256(toUtf8Bytes(`secret ${epoch}`)));
      const lotId = keccak256(toUtf8Bytes(`lot ${epoch}`));
      const w = { chainId: CHAIN_ID, escrow: ESCROW_A, asset: ASSET_A, epoch: epoch + 3n, lotId, hashlock, recipient: ACCOUNTS.bob, shares, bond: shares * 3n, evmExpiry: epoch };
      assert.equal(
        await origin.hash.call('premiumLockLeaf', [w.chainId, ESCROW_A, w.asset, [lotId, hashlock, w.recipient, shares, epoch, w.epoch, w.bond]]),
        ids.premiumLockLeaf(w),
      );
    }
  });

  test('a premium lock changes with every field it commits to', () => {
    const base = { chainId: CHAIN_ID, escrow: ESCROW_A, asset: ASSET_A, epoch: 5n, lotId: '0x' + '21'.repeat(32), hashlock: '0x' + '11'.repeat(32), recipient: ACCOUNTS.bob, shares: ONE, bond: ONE / 40n, evmExpiry: 7n };
    const leaf = ids.premiumLockLeaf(base);
    for (const change of [
      { chainId: CHAIN_ID + 1n },
      { escrow: ESCROW_B },
      { asset: ACCOUNTS.alice },
      { lotId: '0x' + '22'.repeat(32) },
      { hashlock: '0x' + '12'.repeat(32) },
      { recipient: ACCOUNTS.alice },
      { shares: ONE + 1n },
      { evmExpiry: 8n },
      { epoch: 6n },
      { bond: ONE / 40n + 1n },
    ]) {
      assert.notEqual(ids.premiumLockLeaf({ ...base, ...change }), leaf, Object.keys(change)[0]);
    }
  });

  test('the escrow reads the two windows after a quote closes as one day each (whitepaper §6.3)', async () => {
    assert.equal(await origin.hash.call('admissionWindow'), 86400n);
    assert.equal(await origin.hash.call('evmClaimWindow'), 86400n);
  });
});

describe('the relayer signs what the deployed verifier checks', () => {
  let origin;
  before(async () => {
    origin = await originLeg();
  });

  const messages = [
    '0x' + '00'.repeat(32), // every digit zero: the longest verifier chains, checksum 960
    '0x' + 'ff'.repeat(32), // every digit fifteen: checksum zero
    keccak256(toUtf8Bytes('an ordinary root message')),
  ];

  test('the message digits and the checksum agree', async () => {
    for (const m of messages) {
      const onChain = (await origin.hash.call('wotsDigits', [m])).map(Number);
      assert.deepEqual(onChain, wots.digits(m));
    }
  });

  test('one chain step agrees, with the leaf, chain and step inside the hash', async () => {
    const x = keccak256(toUtf8Bytes('x'));
    for (const [leaf, chain, step] of [[0, 0, 0], [5, 66, 14], [2 ** 20 - 1, 17, 7]]) {
      assert.equal(
        await origin.hash.call('wotsChainStep', [x, leaf, chain, step]),
        wots.chainStep(x, leaf, chain, step),
      );
    }
  });

  test('a signature recovers the committed public key, at every digit extreme', async () => {
    const signer = signerFor(4);
    for (const m of messages) {
      for (const leaf of [0, 9]) {
        const sig = signer._signUnchecked(m, leaf);
        assert.equal(await origin.hash.call('wotsPublicKey', [m, sig, leaf]), signer.publicKey(leaf));
        assert.equal(
          await origin.hash.call('wotsRecoverRoot', [m, sig, leaf, signer.authPath(leaf)]),
          signer.root,
        );
      }
    }
  });

  test('a signature presented at another leaf reaches no commitment', async () => {
    const signer = signerFor(4);
    const m = messages[2];
    const sig = signer._signUnchecked(m, 3);
    assert.notEqual(await origin.hash.call('wotsRecoverRoot', [m, sig, 4, signer.authPath(4)]), signer.root);
    assert.notEqual(await origin.hash.call('wotsRecoverRoot', [m, sig, 3, signer.authPath(4)]), signer.root);
  });
});

describe('the two chains number the same second into the same epoch', () => {
  let qrl;
  let origin;

  before(async () => {
    qrl = await qrlLeg();
    origin = await originLeg();
  });

  test('the epoch length and the coupon cliff are the same two constants', async () => {
    assert.equal(await origin.hash.call('epochLength'), await qrl.math.call('epochLength'));
    assert.equal(await origin.hash.call('couponCliff'), await qrl.math.call('couponCliff'));
    assert.equal(await origin.hash.call('epochLength'), epochLib.EPOCH_LENGTH);
    assert.equal(await origin.hash.call('couponCliff'), epochLib.COUPON_CLIFF);
  });

  test('an epoch is at most as long as the coupon cliff', async () => {
    // whitepaper §6.3 makes the epoch length governable with exactly this bound.
    // Both legs keep it a constant, so the relation is checked rather than
    // enforced — and it is checked on both, because a change to one is a change
    // that must reach the other.
    assert.ok((await origin.hash.call('epochLength')) <= (await origin.hash.call('couponCliff')));
  });

  test('epochs are counted from the Unix epoch on both chains', async () => {
    for (const ts of [0n, 1n, 604799n, 604800n, 604801n, 1_700_000_000n, 2n ** 40n]) {
      const onQrl = await qrl.math.call('epochOf', [ts]);
      assert.equal(await origin.hash.call('epochOf', [ts]), onQrl);
      assert.equal(epochLib.epochOf(ts), onQrl);
    }
  });

  test('a boundary belongs to the epoch it opens, on both chains', async () => {
    const e = 2810n;
    const start = await origin.hash.call('startOf', [e]);
    assert.equal(start, await qrl.math.call('startOf', [e]));
    assert.equal(start, epochLib.startOf(e));
    assert.equal(await origin.hash.call('epochOf', [start]), e);
    assert.equal(await origin.hash.call('epochOf', [start - 1n]), e - 1n);
  });

  test('both chains read the same wall clock as the same epoch', async () => {
    // The two harnesses hold their own timestamps; align them and the epoch must
    // follow with nothing configured on either side.
    const ts = BigInt(qrl.chain.timestamp);
    origin.chain.timestamp = ts;
    assert.equal(await origin.hash.call('currentEpoch'), await qrl.math.call('currentEpoch'));
    assert.equal(epochLib.epochOf(ts), await origin.hash.call('currentEpoch'));
  });
});

describe('a tree the relayer builds verifies under the escrow’s own verifier', () => {
  let origin;
  before(async () => {
    origin = await originLeg();
  });

  const leaves = (n) => [...Array(n)].map((_, i) => keccak256(toUtf8Bytes(`leaf-${i}`)));

  // The odd counts exercise the promoted node. OpenZeppelin's verifier is
  // agnostic to how a tree was built, so the promotion convention is pinned here
  // against the real verifier rather than assumed in the builder.
  for (const n of [1, 2, 3, 5, 8, 9, 17]) {
    test(`every leaf of a ${n}-leaf tree verifies`, async () => {
      const ls = leaves(n);
      const tree = buildTree(ls);
      for (const leaf of ls) {
        assert.ok(
          await origin.hash.call('verify', [proofFor(tree, leaf), tree.root, leaf]),
          `n=${n}, leaf ${leaf}`,
        );
      }
    });
  }

  test('a one-leaf tree verifies with an empty proof, so the leaf is the root', async () => {
    const [only] = leaves(1);
    assert.ok(await origin.hash.call('verify', [[], only, only]));
  });

  test('a leaf outside the tree does not verify against its root', async () => {
    const tree = buildTree(leaves(5));
    const outsider = keccak256(toUtf8Bytes('leaf-outside'));
    assert.ok(!(await origin.hash.call('verify', [[], tree.root, outsider])));
    assert.ok(!(await origin.hash.call('verify', [proofFor(tree, tree.leaves[0]), tree.root, outsider])));
  });

  test('a proof from one tree does not verify a leaf in another', async () => {
    const a = buildTree(leaves(5));
    const b = buildTree(leaves(6));
    const leaf = a.leaves[2];
    assert.ok(!(await origin.hash.call('verify', [proofFor(a, leaf), b.root, leaf])));
  });

  test('the origin chain is the chain the manifest declares', async () => {
    // block.chainid is inside the stakeAssetId preimage, so a harness running
    // under a different chain id would agree with the registry about hashing and
    // disagree with it about which position each hash names.
    assert.equal(await origin.hash.call('originChainId'), CHAIN_ID);
  });
});
