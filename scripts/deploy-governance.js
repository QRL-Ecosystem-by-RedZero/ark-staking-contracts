#!/usr/bin/env node
/**
 * contracts/core's governance stack — the QRL network's, read by every
 * product on that genesis — from the vendored artifacts
 * (scripts/lib/governance.js), for the network an origin manifest names.
 *
 *   npm run deploy:governance -- --chain hoodi-vps --plan   # config, artifacts, sizes, record; sends and reads nothing
 *   npm run deploy:governance -- --chain hoodi-vps          # deploy, write deployments/governance-<network>.json
 *   npm run deploy:governance -- --chain hoodi-vps --fund   # also top up the role accounts from the deployer
 *
 * One stack per QRL network (2026-10-07): the record is named by the network
 * (`governance.network` in the manifest; hoodi-vps -> private-qrvm), not by
 * the origin chain, and a second origin manifest on the same genesis finds it
 * live and deploys nothing. The stack includes ArkPhase (core §3.6), governed
 * by the timelock from construction. A stack live on this genesis whose
 * record predates ArkPhase (`governance-<chain>.json`, before 2026-10-07)
 * gets ArkPhase added and its record rewritten as the network's; it is not
 * replaced.
 *
 * On the VPS nobody runs this: the relayer (`--redeploy-qrl`) deploys the
 * stack itself after every devnet reset, before the QRL leg. It exists for a
 * deployment made by hand from this machine and for the enclave rehearsal.
 * A live record for this genesis is never replaced: the stack is deployed only
 * where none is live (`--force` deploys a second one anyway).
 */
const fs = require('fs');
const path = require('path');

const { qrlClient, ROOT } = require('./lib/chains');
const { resolveRoles } = require('./lib/deploy');
const gov = require('./lib/governance');
const manifestLib = require('../ecdsa-stakings/relayer/lib/manifest');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(`--${name}`);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

async function main() {
  const chain = arg('chain');
  if (!chain) throw new Error('usage: npm run deploy:governance -- --chain <name> [--plan] [--fund] [--force]');
  const m = manifestLib.load(chain);
  if (m.client === 'harness') throw new Error(`${chain} is the local harness; npm run e2e:local deploys governance for the scenarios that need it`);
  const client = qrlClient();
  const env = client.env;
  const build = gov.governanceBuild({ client, profileName: m.profile });
  const network = gov.networkOf(chain, m);
  const file = gov.networkRecordPath(chain, m);
  // Governance is core's timelock here, so GOVERNANCE_ADDRESS is not read;
  // the sealer and the operator are what the owners must differ from.
  let roles = {};
  const errors = [];
  try {
    roles = resolveRoles({ me: client.address, env, manifest: m, chain, governance: '0x' + 'ee'.repeat(client.address.length === 130 ? 64 : 20) });
  } catch (e) {
    errors.push(e.message);
  }
  const cfg = gov.governanceConfig({ env, chain, manifest: m, deployer: client.address, roles });
  const c = cfg.c;
  errors.push(...cfg.errors);
  for (const w of cfg.warnings) console.warn(`warning  ${w}`);
  const plan = gov.fundingPlan({ env, me: client.address, roles, config: c, chain });

  if (has('plan')) {
    console.log(`plan     ${chain}: the ${network} network's governance stack from ${rel(build)} at profile ${m.profile}`);
    console.log(`record   ${rel(file)}${fs.existsSync(file) ? ' (exists; its liveness is checked on a real run)' : ' (none yet)'}`);
    const legacy = gov.recordCandidates(chain, m).filter((f) => f !== file && fs.existsSync(f));
    for (const f of legacy) console.log(`fallback ${rel(f)}: written under the origin chain's name before 2026-10-07; read while no network record is live`);
    const sizes = {};
    for (const n of gov.GOVERNANCE_CONTRACTS) {
      const a = JSON.parse(fs.readFileSync(path.join(build, `${n}.json`), 'utf8'));
      const init = (a.bytecode.length - 2) / 2;
      sizes[n] = { init, runtime: (a.deployedBytecode.length - 2) / 2, route: init > 18000 ? 'chunked' : 'direct' };
    }
    console.table(sizes);
    console.log(`ArkPhase  constructor(ArkQDayOracle, ArkTimelock, epochLength ${c.epochLength} s): governed by the timelock from construction, phase 0`);
    console.log(JSON.stringify({ ...c, attesterBond: String(c.attesterBond), admissionDeposit: String(c.admissionDeposit) }, null, 2));
    console.log('accounts the deployer would fund:');
    for (const p of plan) console.log(`   ${p.label.padEnd(40)} ${p.address}  ${p.target / 10n ** 18n} QRL`);
    if (errors.length) {
      console.error('\nwould refuse:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    console.log('\nplan ok; nothing was sent');
    return;
  }
  if (errors.length) throw new Error('configuration errors:\n  ' + errors.join('\n  '));

  if (!has('force')) {
    // The network's record first, then the one written under this chain's
    // name before 2026-10-07: whichever is live on this genesis is the stack.
    for (const f of gov.recordCandidates(chain, m)) {
      if (!fs.existsSync(f)) continue;
      const record = JSON.parse(fs.readFileSync(f, 'utf8'));
      const check = await gov.checkGovernanceRecord({ client, record });
      if (!check.ok) {
        console.log(`${rel(f)} is ${check.state}: ${check.reason}`);
        continue;
      }
      if (record.addresses && record.addresses[gov.PHASE_KEY]) {
        console.log(`${rel(f)} is live on this chain and names ArkPhase; nothing to deploy (--force deploys a second stack)`);
        return;
      }
      console.log(`${rel(f)} is live on this chain and predates ArkPhase: adding ArkPhase to it`);
      console.log(`deployer ${client.address}`);
      await gov.addArkPhase({ client, record, from: f, build, epochLength: c.epochLength, network, file });
      if (has('fund')) await gov.fundAccounts({ client, plan });
      return;
    }
  }
  console.log(`deployer ${client.address}`);
  await gov.deployGovernance({ client, chain, manifest: m, config: c, build, network, file });
  if (has('fund')) await gov.fundAccounts({ client, plan });
  console.log(`\nnext: npm run deploy:testnet -- --chain ${chain}   (the leg comes up governed by ArkTimelock, its parameter set on ArkPhase, nothing pending: OC-GOV-03)`);
  console.log(`then: ARK_SIGNER=<owner> npm run governance:accept -- --chain ${chain} --schedule   (the wiring and ArkGovernor.setCourt; --approve per further owner; --status)`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
