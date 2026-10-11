/**
 * A redeploy never loses the seed of the relay it retires (audit 2026-09-29,
 * OL-04 / R3-04).
 *
 * The one rule this file exists to defend: **a secret in .env is archived
 * before anything overwrites it, and a relay whose escrows still hold
 * positions is not retired unless the operator says so.** A redeploy of
 * 2026-09-26 wrote a new relay's one-time seeds over the old ones and left
 * 0.31 stETH of positions behind a relay nobody could sign for.
 *
 * Every file here is a temporary one; the repository's .env is never touched.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { replaceSecrets, archiveEnv } = require('../scripts/lib/env');
const { checkRetiringRelay } = require('../scripts/lib/deploy');

const ROOT = path.join(__dirname, '..');
const OLD_RELAY = '0x5CEfd73C00000000000000000000000000000001';
const SEED_OLD = '0x' + 'a1'.repeat(32);
const SEED_NEW = '0x' + 'b2'.repeat(32);

function tmpEnv(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-env-'));
  const file = path.join(dir, '.env');
  if (text !== null) fs.writeFileSync(file, text);
  return { dir, file };
}

describe('the seeds of a retiring relay are archived before they are replaced (OL-04)', () => {
  test('replaceSecrets copies the old lines to .env.archive-<relay>-<time>, then writes the new ones; it returns no value', () => {
    const { dir, file } = tmpEnv(`DEPLOYER_MNEMONIC="words"\nHOODI_OTS_SEED="${SEED_OLD}"\nHOODI_OTS_SEED_0="${SEED_OLD}"\nHOODI_OTS_HEIGHT="11"\n`);
    const now = Date.UTC(2026, 8, 30, 10, 15, 0);
    const out = replaceSecrets({ HOODI_OTS_SEED_0: SEED_NEW, HOODI_OTS_SEED: SEED_NEW, HOODI_OTS_HEIGHT: '11' }, OLD_RELAY, { file, now });
    assert.equal(path.basename(out.archive), `.env.archive-${OLD_RELAY}-20260930T101500Z`);
    assert.deepEqual(out.keys, ['HOODI_OTS_SEED_0', 'HOODI_OTS_SEED', 'HOODI_OTS_HEIGHT']);
    assert.ok(!JSON.stringify(out).includes(SEED_NEW) && !JSON.stringify(out).includes(SEED_OLD), 'no value in what it returns');
    const archived = fs.readFileSync(out.archive, 'utf8');
    assert.ok(archived.includes(`HOODI_OTS_SEED="${SEED_OLD}"`) && archived.includes(`HOODI_OTS_SEED_0="${SEED_OLD}"`), 'the old seeds are kept');
    assert.ok(!archived.includes(SEED_NEW), 'and only the old');
    assert.ok(!archived.includes('DEPLOYER_MNEMONIC'), 'nothing it does not replace');
    const env = fs.readFileSync(file, 'utf8');
    assert.ok(env.includes(`HOODI_OTS_SEED="${SEED_NEW}"`) && !env.includes(SEED_OLD), 'the new seeds are in .env');
    assert.ok(env.includes('DEPLOYER_MNEMONIC="words"'), 'the rest of .env is untouched');
    if (process.platform !== 'win32') assert.equal(fs.statSync(out.archive).mode & 0o777, 0o600, 'readable by its owner alone');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind');
  });

  test('nothing to archive where no key is set; an archive is never overwritten', () => {
    const { file } = tmpEnv('OTHER="1"\n');
    const out = replaceSecrets({ HOODI_OTS_SEED: SEED_NEW }, OLD_RELAY, { file });
    assert.equal(out.archive, null);
    assert.ok(fs.readFileSync(file, 'utf8').includes(`HOODI_OTS_SEED="${SEED_NEW}"`));
    const now = Date.now();
    archiveEnv(['HOODI_OTS_SEED'], OLD_RELAY, { file, now });
    assert.throws(() => archiveEnv(['HOODI_OTS_SEED'], OLD_RELAY, { file, now }), /not overwritten/);
    const fresh = tmpEnv(null);
    assert.equal(replaceSecrets({ A: '1' }, OLD_RELAY, { file: fresh.file }).archive, null, 'no .env yet: written, nothing archived');
  });

  test('the archive name is gitignored in this repository', (t) => {
    let out;
    try {
      out = execFileSync('git', ['check-ignore', `.env.archive-${OLD_RELAY}-20260930T101500Z`], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      if (e.code === 'ENOENT') return t.skip('git is not on PATH');
      throw new Error('.env.archive-* is not ignored: ' + e.message);
    }
    assert.match(out, /\.env\.archive-/);
  });

  test('deployOrigin writes no seed to its log: only key names and paths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'deploy.js'), 'utf8');
    for (const line of src.split('\n').filter((l) => /\blog\(|console\.(log|error)\(/.test(l))) {
      assert.ok(!/\$\{\s*seeds?\b|\$\{\s*s\s*\}|seeds\[/.test(line), `a log line interpolates a seed: ${line.trim()}`);
    }
  });
});

describe('a relay whose escrows hold positions is not retired without --allow-strand (OL-04)', () => {
  const build = path.join(ROOT, 'ecdsa-stakings', 'ethereum', 'build');
  const manifest = {
    addresses: { relay: OLD_RELAY },
    assets: [
      { symbol: 'stETH', source: 'lido', escrow: '0x76BBFcE000000000000000000000000000000001' },
      { symbol: 'mUNIT', escrow: '0xF7930e9900000000000000000000000000000002' },
      { symbol: 'gone', escrow: '0xA00ECC4d00000000000000000000000000000003' },
    ],
  };
  /**
   * A client whose escrows hold what `held` says in `positionShares` and
   * nothing in the other values the strand check reads since the re-audit of
   * 2026-09-30 (ORIGIN-08); an address with no entry has no code.
   */
  const clientOf = (held) => ({
    code: async (a) => (a.toLowerCase() in held ? '0x6080' : '0x'),
    call: async (a, abi, method) => {
      const v = held[a.toLowerCase()];
      if (v === 'revert') throw new Error('execution reverted');
      return [method === 'positionShares' ? v : 0n];
    },
  });
  const lower = (a) => a.toLowerCase();

  test('an escrow with positions refuses the redeploy, naming it; --allow-strand proceeds and says so', async (t) => {
    if (!fs.existsSync(path.join(build, 'ArkStakeEscrowLido.json'))) return t.skip('no origin-chain build: run npm run compile:evm');
    const held = { [lower(manifest.assets[0].escrow)]: 290_700_000_000_000_000n, [lower(manifest.assets[1].escrow)]: 0n };
    await assert.rejects(checkRetiringRelay({ client: clientOf(held), manifest, build, log: () => {} }), (e) => /still has escrows holding positions/.test(e.message) && /stETH/.test(e.message) && /--allow-strand/.test(e.message) && !/mUNIT/.test(e.message));
    const lines = [];
    const r = await checkRetiringRelay({ client: clientOf(held), manifest, build, allowStrand: true, log: (l) => lines.push(l) });
    assert.equal(r.relay.toLowerCase(), OLD_RELAY.toLowerCase());
    assert.deepEqual(r.stranded.map((s) => s.symbol), ['stETH']);
    assert.ok(lines.some((l) => /WARNING/.test(l) && /stETH/.test(l)));
  });

  test('empty escrows, escrows with no code, and a manifest with no relay pass; an unreadable escrow is refused', async (t) => {
    if (!fs.existsSync(path.join(build, 'ArkStakeEscrowLido.json'))) return t.skip('no origin-chain build: run npm run compile:evm');
    const empty = { [lower(manifest.assets[0].escrow)]: 0n, [lower(manifest.assets[1].escrow)]: 0n };
    assert.deepEqual((await checkRetiringRelay({ client: clientOf(empty), manifest, build, log: () => {} })).stranded, []);
    assert.equal((await checkRetiringRelay({ client: clientOf({}), manifest: { assets: manifest.assets, addresses: {} }, build })).relay, null);
    const unreadable = { [lower(manifest.assets[1].escrow)]: 'revert' };
    await assert.rejects(checkRetiringRelay({ client: clientOf(unreadable), manifest, build, log: () => {} }), /unreadable/);
  });
});
