/**
 * The governance stack's configuration, the funding a fresh genesis needs,
 * the manifest fields that ask for them, and the relayer's preflight before a
 * new origin leg (scripts/lib/governance.js, engine/redeploy.js; item 77).
 *
 * Pure logic: nothing here reaches a chain. That a record is held to its
 * genesis, its code and its wiring is test/GovernanceRedeploy.test.js, on the
 * harness.
 */
const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { governanceConfig, fundingPlan, QDAY_QUORUM, networkOf, recordCandidates, governanceRecordPath } = require('../../../scripts/lib/governance');
const { preflightReason } = require('../engine/redeploy');
const manifestLib = require('../lib/manifest');

const ONE = 10n ** 18n;
const acct = (b) => '0x' + b.repeat(20);
const ME = acct('11');
const SEAL = acct('22');
const OPER = acct('33');
const OWNER = acct('44');
const GUARD = acct('55');
const ATT = ['a1', 'a2', 'a3', 'a4', 'a5'].map(acct);
const shared = { name: 'hoodi-vps', client: 'evm', profile: 'testnet', qday: 'ArkQDayOracle' };
const local = { name: 'local', client: 'harness', profile: 'testnet' };
const roles = { sealer: SEAL, oracleOperator: OPER };
const env = {
  GOV_PROPOSER_OWNERS: OWNER,
  GOV_PROPOSER_THRESHOLD: '1',
  GOV_GUARDIAN_OWNERS: GUARD,
  GOV_GUARDIAN_THRESHOLD: '1',
  QDAY_ATTESTERS: ATT.join(','),
};

describe('the governance stack is configured from the environment on a shared network, and its keys are its own (item 38)', () => {
  test('distinct owners and five attesters pass; the cooldown is seven profile days', () => {
    const { c, errors } = governanceConfig({ env, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.deepEqual(errors, []);
    assert.deepEqual([c.proposerOwners, c.guardianOwners, c.attesters.length], [[OWNER], [GUARD], 5]);
    assert.equal(c.advisoryCooldown, 7 * 600);
    assert.equal(c.attesterBond, 10_000n * ONE);
    // Five buckets since core ArkAllocation-Design A1 (2026-10-09); unset ones are filled at deploy (defaultBuckets).
    assert.deepEqual(c.buckets, Array(5).fill(null));
  });

  test('the Q-Day quorum Q_min is GOV_QDAY_QUORUM_BPS, 500 by default, refused outside 100..5,000 (core OC-GOV-11)', () => {
    const base = governanceConfig({ env, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.equal(base.c.qdayQuorumBps, 500);
    assert.equal('qdayOppositionBps' in base.c, false, 'O_min is gone from the constructor');
    for (const ok of ['100', '5000']) {
      const r = governanceConfig({ env: { ...env, GOV_QDAY_QUORUM_BPS: ok }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
      assert.equal(r.c.qdayQuorumBps, Number(ok));
      assert.ok(!r.errors.some((e) => /GOV_QDAY_QUORUM_BPS/.test(e)), r.errors.join('; '));
    }
    for (const bad of ['0', '99', '5001', '10000']) {
      const r = governanceConfig({ env: { ...env, GOV_QDAY_QUORUM_BPS: bad }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
      assert.ok(r.errors.some((e) => /GOV_QDAY_QUORUM_BPS/.test(e)), `${bad}: ${r.errors.join('; ')}`);
    }
  });

  test('an owner or an attester on the deployer, the sealer or the price operator is refused', () => {
    for (const [name, value, who] of [
      ['GOV_PROPOSER_OWNERS', ME, /deployer/],
      ['GOV_GUARDIAN_OWNERS', SEAL, /sealer/],
      ['QDAY_ATTESTERS', [OPER, ...ATT.slice(1)].join(','), /operator/],
    ]) {
      const { errors } = governanceConfig({ env: { ...env, [name]: value }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
      assert.ok(errors.some((e) => who.test(e)), `${name}=${value}: ${errors.join('; ')}`);
    }
    const knowingly = governanceConfig({ env: { ...env, GOV_PROPOSER_OWNERS: ME, ALLOW_SHARED_KEYS: '1' }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.deepEqual(knowingly.errors, []);
  });

  test('core\'s oracle with fewer attesters than its quorum is refused: the declaration path would be dead', () => {
    const { errors } = governanceConfig({ env: { ...env, QDAY_ATTESTERS: ATT.slice(0, QDAY_QUORUM - 1).join(',') }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.ok(errors.some((e) => /needs 5 bonded attesters/.test(e)), errors.join('; '));
  });

  test('no owners, a threshold above n, or a duplicate owner are refused', () => {
    assert.ok(governanceConfig({ env: {}, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles }).errors.length >= 2);
    const high = governanceConfig({ env: { ...env, GOV_PROPOSER_THRESHOLD: '2' }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.ok(high.errors.some((e) => /k of n/.test(e)));
    const dup = governanceConfig({ env: { ...env, GOV_PROPOSER_OWNERS: `${OWNER},${OWNER}`, GOV_PROPOSER_THRESHOLD: '1' }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.ok(dup.errors.some((e) => /twice/.test(e)));
  });

  test('the unprefixed keys of the network win; a chain-prefixed key is read only where they are absent (2026-10-07)', () => {
    const both = governanceConfig({ env: { ...env, HOODI_VPS_GOV_PROPOSER_OWNERS: acct('66') }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.deepEqual(both.c.proposerOwners, [OWNER]);
    assert.ok(both.warnings.some((w) => /HOODI_VPS_GOV_PROPOSER_OWNERS differs from GOV_PROPOSER_OWNERS/.test(w)), both.warnings.join('; '));
    assert.ok(!both.warnings.some((w) => w.includes(OWNER) || w.includes(acct('66'))), 'a warning names keys, never values');
    const { GOV_PROPOSER_OWNERS, ...rest } = env;
    const fallback = governanceConfig({ env: { ...rest, HOODI_VPS_GOV_PROPOSER_OWNERS: acct('66') }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    assert.deepEqual([fallback.c.proposerOwners, fallback.warnings], [[acct('66')], []]);
  });

  test('ArkPhase counts epochs of the ArkEpoch length at the profile: 4,200 s at testnet', () => {
    assert.equal(governanceConfig({ env, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles }).c.epochLength, 4200);
    assert.equal(governanceConfig({ env, chain: 'local', manifest: { ...local, profile: 'spec' }, deployer: ME }).c.epochLength, 7 * 86400);
  });

  test('a local manifest reads nothing from the environment: the deployer owns both multisigs, one of one', () => {
    const { c, errors } = governanceConfig({ env, chain: 'local', manifest: local, deployer: ME });
    assert.deepEqual(errors, []);
    assert.deepEqual([c.proposerOwners, c.guardianOwners, c.attesters], [[ME], [ME], []]);
  });
});

describe('a fresh genesis funds the deployer alone; the relayer tops up every other role (item 77)', () => {
  test('the sealer, the operator and the owners get the gas float, each attester its bond on top; the deployer nothing', () => {
    const { c } = governanceConfig({ env, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    const plan = fundingPlan({ env: { QRL_ROLE_FUNDING: '50' }, me: ME, roles, config: c });
    const by = Object.fromEntries(plan.map((p) => [p.address, p.target]));
    assert.equal(by[SEAL], 50n * ONE);
    assert.equal(by[OPER], 50n * ONE);
    assert.equal(by[OWNER], 50n * ONE);
    assert.equal(by[ATT[0]], 10_050n * ONE);
    assert.equal(by[ME], undefined);
    assert.equal(plan.length, 3 + 1 + 5);
  });

  test('one account holding two roles is funded once, to the larger target', () => {
    const { c } = governanceConfig({ env: { ...env, GOV_GUARDIAN_OWNERS: ATT[0], ALLOW_SHARED_KEYS: '1' }, chain: 'hoodi-vps', manifest: shared, deployer: ME, roles });
    const plan = fundingPlan({ env: {}, me: ME, roles, config: c });
    const a0 = plan.filter((p) => p.address === ATT[0]);
    assert.equal(a0.length, 1);
    assert.equal(a0[0].target, 10_100n * ONE);
    assert.match(a0[0].label, /guardian.*attester|attester.*guardian/);
  });
});

describe('the manifest names the court, the Q-Day oracle and the governance record (item 77)', () => {
  const base = JSON.parse(fs.readFileSync(manifestLib.manifestPath('hoodi-vps'), 'utf8'));

  test('hoodi-vps: 64-byte owners, one signer of one, the real court, core\'s oracle, the relayer deploys governance', () => {
    const m = manifestLib.load('hoodi-vps');
    assert.equal(m.qrlOwnerLength, 64);
    assert.deepEqual(m.rootSigners, { threshold: 1, signers: 1 });
    assert.equal(m.court, 'real');
    assert.equal(m.qday, 'ArkQDayOracle');
    assert.deepEqual(m.governance, { network: 'private-qrvm', selfDeploy: true });
  });

  test('one record per QRL network: hoodi-vps reads the private-qrvm record, its own pre-2026-10-07 record only as a fallback', () => {
    const m = manifestLib.load('hoodi-vps');
    assert.equal(networkOf('hoodi-vps', m), 'private-qrvm');
    assert.deepEqual(recordCandidates('hoodi-vps', m), [governanceRecordPath('private-qrvm'), governanceRecordPath('hoodi-vps')]);
    assert.equal(networkOf('local', {}), 'local', 'a manifest naming no network is its own');
    assert.equal(networkOf('lane', { governance: { record: 'deployments/governance-lane-x.json' } }), 'lane-x', 'a record path names its network');
  });

  test('an unknown court or oracle, a record outside the repository, or a self-deploy on the double are refused', () => {
    for (const bad of [{ court: 'jury' }, { qday: 'Oracle' }, { governance: { record: '../core/x.json' } }, { governance: { record: 'x.txt' } }, { governance: { selfDeploy: 'yes' } }, { qday: 'MockQDayOracle', governance: { selfDeploy: true } }, { governance: { network: 'Private QRVM' } }, { governance: { network: 'private-qrvm', record: 'deployments/governance-hoodi-vps.json' } }]) {
      assert.throws(() => manifestLib.validate({ ...base, ...bad }), manifestLib.ManifestError, JSON.stringify(bad));
    }
  });
});

describe('before the loop, a new origin leg is found and the old relay\'s state kept aside (item 77)', () => {
  const m = { ...manifestLib.load('hoodi-vps'), addresses: { relay: '0x' + 'aa'.repeat(20), operationsDestination: null } };

  test('no deployment record, or one wired to another relay, is a reason to deploy; a matching one is not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-preflight-'));
    const dep = path.join(root, 'deployments', 'testnet-hoodi-vps.json');
    const quiet = () => {};
    assert.match(preflightReason({ chain: 'hoodi-vps', manifest: m, root, depFile: dep, log: quiet }), /^no /);
    fs.mkdirSync(path.dirname(dep), { recursive: true });
    fs.writeFileSync(dep, JSON.stringify({ relay: '0x' + 'bb'.repeat(20) }));
    assert.match(preflightReason({ chain: 'hoodi-vps', manifest: m, root, depFile: dep, log: quiet }), /wired to relay/);
    fs.writeFileSync(dep, JSON.stringify({ relay: '0x' + 'aa'.repeat(20) }));
    assert.equal(preflightReason({ chain: 'hoodi-vps', manifest: m, root, depFile: dep, log: quiet }), null);
  });

  test('a relayer state kept for another relay is moved aside, never deleted; one for this relay stays', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-preflight-'));
    const dep = path.join(root, 'deployments', 'testnet-hoodi-vps.json');
    fs.mkdirSync(path.dirname(dep), { recursive: true });
    fs.writeFileSync(dep, JSON.stringify({ relay: '0x' + 'aa'.repeat(20) }));
    const dir = path.join(root, '.relayer', 'hoodi-vps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ relay: '0x' + 'aa'.repeat(20), signed: { 0: {} } }));
    preflightReason({ chain: 'hoodi-vps', manifest: m, root, depFile: dep, log: () => {} });
    assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'the state of this relay stays');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ relay: '0x' + 'cc'.repeat(20), signed: { 0: {} } }));
    preflightReason({ chain: 'hoodi-vps', manifest: m, root, depFile: dep, log: () => {} });
    assert.ok(!fs.existsSync(dir));
    const aside = fs.readdirSync(path.join(root, '.relayer')).filter((n) => n.startsWith('hoodi-vps.relay-'));
    assert.equal(aside.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.relayer', aside[0], 'state.json'), 'utf8')).signed, { 0: {} });
  });
});
