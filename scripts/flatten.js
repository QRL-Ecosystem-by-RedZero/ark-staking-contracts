/**
 * Exports every Hyperion source under contracts/ as a plain .txt file in txt/.
 *
 * The point is portability: .hyp opens nowhere, so review tools, mail clients
 * and auditors get the same bytes under an extension everything will display.
 * Nothing is compiled here and no import is resolved -- each source is copied
 * verbatim, with a header naming the path it came from so the tree can be
 * reconstructed from the text alone.
 *
 * With --repo the export covers all of Ark Staking rather than the QRL leg:
 * the Hyperion contracts, the origin-chain Solidity under ecdsa-stakings/, the
 * relayer, the stress and fuzz harnesses, every test, the deploy scripts, the
 * chain manifests and the docs. The file list comes from git (tracked plus
 * untracked-but-not-ignored), so anything .gitignore keeps out -- builds, ABIs,
 * relayer state, .env -- stays out here too. It writes to txt-ark-staking/ and
 * keeps each file's own extension in its name (Escrow.sol.txt), since the tree
 * mixes languages.
 *
 * Options:
 *   --repo     every source in the repo, into txt-ark-staking/
 *   --flat     one directory level, path separators folded into the file name
 *   --own      skip vendored OpenZeppelin (lib/) and test-only mocks/
 *   --bundle   also write _bundle.txt, every source concatenated in order
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');

const args = new Set(process.argv.slice(2));
const REPO = args.has('--repo');
const FLAT = args.has('--flat');
const OWN_ONLY = args.has('--own');
const BUNDLE = args.has('--bundle');

const OUT_NAME = REPO ? 'txt-ark-staking' : 'txt';
const OUT = path.join(ROOT, OUT_NAME);

/** Vendored or test-only trees, excluded by --own. Relative to contracts/. */
const EXCLUDED = ['lib/', 'mocks/'];

/** Extensions --repo treats as source. Anything else (images, PDFs) is skipped. */
const REPO_EXTENSIONS = new Set(['.hyp', '.sol', '.js', '.cjs', '.mjs', '.ts', '.json', '.sh', '.ps1', '.md', '.example']);

/** Tracked, but tooling rather than Ark Staking. */
const REPO_SKIP_FILES = new Set(['package-lock.json', '.gitattributes', '.gitignore']);

function collect(dir, base = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...collect(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.hyp')) found.push(rel);
  }
  return found;
}

/**
 * Repo-relative paths of every source git would commit. A real .env is refused
 * by name even if someone force-added it: this output is made to be handed out.
 */
function collectRepo() {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(listed.split('\0').filter(Boolean))]
    .filter((rel) => {
      const name = path.posix.basename(rel);
      if (REPO_SKIP_FILES.has(name)) return false;
      if (/^\.env(\.|$)/.test(name) && !name.endsWith('.example')) return false;
      if (rel.startsWith(`${OUT_NAME}/`)) return false;
      return REPO_EXTENSIONS.has(path.posix.extname(name)) && fs.existsSync(path.join(ROOT, rel));
    })
    .sort((a, b) => a.localeCompare(b));
}

/** Removes previously generated .txt files, then prunes the empty directories. */
function clean(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(p);
      if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
    } else if (entry.name.endsWith('.txt')) {
      fs.unlinkSync(p);
    }
  }
}

/**
 * Sources as repo-relative paths, each with the name it is written under.
 * The contract-only export keeps its historical layout: paths relative to
 * contracts/, with .hyp replaced by .txt.
 */
function plan() {
  if (REPO) {
    let sources = collectRepo();
    if (OWN_ONLY) sources = sources.filter((rel) => !EXCLUDED.some((skip) => rel.startsWith(`contracts/${skip}`)));
    return sources.map((rel) => ({ rel, name: `${rel}.txt` }));
  }

  if (!fs.existsSync(CONTRACTS)) {
    console.error('no contracts/ directory found');
    process.exit(1);
  }
  let sources = collect(CONTRACTS);
  if (OWN_ONLY) sources = sources.filter((rel) => !EXCLUDED.some((skip) => rel.startsWith(skip)));
  return sources.map((rel) => ({ rel: `contracts/${rel}`, name: rel.replace(/\.hyp$/, '.txt') }));
}

function main() {
  const sources = plan();
  if (sources.length === 0) {
    console.error(REPO ? 'no sources matched' : 'no .hyp sources matched');
    process.exit(1);
  }

  clean(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  const bundle = [];
  let bytes = 0;

  for (const { rel, name } of sources) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const header = `// source: ${rel}\n\n`;
    const target = path.join(OUT, FLAT ? name.replace(/\//g, '__') : name);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, header + content);
    bytes += content.length;

    if (BUNDLE) {
      bundle.push(`${'='.repeat(78)}\n// ${rel}\n${'='.repeat(78)}\n\n${content}`);
    }
    console.log(path.relative(ROOT, target).split(path.sep).join('/'));
  }

  fs.writeFileSync(
    path.join(OUT, 'INDEX.txt'),
    [
      REPO ? 'Ark Staking - every source in the repo exported as text' : 'Quantum Ark - Hyperion sources exported as text',
      `generated ${new Date().toISOString()}`,
      `${sources.length} file(s), ${bytes} bytes of source`,
      '',
      ...sources.map(({ rel }) => rel),
      '',
    ].join('\n'),
  );

  if (BUNDLE) fs.writeFileSync(path.join(OUT, '_bundle.txt'), bundle.join('\n\n'));

  console.log(`\n${sources.length} source(s) -> ${OUT_NAME}/${BUNDLE ? ' (+ _bundle.txt)' : ''}`);
}

main();
