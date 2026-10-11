/**
 * The handover of Ark Staking to contracts/core's timelock, and the operator
 * tooling's wiring (OC round 2026-10-03, docs/review/audit-2026-10-03/GOV at
 * the umbrella root):
 *
 *   OC-GOV-03  `handOverToTimelock` (scripts/lib/deploy.js): a contract the
 *              deployer governs for its bring-up calls ends the same run
 *              governed by the timelock, nothing pending, and the deployer
 *              governs nothing; `deployQrlLeg` builds the parameter set and the
 *              delegation under the timelock and hands the registry over so
 *   OC-GOV-04  at a proposer threshold of two, every wiring transaction is kept,
 *              approved and executed by the tooling, the governor's operations
 *              are kept by op id, and a second run submits nothing again
 *   OC-GOV-05  the wiring schedules ArkGovernor.setCourt
 *   GV-19      a record whose oracle court does not answer as recorded is stale
 *
 * The whole path on a deployed leg is the e2e scenario governance-live
 * (ARK_E2E_CHAIN=local-gov npm run e2e:local -- --scenario governance-live).
 *
 * Needs `vendor/core-governance/build-testnet/` (npm run vendor:governance) and
 * this tree's `build/`; skips, naming what is missing.
 */
const test = require('node:test');
const { describe, before } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { harnessClient, iface, ROOT } = require('../scripts/lib/chains');
const { deployLarge } = require('../scripts/lib/chunked');
const gov = require('../scripts/lib/governance');
const { handOverToTimelock } = require('../scripts/lib/deploy');

const MANIFEST = { name: 'local', chainId: 31337, profile: 'testnet', client: 'harness', confirmations: 1 };
const BUILD = path.join(ROOT, 'build');
const vendored = (() => {
  try {
    return gov.governanceBuild({ client: { kind: 'harness' }, profileName: 'testnet' });
  } catch (e) {
    return { missing: e.message };
  }
})();
const skip = typeof vendored === 'object'
  ? `vendored governance artifacts absent: ${vendored.missing}`
  : !fs.existsSync(path.join(BUILD, 'ArkStakeParams.json')) ? 'no build/ArkStakeParams.json (npm run build)' : false;
const quiet = () => {};
const lower = (a) => String(a).toLowerCase();
const isZero = (a) => BigInt(a) === 0n;
const OTHER = '0x' + '5a'.repeat(20);

/** An ArkStakeParams the deployer governs, as the registry is for its admissions. */
async function governedByDeployer(client) {
  const chunked = await client.deploy('ChunkedDeployer', [], BUILD);
  const launchSet = iface('ArkStakeParams', BUILD).deploy.inputs[2].components.map(() => 0);
  // The ecosystem phase (item 129): a double, and the reference rows (a zero row 0).
  const phase = await client.deploy('MockArkPhase', [], BUILD);
  const rows = [0, 1, 2, 3, 4].map(() => [0, 0, 0]);
  return deployLarge(client, 'ArkStakeParams', [client.address, client.address, launchSet, phase, rows], BUILD, { chunked });
}

describe('the leg ends its deploying run under the timelock (OC-GOV-03)', { skip }, () => {
  let client;
  let record;

  before(async () => {
    client = await harnessClient(MANIFEST);
    const { c } = gov.governanceConfig({ chain: 'local', manifest: MANIFEST, deployer: client.address });
    ({ record } = await gov.deployGovernance({ client, chain: 'local', manifest: MANIFEST, config: c, build: vendored, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-hand-')), 'g.json'), log: quiet }));
  });

  test('propose and accept at once: governance() is the timelock, nothing is pending, the deployer governs nothing', async () => {
    const timelock = record.addresses.ArkTimelock;
    const target = await governedByDeployer(client);
    const P = iface('ArkStakeParams', BUILD);
    assert.equal(await handOverToTimelock({ client, timelock, target, log: quiet }), true);
    assert.equal(lower((await client.call(target, P, 'governance'))[0]), lower(timelock));
    assert.ok(isZero((await client.call(target, P, 'pendingGovernance'))[0]));
    await assert.rejects(client.send(target, P, 'setThreatStage', [1, 2]), /OnlyGovernance|revert/);
    await assert.rejects(client.send(target, P, 'proposeGovernance', [client.address]), /OnlyGovernance|revert/);
    // Nobody can have the timelock accept what was not proposed to it.
    const other = await governedByDeployer(client);
    await assert.rejects(client.send(timelock, iface('ArkTimelock', vendored), 'acceptGovernanceOf', [other]), /NotPendingGovernance|revert/);
  });
});

describe('the operator tooling keeps and completes the wiring at k of n (OC-GOV-04, OC-GOV-05)', { skip }, () => {
  let client;
  let record;
  let leg;

  before(async () => {
    client = await harnessClient(MANIFEST);
    const { c, errors } = gov.governanceConfig({ chain: 'local', manifest: MANIFEST, deployer: client.address, overrides: { proposerOwners: [client.address, OTHER], proposerThreshold: 2 } });
    assert.deepEqual(errors, []);
    ({ record } = await gov.deployGovernance({ client, chain: 'local', manifest: MANIFEST, config: c, build: vendored, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-wire-')), 'g.json'), log: quiet }));
    const params = await governedByDeployer(client);
    await handOverToTimelock({ client, timelock: record.addresses.ArkTimelock, target: params, log: quiet });
    // The three governed contracts stand in as one, already under the timelock;
    // the bond and the court are any non-zero accounts, read and named only.
    leg = { ArkStakeParams: params, ArkStakeRegistry: params, ArkBondDelegation: params, ArkCatBond: '0x' + 'b0'.repeat(20), ArkStakeCourt: '0x' + 'c0'.repeat(20) };
  });

  test('submitted by one owner, nothing executes; a second owner approves and executes every entry', async () => {
    const g = record.addresses;
    const ops = await gov.scheduleAcceptances({ client, build: vendored, governance: g, leg, log: quiet });
    assert.deepEqual(ops.map((o) => [o.name, o.kind]), [
      ['ArkTimelock.setObjectionSource', 'call'],
      ['ArkTimelock.setGovernor', 'call'],
      ['ArkGovernor.setObjectionSource', 'schedule'],
      ['ArkGovernor.setCourt', 'schedule'],
    ], 'the wiring only: nothing is left to accept');
    assert.ok(ops.every((o) => o.executed === false && o.multisigTx !== null));
    let s = await gov.wiringStatus({ client, build: vendored, governance: g, leg });
    assert.ok(isZero(s.timelockObjectionSource), 'below the threshold nothing ran');

    await gov.approveAcceptances({ client, build: vendored, governance: g, ops, from: OTHER, log: quiet });
    assert.ok(ops.every((o) => o.executed));
    assert.ok(ops.filter((o) => o.kind === 'schedule').every((o) => o.opId && o.eta > 0n), 'the governor operations are kept by op id');
    s = await gov.wiringStatus({ client, build: vendored, governance: g, leg });
    assert.equal(lower(s.timelockObjectionSource), lower(leg.ArkCatBond));
    assert.equal(lower(s.timelockGovernor), lower(g.ArkGovernor));
    assert.ok(isZero(s.governorObjectionSource) && isZero(s.governorCourt), 'the governor side waits its 30 days');

    // A second run with the kept entries submits nothing that still stands (SWAPGOV-12).
    const MS = iface('ArkMultisig', vendored);
    const [count] = await client.call(g.ProposerMultisig, MS, 'txCount');
    const again = await gov.scheduleAcceptances({ client, build: vendored, governance: g, leg, existing: ops, log: quiet });
    assert.equal((await client.call(g.ProposerMultisig, MS, 'txCount'))[0], count);
    assert.ok(again.every((o) => ops.includes(o)));

    // Before 30 profile-days nothing executes; after, --execute runs both, and the court and the S2 chamber are named.
    assert.deepEqual(await gov.executeAcceptances({ client, build: vendored, governance: g, ops, log: quiet }), []);
    const eta = ops.filter((o) => o.opId).reduce((m, o) => (BigInt(o.eta) > m ? BigInt(o.eta) : m), 0n);
    client.chain.advanceTime(Number(eta - BigInt((await client.head()).timestamp)) + 1);
    assert.deepEqual(await gov.executeAcceptances({ client, build: vendored, governance: g, ops, log: quiet }), ['ArkGovernor.setObjectionSource', 'ArkGovernor.setCourt']);
    s = await gov.wiringStatus({ client, build: vendored, governance: g, leg });
    assert.deepEqual([s.wired, s.courtWired], [true, true]);
  });
});

describe('the probe reads the oracle court (GV-19)', { skip }, () => {
  test('a record whose court differs from the oracle\'s is stale', async () => {
    const client = await harnessClient(MANIFEST);
    const { c } = gov.governanceConfig({ chain: 'local', manifest: MANIFEST, deployer: client.address });
    const { record } = await gov.deployGovernance({ client, chain: 'local', manifest: MANIFEST, config: c, build: vendored, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-court-')), 'g.json'), log: quiet });
    assert.equal((await gov.checkGovernanceRecord({ client, record })).ok, true);
    const wrong = { ...record, parameters: { ...record.parameters, court: OTHER } };
    const r = await gov.checkGovernanceRecord({ client, record: wrong });
    assert.equal(r.ok, false);
    assert.match(r.reason, /ArkQDayOracle\.court\(\)/);
  });
});
