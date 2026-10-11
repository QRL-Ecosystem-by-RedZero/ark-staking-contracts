#!/usr/bin/env node
/**
 * Vendors contracts/core's BUILT governance artifacts into this tree, for
 * deployment only.
 *
 *   npm run vendor:governance                      # testnet profile, both lines present in core
 *   npm run vendor:governance -- --profile rapid
 *   CORE_DIR=/path/to/core npm run vendor:governance
 *
 * Build them in contracts/core first:
 *   node scripts/compile.js --profile testnet                                  # build-testnet/ (harness line)
 *   HYPC_DOCKER_IMAGE=hypc:local ARK_QRVM=1 node scripts/compile.js --profile testnet   # build-qrvm-testnet/ (v3)
 *
 * The one rule this script exists to enforce: **what is vendored is core's
 * compiled output at this tree's clock, byte for byte, and says where it came
 * from.** The repositories do not import each other's sources (CLAUDE.md
 * §3.2); nothing here compiles a line of core. The relayer on the VPS
 * redeploys the governance stack after every devnet reset from these files
 * (`scripts/lib/governance.js`), because the devnet regenerates from genesis
 * daily and core's checkout is not on that host.
 *
 * Each artifact must record the profile it was built at, and that profile's
 * day must equal this tree's (`scripts/lib/profile.js`): a governance stack on
 * another clock would number epochs differently from the contracts it governs
 * (core design N5). `vendor/core-governance/MANIFEST.json` records, per line,
 * core's commit (and whether its tree was dirty), the compiler, and the
 * sha256 and sizes of every artifact; `governance.js` refuses a vendored
 * directory whose files no longer hash to it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { profile } = require('./lib/profile');
const { EIP170_LIMIT } = require('./lib/limits');
const { GOVERNANCE_CONTRACTS, VENDOR_DIR, INITCODE_LIMIT, vendoredLine } = require('./lib/governance');

const ROOT = path.join(__dirname, '..');
// The ecosystem layer's checkout (ark-ecosystem-contracts); in the workspace it sits at
// projects/ecosystem/contracts. ARK_CORE_DIR names it elsewhere (CORE_DIR is still read).
const CORE = path.resolve(process.env.ARK_CORE_DIR || process.env.CORE_DIR || path.join(ROOT, '..', '..', 'ecosystem', 'contracts'));

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const size = (hex) => (String(hex).length - 2) / 2;

function coreCommit() {
  const head = spawnSync('git', ['-C', CORE, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['-C', CORE, 'status', '--porcelain', '--', 'contracts', 'scripts/compile.js', 'scripts/lib'], { encoding: 'utf8' });
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
  };
}

function main() {
  const at = process.argv.indexOf('--profile');
  const p = profile(at >= 0 ? process.argv[at + 1] : 'testnet');
  if (p.name === 'spec') throw new Error('the spec build of the governance stack is deployed from contracts/core itself; vendor a testnet or rapid profile');
  const lines = [
    { qrvm: false, from: path.join(CORE, `build${p.suffix}`) },
    { qrvm: true, from: path.join(CORE, `build-qrvm${p.suffix}`) },
  ];
  const source = coreCommit();
  const manifestFile = path.join(VENDOR_DIR, 'MANIFEST.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { lines: {} };
  manifest.note = 'contracts/core governance artifacts, vendored for deployment only (scripts/vendor-governance.js). Never edited by hand.';
  let copied = 0;
  for (const line of lines) {
    const to = vendoredLine({ qrvm: line.qrvm, profileName: p.name });
    const name = path.basename(to);
    if (!fs.existsSync(path.join(line.from, 'ArkGovernor.json'))) {
      console.log(`skip  ${name}: no ${path.relative(ROOT, line.from)}/ArkGovernor.json in core (build it there first)`);
      continue;
    }
    fs.mkdirSync(to, { recursive: true });
    const files = {};
    for (const n of GOVERNANCE_CONTRACTS) {
      const text = fs.readFileSync(path.join(line.from, `${n}.json`), 'utf8');
      const art = JSON.parse(text);
      const built = art.profile || { name: 'spec', day: 86400 };
      if (Number(built.day) !== p.day) {
        throw new Error(`${path.relative(ROOT, line.from)}/${n}.json was built at profile ${built.name} (one day ${built.day} s); this tree's ${p.name} profile is ${p.day} s. Rebuild core with --profile ${p.name}`);
      }
      const init = size(art.bytecode);
      const runtime = size(art.deployedBytecode);
      if (runtime > EIP170_LIMIT || init > INITCODE_LIMIT) {
        throw new Error(`${n}: ${init} / ${runtime} bytes is past EIP-3860 ${INITCODE_LIMIT} / EIP-170 ${EIP170_LIMIT}`);
      }
      fs.writeFileSync(path.join(to, `${n}.json`), text);
      files[n] = { sha256: sha256(text), init, runtime, compiler: art.compiler && art.compiler.version };
      copied += 1;
    }
    manifest.lines[name] = {
      from: path.relative(ROOT, line.from).split(path.sep).join('/'),
      profile: { name: p.name, day: p.day },
      core: source,
      vendoredAt: new Date().toISOString(),
      files,
    };
    console.log(`copied ${name}: ${GOVERNANCE_CONTRACTS.length} artifacts from core ${source.commit ? source.commit.slice(0, 10) : '(no git)'}${source.dirty ? ' (dirty tree)' : ''}`);
    console.table(Object.fromEntries(Object.entries(files).map(([n, f]) => [n, { init: f.init, runtime: f.runtime }])));
  }
  if (!copied) throw new Error(`nothing vendored: core has neither build${p.suffix}/ nor build-qrvm${p.suffix}/ — see this script's header`);
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest -> ${path.relative(ROOT, manifestFile)}`);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
