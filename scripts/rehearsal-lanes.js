/**
 * Parallel lanes for the rehearsal-v3 on-chain audit (audit 2026-10-03).
 *
 *   node scripts/rehearsal-lanes.js setup          # manifests, keys, RPC lines, funding
 *   node scripts/rehearsal-lanes.js run <lane>     # deploy both legs, run the lane's scenarios
 *   node scripts/rehearsal-lanes.js status         # one line per lane from its summary file
 *   node scripts/rehearsal-lanes.js rerun <lane> <scenario...>   # on the lane's deployment as it is, no redeploy
 *
 * One scenario after another on the 7-minute rapid profile is 12-15 hours;
 * the devnet host powers off at 02:00. A lane is a deployment of its own
 * (`rehearsal-v3-<lane>`): its own QRL key (`REHEARSAL_<LANE>_MNEMONIC`, funded
 * from the REHEARSAL key, so nothing races the VPS relayer's nonce), its own
 * Hardhat account on the shared local origin node, its own relayer state. The
 * lanes run side by side and do not see each other's contracts.
 *
 * A lane runs its scenarios in order on one deployment; a terminal scenario
 * after the first gets a fresh deployment of its own, as e2e:local gives every
 * scenario. Each lane writes reports/rehearsal-lanes/<lane>.log and .json.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { HDNodeWallet, Mnemonic } = require('ethers');
const { MLDSA87 } = require('@theqrl/wallet.js');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const OUT = path.join(ROOT, 'reports', 'rehearsal-lanes');
const ONE = 10n ** 18n;
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

/** template: the manifest a lane copies; account: its Hardhat account index; bond and fund in QRL. */
const LANES = {
  l1: { template: 'rehearsal-v3', account: 2, bond: 30_000n, fund: 60_000n, scenarios: ['swap-live', 'swap-preemption'] },
  l2: { template: 'rehearsal-v3', account: 3, bond: 80_000n, fund: 130_000n, scenarios: ['court-live'] },
  l3: { template: 'rehearsal-v3', account: 4, bond: 80_000n, fund: 110_000n, scenarios: ['bond-lifecycle'] },
  l4: { template: 'rehearsal-v3', account: 5, bond: 30_000n, fund: 60_000n, scenarios: ['leg-a-live', 'leg-b-live'] },
  l5: { template: 'rehearsal-v3', account: 6, bond: 80_000n, fund: 110_000n, scenarios: ['bond-recovery'] },
  l6: { template: 'rehearsal-v3', account: 7, bond: 30_000n, fund: 60_000n, scenarios: ['leg-a-close'] },
  l7: { template: 'rehearsal-v3', account: 8, bond: 30_000n, fund: 150_000n, scenarios: ['leg-a-seed-return', 'leg-b-exit'] },
  l8: {
    template: 'rehearsal-v3',
    account: 9,
    bond: 30_000n,
    fund: 60_000n,
    scenarios: ['atomic-yield-flow', 'solver-service', 'release-wave', 'freeze', 'loss', 'restart', 'censorship'],
  },
  l9: { template: 'rehearsal-v3', account: 10, bond: 30_000n, fund: 90_000n, scenarios: ['delist', 'qday'] },
  // The rapid profile's quote window is one day = 60 s (~5 slots): live quotes
  // land after it closes (OC-OPS-11), so the swap runs again at the testnet profile.
  s1: { template: 'rehearsal-v3', profile: 'testnet', account: 12, bond: 15_000n, fund: 39_000n, scenarios: ['swap-live', 'swap-preemption'] },
  // Round 2: fresh deployments, with every v3 fix, for what failed in round 1
  // on a v3 incompatibility of the scenarios or on a deployment a rerun left dirty.
  r2: { template: 'rehearsal-v3', account: 13, bond: 15_000n, fund: 30_000n, scenarios: ['court-live'] },
  r3: { template: 'rehearsal-v3', account: 14, bond: 15_000n, fund: 105_000n, scenarios: ['bond-lifecycle'] },
  r5: { template: 'rehearsal-v3', account: 15, bond: 15_000n, fund: 50_000n, scenarios: ['bond-recovery'] },
  r6: { template: 'rehearsal-v3', account: 19, bond: 15_000n, fund: 40_000n, scenarios: ['leg-a-close'] },
  r7: { template: 'rehearsal-v3', account: 16, bond: 15_000n, fund: 100_000n, scenarios: ['leg-b-exit'] },
  r8: { template: 'rehearsal-v3', account: 18, bond: 15_000n, fund: 30_000n, scenarios: ['atomic-yield-flow', 'release-wave'] },
  r9: { template: 'rehearsal-v3', account: 17, bond: 15_000n, fund: 45_000n, scenarios: ['delist', 'qday'] },
  // On the second Hardhat node (8549, same-timestamp blocks allowed): the
  // first ran 490 s ahead of wall time under load, and these failed on that.
  t2: { template: 'rehearsal-v3', rpc: 'http://127.0.0.1:8549', account: 4, bond: 15_000n, fund: 35_000n, scenarios: ['court-live'] },
  t3: { template: 'rehearsal-v3', rpc: 'http://127.0.0.1:8549', account: 2, bond: 15_000n, fund: 90_000n, scenarios: ['bond-lifecycle'] },
  t4: { template: 'rehearsal-v3', rpc: 'http://127.0.0.1:8549', account: 3, bond: 15_000n, fund: 30_000n, scenarios: ['leg-a-live'] },
  g1: { template: 'rehearsal-v3-gov', account: 11, bond: 80_000n, fund: 190_000n, scenarios: ['governance-live', 'governance-qday'] },
};

const TERMINAL = new Set(['delist', 'qday', 'governance-qday', 'bond-recovery', 'leg-a-close', 'leg-a-seed-return', 'leg-b-exit']);

const chainOf = (lane) => `rehearsal-v3-${lane}`;
const envKey = (chain) => chain.toUpperCase().replace(/-/g, '_');
const signerOf = (lane) => `REHEARSAL_${lane.toUpperCase()}`;

function readEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(ENV, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

async function setup() {
  const env = readEnv();
  const add = [];
  for (const [lane, cfg] of Object.entries(LANES)) {
    const chain = chainOf(lane);
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'ecdsa-stakings', cfg.template, 'chain.json'), 'utf8'));
    const m = { ...tpl, name: chain, deployedFromBlock: 0, bondPrincipal: (cfg.bond * ONE).toString(), ...(cfg.profile ? { profile: cfg.profile } : {}) };
    m.assets = tpl.assets.map((a) => ({ ...a, address: null, escrow: null }));
    m.addresses = { relay: null, operationsDestination: tpl.addresses.operationsDestination };
    delete m.authority;
    // A lane is its own network on purpose (2026-10-07: one stack per QRL
    // network): its terminal scenarios must not close another lane's stack.
    if (m.governance) m.governance = { selfDeploy: m.governance.selfDeploy, network: chain };
    m.note = `rehearsal lane ${lane} (scripts/rehearsal-lanes.js): ${cfg.scenarios.join(', ')}`;
    // Never over a lane that exists: its manifest holds the relay, escrows and
    // authority its deployment wrote (a rewrite reset them mid-run once).
    const manifestFile = path.join(ROOT, 'ecdsa-stakings', chain, 'chain.json');
    if (!fs.existsSync(manifestFile)) {
      fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
      fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n');
    }

    const key = envKey(chain);
    const hd = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_MNEMONIC), `m/44'/60'/0'/0/${cfg.account}`);
    if (!env[`${key}_RPC_URL`]) add.push(`${key}_RPC_URL=${cfg.rpc || 'http://127.0.0.1:8548'}`);
    if (!env[`${key}_PRIVATE_KEY`]) add.push(`${key}_PRIVATE_KEY=${hd.privateKey}`);
    if (!env[`${signerOf(lane)}_MNEMONIC`]) add.push(`${signerOf(lane)}_MNEMONIC=${MLDSA87.newWallet().getMnemonic()}`);
  }
  if (add.length) {
    fs.appendFileSync(ENV, `\n# rehearsal lanes (scripts/rehearsal-lanes.js, audit 2026-10-03); Hardhat keys are the public defaults\n${add.join('\n')}\n`);
    console.log(`.env: ${add.length} lines added (keys not printed)`);
  }

  // Fund each lane's QRL key from the REHEARSAL key, topped up to its allowance.
  process.env.ARK_SIGNER = 'REHEARSAL';
  const { qrlClient } = require('./lib/chains');
  const qrl = require('./qrl');
  const funder = qrlClient();
  const fresh = readEnv();
  for (const [lane, cfg] of Object.entries(LANES)) {
    // Only a lane that has not run yet: a lane that ran has spent on its bond and
    // actors, and topping it back up drained the funder once (2026-10-03).
    if (fs.existsSync(path.join(OUT, `${lane}.json`))) continue;
    const wallet = MLDSA87.newWalletFromMnemonic(fresh[`${signerOf(lane)}_MNEMONIC`]);
    const { web3 } = qrl.connect({ extendedSeed: wallet.getHexExtendedSeed() });
    const address = web3.qrl.accounts.seedToAccount(wallet.getHexExtendedSeed()).address;
    const want = cfg.fund * ONE;
    const have = BigInt(await funder.balance(address));
    if (have < want) await funder.transfer(address, want - have);
    console.log(`${lane}  ${chainOf(lane).padEnd(18)} ${address.slice(0, 14)}…  ${String((have < want ? want : have) / ONE).padStart(7)} QRL  ${cfg.scenarios.join(', ')}`);
  }
  console.log(`REHEARSAL left: ${BigInt(await funder.balance(funder.address)) / ONE} QRL`);
}

/** The chain a report under reports/e2e was run on: a lane takes only its own. */
function reportChain(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'e2e', file), 'utf8')).chain;
  } catch {
    return null;
  }
}

function sh(cmd, args, env, log) {
  fs.appendFileSync(log, `\n$ ${cmd} ${args.join(' ')}  [${new Date().toISOString()}]\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 << 20 });
  fs.appendFileSync(log, (r.stdout || '') + (r.stderr || ''));
  return r.status === 0;
}

function run(lane) {
  const cfg = LANES[lane];
  if (!cfg) throw new Error(`unknown lane ${lane}; lanes: ${Object.keys(LANES).join(', ')}`);
  fs.mkdirSync(OUT, { recursive: true });
  const log = path.join(OUT, `${lane}.log`);
  const summaryFile = path.join(OUT, `${lane}.json`);
  const chain = chainOf(lane);
  const env = { ARK_SIGNER: signerOf(lane) };
  const summary = { lane, chain, started: new Date().toISOString(), scenarios: [] };
  const save = () => fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'ecdsa-stakings', chain, 'chain.json'), 'utf8')).profile;
  // The origin leg is compiled per chain directory; a lane's is new.
  if (!fs.existsSync(path.join(ROOT, 'ecdsa-stakings', chain, `build-${profile}`, 'ArkEpochRootRelay.json'))) {
    sh('node', [path.join('scripts', 'compile-evm.js'), '--profile', profile, '--chain', chain], env, log);
  }
  const governed = Boolean(JSON.parse(fs.readFileSync(path.join(ROOT, 'ecdsa-stakings', chain, 'chain.json'), 'utf8')).governance);
  // A lane on core's governance (the -gov template) deploys the stack first: the leg reads its record.
  const deploy = () =>
    sh('npm', ['run', 'deploy:evm', '--', '--chain', chain, '--allow-strand'], env, log) &&
    (!governed || sh('npm', ['run', 'deploy:governance', '--', '--chain', chain], env, log)) &&
    sh('npm', ['run', 'deploy:testnet', '--', '--chain', chain], env, log);

  let deployed = false;
  for (const [i, scenario] of cfg.scenarios.entries()) {
    if (!deployed || (TERMINAL.has(scenario) && i > 0)) {
      const ok = deploy();
      summary.scenarios.push({ scenario: `deploy before ${scenario}`, ok, at: new Date().toISOString() });
      save();
      if (!ok) break;
      deployed = true;
    }
    const t0 = Date.now();
    const ok = sh('npm', ['run', 'e2e', '--', '--chain', chain, '--scenario', scenario], env, log);
    const reports = fs.readdirSync(path.join(ROOT, 'reports', 'e2e')).filter((f) => f.startsWith(`${scenario}-`) && reportChain(f) === chain).sort();
    const report = reports.length ? path.join('reports', 'e2e', reports[reports.length - 1]) : null;
    summary.scenarios.push({ scenario, ok, minutes: Math.round((Date.now() - t0) / 60000), report });
    save();
  }
  summary.ended = new Date().toISOString();
  save();
  console.log(JSON.stringify(summary, null, 2));
}

/** Runs scenarios again on the lane's existing deployment (no bond is locked again); appends to its summary. */
function rerun(lane, scenarios) {
  const f = path.join(OUT, `${lane}.json`);
  const summary = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { lane, chain: chainOf(lane), scenarios: [] };
  delete summary.ended;
  const log = path.join(OUT, `${lane}.log`);
  const env = { ARK_SIGNER: signerOf(lane) };
  for (const scenario of scenarios) {
    const t0 = Date.now();
    const ok = sh('npm', ['run', 'e2e', '--', '--chain', chainOf(lane), '--scenario', scenario], env, log);
    const reports = fs.readdirSync(path.join(ROOT, 'reports', 'e2e')).filter((x) => x.startsWith(`${scenario}-`) && reportChain(x) === chainOf(lane)).sort();
    summary.scenarios.push({ scenario: `${scenario} (rerun)`, ok, minutes: Math.round((Date.now() - t0) / 60000), report: reports.length ? path.join('reports', 'e2e', reports[reports.length - 1]) : null });
    fs.writeFileSync(f, JSON.stringify(summary, null, 2));
  }
  summary.ended = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(summary, null, 2));
}

function status() {
  for (const lane of Object.keys(LANES)) {
    const f = path.join(OUT, `${lane}.json`);
    if (!fs.existsSync(f)) {
      console.log(`${lane}  not started`);
      continue;
    }
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    const line = s.scenarios.map((x) => `${x.scenario}:${x.ok ? 'ok' : 'FAIL'}${x.minutes !== undefined ? `(${x.minutes}m)` : ''}`).join('  ');
    console.log(`${lane}  ${s.ended ? 'done' : 'running'}  ${line}`);
  }
}

const [cmd, lane] = process.argv.slice(2);
if (cmd === 'setup') setup().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
else if (cmd === 'run') run(lane);
else if (cmd === 'status') status();
else if (cmd === 'rerun') rerun(lane, process.argv.slice(4));
else {
  console.error('usage: node scripts/rehearsal-lanes.js setup | run <lane> | status');
  process.exit(1);
}
