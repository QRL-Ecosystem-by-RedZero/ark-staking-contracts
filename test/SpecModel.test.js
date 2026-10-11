/**
 * How the suite reads the specification's parameter set (audit B9).
 *
 * The one rule this file defends: **the parameter set the agreement tests
 * compare against is exactly what `protocol-config.ts` evaluates to — read
 * from the site's generated export, never parsed out of TypeScript text — and
 * an export that has drifted from the module fails loudly instead of being
 * used.** Until 2026-09-29 a regex read the literal, and an entry without a
 * trailing comma was silently absent.
 *
 * The adversarial cases run `test/spec-model.js` in a child process against a
 * scratch copy of the few site files it needs (`ARK_SITE_DIR`), so a stale or
 * hand-edited export can be produced without touching the real one. Every case
 * skips, naming the path, where the site is not beside this repository.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadModel, MISSING, SITE, EXPORT, hashValues } = require('./spec-model');

/** The site files `spec-model.js` reaches: the model, the config and what it imports at run time, the export. */
const FILES = [
  'src/lib/ark-staking.ts',
  'src/lib/ark-governance.ts',
  'src/lib/protocol-config.ts',
  'src/lib/site.ts',
  'src/generated/ark-staking-params.json',
];

const siteAbsent = () => FILES.some((f) => !fs.existsSync(path.join(SITE, f))) && MISSING;

/** A scratch site holding copies of FILES; `edit(dir)` alters it before the load. */
function scratchSite(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-site-'));
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(SITE, f), path.join(dir, f));
  }
  edit(dir);
  return dir;
}

/** `loadModel()` in a fresh process against `dir`: `{ ok, source, params, error }`. */
function loadIn(dir) {
  const script = `
    require(${JSON.stringify(path.join(__dirname, 'spec-model.js'))}).loadModel().then(
      (m) => process.stdout.write(JSON.stringify({ ok: true, source: m.source, params: m.params })),
      (e) => process.stdout.write(JSON.stringify({ ok: false, error: e.message })),
    );`;
  let res;
  try {
    res = spawnSync(process.execPath, ['--no-warnings', '-e', script], {
      env: { ...process.env, ARK_SITE_DIR: dir },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'src/generated/ark-staking-params.json'), 'utf8'));
const writeJson = (dir, doc) => fs.writeFileSync(path.join(dir, 'src/generated/ark-staking-params.json'), JSON.stringify(doc, null, 2) + '\n');

describe('the parameter set is the export, and the export is the module (B9)', () => {
  test('the suite reads the generated export, and it equals what protocol-config.ts evaluates to', async (t) => {
    const absent = siteAbsent();
    if (absent) return t.skip(absent);
    const M = await loadModel();
    assert.equal(M.source, 'export', `${EXPORT} is read`);
    const doc = JSON.parse(fs.readFileSync(EXPORT, 'utf8'));
    assert.equal(doc.schema, 'quantum-ark/ark-staking-params');
    // v2 since the papers' EC revision (2026-09-30), the only version read (PV-27).
    assert.equal(doc.schemaVersion, 2, `schema v${doc.schemaVersion}`);
    for (const k of ['premiumSlopeRatioBps', 'firstReserveDiscountBps', 'offeringBatchMultiple', 'claimCostGwei', 'bufferRampThresholdBps', 'seedingDepositBps']) {
      assert.ok(Number.isSafeInteger(M.params[k]), k);
    }
    assert.ok(!('premiumSlopeBps' in M.params), 'the absolute slope is gone');
    assert.equal(doc.hash, hashValues(doc.values));
    assert.deepEqual(M.params, doc.values.ARK_STAKING);
    // The values section 6.3 states beside each row are carried too.
    for (const k of ['timelockDefaultDays', 'timelockDays', 'admissionDepositArk', 'admissionAuditDays', 'admissionVoteDays', 'admissionTimelockHours', 'bondTermEpochs']) {
      assert.ok(k in M.config.ARK_STAKING_GOVERNANCE, k);
    }
  });

  test('an export that no longer equals the module is refused, naming the field and the fix', (t) => {
    const absent = siteAbsent();
    if (absent) return t.skip(absent);
    // Re-hashed, so only the comparison with the module can catch it.
    const dir = scratchSite((d) => {
      const doc = readJson(d);
      doc.values.ARK_STAKING.bufferBps += 1;
      doc.hash = hashValues(doc.values);
      writeJson(d, doc);
    });
    const r = loadIn(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /stale/);
    assert.match(r.error, /ARK_STAKING\.bufferBps/);
    assert.match(r.error, /npm run export:params/);
  });

  test('an export of schema v1 is refused, naming the version read (PV-27)', (t) => {
    const absent = siteAbsent();
    if (absent) return t.skip(absent);
    // A v1 export in the layout of before the EC revision, its hash current.
    const dir = scratchSite((d) => {
      const doc = readJson(d);
      doc.schemaVersion = 1;
      doc.values.ARK_STAKING.premiumSlopeBps = 1850;
      delete doc.values.ARK_STAKING.premiumSlopeRatioBps;
      doc.hash = hashValues(doc.values);
      writeJson(d, doc);
    });
    const r = loadIn(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /v1, this suite reads quantum-ark\/ark-staking-params v2/);
  });

  test('an export edited by hand, its hash left behind, is refused', (t) => {
    const absent = siteAbsent();
    if (absent) return t.skip(absent);
    const dir = scratchSite((d) => {
      const doc = readJson(d);
      doc.values.ARK_STAKING.indemnityBps = 9000;
      writeJson(d, doc);
    });
    const r = loadIn(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /hash does not match/);
  });

  test('a field the module adds is a stale export, not a silent absence', (t) => {
    const absent = siteAbsent();
    if (absent) return t.skip(absent);
    const dir = scratchSite((d) => {
      const doc = readJson(d);
      delete doc.values.ARK_STAKING.successorLimit;
      doc.hash = hashValues(doc.values);
      writeJson(d, doc);
    });
    const r = loadIn(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /ARK_STAKING\.successorLimit: export undefined, module 3/);
  });

  test('without an export the module is imported: an entry the old regex dropped is read', (t) => {
    const absent = siteAbsent();
    if (absent) return t.skip(absent);
    // The last entry without its trailing comma, and one value written as an
    // expression: the regex reader returned neither.
    const dir = scratchSite((d) => {
      fs.rmSync(path.join(d, 'src/generated/ark-staking-params.json'));
      const file = path.join(d, 'src/lib/protocol-config.ts');
      let src = fs.readFileSync(file, 'utf8');
      const before = src;
      src = src.replace(/(\n\s*validatorConcentrationBps: )1_000,(\r?\n\};)/, '$1 2 * 500$2');
      assert.notEqual(src, before, 'the scratch edit found the last entry of ARK_STAKING');
      fs.writeFileSync(file, src);
    });
    const r = loadIn(dir);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.source, 'module');
    assert.equal(r.params.validatorConcentrationBps, 1000);
  });
});
