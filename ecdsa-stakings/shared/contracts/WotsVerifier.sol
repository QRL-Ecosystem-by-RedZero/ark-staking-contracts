// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * Winternitz one-time signatures under a Merkle commitment. whitepaper §3.6,
 * yellow paper §2.2, invariant I16.
 *
 * The one rule this library exists to enforce: **the only signature the origin
 * chain ever verifies is one whose security rests on a hash function alone.**
 *
 * WHY HASHING ONLY
 * ----------------
 * Every account on this chain authenticates with secp256k1, which the threat
 * model grants the adversary outright, and the lattice scheme QRL signs with
 * costs more gas to verify than a block admits. A hash-based signature is the
 * one scheme that survives the event and fits: no curve arithmetic, and no
 * precompile — `ecrecover` above all — that this chain may carry and the
 * adversary may break. Everything below is keccak256.
 *
 * THE CONSTRUCTION, FIXED BYTE FOR BYTE
 * -------------------------------------
 * ecdsa-stakings/relayer/lib/wots.js is the signer and must match exactly.
 *
 *   n = 32 bytes, H = keccak256, w = 16.
 *   The 32-byte message gives 64 base-16 digits, most significant nibble first
 *   (the high nibble of byte 0 is digit 0). The checksum c = sum(15 - d_i) over
 *   those 64 is written as three base-16 digits, most significant first, as
 *   digits 64, 65 and 66: len = 67 chains.
 *
 *   F(x, leaf, chain, step) = keccak256(abi.encodePacked(
 *       bytes32 x, uint32 leaf, uint8 chain, uint8 step))
 *
 *   sig_i  = F applied d_i times to sk_i, at steps 0 .. d_i - 1
 *   end_i  = F applied to sig_i at steps d_i .. 14   (15 - d_i applications)
 *   pk     = keccak256(abi.encodePacked(end_0, …, end_66))
 *   leaf   = keccak256(abi.encodePacked(bytes1(0x00), pk))
 *   node   = keccak256(abi.encodePacked(bytes1(0x01), left, right))
 *
 * The checksum is what makes the scheme unforgeable rather than merely
 * one-time: advancing any message digit (which anyone can do, by hashing a
 * published chain element forward) lowers the checksum, and lowering a
 * checksum digit needs a hash preimage. Without it a signature on one root
 * would sign every root whose digits dominate it.
 *
 * The leaf index and the chain index are inside F, so a chain element of one
 * key is not a chain element of another key or of another chain of the same
 * key — the multi-target defence of WOTS+ in its simplest form. The 0x00 and
 * 0x01 prefixes separate a leaf from an interior node, so a node cannot be
 * presented as a public key.
 *
 * The authentication path is positional: bit k of the leaf index says whether
 * the node at level k is the left or the right child. A sorted-pair tree, as
 * OpenZeppelin's MerkleProof builds, would not bind the index, and the index is
 * what the relay's forward-only rule is stated over.
 */
library WotsVerifier {
    uint256 internal constant W = 16;
    uint256 internal constant MSG_DIGITS = 64;
    uint256 internal constant CHECKSUM_DIGITS = 3;
    uint256 internal constant LEN = MSG_DIGITS + CHECKSUM_DIGITS; // 67

    /**
     * The Merkle root the signature over `message` at `leafIndex` reaches, or a
     * root no commitment matches if any element is wrong.
     *
     * Returns rather than compares, so the caller states what it compares
     * against in the one place the authority lives.
     */
    function recoverRoot(
        bytes32 message,
        bytes32[67] calldata sig,
        uint32 leafIndex,
        bytes32[] calldata authPath
    ) internal pure returns (bytes32) {
        return merkleRoot(publicKey(message, sig, leafIndex), leafIndex, authPath);
    }

    /// The one-time public key the signature continues to. Hashing only.
    function publicKey(bytes32 message, bytes32[67] calldata sig, uint32 leafIndex)
        internal
        pure
        returns (bytes32)
    {
        uint8[67] memory d = digits(message);
        bytes32[67] memory ends;
        for (uint256 i = 0; i < LEN; ++i) {
            bytes32 x = sig[i];
            for (uint256 step = d[i]; step < W - 1; ++step) {
                x = chainStep(x, leafIndex, uint8(i), uint8(step));
            }
            ends[i] = x;
        }
        return keccak256(abi.encodePacked(ends));
    }

    /// The 64 message digits and the three checksum digits, most significant first.
    function digits(bytes32 message) internal pure returns (uint8[67] memory d) {
        uint256 checksum;
        for (uint256 j = 0; j < 32; ++j) {
            uint8 b = uint8(message[j]);
            d[2 * j] = b >> 4;
            d[2 * j + 1] = b & 0x0f;
            checksum += (W - 1 - (b >> 4)) + (W - 1 - (b & 0x0f));
        }
        // At most 64 * 15 = 960, which three base-16 digits hold (< 4096).
        d[64] = uint8((checksum >> 8) & 0x0f);
        d[65] = uint8((checksum >> 4) & 0x0f);
        d[66] = uint8(checksum & 0x0f);
    }

    /**
     * F(x, leaf, chain, step) = keccak256(abi.encodePacked(x, leaf, chain, step)).
     *
     * In scratch space rather than through `abi.encodePacked`, because a
     * verification runs this up to 1,005 times and `abi.encodePacked` allocates
     * fresh memory on every call: the memory expansion cost of that is quadratic
     * and would dominate the whole verification. The 38 bytes fit in the 64
     * bytes of scratch space Solidity reserves for exactly this use, so the
     * block writes no memory the compiler owns.
     */
    function chainStep(bytes32 x, uint32 leafIndex, uint8 chainIndex, uint8 step)
        internal
        pure
        returns (bytes32 out)
    {
        assembly ("memory-safe") {
            mstore(0x00, x)
            // Bytes 32..37: the four-byte leaf index, then chain, then step,
            // big-endian, exactly as abi.encodePacked lays them out.
            mstore(
                0x20,
                or(
                    shl(224, and(leafIndex, 0xffffffff)),
                    or(shl(216, and(chainIndex, 0xff)), shl(208, and(step, 0xff)))
                )
            )
            out := keccak256(0x00, 38)
        }
    }

    /// The root a public key reaches at a position, by a positional path.
    function merkleRoot(bytes32 pk, uint32 leafIndex, bytes32[] calldata authPath)
        internal
        pure
        returns (bytes32 node)
    {
        node = keccak256(abi.encodePacked(bytes1(0x00), pk));
        uint256 index = leafIndex;
        for (uint256 k = 0; k < authPath.length; ++k) {
            node = (index & 1) == 0
                ? keccak256(abi.encodePacked(bytes1(0x01), node, authPath[k]))
                : keccak256(abi.encodePacked(bytes1(0x01), authPath[k], node));
            index >>= 1;
        }
    }
}
