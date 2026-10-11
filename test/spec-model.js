/**
 * The specification's own model, loaded rather than transcribed.
 *
 * `../../frontend/app/src/lib/ark-staking.ts` (the umbrella layout; relative to
 * this repository's root) is the checked transcription of the
 * Ark Staking whitepaper, and `ARK_STAKING` in `protocol-config.ts` is its
 * parameter set. Node 24 strips TypeScript types on import, so the suite calls
 * the model itself beside the contract rather than a hand copy of it that
 * could drift from both. A disagreement is therefore a disagreement with the
 * specification, and it is a bug in the contract.
 *
 * THE PARAMETER SET (audit B9, 2026-09-29)
 * ----------------------------------------
 * Read from the site's generated export, `src/generated/ark-staking-params.json`
 * (`npm run export:params` there; schema `quantum-ark/ark-staking-params` v2:
 * `{ schema, schemaVersion, generator, sources, hash, values: { ARK_STAKING,
 * ARK_STAKING_GOVERNANCE, governance } }`, `hash` = `sha256:` of
 * `JSON.stringify(values)`). Never parsed out of TypeScript text: until
 * 2026-09-29 a regex did that, and an entry without a trailing comma was
 * silently absent.
 *
 * The export is checked twice before it is used: its hash must match its
 * values (a hand-edited copy is refused), and where `protocol-config.ts` is
 * beside it, the module is imported and the export must equal what it
 * evaluates to — a stale export throws, naming each field that moved and the
 * command that regenerates it. Where the export is absent the module itself is
 * the source (`source: 'module'`). The import needs the `@/` alias the site's
 * modules use; a resolver scoped to the site's `src/` is registered for it
 * (`module.registerHooks`), and nothing of the site's own tooling is loaded.
 *
 * Returns null where the sibling repository is absent, and the tests that need
 * it skip with that reason stated, so the suite still runs in isolation and a
 * reader can see what it did not check.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { pathToFileURL, fileURLToPath } = require('node:url');

/**
 * Where the site lives. `ARK_SITE_DIR` overrides; otherwise the umbrella layout
 * (`<umbrella>/frontend/app`, this repository being `<umbrella>/contracts/staking`),
 * then the pre-umbrella sibling checkout (`../quantum-ark`) the suite was
 * written against. The first candidate holding the model wins; where none
 * does, SITE names the umbrella path so the skip reason points at the layout
 * of record.
 */
const CANDIDATES = [
  process.env.ARK_SITE_DIR,
  path.join(__dirname, '..', '..', '..', '..', 'frontend', 'app'),
  path.join(__dirname, '..', '..', 'quantum-ark'),
].filter(Boolean).map((p) => path.resolve(p));
const SITE =
  CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'src', 'lib', 'ark-staking.ts'))) ??
  CANDIDATES[0];
const SITE_SRC = path.join(SITE, 'src');
const MODEL = path.join(SITE_SRC, 'lib', 'ark-staking.ts');
/** The governance arithmetic: the court's escalation schedule (whitepaper §6.6). */
const GOVERNANCE = path.join(SITE_SRC, 'lib', 'ark-governance.ts');
const CONFIG = path.join(SITE_SRC, 'lib', 'protocol-config.ts');
/** The generated export of the parameter set. */
const EXPORT = path.join(SITE_SRC, 'generated', 'ark-staking-params.json');
const SCHEMA = 'quantum-ark/ark-staking-params';
/**
 * The export versions this loader reads: v2 alone since the contracts caught
 * up with it (2026-09-30, PV-27). v2 (the papers' EC revision) renamed
 * `premiumSlopeBps` to `premiumSlopeRatioBps` and added the first-offering
 * rung, batching, the claim cost, the ramp threshold and the seeding deposit;
 * a v1 export describes a parameter set these contracts no longer implement,
 * and is refused rather than read.
 */
const SCHEMA_VERSIONS = [2];
const SCHEMA_VERSION = SCHEMA_VERSIONS[SCHEMA_VERSIONS.length - 1];
const REGENERATE = 'run `npm run export:params` in frontend/app';

/** Keys a test may rely on; a set missing any of them is refused. */
const REQUIRED = [
  'sigmaTargetBps',
  'premiumSlopeRatioBps',
  'premiumCeilingBps',
  'surgeCeilingBps',
  'threatStage1Bps',
  'threatStage4Bps',
  'tailPremiumFloorBps',
  'indemnityBps',
  'pmlFloorBps',
  'bufferBps',
  'operationsBps',
  'maturityLadderBps',
  'releaseBoundBps',
  'maxEpochMoveBps',
  'fxHaircutMaxBps',
  'juniorThicknessBps',
  'seniorCouponBps',
  'reserveStepBps',
  'reserveFloorBps',
  'unsoldEpochs',
  'admittedTermsMask',
  'validatorConcentrationBps',
  // Schema v2 (2026-09-30).
  'firstReserveDiscountBps',
  'offeringBatchMultiple',
  'claimCostGwei',
  'bufferRampThresholdBps',
  'seedingDepositBps',
];

const MISSING = `site repository (the model) not found at ${SITE}; set ARK_SITE_DIR`;

const hashValues = (values) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex');

let aliasInstalled = false;

/**
 * Resolve the site's `@/x` to `<site>/src/x(.ts|.tsx|/index.ts)`, for imports
 * made from inside the site's `src/` only; every other specifier falls
 * through untouched. Synchronous, in-thread (Node >= 22.15 / 23.5).
 */
function installSiteAlias() {
  if (aliasInstalled) return;
  aliasInstalled = true;
  const { registerHooks } = require('node:module');
  if (typeof registerHooks !== 'function') {
    throw new Error(`module.registerHooks is not available in Node ${process.version}; the site's modules cannot be imported`);
  }
  const inside = (url) => {
    if (!url || !url.startsWith('file:')) return false;
    const rel = path.relative(SITE_SRC, fileURLToPath(url));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const EXT = ['', '.ts', '.tsx', path.sep + 'index.ts', path.sep + 'index.tsx'];
  registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.startsWith('@/') || !inside(context.parentURL)) return next(specifier, context);
      const base = path.join(SITE_SRC, specifier.slice(2));
      const found = EXT.map((e) => base + e).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!found) throw new Error(`spec-model: cannot resolve ${specifier} under ${SITE_SRC}`);
      return { url: pathToFileURL(found).href, shortCircuit: true };
    },
  });
}

/** The values of the export as the modules evaluate them now (the rule of the site's `scripts/lib/ark-params.mjs`). */
async function evaluateModules(gov) {
  installSiteAlias();
  const config = await import(pathToFileURL(CONFIG).href);
  const governance = gov ?? (fs.existsSync(GOVERNANCE) ? await import(pathToFileURL(GOVERNANCE).href) : {});
  return {
    ARK_STAKING: { ...config.ARK_STAKING },
    ARK_STAKING_GOVERNANCE: config.ARK_STAKING_GOVERNANCE ? structuredClone(config.ARK_STAKING_GOVERNANCE) : undefined,
    governance: Object.fromEntries(Object.entries(governance).filter(([, v]) => typeof v === 'number')),
  };
}

/** The export, verified against its own hash; null where the file is absent. */
function readExport() {
  if (!fs.existsSync(EXPORT)) return null;
  const doc = JSON.parse(fs.readFileSync(EXPORT, 'utf8'));
  if (doc.schema !== SCHEMA || !SCHEMA_VERSIONS.includes(doc.schemaVersion)) {
    throw new Error(`${EXPORT}: ${doc.schema} v${doc.schemaVersion}, this suite reads ${SCHEMA} v${SCHEMA_VERSIONS.join(', v')}`);
  }
  if (doc.hash !== hashValues(doc.values)) throw new Error(`${EXPORT}: its hash does not match its values (edited by hand?); ${REGENERATE}`);
  return doc.values;
}

/** Every field that differs between the export and the module, as lines. */
function drift(exported, evaluated) {
  const out = [];
  for (const section of new Set([...Object.keys(exported), ...Object.keys(evaluated)])) {
    const a = exported[section] ?? {};
    const b = evaluated[section] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!isDeepStrictEqual(a[key], b[key])) out.push(`${section}.${key}: export ${JSON.stringify(a[key])}, module ${JSON.stringify(b[key])}`);
    }
  }
  return out;
}

/**
 * The parameter set and the section 6.3 governance values: the export where it
 * exists and is current, the module where the export is absent. Throws on a
 * stale export, a hand-edited one, or a set missing a required key.
 */
async function loadConfig(gov) {
  const exported = readExport();
  const evaluated = fs.existsSync(CONFIG) ? await evaluateModules(gov) : null;
  if (exported && evaluated) {
    const moved = drift(exported, evaluated);
    if (moved.length) throw new Error(`${EXPORT} is stale against protocol-config.ts; ${REGENERATE}:\n  ${moved.join('\n  ')}`);
  }
  const values = exported ?? evaluated;
  if (!values) throw new Error(`neither ${EXPORT} nor ${CONFIG} exists`);
  for (const key of REQUIRED) {
    if (!Number.isSafeInteger(values.ARK_STAKING[key])) throw new Error(`ARK_STAKING has no integer ${key} (${exported ? EXPORT : CONFIG})`);
  }
  return { values, source: exported ? 'export' : 'module' };
}

let cached;

/**
 * `{ ark, gov, params, config, source }`, or null where the sibling repository
 * is absent; `gov` is null where only it is. `params` is `ARK_STAKING`;
 * `config` is the whole export (`ARK_STAKING_GOVERNANCE`, `governance`);
 * `source` says whether it came from the export or the module.
 */
async function loadModel() {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(MODEL) || (!fs.existsSync(CONFIG) && !fs.existsSync(EXPORT))) {
    cached = null;
    return cached;
  }
  const ark = await import(pathToFileURL(MODEL).href);
  const gov = fs.existsSync(GOVERNANCE) ? await import(pathToFileURL(GOVERNANCE).href) : null;
  const { values, source } = await loadConfig(gov);
  cached = { ark, gov, params: values.ARK_STAKING, config: values, source };
  return cached;
}

module.exports = { loadModel, MISSING, SITE, EXPORT, hashValues, drift };
