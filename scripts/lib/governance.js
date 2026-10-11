/**
 * contracts/core's governance stack, deployed on the QRL leg's chain from the
 * artifacts vendored under `vendor/core-governance/`.
 *
 * The one rule this module exists to enforce: **a governance record is
 * trusted only on the chain that holds it.** The devnet is rebuilt from
 * genesis every day (R40); a record written yesterday names addresses that
 * are empty today, or — the chain replaying the deployer from nonce zero —
 * that hold some other contract of today's deployment. So a record is read
 * only after its genesis hash matches the chain's, every address it names has
 * code, and a probe of the wiring answers as the record says (the timelock's
 * proposer, the oracle's timelock and governor, veARK's governor, the
 * governor's own immutables). Anything else is stale, and the QRL leg is not
 * wired to it.
 *
 * WHY THE STACK IS DEPLOYED FROM HERE AT ALL
 * ------------------------------------------
 * After a devnet reset the relayer on qrl-vps redeploys the QRL leg itself
 * (`--redeploy-qrl`), and the leg reads core's ARK, veARK and Q-Day oracle and
 * hands its governance to core's timelock. Core's checkout is not on that
 * host and the two repositories do not import each other's sources, so the
 * relayer tree carries core's COMPILED artifacts (vendored by
 * `scripts/vendor-governance.js`, hashes in `vendor/core-governance/
 * MANIFEST.json`) and this routine — the same order as core's
 * `scripts/deploy-governance.js` — deploys them through this tree's client,
 * so the harness, the enclave and the VPS run one code path. Core's own script
 * stays the reference for a deployment made by hand from its checkout.
 *
 * The stack, at stage S1 (core CLAUDE.md §4, §4.5): ChunkedDeployer; ArkMultisig
 * proposer and guardian; ArkTimelock(proposer, guardian); ArkToken; VeArk(ark,
 * protocol-owned incl. the timelock); ArkGovernorRules; ArkQDayOracle(timelock,
 * court, bond, cooldown, attesters); ArkGovernor (chunked); ArkPhase(oracle,
 * timelock, epoch length) (2026-10-07, core §3.6); then VeArk and the oracle
 * name the governor (one-shot, from the deploying account).
 *
 * ONE STACK PER QRL NETWORK (2026-10-07)
 * --------------------------------------
 * ARK, veARK, the governor, the timelock, the Q-Day oracle and ArkPhase belong
 * to the ecosystem, not to Ark Staking: every product on a genesis reads the
 * same stack (umbrella CLAUDE.md, "One ecosystem layer for every product").
 * So the record is named by the QRL network, `deployments/governance-<network>
 * .json` (`private-qrvm` for the private v3 devnet, the name contracts/nft
 * uses for the same genesis), not by the origin manifest that happened to
 * bootstrap it. A staking manifest names its network in `governance.network`
 * (or the record itself in `governance.record`); a second origin manifest on
 * the same genesis finds the live record and deploys nothing. The relayer
 * still bootstraps the stack after a devnet reset, as the only process on the
 * VPS, where `governance.selfDeploy` allows it. A record written under the
 * origin chain's name before 2026-10-07 (`governance-<chain>.json`) is still
 * read as a fallback, so a deployment wired to one keeps working until the
 * next redeploy.
 *
 * The configuration is the network's too: unprefixed `GOV_*`, `QDAY_*`,
 * `VEARK_*` and `ARK_<bucket>` keys, with the chain-prefixed form
 * (`HOODI_VPS_GOV_*`) read only where the unprefixed key is absent.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

const { profile: buildProfile } = require('./profile');
const { deployLarge } = require('./chunked');
const { iface, ROOT } = require('./chains');
const manifestLib = require('../../ecdsa-stakings/relayer/lib/manifest');
const { toHex, toQ } = require('../../ecdsa-stakings/relayer/lib/addresses');

const ONE = 10n ** 18n;
/** EIP-3860: the largest creation code a CREATE — ChunkedDeployer's included — accepts. */
const INITCODE_LIMIT = 49152;

/** The artifacts vendored, in core's names; all of them are deployed (ArkPhase since 2026-10-07). */
const GOVERNANCE_CONTRACTS = ['ChunkedDeployer', 'ArkMultisig', 'ArkTimelock', 'ArkToken', 'VeArk', 'ArkGovernorRules', 'ArkQDayOracle', 'ArkGovernor', 'ArkPhase'];
/**
 * The addresses every record names — core's `deploy-governance.js` record
 * keys. `ArkPhase` is not among them: a record written before 2026-10-07 has
 * none and is still live (the deployment being audited is wired to one); where
 * a record names it, it is probed like the rest (`checkGovernanceRecord`).
 */
const RECORD_KEYS = ['ChunkedDeployer', 'ProposerMultisig', 'GuardianMultisig', 'ArkTimelock', 'ArkToken', 'VeArk', 'ArkGovernorRules', 'ArkQDayOracle', 'ArkGovernor'];
/** What the QRL leg reads from a record (scripts/lib/deploy.js); `ArkPhase` besides, where named. */
const LEG_KEYS = ['ArkToken', 'VeArk', 'ArkQDayOracle', 'ArkTimelock', 'ArkGovernor'];
const PHASE_KEY = 'ArkPhase';

const VENDOR_DIR = path.join(ROOT, 'vendor', 'core-governance');
/** ArkToken's five allocation buckets, in constructor order (core ArkAllocation-Design.md A1). */
const BUCKET_NAMES = ['incentives', 'treasury', 'contributors', 'backstop', 'liquidity'];

/**
 * Fills the buckets the manifest leaves unset, each on its own address, since
 * the token reverts `DuplicateBucket`: incentives stay with the deployer (the
 * account the scenarios fund from), the treasury goes to the timelock (its
 * holder by design), and contributors, backstop and liquidity go to inert
 * placeholder addresses nobody signs from. A shared manifest that means it
 * sets all five.
 */
function defaultBuckets(buckets, deployer, timelock, onQrl) {
  const placeholder = (k) => '0x' + '00'.repeat((onQrl ? 64 : 20) - 1) + '0' + String(k);
  const fallback = [deployer, timelock, placeholder(1), placeholder(2), placeholder(3)];
  return buckets.map((b, i) => b || fallback[i]);
}
/** The Q-Day oracle's quorum (core `ArkQDayOracle.QUORUM`): fewer attesters can never certify. */
const QDAY_QUORUM = 5;
const QDAY_PANEL = 9;

const envKey = (chain) => chain.toUpperCase().replace(/-/g, '_');
const lower = (a) => toHex(a).toLowerCase();
const same = (a, b) => Boolean(a) && Boolean(b) && lower(a) === lower(b);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** `vendor/core-governance/build<-qrvm><suffix>`: the v3 line for a QRL node, the harness line otherwise. */
function vendoredLine({ qrvm, profileName }) {
  return path.join(VENDOR_DIR, `build${qrvm ? '-qrvm' : ''}${buildProfile(profileName).suffix}`);
}

/**
 * The vendored build a client deploys from, checked: every artifact present,
 * each still hashing to what the vendoring recorded, each built at this
 * profile's day. Throws with the command that repairs it.
 */
function governanceBuild({ client, profileName }) {
  const dir = vendoredLine({ qrvm: client.kind === 'qrl', profileName });
  const name = path.basename(dir);
  const repair = `build contracts/core at --profile ${profileName} (core scripts/compile.js${client.kind === 'qrl' ? ' with ARK_QRVM=1 HYPC_DOCKER_IMAGE=hypc:local' : ''}) and run: npm run vendor:governance -- --profile ${profileName}`;
  const manifestFile = path.join(VENDOR_DIR, 'MANIFEST.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`no vendored governance artifacts (vendor/core-governance/MANIFEST.json); ${repair}`);
  const line = (JSON.parse(fs.readFileSync(manifestFile, 'utf8')).lines || {})[name];
  if (!line) throw new Error(`vendor/core-governance has no ${name}/; ${repair}`);
  const day = buildProfile(profileName).day;
  if (Number(line.profile && line.profile.day) !== day) throw new Error(`vendor/core-governance/${name} was built at one day = ${line.profile && line.profile.day} s, this profile's is ${day} s; ${repair}`);
  for (const n of GOVERNANCE_CONTRACTS) {
    const file = path.join(dir, `${n}.json`);
    if (!fs.existsSync(file)) throw new Error(`vendor/core-governance/${name}/${n}.json is missing; ${repair}`);
    if (!line.files[n] || sha256(fs.readFileSync(file, 'utf8')) !== line.files[n].sha256) {
      throw new Error(`vendor/core-governance/${name}/${n}.json does not hash to MANIFEST.json: edited by hand or half copied; ${repair}`);
    }
  }
  return dir;
}

/**
 * `deployments/governance-<name>.json`. `name` is a QRL network
 * (`networkOf`); called with an origin chain's name it is the pre-2026-10-07
 * record of that chain, read only as a fallback.
 */
const governanceRecordPath = (name) => path.join(ROOT, 'deployments', `governance-${name}.json`);

/**
 * The QRL network whose stack a staking manifest reads: `governance.network`,
 * else the name in `governance.record` (`governance-<network>.json`), else the
 * manifest's own name — a local or enclave manifest is its own network, one
 * chain per run.
 */
function networkOf(chain, m = null) {
  const g = (m && m.governance) || {};
  if (g.network) return g.network;
  const named = g.record ? /^governance-(.+)\.json$/.exec(path.basename(g.record)) : null;
  return named ? named[1] : chain;
}

/** Where the network's record lives: `governance.record` where the manifest names it, else `governance-<network>.json`. */
function networkRecordPath(chain, m = null) {
  const g = (m && m.governance) || {};
  return g.record ? path.resolve(ROOT, g.record) : governanceRecordPath(networkOf(chain, m));
}

/**
 * The records a manifest may be wired to, in order: the network's, then the
 * one written under the origin chain's name before 2026-10-07 (the live
 * deployment of that date is wired to it until its next redeploy).
 */
function recordCandidates(chain, m = null) {
  return [...new Set([networkRecordPath(chain, m), governanceRecordPath(chain)])];
}

/** ArkPhase's epoch: `ArkEpoch.EPOCH_LENGTH` (7 days) at the profile, 4,200 s at testnet; Ark Staking refuses any other (`PhaseEpochMismatch`). */
const phaseEpochLength = (profileName) => 7 * buildProfile(profileName).day;

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const big = (v, d) => (v === undefined || v === null || v === '' ? d : BigInt(v));
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

/**
 * The stack's configuration for one QRL network, and the reasons it may not
 * be deployed (`errors`, empty when it may). `chain` is the origin manifest
 * asking; it names only the fallback prefix.
 *
 * On a SHARED manifest (a real origin chain, `manifestLib.isShared`) it is
 * read from the environment under core's names — `<NAME>` first (the
 * network's, 2026-10-07), then `<CHAIN>_<NAME>` where the unprefixed key is
 * absent, so a `.env` written before then still deploys: a prefixed key that
 * disagrees with the unprefixed one is reported in `warnings` (names only),
 * never read. The names: `GOV_PROPOSER_OWNERS`/`_THRESHOLD`, `GOV_GUARDIAN_OWNERS`/
 * `_THRESHOLD`, `QDAY_ATTESTERS`, `QDAY_ATTESTER_BOND`, `QDAY_ADVISORY_COOLDOWN`,
 * `QDAY_COURT`, `GOV_PROPOSAL_THRESHOLD_BPS`, `GOV_QDAY_QUORUM_BPS`,
 * `GOV_OBJECTION_THRESHOLD_BPS`, `GOV_ADMISSION_DEPOSIT`, `ARK_INCENTIVES` …
 * `ARK_LIQUIDITY`, `VEARK_PROTOCOL_OWNED`. The multisig owners and the
 * attesters must be accounts other than the deployer (the relayer on the
 * VPS), the attestation sealer and the price double's operator (audit D2,
 * item 38; core design §6.1), unless `ALLOW_SHARED_KEYS=1`. A manifest whose
 * Q-Day oracle is core's needs at least five attesters: fewer can never
 * certify, and the declaration path would be dead on arrival.
 *
 * On a LOCAL manifest (the harness, the enclave standing in) the environment
 * is not read, as `resolveRoles` does not read it: the deployer owns both
 * multisigs one of one and there are no attesters unless `overrides` names
 * them — the e2e scenario does.
 *
 * `advisoryCooldown` is a constructor argument in seconds, which the
 * profile's rewrite cannot reach, so its default is seven of the profile's
 * days (4,200 s at the testnet profile). `epochLength`, ArkPhase's, is never
 * read from the environment: it must equal Ark Staking's `ArkEpoch` at the
 * same profile (`phaseEpochLength`).
 */
function governanceConfig({ env = {}, chain, manifest: m, deployer, roles = {}, overrides = {} }) {
  const shared = manifestLib.isShared(m);
  const day = buildProfile(m.profile).day;
  const warnings = [];
  const present = (v) => v !== undefined && v !== null && v !== '';
  const read = (name) => {
    if (!shared) return undefined;
    const prefixed = env[`${envKey(chain)}_${name}`];
    if (present(env[name])) {
      if (present(prefixed) && prefixed !== env[name]) warnings.push(`${envKey(chain)}_${name} differs from ${name}; the network's ${name} is read`);
      return env[name];
    }
    return present(prefixed) ? prefixed : undefined;
  };
  const c = {
    proposerOwners: list(read('GOV_PROPOSER_OWNERS')),
    proposerThreshold: num(read('GOV_PROPOSER_THRESHOLD'), 0),
    guardianOwners: list(read('GOV_GUARDIAN_OWNERS')),
    guardianThreshold: num(read('GOV_GUARDIAN_THRESHOLD'), 0),
    // Unset buckets are filled at deploy time (`defaultBuckets`): the token
    // refuses two buckets on one address (core ArkToken, 2026-10-09).
    buckets: ['ARK_INCENTIVES', 'ARK_TREASURY', 'ARK_CONTRIBUTORS', 'ARK_BACKSTOP', 'ARK_LIQUIDITY'].map((k) => read(k) || null),
    protocolOwned: list(read('VEARK_PROTOCOL_OWNED')),
    attesters: list(read('QDAY_ATTESTERS')),
    attesterBond: big(read('QDAY_ATTESTER_BOND'), 10_000n * ONE),
    advisoryCooldown: num(read('QDAY_ADVISORY_COOLDOWN'), 7 * day),
    court: read('QDAY_COURT') || null,
    proposalThresholdBps: num(read('GOV_PROPOSAL_THRESHOLD_BPS'), 10),
    // Q_min of the Q-Day ratification: votes for, in bps of W (core OC-GOV-11, 2026-10-09).
    qdayQuorumBps: num(read('GOV_QDAY_QUORUM_BPS'), 500),
    objectionThresholdBps: num(read('GOV_OBJECTION_THRESHOLD_BPS'), 2000),
    admissionDeposit: big(read('GOV_ADMISSION_DEPOSIT'), 5_000n * ONE),
    epochLength: phaseEpochLength(m.profile),
  };
  if (!shared) {
    if (!c.proposerOwners.length) [c.proposerOwners, c.proposerThreshold] = [[deployer], 1];
    if (!c.guardianOwners.length) [c.guardianOwners, c.guardianThreshold] = [[deployer], 1];
  }
  Object.assign(c, overrides);
  c.proposerOwners = c.proposerOwners.map(toHex);
  c.guardianOwners = c.guardianOwners.map(toHex);
  c.attesters = c.attesters.map(toHex);
  c.buckets = c.buckets.map((b) => (b ? toHex(b) : null));
  c.protocolOwned = c.protocolOwned.map(toHex);
  for (const k of ['ARK_TREASURY', 'ARK_BACKSTOP', 'ARK_INCENTIVES']) {
    const v = read(k);
    if (v && !c.protocolOwned.some((a) => same(a, v))) c.protocolOwned.push(toHex(v));
  }

  const errors = [];
  const kOfN = (owners, k, name) => {
    if (!owners.length || k < 1 || k > owners.length) errors.push(`${name}_OWNERS / ${name}_THRESHOLD: need k of n with 1 <= k <= n`);
    if (new Set(owners.map(lower)).size !== owners.length) errors.push(`${name}_OWNERS lists an owner twice`);
  };
  kOfN(c.proposerOwners, c.proposerThreshold, 'GOV_PROPOSER');
  kOfN(c.guardianOwners, c.guardianThreshold, 'GOV_GUARDIAN');
  if (c.attesters.length > QDAY_PANEL) errors.push(`QDAY_ATTESTERS: at most ${QDAY_PANEL}`);
  if (new Set(c.attesters.map(lower)).size !== c.attesters.length) errors.push('QDAY_ATTESTERS lists an attester twice');
  if (!(c.qdayQuorumBps >= 100 && c.qdayQuorumBps <= 5000)) errors.push(`GOV_QDAY_QUORUM_BPS ${c.qdayQuorumBps}: must be 100..5000 (core ArkGovernor refuses others)`);
  if (shared && m.qday === 'ArkQDayOracle' && c.attesters.length < QDAY_QUORUM) {
    errors.push(`QDAY_ATTESTERS names ${c.attesters.length}; the manifest's Q-Day oracle is core's, whose certification needs ${QDAY_QUORUM} bonded attesters`);
  }
  if (shared && env.ALLOW_SHARED_KEYS !== '1') {
    const operational = [['the deployer (the relayer)', deployer], ['the attestation sealer', roles.sealer], ['the price double\'s operator', roles.oracleOperator]].filter(([, a]) => a);
    for (const [who, a] of [...c.proposerOwners.map((o) => ['multisig owner', o]), ...c.guardianOwners.map((o) => ['guardian owner', o]), ...c.attesters.map((o) => ['Q-Day attester', o])]) {
      for (const [role, op] of operational) {
        if (same(a, op)) errors.push(`${who} ${toQ(a)} is ${role}; governance and attester keys must be accounts of their own (design §6.1, audit D2)`);
      }
    }
  }
  if (!Number.isInteger(c.epochLength) || c.epochLength <= 0) errors.push(`ArkPhase epoch length ${c.epochLength}: must be ArkEpoch's at profile ${m.profile}`);
  return { c, errors, shared, warnings };
}

/* ------------------------------------------------------------------ */
/* Deployment                                                          */
/* ------------------------------------------------------------------ */

/**
 * Deploys the network's stack at stage S1 and writes its record. Returns the
 * record. Nothing about Ark Staking is touched: the QRL leg proposes its
 * governance to the timelock itself (`deployQrlLeg`).
 *
 * ArkPhase is governed by the timelock from construction, as the Q-Day
 * oracle is (core §3.6: `governance` = ArkTimelock from S1): its constructor
 * takes the governance account, so no deployer key ever holds it and no
 * acceptance is owed (`governance:accept` only reports it). Its epoch length
 * is the profile's `ArkEpoch.EPOCH_LENGTH` (`config.epochLength`), which Ark
 * Staking's parameter set checks at construction.
 */
async function deployGovernance({ client, chain, manifest: m, config: c, build, network = networkOf(chain, m), file = networkRecordPath(chain, m), log = console.log }) {
  const onQrl = client.kind === 'qrl';
  const rec = (a) => (onQrl ? toQ(a) : toHex(a));
  const abi = (n) => iface(n, build);
  const qrlChainId = Number(await client.chainId());
  const genesis = await client.genesis();
  const startBlock = (await client.head()).latest;
  log(`   governance stack from ${path.relative(ROOT, build)} (core's compiled artifacts, vendored)`);

  const chunked = await client.deploy('ChunkedDeployer', [], build);
  const d = (name, args = []) => deployLarge(client, name, args, build, { chunked, log });
  const a = { ChunkedDeployer: chunked };
  a.ProposerMultisig = await d('ArkMultisig', [c.proposerOwners, c.proposerThreshold]);
  a.GuardianMultisig = await d('ArkMultisig', [c.guardianOwners, c.guardianThreshold]);
  a.ArkTimelock = await d('ArkTimelock', [a.ProposerMultisig, a.GuardianMultisig]);
  // The vesting schedule runs from the chain's own genesis, so a stack
  // redeployed on the same genesis vests identically.
  const vestStart = Number(genesis.timestamp) || Number((await client.head()).timestamp);
  const buckets = defaultBuckets(c.buckets, client.address, a.ArkTimelock, onQrl);
  a.ArkToken = await d('ArkToken', [...buckets, vestStart]);
  const protocolOwned = [...c.protocolOwned, a.ArkTimelock];
  a.VeArk = await d('VeArk', [a.ArkToken, protocolOwned]);
  a.ArkGovernorRules = await d('ArkGovernorRules');
  const zero = onQrl ? '0x' + '00'.repeat(64) : '0x' + '00'.repeat(20);
  a.ArkQDayOracle = await d('ArkQDayOracle', [a.ArkTimelock, c.court ? toHex(c.court) : zero, c.attesterBond, c.advisoryCooldown, c.attesters]);
  a.ArkGovernor = await d('ArkGovernor', [a.VeArk, a.ArkTimelock, a.ArkGovernorRules, a.ArkToken, a.ArkQDayOracle, c.proposalThresholdBps, c.qdayQuorumBps, c.objectionThresholdBps, c.admissionDeposit]);
  // The ecosystem phase (core §3.6), governed by the timelock from construction.
  a.ArkPhase = await d('ArkPhase', [a.ArkQDayOracle, a.ArkTimelock, c.epochLength]);
  await client.send(a.VeArk, abi('VeArk'), 'setGovernor', [a.ArkGovernor]);
  await client.send(a.ArkQDayOracle, abi('ArkQDayOracle'), 'setGovernor', [a.ArkGovernor]);
  for (const [n, v] of Object.entries(a)) log(`   ${n.padEnd(18)} ${rec(v)}`);

  const addresses = Object.fromEntries(Object.entries(a).map(([n, v]) => [n, rec(v)]));
  const record = {
    // The QRL network this stack serves, one per genesis, read by every
    // product on it; `bootstrappedBy` is the origin manifest whose run
    // deployed it, nothing more (2026-10-07).
    network,
    bootstrappedBy: chain,
    chainId: String(qrlChainId),
    genesisHash: genesis.hash,
    genesisTimestamp: Number(genesis.timestamp),
    profile: m.profile,
    stage: 'S1',
    deployedAt: new Date().toISOString(),
    deployedFromBlock: Number(startBlock),
    deployer: rec(client.address),
    deployedBy: 'ark-staking-contracts scripts/lib/governance.js (vendored ecosystem artifacts)',
    buildDir: path.relative(ROOT, build).split(path.sep).join('/'),
    vendored: vendoredSource(build),
    addresses,
    parameters: {
      buckets: Object.fromEntries(BUCKET_NAMES.map((n, i) => [n, rec(buckets[i])])),
      proposerOwners: c.proposerOwners.map(rec),
      proposerThreshold: c.proposerThreshold,
      guardianOwners: c.guardianOwners.map(rec),
      guardianThreshold: c.guardianThreshold,
      protocolOwned: protocolOwned.map(rec),
      attesters: c.attesters.map(rec),
      attesterBond: String(c.attesterBond),
      advisoryCooldown: c.advisoryCooldown,
      court: c.court ? rec(c.court) : rec(zero),
      proposalThresholdBps: c.proposalThresholdBps,
      qdayQuorumBps: c.qdayQuorumBps,
      objectionThresholdBps: c.objectionThresholdBps,
      admissionDeposit: String(c.admissionDeposit),
      epochLength: c.epochLength,
      uncalibrated: ['proposalThresholdBps', 'qdayQuorumBps', 'objectionThresholdBps', 'attesterBond', 'advisoryCooldown'],
      phase1TestAttesters: manifestLib.isShared(m)
        ? 'the attesters are operator-held test keys (phase 1): the private devnet has no independent Q-Day attesters'
        : 'local run',
    },
    next: [
      'the QRL leg is deployed under ArkTimelock (deployQrlLeg, OC-GOV-03): ArkStakeParams and ArkBondDelegation from construction, ArkStakeRegistry accepted in the same run',
      'proposer multisig: governance:accept --schedule (then --approve by each further owner) wires the timelock objection source and governor and schedules ArkGovernor.setObjectionSource and setCourt (30 profile-days); --execute once they are due',
      'attesters: ArkQDayOracle.postBond() with at least attesterBond',
      'ArkPhase: governed by ArkTimelock from construction, phase 0; a move is a timelock operation (setPhase 30 days, enterQDay 48 hours, restore 30 days; core §4.6)',
      'every product on this network reads this record: Ark Staking legs (deployQrlLeg wires ArkStakeParams to ArkPhase), Qurrl (ARK_PHASE_ADDRESS, and its Cushion lane to a leg\'s ArkCatBond)',
    ],
  };
  const check = await checkGovernanceRecord({ client, record });
  if (!check.ok) throw new Error(`the governance stack just deployed does not probe as its record says (${check.reason}); refusing to write the record`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (client.kind !== 'harness' && fs.existsSync(file)) fs.copyFileSync(file, file.replace(/\.json$/, `.replaced-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  log(`   governance record -> ${path.relative(ROOT, file)}`);
  return { record, file };
}

function vendoredSource(build) {
  try {
    const line = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'MANIFEST.json'), 'utf8')).lines[path.basename(build)];
    return line ? { core: line.core, vendoredAt: line.vendoredAt, profile: line.profile } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Is a record live on this chain?                                     */
/* ------------------------------------------------------------------ */

/** The getters the probe reads, written out so a record is checkable without any build at hand. */
const PROBE = new Interface([
  'function proposer() view returns (address)',
  'function guardian() view returns (address)',
  'function timelock() view returns (address)',
  'function governor() view returns (address)',
  'function veArk() view returns (address)',
  'function qday() view returns (address)',
  'function court() view returns (address)',
  'function governance() view returns (address)',
  'function qdayOracle() view returns (address)',
  'function epochLength() view returns (uint256)',
]);

/**
 * Whether `record` describes a stack live on the chain `client` reaches.
 * `{ ok: true, legacy }` or `{ ok: false, state, reason }`: `foreign` (another
 * chain id), `stale` (another genesis, an address with no code, or wiring that
 * does not answer as recorded). A record with no genesis hash — one written by
 * an older core script — is accepted only on the probe, and marked `legacy`.
 * Where the record names `ArkPhase` (2026-10-07 on) it is held too: code, its
 * governance the timelock, its oracle the stack's, its epoch length the
 * recorded one. A record without it is still live (it predates ArkPhase).
 */
async function checkGovernanceRecord({ client, record }) {
  const a = record && record.addresses;
  if (!a) return { ok: false, state: 'stale', reason: 'the record names no addresses' };
  const chainId = await client.chainId();
  if (record.chainId !== undefined && BigInt(record.chainId) !== BigInt(chainId)) {
    return { ok: false, state: 'foreign', reason: `the record is for chain ${record.chainId}, the node answers ${chainId}` };
  }
  if (record.genesisHash) {
    const g = await client.genesis();
    if (String(g.hash).toLowerCase() !== String(record.genesisHash).toLowerCase()) {
      return { ok: false, state: 'stale', reason: `the record was written on genesis ${record.genesisHash}; this chain's is ${g.hash}` };
    }
  }
  for (const k of RECORD_KEYS) {
    if (!a[k]) return { ok: false, state: 'stale', reason: `the record names no ${k}` };
    const code = await client.code(toHex(a[k]));
    if (!code || code === '0x') return { ok: false, state: 'stale', reason: `${k} ${a[k]} has no code on this chain` };
  }
  if (a[PHASE_KEY]) {
    const code = await client.code(toHex(a[PHASE_KEY]));
    if (!code || code === '0x') return { ok: false, state: 'stale', reason: `${PHASE_KEY} ${a[PHASE_KEY]} has no code on this chain` };
  }
  const read = async (k, m) => (await client.call(toHex(a[k]), PROBE, m))[0];
  const expect = [
    // The proposer is the S1 multisig, or the governor once handed over (S2).
    ['ArkTimelock', 'proposer', [a.ProposerMultisig, a.ArkGovernor]],
    ['ArkTimelock', 'guardian', [a.GuardianMultisig, null]],
    ['ArkQDayOracle', 'timelock', [a.ArkTimelock]],
    ['ArkQDayOracle', 'governor', [a.ArkGovernor]],
    ['VeArk', 'governor', [a.ArkGovernor]],
    ['ArkGovernor', 'veArk', [a.VeArk]],
    ['ArkGovernor', 'qday', [a.ArkQDayOracle]],
    ['ArkGovernor', 'timelock', [a.ArkTimelock]],
  ];
  // GV-19: the oracle's court (an immutable, zero where slashing is off), as recorded.
  const court = record.parameters && record.parameters.court;
  if (court !== undefined && court !== null) expect.push(['ArkQDayOracle', 'court', [BigInt(toHex(court)) === 0n ? null : court]]);
  // ArkPhase: the timelock governs it from construction (core §3.6).
  if (a[PHASE_KEY]) expect.push([PHASE_KEY, 'governance', [a.ArkTimelock]], [PHASE_KEY, 'qdayOracle', [a.ArkQDayOracle]]);
  for (const [k, m, accepted] of expect) {
    let got;
    try {
      got = await read(k, m);
    } catch (e) {
      return { ok: false, state: 'stale', reason: `${k}.${m}() does not answer at ${a[k]}: another contract lives there (${e.shortMessage || e.message})` };
    }
    const zero = /^0x0*$/.test(toHex(got));
    const fine = accepted.some((x) => (x === null ? zero : same(got, x)));
    if (!fine) return { ok: false, state: 'stale', reason: `${k}.${m}() answers ${got}, the record says ${accepted.filter(Boolean).join(' or ')}` };
  }
  const recordedLength = record.parameters && record.parameters.epochLength;
  if (a[PHASE_KEY] && recordedLength !== undefined && recordedLength !== null) {
    let got;
    try {
      got = BigInt((await client.call(toHex(a[PHASE_KEY]), PROBE, 'epochLength'))[0]);
    } catch (e) {
      return { ok: false, state: 'stale', reason: `${PHASE_KEY}.epochLength() does not answer at ${a[PHASE_KEY]} (${e.shortMessage || e.message})` };
    }
    if (got !== BigInt(recordedLength)) return { ok: false, state: 'stale', reason: `${PHASE_KEY}.epochLength() answers ${got}, the record says ${recordedLength}` };
  }
  return { ok: true, legacy: !record.genesisHash };
}

/**
 * Adds ArkPhase to a stack that is live on this chain and predates it (a
 * record written before 2026-10-07): deploys `ArkPhase(oracle, timelock,
 * epochLength)` against the record's own oracle and timelock and writes the
 * record, now the network's, to `file` — one stack per network, not a second
 * stack beside the first. The record it came from is left where it was.
 * Returns `{ record, file }`.
 */
async function addArkPhase({ client, record: old, from = null, build, epochLength, network, file, log = console.log }) {
  const a = old.addresses || {};
  if (a[PHASE_KEY]) throw new Error(`the record already names ${PHASE_KEY} ${a[PHASE_KEY]}`);
  const check = await checkGovernanceRecord({ client, record: old });
  if (!check.ok) throw new Error(`the record is ${check.state} (${check.reason}); a stack that is not live gets a whole new stack, not ArkPhase alone`);
  const rec = (x) => (client.kind === 'qrl' ? toQ(x) : toHex(x));
  const chunked = toHex(a.ChunkedDeployer);
  const phase = await deployLarge(client, PHASE_KEY, [toHex(a.ArkQDayOracle), toHex(a.ArkTimelock), epochLength], build, { chunked, log });
  log(`   ${PHASE_KEY.padEnd(18)} ${rec(phase)}  (added to the live stack; governed by its ArkTimelock from construction)`);
  const record = {
    ...old,
    network,
    addresses: { ...a, [PHASE_KEY]: rec(phase) },
    parameters: { ...(old.parameters || {}), epochLength },
    phaseAdded: { at: new Date().toISOString(), from: from ? path.relative(ROOT, from).split(path.sep).join('/') : null, buildDir: path.relative(ROOT, build).split(path.sep).join('/') },
  };
  const after = await checkGovernanceRecord({ client, record });
  if (!after.ok) throw new Error(`ArkPhase was deployed at ${rec(phase)} and does not probe as the record says (${after.reason}); refusing to write the record`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (client.kind !== 'harness' && fs.existsSync(file)) fs.copyFileSync(file, file.replace(/\.json$/, `.replaced-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  log(`   governance record -> ${path.relative(ROOT, file)}`);
  return { record, file };
}

/** ArkPhase as the chain holds it, for a status report; null where the record names none. */
async function phaseStatus({ client, governance: g }) {
  if (!g || !g[PHASE_KEY]) return null;
  const at = toHex(g[PHASE_KEY]);
  const i = new Interface([
    'function phase() view returns (uint8)',
    'function storedPhase() view returns (uint8)',
    'function pendingPhase() view returns (uint8, uint256)',
    'function governance() view returns (address)',
    'function pendingGovernance() view returns (address)',
    'function epochLength() view returns (uint256)',
  ]);
  const one = async (m) => (await client.call(at, i, m))[0];
  const [to, effective] = await client.call(at, i, 'pendingPhase');
  return {
    address: g[PHASE_KEY],
    phase: Number(await one('phase')),
    storedPhase: Number(await one('storedPhase')),
    pending: BigInt(effective) === 0n ? null : { to: Number(to), effectiveEpoch: BigInt(effective) },
    governance: toHex(await one('governance')),
    governedByTimelock: same(await one('governance'), g.ArkTimelock),
    pendingGovernance: toHex(await one('pendingGovernance')),
    epochLength: BigInt(await one('epochLength')),
  };
}

/* ------------------------------------------------------------------ */
/* Funding the accounts a fresh genesis did not fund                    */
/* ------------------------------------------------------------------ */

/**
 * The accounts other than the deployer that must hold QRL on a fresh genesis
 * (which funds the deployer alone): the attestation sealer and the price
 * double's operator (gas), each multisig owner (gas, to schedule the
 * governance handover), and each Q-Day attester (its bond and gas: a bond is
 * posted by the attester itself, `ArkQDayOracle.postBond`). `QRL_ROLE_FUNDING`
 * (whole QRL, default 100) is the gas float; an account already holding its
 * target is left alone, so a second run sends nothing. The reporters of
 * `ArkReferenceOracle` (`reporters`, where the leg wires the real oracle,
 * 2026-10-05) take the same float.
 *
 * And the reference solver (2026-09-29), where the environment names its QRL
 * account (`SOLVER_ADDRESS`, or `<CHAIN>_SOLVER_QRL_ADDRESS` with `chain`):
 * topped up to `SOLVER_QRL_FUNDING` (whole QRL, `<CHAIN>_` first), by default
 * `SOLVER_QRL_FUNDING_DEFAULT` — a day of lots at the default lot cap, their
 * bonds and their gas. It is a market maker's working capital on a test
 * network, which is why it comes from the genesis the relayer holds.
 */
const SOLVER_QRL_FUNDING_DEFAULT = 25_000n;

function solverFunding({ env = {}, chain = null }) {
  const K = chain ? `${envKey(chain)}_` : null;
  const pick = (name) => (K && env[`${K}${name}`]) || env[name] || null;
  const address = (K && env[`${K}SOLVER_QRL_ADDRESS`]) || env.SOLVER_ADDRESS || null;
  if (!address) return null;
  const whole = pick('SOLVER_QRL_FUNDING');
  return { address, target: (whole === null ? SOLVER_QRL_FUNDING_DEFAULT : BigInt(whole)) * ONE };
}

function fundingPlan({ env = {}, me, roles = {}, config = null, chain = null, reporters = [] }) {
  const gas = BigInt(env.QRL_ROLE_FUNDING || '100') * ONE;
  const out = [];
  const add = (address, label, target) => {
    if (!address || same(address, me)) return;
    const existing = out.find((x) => same(x.address, address));
    if (existing) {
      if (target > existing.target) existing.target = target;
      existing.label += `, ${label}`;
      return;
    }
    out.push({ address: toHex(address), label, target });
  };
  add(roles.sealer, 'attestation sealer', gas);
  add(roles.oracleOperator, 'price double operator', gas);
  if (config) {
    config.proposerOwners.forEach((o) => add(o, 'proposer multisig owner', gas));
    config.guardianOwners.forEach((o) => add(o, 'guardian multisig owner', gas));
    config.attesters.forEach((o) => add(o, 'Q-Day attester', config.attesterBond + gas));
  }
  // The reporters of ArkReferenceOracle, where the leg wires it (gas: a
  // submit each per round, a submitYield each per epoch and key).
  reporters.forEach((o) => add(o, 'oracle reporter', gas));
  const solver = solverFunding({ env, chain });
  if (solver) add(solver.address, 'reference solver', solver.target);
  return out;
}

/** QRL the plan still needs sent. */
async function fundingShortfall({ client, plan }) {
  let total = 0n;
  for (const p of plan) {
    const have = await client.balance(p.address);
    if (have < p.target) total += p.target - have;
  }
  return total;
}

/** Tops each account of the plan up to its target from the client's account. Idempotent. */
async function fundAccounts({ client, plan, log = console.log }) {
  const sent = [];
  for (const p of plan) {
    const have = await client.balance(p.address);
    if (have >= p.target) continue;
    const amount = p.target - have;
    await client.transfer(p.address, amount);
    sent.push({ ...p, amount });
    log(`   funded   ${p.label.padEnd(26)} ${client.kind === 'qrl' ? toQ(p.address) : p.address}  +${amount / ONE} QRL`);
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* The handover and the wiring, through the proposer multisig           */
/* ------------------------------------------------------------------ */

/** The three contracts `deployQrlLeg` hands to the timelock (IGovernanceHandover). */
const GOVERNED = ['ArkStakeParams', 'ArkStakeRegistry', 'ArkBondDelegation'];
const HANDOVER = new Interface([
  'function acceptGovernance()',
  'function governance() view returns (address)',
  'function pendingGovernance() view returns (address)',
]);
/** core `IArkTimelock.OpState`. */
const OP_QUEUED = 1;
const OP_EXECUTED = 2;

/**
 * WHAT THE OPERATOR'S TOOLING KEEPS (audit 2026-10-03, OC-GOV-04)
 * ---------------------------------------------------------------
 * One entry per proposer-multisig transaction it submits, returned by
 * `scheduleAcceptances` and persisted by `governance-accept.js` in
 * `deployments/governance-accept-<chain>.json`:
 *
 *   { name, kind, target, multisigTx, executed, opId, eta }
 *
 *   kind 'accept'    acceptGovernance() on a governed contract, scheduled through the timelock (48 h)
 *        'call'      a direct multisig call on the timelock: setObjectionSource, setGovernor (at once)
 *        'schedule'  a 30-day timelock operation on the governor: setObjectionSource, setCourt
 *
 * `approveAcceptances` approves and executes every entry not yet executed,
 * whatever its kind, and records the op id of those that schedule;
 * `executeAcceptances` executes every recorded op whose delay has run. The
 * wiring used to be submitted and dropped: at a threshold above one nobody
 * approved it, and at any threshold the governor's 30-day objection-source
 * operation was never kept or executed.
 */
const normalise = (op) => ({ ...op, kind: op.kind || 'accept', executed: op.executed ?? Boolean(op.opId) });

/** Submits `payload` to `target` through the proposer multisig; executes it at once at threshold one. */
async function submitVia({ client, abi, g, threshold, opts, log }, entry, target, payload) {
  const ms = toHex(g.ProposerMultisig);
  const [id] = await client.call(ms, abi('ArkMultisig'), 'txCount');
  await client.send(ms, abi('ArkMultisig'), 'submit', [toHex(target), 0n, payload], opts);
  Object.assign(entry, { multisigTx: BigInt(id), executed: false, opId: null, eta: null });
  if (threshold > 1n) {
    log(`   ${entry.name.padEnd(30)} multisig tx ${id} submitted; ${threshold - 1n} more owner(s) approve, then any owner executes it (--approve)`);
    return entry;
  }
  const receipt = await client.send(ms, abi('ArkMultisig'), 'execute', [id], opts);
  settle(client, abi, entry, receipt, log);
  return entry;
}

/** Marks an entry executed and, where it scheduled, records its op id and eta. */
function settle(client, abi, entry, receipt, log) {
  entry.executed = true;
  if (entry.kind === 'call') {
    log(`   ${entry.name.padEnd(30)} done`);
    return;
  }
  const ev = scheduledOf(client, abi('ArkTimelock'), receipt.logs);
  entry.opId = ev.opId;
  entry.eta = ev.eta;
  log(`   ${entry.name.padEnd(30)} scheduled as ${ev.opId}, executable from ${ev.eta}`);
}

/** An entry of `existing` named `name` that still stands: its multisig transaction unexecuted, or its op Queued or Executed. */
async function standing({ client, abi, g }, existing, name) {
  for (const raw of existing || []) {
    const e = normalise(raw);
    if (e.name !== name || e.multisigTx === null || e.multisigTx === undefined) continue;
    if (!e.executed) {
      const tx = await client.call(toHex(g.ProposerMultisig), abi('ArkMultisig'), 'txOf', [BigInt(e.multisigTx)]);
      if (!tx[3]) return raw;
      continue;
    }
    if (!e.opId) continue;
    const [s] = await client.call(toHex(g.ArkTimelock), abi('ArkTimelock'), 'stateOf', [e.opId]);
    if (Number(s) === OP_QUEUED || Number(s) === OP_EXECUTED) return raw;
  }
  return null;
}

/**
 * The proposer multisig schedules `acceptGovernance()` on each governed
 * contract the timelock does not govern yet (core design §6.1; 48
 * profile-hours, twenty minutes at the testnet profile), after the wiring
 * (`wireObjectionSource`). Since OC-GOV-03 `deployQrlLeg` leaves all three
 * governed by the timelock, so on a fresh deployment only the wiring is
 * submitted. `client` signs as one owner (`from` on the harness); above a
 * threshold of one the other owners approve with `approveAcceptances`.
 * `existing` (the persisted entries of an earlier run on this genesis) is
 * not submitted again while it stands (SWAPGOV-12). Returns every entry.
 */
async function scheduleAcceptances({ client, build, governance: g, leg, from = undefined, existing = [], log = console.log }) {
  const abi = (n) => iface(n, build);
  const opts = from ? { from } : {};
  const threshold = BigInt((await client.call(toHex(g.ProposerMultisig), abi('ArkMultisig'), 'threshold'))[0]);
  const ctx = { client, abi, g, threshold, opts, log };
  const out = await wireObjectionSource({ client, abi, governance: g, leg, threshold, opts, log, existing });
  for (const name of GOVERNED) {
    const target = toHex(leg[name]);
    const [current] = await client.call(target, HANDOVER, 'governance');
    if (same(current, g.ArkTimelock)) {
      log(`   ${name.padEnd(30)} already governed by the timelock`);
      continue;
    }
    const kept = await standing(ctx, existing, name);
    if (kept) {
      out.push(kept);
      log(`   ${name.padEnd(30)} acceptance already submitted (multisig tx ${kept.multisigTx})`);
      continue;
    }
    const payload = HANDOVER.encodeFunctionData('acceptGovernance', []);
    // Inner calldata the multisig forwards to the timelock: on QRL (QIP-55) the
    // target is a 64-byte address and the words are 64 bytes, which ethers'
    // 32-byte coder refuses; the selector-only payload is the same on both.
    const schedule = client.kind === 'qrl'
      ? require('./chains').qrlCodec(abi('ArkTimelock')).encode('schedule', [target, payload])
      : abi('ArkTimelock').encodeFunctionData('schedule', [target, payload]);
    out.push(await submitVia(ctx, { name, kind: 'accept', target }, g.ArkTimelock, schedule));
  }
  return out;
}

/**
 * The wiring the S1 proposer multisig owes the stack (core design §6.8, EC-06;
 * re-audit 2026-09-30; audit 2026-10-03), each step skipped where it is done,
 * where the vendored artifact predates it, or where `existing` holds it:
 *
 *   ArkTimelock.setObjectionSource(bond)   direct, once: Leg B objects from S1
 *   ArkTimelock.setGovernor(governor)      direct, once: the handover's one target (SWAPGOV-03)
 *   ArkGovernor.setObjectionSource(bond)   a 30-day operation: the S2 chamber (SWAPGOV-05, GV-14)
 *   ArkGovernor.setCourt(court)            a 30-day operation: the court's terminal step (OC-GOV-05)
 *
 * Returns the entries it submitted (see above); at a threshold above one they
 * wait for `approveAcceptances`.
 */
async function wireObjectionSource({ client, abi, governance: g, leg, threshold, opts = {}, log = console.log, existing = [] }) {
  const timelock = abi('ArkTimelock');
  if (!timelock.getFunction('setObjectionSource') || !leg.ArkCatBond) return [];
  const ctx = { client, abi, g, threshold, opts, log };
  const bond = toHex(leg.ArkCatBond);
  const encode = (i, fn, args) => (client.kind === 'qrl' ? require('./chains').qrlCodec(i).encode(fn, args) : i.encodeFunctionData(fn, args));
  const zero = (v) => !v || BigInt(toHex(v)) === 0n;
  const out = [];
  const step = async (name, kind, needed, target, payload) => {
    if (!needed) return;
    const kept = await standing(ctx, existing, name);
    if (kept) {
      out.push(kept);
      log(`   ${name.padEnd(30)} already submitted (multisig tx ${kept.multisigTx})`);
      return;
    }
    out.push(await submitVia(ctx, { name, kind, target: toHex(target) }, g.ArkTimelock, payload));
  };
  const [current] = await client.call(toHex(g.ArkTimelock), timelock, 'objectionSource');
  if (!zero(current)) log(`   objection source already set: ${toHex(current)}`);
  await step('ArkTimelock.setObjectionSource', 'call', zero(current), g.ArkTimelock, encode(timelock, 'setObjectionSource', [bond]));
  if (g.ArkGovernor && timelock.getFunction('setGovernor')) {
    const [named] = await client.call(toHex(g.ArkTimelock), timelock, 'governor');
    await step('ArkTimelock.setGovernor', 'call', zero(named), g.ArkTimelock, encode(timelock, 'setGovernor', [toHex(g.ArkGovernor)]));
  }
  const governor = g.ArkGovernor ? abi('ArkGovernor') : null;
  if (governor && governor.getFunction('setObjectionSource') && governor.getFunction('objectionSource')) {
    const [gs] = await client.call(toHex(g.ArkGovernor), governor, 'objectionSource');
    const inner = encode(governor, 'setObjectionSource', [bond]);
    await step('ArkGovernor.setObjectionSource', 'schedule', zero(gs), g.ArkGovernor, encode(timelock, 'schedule', [toHex(g.ArkGovernor), inner]));
  }
  // OC-GOV-05: until the governor names the court, an escalation takes its
  // deposit and cannot be voted; it is scheduled with the rest of the wiring.
  if (governor && leg.ArkStakeCourt && governor.getFunction('setCourt') && governor.getFunction('court')) {
    const [named] = await client.call(toHex(g.ArkGovernor), governor, 'court');
    const inner = encode(governor, 'setCourt', [toHex(leg.ArkStakeCourt)]);
    await step('ArkGovernor.setCourt', 'schedule', zero(named), g.ArkGovernor, encode(timelock, 'schedule', [toHex(g.ArkGovernor), inner]));
  }
  return out;
}

/**
 * A further proposer-multisig owner approves every entry not yet executed;
 * once the approvals reach the threshold the same owner executes the multisig
 * transaction, and where it schedules the op id and eta are recorded. An
 * entry executed by someone else meanwhile is marked so. Returns the entries.
 */
async function approveAcceptances({ client, build, governance: g, ops, from = undefined, log = console.log }) {
  const abi = (n) => iface(n, build);
  const opts = from ? { from } : {};
  const me = from || client.address;
  const multisig = toHex(g.ProposerMultisig);
  const threshold = BigInt((await client.call(multisig, abi('ArkMultisig'), 'threshold'))[0]);
  for (let i = 0; i < ops.length; i++) {
    const op = (ops[i] = normalise(ops[i]));
    if (op.executed || op.multisigTx === null || op.multisigTx === undefined) continue;
    const id = BigInt(op.multisigTx);
    const tx = await client.call(multisig, abi('ArkMultisig'), 'txOf', [id]);
    if (tx[3]) {
      op.executed = true;
      log(`   ${op.name.padEnd(30)} multisig tx ${id} was executed by another owner${op.kind === 'call' ? '' : '; its op id is in its Scheduled event'}`);
      continue;
    }
    let [n] = await client.call(multisig, abi('ArkMultisig'), 'approvalCount', [id]);
    // Not the `approved(id, me)` getter: on the v3 build a public mapping's
    // getter with an address key reads false (OC-V3-02); an approval this
    // owner already gave is refused by eth_call instead.
    let mine = false;
    if (BigInt(n) < threshold) {
      try {
        await client.call(multisig, abi('ArkMultisig'), 'approve', [id], { from: me });
      } catch {
        mine = true;
      }
    }
    if (BigInt(n) < threshold && !mine) {
      await client.send(multisig, abi('ArkMultisig'), 'approve', [id], opts);
      [n] = await client.call(multisig, abi('ArkMultisig'), 'approvalCount', [id]);
    }
    if (BigInt(n) < threshold) {
      log(`   ${op.name.padEnd(30)} multisig tx ${id}: ${n} of ${threshold} approvals`);
      continue;
    }
    const receipt = await client.send(multisig, abi('ArkMultisig'), 'execute', [id], opts);
    settle(client, abi, op, receipt, log);
  }
  return ops;
}

/** The timelock's `Scheduled(opId, target, selector, value, eta, delay, payload)` from a receipt, on either word width. */
function scheduledOf(client, timelockAbi, logs) {
  if (client.kind === 'qrl') {
    const { decodeQrlLogs } = require('./chains');
    // The payload is a dynamic member after the three scalars; only the scalars are read.
    const spec = {
      signature: 'Scheduled(bytes32,address,bytes4,uint256,uint64,uint64,bytes)',
      topics: [{ name: 'opId', type: 'bytes32' }, { name: 'target', type: 'address' }],
      data: [{ name: 'value', type: 'uint256' }, { name: 'eta', type: 'uint64' }, { name: 'delay', type: 'uint64' }],
    };
    const [ev] = decodeQrlLogs({ Scheduled: spec }, logs);
    if (!ev) throw new Error('the multisig executed, and the timelock emitted no Scheduled event');
    return { opId: ev.args.opId, eta: BigInt(ev.args.eta) };
  }
  const { parseLogs } = require('./chains');
  const ev = parseLogs(timelockAbi, logs).find((x) => x.name === 'Scheduled');
  if (!ev) throw new Error('the multisig executed, and the timelock emitted no Scheduled event');
  return { opId: ev.args.opId, eta: BigInt(ev.args.eta) };
}

/**
 * Executes every recorded op whose delay has run and which is still Queued
 * (anyone may): the acceptances after 48 profile-hours, the governor's wiring
 * after 30 profile-days. Returns the names executed.
 */
async function executeAcceptances({ client, build, governance: g, ops, log = console.log }) {
  const abi = (n) => iface(n, build);
  const now = (await client.head()).timestamp;
  const done = [];
  for (const op of ops) {
    if (!op.opId) continue;
    const [s] = await client.call(toHex(g.ArkTimelock), abi('ArkTimelock'), 'stateOf', [op.opId]);
    if (Number(s) === OP_EXECUTED) continue;
    if (Number(s) !== OP_QUEUED) {
      log(`   ${op.name.padEnd(30)} op ${op.opId} is no longer Queued (state ${s})`);
      continue;
    }
    const eta = op.eta !== null && op.eta !== undefined ? BigInt(op.eta) : BigInt((await client.call(toHex(g.ArkTimelock), abi('ArkTimelock'), 'etaOf', [op.opId]))[0]);
    if (now < eta) {
      log(`   ${op.name.padEnd(30)} executable from ${eta} (now ${now})`);
      continue;
    }
    await client.send(toHex(g.ArkTimelock), abi('ArkTimelock'), 'execute', [op.opId]);
    done.push(op.name);
    log(`   ${op.name.padEnd(30)} executed`);
  }
  return done;
}

/**
 * The wiring as the chain holds it (OC-GOV-04, OC-GOV-05): the timelock's
 * objection source and governor, the governor's objection source and court.
 * `wired` is true when the first three name the bond and the governor;
 * `courtWired` when the governor names the leg's court (null without one).
 */
async function wiringStatus({ client, build, governance: g, leg }) {
  const abi = (n) => iface(n, build);
  const read = async (to, n, m) => {
    const i = abi(n);
    if (!i.getFunction(m)) return null;
    return toHex((await client.call(toHex(to), i, m))[0]);
  };
  const s = {
    timelockObjectionSource: await read(g.ArkTimelock, 'ArkTimelock', 'objectionSource'),
    timelockGovernor: await read(g.ArkTimelock, 'ArkTimelock', 'governor'),
    governorObjectionSource: g.ArkGovernor ? await read(g.ArkGovernor, 'ArkGovernor', 'objectionSource') : null,
    governorCourt: g.ArkGovernor ? await read(g.ArkGovernor, 'ArkGovernor', 'court') : null,
  };
  s.wired = same(s.timelockObjectionSource, leg.ArkCatBond) && same(s.timelockGovernor, g.ArkGovernor) && same(s.governorObjectionSource, leg.ArkCatBond);
  s.courtWired = leg.ArkStakeCourt ? same(s.governorCourt, leg.ArkStakeCourt) : null;
  return s;
}

/** Who governs each governed contract, and who is proposed. */
async function acceptanceStatus({ client, leg }) {
  const out = {};
  for (const name of GOVERNED) {
    const target = toHex(leg[name]);
    const [governance] = await client.call(target, HANDOVER, 'governance');
    let pending = null;
    try {
      [pending] = await client.call(target, HANDOVER, 'pendingGovernance');
    } catch {
      /* an older build names no pending governance */
    }
    out[name] = { governance: toHex(governance), pending: pending ? toHex(pending) : null };
  }
  return out;
}

module.exports = {
  GOVERNED,
  scheduleAcceptances,
  wireObjectionSource,
  approveAcceptances,
  executeAcceptances,
  acceptanceStatus,
  wiringStatus,
  GOVERNANCE_CONTRACTS,
  RECORD_KEYS,
  LEG_KEYS,
  PHASE_KEY,
  networkOf,
  networkRecordPath,
  recordCandidates,
  phaseEpochLength,
  addArkPhase,
  phaseStatus,
  VENDOR_DIR,
  INITCODE_LIMIT,
  QDAY_QUORUM,
  vendoredLine,
  governanceBuild,
  governanceRecordPath,
  governanceConfig,
  deployGovernance,
  checkGovernanceRecord,
  fundingPlan,
  solverFunding,
  SOLVER_QRL_FUNDING_DEFAULT,
  fundingShortfall,
  fundAccounts,
};
