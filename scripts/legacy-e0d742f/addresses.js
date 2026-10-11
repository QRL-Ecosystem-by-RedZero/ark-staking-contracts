/**
 * Address rendering across the two chains.
 *
 * The one rule this module exists to enforce: **an address that reaches a hash
 * preimage is twenty bytes of lowercase hex, whichever chain it came from.**
 *
 * The same twenty bytes are written `0x…` on the origin chain and `Q…` on QRL,
 * and QRL's casing is not EIP-55. So `ethers.getAddress` throws a checksum error
 * on a QRL address written with its own casing, and throws `invalid address` on
 * the `Q` form outright. Neither failure is the dangerous one: the dangerous one
 * is a mixed-case address reaching `abi.encode` and producing a `stakeAssetId`
 * that corresponds to no position. That is a correctness bug and not a
 * formatting one, so normalisation happens here and every preimage in
 * identifiers.js calls through it.
 *
 * Origin-chain addresses get `toChecksum` where they are *displayed or
 * configured*, so a typo in a chain manifest is caught. QRL addresses never do.
 * The asymmetry is deliberate.
 */
const { getAddress } = require('ethers');

const HEX20 = /^[0-9a-f]{40}$/;

class BadAddress extends Error {
  constructor(value, why) {
    super(`bad address ${JSON.stringify(value)}: ${why}`);
    this.name = 'BadAddress';
    this.value = value;
  }
}

/** The canonical form for hashing: `0x` + forty lowercase hex characters. */
function toHex(value) {
  if (typeof value !== 'string') throw new BadAddress(value, 'not a string');

  // A `Z` address is not an alternative rendering to be normalised — it is a
  // symptom. The qrysm consensus-client images published in 2025-08 render
  // addresses with a `Z` prefix, while the genesis generator and the execution
  // client this project pins are from 2026-03 and render `Q`; the two ends are
  // mutually exclusive, which is why scripts/build-qrysm.sh builds the client
  // from source. An address arriving here with a `Z` means something in the
  // stack is the wrong build, and silently accepting the bytes would hide that
  // until a chain sat at block 0 for unrelated-looking reasons. CLAUDE.md §4.2.
  if (/^Z/i.test(value)) {
    throw new BadAddress(
      value,
      'a Z prefix is the stale 2025-08 qrysm rendering; this stack is Q throughout (CLAUDE.md §4.2)',
    );
  }

  const body = value.replace(/^0x/i, '').replace(/^Q/i, '').toLowerCase();
  if (!HEX20.test(body)) throw new BadAddress(value, 'not twenty bytes of hex');
  return `0x${body}`;
}

/** The same twenty bytes as QRL renders them. */
function toQ(value) {
  return `Q${toHex(value).slice(2)}`;
}

/** EIP-55. Origin-chain addresses only — a QRL address is not checksummed. */
function toChecksum(value) {
  return getAddress(toHex(value));
}

function sameAddress(a, b) {
  return toHex(a) === toHex(b);
}

module.exports = { toHex, toQ, toChecksum, sameAddress, BadAddress };
