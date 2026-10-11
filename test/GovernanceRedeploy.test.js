/**
 * A governance record is trusted only on the chain that holds it (item 77).
 *
 * The devnet is rebuilt from genesis every day; the relayer then redeploys
 * contracts/core's governance stack from the vendored artifacts and wires the
 * QRL leg to it (scripts/lib/governance.js, ecdsa-stakings/relayer/engine/
 * redeploy.js). These tests deploy the stack on one harness chain and hold its
 * record against that chain and against a second one standing in for the
 * chain after a reset: another genesis, no code at the recorded addresses,
 * addresses that hold some other contract, another chain id. Each is refused,
 * and the redeploy plan answers "deploy governance" exactly when it should.
 *
 * Needs `vendor/core-governance/build-testnet/` (npm run vendor:governance,
 * after contracts/core is built at --profile testnet); skips, naming it, where
 * it is absent.
 */
const test = require('node:test');
const { describe, before } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { harnessClient, iface } = require('../scripts/lib/chains');
const gov = require('../scripts/lib/governance');
const { liveGovernanceRecord, StaleGovernanceError } = require('../scripts/lib/deploy');
const { qrlSidePlan } = require('../ecdsa-stakings/relayer/engine/redeploy');

const MANIFEST = { name: 'local', chainId: 31337, profile: 'testnet', client: 'harness', confirmations: 1, governance: { selfDeploy: true } };
const vendored = (() => {
  try {
    return gov.governanceBuild({ client: { kind: 'harness' }, profileName: 'testnet' });
  } catch (e) {
    return { missing: e.message };
  }
})();
const skip = typeof vendored === 'object' ? `vendored governance artifacts absent: ${vendored.missing}` : false;
const quiet = () => {};
const ONE = 10n ** 18n;

describe('a governance record is held to its genesis, its code and its wiring (item 77)', { skip }, () => {
  let chainA;
  let chainB;
  let record;
  let file;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-gov-'));
  const attesters = ['a1', 'a2', 'a3', 'a4', 'a5'].map((b) => '0x' + b.repeat(20));

  before(async () => {
    chainA = await harnessClient(MANIFEST);
    chainB = await harnessClient(MANIFEST);
    const { c, errors } = gov.governanceConfig({ chain: 'local', manifest: MANIFEST, deployer: chainA.address, overrides: { attesters, attesterBond: 10n * ONE } });
    assert.deepEqual(errors, []);
    ({ record, file } = await gov.deployGovernance({ client: chainA, chain: 'local', manifest: MANIFEST, config: c, build: vendored, file: path.join(tmp, 'governance-local.json'), log: quiet }));
  });

  test('the stack deployed from the vendored artifacts probes as its record says, on its own genesis', async () => {
    assert.deepEqual(await gov.checkGovernanceRecord({ client: chainA, record }), { ok: true, legacy: false });
    const oracle = iface('ArkQDayOracle', vendored);
    const [governor] = await chainA.call(record.addresses.ArkQDayOracle, oracle, 'governor');
    assert.equal(governor.toLowerCase(), record.addresses.ArkGovernor.toLowerCase());
    const [panel] = await chainA.call(record.addresses.ArkQDayOracle, oracle, 'attesters');
    assert.equal(panel.length, 5);
    assert.equal(record.profile, 'testnet');
    assert.match(record.genesisHash, /^0x[0-9a-f]{64}$/);
  });

  test('ArkPhase is part of the network\'s stack: the timelock governs it from construction, on the stack\'s oracle, at ArkEpoch\'s length (2026-10-07)', async () => {
    const P = iface('ArkPhase', vendored);
    const at = record.addresses.ArkPhase;
    assert.ok(at, 'the record names ArkPhase');
    const [governance] = await chainA.call(at, P, 'governance');
    const [oracle] = await chainA.call(at, P, 'qdayOracle');
    const [length] = await chainA.call(at, P, 'epochLength');
    const [phase] = await chainA.call(at, P, 'phase');
    assert.deepEqual([governance.toLowerCase(), oracle.toLowerCase(), BigInt(length), Number(phase)], [record.addresses.ArkTimelock.toLowerCase(), record.addresses.ArkQDayOracle.toLowerCase(), 4200n, 0]);
    assert.equal(record.parameters.epochLength, 4200);
    assert.equal(record.network, 'local', 'a manifest naming no network is its own');
    const wrong = await gov.checkGovernanceRecord({ client: chainA, record: { ...record, addresses: { ...record.addresses, ArkPhase: record.addresses.VeArk } } });
    assert.equal(wrong.ok, false, 'an ArkPhase address holding another contract is refused');
    const length600 = await gov.checkGovernanceRecord({ client: chainA, record: { ...record, parameters: { ...record.parameters, epochLength: 600 } } });
    assert.deepEqual([length600.ok, /epochLength/.test(length600.reason)], [false, true]);
  });

  test('a live record from before ArkPhase is still live, and gets ArkPhase added to the same stack, not a second stack', async () => {
    const { ArkPhase, ...older } = record.addresses;
    const before2026 = { ...record, network: 'local', addresses: older, parameters: { ...record.parameters, epochLength: undefined } };
    assert.deepEqual(await gov.checkGovernanceRecord({ client: chainA, record: before2026 }), { ok: true, legacy: false });
    const out = path.join(tmp, 'governance-net.json');
    const { record: added } = await gov.addArkPhase({ client: chainA, record: before2026, build: vendored, epochLength: 4200, network: 'net', file: out, log: quiet });
    assert.equal(added.network, 'net');
    assert.equal(added.addresses.ArkTimelock, record.addresses.ArkTimelock, 'the same timelock');
    assert.notEqual(added.addresses.ArkPhase.toLowerCase(), ArkPhase.toLowerCase());
    assert.deepEqual(await gov.checkGovernanceRecord({ client: chainA, record: added }), { ok: true, legacy: false });
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).addresses.ArkPhase, added.addresses.ArkPhase);
    await assert.rejects(gov.addArkPhase({ client: chainA, record: added, build: vendored, epochLength: 4200, network: 'net', file: out, log: quiet }), /already names ArkPhase/);
  });

  test('the same record on the chain after a reset is stale: its genesis is not this chain\'s', async () => {
    const r = await gov.checkGovernanceRecord({ client: chainB, record });
    assert.deepEqual([r.ok, r.state], [false, 'stale']);
    assert.match(r.reason, /genesis/);
  });

  test('a record with no genesis hash is still refused where its addresses hold no code', async () => {
    const r = await gov.checkGovernanceRecord({ client: chainB, record: { ...record, genesisHash: undefined } });
    assert.deepEqual([r.ok, r.state], [false, 'stale']);
    assert.match(r.reason, /no code/);
  });

  test('addresses that hold some other contract of the chain are refused by the probe, not trusted for their code', async () => {
    const swapped = { ...record, genesisHash: undefined, addresses: { ...record.addresses, ArkTimelock: record.addresses.VeArk, VeArk: record.addresses.ArkTimelock } };
    const r = await gov.checkGovernanceRecord({ client: chainA, record: swapped });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not answer|answers/);
    const legacy = await gov.checkGovernanceRecord({ client: chainA, record: { ...record, genesisHash: undefined } });
    assert.deepEqual(legacy, { ok: true, legacy: true });
  });

  test('a record for another chain id is foreign', async () => {
    const r = await gov.checkGovernanceRecord({ client: chainA, record: { ...record, chainId: '1' } });
    assert.deepEqual([r.ok, r.state], [false, 'foreign']);
  });

  test('the QRL leg refuses a stale record before it sends anything, and requires one where the manifest names core\'s oracle', async () => {
    await assert.rejects(
      liveGovernanceRecord({ client: chainB, chain: 'local', manifest: MANIFEST, qrlChainId: 31337, explicit: file }),
      (e) => e instanceof StaleGovernanceError && /stale/.test(e.message),
    );
    const live = await liveGovernanceRecord({ client: chainA, chain: 'local', manifest: MANIFEST, qrlChainId: 31337, explicit: file });
    assert.equal(live.addresses.ArkTimelock, record.addresses.ArkTimelock.toLowerCase());
    assert.equal(await liveGovernanceRecord({ client: chainA, chain: 'local', manifest: { ...MANIFEST, qday: 'MockQDayOracle' }, qrlChainId: 31337, explicit: file }), null);
    // A chain with no record anywhere, on a manifest that names core's oracle.
    await assert.rejects(
      liveGovernanceRecord({ client: chainB, chain: 'nochain', manifest: { ...MANIFEST, qday: 'ArkQDayOracle' }, qrlChainId: 999999 }),
      /no governance record exists/,
    );
  });

  test('the relayer\'s redeploy plan deploys governance after a reset and only then', async () => {
    const env = { GOVERNANCE_RECORD: file };
    const after = await qrlSidePlan({ client: chainB, chain: 'local', manifest: MANIFEST, env });
    assert.deepEqual([after.live, after.deployGovernance], [false, true]);
    assert.match(after.status.reason, /genesis/);
    const same = await qrlSidePlan({ client: chainA, chain: 'local', manifest: MANIFEST, env });
    assert.deepEqual([same.live, same.deployGovernance], [true, false]);
    const notAsked = qrlSidePlan({ client: chainB, chain: 'local', manifest: { ...MANIFEST, governance: { selfDeploy: false } }, env });
    await assert.rejects(notAsked, /does not ask the relayer to deploy it/);
  });

  test('funding a fresh genesis is idempotent: a second run sends nothing', async () => {
    const plan = [{ address: '0x' + 'b1'.repeat(20), label: 'attester', target: 12n * ONE }];
    const first = await gov.fundAccounts({ client: chainB, plan, log: quiet });
    assert.equal(first.length, 1);
    assert.equal(await chainB.balance(plan[0].address), 12n * ONE);
    assert.equal(await gov.fundingShortfall({ client: chainB, plan }), 0n);
    assert.deepEqual(await gov.fundAccounts({ client: chainB, plan, log: quiet }), []);
  });
});
