/**
 * The relayer's hashes and its Merkle tree, against the contract that consumes
 * them.
 *
 * The one rule this file exists to defend: **the relayer's transcription of the
 * preimages and of OpenZeppelin's tree is the one `ArkStakeRegistry` accepts.**
 *
 * Three implementations of these hashes will exist — Hyperion here, Solidity in
 * the origin-chain escrow, and JavaScript in `ecdsa-stakings/relayer/lib`. A
 * divergence in any of them does not raise an error anywhere: it produces an
 * identifier corresponding to no position, or a proof that simply fails. So the
 * agreement is asserted rather than trusted, and it is asserted against the real
 * verifier — `MockAttestation` runs OpenZeppelin's `MerkleProof.verifyCalldata`,
 * not a second copy of the relayer's arithmetic.
 *
 * The relayer's unit tests under `ecdsa-stakings/relayer/test` check the shape of
 * those modules and must not be read as evidence for this agreement. This file
 * is the evidence.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { Chain, ACCOUNTS } = require('./harness');

const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
const { buildTree, proofFor } = require('../ecdsa-stakings/relayer/lib/merkle');
const { epochOf } = require('../ecdsa-stakings/relayer/lib/epoch');

const { deployStack, ONE, CHAIN_ID, ASSET_A, GROUP_A, ESCROW } = require('./stake-fixture');

async function fixture() {
  const { chain, registry, attest } = await deployStack({
    bondQrl: 10_000_000n * ONE,
    assets: [{ asset: ASSET_A, group: GROUP_A }],
  });
  // The anchor leaf, the spend key and the release builders are the
  // registry's library code since 2026-09-29, reached through the harness.
  const math = await chain.deploy('StakeMathHarness');
  return { chain, registry, attest, math };
}

describe('the relayer computes the identifiers the registry computes', () => {
  let ctx;
  before(async () => {
    ctx = await fixture();
  });

  /**
   * A table rather than one case, because a transcription error in `abi.encode`
   * argument *types* is invisible for most values — a `uint64` and a `uint256`
   * pad to the same 32 bytes for a small nonce, and only a large one separates
   * them. The zero address and the maximum nonce are here for that reason.
   */
  const rows = [
    { label: 'the modelled position', asset: ASSET_A, depositor: ACCOUNTS.alice, owner: ACCOUNTS.bob, nonce: 0n, notional: 100n * ONE },
    { label: 'a repeated deposit', asset: ASSET_A, depositor: ACCOUNTS.alice, owner: ACCOUNTS.bob, nonce: 1n, notional: 100n * ONE },
    { label: 'a nonce above 32 bits', asset: ASSET_A, depositor: ACCOUNTS.alice, owner: ACCOUNTS.bob, nonce: 2n ** 40n, notional: 1n },
    { label: 'the largest nonce a uint64 holds', asset: ASSET_A, depositor: ACCOUNTS.mallory, owner: ACCOUNTS.alice, nonce: 2n ** 64n - 1n, notional: 2n ** 128n },
    { label: 'a one-wei notional', asset: '0x' + 'bb'.repeat(20), depositor: ACCOUNTS.bob, owner: ACCOUNTS.guardian, nonce: 7n, notional: 1n },
  ];

  for (const row of rows) {
    test(`stakeAssetId agrees on ${row.label}`, async () => {
      const onChain = await ctx.registry.call('stakeAssetId', [
        CHAIN_ID,
        row.asset,
        row.depositor,
        row.owner,
        row.nonce,
      ]);
      const offChain = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      assert.equal(offChain, onChain);
    });

    test(`stakeLeafKey agrees on ${row.label}`, async () => {
      const id = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      const onChain = await ctx.math.call('stakeLeafKey', [ESCROW, id, row.notional]);
      assert.equal(ids.stakeLeafKey(ESCROW, id, row.notional), onChain);
    });

    test(`releasePayload and releaseLeaf agree on ${row.label}`, async () => {
      const id = ids.stakeAssetId({
        chainId: CHAIN_ID,
        asset: row.asset,
        depositor: row.depositor,
        boundQrlOwner: row.owner,
        depositNonce: row.nonce,
      });
      const claimNonce = 1n;
      const onChainPayload = await ctx.math.call('releasePayload', [
        id,
        row.owner,
        claimNonce,
        CHAIN_ID,
      ]);
      const offChainPayload = ids.releasePayload({
        id,
        recipient: row.owner,
        claimNonce,
        chainId: CHAIN_ID,
      });
      assert.equal(offChainPayload, onChainPayload);

      const onChainLeaf = await ctx.math.call('releaseLeaf', [ESCROW, onChainPayload]);
      assert.equal(ids.releaseLeaf(ESCROW, offChainPayload), onChainLeaf);
    });
  }

  test('assetKey agrees, including across two chains', async () => {
    for (const chainId of [1n, 8453n, 2n ** 64n]) {
      const onChain = await ctx.registry.call('assetKey', [chainId, ASSET_A]);
      assert.equal(ids.assetKey(chainId, ASSET_A), onChain);
    }
  });

  test('spendKey agrees, so a proof is consumed against the same pair on both sides', async () => {
    const leaf = keccak256(toUtf8Bytes('some-leaf'));
    for (const epoch of [0n, 2810n, 2n ** 64n]) {
      const onChain = await ctx.math.call('spendKey', [epoch, leaf]);
      assert.equal(ids.spendKey(epoch, leaf), onChain);
    }
  });

  test('the domain tag the relayer carries is the one the registry deployed', async () => {
    assert.equal(ids.STAKE_DOMAIN, await ctx.registry.call('STAKE_DOMAIN'));
  });

  test('the relayer and the registry number the same second into the same epoch', async () => {
    // Both divide by 604800 from the Unix epoch. Nothing configures either, and
    // that is what lets an origin-chain event name an epoch a QRL contract
    // agrees with.
    const harness = await ctx.chain.deploy('StakeMathHarness');
    for (const ts of [0n, 1n, 604799n, 604800n, BigInt(ctx.chain.timestamp)]) {
      assert.equal(epochOf(ts), await harness.call('epochOf', [ts]));
    }
  });

  test('an address written the QRL way and the Ethereum way give one identifier', async () => {
    // CLAUDE.md records this as a correctness bug rather than a formatting one:
    // a mis-cased boundQrlOwner yields an id corresponding to no position.
    const owner = ACCOUNTS.bob;
    const onChain = await ctx.registry.call('stakeAssetId', [
      CHAIN_ID,
      ASSET_A,
      ACCOUNTS.alice,
      owner,
      0n,
    ]);
    for (const written of [owner, owner.toUpperCase().replace('0X', '0x'), `Q${owner.slice(2)}`]) {
      assert.equal(
        ids.stakeAssetId({
          chainId: CHAIN_ID,
          asset: ASSET_A,
          depositor: ACCOUNTS.alice,
          boundQrlOwner: written,
          depositNonce: 0n,
        }),
        onChain,
      );
    }
  });
});

describe('a tree the relayer builds is a tree the registry verifies', () => {
  /**
   * Builds `n` anchors, seals the root the relayer's builder produced, and
   * records every one of them against that root with the relayer's proofs.
   *
   * `recordAnchor` is the real consumer: it calls `MockAttestation.verify`,
   * which calls OpenZeppelin's `MerkleProof.verifyCalldata`. Nothing in this
   * path re-implements the tree, so a passing run is evidence about the
   * builder rather than about itself.
   */
  async function sealAndRecord(n) {
    const ctx = await fixture();
    const epoch = epochOf(ctx.chain.timestamp);

    const anchors = [...Array(n)].map((_, i) => {
      const input = {
        chainId: CHAIN_ID,
        asset: ASSET_A,
        depositor: ACCOUNTS.alice,
        boundQrlOwner: ACCOUNTS.bob,
        depositNonce: BigInt(i),
      };
      const notional = BigInt(i + 1) * ONE;
      const id = ids.stakeAssetId(input);
      return { input, notional, id, leaf: ids.stakeLeafKey(ESCROW, id, notional) };
    });

    const tree = buildTree(anchors.map((a) => a.leaf));
    await ctx.attest.send('seal', [epoch, tree.root]);

    for (const a of anchors) {
      await ctx.registry.send(
        'recordAnchor',
        [
          [a.input.chainId, a.input.asset, a.input.depositor, a.input.boundQrlOwner, a.input.depositNonce, a.notional, ESCROW],
          epoch,
          proofFor(tree, a.leaf),
        ],
        { from: ACCOUNTS.mallory },
      );
      const rec = await ctx.registry.call('anchorOf', [a.id]);
      assert.equal(rec.status, 1n, `anchor ${a.id} not recorded for n=${n}`);
    }
    return { ctx, tree, anchors, epoch };
  }

  // Odd counts are the ones that exercise the promoted node, and the on-chain
  // verifier is agnostic to how a tree was built — so the promotion convention
  // is pinned here rather than assumed in the builder.
  for (const n of [1, 2, 3, 5, 8, 9]) {
    test(`every leaf of a ${n}-leaf tree records against the sealed root`, async () => {
      await sealAndRecord(n);
    });
  }

  test('a one-leaf epoch seals the leaf itself and records with an empty proof', async () => {
    const { tree, anchors } = await sealAndRecord(1);
    assert.equal(tree.root, anchors[0].leaf);
    assert.deepEqual(proofFor(tree, anchors[0].leaf), []);
  });

  test('a leaf that was never in the epoch does not record against its root', async () => {
    const { ctx, tree, epoch } = await sealAndRecord(5);
    const outsider = {
      chainId: CHAIN_ID,
      asset: ASSET_A,
      depositor: ACCOUNTS.guardian,
      boundQrlOwner: ACCOUNTS.bob,
      depositNonce: 99n,
    };
    const notional = 7n * ONE;
    await assert.rejects(
      ctx.registry.send(
        'recordAnchor',
        [
          [outsider.chainId, outsider.asset, outsider.depositor, outsider.boundQrlOwner, outsider.depositNonce, notional, ESCROW],
          epoch,
          proofFor(tree, tree.leaves[0]),
        ],
        { from: ACCOUNTS.mallory },
      ),
      /BadProof/,
    );
  });

  test('a proof carried over from another epoch does not record', async () => {
    const { ctx, tree, anchors, epoch } = await sealAndRecord(3);
    // The same leaf, the same proof, an epoch with no root.
    const a = anchors[0];
    await assert.rejects(
      ctx.registry.send(
        'recordAnchor',
        [
          [a.input.chainId, a.input.asset, a.input.depositor, a.input.boundQrlOwner, 42n, a.notional, ESCROW],
          epoch + 1n,
          proofFor(tree, a.leaf),
        ],
        { from: ACCOUNTS.mallory },
      ),
      /BadProof/,
    );
  });

  test('an insurance-domain leaf does not record as an anchoring', async () => {
    // whitepaper §3.5. If the domain tag were absent, a root sealed to record an
    // anchoring would satisfy the insurance claim path as well.
    const ctx = await fixture();
    const epoch = epochOf(ctx.chain.timestamp);
    const input = {
      chainId: CHAIN_ID,
      asset: ASSET_A,
      depositor: ACCOUNTS.alice,
      boundQrlOwner: ACCOUNTS.bob,
      depositNonce: 0n,
    };
    const notional = 100n * ONE;
    const id = ids.stakeAssetId(input);

    await ctx.attest.send('seal', [epoch, ids.insuranceLeafKey(id, notional)]);
    await assert.rejects(
      ctx.registry.send(
        'recordAnchor',
        [[input.chainId, input.asset, input.depositor, input.boundQrlOwner, input.depositNonce, notional, ESCROW], epoch, []],
        { from: ACCOUNTS.mallory },
      ),
      /BadProof/,
    );
  });
});
