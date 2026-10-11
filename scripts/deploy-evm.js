/**
 * Deploys the origin-chain leg of a testnet-profile manifest.
 *
 *   npm run deploy:evm -- --chain hoodi
 *   npm run deploy:evm -- --chain rehearsal     (the enclave standing in)
 *   npm run deploy:evm -- --chain hoodi --allow-strand
 *       (redeploy although an escrow of the retiring relay still holds
 *        positions; refused otherwise. Its seeds are archived either way,
 *        audit 2026-09-29 OL-04)
 *
 * The work is in scripts/lib/deploy.js, which `npm run e2e:local` runs against
 * the harness first: the deployment order that reaches a public testnet is one
 * that has already been executed, in full, offline.
 *
 * A spec-profile deployment to a real origin chain has no script (R13),
 * deliberately: it is bytecode deployed once and abandoned, and it should be
 * done by hand from artifacts somebody inspected.
 */
const { originClient } = require('./lib/chains');
const { deployOrigin } = require('./lib/deploy');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const chain = arg('chain');
  if (!chain) throw new Error('usage: npm run deploy:evm -- --chain <name>');
  const { client, manifest, build } = await originClient(chain);
  const head = await client.head();
  console.log(`chain    ${chain}  id ${manifest.chainId}  (${client.kind})  head ${head.latest}`);
  console.log(`deployer ${client.address}\n`);

  await deployOrigin({ client, chain, manifest, build, allowStrand: process.argv.includes('--allow-strand') });
  console.log(`\nnext: npm run deploy:testnet -- --chain ${chain}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
