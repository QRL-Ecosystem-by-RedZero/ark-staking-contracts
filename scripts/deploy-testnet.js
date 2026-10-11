/**
 * Deploys the QRL leg of a testnet-profile deployment on the private enclave,
 * wired to one origin chain's manifest, and admits that chain's assets.
 *
 *   npm run deploy:testnet -- --chain hoodi
 *   npm run deploy:testnet -- --chain hoodi-vps --plan   # what would be deployed; sends and reads nothing
 *
 * The QRL leg stays on the Kurtosis enclave under the private-only rule of
 * CLAUDE.md §4 — `connect()` still refuses a public RPC. Only the origin leg
 * goes public, and only as a testnet-profile build.
 *
 * Unlike `npm run deploy` this exercises nothing: the scenarios of
 * scripts/e2e/ do, across real epochs. The deployment itself is
 * scripts/lib/deploy.js, the same function the local harness run uses.
 */
const { qrlClient } = require('./lib/chains');
const { deployQrlLeg, planQrlLeg } = require('./lib/deploy');
const manifestLib = require('../ecdsa-stakings/relayer/lib/manifest');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const chain = arg('chain');
  if (!chain) throw new Error('usage: npm run deploy:testnet -- --chain <name>');
  const m = manifestLib.load(chain);
  if (m.profile === 'spec') throw new Error(`${chain} is a spec-profile manifest; this script deploys time-compressed builds only`);
  // The rehearsal chain is the enclave itself, so this is the same client and
  // the same chain as its origin leg — that is the point of it. The harness
  // chain exists only inside `npm run e2e:local`, which deploys both legs.
  if (m.client === 'harness') throw new Error(`${chain} is the local harness; run: npm run e2e:local -- --scenario <name>`);

  const client = qrlClient();
  if (process.argv.includes('--plan')) {
    // No RPC read and nothing sent: the build, the sizes and routes, the roles.
    const plan = planQrlLeg({ client, chain, manifest: m });
    console.log(`plan     ${chain}: build ${plan.build}, court ${plan.court}, Q-Day oracle ${plan.qday}`);
    console.log(`governance record: ${plan.governance || 'none (the doubles)'}`);
    if (plan.arkPhase) console.log(`ark phase: ${plan.arkPhase.kind}${plan.arkPhase.address ? ` ${plan.arkPhase.address}` : ''}, ${plan.arkPhase.source}; rows ${plan.arkPhase.rows}`);
    if (plan.roles) console.log(`roles    ${JSON.stringify(plan.roles)}`);
    if (plan.oracle) {
      const o = plan.oracle;
      console.log(`oracle   ${o.kind}${o.reporters ? `: ${o.reporters.length} reporters, quorum ${o.quorum}, τ_o ${o.roundIntervalSeconds} s, heartbeat ${o.heartbeatSeconds} s, s_obs ${o.maxStepBps} bps` : ''}`);
      for (const f of o.funding || []) console.log(`funding  ${f.label.padEnd(16)} ${f.address}  topped up to ${f.targetQrl} QRL (QRL_ROLE_FUNDING)`);
    }
    console.table(Object.fromEntries(plan.rows.map((r) => [r.contract, { init: r.init, runtime: r.runtime, route: r.route }])));
    if (plan.errors.length) {
      console.error('\nwould refuse:\n  ' + plan.errors.join('\n  '));
      process.exit(1);
    }
    console.log('\nplan ok; nothing was sent');
    return;
  }
  console.log(`QRL      ${client.env.QRL_RPC_URL}  chainId ${await client.chainId()}`);
  console.log(`origin   ${chain}  chainId ${m.chainId}`);
  console.log(`deployer ${client.address}\n`);

  await deployQrlLeg({ client, chain, manifest: m });
  console.log(`next: npm run relay -- --chain ${chain}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
