// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "../ArkStakeIds.sol";
import "../ArkEpochLib.sol";
import "../WotsVerifier.sol";

/**
 * Test doubles for the origin-chain leg. Never deployed to any network.
 *
 * `ArkStakeIdsHarness` exists because `ArkStakeIds` and `ArkEpochLib` are
 * `internal` libraries and are inlined into their callers, so no test can reach
 * them directly — the same reason `StakeMathHarness` exists on the QRL side. It
 * forwards and adjusts nothing; a harness that normalised an argument would be
 * testing itself.
 *
 * It also exposes `MerkleProof.verify` and the pieces of `WotsVerifier`. That
 * is what makes the agreement tests evidence rather than assertion: the
 * relayer's tree builder and one-time signer are checked against the verifiers
 * the escrow and the relay actually link, not against a second copy of the
 * relayer's own arithmetic.
 */
contract ArkStakeIdsHarness {
    function stakeDomain() external pure returns (bytes32) {
        return ArkStakeIds.STAKE_DOMAIN;
    }

    function assetKey(uint256 chainId, address asset) external pure returns (bytes32) {
        return ArkStakeIds.assetKey(chainId, asset);
    }

    function stakeAssetId(
        uint256 chainId,
        address asset,
        address depositor,
        bytes calldata boundQrlOwner,
        uint64 depositNonce
    ) external pure returns (bytes32) {
        (bytes32 hi, bytes32 lo) = ArkStakeIds.qrlOwnerWords(boundQrlOwner);
        return ArkStakeIds.stakeAssetId(chainId, asset, depositor, hi, lo, depositNonce);
    }

    function qrlOwnerWords(bytes calldata boundQrlOwner) external pure returns (bytes32 hi, bytes32 lo) {
        return ArkStakeIds.qrlOwnerWords(boundQrlOwner);
    }

    function stakeLeafKey(address escrow, bytes32 id, uint256 anchoredNotional) external pure returns (bytes32) {
        return ArkStakeIds.stakeLeafKey(escrow, id, anchoredNotional);
    }

    function spendKey(uint256 epoch, bytes32 leaf) external pure returns (bytes32) {
        return ArkStakeIds.spendKey(epoch, leaf);
    }

    function releasePayload(bytes32 id, address recipient, uint64 claimNonce, uint256 chainId)
        external
        pure
        returns (bytes32)
    {
        return ArkStakeIds.releasePayload(id, recipient, claimNonce, chainId);
    }

    function releaseLeaf(address escrow, bytes32 payload) external pure returns (bytes32) {
        return ArkStakeIds.releaseLeaf(escrow, payload);
    }

    function rootMessage(uint256 chainId, address relay, uint64 epoch, bytes32 epochRoot, uint32 leafCount)
        external
        pure
        returns (bytes32)
    {
        return ArkStakeIds.rootMessage(chainId, relay, epoch, epochRoot, leafCount);
    }

    function anchorCountLeaf(uint256 epoch, uint256 count) external pure returns (bytes32) {
        return ArkStakeIds.anchorCountLeaf(epoch, count);
    }

    function extensionMessage(
        uint256 chainId,
        address relay,
        uint64 epoch,
        uint8 nextGeneration,
        bytes32 link,
        bytes32 epochRoot,
        uint32 leafCount
    ) external pure returns (bytes32) {
        return ArkStakeIds.extensionMessage(chainId, relay, epoch, nextGeneration, link, epochRoot, leafCount);
    }

    function cancelMessage(
        uint256 chainId,
        address relay,
        uint64 epoch,
        uint8 nextGeneration,
        bytes32 link,
        bytes32 epochRoot,
        uint32 leafCount
    ) external pure returns (bytes32) {
        return ArkStakeIds.cancelMessage(chainId, relay, epoch, nextGeneration, link, epochRoot, leafCount);
    }

    function chainLink(bytes32[] calldata signerRoots, bytes32 nextChainCommit) external pure returns (bytes32) {
        return ArkStakeIds.chainLink(signerRoots, nextChainCommit);
    }

    function closeLeaf(uint256 chainId, address escrow) external pure returns (bytes32) {
        return ArkStakeIds.closeLeaf(chainId, escrow);
    }

    function freezeLeaf(uint256 chainId, address escrow, bool frozen) external pure returns (bytes32) {
        return ArkStakeIds.freezeLeaf(chainId, escrow, frozen);
    }

    function delistLeaf(uint256 chainId, address escrow, address asset) external pure returns (bytes32) {
        return ArkStakeIds.delistLeaf(chainId, escrow, asset);
    }

    function seedReturnLeaf(uint256 chainId, address escrow, uint256 epoch) external pure returns (bytes32) {
        return ArkStakeIds.seedReturnLeaf(chainId, escrow, epoch);
    }

    function premiumOfferLeaf(
        uint256 chainId,
        address escrow,
        address asset,
        uint256 epoch,
        uint256 shares,
        uint256 units
    ) external pure returns (bytes32) {
        return ArkStakeIds.premiumOfferLeaf(chainId, escrow, asset, epoch, shares, units);
    }

    function bufferLeaf(uint256 chainId, address escrow, address asset, uint256 epoch, uint256 units)
        external
        pure
        returns (bytes32)
    {
        return ArkStakeIds.bufferLeaf(chainId, escrow, asset, epoch, units);
    }

    function premiumLockLeaf(uint256 chainId, address escrow, address asset, IArkStakeEscrow.PremiumLock calldata p)
        external
        pure
        returns (bytes32)
    {
        return ArkStakeIds.premiumLockLeaf(chainId, escrow, asset, p);
    }

    function releasedLeaf(address escrow, bytes32 id, uint64 claimNonce) external pure returns (bytes32) {
        return ArkStakeIds.releasedLeaf(escrow, id, claimNonce);
    }

    function allocationLeaf(address escrow, uint256 epoch, IArkStakeEscrow.AllocationRates calldata rates)
        external
        pure
        returns (bytes32)
    {
        return ArkStakeIds.allocationLeaf(escrow, epoch, rates);
    }

    function lossLeaf(
        uint256 chainId,
        address escrow,
        bytes32 determinationId,
        bytes32 id,
        address destination,
        uint256 quantity
    ) external pure returns (bytes32) {
        return ArkStakeIds.lossLeaf(chainId, escrow, determinationId, id, destination, quantity);
    }

    function shareLeaf(
        uint256 chainId,
        address escrow,
        bytes32 successorId,
        bytes32 recoveryId,
        bytes32 recipient,
        address destination,
        uint256 quantity
    ) external pure returns (bytes32) {
        return ArkStakeIds.shareLeaf(chainId, escrow, successorId, recoveryId, recipient, destination, quantity);
    }

    /// The domain tags, in one call, in the order identifiers.js exports them.
    function domains() external pure returns (bytes32[16] memory d) {
        d[0] = ArkStakeIds.STAKE_DOMAIN;
        d[1] = ArkStakeIds.ROOT_DOMAIN;
        d[2] = ArkStakeIds.CLOSE_DOMAIN;
        d[3] = ArkStakeIds.FREEZE_DOMAIN;
        d[4] = ArkStakeIds.DELIST_DOMAIN;
        d[5] = ArkStakeIds.OFFER_DOMAIN;
        d[6] = ArkStakeIds.PREMIUM_DOMAIN;
        d[7] = ArkStakeIds.RELEASED_DOMAIN;
        d[8] = ArkStakeIds.ALLOCATION_DOMAIN;
        d[9] = ArkStakeIds.LOSS_DOMAIN;
        d[10] = ArkStakeIds.RECOVERY_DOMAIN;
        d[11] = ArkStakeIds.BUFFER_DOMAIN;
        d[12] = ArkStakeIds.EXTENSION_DOMAIN;
        d[13] = ArkStakeIds.CANCEL_DOMAIN;
        d[14] = ArkStakeIds.ANCHOR_COUNT_DOMAIN;
        d[15] = ArkStakeIds.SEED_RETURN_DOMAIN;
    }

    function wotsDigits(bytes32 message) external pure returns (uint8[67] memory) {
        return WotsVerifier.digits(message);
    }

    function wotsChainStep(bytes32 x, uint32 leafIndex, uint8 chainIndex, uint8 step)
        external
        pure
        returns (bytes32)
    {
        return WotsVerifier.chainStep(x, leafIndex, chainIndex, step);
    }

    function wotsPublicKey(bytes32 message, bytes32[67] calldata sig, uint32 leafIndex)
        external
        pure
        returns (bytes32)
    {
        return WotsVerifier.publicKey(message, sig, leafIndex);
    }

    function wotsRecoverRoot(
        bytes32 message,
        bytes32[67] calldata sig,
        uint32 leafIndex,
        bytes32[] calldata authPath
    ) external pure returns (bytes32) {
        return WotsVerifier.recoverRoot(message, sig, leafIndex, authPath);
    }

    function epochLength() external pure returns (uint64) {
        return ArkEpochLib.EPOCH_LENGTH;
    }

    function couponCliff() external pure returns (uint64) {
        return ArkEpochLib.COUPON_CLIFF;
    }

    function admissionWindow() external pure returns (uint64) {
        return ArkEpochLib.ADMISSION_WINDOW;
    }

    function evmClaimWindow() external pure returns (uint64) {
        return ArkEpochLib.EVM_CLAIM_WINDOW;
    }

    function epochOf(uint256 timestamp) external pure returns (uint256) {
        return ArkEpochLib.epochOf(timestamp);
    }

    function currentEpoch() external view returns (uint256) {
        return ArkEpochLib.current();
    }

    function startOf(uint256 epoch) external pure returns (uint256) {
        return ArkEpochLib.startOf(epoch);
    }

    /// The verifier the escrow links, exposed so a tree builder can be checked against it.
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf)
        external
        pure
        returns (bool)
    {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// The chain id the identifiers are built from, as this contract sees it.
    function originChainId() external view returns (uint256) {
        return block.chainid;
    }
}
