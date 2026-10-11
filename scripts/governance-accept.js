#!/usr/bin/env node
/**
 * The governance handover of the QRL leg to contracts/core's timelock, for an
 * operator holding a proposer-multisig owner's key.
 *
 *   npm run governance:accept -- --chain hoodi-vps --status
 *   ARK_SIGNER=GOV_OWNER1 npm run governance:accept -- --chain hoodi-vps --schedule
 *   ARK_SIGNER=GOV_OWNER2 npm run governance:accept -- --chain hoodi-vps --approve   # each further owner, up to the threshold
 *   npm run governance:accept -- --chain hoodi-vps --execute        # anyone, once the delay has run
 *
 * Since the OC round of 2026-10-03 (OC-GOV-03) `deployQrlLeg` leaves the
 * timelock governing ArkStakeParams, ArkStakeRegistry and ArkBondDelegation
 * with nothing pending, so after a devnet reset no deployer key governs. What
 * the proposer multisig still owes, and what --schedule submits, is the
 * WIRING: the timelock's objection source and governor (direct calls), and
 * the governor's objection source and court (30-day operations, OC-GOV-05).
 * An acceptance is scheduled only for a contract the timelock does not govern
 * (a leg deployed by an older tree): an `acceptGovernance()` operation, 48
 * profile-hours, twenty minutes at the testnet profile.
 *
 * Every multisig transaction submitted, and the op id of each that schedules,
 * is kept in the file below (OC-GOV-04): --approve approves and executes each
 * one not yet executed, --execute executes each op once due (the governor's
 * two after 30 profile-days), --status prints who governs, the wiring reads
 * (timelock.objectionSource, timelock.governor, governor.objectionSource,
 * governor.court) and the kept entries. A second --schedule on the same
 * genesis submits nothing that still stands.
 *
 * `ARK_SIGNER=GOV_OWNER` signs with `GOV_OWNER_MNEMONIC` from this machine's
 * .env (scripts/qrl.js): an owner key never goes to the VPS. The QRL RPC must
 * be reachable from here: a devnet RPC that is not public is reached through
 * an SSH tunnel to a host that can see it, with QRL_RPC_URL=http://127.0.0.1:8545. The scheduled operations are kept in
 * `deployments/governance-accept-<chain>.json`, bound to the genesis they were
 * scheduled on.
 *
 * ArkPhase (2026-10-07, the network's, core §3.6) is governed by the timelock
 * from construction, so nothing is owed for it; --status reports it. Should
 * a stack ever hold one proposed to the timelock and not accepted, --schedule
 * completes it with `ArkTimelock.acceptGovernanceOf` (anyone may, OC-GOV-03).
 */
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

const { qrlClient, ROOT } = require('./lib/chains');
const { deploymentPath } = require('./lib/deploy');
const gov = require('./lib/governance');
const manifestLib = require('../ecdsa-stakings/relayer/lib/manifest');
/** BigInts as decimal strings, which BigInt() reads back. */
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(`--${name}`);
const ACCEPT_OF = new Interface(['function acceptGovernanceOf(address target)']);
const sameAddress = (a, b) => String(a || '').replace(/^(0x|Q|q)/, '').toLowerCase() === String(b || '').replace(/^(0x|Q|q)/, '').toLowerCase();

async function main() {
  const chain = arg('chain');
  if (!chain || !(has('status') || has('schedule') || has('approve') || has('execute'))) {
    throw new Error('usage: npm run governance:accept -- --chain <name> --status | --schedule | --approve | --execute');
  }
  const m = manifestLib.load(chain);
  const client = qrlClient();
  const dep = JSON.parse(fs.readFileSync(deploymentPath(chain), 'utf8'));
  if (!dep.governance) throw new Error(`${path.relative(ROOT, deploymentPath(chain))} is wired to no governance stack (its Q-Day oracle is the double)`);
  const recordFile = path.resolve(ROOT, dep.governance.record);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const check = await gov.checkGovernanceRecord({ client, record });
  if (!check.ok) throw new Error(`${dep.governance.record} is ${check.state} on this chain: ${check.reason}. Run npm run devnet:up (umbrella) for today's records`);
  const g = record.addresses;
  const build = gov.governanceBuild({ client, profileName: m.profile });
  const opsFile = path.join(ROOT, 'deployments', `governance-accept-${chain}.json`);
  const genesis = (await client.genesis()).hash;

  const sameGenesis = (f) => String(f.genesis).toLowerCase() === String(genesis).toLowerCase();
  const kept = fs.existsSync(opsFile) ? JSON.parse(fs.readFileSync(opsFile, 'utf8')) : null;

  if (has('status')) {
    console.log(JSON.stringify({
      timelock: g.ArkTimelock,
      governed: await gov.acceptanceStatus({ client, leg: dep.qrl }),
      arkPhase: await gov.phaseStatus({ client, governance: g }),
      wiring: await gov.wiringStatus({ client, build, governance: g, leg: dep.qrl }),
      kept: kept && sameGenesis(kept) ? kept.ops : null,
    }, replacer, 2));
    return;
  }
  if (has('schedule')) {
    console.log(`owner    ${client.address} (proposer multisig ${g.ProposerMultisig})`);
    const existing = kept && sameGenesis(kept) ? kept.ops : [];
    const ops = await gov.scheduleAcceptances({ client, build, governance: g, leg: dep.qrl, existing });
    const phase = await gov.phaseStatus({ client, governance: g });
    if (phase && !phase.governedByTimelock) {
      if (sameAddress(phase.pendingGovernance, g.ArkTimelock)) {
        await client.send(g.ArkTimelock, ACCEPT_OF, 'acceptGovernanceOf', [phase.address]);
        console.log(`   ArkPhase                       accepted by the timelock (acceptGovernanceOf)`);
      } else {
        console.log(`   ArkPhase                       governed by ${phase.governance}: it must proposeGovernance(${g.ArkTimelock}) before the timelock can accept it`);
      }
    }
    // Entries of an earlier run that this one did not resubmit stay kept.
    const merged = [...existing.filter((e) => !ops.includes(e)), ...ops];
    fs.writeFileSync(opsFile, JSON.stringify({ genesis, ops: merged }, replacer, 2));
    console.log(`kept -> ${path.relative(ROOT, opsFile)}; --approve by each further owner, --execute once the delays have run`);
    return;
  }
  if (!kept) throw new Error(`nothing scheduled: run --schedule first (${path.relative(ROOT, opsFile)} is missing)`);
  const saved = kept;
  if (!sameGenesis(saved)) throw new Error(`${path.relative(ROOT, opsFile)} was scheduled on another genesis; schedule again`);
  if (has('approve')) {
    console.log(`owner    ${client.address} (proposer multisig ${g.ProposerMultisig})`);
    const ops = await gov.approveAcceptances({ client, build, governance: g, ops: saved.ops });
    fs.writeFileSync(opsFile, JSON.stringify({ genesis, ops }, replacer, 2));
    console.log(`approved -> ${path.relative(ROOT, opsFile)}; run --execute once the delays have run`);
    return;
  }
  const done = await gov.executeAcceptances({ client, build, governance: g, ops: saved.ops });
  fs.writeFileSync(opsFile, JSON.stringify(saved, replacer, 2));
  console.log(done.length ? `accepted: ${done.join(', ')}` : 'nothing executable yet');
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
