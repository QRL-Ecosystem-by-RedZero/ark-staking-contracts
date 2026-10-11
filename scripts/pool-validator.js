/**
 * Fund one validator of the staking pool on a private network, by hand.
 *
 *   node scripts/pool-validator.js --chain hoodi-vps --deposit-data <file> [--team-deposit 40000]
 *
 * On `hoodi-vps` nobody needs to: the devnet host writes the deposit data on
 * every bring-up, `ark-warmup` carries it to qrl-vps, and the relayer funds it
 * (`scripts/warmup.js`). This is for another chain, or for a relayer that is
 * stopped. Run it with the relayer and the faucet stopped: they sign from the
 * same account. What it sends, and why the first 40,000 QRL is the team's, is
 * in `scripts/lib/pool-validator.js`.
 */
const fs = require('fs');
const path = require('path');

const { qrlClient, qrlBuild, ROOT } = require('./lib/chains');
const { deploymentPath } = require('./lib/deploy');
const { fundPoolValidator } = require('./lib/pool-validator');

const ONE = 10n ** 18n;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const chain = arg('chain');
  const file = arg('deposit-data');
  if (!chain || !file) throw new Error('usage: node scripts/pool-validator.js --chain <name> --deposit-data <file> [--team-deposit <QRL>]');
  const dep = JSON.parse(fs.readFileSync(deploymentPath(chain), 'utf8'));
  const client = qrlClient();
  console.log(`deployer   ${client.address}`);
  console.log(`pool       ${dep.qrl.ArkStakingPool}\ndelegation ${dep.qrl.ArkBondDelegation}`);
  const r = await fundPoolValidator({
    client,
    build: qrlBuild(dep.profile),
    q: dep.qrl,
    depositData: JSON.parse(fs.readFileSync(file, 'utf8')),
    teamDeposit: BigInt(arg('team-deposit', '40000')) * ONE,
  });
  if (r.steps.length === 0) console.log('already funded; nothing sent');
  fs.writeFileSync(path.join(ROOT, 'deployments', `pool-validator-${chain}.json`), JSON.stringify({ pubkeyHash: r.pubkeyHash, delegation: dep.qrl.ArkBondDelegation, epoch: r.epoch ?? null, at: new Date().toISOString() }, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  },
);
