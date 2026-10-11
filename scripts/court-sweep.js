/**
 * Closes what a failed court run left open (audit 2026-10-03, OC-OPS-26).
 *
 *   npm run court:sweep -- --chain hoodi-vps            the plan (the default; sends nothing)
 *   npm run court:sweep -- --chain hoodi-vps --plan     the same
 *   npm run court:sweep -- --chain hoodi-vps --execute  sends every step possible now, from the deployer
 *
 * Every case the court ever opened (`caseCount`, `caseAt`), its state, its
 * asserted payload (recovered from `AssertionOpened` since the deployment's
 * `deployedFromBlock`, checked against the hash the court holds), and the next
 * permissionless step toward its close with the time it becomes possible:
 * scripts/lib/court-sweep.js says which steps it takes and which it never
 * takes. `--execute` sends the possible ones serially and prints the bond's
 * open-determination count after (`state().determinationsOpen`), which must
 * be zero before the bond issues again.
 *
 * The QRL client is the deployer's (`qrlClient()`, `.env`; `ARK_SIGNER`
 * picks another key of the same file). A relayer signing from the same key
 * at the same moment races it on the nonce: stop it, or sign with another key.
 *
 * Options: `--from-block N` (the log scan's start; default the deployment's
 * `deployedFromBlock`), `--from-index N` (the first case, one-based),
 * `--chunk N` (blocks per log request, default 5000).
 */
const fs = require('fs');
const path = require('path');

const { qrlClient, qrlAbiBuild, qrlBuild, qrvmBuild, iface, ROOT } = require('./lib/chains');
const { errorInterface } = require('../ecdsa-stakings/relayer/engine/errors');
const { toHex } = require('../ecdsa-stakings/relayer/lib/addresses');
const S = require('./lib/court-sweep');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

async function main() {
  const chain = flag('chain');
  if (!chain) throw new Error('usage: npm run court:sweep -- --chain <name> [--plan | --execute]');
  const execute = argv.includes('--execute');
  if (execute && argv.includes('--plan')) throw new Error('--plan and --execute exclude each other');
  const depFile = path.join(ROOT, 'deployments', `testnet-${chain}.json`);
  if (!fs.existsSync(depFile)) throw new Error(`no ${path.relative(ROOT, depFile)}`);
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'));
  const q = dep.qrl || {};
  if (!q.ArkStakeCourt || !q.ArkCatBond) throw new Error(`${path.relative(ROOT, depFile)} names no ArkStakeCourt / ArkCatBond`);
  const profile = dep.profile || 'testnet';

  const client = qrlClient({ name: 'qrl', confirmations: 2 });
  // The node must be the deployment's chain: a regenerated devnet answers the same id with another genesis.
  const id = await client.chainId();
  if (dep.qrlChainId !== undefined && id !== BigInt(dep.qrlChainId)) throw new Error(`the QRL RPC answers chain ${id}; ${path.basename(depFile)} was deployed on ${dep.qrlChainId}`);
  if (dep.qrlGenesisHash) {
    const g = await client.genesis();
    if (g.hash !== String(dep.qrlGenesisHash).toLowerCase()) throw new Error(`the node's genesis ${g.hash} is not the deployment's ${dep.qrlGenesisHash}: the devnet was regenerated`);
  }

  const abi = {
    court: iface('ArkStakeCourt', qrlAbiBuild(profile, 'ArkStakeCourt')),
    bond: iface('ArkCatBond', qrlAbiBuild(profile, 'ArkCatBond')),
  };
  const errors = errorInterface([qrlBuild(profile), qrvmBuild(profile)]);
  const at = { court: toHex(q.ArkStakeCourt), bond: toHex(q.ArkCatBond) };
  // A plan sends nothing: the client handed to the sweep cannot.
  const sender = execute ? client : { ...client, send: async () => { throw new Error('--plan sends nothing'); } };

  console.log(`court sweep on ${chain} (chain ${id}, profile ${profile}): court ${at.court.slice(0, 14)}…, bond ${at.bond.slice(0, 14)}…`);
  console.log(`mode ${execute ? 'EXECUTE' : 'plan (read only)'}${execute ? `, sender ${client.address.slice(0, 14)}…` : ''}\n`);
  const o = {
    client: sender,
    at,
    abi,
    errors,
    execute,
    fromBlock: BigInt(flag('from-block', dep.deployedFromBlock || 0)),
    fromIndex: BigInt(flag('from-index', '1')),
    chunk: BigInt(flag('chunk', '5000')),
    log: (m) => console.log(`   ${m}`),
  };
  const { before, after, results } = await S.sweep(o);
  console.log(S.summary(before));
  console.log('');
  console.log(S.table(before));
  if (!execute) {
    const now = before.cases.filter((x) => x.stage !== S.STAGE.FINAL && !x.plan.blocked && S.due(x.plan, before.now, before.block));
    console.log(`\n${now.length} step(s) possible now; nothing sent (--execute sends them)`);
    return;
  }
  console.log(`\nsent: ${results.filter((r) => r.ok).length} step(s), refused or failed: ${results.filter((r) => !r.ok).length}`);
  for (const r of results) console.log(`   ${r.ok ? 'ok    ' : 'FAILED'} ${r.step.padEnd(11)} ${r.id.slice(0, 12)}…${r.error ? ` ${r.error}` : ''}`);
  console.log('');
  console.log(S.summary(after));
  console.log('');
  console.log(S.table(after));
  console.log(`\nbond determinationsOpen after the sweep: ${after.bond.determinationsOpen}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
