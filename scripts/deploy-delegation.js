/**
 * The staking venue for bond principal — `ArkStakingPool` and the delegation
 * running its validators — added to a QRL leg whose staking contract names none.
 *
 *   npm run deploy:delegation -- --chain hoodi-vps
 *
 * Deploys the pool and its `ArkBondDelegation` on the enclave's genesis deposit
 * contract, has the leg's `ArkBondStaking` name the pool (one-shot, and the
 * staking contract's deployer's — so this must be signed by the account that
 * deployed the leg), and records both in the deployment file. `deployedAt` is left as it was: this is
 * the same leg, completed, and a new `deployedAt` would make the relayer reset
 * its QRL state as though the leg had been replaced (R40).
 *
 * Nothing is sent when the staking contract already names a venue.
 */
const fs = require('fs');
const path = require('path');

const { qrlClient, iface, qrlBuild, ROOT } = require('./lib/chains');
const { deployPool, deploymentPath } = require('./lib/deploy');
const { toHex } = require('../ecdsa-stakings/relayer/lib/addresses');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const chain = arg('chain');
  if (!chain) throw new Error('usage: npm run deploy:delegation -- --chain <name>');
  const file = deploymentPath(chain);
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const build = qrlBuild(dep.profile);
  const client = qrlClient();
  if (toHex(client.address) !== toHex(dep.deployer)) {
    throw new Error(`the leg was deployed by ${dep.deployer} and setDelegation is that account's; this .env signs as ${client.address}`);
  }

  const q = dep.qrl;
  const named = toHex((await client.call(q.ArkBondStaking, iface('ArkBondStaking', build), 'venue'))[0]);
  if (named !== '0x' + '00'.repeat(20)) {
    console.log(`ArkBondStaking ${q.ArkBondStaking} already names venue ${named}; nothing sent`);
    return;
  }
  const { pool, delegation } = await deployPool({ client, build, staking: q.ArkBondStaking, params: q.ArkStakeParams, attestation: q.MockAttestation, profile: dep.profile });
  q.ArkStakingPool = pool;
  q.ArkBondDelegation = delegation;
  fs.writeFileSync(file, JSON.stringify(dep, null, 2));
  console.log(`recorded in ${path.relative(ROOT, file)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  },
);
