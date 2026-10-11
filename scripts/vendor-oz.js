/**
 * Vendors the OpenZeppelin sources this project depends on into
 * contracts/lib/openzeppelin as Hyperion (.hyp) files.
 *
 * Hyperion is a Solidity fork: the language accepts OZ 4.x code as-is, but hypc
 * rejects `pragma solidity` and only resolves `.hyp` imports. Rather than
 * hand-porting ERC721/AccessControl and losing audited code, this copies the
 * exact upstream sources and rewrites three things:
 *   1. `pragma solidity ...;`  ->  `pragma hyperion >=0.0.1;`
 *   2. `import "....sol"`      ->  `import "....hyp"`
 *   3. `@solidity memory-safe-assembly` -> `@hyperion memory-safe-assembly`
 *
 * Imports are followed transitively from the entry points below, so the
 * vendored tree is exactly the closure that gets compiled.
 *
 * The output directory is generated. Never hand-edit it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OZ_ROOT = path.join(ROOT, 'node_modules', '@openzeppelin', 'contracts');
const OUT = path.join(ROOT, 'contracts', 'lib', 'openzeppelin');

const ENTRY = [
  'security/ReentrancyGuard.sol',
  'token/ERC20/ERC20.sol',
  // Membership against a published root: the forward path of whitepaper 9.2
  // and the two withdrawal roots of 11.4 both check one.
  'utils/cryptography/MerkleProof.sol',
];

function rewrite(src) {
  return src
    .replace(/pragma\s+solidity[^;]*;/g, 'pragma hyperion >=0.0.1;')
    .replace(/(import\s+[^;]*?)\.sol(["'])/g, '$1.hyp$2')
    .replace(/@solidity\s+memory-safe-assembly/g, '@hyperion memory-safe-assembly')
    // QRVM (QIP-55, 512-bit words): OZ's scratch-space pair hash hashes zero,
    // so every Merkle proof fails on a v3 chain; abi.encodePacked does not
    // depend on the word size and matches the relayer's tree (audit
    // 2026-10-03, OC-V3-01, measured on the v3 devnet).
    .replace(
      /(function _efficientHash\(bytes32 a, bytes32 b\) private pure returns \(bytes32 value\) \{)[\s\S]*?\n    \}\n/,
      '$1\n        return keccak256(abi.encodePacked(a, b));\n    }\n',
    );
}

function importsOf(src) {
  const out = [];
  const re = /import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function main() {
  const pinned = '4.9.6';
  if (!fs.existsSync(OZ_ROOT)) {
    console.error(`missing @openzeppelin/contracts — run: npm i @openzeppelin/contracts@${pinned}`);
    process.exit(1);
  }
  const installed = JSON.parse(fs.readFileSync(path.join(OZ_ROOT, 'package.json'), 'utf8')).version;
  if (installed !== pinned) {
    console.error(`@openzeppelin/contracts is ${installed}, this project is validated against ${pinned}`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });

  const seen = new Set();
  const queue = [...ENTRY];

  while (queue.length) {
    const rel = path.normalize(queue.shift()).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.join(OZ_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error('unresolved OZ import:', rel);
      process.exit(1);
    }
    const src = fs.readFileSync(abs, 'utf8');

    for (const imp of importsOf(src)) {
      if (imp.startsWith('.')) queue.push(path.posix.join(path.posix.dirname(rel), imp));
      else queue.push(imp.replace(/^@openzeppelin\/contracts\//, ''));
    }

    const dest = path.join(OUT, rel.replace(/\.sol$/, '.hyp'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewrite(src));
  }

  console.log(`vendored ${seen.size} OpenZeppelin ${pinned} sources -> contracts/lib/openzeppelin/`);
  [...seen].sort().forEach((f) => console.log('  ', f.replace(/\.sol$/, '.hyp')));
}

main();
