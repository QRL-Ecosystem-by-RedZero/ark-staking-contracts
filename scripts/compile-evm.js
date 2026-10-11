/**
 * Compiles ecdsa-stakings/shared/contracts/ with solc and writes per-chain
 * artifacts.
 *
 * The origin-chain leg is EVM bytecode, not ZVM, so it needs a second compiler.
 * This is the mirror of scripts/compile.js and differs in four deliberate places:
 *
 *  - `language` is "Solidity"; output lives under `evm`, not `zvm`.
 *  - OpenZeppelin is *imported* rather than vendored. The `.sol` files are
 *    already `.sol`, so the rewrite scripts/vendor-oz.js performs has no work to
 *    do here. The 4.9.6 pin is re-asserted below anyway, because a silent minor
 *    bump would change the escrow's bytecode, and the escrow's whole security
 *    argument is about bytecode somebody inspected.
 *  - Artifacts go to ecdsa-stakings/<chain>/build/, never to build/. Two
 *    reasons, and the second is the one that bites: test/harness.js reads every
 *    file in a build directory to assemble its revert decoder, and artifacts are
 *    keyed by contract name alone — so OpenZeppelin's Hyperion `MerkleProof` and
 *    its Solidity twin would overwrite one another with no error at all.
 *  - It is *per chain* because the artifact is a function of `evmVersion`, which
 *    is a per-chain manifest field. An L2 pinned to `paris` produces different
 *    bytecode from mainnet's `shanghai` for identical source.
 *
 * The 18,000-byte creation limit of scripts/compile.js does NOT apply here. That
 * ceiling is the QRL RPC proxy's 50KB body cap minus the ~7.2KB ML-DSA-87
 * envelope, and neither exists on an EVM chain. EIP-3860's initcode limit
 * replaces it.
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const manifest = require('../ecdsa-stakings/relayer/lib/manifest');
const { fromArgv, rewriteSources } = require('./lib/profile');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'ecdsa-stakings', 'shared', 'contracts');
const STAKINGS = path.join(ROOT, 'ecdsa-stakings');
const OZ_ROOT = path.join(ROOT, 'node_modules', '@openzeppelin', 'contracts');
const OZ_PREFIX = '@openzeppelin/contracts/';

const OZ_PIN = '4.9.6';
const SOLC_PIN = '0.8.24';

/** Our own contracts, as opposed to imported OpenZeppelin. */
const OWN = ['ArkEpochRootRelay', 'ArkStakeEscrowUnits', 'ArkStakeEscrowShares', 'ArkStakeEscrowLido', 'ArkStakeIdsHarness'];

const PROFILE = fromArgv();

/**
 * The one contract compiled through the IR pipeline (phase C3, 2026-09-28).
 * The loss claims and the units-fixed loss entries of D13/D17 took the Lido
 * form 732 bytes past EIP-170 under the legacy code generator, and the escrow
 * cannot be split (no delegatecall, CLAUDE.md §7.2). viaIR brings that one
 * form under the limit and GROWS the other two (Shares by some 800 bytes), so
 * it is chosen per contract rather than for the build: every other artifact —
 * the Units and Shares forms, the relay, the identifier harness — is the
 * legacy pipeline's, byte for byte what it was. The artifact records which
 * pipeline produced it (`settings.viaIR`).
 */
const VIA_IR = new Set(['ArkStakeEscrowLido']);

const EIP170_LIMIT = 24576; // runtime
const EIP3860_LIMIT = 49152; // initcode

function assertPins() {
  const installed = JSON.parse(
    fs.readFileSync(path.join(OZ_ROOT, 'package.json'), 'utf8'),
  ).version;
  if (installed !== OZ_PIN) {
    console.error(
      `@openzeppelin/contracts is ${installed}, expected ${OZ_PIN}.\n` +
        'Both legs compile against this one tree, so a bump here changes the ' +
        'escrow bytecode and the vendored Hyperion sources at the same time.',
    );
    process.exit(1);
  }
  if (!solc.version().startsWith(SOLC_PIN)) {
    console.error(
      `solc is ${solc.version()}, expected ${SOLC_PIN}.\n` +
        'The escrow is deployed from bytecode and abandoned, so the compiler ' +
        'version is part of the source rather than of a config file.',
    );
    process.exit(1);
  }
}

function collectSources(dir, base = '') {
  const sources = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(sources, collectSources(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.sol')) {
      sources[rel] = { content: fs.readFileSync(path.join(dir, entry.name), 'utf8') };
    }
  }
  return sources;
}

/**
 * solc hands relative imports back already resolved against the importing
 * source unit, so `./IERC20.sol` inside an OpenZeppelin file arrives here as the
 * full `@openzeppelin/contracts/...` path.
 */
function resolveImport(p) {
  if (p.startsWith(OZ_PREFIX)) {
    const abs = path.join(OZ_ROOT, p.slice(OZ_PREFIX.length));
    if (!fs.existsSync(abs)) return { error: `unresolved OpenZeppelin import: ${p}` };
    return { contents: fs.readFileSync(abs, 'utf8') };
  }
  const local = path.join(SHARED, p);
  if (fs.existsSync(local)) return { contents: fs.readFileSync(local, 'utf8') };
  return { error: `unresolved import: ${p}` };
}

function compileFor(m, sources, viaIR = false) {
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      ...(viaIR ? { viaIR: true } : {}),
      evmVersion: m.evmVersion,
      // whitepaper §2.1 says the escrow's constraints are verifiable by
      // inspecting deployed bytecode. That needs a reproducible compile, and the
      // metadata hash otherwise varies with the path the compiler ran from.
      metadata: { bytecodeHash: 'none' },
      outputSelection: {
        '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
      },
    },
  };
  return JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
}

function writeArtifacts(m, output, ir = null) {
  const outDir = path.join(STAKINGS, m.name, `build${PROFILE.suffix}`);
  const abiDir = path.join(STAKINGS, m.name, 'abi');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(abiDir, { recursive: true });

  const sizes = {};
  for (const [file, legacyContracts] of Object.entries(output.contracts || {})) {
    for (const [name, legacy] of Object.entries(legacyContracts)) {
      const viaIR = Boolean(ir && VIA_IR.has(name));
      const c = viaIR ? ir.contracts[file][name] : legacy;
      const bytecode = c.evm && c.evm.bytecode && c.evm.bytecode.object;
      if (!bytecode) continue; // interface or abstract contract
      fs.writeFileSync(
        path.join(outDir, `${name}.json`),
        JSON.stringify(
          {
            contractName: name,
            sourceName: file,
            compiler: { name: 'solc', version: solc.version() },
            settings: {
              evmVersion: m.evmVersion,
              optimizer: { enabled: true, runs: 200 },
              ...(viaIR ? { viaIR: true } : {}),
              metadata: { bytecodeHash: 'none' },
            },
            profile: PROFILE.name,
            chain: m.name,
            chainId: m.chainId,
            abi: c.abi,
            bytecode: '0x' + bytecode,
            deployedBytecode: '0x' + c.evm.deployedBytecode.object,
          },
          null,
          2,
        ),
      );
      if (!PROFILE.suffix) fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(c.abi, null, 2));
      sizes[name] = {
        init: bytecode.length / 2,
        runtime: c.evm.deployedBytecode.object.length / 2,
      };
    }
  }
  return sizes;
}

function report(m, sizes) {
  console.log('\n%s %s %s %s', m.name.padEnd(14), 'contract'.padEnd(24), 'init'.padStart(8), 'runtime'.padStart(8));
  let over = false;
  for (const n of OWN) {
    if (!sizes[n]) {
      console.log('%s %s', ''.padEnd(14), `${n.padEnd(24)}    MISSING`);
      over = true;
      continue;
    }
    const flags = [];
    if (sizes[n].runtime > EIP170_LIMIT) flags.push(`EXCEEDS EIP-170 ${EIP170_LIMIT}`);
    if (sizes[n].init > EIP3860_LIMIT) flags.push(`EXCEEDS EIP-3860 ${EIP3860_LIMIT}`);
    if (flags.length) over = true;
    console.log(
      '%s %s %s %s%s',
      ''.padEnd(14),
      n.padEnd(24),
      String(sizes[n].init).padStart(8),
      String(sizes[n].runtime).padStart(8),
      flags.length ? '  << ' + flags.join(', ') : '',
    );
  }
  if (!OWN.length) console.log('%s (no contracts named in OWN yet)', ''.padEnd(14));
  return over;
}

function main() {
  assertPins();

  const only = process.argv.includes('--chain')
    ? process.argv[process.argv.indexOf('--chain') + 1]
    : null;
  // A chain is built at the profile its manifest names and at no other: a
  // mainnet manifest must never yield a time-compressed artifact, and a testnet
  // chain built at week-long epochs would test nothing it was listed for.
  const names = (only ? [only] : manifest.chains()).filter((n) => {
    const want = manifest.load(n).profile;
    if (want === PROFILE.name) return true;
    if (only) {
      console.error(`chain ${n} is a ${want}-profile manifest; compile it with --profile ${want}`);
      process.exit(1);
    }
    return false;
  });
  if (!names.length) {
    console.error('no chains found under ecdsa-stakings/ — a chain is a directory with a chain.json');
    process.exit(1);
  }

  const { sources, rewrites } = rewriteSources(collectSources(SHARED), PROFILE);
  if (!Object.keys(sources).length) {
    console.error(`no .sol sources under ${SHARED}`);
    process.exit(1);
  }

  console.log(`solc ${solc.version()}`);
  console.log(`compiling ${Object.keys(sources).length} Solidity sources, profile ${PROFILE.name}, for: ${names.join(', ')}\n`);
  for (const r of rewrites) console.log(`  ${PROFILE.name}: ${r.file}  ${r.from} -> ${r.to}`);

  let fatal = false;
  let over = false;
  let warnings = 0;

  for (const name of names) {
    const m = manifest.load(name);
    const output = compileFor(m, sources);
    const ir = VIA_IR.size ? compileFor(m, sources, true) : null;

    for (const err of [...(output.errors || []), ...((ir && ir.errors) || []).filter((e) => e.severity === 'error')]) {
      if (err.severity === 'error') {
        fatal = true;
        console.error(err.formattedMessage);
      } else if (!/SPDX/.test(err.formattedMessage)) {
        warnings++;
        console.warn('warn:', err.formattedMessage.split('\n')[0]);
      }
    }
    if (fatal) process.exit(1);

    over = report(m, writeArtifacts(m, output, ir)) || over;
  }

  if (over) process.exit(1);
  console.log(`\n${warnings} warning(s). artifacts -> ecdsa-stakings/<chain>/build${PROFILE.suffix}/, ABIs -> .../abi/`);
}

main();
