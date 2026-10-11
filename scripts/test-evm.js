/**
 * Runs the origin-chain and relayer suites.
 *
 * A second runner rather than an extension of test/run.js, deliberately. That
 * file guards on `build/StakingVault.json` and exits with a pointer to
 * `npm run build`; teaching it about a second toolchain means either a second
 * hard guard — which turns `npm test` red for anyone who has not run
 * `compile:evm`, over 253 tests that have nothing to do with it — or a
 * conditional one, which is a runner that silently runs zero EVM tests. Keeping
 * `npm test` meaning exactly what it has always meant also keeps a bisect over
 * the QRL history uncontaminated. `npm run check` runs both.
 *
 * Two suites, with different prerequisites and different failure modes:
 *
 *  - `contracts` needs solc artifacts and executes bytecode.
 *  - `relay` is pure logic, needs no compiler at all, and runs in under a
 *    second. That is the point of separating the relayer's hashing and tree
 *    building from its I/O: the protocol can be checked before either compiler.
 *
 * The relayer's agreement with the *deployed* contracts is not tested here — it
 * lives in test/ArkStakeRelayMerkle.test.js, under the QRL runner, because that
 * is where the artifacts are.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const manifest = require('../ecdsa-stakings/relayer/lib/manifest');

const ROOT = path.join(__dirname, '..');
const STAKINGS = path.join(ROOT, 'ecdsa-stakings');

/** Written by scripts/compile-evm.js; its absence means the suite cannot run. */
const SENTINEL = 'ArkStakeIdsHarness.json';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const suite = flag('suite', 'all');
const onlyChain = flag('chain', null);

/** One level, matching test/run.js's non-recursive habit. */
function testsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(dir, f));
}

function contractFiles() {
  // The suite runs against spec-profile builds only: its tests move the clock
  // by the specification's durations, which a time-compressed build does not have.
  const chains = onlyChain ? [onlyChain] : manifest.chains({ profile: 'spec' });
  for (const chain of chains) {
    const build = path.join(STAKINGS, chain, 'build');
    if (!fs.existsSync(path.join(build, SENTINEL))) {
      console.error(
        `no EVM artifacts in ecdsa-stakings/${chain}/build/ — run: npm run compile:evm`,
      );
      process.exit(1);
    }
  }
  return [
    ...testsIn(path.join(STAKINGS, 'shared', 'test')),
    ...chains.flatMap((chain) => testsIn(path.join(STAKINGS, chain, 'test'))),
  ];
}

const relayFiles = () => testsIn(path.join(STAKINGS, 'relayer', 'test'));

const files = [];
if (suite === 'contracts' || suite === 'all') files.push(...contractFiles());
if (suite === 'relay' || suite === 'all') files.push(...relayFiles());

if (!['contracts', 'relay', 'all'].includes(suite)) {
  console.error(`unknown --suite ${suite}; expected contracts, relay or all`);
  process.exit(1);
}

if (!files.length) {
  console.error(`no test files found for --suite ${suite}`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
