/**
 * `deployOrigin` (scripts/lib/deploy.js) and the relayer state it retires.
 *
 * The rule under test: the previous relay's state is moved aside only once the
 * new relay exists. Moved first, a deployment that fails half way leaves the
 * old seed and the old relay beside an empty state — a relayer that would sign
 * the old relay's next leaf with no record of what that leaf already signed.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deployOrigin, resolveRoles } = require('../../../scripts/lib/deploy');
const { RelayerState } = require('../engine/state');
const manifestLib = require('../lib/manifest');

// A copy of a checked-in manifest, so no outcome here can write the real one.
// Only the existence of the relay's artifact is checked before the first send,
// and the stub client never reads it, so an empty one will do.
const CHAIN = 'hoodi';
const MANIFEST = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-manifest-')), 'chain.json');
fs.copyFileSync(manifestLib.manifestPath(CHAIN), MANIFEST);
const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-build-'));
fs.writeFileSync(path.join(BUILD, 'ArkEpochRootRelay.json'), '{}');

function stubClient(failOn) {
  let n = 0;
  return {
    async head() {
      return { latest: 1n, safe: 1n, timestamp: 0n };
    },
    // Every address the manifest names has code: the doubles are not redeployed.
    async code() {
      return '0x60';
    },
    async deploy(name) {
      if (name === failOn) throw new Error(`deploying ${name} failed`);
      n += 1;
      return '0x' + n.toString(16).padStart(40, '0');
    },
  };
}

function oldState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-deploy-'));
  const s = new RelayerState(path.join(root, CHAIN));
  s.data.signed[0] = { message: '0x' + '11'.repeat(32), epoch: 1n, root: '0x01', admitted: true };
  s.save();
  return root;
}

describe('deployOrigin and the relayer state', () => {
  test('a relay that fails to deploy leaves the previous state where it was', async () => {
    const stateRoot = oldState();
    await assert.rejects(
      // The manifest's relay is retired with escrows this stub cannot read: allowed here (OL-04 has its own test).
      deployOrigin({ client: stubClient('ArkEpochRootRelay'), chain: CHAIN, build: BUILD, log: () => {}, persistEnv: false, treeHeight: 2, stateRoot, manifestFile: MANIFEST, allowStrand: true }),
      /ArkEpochRootRelay failed/,
    );
    assert.equal(new RelayerState(path.join(stateRoot, CHAIN)).data.signed[0].message, '0x' + '11'.repeat(32));
  });

  test('once the new relay exists, the previous state is moved aside, not deleted', async () => {
    const stateRoot = oldState();
    await assert.rejects(
      deployOrigin({ client: stubClient('ArkStakeEscrowLido'), chain: CHAIN, build: BUILD, log: () => {}, persistEnv: false, treeHeight: 2, stateRoot, manifestFile: MANIFEST, allowStrand: true }),
      /failed/,
    );
    assert.ok(!fs.existsSync(path.join(stateRoot, CHAIN, 'state.json')));
    const aside = fs.readdirSync(stateRoot).find((d) => d.startsWith(`${CHAIN}.`));
    assert.ok(aside && fs.existsSync(path.join(stateRoot, aside, 'state.json')));
  });

  test('escrows of the retiring relay that may hold positions stop the deployment before anything is deployed (OL-04)', async () => {
    const stateRoot = oldState();
    const client = stubClient(null);
    let deployed = 0;
    const deploy = client.deploy;
    client.deploy = async (...a) => {
      deployed += 1;
      return deploy(...a);
    };
    await assert.rejects(
      deployOrigin({ client, chain: CHAIN, build: BUILD, log: () => {}, persistEnv: false, treeHeight: 2, stateRoot, manifestFile: MANIFEST }),
      /still has escrows holding positions.*--allow-strand/,
    );
    assert.equal(deployed, 0, 'nothing deployed');
    assert.equal(new RelayerState(path.join(stateRoot, CHAIN)).data.signed[0].message, '0x' + '11'.repeat(32), 'the state stays');
  });

  test('a relayer running on this state stops the deployment before anything is sent', async () => {
    const stateRoot = oldState();
    fs.writeFileSync(path.join(stateRoot, CHAIN, 'lock'), String(process.ppid));
    await assert.rejects(
      deployOrigin({ client: stubClient(null), chain: CHAIN, build: BUILD, log: () => {}, persistEnv: false, treeHeight: 2, stateRoot, manifestFile: MANIFEST }),
      /relayer is running/,
    );
  });
});

describe('re-audit 2026-09-30: the operations destination is named, and every value of a retiring escrow is read (ORIGIN-07, ORIGIN-08)', () => {
  test('ORIGIN-07: a manifest with no operations destination deploys nothing (no random, keyless address)', async () => {
    const stateRoot = oldState();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-manifest-')), 'chain.json');
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    m.addresses.operationsDestination = null;
    fs.writeFileSync(file, JSON.stringify(m));
    const client = stubClient(null);
    let deployed = 0;
    const deploy = client.deploy;
    client.deploy = async (...a) => {
      deployed += 1;
      return deploy(...a);
    };
    await assert.rejects(
      deployOrigin({ client, chain: CHAIN, build: BUILD, log: () => {}, persistEnv: false, treeHeight: 2, stateRoot, manifestFile: file, allowStrand: true }),
      /names no addresses.operationsDestination/,
    );
    assert.equal(deployed, 0);
  });

  test('ORIGIN-08: an escrow of the retiring relay holding only a buffer (its seed) stops the deployment too', async () => {
    const { checkRetiringRelay } = require('../../../scripts/lib/deploy');
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const client = {
      async code() {
        return '0x60';
      },
      async call(_to, _abi, name) {
        return [name === 'bufferShares' ? 10n ** 18n : 0n];
      },
    };
    const build = path.join(__dirname, '..', '..', 'ethereum', 'build');
    await assert.rejects(checkRetiringRelay({ client, manifest: m, build, log: () => {} }), /bufferShares/);
    const quiet = { ...client, async call() { return [0n]; } };
    const { stranded } = await checkRetiringRelay({ client: quiet, manifest: m, build, log: () => {} });
    assert.deepEqual(stranded, [], 'an escrow holding nothing retires');
  });
});

describe('the QRL leg roles on a shared network are three accounts, or an explicit override (D2)', () => {
  const ME = '0x' + '11'.repeat(20);
  const GOV = '0x' + '22'.repeat(20);
  const SEAL = '0x' + '33'.repeat(20);
  const OPER = '0x' + '44'.repeat(20);

  test('a local manifest uses the deployer for every role and reads nothing from the environment', () => {
    const r = resolveRoles({ me: ME, env: { GOVERNANCE_ADDRESS: GOV, SEALER_ADDRESS: SEAL }, manifest: { client: 'harness' }, chain: 'local' });
    assert.deepEqual([r.governance, r.sealer, r.oracleOperator, r.shared], [ME, ME, ME, false]);
    assert.equal(resolveRoles({ me: ME, env: {}, manifest: { client: 'qrl' }, chain: 'rehearsal' }).shared, false);
  });

  test('a shared manifest refuses governance, the sealer and the deployer on one key', () => {
    const shared = { client: 'evm' };
    assert.throws(() => resolveRoles({ me: ME, env: {}, manifest: shared, chain: 'hoodi-vps' }), /shared network/);
    assert.throws(() => resolveRoles({ me: ME, env: { GOVERNANCE_ADDRESS: GOV }, manifest: shared, chain: 'hoodi-vps' }), /sealer is the deployer/);
    assert.throws(() => resolveRoles({ me: ME, env: { GOVERNANCE_ADDRESS: GOV, SEALER_ADDRESS: GOV }, manifest: shared, chain: 'hoodi-vps' }), /governance is the attestation sealer/);
    assert.throws(() => resolveRoles({ me: ME, env: {}, manifest: {}, chain: 'hoodi' }), /shared network/, 'an absent client is a real origin chain');
  });

  test('three distinct accounts pass, per-chain keys win, and ALLOW_SHARED_KEYS=1 overrides knowingly', () => {
    const shared = { client: 'evm' };
    const r = resolveRoles({ me: ME, env: { GOVERNANCE_ADDRESS: ME, HOODI_VPS_GOVERNANCE_ADDRESS: GOV, SEALER_ADDRESS: SEAL, ORACLE_OPERATOR_ADDRESS: OPER }, manifest: shared, chain: 'hoodi-vps' });
    assert.deepEqual([r.governance, r.sealer, r.oracleOperator], [GOV, SEAL, OPER]);
    const o = resolveRoles({ me: ME, env: { ALLOW_SHARED_KEYS: '1' }, manifest: shared, chain: 'hoodi-vps' });
    assert.equal(o.governance, ME);
    assert.ok(o.clashes.length >= 2);
  });

  test("the price double's operator is not the deployer on a shared network (item 38, 2026-09-28)", () => {
    const shared = { client: 'evm' };
    assert.throws(() => resolveRoles({ me: ME, env: { GOVERNANCE_ADDRESS: GOV, SEALER_ADDRESS: SEAL }, manifest: shared, chain: 'hoodi-vps' }), /operator is the deployer/);
  });

  test('a live governance record makes the timelock governance; GOVERNANCE_ADDRESS is then not read', () => {
    const shared = { client: 'evm' };
    const TL = '0x' + '55'.repeat(20);
    const r = resolveRoles({ me: ME, env: { GOVERNANCE_ADDRESS: ME, SEALER_ADDRESS: SEAL, ORACLE_OPERATOR_ADDRESS: OPER }, manifest: shared, chain: 'hoodi-vps', governance: TL });
    assert.deepEqual([r.governance, r.clashes.length], [TL, 0]);
    assert.equal(resolveRoles({ me: ME, manifest: { client: 'harness' }, chain: 'local', governance: TL }).governance, TL);
  });
});
