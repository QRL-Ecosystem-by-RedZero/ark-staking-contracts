/**
 * Every cross-leg scenario, both legs, one ZVM, no node.
 *
 *   npm run e2e:local                              every scenario
 *   npm run e2e:local -- --scenario release-wave   one of them
 *   npm run e2e:local -- --scenario happy-path --oracle real
 *                                                  on ArkReferenceOracle, its reporters in-process
 *
 * The valuation oracle: `MockPriceOracle` unless the scenario asks for the
 * real one (`priceOracle: 'ArkReferenceOracle'`, oracle-live) or `--oracle
 * real` is given. The real one is deployed with three harness reporters,
 * quorum two (`helpers/oracle.js`), warmed up on the harness clock before the
 * scenario starts (thirty days and twenty-four hours of accepted rounds and a
 * mark: 5.2 – 6.2 h of testnet-profile time, seconds here) with the relayer
 * ticking and sealing a root each epoch (I40), and only then is
 * the manifest's bond principal subscribed, issuance being suspended while
 * the series is silent. The reporters keep posting through the scenario.
 *
 * The one rule this runner exists to enforce: **nothing reaches a node that
 * has not first run here.** It deploys through scripts/lib/deploy.js and
 * drives scripts/e2e/scenarios/ through the same relayer engine that will run
 * against Hoodi; what differs is only the transport (`harnessClient`) and the
 * clock, which here can be moved. A scenario that needs ten hours of real
 * epochs takes seconds.
 *
 * The chain it builds is generated, not checked in: `ecdsa-stakings/local/` is
 * written here — manifest, then artifacts through the testnet-profile compiler
 * — and gitignored, because its addresses change with every run.
 *
 * What it cannot show, and what the enclave and Hoodi are for: ML-DSA-87
 * signing and the 50KB envelope, real gas and real finality, a rebasing token
 * nobody controls, and a relayer that must survive its own restart.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { Ctx, Relayer } = require('./e2e/lib');
const { originClient, resetClients, qrlBuild, ROOT } = require('./lib/chains');
const { deployOrigin, deployQrlLeg, envKey, bondPrincipalOf, BOND_PRINCIPAL } = require('./lib/deploy');
const { iface } = require('./lib/chains');
const oracleHelper = require('./e2e/helpers/oracle');
const gov = require('./lib/governance');
const manifestLib = require('../ecdsa-stakings/relayer/lib/manifest');

// ARK_E2E_CHAIN=local-<name> gives a run its own manifest, build, relayer
// state and deployment record, so two runs can go side by side.
const CHAIN = process.env.ARK_E2E_CHAIN || 'local';
if (!/^local(-[a-z0-9]+)?$/.test(CHAIN)) throw new Error(`ARK_E2E_CHAIN must be local or local-<name>, not ${CHAIN}`);
const SCENARIOS = path.join(__dirname, 'e2e', 'scenarios');
/** Hardhat's, and not any public chain's: the harness answers with it. */
const CHAIN_ID = 31337;
/** The local relay's tree height: see runOne. */
const LOCAL_TREE_HEIGHT = 8;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

/** The generated manifest. Two assets, one of each escrow form. */
const TEMPLATE = {
  name: CHAIN,
  chainId: CHAIN_ID,
  profile: 'testnet',
  client: 'harness',
  evmVersion: 'shanghai',
  // The harness QRL leg is the v2 build, whose accounts are 20 bytes (D14).
  qrlOwnerLength: 20,
  // The reference signer set of whitepaper §3.6, two of three, so every
  // scenario runs root admission under the threshold (D1).
  rootSigners: { threshold: 2, signers: 3 },
  finality: 'confirmations',
  confirmations: 1,
  deliveryMarginSeconds: 30,
  deployedFromBlock: 0,
  assets: [
    { symbol: 'mUNIT', mock: 'MockAsset', address: null, rebasing: false, correlationGroup: 'group:mock-units', exitBoundBps: 2500, escrow: null },
    { symbol: 'mREB', mock: 'MockRebasingAsset', address: null, rebasing: true, correlationGroup: 'group:lido-like', exitBoundBps: 2500, escrow: null },
  ],
  // The operations destination is named, never minted (re-audit 2026-09-30, ORIGIN-07): a fixed local address.
  addresses: { relay: null, operationsDestination: '0x' + 'e0'.repeat(20) },
  // The scenarios price a partly covered book, so the harness subscribes on
  // purpose; a real manifest names bond principal only as a team allocation.
  bondPrincipal: BOND_PRINCIPAL.toString(),
};

function prepareChain() {
  const file = manifestLib.manifestPath(CHAIN);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Addresses are rewritten by every deployment, so the manifest starts empty
  // each run rather than carrying the last run's escrows.
  fs.writeFileSync(file, JSON.stringify(TEMPLATE, null, 2) + '\n');
  // So does a governance record: each scenario is a new chain, and a record
  // left by the last one is stale here (deployQrlLeg would refuse it).
  fs.rmSync(gov.governanceRecordPath(CHAIN), { force: true });

  // Rebuild when a source is newer than its artifact, not only when the
  // artifact is missing: a stale build deploys yesterday's constructor and
  // every scenario fails before it starts (OC-OPS-01, audit 2026-10-03).
  const build = path.join(ROOT, 'ecdsa-stakings', CHAIN, 'build-testnet');
  const originArtifact = path.join(build, 'ArkStakeEscrowUnits.json');
  if (stale(originArtifact, path.join(ROOT, 'ecdsa-stakings', 'shared', 'contracts'), '.sol')) {
    console.log('compiling the origin leg for the local chain (profile testnet)…');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'compile-evm.js'), '--profile', 'testnet', '--chain', CHAIN], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
  if (stale(path.join(qrlBuild('testnet'), 'ArkStakeRegistry.json'), path.join(ROOT, 'contracts'), '.hyp')) {
    console.log('compiling the QRL leg (profile testnet)…');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'compile.js'), '--profile', 'testnet'], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}

/** True when `artifact` is missing or older than any `ext` file under `sources`. */
function stale(artifact, sources, ext) {
  if (!fs.existsSync(artifact)) return true;
  const built = fs.statSync(artifact).mtimeMs;
  return fs
    .readdirSync(sources, { recursive: true })
    .some((f) => String(f).endsWith(ext) && fs.statSync(path.join(sources, String(f))).mtimeMs > built);
}

async function runOne(name, opts) {
  const scenario = require(path.join(SCENARIOS, `${name}.js`));
  prepareChain();

  const { client, manifest, build } = await originClient(CHAIN);
  console.log(`\n=== ${name}: ${scenario.description}`);
  const quiet = () => {};
  // Height 8: 256 leaves per generation, far more roots than any scenario
  // admits, and four generations of three trees generated in seconds.
  const origin = await deployOrigin({ client, chain: CHAIN, manifest, build, log: quiet, persistEnv: false, treeHeight: LOCAL_TREE_HEIGHT });
  // A scenario that asks for it gets contracts/core's governance stack first,
  // deployed from the vendored artifacts exactly as the relayer deploys it
  // after a devnet reset (engine/redeploy.js): the stack, the role accounts
  // funded, then the leg wired to the record.
  let governanceRecord = null;
  if (scenario.governance) {
    const govBuild = gov.governanceBuild({ client, profileName: origin.manifest.profile });
    const { c, errors } = gov.governanceConfig({ chain: CHAIN, manifest: origin.manifest, deployer: client.address, overrides: scenario.governance });
    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
    const { file } = await gov.deployGovernance({ client, chain: CHAIN, manifest: origin.manifest, config: c, build: govBuild, log: quiet });
    await gov.fundAccounts({ client, plan: gov.fundingPlan({ me: client.address, config: c }), log: quiet });
    governanceRecord = file;
  }
  // The valuation oracle: the scenario's, else --oracle, else the double.
  // The harness environment is .env's (safeEnv); the chain-scoped keys set
  // here take precedence over anything an operator keeps there.
  const oracleKind = scenario.priceOracle || (opts.oracle === 'real' ? 'ArkReferenceOracle' : 'MockPriceOracle');
  const realOracle = oracleKind === 'ArkReferenceOracle';
  const K = envKey(CHAIN);
  const env0 = client.env;
  client.env = { ...env0, ARK_PRICE_ORACLE: oracleKind };
  if (realOracle) {
    Object.assign(client.env, {
      [`${K}_ORACLE_REPORTERS`]: oracleHelper.harnessReporterAddresses().join(','),
      [`${K}_ORACLE_REPORTER_QUORUM`]: '2',
    });
    const o = scenario.oracleSettings || {};
    if (o.roundIntervalSeconds) client.env[`${K}_ORACLE_ROUND_INTERVAL_SECONDS`] = String(o.roundIntervalSeconds);
    if (o.heartbeatSeconds) client.env[`${K}_ORACLE_HEARTBEAT_SECONDS`] = String(o.heartbeatSeconds);
    if (o.maxStepBps) client.env[`${K}_ORACLE_MAX_STEP_BPS`] = String(o.maxStepBps);
  }
  let deployment;
  try {
    deployment = await deployQrlLeg({ client, chain: CHAIN, manifest: origin.manifest, log: quiet, governanceRecord });
  } finally {
    client.env = env0;
  }
  console.log(`    deployed: relay ${origin.relay.slice(0, 12)}…, ${deployment.assets.length} escrows, registry ${deployment.qrl.ArkStakeRegistry.slice(0, 12)}…, ${oracleKind}`);

  const relayer = await new Relayer({ chain: CHAIN, seeds: origin.seeds, treeHeight: origin.treeHeight, log: opts.verbose ? console.log : quiet }).init();
  // On the harness a poll is a jump of the clock, so the scenario's waits cross
  // epochs instead of waiting for them.
  const ctx = new Ctx(relayer, name, { poll: Number(flag('poll', '420')) });
  let failure = null;
  try {
    if (realOracle) {
      // The reporters in-process, the warm-up on the harness clock, then the
      // principal deployQrlLeg leaves unsubscribed while the series is silent.
      const h = await oracleHelper.attachReporters(ctx, { verbose: opts.verbose });
      const took = await oracleHelper.warmUp(ctx, h);
      console.log(`    ArkReferenceOracle warmed up in ${took} s of chain time (${h.reporter.stats.rounds} rounds, ${h.reporter.stats.reports} reports, ${h.reporter.stats.yields} yield reports)`);
      const principal = bondPrincipalOf(origin.manifest);
      if (principal > 0n) {
        await client.send(deployment.qrl.ArkCatBond, iface('ArkCatBond', qrlBuild(origin.manifest.profile)), 'subscribe', [1, 0], { value: principal });
        ctx.note(`subscribed ${principal / 10n ** 18n} QRL of manifest bondPrincipal once the series answered`);
      }
    }
    await scenario.run(ctx, opts);
  } catch (e) {
    failure = e.stack || e.message;
  }
  // As in e2e.js: the read-only invariant checks close every scenario.
  let invariants = null;
  try {
    const s = await ctx.invariants('end');
    invariants = { held: s.held, violated: s.violated.map((v) => v.id), known: s.known.map((v) => `${v.id}:${v.known}`), skipped: s.skipped };
    if (!failure && s.violated.length) failure = `invariants violated: ${invariants.violated.join(', ')}`;
  } catch (e) {
    invariants = { error: e.message };
  }
  const report = ctx.save({ outOfScope: scenario.outOfScope || [], failure, invariants, local: true });
  // The relayer the scenario ended with: a restart replaces the one started
  // here, and the lock it holds would stop the next scenario's deployment.
  ctx.r.close();
  console.log(`    ${failure ? 'FAILED' : 'passed'}: ${ctx.checks} rules asserted -> ${path.relative(ROOT, report)}`);
  if (failure) console.error(failure);
  return !failure;
}

async function main() {
  const only = flag('scenario');
  const names = only
    ? [only]
    // qday closes the escrow permanently, so it runs last even here, where each
    // scenario gets its own deployment.
    : ['happy-path', 'happy-path:mREB', 'atomic-yield-flow', 'atomic-yield-flow:mREB', 'solver-service', 'release-wave', 'freeze', 'loss', 'restart', 'censorship', 'delist',
        // OC audit 2026-10-03: the live-audit scenarios, non-terminal first.
        'governance-live', 'court-live', 'swap-live', 'swap-preemption', 'bond-lifecycle', 'leg-a-live', 'leg-b-live',
        // 2026-10-05: ArkReferenceOracle, its reporters, silence and the breaker (non-terminal).
        'oracle-live',
        'governance-qday', 'qday', 'bond-recovery', 'leg-a-close', 'leg-a-seed-return', 'leg-b-exit'];
  const opts = { asset: flag('asset'), epochs: flag('epochs'), notional: flag('notional'), positions: flag('positions'), quantity: flag('quantity'), oracle: flag('oracle', 'mock'), verbose: argv.includes('--verbose') };
  if (!['mock', 'real'].includes(opts.oracle)) throw new Error(`--oracle is mock or real, not ${opts.oracle}`);

  const results = [];
  for (const entry of names) {
    // "scenario:asset" runs the same scenario against the other escrow form;
    // the rebasing one is where principal is recorded in shares.
    const [name, asset] = entry.split(':');
    // Each scenario gets its own chain: a scenario that closes the escrow, or
    // fills a buffer, must not decide what the next one sees.
    resetClients();
    results.push([entry, await runOne(name, asset ? { ...opts, asset } : opts)]);
  }
  console.log('\nsummary');
  for (const [name, ok] of results) console.log(`   ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (results.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
