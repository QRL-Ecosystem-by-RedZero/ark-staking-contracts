/**
 * The relayer's own redeploy of the QRL side, after a devnet reset (R40).
 *
 * The one rule this module exists to enforce: **after a reset the QRL side
 * comes back whole or not at all, in dependency order.** contracts/core's
 * governance stack first — where the manifest's `governance.selfDeploy` asks
 * for it and no record live on THIS genesis exists (scripts/lib/governance.js
 * holds a record to the chain: genesis hash, code at every address, a probe of
 * the wiring) — from the artifacts vendored under vendor/core-governance/;
 * then every role account the fresh genesis did not fund, topped up from the
 * deployer (the attestation sealer and the price double's operator for gas,
 * the multisig owners for gas, each Q-Day attester for its bond and gas, the
 * reporters of ArkReferenceOracle for gas where the leg wires it, and the
 * reference solver's QRL account for a day of lots, 2026-09-29); then
 * the QRL leg, wired to that stack by `deployQrlLeg`, which refuses a stale
 * record itself. Nothing here decides what a leaf says: it only puts back the
 * contracts the leaves are proved against.
 *
 * Bounded retries per genesis (an attempt file beside the deployment record):
 * one where bond principal would be subscribed again, three otherwise. A
 * governance stack that finished is not redeployed by a retry — its record is
 * live on this genesis by then.
 *
 * THE STACK IS THE NETWORK'S (2026-10-07)
 * ---------------------------------------
 * One governance stack per QRL network, read by every product on it: the
 * record is `deployments/governance-<network>.json` (`governance.network` in
 * the manifest, `private-qrvm` for hoodi-vps), and this relayer bootstraps it
 * only because it is the one process on the VPS. A second origin manifest on
 * the same genesis finds that record live and deploys no stack of its own. A
 * stack live on this genesis whose record predates ArkPhase gets ArkPhase
 * added (`addArkPhase`), never a second stack beside it.
 */
const fs = require('fs');
const path = require('path');

const manifestLib = require('../lib/manifest');
const { toHex } = require('../lib/addresses');
const { deployQrlLeg, deploymentPath, bondPrincipalOf, governanceRecordOf, resolveRoles, oracleReporterAddressesOf, ONE } = require('../../../scripts/lib/deploy');
const gov = require('../../../scripts/lib/governance');
const { ROOT } = require('../../../scripts/lib/chains');

/** QRL the leg's thirty-odd transactions and the governance stack's fifteen are budgeted at, beside funding and principal. */
const LEG_GAS_BUDGET = 10_000n * ONE;
const GOVERNANCE_GAS_BUDGET = 2_000n * ONE;

/** A stand-in for "the timelock that will exist": only compared, never sent to. */
const pendingTimelock = (me) => '0x' + 'ee'.repeat(toHex(me).length === 130 ? 64 : 20);

/**
 * What the redeploy would do on this chain, read-only: whether the governance
 * record is live, whether it will be deployed, the roles, the funding plan.
 */
async function qrlSidePlan({ client, chain, manifest: m = manifestLib.load(chain), env = client.env || {} }) {
  const me = client.address;
  const qrlChainId = Number(await client.chainId());
  const selfDeploy = Boolean(m.governance && m.governance.selfDeploy);
  let found = null;
  let status = { ok: false, state: 'missing', reason: 'no governance record' };
  if (m.qday !== 'MockQDayOracle') {
    try {
      found = governanceRecordOf({ env, chain, qrlChainId, manifest: m });
      if (found) status = await gov.checkGovernanceRecord({ client, record: found.record });
    } catch (e) {
      status = { ok: false, state: 'stale', reason: e.message };
    }
  }
  const live = Boolean(found && status.ok);
  const deployGovernance = selfDeploy && !live;
  if (!selfDeploy && found && !live) {
    throw new Error(`governance record ${found.file} is not live on this chain (${status.reason}) and the ${chain} manifest does not ask the relayer to deploy it (governance.selfDeploy)`);
  }
  // A live stack from before ArkPhase (2026-10-07): ArkPhase is added to it.
  const addPhase = live && !found.addresses[gov.PHASE_KEY];
  if (addPhase && !selfDeploy && manifestLib.isShared(m)) {
    throw new Error(`governance record ${found.file} is live and names no ArkPhase, and the ${chain} manifest does not ask the relayer to deploy governance (governance.selfDeploy): run npm run deploy:governance -- --chain ${chain}`);
  }
  const network = gov.networkOf(chain, m);
  const recordFile = gov.networkRecordPath(chain, m);
  const roles = resolveRoles({ me, env, manifest: m, chain, governance: live ? found.addresses.ArkTimelock : deployGovernance ? pendingTimelock(me) : null });
  let config = null;
  if (selfDeploy) {
    const cfg = gov.governanceConfig({ env, chain, manifest: m, deployer: me, roles });
    if (cfg.errors.length) throw new Error(`the governance stack cannot be deployed for ${chain}:\n  ${cfg.errors.join('\n  ')}`);
    config = cfg.c;
  }
  // The role accounts, and the reference solver's QRL account where the
  // environment names one (SOLVER_ADDRESS): its working capital on this genesis.
  // And the reporters of ArkReferenceOracle, where the leg wires the real oracle.
  const funding = gov.fundingPlan({ env, me, roles, config, chain, reporters: oracleReporterAddressesOf({ env, chain, manifest: m }) });
  return { manifest: m, qrlChainId, found, status, live, deployGovernance, addPhase: addPhase && selfDeploy, network, recordFile, roles, config, funding };
}

/**
 * Redeploy the QRL side on the chain `client` reaches. Returns the new
 * deployment record. Throws — and the loop exits for systemd to restart it —
 * on anything short of a whole side.
 */
async function redeployQrlSide({ client, chain, log = console.log, error = console.error }) {
  const plan = await qrlSidePlan({ client, chain });
  const m = plan.manifest;
  const me = client.address;
  const build = plan.deployGovernance || plan.addPhase ? gov.governanceBuild({ client, profileName: m.profile }) : null;

  const principal = bondPrincipalOf(m);
  const need = principal + LEG_GAS_BUDGET + (plan.deployGovernance || plan.addPhase ? GOVERNANCE_GAS_BUDGET : 0n) + (await gov.fundingShortfall({ client, plan: plan.funding }));
  const have = await client.balance(me);
  if (have < need) throw new Error(`deployer ${me} holds ${have / ONE} QRL on the fresh chain; the QRL side needs ${need / ONE} (leg, governance, role funding and bonds)`);

  const depFile = deploymentPath(chain);
  const previous = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, 'utf8')) : null;
  const maxAttempts = principal > 0n ? 1 : 3;
  const genesis = await client.genesis();
  const attemptFile = depFile.replace(/\.json$/, '.redeploy-attempt.json');
  let attempts = 0;
  if (fs.existsSync(attemptFile)) {
    const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
    if (attempt.genesis === genesis.hash) {
      attempts = attempt.attempts || 1;
      if (attempts >= maxAttempts) {
        throw new Error(`${attempts} redeploy(s) of the ${chain} QRL side on genesis ${genesis.hash} did not finish, the last at ${attempt.at}; ` +
          `deploy by hand (npm run deploy:governance -- --chain ${chain} --fund, then npm run deploy:testnet -- --chain ${chain}) and remove ${attemptFile}`);
      }
      error(`qrl leg  redeploy ${attempts} of ${maxAttempts} on this genesis did not finish (${attempt.at}); trying again`);
    }
  }
  fs.mkdirSync(path.dirname(attemptFile), { recursive: true });
  fs.writeFileSync(attemptFile, JSON.stringify({ genesis: genesis.hash, at: new Date().toISOString(), pid: process.pid, attempts: attempts + 1 }));
  log(`qrl leg  redeploying the QRL side on chain ${plan.qrlChainId} from ${me}`);

  if (plan.deployGovernance) {
    log(`governance ${plan.status.reason}; deploying the ${plan.network} network's stack (contracts/core) from ${path.relative(ROOT, build)}`);
    await gov.deployGovernance({ client, chain, manifest: m, config: plan.config, build, network: plan.network, file: plan.recordFile, log });
  } else if (plan.addPhase) {
    log(`governance ${path.relative(ROOT, plan.found.file)} is live on this genesis and predates ArkPhase; adding ArkPhase to it as the ${plan.network} network's record`);
    await gov.addArkPhase({ client, record: plan.found.record, from: plan.found.file, build, epochLength: gov.phaseEpochLength(m.profile), network: plan.network, file: plan.recordFile, log });
  } else if (plan.live) {
    log(`governance ${path.relative(ROOT, plan.found.file)} is live on this genesis; the leg is wired to it`);
  }
  await gov.fundAccounts({ client, plan: plan.funding, log });
  const record = await deployQrlLeg({ client, chain, manifest: m, log });
  fs.rmSync(attemptFile, { force: true });
  // Width-insensitive: a v3 record writes Q+128 where an older one wrote 0x.
  if (previous && toHex(record.qrl.ArkStakeRegistry) !== toHex(previous.qrl.ArkStakeRegistry)) {
    // The site reads the registry from its network manifest, which the host
    // republishes when this deployment file changes (ark-networks-sync.path).
    error(`qrl leg  registry moved ${previous.qrl.ArkStakeRegistry} -> ${record.qrl.ArkStakeRegistry}; the site follows once the manifest is republished`);
  }
  return record;
}

/**
 * Why the relayer cannot start against the deployment record as it stands,
 * or null: no record (a first install, or an installer run with
 * `--new-origin`), or one wired to a relay the manifest no longer names (a
 * new origin leg). And a relayer state kept for another relay is moved aside
 * — never deleted: it records what was signed for that relay. Moving it is
 * safe because a state that does not cover the relay's consumed leaves
 * refuses to sign (`Relayer.assertCovers`).
 */
function preflightReason({ chain, manifest: m = manifestLib.load(chain), root = ROOT, depFile = deploymentPath(chain), log = console.log }) {
  const relay = toHex(m.addresses.relay);
  const stateDir = path.join(root, '.relayer', chain);
  const stateFile = path.join(stateDir, 'state.json');
  if (fs.existsSync(stateFile)) {
    const held = JSON.parse(fs.readFileSync(stateFile, 'utf8')).relay;
    if (held && toHex(held) !== relay) {
      const aside = `${stateDir}.relay-${String(held).slice(2, 10)}-${Date.now()}`;
      fs.renameSync(stateDir, aside);
      log(`state    kept for relay ${held}, not the manifest's ${relay}; moved to ${path.relative(root, aside)}`);
    }
  }
  const file = depFile;
  if (!fs.existsSync(file)) return `no ${path.relative(root, file)}`;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (toHex(d.relay) !== relay) return `${path.relative(root, file)} is wired to relay ${d.relay}; the manifest names ${relay}`;
  return null;
}

/**
 * The reference solver's QRL on a leg that needs no redeploy (2026-09-29):
 * topped up from the deployer to `SOLVER_QRL_FUNDING` where it holds less
 * than half of it — a first install on a genesis no reset has funded it on.
 * Only on the genesis the deployment record names: on a regenerated chain the
 * redeploy funds it, and nothing may send from the deployer before the
 * redeploy does (the leg's addresses follow its nonces). Returns what was sent.
 */
async function topUpSolver({ client, chain, env = client.env || {}, depFile = deploymentPath(chain), log = console.log }) {
  const f = gov.solverFunding({ env, chain });
  if (!f || toHex(f.address).toLowerCase() === toHex(client.address).toLowerCase()) return [];
  if (!fs.existsSync(depFile)) return [];
  const d = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const genesis = await client.genesis();
  if (!d.qrlGenesisHash || d.qrlGenesisHash.toLowerCase() !== genesis.hash.toLowerCase()) return [];
  if ((await client.balance(f.address)) * 2n >= f.target) return [];
  return gov.fundAccounts({ client, plan: [{ address: toHex(f.address), label: 'reference solver', target: f.target }], log });
}

module.exports = { qrlSidePlan, redeployQrlSide, preflightReason, topUpSolver, LEG_GAS_BUDGET, GOVERNANCE_GAS_BUDGET };
