/**
 * Deploying a testnet-profile deployment, once, for three callers.
 *
 * The one rule this module exists to enforce: **the local run and the public
 * one deploy through the same code.** `scripts/e2e-local.js` (the ZVM harness),
 * `scripts/deploy-evm.js` and `scripts/deploy-testnet.js` all land here, so a
 * deployment order that works on the harness is the order that runs on Hoodi,
 * and a mistake in it is found in seconds rather than after a faucet.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

const { evmToQrl, iface, qrlBuild, QRL_DEPOSIT_CONTRACT, ROOT } = require('./chains');
const { profile: buildProfile } = require('./profile');
const { deployLarge } = require('./chunked');
const { replaceSecrets } = require('./env');
const manifestLib = require('../../ecdsa-stakings/relayer/lib/manifest');
const { authorityChain, thresholdAdmissible } = require('../../ecdsa-stakings/relayer/lib/authority');
const { RelayerState } = require('../../ecdsa-stakings/relayer/engine/state');
const { toChecksum, toHex, toQ } = require('../../ecdsa-stakings/relayer/lib/addresses');
const { LEG_KEYS, PHASE_KEY, checkGovernanceRecord, recordCandidates, networkOf, fundingPlan, fundAccounts } = require('./governance');

const ONE = 10n ** 18n;

/**
 * 2,048 leaves per generation. One root per epoch and a migration horizon at
 * 8,000 bps leave 1,638 roots — 80 days of 70-minute epochs — and each of the
 * three later generations of the authority chain as many again once activated
 * (whitepaper §3.6). Height 12 would double both and cost every relayer start
 * another eight seconds of key generation per signer.
 */
const TREE_HEIGHT = 11;

/**
 * The signer set a relay is deployed with (whitepaper §3.6, §3.7): the
 * manifest's `rootSigners`, `{ threshold, signers }`, and one of one where it
 * names none — phase 1 of whitepaper §3.7, a single signing authority, which
 * every testnet deployment has been. Refused where n / 2 < k <= n fails.
 */
function rootSignersOf(m) {
  const conf = m.rootSigners || { threshold: 1, signers: 1 };
  const k = Number(conf.threshold);
  const n = Number(conf.signers);
  if (!thresholdAdmissible(k, n)) throw new Error(`${m.name}: rootSigners ${k} of ${n} is not admissible (n / 2 < k <= n, n <= 16)`);
  return { threshold: k, signers: n };
}

/**
 * The QRL account length the escrows of a manifest serve (whitepaper §3.2,
 * D14): 64 where the QRL leg carries QIP-55, 20 on the legacy line. Named in
 * the manifest, never guessed: an escrow built for the wrong line refuses
 * every beneficiary its chain can produce.
 */
function qrlOwnerLengthOf(m) {
  if (m.qrlOwnerLength === 64 || m.qrlOwnerLength === 20) return m.qrlOwnerLength;
  throw new Error(`${m.name}: the manifest names no qrlOwnerLength — 64 for a QIP-55 (testnet v3) QRL leg, 20 for the legacy line`);
}

/** Seeding minimum, in asset units, when the manifest names none and sizes no requirement. */
const DEFAULT_SEED_MINIMUM = 10n ** 18n;

/**
 * The seeding deposit of whitepaper §4.2 (EC-05, 2026-09-30):
 * `seedingDepositBps` of K_0, the capital requirement of the notional the
 * admission audit sizes the escrow for, rounded up (the model's
 * `seedingDepositMinimumUnits`). A manifest states K_0 in base units as
 * `auditRequirement`; an explicit `seedMinimum` still wins.
 */
const SEEDING_DEPOSIT_BPS = 500n;
function seedMinimumOf(a) {
  if (a.seedMinimum) return BigInt(a.seedMinimum);
  if (a.auditRequirement) return (BigInt(a.auditRequirement) * SEEDING_DEPOSIT_BPS + 9_999n) / 10_000n;
  return DEFAULT_SEED_MINIMUM;
}

/**
 * The escrow's `AUDIT_YIELD_RATE` (constructor argument since 2026-09-30,
 * EC-08 / PV-04): the admission audit's reference yield as one epoch of gross
 * yield per unit of notional, 1e18 fixed point, the rate the reserve gate of
 * `anchorCommitted` reads before an epoch has closed with a yield of its own.
 * A manifest states the audit's yield per annum as `auditYieldBps`; the
 * admission yield (`admissionYieldBps`, else 220) stands in where it does not.
 * An epoch is seven days and a year 365 on every profile, since a profile
 * scales the day and not the ratio. Rounded up, toward refusing a commitment.
 */
function auditYieldRateOf(a) {
  const bps = BigInt(a.auditYieldBps ?? a.admissionYieldBps ?? DEFAULT_ADMISSION_YIELD_BPS);
  if (bps <= 0n) throw new Error(`${a.symbol || 'asset'}: auditYieldBps must be positive (the escrow refuses a zero rate)`);
  const den = 10_000n * 365n;
  return (bps * 10n ** 18n * 7n + den - 1n) / den;
}

/** QRL per origin unit, for every average the valuation double reports. */
const PRICE = 10_000n * ONE;
/**
 * A book partly covered, priced on the scarcity slope rather than at the target:
 * twenty units of cover at the modelled price. It is what the offline harness
 * subscribes (`scripts/e2e-local.js`), not a default — see `bondPrincipalOf`.
 */
const BOND_PRINCIPAL = 200_000n * ONE;

/**
 * Bond principal the deployer subscribes, in QRL wei: the manifest's
 * `bondPrincipal`, and nothing when it names none.
 *
 * Bond principal is what bondholders bought. A deployment that subscribed from
 * its own account would show a book covered by nobody's decision — the site
 * would read it as demand. A team allocation is made by writing it into the
 * manifest, where it is visible and deliberate. An unsubscribed book is a real
 * state: `covered` is zero, the premium is zero, and anchoring still opens.
 */
function bondPrincipalOf(m) {
  return m.bondPrincipal ? BigInt(m.bondPrincipal) : 0n;
}
/** The book's realised origin yield, read at the oracle's book-wide key: 2.20%, above the floor. */
const BOOK_YIELD_BPS = 220;
/** The yield an asset is admitted on when the manifest names none: 2.20%, above the floor at stage 1. */
const DEFAULT_ADMISSION_YIELD_BPS = 220;

const envKey = (chain) => chain.toUpperCase().replace(/-/g, '_');

/**
 * The court's constructor constants (technical reference §3.4): the minimum
 * juror stake, which is also the stake one seat holds (s_min of yellow paper
 * §5.1); `base_orig`, the deposit base in base units of the origin asset,
 * 0.01 of an 18-decimal asset (yellow paper §5.1, 2026-10-06: the smallest
 * loss heard, and at the settlement price at the assertion the base of the
 * first deposit; it replaced a base of 1,000 QRL, which moved the smallest
 * loss heard with the rate); the fee of one coherent seat, seven of which are
 * the least first deposit. A manifest may name another base as
 * `courtDepositBaseOrig` (base units); it is not derived from the seeding
 * minimum. The book has one price key (OC-ORC-07), so one base serves it.
 * And the ARK reference price the price double reports at `(0, ARK)` where
 * no valuation oracle of the protocol is named — 100 QRL an ARK puts the
 * bound of one first-round determination at 799,920 QRL.
 */
const JUROR_MIN_STAKE = 10_000n * ONE;
const COURT_DEPOSIT_BASE_ORIG = 10n ** 16n;
const JUROR_FEE = 100n * ONE;

/** The court's `base_orig` for manifest `m`: its `courtDepositBaseOrig`, else the reference 1e16; above zero. */
function courtDepositBaseOrigOf(m) {
  const v = m && m.courtDepositBaseOrig != null ? BigInt(m.courtDepositBaseOrig) : COURT_DEPOSIT_BASE_ORIG;
  if (v <= 0n) throw new Error(`${(m && m.name) || 'manifest'}: courtDepositBaseOrig must be above zero (base units of the origin asset)`);
  return v;
}
const ARK_REFERENCE_PRICE = 100n * ONE;

/**
 * The valuation oracle the registry is wired to (yellow paper §6.1, staking
 * CLAUDE.md item 122): `ArkReferenceOracle`, the production contract a
 * reporter quorum feeds, or `MockPriceOracle`, the posted double. Chosen by
 * `ARK_PRICE_ORACLE`, else the manifest's `priceOracle`, else the double:
 * the real one is silent through its warm-up (thirty days and twenty-four
 * hours of accepted rounds, five hours and ten minutes on the testnet
 * profile), so the harness, `e2e:local` and any run that must price at once
 * keep the double. The registry fixes the oracle when it is wired, so moving
 * a deployment to the real one is a redeploy of the QRL leg after the
 * reporters have run through the warm-up.
 */
const PRICE_ORACLES = ['ArkReferenceOracle', 'MockPriceOracle'];
function priceOracleKindOf(m, env = {}) {
  const kind = env.ARK_PRICE_ORACLE || (m && m.priceOracle) || 'MockPriceOracle';
  if (!PRICE_ORACLES.includes(kind)) throw new Error(`the price oracle is one of ${PRICE_ORACLES.join(', ')} (ARK_PRICE_ORACLE, manifest priceOracle), not ${kind}`);
  return kind;
}

/**
 * The reference venue list of technical reference §3.7 and its freeze list,
 * which names off-chain venues only; the oracle commits their hashes and a
 * report names the one it was formed under. The text is the commitment: a
 * reporter forms its legs from exactly these venues.
 */
const VENUE_LIST = 'ark-staking/venues/v1;QRL/USDT:MEXC,Biconomy,XT;USDT/USD;ETH/USD:Coinbase,Kraken,Binance;cross-check ETH/USD:Chainlink;stETH/ETH:Curve,Chainlink';
const FREEZE_VENUE_LIST = 'ark-staking/venues/freeze/v1;QRL/USDT:MEXC,Biconomy,XT;USDT/USD;ETH/USD:Coinbase,Kraken,Binance';

/**
 * The launch values of the oracle (technical reference §3.7), in the order
 * of `ArkReferenceOracle.Settings`. The round interval and the heartbeat do
 * not scale with a profile, reporters quoting a market in real time: 3,600 s
 * and 21,600 s at the spec profile, 120 s and 600 s on a compressed one.
 */
function oracleSettingsOf(profileName, quorum, overrides = {}) {
  const { keccak256, toUtf8Bytes } = require('ethers');
  const compressed = (profileName || 'spec') !== 'spec';
  const pick = (k, d) => (overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== '' ? Number(overrides[k]) : d);
  return [
    quorum,
    pick('roundIntervalSeconds', compressed ? 120 : 3600),
    pick('heartbeatSeconds', compressed ? 600 : 21600),
    pick('maxStepBps', 1000),
    300,
    1500,
    2,
    keccak256(toUtf8Bytes(VENUE_LIST)),
    keccak256(toUtf8Bytes(FREEZE_VENUE_LIST)),
    ARK_REFERENCE_PRICE,
  ];
}

/**
 * Launch-value overrides of the oracle's round interval, heartbeat and step
 * limit, from `<CHAIN>_ORACLE_ROUND_INTERVAL_SECONDS` / `ORACLE_ROUND_INTERVAL_SECONDS`,
 * `..._ORACLE_HEARTBEAT_SECONDS`, `..._ORACLE_MAX_STEP_BPS`. Inside the
 * ranges of technical reference §3.7, which the constructor enforces; unset,
 * the reference values. The harness's oracle scenario sets a 60 s interval:
 * at 120 s and 1,000 bps the compressed profile's 24-hour average can fall at
 * most 1 - 0.9^5, about 41%, in a day (five rounds in a 600 s day), short of
 * the breaker's 5,000 bps, so the breaker cannot fire there at the reference
 * values.
 */
function oracleOverridesOf({ env = {}, chain }) {
  const read = (name) => env[`${envKey(chain)}_${name}`] || env[name] || null;
  return {
    roundIntervalSeconds: read('ORACLE_ROUND_INTERVAL_SECONDS'),
    heartbeatSeconds: read('ORACLE_HEARTBEAT_SECONDS'),
    maxStepBps: read('ORACLE_MAX_STEP_BPS'),
  };
}

/**
 * The reporter addresses the leg would wire, where it wires the real oracle;
 * none otherwise. What the funding plan tops up (QRL_ROLE_FUNDING).
 */
function oracleReporterAddressesOf({ env = {}, chain, manifest: m }) {
  if (priceOracleKindOf(m, env) !== 'ArkReferenceOracle') return [];
  return oracleReportersOf({ env, chain }).reporters.map((a) => toHex(a));
}

/**
 * The reporter set of the oracle, from `<CHAIN>_ORACLE_REPORTERS` or
 * `ORACLE_REPORTERS` (comma-separated QRL addresses; the keys stay with the
 * reporters), and its quorum from `ORACLE_REPORTER_QUORUM`, else the least
 * majority. The contract refuses a set outside 3 - 9, a quorum at or below
 * half of it, and a reporter that is governance, the timelock's guardian or
 * proposer, the deployer or the sealer (I41).
 */
function oracleReportersOf({ env = {}, chain }) {
  const raw = env[`${envKey(chain)}_ORACLE_REPORTERS`] || env.ORACLE_REPORTERS || '';
  const reporters = raw.split(',').map((a) => a.trim()).filter(Boolean);
  if (reporters.length < 3) throw new Error(`${chain}: ArkReferenceOracle needs ORACLE_REPORTERS (or ${envKey(chain)}_ORACLE_REPORTERS), three to nine reporter addresses, comma-separated`);
  const q = env[`${envKey(chain)}_ORACLE_REPORTER_QUORUM`] || env.ORACLE_REPORTER_QUORUM;
  const quorum = q ? Number(q) : Math.floor(reporters.length / 2) + 1;
  return { reporters, quorum };
}

/**
 * contracts/core's governance deployment for this QRL network, where there
 * is one, read from disk (its liveness is `liveGovernanceRecord`'s question).
 * One stack per QRL network (2026-10-07), so the record is the network's,
 * whichever origin manifest asks. Looked for, in order: `explicit`;
 * `GOVERNANCE_RECORD` or `<CHAIN>_GOVERNANCE_RECORD` (a path); the network's
 * record (`deployments/governance-<network>.json`, the network from the
 * manifest's `governance.network` or `governance.record`, governance.js
 * `networkOf`); the record written under the origin chain's name before
 * 2026-10-07 (`governance-<chain>.json`, a fallback until the next
 * redeploy); and last `../core/deployments/governance-<qrlChainId>.json`
 * beside this repository (what core's `scripts/deploy-governance.js` writes,
 * keyed by chain id unless `GOV_NETWORK` named it otherwise). Null where there
 * is none: the harness, a private enclave with no governance deployed. What it
 * supplies: ARK, veARK, the Q-Day oracle, the timelock that becomes
 * governance, the governor the court's terminal step answers to, and
 * `ArkPhase` where the record names it (a record from before 2026-10-07
 * does not; `deployQrlLeg` refuses to wire a new leg to such a stack).
 */
const GOVERNANCE_KEYS = LEG_KEYS;
function governanceRecordOf({ env = {}, chain, qrlChainId, manifest: m = null, explicit = null }) {
  const named = explicit || env.GOVERNANCE_RECORD || env[`${envKey(chain)}_GOVERNANCE_RECORD`] || null;
  const candidates = named ? [path.resolve(ROOT, named)] : [...recordCandidates(chain, m), path.join(ROOT, '..', '..', 'ecosystem', 'contracts', 'deployments', `governance-${qrlChainId}.json`)];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    if (named) throw new Error(`governance record ${named} not found`);
    return null;
  }
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = record.addresses || {};
  for (const k of GOVERNANCE_KEYS) {
    if (!a[k]) throw new Error(`governance record ${file} names no ${k}`);
  }
  if (record.chainId !== undefined && Number(record.chainId) !== Number(qrlChainId)) {
    throw new Error(`governance record ${file} is for chain ${record.chainId}, this QRL chain is ${qrlChainId}`);
  }
  const keys = a[PHASE_KEY] ? [...GOVERNANCE_KEYS, PHASE_KEY] : GOVERNANCE_KEYS;
  return { file, record, network: record.network || networkOf(chain, m), addresses: Object.fromEntries(keys.map((k) => [k, toHex(a[k])])) };
}

/**
 * The governance record the QRL leg may be wired to on this chain: found as
 * `governanceRecordOf` finds it, then held to the chain — its genesis, code at
 * every address, and a probe of its wiring (`checkGovernanceRecord`). A record
 * that fails is STALE and is refused, never wired to: after a devnet reset
 * yesterday's addresses are empty or hold some other contract of today's
 * deployment. Null where none exists and the manifest does not require one
 * (`qday: "ArkQDayOracle"` requires one; `qday: "MockQDayOracle"` ignores any).
 */
async function liveGovernanceRecord({ client, env = {}, chain, manifest: m, qrlChainId, explicit = null }) {
  if (m && m.qday === 'MockQDayOracle') return null;
  const gov = governanceRecordOf({ env, chain, qrlChainId, manifest: m, explicit });
  if (!gov) {
    if (m && m.qday === 'ArkQDayOracle') {
      throw new Error(`${chain}: the manifest's Q-Day oracle is core's ArkQDayOracle and no governance record exists for chain ${qrlChainId}; ` +
        `deploy it first (npm run deploy:governance -- --chain ${chain}), or let the relayer do it (--redeploy-qrl)`);
    }
    return null;
  }
  const check = await checkGovernanceRecord({ client, record: gov.record });
  if (!check.ok) {
    throw new StaleGovernanceError(`governance record ${path.relative(ROOT, gov.file)} is ${check.state}: ${check.reason}. ` +
      `Redeploy it (npm run deploy:governance -- --chain ${chain}; the relayer does so itself with --redeploy-qrl) before the QRL leg`);
  }
  return { ...gov, legacy: check.legacy };
}

class StaleGovernanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleGovernanceError';
  }
}

/**
 * The ecosystem phase a new leg's parameter set reads (item 129, 2026-10-07):
 * `{ kind, address?, reason }`. `core` where the network's record names
 * ArkPhase; `mock` (a `MockArkPhase` the deployer operates, deployed with the
 * leg) where there is no record — the harness, the Kurtosis enclave — or, on
 * a manifest that is not shared, a record from before ArkPhase; `refused` on
 * a shared manifest whose record predates ArkPhase: a stand-in the relayer's
 * key could move would put the threat stage in one key's hands, so the stack
 * gets ArkPhase first (`npm run deploy:governance`, which adds it to a live
 * stack) or is redeployed whole after a reset.
 */
function phaseSourceOf({ gov, manifest: m }) {
  if (gov && gov.addresses[PHASE_KEY]) return { kind: 'core', address: gov.addresses[PHASE_KEY], reason: `${PHASE_KEY} of ${path.relative(ROOT, gov.file)}` };
  if (!gov) return { kind: 'mock', reason: 'no governance record: MockArkPhase, operated by the deployer' };
  if (!manifestLib.isShared(m)) return { kind: 'mock', reason: `${path.relative(ROOT, gov.file)} predates ArkPhase; a private manifest gets MockArkPhase, operated by the deployer` };
  return {
    kind: 'refused',
    reason: `${path.relative(ROOT, gov.file)} names no ArkPhase (a stack deployed before 2026-10-07): add it to the live stack first (npm run deploy:governance -- --chain <c>), or let the relayer redeploy the whole stack after a reset`,
  };
}

/** Five zero rows: the parameter set's reference phase rows (a zero row-0 mask selects them; ArkStakeParams `_referenceRows`). */
const REFERENCE_PHASE_ROWS = [0, 1, 2, 3, 4].map(() => [0, 0, 0]);
/** The one ArkPhase view the deployment reads before it builds on one. */
const PHASE_VIEWS = new Interface(['function epochLength() view returns (uint256)']);

/** Whether a build's ArkStakeParams is from before item 129 (a three-argument constructor, no ArkPhase). */
function paramsPredatesPhase(build) {
  const file = path.join(build, 'ArkStakeParams.json');
  if (!fs.existsSync(file)) return false;
  const ctor = JSON.parse(fs.readFileSync(file, 'utf8')).abi.find((x) => x.type === 'constructor');
  return Boolean(ctor) && ctor.inputs.length < 5;
}

/**
 * Who holds what on the QRL leg (audit 2026-09-27, D2): governance of the
 * parameter set, the registry and the delegation; the `MockAttestation`
 * sealer; the operator of the Q-Day and price doubles; and the deploying
 * account, which on the VPS is also the relayer (`--redeploy-qrl`).
 *
 * Until then all of them were the deployer, immutably. On a SHARED manifest
 * (a real origin chain, `manifestLib.isShared`) each is read from the
 * environment — `<CHAIN>_GOVERNANCE_ADDRESS` or `GOVERNANCE_ADDRESS`, likewise
 * `SEALER_ADDRESS` and `ORACLE_OPERATOR_ADDRESS` — and the deployment refuses
 * to run where governance, the sealer and the deployer are not three distinct
 * accounts, unless `ALLOW_SHARED_KEYS=1` says the operator means it. The
 * oracle operator defaults to the deployer and is not part of that check: the
 * relayer no longer acts on the Q-Day double there (engine/relayer.js).
 *
 * On a local manifest (the harness, the private enclave) the environment is
 * NOT read and every role is the deployer: the harness seals from the
 * deploying account, and an operator's VPS settings in .env must not reach it.
 *
 * Governance is handed over, not set: the leg is deployed and wired with the
 * deployer governing (admission needs it), then `proposeGovernance` names the
 * account, which completes the handover itself with `acceptGovernance`
 * (IGovernanceHandover, whitepaper §6.3). Where it is core's timelock
 * (OC-GOV-03) the parameter set and the delegation are built under it and the
 * registry is accepted by it in the same run (`handOverToTimelock`). The
 * sealer and the operator are handed over in one step, being test doubles.
 */
function resolveRoles({ me, env = {}, manifest: m, chain, governance: governanceOverride = null }) {
  const same = (a, b) => toHex(a).toLowerCase() === toHex(b).toLowerCase();
  if (!manifestLib.isShared(m)) return { governance: governanceOverride ? toHex(governanceOverride) : me, sealer: me, oracleOperator: me, shared: false };
  const read = (name) => env[`${envKey(chain)}_${name}`] || env[name] || null;
  // Core's timelock where a live governance record names it: GOVERNANCE_ADDRESS
  // is then not read (the leg's governance IS the timelock).
  const governance = governanceOverride || read('GOVERNANCE_ADDRESS') || me;
  const sealer = read('SEALER_ADDRESS') || me;
  const oracleOperator = read('ORACLE_OPERATOR_ADDRESS') || me;
  const clashes = [];
  if (same(governance, me)) clashes.push('governance is the deployer');
  if (same(sealer, me)) clashes.push('the attestation sealer is the deployer (the relayer)');
  if (same(governance, sealer)) clashes.push('governance is the attestation sealer');
  // The price double's operator moves every settlement figure the bond and
  // the court convert at; on a shared network it is not the relayer's key
  // either (item 38, 2026-09-28).
  if (same(oracleOperator, me)) clashes.push("the price double's operator is the deployer (the relayer)");
  if (clashes.length && env.ALLOW_SHARED_KEYS !== '1') {
    throw new Error(
      `${chain} is a shared network and ${clashes.join('; ')}. Set GOVERNANCE_ADDRESS, SEALER_ADDRESS and ORACLE_OPERATOR_ADDRESS ` +
        `(or ${envKey(chain)}_GOVERNANCE_ADDRESS / _SEALER_ADDRESS / _ORACLE_OPERATOR_ADDRESS) to accounts other than the deployer ` +
        '(GOVERNANCE_ADDRESS may be left unset where a governance record names the timelock), ' +
        'with QRL_SEALER_MNEMONIC on the relayer host for the sealer, or ALLOW_SHARED_KEYS=1 to deploy on one key knowingly',
    );
  }
  return { governance: toHex(governance), sealer: toHex(sealer), oracleOperator: toHex(oracleOperator), shared: true, clashes };
}

/**
 * The escrow contract an asset of the manifest is deployed as. An asset whose
 * `source` is Lido gets the form that also takes ETH and stakes it through
 * Lido in the same call; its share accounting is stETH's own.
 */
function escrowForm(a) {
  if (a.source === 'lido') return 'ArkStakeEscrowLido';
  return a.rebasing ? 'ArkStakeEscrowShares' : 'ArkStakeEscrowUnits';
}
const deploymentPath = (chain) => path.join(ROOT, 'deployments', `testnet-${chain}.json`);

/**
 * The origin leg: the test doubles a manifest lists without an address, the
 * relay behind a fresh signer set and its authority chain, and one escrow per
 * asset.
 *
 * Each signer gets a fresh seed, and each seed grows the four generations of
 * that signer's trees (`lib/authority.js`); the relay is constructed with
 * generation 1's roots, the threshold, the height and the commitment to the
 * rest, and the manifest records every generation's roots (`authority`), which
 * are public and which the relayer's extension reads. In a deployment of real
 * value each signer generates its own seed on its own host and hands over only
 * its roots; generating them in one place is the testnet's phase 1.
 *
 * `persistEnv` writes the seeds to .env for a relayer in another process
 * (`<CHAIN>_OTS_SEED_<i>`, and `<CHAIN>_OTS_SEED` for signer 0 as before); a
 * local run keeps them in memory and hands them to the relayer directly,
 * because .env belongs to the deployments an operator means to keep.
 */
/**
 * The relay a redeploy retires, and whether it may be retired (audit
 * 2026-09-29, OL-04 / R3-04): refused while any escrow the manifest names for
 * it still holds value only that relay's future roots can release, unless
 * `allowStrand` — a redeploy used to leave the old relay's escrows open with
 * their seed overwritten, and 0.31 stETH of positions nobody could release.
 * Since the re-audit of 2026-09-30 (ORIGIN-08) that is any of the stake, the
 * position and queued shares, the buffer (the seed among it), the premium
 * pot, the reserve and a loss owed — not `positionShares` alone — or any
 * that cannot be read. An escrow with no code on this chain (a regenerated
 * harness) holds nothing.
 * Returns `{ relay, stranded }`: the retiring relay (null where the manifest
 * names none) and the escrows passed over under `allowStrand`.
 */
/** What an escrow holds that only its relay's future roots release (ORIGIN-08). */
const STRAND_READS = ['totalStake', 'positionShares', 'queuedShares', 'bufferShares', 'auctionShares', 'psrShares', 'lossOwedUnits'];

async function checkRetiringRelay({ client, manifest: out, build, allowStrand = false, log = console.log }) {
  const relay = out.addresses && out.addresses.relay ? toChecksum(out.addresses.relay) : null;
  if (!relay) return { relay: null, stranded: [] };
  const stranded = [];
  for (const a of out.assets || []) {
    if (!a.escrow) continue;
    const escrow = toHex(a.escrow);
    if ((await client.code(escrow)) === '0x') continue;
    const held = [];
    for (const name of STRAND_READS) {
      let v = null;
      try {
        const r = await client.call(escrow, iface(escrowForm(a), build), name, []);
        v = BigInt(Array.isArray(r) ? r[0] : r);
      } catch {
        v = null;
      }
      if (v !== 0n) held.push(`${name} ${v === null ? 'unreadable' : String(v)}`);
    }
    if (!held.length) continue;
    stranded.push({ symbol: a.symbol, escrow: a.escrow, held: held.join(', ') });
  }
  if (stranded.length && !allowStrand) {
    const list = stranded.map((s) => `${s.symbol} ${s.escrow} (${s.held})`).join('; ');
    throw new Error(
      `the relay ${relay} this redeploy retires still has escrows holding positions: ${list}. Release them first, or pass --allow-strand ` +
        'to redeploy anyway (its seed is archived, never lost)',
    );
  }
  for (const s of stranded) log(`   WARNING  --allow-strand: escrow ${s.escrow} (${s.symbol}) of the retired relay ${relay} still holds value its roots release (${s.held})`);
  return { relay, stranded };
}

async function deployOrigin({ client, chain: chainName, manifest: m, build, log = console.log, persistEnv = true, treeHeight = TREE_HEIGHT, stateRoot = path.join(ROOT, '.relayer'), manifestFile = manifestLib.manifestPath(chainName), allowStrand = false, envFile }) {
  if (!fs.existsSync(path.join(build, 'ArkEpochRootRelay.json'))) {
    throw new Error(`no testnet artifacts in ${path.relative(ROOT, build)} — run: npm run compile:evm -- --profile testnet`);
  }
  // A relayer running for this chain on this host is signing from the state
  // this deployment is about to retire; its next save would land in a
  // directory that has been moved, and its next root would sign for the old
  // relay from a state the new one no longer keeps. Stop it first.
  const stateDir = path.join(stateRoot, chainName);
  const holder = RelayerState.liveHolder(stateDir);
  if (holder) throw new Error(`the ${chainName} relayer is running (process ${holder}); stop it before deploying a new relay`);
  const head = await client.head();

  const out = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  // Before anything is deployed: where the seed and the operations share go
  // (re-audit 2026-09-30, ORIGIN-07). A random, keyless address used to be
  // minted and written back to the manifest, and the seed return and every
  // operations share then went to an address nobody holds.
  if (!out.addresses || !out.addresses.operationsDestination) {
    throw new Error(
      `the ${chainName} manifest names no addresses.operationsDestination: set it to the protocol treasury's address on this chain, ` +
        'which receives the seed return and the operations share; no escrow is deployed to a random one',
    );
  }
  // And the relay this retires, and the positions its escrows hold (OL-04).
  const retiring = await checkRetiringRelay({ client, manifest: out, build, allowStrand, log });
  const { threshold, signers } = rootSignersOf(out);
  const ownerLength = qrlOwnerLengthOf(out);
  const seeds = Array.from({ length: signers }, () => '0x' + crypto.randomBytes(32).toString('hex'));
  const t0 = Date.now();
  const chain = authorityChain(seeds, treeHeight);
  log(`signer set: ${threshold} of ${signers}, four generations of 2^${treeHeight} leaves each, commitment ${chain.commits[0].slice(0, 18)}…  (${Date.now() - t0} ms)`);
  for (const a of out.assets) {
    // A double's address from a chain that has since been regenerated names no
    // code here; the escrow built on it would call nothing and fail to deploy.
    if (a.mock && (!a.address || (await client.code(toHex(a.address))) === '0x')) {
      a.address = toChecksum(await client.deploy(a.mock, [], build, 3_000_000));
      log(`   ${a.symbol.padEnd(8)} ${a.mock} ${a.address}`);
    }
  }

  const relay = await client.deploy('ArkEpochRootRelay', [chain.generations[0], threshold, treeHeight, chain.commits[0]], build, 4_000_000);
  log(`   relay    ${relay}`);
  if (persistEnv) {
    // Written only once the relay that trusts them exists: a seed in .env with
    // no relay behind it is harmless, the reverse is not.
    // The retiring relay's seeds are archived first, to .env.archive-<relay>-<time>
    // (OL-04): a seed overwritten in place was the only key to that relay.
    // Neither path prints a value.
    const key = envKey(chainName);
    const entries = Object.fromEntries(seeds.map((s, i) => [`${key}_OTS_SEED_${i}`, s]));
    entries[`${key}_OTS_SEED`] = seeds[0];
    entries[`${key}_OTS_HEIGHT`] = String(treeHeight);
    const { archive } = replaceSecrets(entries, retiring.relay || 'no-relay', envFile ? { file: envFile } : {});
    if (archive) log(`   the retiring relay's seeds archived to ${path.relative(ROOT, archive) || archive} (gitignored; keep it offline)`);
  }

  // The previous relay's state names leaves of a key set that is being
  // retired; kept, it would let the relayer believe leaves were spent that
  // were not, or the reverse. Moved, not deleted: it records what was signed.
  //
  // Only now, with the new relay deployed and its seed persisted. Moved any
  // earlier, a failure in between leaves the OLD seed and the OLD relay beside
  // an empty state — a relayer that would sign the old relay's next leaf with
  // no record of what that leaf already signed. Moved here, a failure leaves
  // either the old state beside the old relay, or a seed that opens no relay
  // the manifest names, and the relayer refuses both.
  if (fs.existsSync(stateDir)) {
    const aside = `${stateDir}.${Date.now()}`;
    fs.renameSync(stateDir, aside);
    log(`previous relayer state moved to ${path.relative(ROOT, aside)}`);
  }

  const operations = toHex(out.addresses.operationsDestination);

  for (const a of out.assets) {
    const form = escrowForm(a);
    const seedMinimum = seedMinimumOf(a);
    const auditYieldRate = auditYieldRateOf(a);
    // The Shares form is told where the share accounting lives. For stETH and
    // for the double it is the token itself; the manifest can name another
    // contract where an asset keeps its shares elsewhere. It is a constructor
    // argument because there is no owner to set it later (whitepaper §3.2).
    // The Lido form is stETH's own accounting by construction, and takes ETH.
    // The audit's reference yield is the last argument of every form (EC-08).
    const args = form === 'ArkStakeEscrowShares'
      ? [toHex(a.address), toHex(a.shareAccounting || a.address), relay, operations, seedMinimum, ownerLength, auditYieldRate]
      : [toHex(a.address), relay, operations, seedMinimum, ownerLength, auditYieldRate];
    // The escrow's code deposit alone is ~3.3M gas at 16 KB; 10M leaves room and stays under
    // the 16,777,216 per-transaction cap an EIP-7825 chain such as Hoodi enforces.
    a.escrow = toChecksum(await client.deploy(form, args, build, 10_000_000));
    log(`   escrow   ${a.symbol.padEnd(8)} ${form.padEnd(22)} ${a.escrow}  seed minimum ${seedMinimum}  audit yield rate ${auditYieldRate}`);
  }

  out.addresses.relay = toChecksum(relay);
  out.addresses.operationsDestination = toChecksum(operations);
  out.deployedFromBlock = Number(head.latest);
  // The authority chain the relay commits to, public: generation g's roots
  // and the commitment it holds while active. The relayer signs an extension
  // to the next generation from here (whitepaper §3.6).
  out.authority = { threshold, signers, treeHeight, generations: chain.generations, commits: chain.commits };
  manifestLib.validate(out);
  fs.writeFileSync(manifestFile, JSON.stringify(out, null, 2) + '\n');
  log(`manifest updated -> ${path.relative(ROOT, manifestFile)}`);
  return { manifest: manifestLib.load(chainName), relay, seeds, seed: seeds[0], treeHeight, threshold, operations };
}

/**
 * The staking venue bond principal earns in, and the validators behind it:
 * `ArkStakingPool`, whose `ArkBondDelegation` runs validators on the chain's own
 * genesis deposit contract with the pool as its counterparty and a concentration
 * bound of 10,000 bps, so 40,000 QRL from any depositors funds a validator.
 * `setDelegation` and `setVenue` are one-shot and their deployer's, so `client`
 * must be the account that deployed the pool and the staking contract.
 */
async function deployPool({ client, build, staking, params, attestation, governance = null, profile = 'spec', chunked = null, log = console.log }) {
  const pool = await deployLarge(client, 'ArkStakingPool', [], build, { chunked, log });
  const delegation = await deployDelegation({ client, build, counterparty: pool, params, attestation, concentrationBps: 10_000, governance, profile, chunked, log });
  await client.send(pool, iface('ArkStakingPool', build), 'setDelegation', [delegation]);
  if (staking) {
    await client.send(staking, iface('ArkBondStaking', build), 'setVenue', [pool]);
    // A loss the delegation books reaches the bond in the same transaction (OC-LEGB-13).
    await client.send(pool, iface('ArkStakingPool', build), 'setLossListener', [staking]);
  }
  log(`   ${'ArkStakingPool'.padEnd(18)} ${pool}  venue of the bond's staking contract`);
  return { pool, delegation };
}

/**
 * Bond principal's way to QRL staking: `ArkBondDelegation` on the chain's own
 * genesis deposit contract, named by the staking contract (whitepaper §3.4).
 *
 * The enclave has the deposit contract at Q4242…42 and the harness installs its
 * code and storage there. A delegation pointed at an empty address would take
 * every `fund` and deposit nothing, so its absence stops the deployment rather
 * than being wired around. The delegation's bond is the staking contract, never
 * the bond itself: it pays its counterparty with raw calls, which `ArkCatBond`
 * refuses (CLAUDE.md §8.1). `setDelegation` is one-shot and the staking
 * contract's deployer's, so `client` must be the account that deployed it.
 * `governance` is the delegation's governance from construction (core's
 * timelock where a governance record exists, OC-GOV-03); the deployer where
 * it is null.
 */
/**
 * The beacon chain's wait from a deposit to the first epoch a voluntary exit
 * is accepted, in seconds: SHARD_COMMITTEE_PERIOD on the devnet (the e2e's
 * 16 × 128 × 12 s). QRL_EXIT_ELIGIBLE_SECONDS in .env overrides it for a
 * chain whose beacon parameters differ.
 */
const EXIT_ELIGIBLE_SECONDS = 16 * 128 * 12;

/**
 * `ArkBondDelegation.ELIGIBLE_EPOCHS` for a profile (OC-LEGB-04): the wait
 * above in the profile's epochs, rounded up, and one more for the
 * activation queue and the epoch the funding lands in part-way through.
 */
function eligibleEpochsOf(profile, env = {}) {
  const seconds = Number(env.QRL_EXIT_ELIGIBLE_SECONDS || EXIT_ELIGIBLE_SECONDS);
  const epoch = 7 * buildProfile(profile).day;
  return BigInt(Math.ceil(seconds / epoch) + 1);
}

async function deployDelegation({ client, build, counterparty, params, attestation, concentrationBps = 0, governance = null, profile = 'spec', chunked = null, log = console.log }) {
  // Where the genesis put its deposit contract. QRL_DEPOSIT_CONTRACT in .env
  // overrides the v2 default for a QIP-55 (testnet v3) chain, whose genesis
  // address is the 64-byte `Q` + '42' x 64 — the env form may be Q or 0x and is
  // normalised here. Only on the real QRL client: the harness installs the
  // deposit contract's code at the 20-byte default, whatever .env says.
  const depositContract = client.kind === 'qrl' && client.env && client.env.QRL_DEPOSIT_CONTRACT
    ? toHex(client.env.QRL_DEPOSIT_CONTRACT)
    : QRL_DEPOSIT_CONTRACT;
  const depositCode = await client.code(depositContract);
  if (!depositCode || depositCode === '0x') throw new Error(`no deposit contract at ${depositContract} on this QRL chain`);
  // Through deployLarge: on the v3 build the delegation's init code crosses
  // the direct-deploy ceiling (the choice is by measured size, never by name).
  const eligible = eligibleEpochsOf(profile, client.env || {});
  const delegation = await deployLarge(client, 'ArkBondDelegation', [counterparty, governance || client.address, depositContract, params, attestation, concentrationBps, eligible], build, { chunked, log });
  log(`   ${'ArkBondDelegation'.padEnd(18)} ${delegation}  deposit contract ${depositContract}, exit eligible ${eligible} epoch(s) after funding`);
  return delegation;
}

/** Core's `ArkTimelock.acceptGovernanceOf` (OC-GOV-03) and the handover views of a governed contract, written out. */
const TIMELOCK_ACCEPT = new Interface(['function acceptGovernanceOf(address target)']);
const HANDOVER_VIEWS = new Interface(['function proposeGovernance(address next)', 'function governance() view returns (address)', 'function pendingGovernance() view returns (address)']);

/**
 * Hands `target` (governed by the deploying account) to core's timelock in
 * this run (OC-GOV-03): `proposeGovernance(timelock)`, then the timelock
 * accepts at once through `acceptGovernanceOf`, which anyone may call. Checks
 * the result: governance() == timelock, pendingGovernance() == 0. Where the
 * timelock predates that function (an older core build named by a record) the
 * proposal stays pending, as before the fix, and false is returned.
 */
async function handOverToTimelock({ client, timelock, target, log = console.log }) {
  await client.send(target, HANDOVER_VIEWS, 'proposeGovernance', [timelock]);
  try {
    await client.call(timelock, TIMELOCK_ACCEPT, 'acceptGovernanceOf', [target]);
  } catch (e) {
    log(`   WARNING the timelock ${timelock} does not accept at once (built before OC-GOV-03?): ${e.shortMessage || e.message}`);
    return false;
  }
  await client.send(timelock, TIMELOCK_ACCEPT, 'acceptGovernanceOf', [target]);
  const [governance] = await client.call(target, HANDOVER_VIEWS, 'governance');
  const [pending] = await client.call(target, HANDOVER_VIEWS, 'pendingGovernance');
  if (toHex(governance).toLowerCase() !== toHex(timelock).toLowerCase() || BigInt(toHex(pending)) !== 0n) {
    throw new Error(`the handover of ${target} to ${timelock} did not complete: governance ${governance}, pending ${pending}`);
  }
  return true;
}

/**
 * The build the QRL leg is deployed from: against a QIP-55 (testnet v3) node
 * the QRVM build at the manifest's profile (`build-qrvm<suffix>/`) where it
 * exists, else the v2 build of that profile. Throws where neither exists.
 */
function qrlLegBuild(client, m) {
  const qrvmBuild = path.join(ROOT, `build-qrvm${buildProfile(m.profile).suffix}`);
  const dir = client.kind === 'qrl' && fs.existsSync(path.join(qrvmBuild, 'ArkStakeRegistry.json')) ? qrvmBuild : qrlBuild(m.profile);
  if (!fs.existsSync(path.join(dir, 'ArkStakeRegistry.json'))) {
    throw new Error(`no artifacts in ${path.basename(dir)}/ — run: npm run compile -- --profile ${m.profile}`);
  }
  return dir;
}

/**
 * What `deployQrlLeg` would deploy and how, WITHOUT sending or reading
 * anything from a node: the build, every contract with its measured init and
 * runtime size and its route (direct, or through ChunkedDeployer), the roles
 * and their clashes, the court, the Q-Day oracle and the governance record it
 * would look for. `errors` lists what would stop the real run. The
 * `--plan` of `deploy:testnet` prints it.
 */
function planQrlLeg({ client, chain, manifest: m, env = client.env || {} }) {
  const errors = [];
  const build = qrlLegBuild(client, m);
  const courtKind = (env && env.ARK_COURT) || m.court || 'real';
  const qrlChainId = Number(env.QRL_CHAIN_ID || 0);
  let gov = null;
  try {
    gov = m.qday === 'MockQDayOracle' ? null : governanceRecordOf({ env, chain, qrlChainId, manifest: m });
  } catch (e) {
    errors.push(e.message);
  }
  const needsGov = m.qday === 'ArkQDayOracle';
  const willHaveGov = Boolean(gov) || needsGov;
  // The ecosystem phase (item 129): the network's ArkPhase, or the double
  // where no stack exists; a stack the relayer will deploy brings its own.
  let phase = gov ? phaseSourceOf({ gov, manifest: m }) : needsGov ? { kind: 'core', reason: 'ArkPhase of the network record the relayer deploys (--redeploy-qrl) or npm run deploy:governance writes' } : phaseSourceOf({ gov: null, manifest: m });
  // A record from before ArkPhase on a manifest whose relayer bootstraps the
  // network's stack: the redeploy adds ArkPhase to it on this genesis, or
  // deploys a whole stack after a reset (engine/redeploy.js), before the leg.
  if (phase.kind === 'refused' && m.governance && m.governance.selfDeploy) {
    phase = { kind: 'core', reason: `${path.relative(ROOT, gov.file)} predates ArkPhase: the relayer's redeploy (or npm run deploy:governance) adds it to the network's stack before the leg` };
  }
  if (phase.kind === 'refused') errors.push(phase.reason);
  const width = client.address.length === 130 ? 64 : 20;
  const timelock = gov ? gov.addresses.ArkTimelock : willHaveGov ? '0x' + 'ee'.repeat(width) : null;
  let roles = null;
  try {
    roles = resolveRoles({ me: client.address, env, manifest: m, chain, governance: timelock });
  } catch (e) {
    errors.push(e.message);
  }
  const names = [
    'ChunkedDeployer', ...(phase.kind === 'mock' ? ['MockArkPhase'] : []), 'ArkStakeParams', 'ArkStakeRegistry', 'ProceedsLedger', 'MockAttestation',
    ...(willHaveGov ? [] : ['MockQDayOracle']), priceOracleKindOf(m, env), 'ArkBondCoupon', 'ArkCatBondRecovery',
    'ArkCatBondSettlement', 'ArkCatBond',
    ...(courtKind === 'real' ? [...(willHaveGov ? [] : ['ArkToken', 'MockVeArk']), 'ArkJurorPool', 'ArkStakeCourt'] : ['MockDisputeCourt']),
    'ArkBondStaking', 'PremiumSwap', 'ArkStakingPool', 'ArkBondDelegation',
  ];
  const { CHUNK_SAFE } = require('./chunked');
  const { EIP170_LIMIT, DIRECT_DEPLOY_LIMIT } = require('./limits');
  const rows = names.map((n) => {
    const art = JSON.parse(fs.readFileSync(path.join(build, `${n}.json`), 'utf8'));
    const init = (art.bytecode.length - 2) / 2;
    const runtime = (art.deployedBytecode.length - 2) / 2;
    const route = init > DIRECT_DEPLOY_LIMIT ? 'chunked' : 'direct';
    if (runtime > EIP170_LIMIT) errors.push(`${n}: runtime ${runtime} is past EIP-170 ${EIP170_LIMIT}`);
    if (init > 49152) errors.push(`${n}: init ${init} is past EIP-3860 49,152`);
    if (route === 'chunked' && !CHUNK_SAFE.has(n)) errors.push(`${n}: ${init} bytes of init code and not declared safe to create through ChunkedDeployer`);
    return { contract: n, init, runtime, route };
  });
  if (!m.addresses.relay) errors.push(`${chain} has no relay yet — deploy the origin leg first (npm run deploy:evm -- --chain ${chain})`);
  if (paramsPredatesPhase(build)) errors.push(`${path.relative(ROOT, build)}/ArkStakeParams.json predates the ecosystem phase (item 129): rebuild at profile ${m.profile}`);
  // The valuation oracle, its reporters and their gas (QRL_ROLE_FUNDING).
  let oracle = null;
  try {
    const kind = priceOracleKindOf(m, env);
    if (kind === 'ArkReferenceOracle') {
      const set = oracleReportersOf({ env, chain });
      const settings = oracleSettingsOf(m.profile, set.quorum, oracleOverridesOf({ env, chain }));
      const funding = fundingPlan({ env, me: client.address, reporters: set.reporters.map((a) => toHex(a)) });
      if (roles) {
        for (const r of set.reporters) {
          for (const [role, a] of [['the deployer', client.address], ['governance', roles.governance], ['the sealer', roles.sealer]]) {
            if (a && toHex(a).toLowerCase() === toHex(r).toLowerCase()) errors.push(`oracle reporter ${r} is ${role}: the oracle refuses a reporter holding another role (I41)`);
          }
        }
      }
      oracle = {
        kind,
        reporters: set.reporters,
        quorum: set.quorum,
        roundIntervalSeconds: settings[1],
        heartbeatSeconds: settings[2],
        maxStepBps: settings[3],
        funding: funding.map((f) => ({ address: f.address, label: f.label, targetQrl: String(f.target / ONE) })),
      };
    } else {
      oracle = { kind };
    }
  } catch (e) {
    errors.push(e.message);
  }
  return {
    oracle,
    build: path.relative(ROOT, build),
    court: courtKind,
    qday: willHaveGov ? 'ArkQDayOracle (core)' : 'MockQDayOracle',
    governance: gov ? path.relative(ROOT, gov.file) : needsGov ? 'required; none on disk: the relayer deploys it (--redeploy-qrl), or npm run deploy:governance' : null,
    arkPhase: { kind: phase.kind, address: phase.address || null, source: phase.reason, rows: 'reference (five zero rows)' },
    roles,
    rows,
    errors,
  };
}

/**
 * The QRL leg, wired to one origin chain's manifest, with that chain's assets
 * admitted. Reads `build-testnet/`: a QRL leg on the spec clock would number
 * epochs 144 times more slowly than the relay it talks to. Against a QIP-55
 * (testnet v3) node it reads the QRVM build (`build-qrvm<suffix>/`,
 * ARK_QRVM=1) where one exists — the v2 bytecode does not run on the 512-bit
 * QRVM — and its every EVM-address argument is zero-extended to the 64-byte
 * `address` slot (`evmToQrl`).
 *
 * ON THE v3 PATH THE DEPLOYMENT RECORD'S QRL ADDRESSES ARE WRITTEN IN THE
 * SELF-DESCRIBING `Q`+128 FORM (origin-chain addresses stay 0x+40). The
 * frontend and devnet-up consumers of this record are ported to that form in
 * a later phase; until then they read v2-shaped records only.
 */
async function deployQrlLeg({ client, chain, manifest: m, log = console.log, court: courtOverride = null, governanceRecord = null }) {
  // The court: the argument, else ARK_COURT, else the manifest's `court`, else the real one.
  const courtKind = courtOverride || (client.env && client.env.ARK_COURT) || m.court || 'real';
  // The QRL leg is built at the same profile as the origin leg it serves: a
  // leg on another clock would number every epoch differently.
  const onQrl = client.kind === 'qrl';
  const QRL_BUILD = qrlLegBuild(client, m);
  if (!m.addresses.relay) throw new Error(`${chain} has no relay yet — deploy the origin leg first`);

  // An origin-chain 20-byte address into a Hyperion `address` parameter:
  // zero-extended on the v3 leg, untouched on the harness (32-byte words).
  const evmAddr = (a) => (onQrl ? evmToQrl(a) : a);
  const ZERO_EVM = '0x' + '00'.repeat(20);
  // How an address of this leg is written into the record: Q+128 on v3.
  const rec = (a) => (onQrl ? toQ(a) : a);

  const me = client.address;
  if (courtKind !== 'real' && courtKind !== 'mock') throw new Error(`the court is 'real' or 'mock' (ARK_COURT, manifest court), not ${courtKind}`);
  const startBlock = (await client.head()).latest;
  // Recorded so a relayer can tell a devnet regenerated from genesis, which it
  // may redeploy on, from a node that is behind or an RPC on another chain,
  // which it must not (R40, engine/relayer.js qrlLegState).
  const qrlChainId = Number(await client.chainId());
  const genesis = await client.genesis();
  // contracts/core's governance, where it is deployed on this chain (phase
  // C4): its ARK, veARK and Q-Day oracle replace the doubles, its timelock
  // becomes governance of the three governed contracts, and its governor is
  // the one caller of the court's terminal step. Held to this chain before
  // it is used: a record from before a devnet reset is refused (stale).
  const gov = await liveGovernanceRecord({ client, env: client.env || {}, chain, manifest: m, qrlChainId, explicit: governanceRecord });
  const ext = gov ? gov.addresses : {};
  if (gov) log(`   governance record ${path.relative(ROOT, gov.file)}${gov.legacy ? ' (no genesis hash: accepted on its probe)' : ''}: ARK, veARK, the Q-Day oracle and the timelock are core's`);
  // Before anything is sent: a refusal here costs nothing (D2).
  const roles = resolveRoles({ me, env: client.env || {}, manifest: m, chain, governance: gov ? ext.ArkTimelock : null });
  if (roles.shared && roles.clashes && roles.clashes.length) log(`   WARNING ALLOW_SHARED_KEYS=1: ${roles.clashes.join('; ')}`);
  // Every deployment goes through `deployLarge`, which sends a contract whole
  // when it fits and through `ChunkedDeployer` when it does not — decided from
  // the artifact actually built, never by name: on the QRVM (v3) build the
  // registry (20,368 bytes of init code) and the delegation (20,188) cross the
  // 18,000-byte ceiling beside the bond, on the v2 builds only the bond does.
  const d = (name, args = []) => deployLarge(client, name, args, QRL_BUILD, { chunked, log });
  const abi = (n) => iface(n, QRL_BUILD);

  // First, because everything larger than one QRL request can carry is
  // assembled on chain from pieces (CLAUDE.md §3.1, scripts/lib/chunked.js).
  const chunked = await client.deploy('ChunkedDeployer', [], QRL_BUILD);

  // The launch set is written at construction and nowhere else since
  // 2026-09-28 (design §6.2); all zeros is the constructor's reference values
  // of whitepaper chapter 6. The deployer is named, not read from msg.sender:
  // the parameter set is above the single-request ceiling and may be created
  // through ChunkedDeployer. Later changes are keyed diffs (`setParamsDiff`),
  // each in force from the next epoch boundary.
  const launchSet = abi('ArkStakeParams').deploy.inputs[2].components.map(() => 0);
  // OC-GOV-03 (audit 2026-10-03): where a governance record names core's
  // timelock, it governs the parameter set and the delegation from
  // construction, since bring-up makes no governance call on either. The
  // registry alone starts under the deployer, for the admission transactions,
  // and is handed over in this same run (below): no deployer key governs past
  // it, across a devnet reset or otherwise.
  const timelock = gov ? toHex(ext.ArkTimelock) : null;
  // The ecosystem phase (item 129, 2026-10-07): the threat stage is derived
  // from it, and the parameter set holds it as an immutable, so it exists
  // first. The network's ArkPhase where the record names it; MockArkPhase,
  // operated by the deployer, where there is no stack (phaseSourceOf). Five
  // zero rows select the reference per-phase rows.
  const phaseSource = phaseSourceOf({ gov, manifest: m });
  if (phaseSource.kind === 'refused') throw new Error(`${chain}: ${phaseSource.reason}`);
  if (paramsPredatesPhase(QRL_BUILD)) throw new Error(`${path.relative(ROOT, QRL_BUILD)}/ArkStakeParams.json predates the ecosystem phase (item 129): rebuild at profile ${m.profile}`);
  const phase = phaseSource.kind === 'core' ? toHex(ext[PHASE_KEY]) : await d('MockArkPhase');
  {
    const want = BigInt(7 * buildProfile(m.profile).day);
    const [len] = await client.call(phase, PHASE_VIEWS, 'epochLength');
    if (BigInt(len) !== want) throw new Error(`${phaseSource.kind === 'core' ? 'ArkPhase' : 'MockArkPhase'} ${rec(phase)} counts epochs of ${len} s; this leg's ArkEpoch is ${want} s at profile ${m.profile} (PhaseEpochMismatch)`);
  }
  if (phaseSource.kind === 'mock') log(`   MockArkPhase       ${rec(phase)}  (${phaseSource.reason})`);
  const params = await d('ArkStakeParams', [timelock || me, me, launchSet, phase, REFERENCE_PHASE_ROWS]);
  const registry = await d('ArkStakeRegistry', [me, params, me]);
  const ledger = await d('ProceedsLedger');
  const attestation = await d('MockAttestation');
  // Core's ArkQDayOracle answers the three views the registry and the bond
  // read (`IQDayOracle`: declared, frozen, declaredAt), byte for byte.
  const qday = ext.ArkQDayOracle || (await d('MockQDayOracle'));
  // The valuation oracle (yellow paper §6.1; `priceOracleKindOf`). The real
  // one governs itself, under the timelock from construction where a
  // governance record names one, as the parameter set does; its reporter keys
  // are refused where they hold another role (I41).
  const oracleKind = priceOracleKindOf(m, client.env || {});
  const realOracle = oracleKind === 'ArkReferenceOracle';
  const oracleSet = realOracle ? oracleReportersOf({ env: client.env || {}, chain }) : null;
  const oracle = realOracle
    ? await d('ArkReferenceOracle', [
      timelock || me,
      params,
      qday,
      oracleSet.reporters.map((a) => toHex(a)),
      [...new Set([me, roles.sealer].map((a) => toHex(a)))],
      oracleSettingsOf(m.profile, oracleSet.quorum, oracleOverridesOf({ env: client.env || {}, chain })),
    ])
    : await d('MockPriceOracle');

  // The registry takes only governance and the parameters, so it exists before the
  // bond and the bond holds it as an immutable. The bond takes the deployer as its
  // wiring authority explicitly: created through `ChunkedDeployer`, its
  // `msg.sender` would be that contract, which can make no call with the right.
  const coupon = await d('ArkBondCoupon', [params, ledger, registry]);
  // Build 2's module (phase C3): deployed first, on the bond's own five
  // dependencies, and named in the bond's constructor, which checks them — it
  // no longer fits inside the bond's creation code (EIP-3860).
  // Phase C3b: the claimant record and the per-escrow subrogation, named in
  // the settlement module's constructor, which checks it as the bond checks it.
  const recovery = await d('ArkCatBondRecovery', [registry, params, coupon, qday, attestation]);
  const settlement = await d('ArkCatBondSettlement', [registry, params, coupon, qday, attestation, recovery]);
  const bond = await d('ArkCatBond', [registry, params, coupon, qday, attestation, me, settlement]);
  // The product's court and its juror pool (phase C4), or the stand-in that
  // states findings (ARK_COURT=mock). ARK is core's where a governance record
  // names it; otherwise the tree's copy, its incentive allocation to the
  // deployer and the other five to fixed placeholder accounts. veARK likewise,
  // or a double the oracle operator runs. The court creates its findings module.
  const courtAddrs = {};
  let court;
  if (courtKind === 'real') {
    const placeholder = (b) => evmAddr('0x' + b.repeat(20));
    const vestStart = Number(genesis.timestamp) || Math.floor(Date.now() / 1000);
    const ark = ext.ArkToken || (await d('ArkToken', [me, placeholder('91'), placeholder('92'), placeholder('93'), placeholder('94'), placeholder('95'), vestStart]));
    const veArk = ext.VeArk || (await d('MockVeArk'));
    const jurorPool = await d('ArkJurorPool', [ark, veArk, JUROR_MIN_STAKE, me]);
    const governor = ext.ArkGovernor || me;
    court = await d('ArkStakeCourt', [jurorPool, bond, registry, params, ark, governor, courtDepositBaseOrigOf(m), JUROR_FEE]);
    courtAddrs.ArkJurorPool = jurorPool;
    courtAddrs.ArkStakeCourt = court;
    courtAddrs.ArkCourtFindings = (await client.call(court, abi('ArkStakeCourt'), 'FINDINGS'))[0];
    courtAddrs[ext.ArkToken ? 'ArkToken' : 'ArkTokenDouble'] = ark;
    courtAddrs[ext.VeArk ? 'VeArk' : 'MockVeArk'] = veArk;
    if (ext.ArkGovernor) courtAddrs.ArkGovernor = governor;
  } else {
    court = await d('MockDisputeCourt', [bond]);
    courtAddrs.MockDisputeCourt = court;
  }
  const staking = await d('ArkBondStaking', [bond]);
  // The premium swap reads the registry's price, the parameters' reserve ladder
  // and the attested forward roots, and delivers to the ledger — and, since
  // phase C3b, the juror fraction of each lot to the court's fee pool
  // (whitepaper §6.2); with the stand-in court, none (zero: the ledger). After
  // everything the registry's address depends on, so a redeploy on a fresh
  // chain still lands the registry where the site expects it (R40).
  const swap = await d('PremiumSwap', [registry, params, ledger, attestation, courtAddrs.ArkStakeCourt || evmAddr(ZERO_EVM)]);

  const addrs = {
    ChunkedDeployer: chunked,
    ArkStakeParams: params,
    ArkStakeRegistry: registry,
    ProceedsLedger: ledger,
    ArkBondCoupon: coupon,
    ArkCatBond: bond,
    ArkCatBondSettlement: settlement,
    ArkCatBondRecovery: recovery,
    ArkBondStaking: staking,
    PremiumSwap: swap,
    ...courtAddrs,
    MockAttestation: attestation,
    [ext.ArkQDayOracle ? 'ArkQDayOracle' : 'MockQDayOracle']: qday,
    [phaseSource.kind === 'core' ? 'ArkPhase' : 'MockArkPhase']: phase,
    [oracleKind]: oracle,
  };
  for (const [n, a] of Object.entries(addrs)) log(`   ${n.padEnd(18)} ${a}`);

  await client.send(params, abi('ArkStakeParams'), 'setRegistry', [registry]);
  // THE LEDGER'S BOND IS THE COUPON ACCOUNT. `ArkBondCoupon` is what draws from
  // the ledger and carries its residue, and both are the ledger's bond-only calls.
  await client.send(coupon, abi('ArkBondCoupon'), 'setBond', [bond]);
  await client.send(ledger, abi('ProceedsLedger'), 'setBond', [coupon]);
  // The ledger's one depositor: the swap credits the QRL of a claimed lot, and nothing else credits anything.
  await client.send(ledger, abi('ProceedsLedger'), 'setSwap', [swap]);
  await client.send(registry, abi('ArkStakeRegistry'), 'setDependencies', [attestation, qday, oracle, bond]);
  if (courtAddrs.ArkJurorPool) await client.send(courtAddrs.ArkJurorPool, abi('ArkJurorPool'), 'setCourt', [court]);
  await client.send(bond, abi('ArkCatBond'), 'setCourt', [court]);
  await client.send(bond, abi('ArkCatBond'), 'setStaking', [staking]);
  // The Treasury tops the Cushion up through the ecosystem's router (core
  // QuantumArk-Treasury-Flows §6-§7, 2026-10-13): wired once, by the account
  // that deployed the router, which on a devnet is this relayer.
  if (ext.ArkTreasuryRouter) {
    const ROUTER = [
      { type: 'function', name: 'cushion', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
      { type: 'function', name: 'wireCushion', inputs: [{ name: 'cushion_', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
    ];
    const router = toHex(ext.ArkTreasuryRouter);
    const [wired] = await client.call(router, ROUTER, 'cushion');
    if (/^0x0+$/.test(String(wired))) {
      try {
        await client.send(router, ROUTER, 'wireCushion', [bond]);
        log(`   ArkTreasuryRouter  Cushion -> ${rec(bond)}`);
      } catch (e) {
        log(`   ArkTreasuryRouter  Cushion not wired (${e.message}); its deployer must call wireCushion once`);
      }
    } else {
      log(`   ArkTreasuryRouter  Cushion already wired to ${rec(wired)}; this leg's bond is not the Treasury's top-up target`);
    }
  }
  {
    const { pool, delegation } = await deployPool({ client, build: QRL_BUILD, staking, params, attestation, governance: timelock, profile: m.profile, chunked, log });
    addrs.ArkStakingPool = pool;
    addrs.ArkBondDelegation = delegation;
  }

  if (!realOracle) await client.send(oracle, abi('MockPriceOracle'), 'set', [PRICE, PRICE, PRICE]);
  // The ARK reference price the court values a claim's bound in (yellow paper
  // §5.1): the real oracle holds it from construction (`arkReferencePrice`);
  // the double reports it as its reference and at its key (0, ARK).
  if (courtAddrs.ArkStakeCourt && !realOracle) {
    await client.send(oracle, abi('MockPriceOracle'), 'setArkReferencePrice', [ARK_REFERENCE_PRICE]);
    await client.send(oracle, abi('MockPriceOracle'), 'setPriceFor', [0n, courtAddrs.ArkToken || courtAddrs.ArkTokenDouble, ARK_REFERENCE_PRICE]);
    // Carried at once, so the court can value a SEVERITY finding even if the
    // oracle falls silent before any assertion carried one (OC-ORC-03).
    if (courtAddrs.ArkCourtFindings) await client.send(courtAddrs.ArkCourtFindings, abi('ArkCourtFindings'), 'carryArkPrice', []);
  }
  // The book-wide key the bond reads the realised yield at for the issuance
  // suspension of whitepaper §4.7. Unset, it reads zero, the coupon at exact cover
  // reads zero, and every subscription is refused as below the floor. The
  // zero address is an origin-chain (20-byte) value into an `address`
  // parameter, so it is widened on the v3 leg like any other.
  // With the real oracle the reporters post the yields (`submitYield`).
  if (!realOracle) await client.send(oracle, abi('MockPriceOracle'), 'setYield', [0n, evmAddr(ZERO_EVM), BOOK_YIELD_BPS]);
  const principal = bondPrincipalOf(m);
  if (principal > 0n && realOracle) {
    // Issuance is suspended while the series is silent, through the warm-up.
    log(`   wired; ${principal / ONE} QRL of manifest bondPrincipal NOT subscribed: ArkReferenceOracle is silent until its warm-up ends, and issuance is suspended until then`);
  } else if (principal > 0n) {
    await client.send(bond, abi('ArkCatBond'), 'subscribe', [1, 0], { value: principal });
    log(`   wired; ${principal / ONE} QRL of junior principal subscribed by the deployer (manifest bondPrincipal); threat stage 1 (whitepaper §4.4)`);
  } else {
    log('   wired; no bond principal subscribed (the manifest names none); threat stage 1 (whitepaper §4.4)');
  }

  const assets = [];
  for (const a of m.assets) {
    if (!a.address || !a.escrow) throw new Error(`${chain} asset ${a.symbol} has no address or escrow yet`);
    const group = manifestLib.correlationGroupHash(a.correlationGroup);
    const yieldBps = a.admissionYieldBps || DEFAULT_ADMISSION_YIELD_BPS;
    // The upgrade authority is recorded, not checked, by the registry. A test
    // double has none; stETH on Hoodi has Lido's, which no run here audits.
    // The asset and the authority are origin-chain addresses into `address`
    // parameters: widened on the v3 leg, 20 bytes on the harness.
    const input = [BigInt(m.chainId), evmAddr(toHex(a.address)), group, evmAddr(ZERO_EVM), a.exitBoundBps, yieldBps, a.rebasing, true, true];
    await client.send(registry, abi('ArkStakeRegistry'), 'admitAsset', [input]);
    if (!realOracle) await client.send(oracle, abi('MockPriceOracle'), 'setYield', [BigInt(m.chainId), evmAddr(toHex(a.address)), yieldBps]);
    const key = (await client.call(registry, abi('ArkStakeRegistry'), 'assetKey', [BigInt(m.chainId), evmAddr(toHex(a.address))]))[0];
    log(`   ${a.symbol.padEnd(8)} ${a.correlationGroup.padEnd(20)} y_A ${yieldBps} bps  key ${key.slice(0, 18)}…`);
    assets.push({ symbol: a.symbol, asset: toHex(a.address), escrow: toHex(a.escrow), assetKey: key, correlationGroup: group });
  }

  // The roles leave the deployer last, once admission and every price the
  // doubles report are in place (D2, resolveRoles). Governance only proposed:
  // the named account accepts it on each of the three contracts itself. Where
  // GOVERNANCE_ADDRESS is contracts/core's ArkTimelock, each acceptance is an
  // `acceptGovernance()` operation scheduled through it (48 hours in its
  // table), and from then on every setter reaches these contracts through the
  // timelock's delays: setParamsDiff, setThreatStage(from, to), admitAsset,
  // delistAsset, admitValidator, commitExit, withdrawAdmission.
  //
  // Where core's timelock governs (OC-GOV-03), the parameter set and the
  // delegation were built under it; the registry is proposed to it and the
  // timelock accepts at once (`ArkTimelock.acceptGovernanceOf`, which anyone
  // may call), so the run ends with governance() == timelock on all three
  // and nothing pending. A timelock built before that function existed
  // leaves the registry pending: logged, and `governance:accept` schedules it.
  const differs = (a) => toHex(a).toLowerCase() !== toHex(me).toLowerCase();
  let governanceAccepted = !differs(roles.governance);
  if (timelock) {
    governanceAccepted = await handOverToTimelock({ client, timelock, target: registry, log });
    log(`   ArkTimelock ${rec(timelock)} governs ArkStakeParams and ArkBondDelegation from construction${governanceAccepted ? ', and ArkStakeRegistry from its admissions on; nothing pending' : '; ArkStakeRegistry is proposed to it and waits for an acceptance (governance:accept --schedule)'}`);
  } else if (differs(roles.governance)) {
    const governed = [['ArkStakeParams', params], ['ArkStakeRegistry', registry], ['ArkBondDelegation', addrs.ArkBondDelegation]];
    if (realOracle) governed.push(['ArkReferenceOracle', oracle]);
    for (const [n, addr] of governed) {
      await client.send(addr, abi(n), 'proposeGovernance', [roles.governance]);
    }
    log(`   governance proposed to ${rec(roles.governance)} on ${governed.map(([n]) => n).join(', ')}; that account must call acceptGovernance() on each`);
  }
  if (differs(roles.sealer)) {
    await client.send(attestation, abi('MockAttestation'), 'transferSealer', [roles.sealer]);
    log(`   MockAttestation sealer is ${rec(roles.sealer)}; the relayer seals with QRL_SEALER_MNEMONIC`);
  }
  if (differs(roles.oracleOperator)) {
    if (!ext.ArkQDayOracle) await client.send(qday, abi('MockQDayOracle'), 'transferOperator', [roles.oracleOperator]);
    if (courtAddrs.MockVeArk) await client.send(courtAddrs.MockVeArk, abi('MockVeArk'), 'transferOperator', [roles.oracleOperator]);
    if (!realOracle) await client.send(oracle, abi('MockPriceOracle'), 'transferOperator', [roles.oracleOperator]);
    log(`   ${ext.ArkQDayOracle ? '' : 'MockQDayOracle, '}${realOracle ? 'no price double' : 'MockPriceOracle'} operated by ${rec(roles.oracleOperator)}`);
  }

  // The reporters' gas (QRL_ROLE_FUNDING, whole QRL, default 100), as the
  // other role accounts a fresh genesis did not fund: after every deployment,
  // so no address of the leg moves with it. The relayer's redeploy tops them
  // up before the leg (engine/redeploy.js); then nothing is sent here.
  let reporterFunding = [];
  if (realOracle) {
    const plan = fundingPlan({ env: client.env || {}, me, reporters: oracleSet.reporters.map((a) => toHex(a)) });
    reporterFunding = await fundAccounts({ client, plan, log });
    if (!reporterFunding.length) log(`   oracle reporters hold their gas float already (${plan.length} of ${oracleSet.reporters.length} named)`);
  }

  // The record's QRL-leg addresses are written in the self-describing Q+128
  // form on the v3 path (origin-chain addresses stay 0x+40); the frontend and
  // devnet-up readers of this file are ported to that form in a later phase.
  const record = {
    profile: 'testnet',
    origin: chain,
    originChainId: m.chainId,
    qrlChainId,
    qrlGenesisHash: genesis.hash,
    qrlGenesisTimestamp: Number(genesis.timestamp),
    network: client.env.QRL_RPC_URL || client.kind,
    deployer: rec(me),
    // Who holds what (D2). `governance` is where it was proposed to; until
    // that account accepts, the deployer still governs. With core's timelock
    // it is accepted in this run (OC-GOV-03).
    roles: {
      governance: rec(roles.governance),
      governanceAccepted,
      sealer: rec(roles.sealer),
      oracleOperator: rec(roles.oracleOperator),
    },
    deployedAt: new Date().toISOString(),
    deployedFromBlock: Number(startBlock),
    qrl: Object.fromEntries(Object.entries(addrs).map(([n, a]) => [n, rec(a)])),
    relay: toHex(m.addresses.relay),
    assets,
    // Which Q-Day oracle the registry and the bond read (phase C3b): core's
    // ArkQDayOracle, access-controlled, whose declaration and freeze the
    // relayer seals into close and freeze leaves on every network; or the
    // double, which it seals only on a local manifest (D2, mockQdayActs).
    // The valuation oracle the registry fixed (yellow paper §6.1).
    priceOracle: realOracle
      ? {
        kind: 'real',
        contract: 'ArkReferenceOracle',
        address: rec(oracle),
        reporters: oracleSet.reporters.map((a) => rec(toHex(a))),
        quorum: oracleSet.quorum,
        settings: Object.fromEntries(['reporterQuorum', 'roundIntervalSeconds', 'heartbeatSeconds', 'maxStepBps', 'maxDispersionBps', 'deviationAlarmBps', 'pauseMaxEpochs'].map((k, i) => [k, Number(oracleSettingsOf(m.profile, oracleSet.quorum, oracleOverridesOf({ env: client.env || {}, chain }))[i])])),
        funded: reporterFunding.map((f) => ({ address: rec(f.address), amount: String(f.amount) })),
        venueList: VENUE_LIST,
        freezeVenueList: FREEZE_VENUE_LIST,
        governance: rec(timelock || me),
        note: 'silent until thirty days and twenty-four hours (profile-scaled) of accepted rounds; no price setter (I41)',
      }
      : { kind: 'mock', contract: 'MockPriceOracle', address: rec(oracle), uncalibrated: ['refPrice'] },
    qday: {
      kind: ext.ArkQDayOracle ? 'real' : 'mock',
      address: rec(qday),
      source: gov ? path.relative(ROOT, gov.file) : null,
    },
    // The ecosystem phase the parameter set reads (item 129): the network's
    // ArkPhase, moved only through its timelock rows; or the double, which the
    // deployer operates (setPhase / setPending / setDeclared, at once).
    arkPhase: phaseSource.kind === 'core'
      ? { kind: 'core', address: rec(phase), source: path.relative(ROOT, gov.file).split(path.sep).join('/'), governance: rec(timelock), rows: 'reference' }
      : { kind: 'mock', contract: 'MockArkPhase', address: rec(phase), operator: rec(me), rows: 'reference', note: 'stand-in: its operator moves the phase, hence the threat stage, at once and at will; never on a shared network' },
    // The governance stack this leg is wired to, and the genesis it was
    // checked on: a relayer that finds another genesis redeploys both.
    governance: gov
      ? {
        record: path.relative(ROOT, gov.file).split(path.sep).join('/'),
        network: gov.network || null,
        genesisHash: gov.record.genesisHash || null,
        addresses: Object.fromEntries(Object.entries(gov.record.addresses).map(([n, a]) => [n, rec(toHex(a))])),
        acceptance: governanceAccepted
          ? 'ArkTimelock governs ArkStakeParams and ArkBondDelegation from construction and accepted ArkStakeRegistry in the deploying run (OC-GOV-03); the proposer multisig still wires the chambers and the court (governance:accept --schedule)'
          : 'the proposer multisig schedules acceptGovernance() on ArkStakeRegistry through ArkTimelock (48 profile-hours) and wires the chambers and the court (governance:accept --schedule)',
      }
      : null,
    // The court (phase C4): its reference values, where its external
    // dependencies came from, and what contracts/core must still do.
    court: courtAddrs.ArkStakeCourt
      ? {
        kind: 'real',
        jurorMinStake: String(JUROR_MIN_STAKE),
        depositBaseOrig: String(courtDepositBaseOrigOf(m)),
        minDeposit: String(7n * JUROR_FEE),
        jurorFee: String(JUROR_FEE),
        arkReferencePrice: String(ARK_REFERENCE_PRICE),
        uncalibrated: ['jurorMinStake', 'depositBaseOrig', 'jurorFee', 'arkReferencePrice'],
        governanceRecord: gov ? path.relative(ROOT, gov.file) : null,
        next: gov
          ? [`ArkGovernor.setCourt(${rec(courtAddrs.ArkStakeCourt)}) through ArkTimelock (30 days), scheduled by governance:accept --schedule with the wiring (OC-GOV-05): until it runs no escalation can be voted`]
          : ['no governor: the deployer answers resolveEscalation (harness and private networks only)'],
      }
      : { kind: 'mock' },
  };
  fs.mkdirSync(path.dirname(deploymentPath(chain)), { recursive: true });
  // The record it replaces is kept: it names the leg the relayer's state was
  // recorded against, and an operator reconciling by hand needs it. A harness
  // chain lives for one process and leaves nothing to reconcile.
  if (client.kind !== 'harness' && fs.existsSync(deploymentPath(chain))) {
    fs.copyFileSync(deploymentPath(chain), deploymentPath(chain).replace(/\.json$/, `.replaced-${Date.now()}.json`));
  }
  fs.writeFileSync(deploymentPath(chain), JSON.stringify(record, null, 2));
  log(`deployment saved -> ${path.relative(ROOT, deploymentPath(chain))}`);
  return record;
}

module.exports = { phaseSourceOf, REFERENCE_PHASE_ROWS, paramsPredatesPhase, priceOracleKindOf, oracleSettingsOf, oracleOverridesOf, oracleReportersOf, oracleReporterAddressesOf, VENUE_LIST, FREEZE_VENUE_LIST, resolveRoles, handOverToTimelock, deployOrigin, checkRetiringRelay, seedMinimumOf, auditYieldRateOf, deployQrlLeg, deployDelegation, deployPool, eligibleEpochsOf, escrowForm, deploymentPath, envKey, rootSignersOf, qrlOwnerLengthOf, governanceRecordOf, liveGovernanceRecord, StaleGovernanceError, qrlLegBuild, planQrlLeg, TREE_HEIGHT, PRICE, BOND_PRINCIPAL, bondPrincipalOf, BOOK_YIELD_BPS, ONE, JUROR_MIN_STAKE, COURT_DEPOSIT_BASE_ORIG, courtDepositBaseOrigOf, JUROR_FEE, ARK_REFERENCE_PRICE };
