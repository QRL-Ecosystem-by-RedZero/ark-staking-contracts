/**
 * Compiles contracts/**\/*.hyp with the Hyperion compiler and writes artifacts
 * (abi + bytecode) to build/, ABIs to abi/.
 *
 * Which compiler: HYPC_BIN (a native hypc binary) or HYPC_DOCKER_IMAGE (e.g.
 * hypc:local) when set, otherwise the npm module @theqrl/hypc. The npm module
 * is stuck at 0.0.2 (2025-02), which predates QRVM 512-bit codegen —
 * contracts meant for a QIP-55 / testnet v3 chain (64-byte addresses) MUST be
 * compiled through one of the overrides, and with ARK_QRVM=1 (or --qrvm) so
 * the v3 artifacts land beside the v2 build instead of over it.
 *
 * Differences from a Solidity/solc setup worth knowing:
 *  - `language` must be "Hyperion"; hypc rejects "Solidity" outright.
 *  - Output lives under `zvm` (Zond Virtual Machine) on the 0.0.x line; the
 *    QIP-55 compiler line renamed it `qrvm`.
 *  - The version pragma is `pragma hyperion >=0.0.1;`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { fromArgv, rewriteSources } = require('./lib/profile');

/** Runs --standard-json through whichever compiler the environment names. */
function makeCompiler() {
  const bin = process.env.HYPC_BIN;
  const image = process.env.HYPC_DOCKER_IMAGE;
  const cli = (cmd, args, label) => ({
    label,
    compile(input) {
      const run = spawnSync(cmd, [...args, '--standard-json'], {
        input,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (run.error) throw run.error;
      if (run.status !== 0) throw new Error(`${label} exited ${run.status}: ${run.stderr}`);
      return run.stdout;
    },
    version() {
      const run = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8' });
      const m = (run.stdout || '').match(/Version:\s*(\S+)/);
      return m ? m[1] : (run.stdout || '').trim().split('\n').pop();
    },
  });
  if (bin) return cli(bin, [], `hypc (${bin})`);
  if (image) return cli('docker', ['run', '--rm', '-i', image], `hypc (docker ${image})`);
  const hypc = require('@theqrl/hypc');
  return { label: 'hypc (npm)', compile: (input) => hypc.compile(input), version: () => hypc.version() };
}

// The v3 build is asked for, never inferred: an override compiler alone still
// writes to build/ (a newer binary producing the v2 target), and ARK_QRVM=1
// alone is refused, because the npm 0.0.2 module cannot produce QRVM 512-bit
// bytecode and silently labelling its output "qrvm" would be worse than
// stopping. Refused before makeCompiler(), whose emscripten module cannot be
// process.exit()ed over cleanly on Windows.
const QRVM = process.env.ARK_QRVM === '1' || process.argv.includes('--qrvm');
if (QRVM && !process.env.HYPC_BIN && !process.env.HYPC_DOCKER_IMAGE) {
  console.error('ARK_QRVM=1 needs HYPC_BIN or HYPC_DOCKER_IMAGE: npm @theqrl/hypc 0.0.2 predates QRVM 512-bit codegen');
  process.exit(1);
}

const hypc = makeCompiler();

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const PROFILE = fromArgv();
// A non-spec profile writes beside the spec build, never over it: build/ is what
// `npm test` and `npm run deploy` read, and it must stay the specification's.
// The QRVM (v3) build likewise: build-qrvm/ and abi-qrvm/, so the v2 harness
// build under build/ is never clobbered by a 512-bit artifact it cannot run.
const OUT = path.join(ROOT, `build${QRVM ? '-qrvm' : ''}${PROFILE.suffix}`);
const ABI_DIR = path.join(ROOT, QRVM ? 'abi-qrvm' : 'abi');

/**
 * Sources a profile never rewrites: vendored OpenZeppelin, and the §8.2
 * inherited contracts, which belong to another product and keep its durations.
 */
const PROFILE_EXEMPT = (file) =>
  file.startsWith('lib/') || ['ArkToken.hyp', 'VeArk.hyp', 'StakingVault.hyp'].includes(file);

/** Our own contracts, as opposed to vendored OpenZeppelin. */
const OWN = ['ArkToken', 'VeArk', 'StakingVault', 'ProceedsLedger', 'ArkStakeParams', 'ArkStakeParamsChecks', 'ArkStakeRegistry', 'ArkBondDelegation', 'ArkBondCoupon', 'ArkBondStaking', 'ArkCatBond', 'ArkCatBondExit', 'ArkCatBondSettlement', 'ArkCatBondRecovery', 'ArkCatBondDeterminations', 'PremiumSwap', 'PremiumSwapJudge', 'ArkStakingPool', 'ArkJurorPool', 'ArkStakeCourt', 'ArkCourtFindings', 'ArkReferenceOracle', 'ChunkedDeployer'];

/** Both ceilings, shared with `scripts/lib/chunked.js` so there is one of each. */
const { EIP170_LIMIT, DIRECT_DEPLOY_LIMIT } = require('./lib/limits');

function collectSources(dir, base = '') {
  const sources = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(sources, collectSources(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.hyp')) {
      sources[rel] = { content: fs.readFileSync(path.join(dir, entry.name), 'utf8') };
    }
  }
  return sources;
}

function main() {
  const { sources, rewrites } = rewriteSources(collectSources(CONTRACTS), PROFILE, PROFILE_EXEMPT);
  console.log(`hypc ${hypc.version()}`);
  console.log(`compiling ${Object.keys(sources).length} Hyperion sources, profile ${PROFILE.name}...\n`);
  for (const r of rewrites) console.log(`  ${PROFILE.name}: ${r.file}  ${r.from} -> ${r.to}`);

  const input = {
    language: 'Hyperion',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // hypc 0.0.x nests output under `zvm`; the QIP-55 line renamed it
      // `qrvm`. Ask for both, read whichever came back — each line ignores
      // the selection key it does not know.
      outputSelection: {
        '*': {
          '*': [
            'abi',
            'zvm.bytecode.object',
            'zvm.deployedBytecode.object',
            'qrvm.bytecode.object',
            'qrvm.deployedBytecode.object',
          ],
        },
      },
    },
  };

  const output = JSON.parse(hypc.compile(JSON.stringify(input)));

  let fatal = false;
  let warnings = 0;
  for (const err of output.errors || []) {
    if (err.severity === 'error') {
      fatal = true;
      console.error(err.formattedMessage);
    } else if (!/SPDX/.test(err.formattedMessage)) {
      warnings++;
      console.warn('warn:', err.formattedMessage.split('\n')[0]);
    }
  }
  if (fatal) process.exit(1);

  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(ABI_DIR, { recursive: true });

  const sizes = {};
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, c] of Object.entries(contracts)) {
      const vm = c.qrvm || c.zvm;
      const bytecode = vm && vm.bytecode && vm.bytecode.object;
      if (!bytecode) continue; // interface or abstract contract
      fs.writeFileSync(
        path.join(OUT, `${name}.json`),
        JSON.stringify(
          {
            contractName: name,
            sourceName: file,
            compiler: { name: 'hypc', version: hypc.version() },
            profile: PROFILE.name,
            abi: c.abi,
            bytecode: '0x' + bytecode,
            deployedBytecode: '0x' + vm.deployedBytecode.object,
          },
          null,
          2,
        ),
      );
      // A profile changes durations, never an interface, so abi/ has one copy.
      if (!PROFILE.suffix) fs.writeFileSync(path.join(ABI_DIR, `${name}.json`), JSON.stringify(c.abi, null, 2));
      sizes[name] = {
        init: bytecode.length / 2,
        runtime: vm.deployedBytecode.object.length / 2,
      };
    }
  }

  console.log('\n%s %s %s', 'contract'.padEnd(20), 'init'.padStart(8), 'runtime'.padStart(8));
  let over = false;
  for (const n of OWN) {
    if (!sizes[n]) {
      console.log('%s %s', n.padEnd(20), '   MISSING');
      over = true;
      continue;
    }
    const flags = [];
    if (sizes[n].runtime > EIP170_LIMIT) flags.push(`EXCEEDS EIP-170 ${EIP170_LIMIT}`);
    if (sizes[n].init > DIRECT_DEPLOY_LIMIT) flags.push('needs chunked deploy');
    if (sizes[n].runtime > EIP170_LIMIT) over = true;
    console.log(
      '%s %s %s%s',
      n.padEnd(20),
      String(sizes[n].init).padStart(8),
      String(sizes[n].runtime).padStart(8),
      flags.length ? '  << ' + flags.join(', ') : '',
    );
  }
  if (over) process.exit(1);

  console.log(`\n${warnings} warning(s). artifacts -> ${path.basename(OUT)}/, ABIs -> ${path.basename(ABI_DIR)}/`);
}

main();
