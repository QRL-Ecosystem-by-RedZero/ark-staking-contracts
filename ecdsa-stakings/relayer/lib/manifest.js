/**
 * The per-chain manifest, and what makes one valid.
 *
 * The one rule this module exists to enforce: **a manifest that would produce
 * identifiers corresponding to no position fails at load, not in production.**
 *
 * Three fields carry that risk and each is checked for a different reason:
 *
 * - `chainId` is inside the `stakeAssetId` preimage, so a wrong one produces a
 *   whole book of identifiers the registry has never seen.
 * - an asset address is inside it too, and is the one field an operator types.
 *   It is checked as EIP-55 rather than merely as hex, because a checksum is the
 *   only thing that catches a transposed character.
 * - `correlationGroup` is a *string* here and a `bytes32` on QRL. The registry
 *   was admitted with `keccak256(theString)`, and the concentration measurement
 *   that sizes the whole capital requirement is taken over those groups. A
 *   manifest whose group strings do not match what governance admitted produces
 *   a partition that is wrong without being invalid — the specification's
 *   status register already records that nobody can verify the partition, so
 *   the least this can do is refuse a group that was never admitted.
 */
const fs = require('fs');
const path = require('path');
const { keccak256, toUtf8Bytes } = require('ethers');

const { toChecksum, toHex } = require('./addresses');

const STAKINGS = path.join(__dirname, '..', '..');

/**
 * The evm versions solc 0.8.24 emits, in order. `test/harness.js` runs
 * `Hardfork.Shanghai`, so anything past it compiles to opcodes the harness
 * reports as invalid — a failure that reads like a contract bug and is not one.
 */
const EVM_VERSIONS = ['london', 'paris', 'shanghai', 'cancun'];
const HARNESS_EVM_VERSION = 'shanghai';

/** Test doubles a testnet manifest may list as an asset, from shared/contracts/mocks. */
const MOCKS = ['MockAsset', 'MockRebasingAsset'];
/** How a real asset is acquired: `lido` stakes ETH through the token's own `submit`. */
const SOURCES = ['lido'];

/** Build profiles, as `scripts/lib/profile.js` defines them; absent means spec. */
const PROFILES = ['spec', 'testnet', 'rapid'];

/**
 * Chains holding real value, on which a `testnet` manifest is refused. Not an
 * allowlist of testnets: an unlisted chain id is permitted, so this list only
 * ever needs to grow.
 */
const MAINNET_CHAIN_IDS = [1, 10, 56, 100, 137, 324, 1101, 5000, 8453, 42161, 42220, 43114, 59144, 81457, 534352];

class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

const fail = (field, why) => {
  throw new ManifestError(`chain manifest ${field}: ${why}`);
};

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/** Pure. Throws with a field path; returns the manifest unchanged. */
function validate(m) {
  if (!m || typeof m !== 'object') fail('', 'not an object');
  if (typeof m.name !== 'string' || !/^[a-z0-9-]+$/.test(m.name)) {
    fail('name', 'must be lowercase letters, digits and hyphens');
  }
  if (!isPositiveInt(m.chainId)) fail('chainId', 'must be a positive integer');
  if (m.profile !== undefined && !PROFILES.includes(m.profile)) {
    fail('profile', `must be one of ${PROFILES.join(', ')}`);
  }
  // A time-compressed escrow unbonds in hours. On a chain holding real value
  // that is not a test, it is the product with its one delay removed.
  if (m.profile !== undefined && m.profile !== 'spec' && MAINNET_CHAIN_IDS.includes(m.chainId)) {
    fail('profile', `"${m.profile}" is refused on chain ${m.chainId}, which is a mainnet`);
  }
  // How the chain is reached. `qrl` is the Kurtosis enclave standing in for an
  // origin chain (ZVM runs solc artifacts unmodified, CLAUDE.md §5): the same
  // bytecode, spoken to over `qrl_*` with Q addresses. Rehearsal only.
  if (m.client !== undefined && !['evm', 'qrl', 'harness'].includes(m.client)) {
    fail('client', 'must be "evm", "qrl" or "harness"');
  }
  if (m.client !== undefined && m.client !== 'evm' && (m.profile === undefined || m.profile === 'spec')) {
    fail('client', `"${m.client}" stands in for an origin chain and needs a time-compressed profile`);
  }
  if (!EVM_VERSIONS.includes(m.evmVersion)) {
    fail('evmVersion', `must be one of ${EVM_VERSIONS.join(', ')}`);
  }
  if (EVM_VERSIONS.indexOf(m.evmVersion) > EVM_VERSIONS.indexOf(HARNESS_EVM_VERSION)) {
    fail(
      'evmVersion',
      `"${m.evmVersion}" is past ${HARNESS_EVM_VERSION}; test/harness.js runs Hardfork.Shanghai ` +
        'and would report a valid contract as an invalid opcode. Raise the harness first',
    );
  }
  if (!['finalized', 'confirmations'].includes(m.finality)) {
    fail('finality', 'must be "finalized" or "confirmations"');
  }
  if (!isPositiveInt(m.confirmations)) fail('confirmations', 'must be a positive integer');
  // Seconds per origin block, for the time a revealed preimage needs to reach
  // QRL (lib/epoch.js revealBudgetSeconds). Twelve where absent.
  if (m.blockSeconds !== undefined && !isPositiveInt(m.blockSeconds)) fail('blockSeconds', 'must be a positive integer');
  if (!isPositiveInt(m.deliveryMarginSeconds)) {
    fail('deliveryMarginSeconds', 'must be a positive integer');
  }
  // A public RPC caps eth_getLogs ranges, and the cap is per provider rather
  // than per chain, so it is configured and not guessed.
  if (m.logChunkBlocks !== undefined && !isPositiveInt(m.logChunkBlocks)) {
    fail('logChunkBlocks', 'must be a positive integer');
  }
  if (!Number.isInteger(m.deployedFromBlock) || m.deployedFromBlock < 0) {
    fail('deployedFromBlock', 'must be a non-negative integer');
  }

  if (!Array.isArray(m.assets) || m.assets.length === 0) fail('assets', 'must be a non-empty array');
  const seen = new Set();
  m.assets.forEach((a, i) => {
    const at = `assets[${i}]`;
    if (typeof a.symbol !== 'string' || !a.symbol) fail(`${at}.symbol`, 'missing');
    // A test double is deployed by scripts/deploy-evm.js, which writes its
    // address back; until then it has none. Only a testnet manifest may list
    // one — a double anchored beside real value would be a token anyone mints.
    if (a.mock !== undefined) {
      if (m.profile === undefined || m.profile === 'spec') {
        fail(`${at}.mock`, 'a test double is listed only on a time-compressed manifest');
      }
      if (!MOCKS.includes(a.mock)) fail(`${at}.mock`, `must be one of ${MOCKS.join(', ')}`);
      if (a.rebasing !== (a.mock === 'MockRebasingAsset')) fail(`${at}.rebasing`, `does not match ${a.mock}`);
    }
    if (a.address !== null || a.mock === undefined) {
      try {
        toChecksum(a.address);
      } catch (e) {
        fail(`${at}.address`, e.message);
      }
      if (a.address !== toChecksum(a.address)) {
        fail(`${at}.address`, 'must be EIP-55 checksummed, so a transposed character is caught');
      }
      const key = toHex(a.address);
      if (seen.has(key)) fail(`${at}.address`, 'listed twice; one escrow is deployed per asset');
      seen.add(key);
    }
    // Where an operator acquires a real asset for a seed or an anchor
    // (scripts/lib/assets.js). A double is minted and names none.
    if (a.source !== undefined) {
      if (a.mock !== undefined) fail(`${at}.source`, 'a test double is minted and names no source');
      if (!SOURCES.includes(a.source)) fail(`${at}.source`, `must be one of ${SOURCES.join(', ')}`);
    }
    if (typeof a.rebasing !== 'boolean') fail(`${at}.rebasing`, 'must be true or false');
    if (typeof a.correlationGroup !== 'string' || !a.correlationGroup) {
      fail(`${at}.correlationGroup`, 'must be the string the registry hashed to admit the asset');
    }
    if (!isPositiveInt(a.exitBoundBps) || a.exitBoundBps > 10000) {
      fail(`${at}.exitBoundBps`, 'must be between 1 and 10000');
    }
    if (a.escrow !== null) {
      try {
        toChecksum(a.escrow);
      } catch (e) {
        fail(`${at}.escrow`, e.message);
      }
    }
  });

  // The QRL account length the escrows serve (whitepaper §3.2, D14): fixed in
  // each escrow's constructor, so it is named here rather than guessed.
  if (m.qrlOwnerLength !== undefined && m.qrlOwnerLength !== 20 && m.qrlOwnerLength !== 64) {
    fail('qrlOwnerLength', 'must be 64 (a QIP-55 QRL leg) or 20 (the legacy line)');
  }
  // The signer set a relay is deployed with (whitepaper §3.6): k of n with
  // n / 2 < k <= n. Absent, one of one.
  if (m.rootSigners !== undefined) {
    const { threshold: k, signers: n } = m.rootSigners || {};
    if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || n > 16 || k > n || 2 * k <= n) {
      fail('rootSigners', 'must be { threshold, signers } with signers / 2 < threshold <= signers <= 16');
    }
  }
  // The product's court on the QRL leg (scripts/lib/deploy.js): the real one
  // or the stand-in; ARK_COURT in the environment overrides it.
  if (m.court !== undefined && m.court !== 'real' && m.court !== 'mock') fail('court', 'must be "real" or "mock"');
  // The Q-Day oracle the QRL leg reads: contracts/core's (a governance record
  // is then REQUIRED, and must be live on the chain) or the double (any record
  // is then ignored). Absent: core's where a live record exists, else the double.
  if (m.qday !== undefined && m.qday !== 'ArkQDayOracle' && m.qday !== 'MockQDayOracle') {
    fail('qday', 'must be "ArkQDayOracle" (contracts/core\'s, from the governance record) or "MockQDayOracle"');
  }
  // The QRL network whose governance stack the leg reads (one stack per
  // network, 2026-10-07: ARK, veARK, the governor, the timelock, the Q-Day
  // oracle and ArkPhase, shared by every product on that genesis), its record
  // where it is not `deployments/governance-<network>.json`, and whether this
  // relayer may bootstrap the stack after a devnet reset when none is live
  // (scripts/lib/governance.js, engine/redeploy.js).
  if (m.governance !== undefined && m.governance !== null) {
    const g = m.governance;
    if (typeof g !== 'object') fail('governance', 'must be { network, record?, selfDeploy }');
    if (g.network !== undefined && (typeof g.network !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(g.network))) {
      fail('governance.network', 'must be a QRL network name in lower case, e.g. private-qrvm');
    }
    if (g.record !== undefined && (typeof g.record !== 'string' || !/^[\w./-]+\.json$/.test(g.record) || g.record.includes('..'))) {
      fail('governance.record', 'must be a .json path inside this repository, e.g. deployments/governance-<network>.json');
    }
    if (g.network !== undefined && g.record !== undefined && !g.record.endsWith(`governance-${g.network}.json`)) {
      fail('governance.record', `names another network than governance.network (${g.network}); one record per network`);
    }
    if (g.selfDeploy !== undefined && typeof g.selfDeploy !== 'boolean') fail('governance.selfDeploy', 'must be true or false');
    if (m.qday === 'MockQDayOracle' && g.selfDeploy) fail('governance.selfDeploy', 'a manifest on the Q-Day double reads no governance record');
  }
  // The authority chain a deployment committed to, written by deployOrigin.
  if (m.authority !== undefined && m.authority !== null) {
    const a = m.authority;
    const hex32 = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
    if (!Array.isArray(a.generations) || !a.generations.length || !a.generations.every((g) => Array.isArray(g) && g.length === a.signers && g.every(hex32))) {
      fail('authority.generations', 'must list, per generation, one 32-byte root per signer');
    }
    if (!Array.isArray(a.commits) || a.commits.length !== a.generations.length || !a.commits.every(hex32)) {
      fail('authority.commits', 'must hold one 32-byte commitment per generation');
    }
    if (!Number.isInteger(a.treeHeight) || a.treeHeight < 1 || a.treeHeight > 20) fail('authority.treeHeight', 'must be 1..20');
  }

  if (!m.addresses || typeof m.addresses !== 'object') fail('addresses', 'missing');
  // No premium destination: the premium share is held in the escrow for the
  // auction of whitepaper §4.7 and leaves only by a settlement leaf naming its
  // destination, so there is no address to configure for it.
  for (const field of ['relay', 'operationsDestination']) {
    const v = m.addresses[field];
    if (v === undefined) fail(`addresses.${field}`, 'missing; use null before deployment');
    if (v !== null) {
      try {
        toChecksum(v);
      } catch (e) {
        fail(`addresses.${field}`, e.message);
      }
    }
  }

  return m;
}

/**
 * Whether the manifest's origin chain is a shared, public network (a real EVM
 * chain) rather than a stand-in the operator owns end to end (the harness or
 * the private enclave). On a shared network the deployment refuses to leave
 * governance, the attestation sealer and the relayer on one account
 * (scripts/lib/deploy.js), and the relayer does not act on the Q-Day double
 * (engine/relayer.js mockQdayActs). Audit 2026-09-27, D2.
 */
/**
 * A network other people use: an EVM origin chain, unless the manifest says
 * `"shared": false` — a private rehearsal whose origin is a local node
 * (rehearsal-v3, audit 2026-10-03), where every role is the deployer as on
 * the enclave.
 */
const isShared = (m) => (m.shared === false ? false : (m.client || 'evm') === 'evm');

/** The `bytes32` the registry admitted this asset under. */
const correlationGroupHash = (group) => keccak256(toUtf8Bytes(group));

const manifestPath = (chain) => path.join(STAKINGS, chain, 'chain.json');

function load(chain) {
  const p = manifestPath(chain);
  if (!fs.existsSync(p)) throw new ManifestError(`no chain manifest at ${p}`);
  const m = validate(JSON.parse(fs.readFileSync(p, 'utf8')));
  return { ...m, profile: m.profile || 'spec', client: m.client || 'evm' };
}

/**
 * The chains this tree holds.
 *
 * A directory under `ecdsa-stakings/` is a chain if and only if it carries a
 * `chain.json`. That is what excludes `shared/` and `relayer/` without anyone
 * maintaining a denylist that a new directory would silently fall outside of.
 */
function chains({ profile } = {}) {
  return fs
    .readdirSync(STAKINGS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(STAKINGS, e.name, 'chain.json')))
    .map((e) => e.name)
    .filter((n) => !profile || load(n).profile === profile)
    .sort();
}

module.exports = {
  isShared,
  validate,
  load,
  chains,
  manifestPath,
  correlationGroupHash,
  EVM_VERSIONS,
  HARNESS_EVM_VERSION,
  PROFILES,
  MOCKS,
  MAINNET_CHAIN_IDS,
  ManifestError,
};
