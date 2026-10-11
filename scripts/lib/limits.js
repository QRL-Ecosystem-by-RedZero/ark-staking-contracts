/**
 * The deployment ceilings, in one place.
 *
 * `scripts/compile.js` flags a contract against them and `scripts/lib/chunked.js`
 * decides from them how a contract is sent. Two declarations of one limit would be
 * two limits the day one of them is edited, so both read this module, which
 * depends on nothing so that the compiler does not have to load a chain client to
 * learn a number.
 */

/** Runtime bytecode above this cannot be deployed at all (EIP-170). */
const EIP170_LIMIT = 24576;

/**
 * Largest creation payload sent in one request: the QRL proxy caps a body at
 * 50KB, and an ML-DSA-87 signature with its public key adds ~7.2KB to every
 * transaction on top of hex doubling the payload. Above it, a contract is
 * assembled on chain by `ChunkedDeployer` (CLAUDE.md §3.1).
 */
const DIRECT_DEPLOY_LIMIT = 18000;

module.exports = { EIP170_LIMIT, DIRECT_DEPLOY_LIMIT };
