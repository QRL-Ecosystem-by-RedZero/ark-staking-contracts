/**
 * ArkBondDelegation against the real QRL deposit contract, and ArkBondStaking
 * in front of it.
 *
 * The one rule this file exists to defend: **bond principal is deposited only
 * as the one 40,000-QRL deposit governance admitted, only onto a key with no
 * deposit before it, never past the concentration bound, always withdrawing to
 * the delegation contract — and nothing that comes back counts, or is paid out,
 * before a report root has stood for the challenge window** (whitepaper §3.4,
 * §6.3).
 *
 * Nothing here is a double. The deposit contract is the runtime code and the
 * storage read off the Kurtosis enclave's genesis contract at Q4242…42
 * (`test/fixtures/zond-deposit-contract.json`), installed at the same address,
 * and the deposits are real ones — ML-DSA-87 validator keys, 4,627-byte
 * signatures, deposit data roots — written by qrysm's own `deposit` tool
 * (`test/fixtures/zond-deposits.json`). The deposit contract recomputes the
 * SSZ root of every deposit and refuses one that does not match, so a deposit
 * whose withdrawal credentials, amount or signature differ from what governance
 * admitted is refused by the chain's own code, not by an assertion here.
 *
 * The deposit data names a fixed address, so the delegation contract is
 * deployed normally and then moved there: its configuration is all immutable,
 * which is what lets it move whole. The beacon chain itself is not here; its
 * facts reach the contract only as the attester quorum's statements, sealed
 * into `MockAttestation` (which verifies a real Merkle proof), and a withdrawal
 * is simulated the way the chain performs one: a balance credit that runs no
 * code.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Interface, keccak256, getBytes, AbiCoder, toUtf8Bytes } = require('ethers');
const { Chain, ACCOUNTS } = require('./harness');
const F = require('./stake-fixture');
const { pairHash } = F;

const DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242';
const snapshot = require('./fixtures/zond-deposit-contract.json');
const deposits = require('./fixtures/zond-deposits.json');

const QRL = 10n ** 18n;
const VALIDATOR = 40_000n * QRL;
const BOND = ACCOUNTS.guardian;
const OPERATOR = ACCOUNTS.bob;
const OPERATOR_BOND = 4_000n * QRL;
const DAY = 24 * 60 * 60;
const EPOCH = 7 * DAY;
const coder = AbiCoder.defaultAbiCoder();
const REPORT_DOMAIN = keccak256(toUtf8Bytes('ARK_DELEGATION_REPORT_V2'));
const DEPOSIT_CHECK_DOMAIN = keccak256(toUtf8Bytes('ARK_DELEGATION_DEPOSIT_CHECK_V1'));
const FEES_TAG = keccak256(toUtf8Bytes('FEES'));
const ZERO32 = '0x' + '00'.repeat(32);

/** Beacon API status ordinals, as the report carries them. */
const STATUS = { pending: 0, active: 2, exiting: 3, slashed: 4, exited: 5, exitedSlashed: 6, possible: 7, done: 8 };

const depositIface = new Interface([
  'function deposit(bytes,bytes,bytes,bytes32) payable',
  'function get_deposit_count() view returns (bytes)',
  'function get_deposit_root() view returns (bytes32)',
  'event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index)',
]);

/* The SSZ root of a DepositData, as qrysm and the `depositroot` precompile compute it. */
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
function merkleize(chunks) {
  let width = 1;
  while (width < chunks.length) width *= 2;
  let layer = [...chunks];
  while (layer.length < width) layer.push(Buffer.alloc(32));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256(Buffer.concat([layer[i], layer[i + 1]])));
    layer = next;
  }
  return layer[0];
}
function packed(b) {
  const chunks = [];
  for (let i = 0; i < b.length; i += 32) {
    const c = Buffer.alloc(32);
    b.copy(c, 0, i, Math.min(i + 32, b.length));
    chunks.push(c);
  }
  return merkleize(chunks);
}
function depositDataRoot(pubkey, credentials, amountWei, signature) {
  const amount = Buffer.alloc(32);
  amount.writeBigUInt64LE(amountWei / 10n ** 9n);
  const hex = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
  return '0x' + merkleize([packed(hex(pubkey)), hex(credentials), amount, packed(hex(signature))]).toString('hex');
}

async function fixture({ fundWith = 0n } = {}) {
  const chain = await Chain.create();
  await chain.fund(BOND, 10_000_000n * QRL);
  await chain.fund(OPERATOR, 1_000_000n * QRL);
  await chain.installCode(DEPOSIT_CONTRACT, snapshot.code, snapshot.storage);

  await chain.fund(ACCOUNTS.admin, 1_000_000n * QRL);
  const params = await F.deployParams(chain);
  const attest = await chain.deploy('MockAttestationResealable');
  const deployed = await chain.deploy(
    'ArkBondDelegation',
    ['address', 'address', 'address', 'address', 'address', 'uint256', 'uint256'],
    // ELIGIBLE_EPOCHS 0: a deadline runs from the request, as before OC-LEGB-04 (test/OC-LEGB.test.js covers it).
    [BOND, ACCOUNTS.admin, DEPOSIT_CONTRACT, params.address, attest.address, 0n, 0n],
  );
  // Slot 0 is ReentrancyGuard's status and slot 1 `governance` — storage since
  // the 2026-09-27 handover — the two words the constructor writes.
  const delegation = await chain.relocate(deployed, deposits.delegationAddress, [0, 1]);
  if (fundWith > 0n) await delegation.send('fund', [], { from: BOND, value: fundWith });
  return withViews({ chain, params, attest, delegation });
}

function withViews(ctx) {
  ctx.depositView = async (fn) => {
    const res = await ctx.chain.execute(DEPOSIT_CONTRACT, ACCOUNTS.admin, depositIface.encodeFunctionData(fn), 0n, true);
    return depositIface.decodeFunctionResult(fn, res.returnValue)[0];
  };
  ctx.depositCount = async () => {
    const le = getBytes(await ctx.depositView('get_deposit_count'));
    return le.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
  };
  return ctx;
}

const EXIT = keccak256(toUtf8Bytes('a pre-signed voluntary exit, held by the quorum'));
const admit = (ctx, d, { bond = OPERATOR_BOND, root = d.deposit_data_root, exit = EXIT } = {}) =>
  ctx.delegation.send('admitValidator', [d.pubkey, root, exit, OPERATOR], { from: ACCOUNTS.admin, value: bond });

const epochOf = (ctx) => ctx.chain.timestamp / BigInt(EPOCH);

/**
 * The attestation keyspace of the delegation's roots (D10): reports and deposit
 * checks are sealed at `REPORT_KEYSPACE | epoch`, never at the plain epoch the
 * forward path reads.
 */
const REPORT_KEYSPACE = (BigInt(keccak256(toUtf8Bytes('ARK_DELEGATION_REPORTS_V1'))) << 128n) & (2n ** 256n - 1n);
const reportKey = (e) => REPORT_KEYSPACE | BigInt(e);

/**
 * The deposit-check keyspace (OC-LEGB-02): a check is sealed at
 * `DEPOSIT_KEYSPACE | deposit count`, never at a report key.
 */
const DEPOSIT_KEYSPACE = (BigInt(keccak256(toUtf8Bytes('ARK_DELEGATION_DEPOSIT_CHECKS_V1'))) << 128n) & (2n ** 256n - 1n);

/** The quorum's statement that `d`'s key has no deposit at the deposit contract's root now, sealed at the deposit count's key. */
async function depositCheck(ctx, d) {
  const root = await ctx.depositView('get_deposit_root');
  const e = epochOf(ctx);
  const leaf = keccak256(coder.encode(['bytes32', 'address', 'bytes32', 'bytes32'], [DEPOSIT_CHECK_DOMAIN, ctx.delegation.address, keccak256(d.pubkey), root]));
  await ctx.attest.send('seal', [DEPOSIT_KEYSPACE | (await ctx.depositCount()), leaf]);
  return { root, e };
}

async function delegate(ctx, d, { from = ACCOUNTS.mallory, signature = d.signature } = {}) {
  const { root } = await depositCheck(ctx, d);
  return ctx.delegation.send('delegate', [d.pubkey, signature, root, []], { from });
}

/** A funded validator, ready to be reported on. */
async function funded(ctx, d = deposits.ours[0]) {
  await admit(ctx, d);
  await delegate(ctx, d);
  return keccak256(d.pubkey);
}

/**
 * One validator's report line, as a tuple the contract takes, with honest
 * defaults. The credentials slot carries `keccak256` of the raw credentials —
 * since QIP-55 the credential is a full 64-byte execution address and the
 * Report field is its hash (`credentialsHash`), not the credential itself.
 */
function reportOf(ctx, e, d, status, withdrawn, { slashed = false, exitInitiated, credentials, balance = VALIDATOR } = {}) {
  const init = exitInitiated ?? (status >= STATUS.exiting ? e : 0n);
  const creds = keccak256(credentials ?? d.withdrawal_credentials);
  return [e, keccak256(d.pubkey), status, slashed, init, creds, balance, withdrawn];
}
const REPORT_TYPES = ['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'bool', 'uint64', 'bytes32', 'uint256', 'uint256'];
const leafOf = (ctx, r) => keccak256(coder.encode(REPORT_TYPES, [REPORT_DOMAIN, ctx.delegation.address, ...r]));
const feesLeaf = (ctx, e, fees) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'address', 'uint256', 'uint256'], [REPORT_DOMAIN, FEES_TAG, ctx.delegation.address, e, fees]));

/** Move past the challenge window of the root noted for `e`. */
async function clearWindow(ctx, e) {
  const clears = await ctx.delegation.call('reportClearsAt', [e]);
  if (clears > ctx.chain.timestamp) ctx.chain.advanceTime(Number(clears - ctx.chain.timestamp));
}

/** Seal a one-line report for the epoch in progress, note it, let its window pass, and apply it. */
async function report(ctx, d, status, withdrawn, { clear = true, ...opts } = {}) {
  const e = epochOf(ctx);
  const r = reportOf(ctx, e, d, status, withdrawn, opts);
  await ctx.attest.send('seal', [reportKey(e), leafOf(ctx, r)]);
  await ctx.delegation.send('noteRoot', [e]);
  if (clear) await clearWindow(ctx, e);
  return ctx.delegation.send('reconcile', [r, []], { from: ACCOUNTS.mallory });
}

/** What the balance must cover: principal held, bonds, refunds, and distribution cleared and unpaid. */
async function owed(ctx) {
  const c = (n) => ctx.delegation.call(n);
  return (await c('idle')) + (await c('bondsHeld')) + (await c('refundsOwed')) + (await c('distributionReconciled')) - (await c('distributed'));
}

describe('ArkBondDelegation', () => {
  describe('the deposit contract is the chain\'s own', () => {
    test('the fixture is the genesis contract with no deposits yet', async () => {
      const ctx = await fixture();
      assert.equal(await ctx.depositCount(), 0n);
      assert.equal(snapshot.code.length > 10_000, true);
    });

    test('a funded validator withdraws to the delegation contract, as qrysm writes an execution address', async () => {
      const ctx = await fixture();
      const creds = await ctx.delegation.call('withdrawalCredentials');
      assert.equal(creds, '0x' + '00'.repeat(12) + deposits.delegationAddress.slice(2));
      for (const d of deposits.ours) assert.equal(d.withdrawal_credentials, creds);
    });

    test('the SSZ root computed here is the one qrysm wrote', () => {
      const d = deposits.ours[0];
      assert.equal(depositDataRoot(d.pubkey, d.withdrawal_credentials, VALIDATOR, d.signature), d.deposit_data_root);
    });
  });

  describe('a real deposit reaches the deposit contract', () => {
    test('an admitted validator is funded with 40,000 QRL and the deposit is recorded', async () => {
      const ctx = await fixture({ fundWith: 1_000_000n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d);
      const rootBefore = await ctx.depositView('get_deposit_root');

      const res = await delegate(ctx, d);

      assert.equal(await ctx.depositCount(), 1n);
      assert.notEqual(await ctx.depositView('get_deposit_root'), rootBefore);
      assert.equal(await ctx.chain.balanceOf(DEPOSIT_CONTRACT), VALIDATOR);
      const logs = res.logs.filter((l) => l.address.toLowerCase() === DEPOSIT_CONTRACT);
      const ev = depositIface.parseLog(logs[0]);
      assert.equal(ev.name, 'DepositEvent');
      assert.equal(ev.args.pubkey, d.pubkey);
      assert.equal(ev.args.withdrawal_credentials, d.withdrawal_credentials);
      const [mine] = ctx.delegation.events(res, 'Delegated');
      assert.equal(mine.args.pubkeyHash, keccak256(d.pubkey));
      assert.equal(await ctx.delegation.call('delegated'), VALIDATOR);
      assert.equal(await ctx.delegation.call('idle'), 1_000_000n * QRL - VALIDATOR);
    });

    test('funding an admitted validator is permissionless, and the caller receives nothing', async () => {
      const ctx = await fixture({ fundWith: 1_000_000n * QRL });
      const d = deposits.ours[1];
      await admit(ctx, d);
      const before = await ctx.chain.balanceOf(ACCOUNTS.mallory);
      await delegate(ctx, d, { from: ACCOUNTS.mallory });
      assert.equal(await ctx.chain.balanceOf(ACCOUNTS.mallory), before);
    });

    test('deposit data naming another withdrawal address is refused by the deposit contract\'s own root check', async () => {
      // The credentials are built from this contract's address, never passed
      // in, so the root in someone else's deposit data no longer matches.
      const ctx = await fixture({ fundWith: 1_000_000n * QRL });
      const theirs = deposits.theirs[0];
      await admit(ctx, theirs);
      await assert.rejects(() => delegate(ctx, theirs), /reconstructed DepositData does not match supplied deposit_data_root/);
      assert.equal(await ctx.depositCount(), 0n);
    });
  });

  describe('one deposit per validator, fixed at admission (D2, D3)', () => {
    test('a signature other than the one admitted is refused, so no deposit the beacon chain would drop can be made', async () => {
      // The attack on the old `delegate`: any caller chose the signature and its
      // matching root, the deposit contract accepted it — it checks no signature
      // — and the beacon chain later dropped the deposit with 40,000 QRL burned.
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d);
      const junk = '0x' + 'ab'.repeat(4627);
      await assert.rejects(() => delegate(ctx, d, { signature: junk }), /reconstructed DepositData does not match supplied deposit_data_root/);
      assert.equal(await ctx.depositCount(), 0n);
      assert.equal(await ctx.delegation.call('delegated'), 0n);
    });

    test('the amount is not an argument: every deposit is 40,000 QRL, and a root for any other amount cannot be used', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const inputs = ctx.delegation.iface.getFunction('delegate').inputs.map((i) => i.name);
      assert.deepEqual(inputs, ['pubkey', 'signature', 'depositRoot', 'checkProof']);
      assert.equal(await ctx.delegation.call('VALIDATOR_STAKE'), VALIDATOR);

      // Governance admitting data for 1,000 QRL admits a deposit that never matches.
      const d = deposits.ours[0];
      const small = depositDataRoot(d.pubkey, d.withdrawal_credentials, 1_000n * QRL, d.signature);
      await admit(ctx, d, { root: small });
      await assert.rejects(() => delegate(ctx, d), /reconstructed DepositData does not match supplied deposit_data_root/);
    });

    test('a validator is funded once: there is no top-up, so nothing is staked above the maximum effective balance', async () => {
      const ctx = await fixture({ fundWith: 1_000_000n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d);
      await delegate(ctx, d);
      await assert.rejects(() => delegate(ctx, d), /AlreadyFunded/);
      assert.equal(await ctx.depositCount(), 1n);
      assert.equal((await ctx.delegation.call('validatorOf', [keccak256(d.pubkey)])).stake, VALIDATOR);
    });

    test('admission records the deposit data root, and refuses none', async () => {
      const ctx = await fixture();
      const d = deposits.ours[0];
      await assert.rejects(() => admit(ctx, d, { root: ZERO32 }), /ZeroValue/);
      await admit(ctx, d);
      assert.equal((await ctx.delegation.call('validatorOf', [keccak256(d.pubkey)])).depositDataRoot, d.deposit_data_root);
    });
  });

  describe('no deposit onto a key that already has one (D1)', () => {
    test('a key the operator deposited first, to its own credentials, is not funded: the deposit root has moved', async () => {
      // The attack: the operator deposits its own key first — 1 QRL, its own
      // credentials, a valid signature — so our 40,000 becomes a top-up to its
      // credentials, which it withdraws on exit.
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d);
      const { root, e } = await depositCheck(ctx, d);

      const theirs = '0x' + '00'.repeat(12) + OPERATOR.slice(2).toLowerCase();
      const frontRun = depositDataRoot(d.pubkey, theirs, QRL, d.signature);
      await ctx.chain.execute(DEPOSIT_CONTRACT, OPERATOR, depositIface.encodeFunctionData('deposit', [d.pubkey, theirs, d.signature, frontRun]), QRL);

      await assert.rejects(
        () => ctx.delegation.send('delegate', [d.pubkey, d.signature, root, []], { from: ACCOUNTS.mallory }),
        /DepositRootChanged/,
      );
      assert.equal(await ctx.depositCount(), 1n, 'only the operator\'s deposit');
    });

    test('a delegation needs the quorum\'s statement, for this key and this root', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const [d, other] = deposits.ours;
      await admit(ctx, d);
      const root = await ctx.depositView('get_deposit_root');
      const e = epochOf(ctx);
      // No statement sealed at all.
      await assert.rejects(() => ctx.delegation.send('delegate', [d.pubkey, d.signature, root, []]), /BadProof/);
      // A statement about another key.
      await depositCheck(ctx, other);
      await assert.rejects(() => ctx.delegation.send('delegate', [d.pubkey, d.signature, root, []]), /BadProof/);
      // A statement at a root that is not the live one.
      await assert.rejects(() => ctx.delegation.send('delegate', [d.pubkey, d.signature, ZERO32, []]), /DepositRootChanged/);
      assert.equal(await ctx.delegation.call('depositCheckLeaf', [keccak256(d.pubkey), root]),
        keccak256(coder.encode(['bytes32', 'address', 'bytes32', 'bytes32'], [DEPOSIT_CHECK_DOMAIN, ctx.delegation.address, keccak256(d.pubkey), root])));
    });

    test('a report showing credentials other than ours forfeits the bond, and the stake that never comes back is a loss', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await funded(ctx, d);
      const theirs = '0x' + '00'.repeat(12) + OPERATOR.slice(2).toLowerCase();
      const bondBefore = await ctx.chain.balanceOf(BOND);
      const res = await report(ctx, d, STATUS.done, 0n, { credentials: theirs });
      assert.equal(ctx.delegation.events(res, 'BondForfeited')[0].args.reason, 3n);
      assert.equal((await ctx.chain.balanceOf(BOND)) - bondBefore, OPERATOR_BOND);
      assert.equal(ctx.delegation.events(res, 'StakeLost')[0].args.loss, VALIDATOR);
      assert.equal(await ctx.delegation.call('refundOf', [OPERATOR]), 0n, 'the operator gets nothing back');
    });
  });

  describe('the concentration bound is enforced at delegation (whitepaper §3.4, §6.3)', () => {
    test('below 400,000 QRL of principal no validator can be funded at all', async () => {
      const ctx = await fixture({ fundWith: 399_999n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d);
      await assert.rejects(() => delegate(ctx, d), /ConcentrationExceeded/);
      assert.equal(await ctx.delegation.call('concentrationBound'), 39_999n * QRL + (9n * QRL) / 10n);
    });

    test('exactly at the bound a validator is funded', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d);
      await delegate(ctx, d);
      assert.equal(await ctx.depositCount(), 1n);
    });

    test('the bound spreads a pool across validators rather than refusing it', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      for (const d of deposits.ours) {
        await admit(ctx, d);
        await delegate(ctx, d);
      }
      assert.equal(await ctx.depositCount(), 3n);
      assert.equal(await ctx.delegation.call('delegated'), 3n * VALIDATOR);
    });

    test('a lower bound voted in governance binds the next delegation', async () => {
      const ctx = await fixture({ fundWith: 600_000n * QRL });
      // A diff, in force from the next epoch boundary (design §6.4).
      await F.enactParams(ctx.chain, ctx.params, { validatorConcentrationBps: 500 });
      const d = deposits.ours[0];
      await admit(ctx, d);
      await assert.rejects(() => delegate(ctx, d), /ConcentrationExceeded/, '500 bps of 600,000 is 30,000');
    });

    test('nothing is deposited beyond the idle principal', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await ctx.delegation.send('returnIdle', [370_000n * QRL], { from: BOND });
      const d = deposits.ours[0];
      await admit(ctx, d);
      await assert.rejects(() => delegate(ctx, d), /InsufficientIdle|ConcentrationExceeded/);
    });
  });

  describe('who may do what', () => {
    test('an unadmitted validator is not funded', async () => {
      const ctx = await fixture({ fundWith: 1_000_000n * QRL });
      await assert.rejects(() => delegate(ctx, deposits.ours[0]), /ValidatorNotAdmitted/);
    });

    test('only governance admits, a key is admitted once, and only an ML-DSA-87 key', async () => {
      const ctx = await fixture();
      const d = deposits.ours[0];
      await assert.rejects(() => ctx.delegation.send('admitValidator', [d.pubkey, d.deposit_data_root, EXIT, OPERATOR], { from: ACCOUNTS.mallory }), /OnlyGovernance/);
      await assert.rejects(() => ctx.delegation.send('admitValidator', ['0x' + 'ab'.repeat(48), d.deposit_data_root, EXIT, OPERATOR], { from: ACCOUNTS.admin, value: OPERATOR_BOND }), /BadPubkeyLength/);
      await admit(ctx, d);
      await assert.rejects(() => admit(ctx, d), /ValidatorAlreadyAdmitted/);
    });

    test('a validator is admitted only behind an operator bond of 1,000 bps of the stake it may carry', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      assert.equal(await ctx.delegation.call('requiredBond'), OPERATOR_BOND);
      await assert.rejects(() => admit(ctx, deposits.ours[0], { bond: OPERATOR_BOND - 1n }), /OperatorBondShort/);
      await admit(ctx, deposits.ours[0]);
      assert.equal(await ctx.delegation.call('bondsHeld'), OPERATOR_BOND);
      assert.equal(await ctx.delegation.call('idle'), 400_000n * QRL, 'a bond is not principal');
    });

    test('the exit commitment can follow funding, because a QRL exit names an index the deposit creates', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await admit(ctx, d, { exit: ZERO32 });
      await delegate(ctx, d);
      const later = keccak256(toUtf8Bytes('the exit, signed once the index is known'));
      await assert.rejects(() => ctx.delegation.send('commitExit', [keccak256(d.pubkey), later], { from: ACCOUNTS.mallory }), /OnlyGovernance/);
      await ctx.delegation.send('commitExit', [keccak256(d.pubkey), later], { from: ACCOUNTS.admin });
      assert.equal((await ctx.delegation.call('validatorOf', [keccak256(d.pubkey)])).exitCommitment, later);
    });

    test('only the bond places principal, and a bare transfer is refused', async () => {
      const ctx = await fixture();
      await assert.rejects(() => ctx.delegation.send('fund', [], { from: ACCOUNTS.mallory, value: QRL }), /OnlyBond/);
      await assert.rejects(() => ctx.chain.execute(ctx.delegation.address, BOND, '0x', QRL), /ZeroValue/);
    });

    test('only the bond takes principal back, and only what is idle', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await assert.rejects(() => ctx.delegation.send('returnIdle', [QRL], { from: ACCOUNTS.mallory }), /OnlyBond/);
      await assert.rejects(
        () => ctx.delegation.send('returnIdle', [400_000n * QRL], { from: BOND }),
        /InsufficientIdle/,
        'principal on the beacon chain cannot be called back from here',
      );
      const before = await ctx.chain.balanceOf(BOND);
      await ctx.delegation.send('returnIdle', [360_000n * QRL], { from: BOND });
      assert.equal((await ctx.chain.balanceOf(BOND)) > before, true);
      assert.equal(await ctx.delegation.call('principal'), 40_000n * QRL);
    });
  });

  describe('an admission nothing was deposited under can be withdrawn (D8)', () => {
    test('the operator takes its bond back from a validator never funded, and the key may be admitted again', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      const pkh = keccak256(d.pubkey);
      await admit(ctx, d);
      await assert.rejects(() => ctx.delegation.send('withdrawAdmission', [pkh], { from: ACCOUNTS.mallory }), /NotOperator/);
      const res = await ctx.delegation.send('withdrawAdmission', [pkh], { from: OPERATOR });
      assert.equal(ctx.delegation.events(res, 'AdmissionWithdrawn')[0].args.bond, OPERATOR_BOND);
      assert.equal(await ctx.delegation.call('bondsHeld'), 0n);
      assert.equal(await ctx.delegation.call('refundOf', [OPERATOR]), OPERATOR_BOND);
      const before = await ctx.chain.balanceOf(OPERATOR);
      await ctx.delegation.send('claimRefund', [], { from: OPERATOR });
      assert.equal((await ctx.chain.balanceOf(OPERATOR)) - before, OPERATOR_BOND);
      await assert.rejects(() => delegate(ctx, d), /ValidatorNotAdmitted/);
      await admit(ctx, d);
    });

    test('governance may withdraw it too; a funded validator\'s admission cannot be withdrawn', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const [a, b] = deposits.ours;
      await admit(ctx, a);
      await ctx.delegation.send('withdrawAdmission', [keccak256(a.pubkey)], { from: ACCOUNTS.admin });
      const pkh = await funded(ctx, b);
      await assert.rejects(() => ctx.delegation.send('withdrawAdmission', [pkh], { from: OPERATOR }), /AlreadyFunded/);
    });
  });

  describe('exit on request (whitepaper §3.4)', () => {
    test('only the bond asks for an exit, once, and only of a funded validator', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await admit(ctx, deposits.ours[1]);
      // Admitted, not funded: there is no validator to exit (OC-LEGB-04: the delegation picks).
      await assert.rejects(() => ctx.delegation.send('requestExit', [], { from: BOND }), /NoValidatorToExit/);
      const pkh = await funded(ctx);
      await assert.rejects(() => ctx.delegation.send('requestExit', [], { from: ACCOUNTS.mallory }), /OnlyBond/);
      const res = await ctx.delegation.send('requestExit', [], { from: BOND });
      const [ev] = ctx.delegation.events(res, 'ExitRequested');
      assert.equal(ev.args.pubkeyHash, pkh);
      assert.equal(ev.args.exitCommitment, EXIT, 'the quorum broadcasts what was committed');
      await assert.rejects(() => ctx.delegation.send('requestExit', [], { from: BOND }), /NoValidatorToExit/, 'the one validator is exiting already');
    });

    test('an exit asked for counts as pending until its stake is back, and then stops counting', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      assert.equal(await ctx.delegation.call('exitsPending'), VALIDATOR);
      await ctx.chain.credit(ctx.delegation.address, VALIDATOR);
      await report(ctx, deposits.ours[0], STATUS.done, VALIDATOR);
      assert.equal(await ctx.delegation.call('exitsPending'), 0n);
    });

    test('an operator still not exiting two epochs after the request forfeits its bond to the pool', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      // A report for the epoch after the request is inside the deadline.
      ctx.chain.advanceTime(EPOCH);
      let res = await report(ctx, deposits.ours[0], STATUS.active, 0n);
      assert.equal(ctx.delegation.events(res, 'BondForfeited').length, 0, 'one epoch after the request is inside the deadline');
      // A later report, two or more epochs after the request, still active: forfeited.
      const bondBefore = await ctx.chain.balanceOf(BOND);
      res = await report(ctx, deposits.ours[0], STATUS.active, 0n);
      const [ev] = ctx.delegation.events(res, 'BondForfeited');
      assert.equal(ev.args.reason, 2n);
      assert.equal((await ctx.chain.balanceOf(BOND)) - bondBefore, OPERATOR_BOND);
      assert.equal(await ctx.delegation.call('bondsHeld'), 0n);
    });

    test('an operator that has begun to exit by the deadline keeps its bond', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      ctx.chain.advanceTime(2 * EPOCH);
      const res = await report(ctx, deposits.ours[0], STATUS.exiting, 0n);
      assert.equal(ctx.delegation.events(res, 'BondForfeited').length, 0);
    });

    test('a slashed validator forfeits its operator bond', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      const res = await report(ctx, deposits.ours[0], STATUS.slashed, 0n, { slashed: true });
      assert.equal(ctx.delegation.events(res, 'BondForfeited')[0].args.reason, 1n);
    });
  });

  describe('a forfeit cannot be dodged by the line that is reconciled first (D6)', () => {
    test('a slashing first reconciled at withdrawal_done still forfeits: `slashed` stays in every later line', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, 30_000n * QRL);
      const res = await report(ctx, deposits.ours[0], STATUS.done, 30_000n * QRL, { slashed: true });
      assert.equal(ctx.delegation.events(res, 'BondForfeited')[0].args.reason, 1n);
      assert.equal(await ctx.delegation.call('refundOf', [OPERATOR]), 0n, 'the slashed operator gets nothing back');
      assert.equal(ctx.delegation.events(res, 'StakeLost')[0].args.loss, 10_000n * QRL);
    });

    test('an exit begun after the deadline forfeits, even when the first line reconciled already shows it exited', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      const requested = epochOf(ctx);
      ctx.chain.advanceTime(6 * EPOCH);
      const res = await report(ctx, deposits.ours[0], STATUS.exited, 0n, { exitInitiated: requested + 5n });
      assert.equal(ctx.delegation.events(res, 'BondForfeited')[0].args.reason, 2n);
    });

    test('an exit begun on time keeps the bond, however late the line showing it is reconciled', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      const requested = epochOf(ctx);
      ctx.chain.advanceTime(6 * EPOCH);
      const res = await report(ctx, deposits.ours[0], STATUS.exited, 0n, { exitInitiated: requested + 1n });
      assert.equal(ctx.delegation.events(res, 'BondForfeited').length, 0);
    });

    test('G8: the deadline is the one in force in the epoch the exit was requested, not when a report judges it', async () => {
      // Whitepaper §6.5: "the exit deadline of a validator in force in the
      // epoch its exit was requested, not when the request is judged". A vote
      // lengthening the deadline after the request reaches no request already
      // made, and one shortening it cannot forfeit a bond on terms its operator
      // never had.
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      const requested = epochOf(ctx);
      assert.equal(await ctx.delegation.call('exitDeadlineEpoch', [pkh]), requested + 2n, 'fixed at the request');
      await F.enactParams(ctx.chain, ctx.params, { exitDeadlineEpochs: 4 });
      ctx.chain.advanceTime(5 * EPOCH);
      const res = await report(ctx, deposits.ours[0], STATUS.exited, 0n, { exitInitiated: requested + 3n });
      assert.equal(ctx.delegation.events(res, 'BondForfeited')[0].args.reason, 2n, 'judged on the two epochs in force at the request');
    });

    test('G8: a deadline shortened after the request does not forfeit a bond still inside its own', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.delegation.send('requestExit', [], { from: BOND });
      const requested = epochOf(ctx);
      await F.enactParams(ctx.chain, ctx.params, { exitDeadlineEpochs: 1 });
      ctx.chain.advanceTime(5 * EPOCH);
      const res = await report(ctx, deposits.ours[0], STATUS.exited, 0n, { exitInitiated: requested + 2n });
      assert.equal(ctx.delegation.events(res, 'BondForfeited').length, 0);
    });

    test('a line whose status and exit epoch disagree is refused', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await assert.rejects(() => report(ctx, deposits.ours[0], STATUS.exited, 0n, { exitInitiated: 0n }), /BadStatus/);
      await assert.rejects(() => report(ctx, deposits.ours[0], STATUS.active, 0n, { exitInitiated: 5n }), /BadStatus/);
    });
  });

  describe('nothing received counts before a root has stood for the challenge window (whitepaper §3.4, D4)', () => {
    test('a withdrawal no report has covered is neither distributed nor idle', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, 123n * QRL);
      await assert.rejects(() => ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory }), /NothingToDistribute/);
      assert.equal(await ctx.delegation.call('idle'), 360_000n * QRL);
    });

    test('a report is refused inside its challenge window', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await assert.rejects(() => report(ctx, deposits.ours[0], STATUS.active, 0n, { clear: false }), /ReportNotCleared/);
    });

    test('a root sealed late for a long-past epoch gets its whole window from when it was noted', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await funded(ctx, d);
      ctx.chain.advanceTime(5 * EPOCH);
      const e = epochOf(ctx) - 3n;
      const r = reportOf(ctx, e, d, STATUS.active, 0n);
      await ctx.attest.send('seal', [reportKey(e), leafOf(ctx, r)]);
      await assert.rejects(() => ctx.delegation.send('reconcile', [r, []]), /RootNotNoted/, 'measured from the epoch it would clear at once');
      await ctx.delegation.send('noteRoot', [e]);
      await assert.rejects(() => ctx.delegation.send('reconcile', [r, []]), /ReportNotCleared/);
      ctx.chain.advanceTime(7 * DAY - 1);
      await assert.rejects(() => ctx.delegation.send('reconcile', [r, []]), /ReportNotCleared/);
      ctx.chain.advanceTime(1);
      await ctx.delegation.send('reconcile', [r, []]);
    });

    test('D10: a report sealed in the forward keyspace proves nothing here, and the keyspace is the one stated', async () => {
      // whitepaper §3.5: forward roots and reconciliation reports are sealed
      // under attestation keyspaces distinct from each other. A report line
      // sealed at the plain epoch — where the registry and the swap read
      // anchors and offers — is not a root this contract ever reads.
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      assert.equal(await ctx.delegation.call('REPORT_KEYSPACE'), REPORT_KEYSPACE);
      const d = deposits.ours[0];
      await funded(ctx, d);
      // An epoch whose report keyspace holds no root yet (the deposit check sealed one in the last).
      ctx.chain.advanceTime(EPOCH);
      const e = epochOf(ctx);
      assert.equal(await ctx.delegation.call('reportKey', [e]), reportKey(e));
      const r = reportOf(ctx, e, d, STATUS.active, 0n);
      await ctx.attest.send('seal', [e, leafOf(ctx, r)]);
      await assert.rejects(() => ctx.delegation.send('noteRoot', [e]), /RootMissing/);
      // And a deposit check sealed in the forward keyspace funds nothing.
      const d2 = deposits.ours[1];
      await admit(ctx, d2);
      const root = await ctx.depositView('get_deposit_root');
      const leaf = keccak256(coder.encode(['bytes32', 'address', 'bytes32', 'bytes32'], [DEPOSIT_CHECK_DOMAIN, ctx.delegation.address, keccak256(d2.pubkey), root]));
      ctx.chain.advanceTime(EPOCH);
      const e2 = epochOf(ctx);
      await ctx.attest.send('seal', [e2, leaf]);
      await assert.rejects(() => ctx.delegation.send('delegate', [d2.pubkey, d2.signature, root, []]), /BadProof/);
    });

    test('a root replaced after it was noted must be noted again, and its window starts again', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await funded(ctx, d);
      const e = epochOf(ctx);
      const first = reportOf(ctx, e, d, STATUS.active, 0n);
      await ctx.attest.send('seal', [reportKey(e), leafOf(ctx, first)]);
      await ctx.delegation.send('noteRoot', [e]);
      await assert.rejects(() => ctx.delegation.send('noteRoot', [e]), /RootAlreadyNoted/, 'the same root cannot push its own window');
      ctx.chain.advanceTime(3 * EPOCH);

      // The quorum corrects the root just before the old one would have cleared.
      const corrected = reportOf(ctx, e, d, STATUS.active, 0n, { balance: VALIDATOR - 1n });
      await ctx.attest.send('seal', [reportKey(e), leafOf(ctx, corrected)]);
      await assert.rejects(() => ctx.delegation.send('reconcile', [first, []]), /RootNotNoted/);
      await ctx.delegation.send('noteRoot', [e]);
      await assert.rejects(() => ctx.delegation.send('reconcile', [corrected, []]), /ReportNotCleared/);
      await clearWindow(ctx, e);
      await ctx.delegation.send('reconcile', [corrected, []]);
      await assert.rejects(() => ctx.delegation.send('noteRoot', [e + 50n]), /RootMissing/);
    });

    test('a cleared report of an active validator is distribution, forwarded to the bond by anyone', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, 123n * QRL);
      const res = await report(ctx, deposits.ours[0], STATUS.active, 123n * QRL);
      const [ev] = ctx.delegation.events(res, 'Reconciled');
      assert.equal(ev.args.distribution, 123n * QRL);
      assert.equal(ev.args.principalReturned, 0n);

      const bondBefore = await ctx.chain.balanceOf(BOND);
      const callerBefore = await ctx.chain.balanceOf(ACCOUNTS.mallory);
      await ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory });
      assert.equal((await ctx.chain.balanceOf(BOND)) - bondBefore, 123n * QRL);
      assert.equal(await ctx.chain.balanceOf(ACCOUNTS.mallory), callerBefore);
      await assert.rejects(() => ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory }), /NothingToDistribute/);
    });

    test('after exit, a withdrawal returns principal up to the stake and the rest is distribution', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, VALIDATOR + 7n * QRL);
      const res = await report(ctx, deposits.ours[0], STATUS.exited, VALIDATOR + 7n * QRL);
      const [ev] = ctx.delegation.events(res, 'Reconciled');
      assert.equal(ev.args.principalReturned, VALIDATOR);
      assert.equal(ev.args.distribution, 7n * QRL);
      assert.equal(await ctx.delegation.call('idle'), 400_000n * QRL);
      assert.equal(await ctx.delegation.call('delegated'), 0n);
    });

    test('a validator that closes short of its stake is a loss of bond principal, and its clean bond goes back', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const pkh = await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, 39_000n * QRL);
      const res = await report(ctx, deposits.ours[0], STATUS.done, 39_000n * QRL);
      assert.equal(ctx.delegation.events(res, 'StakeLost')[0].args.loss, 1_000n * QRL);
      assert.equal(await ctx.delegation.call('principal'), 399_000n * QRL);
      assert.equal(await ctx.delegation.call('delegated'), 0n);
      assert.equal(await ctx.delegation.call('idle'), 399_000n * QRL);
      assert.equal((await ctx.delegation.call('validatorOf', [pkh])).closed, true);

      assert.equal(await ctx.delegation.call('refundOf', [OPERATOR]), OPERATOR_BOND);
      const before = await ctx.chain.balanceOf(OPERATOR);
      await ctx.delegation.send('claimRefund', [], { from: OPERATOR });
      assert.equal((await ctx.chain.balanceOf(OPERATOR)) - before, OPERATOR_BOND);
      await assert.rejects(() => report(ctx, deposits.ours[0], STATUS.done, 39_000n * QRL), /ValidatorClosed/);
    });

    test('a report only moves forward, and withdrawals only grow', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, 10n * QRL);
      const e = epochOf(ctx);
      await report(ctx, deposits.ours[0], STATUS.active, 10n * QRL);
      await assert.rejects(
        () => ctx.delegation.send('reconcile', [reportOf(ctx, e, deposits.ours[0], STATUS.active, 10n * QRL), []], { from: ACCOUNTS.mallory }),
        /ReportNotForward/,
      );
      await assert.rejects(() => report(ctx, deposits.ours[0], STATUS.active, 5n * QRL), /WithdrawalsWentBackwards/);
    });

    test('a line the quorum did not seal proves nothing', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await funded(ctx, d);
      const e = epochOf(ctx);
      await ctx.attest.send('seal', [reportKey(e), leafOf(ctx, reportOf(ctx, e, d, STATUS.active, 0n))]);
      await ctx.delegation.send('noteRoot', [e]);
      await clearWindow(ctx, e);
      await assert.rejects(
        () => ctx.delegation.send('reconcile', [reportOf(ctx, e, d, STATUS.exited, VALIDATOR), []], { from: ACCOUNTS.mallory }),
        /BadProof/,
      );
    });

    test('the fees of proposed blocks are distribution once reported, alongside a validator line', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      const d = deposits.ours[0];
      await funded(ctx, d);
      await ctx.chain.credit(ctx.delegation.address, 5n * QRL);
      const e = epochOf(ctx);
      const r = reportOf(ctx, e, d, STATUS.active, 0n);
      const a = leafOf(ctx, r);
      const fees = feesLeaf(ctx, e, 5n * QRL);
      await ctx.attest.send('seal', [reportKey(e), pairHash(a, fees)]);
      await ctx.delegation.send('noteRoot', [e]);
      await clearWindow(ctx, e);
      await ctx.delegation.send('reconcile', [r, [fees]], { from: ACCOUNTS.mallory });
      await ctx.delegation.send('reconcileFees', [e, 5n * QRL, [a]], { from: ACCOUNTS.mallory });
      assert.equal(await ctx.delegation.call('distributionReconciled'), 5n * QRL);
      assert.equal(await ctx.delegation.call('feesReportLeaf', [e, 5n * QRL]), fees);
      assert.equal(await ctx.delegation.call('validatorReportLeaf', [r]), a);
    });

    test('the balance always covers idle principal, bonds, refunds and cleared distribution', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, VALIDATOR + 3n * QRL);
      await report(ctx, deposits.ours[0], STATUS.done, VALIDATOR + 3n * QRL);
      assert.equal(await ctx.chain.balanceOf(ctx.delegation.address), await owed(ctx));
    });
  });

  describe('distribution reported and never received is not paid out of principal (D4, D9)', () => {
    async function phantomFees(ctx, fees) {
      const e = epochOf(ctx);
      await ctx.attest.send('seal', [reportKey(e), feesLeaf(ctx, e, fees)]);
      await ctx.delegation.send('noteRoot', [e]);
      await clearWindow(ctx, e);
      await ctx.delegation.send('reconcileFees', [e, fees, []], { from: ACCOUNTS.mallory });
    }

    test('fees reported but never credited are not distributed: the balance above principal and bonds is nil', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await phantomFees(ctx, 5n * QRL);
      const held = await ctx.chain.balanceOf(ctx.delegation.address);
      await assert.rejects(() => ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory }), /NothingToDistribute/);
      assert.equal(await ctx.chain.balanceOf(ctx.delegation.address), held);
      // Principal can still be taken back in full: distribution ranks behind it.
      await ctx.delegation.send('returnIdle', [360_000n * QRL], { from: BOND });
    });

    test('distribution is paid as far as the balance covers it, and the rest once the value arrives', async () => {
      const ctx = await fixture({ fundWith: 400_000n * QRL });
      await funded(ctx);
      await ctx.chain.credit(ctx.delegation.address, 2n * QRL);
      await phantomFees(ctx, 5n * QRL);
      const bondBefore = await ctx.chain.balanceOf(BOND);
      await ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory });
      assert.equal((await ctx.chain.balanceOf(BOND)) - bondBefore, 2n * QRL);
      assert.equal(await ctx.delegation.call('idle'), 360_000n * QRL);
      await ctx.chain.credit(ctx.delegation.address, 3n * QRL);
      await ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory });
      assert.equal((await ctx.chain.balanceOf(BOND)) - bondBefore, 5n * QRL);
    });
  });
});

/* ------------------------------------------------------------------ */
/* ArkBondStaking in front of the delegation                           */
/* ------------------------------------------------------------------ */

describe('ArkBondStaking', () => {
  /**
   * Scenario report part 3's shape — a bond far larger than the book requires —
   * run to a conditional release, so the bond owes principal to its holders and
   * holds the balance to pay it. Everything else it may part with is placed and
   * deployed.
   */
  async function owingBook() {
    const ctx = await F.deployBondStack();
    await F.anchor(ctx, { notional: 200n * F.ONE });
    const first = (BigInt(ctx.chain.timestamp) + BigInt(30 * DAY)) / BigInt(EPOCH) + 1n;
    await F.subscribe(ctx, { class_: F.CLASS.JUNIOR, value: 2_000_000n * F.ONE });
    await F.distributeDue(ctx);
    await F.deliverAndDistribute(ctx, first, 100n * F.ONE);
    F.toNextEpoch(ctx);
    F.toNextEpoch(ctx);
    await F.distributeDue(ctx);
    await ctx.attest.send('seal', [F.epochNow(ctx) - 1n, '0x' + 'ab'.repeat(32)]);
    await ctx.bond.send('conditionalRelease');
    const free = await ctx.bond.call('unencumbered');
    await ctx.bond.send('placeWithStaking', [free]);
    await ctx.delegation.send('deployIdle', [free]);
    return ctx;
  }

  /**
   * The bond, its staking contract, the pool, and the REAL delegation behind the
   * pool on the genesis deposit contract: `deployBondStack` in full, with the
   * delegation moved to the address the qrysm deposits name instead of
   * `MockDelegation`. The pool is the delegation's counterparty, at a
   * concentration bound of 10,000 bps: one validator may be the whole pool.
   */
  async function realStack() {
    const chain = await Chain.create();
    const admin = ACCOUNTS.admin;
    for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 30n);
    await chain.installCode(DEPOSIT_CONTRACT, snapshot.code, snapshot.storage);

    const params = await F.deployParams(chain, { governance: admin, deployer: admin });
    const registry = await chain.deploy('ArkStakeRegistry', ['address', 'address', 'address'], [admin, params.address, admin]);
    await params.send('setRegistry', [registry.address], { from: admin });
    const attest = await chain.deploy('MockAttestationResealable');
    const qday = await chain.deploy('MockQDayOracle');
    const oracle = await chain.deploy('MockPriceOracle');
    const ledger = await chain.deploy('ProceedsLedger');
    const coupon = await chain.deploy('ArkBondCoupon', ['address', 'address', 'address'], [params.address, ledger.address, registry.address]);
    const bond = await F.deployBond(chain, [registry.address, params.address, coupon.address, qday.address, attest.address], admin);
    await coupon.send('setBond', [bond.address], { from: admin });
    await ledger.send('setBond', [coupon.address], { from: admin });
    await registry.send('setDependencies', [attest.address, qday.address, oracle.address, bond.address], { from: admin });
    const court = await chain.deploy('MockDisputeCourt', ['address'], [bond.address]);
    await bond.send('setCourt', [court.address], { from: admin });
    const staking = await chain.deploy('ArkBondStaking', ['address'], [bond.address]);
    await bond.send('setStaking', [staking.address], { from: admin });
    const pool = await chain.deploy('ArkStakingPool');
    const deployed = await chain.deploy(
      'ArkBondDelegation',
      ['address', 'address', 'address', 'address', 'address', 'uint256', 'uint256'],
      [pool.address, admin, DEPOSIT_CONTRACT, params.address, attest.address, 10_000n, 0n],
    );
    const delegation = await chain.relocate(deployed, deposits.delegationAddress, [0, 1]);
    await pool.send('setDelegation', [delegation.address], { from: admin });
    await staking.send('setVenue', [pool.address], { from: admin });

    await oracle.send('set', [F.REF_PRICE, F.REF_PRICE, F.REF_PRICE]);
    await oracle.send('setYield', [0n, F.ZERO, F.BOOK_YIELD_BPS]);
    for (const a of [{ asset: F.ASSET_A, group: F.GROUP_A }, { asset: F.ASSET_B, group: F.GROUP_B }]) {
      await registry.send('admitAsset', [F.assetInput(a)], { from: admin });
    }
    return withViews({ chain, params, attest, bond, staking, pool, delegation });
  }

  describe('bond principal earns at real validators through the pool, from a single validator\'s stake', () => {
    test('40,000 QRL of bond principal funds a validator: the pool, not the bond, carries the concentration bound', async () => {
      const ctx = await realStack();
      await F.subscribe(ctx, { class_: F.CLASS.JUNIOR, value: 40_000n * F.ONE });
      await ctx.bond.send('placeWithStaking', [40_000n * QRL]);
      assert.equal(await ctx.delegation.call('principal'), 40_000n * QRL);
      assert.equal(await ctx.delegation.call('CONCENTRATION_BPS'), 10_000n);
      await funded(ctx);
      assert.equal(await ctx.delegation.call('delegated'), VALIDATOR);
    });

    test('a validator\'s rewards reach the holders as the staking distribution, through the pool', async () => {
      const ctx = await realStack();
      await F.subscribe(ctx, { class_: F.CLASS.JUNIOR, value: 40_000n * F.ONE });
      await ctx.bond.send('placeWithStaking', [40_000n * QRL]);
      await funded(ctx);
      // The beacon chain skims the balance above 40,000 to the credentials.
      await ctx.chain.credit(ctx.delegation.address, 12n * QRL);
      await report(ctx, deposits.ours[0], STATUS.active, 12n * QRL);
      await ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory });
      const value = await ctx.pool.call('positionValue', [ctx.staking.address]);
      assert.ok(value > 40_000n * QRL, 'the position is worth its principal and its reward');
      const res = await ctx.staking.send('harvest', [], { from: ACCOUNTS.mallory });
      const [h] = ctx.staking.events(res, 'Harvested');
      await ctx.staking.send('claim', [h.args.requestId], { from: ACCOUNTS.mallory });
      assert.ok((await ctx.bond.call('state')).freePool >= 12n * QRL - 10n ** 6n);
      assert.equal(await ctx.bond.call('placedWithStaking'), 40_000n * QRL, 'the reward is not principal');
    });
  });

  describe('a loss at staking reaches the book before any payout prices it (D7)', () => {
    test('a validator closing short is a loss to every holding, booked by syncLoss and by every payout first', async () => {
      const ctx = await realStack();
      await F.subscribe(ctx, { class_: F.CLASS.JUNIOR, value: 1_000_000n * F.ONE });
      await ctx.bond.send('placeWithStaking', [400_000n * QRL]);
      assert.equal(await ctx.delegation.call('principal'), 400_000n * QRL);
      await funded(ctx);

      await ctx.chain.credit(ctx.delegation.address, 39_000n * QRL);
      const res = await report(ctx, deposits.ours[0], STATUS.done, 39_000n * QRL);
      assert.equal(ctx.delegation.events(res, 'StakeLost')[0].args.loss, 1_000n * QRL);
      const sync = await ctx.staking.send('syncLoss');
      const lost = ctx.staking.events(sync, 'LossRecorded')[0].args.amount;
      assert.ok(lost >= 1_000n * QRL && lost - 1_000n * QRL < 10n);
      assert.ok((await ctx.bond.call('outstandingPrincipal')) <= 999_000n * QRL);

      // Idempotent: nothing is left to record, and a second call records nothing.
      const again = await ctx.staking.send('syncLoss');
      assert.equal(ctx.staking.events(again, 'LossRecorded').length, 0);
    });

    test('a forfeited operator bond reaches the holders as distribution, through the pool, at the validator\'s close', async () => {
      const ctx = await realStack();
      await F.subscribe(ctx, { class_: F.CLASS.JUNIOR, value: 1_000_000n * F.ONE });
      await ctx.bond.send('placeWithStaking', [400_000n * QRL]);
      await funded(ctx);
      await report(ctx, deposits.ours[0], STATUS.slashed, 0n, { slashed: true });
      // Held until the close, where the loss it answers for is known (OC-LEGB-03): nothing to harvest yet.
      await assert.rejects(() => ctx.staking.send('harvest'), /NothingToHarvest/);
      await ctx.chain.credit(ctx.delegation.address, VALIDATOR);
      await report(ctx, deposits.ours[0], STATUS.done, VALIDATOR, { slashed: true });
      const res = await ctx.staking.send('harvest');
      const [h] = ctx.staking.events(res, 'Harvested');
      const before = await ctx.chain.balanceOf(ctx.bond.address);
      const claimed = await ctx.staking.send('claim', [h.args.requestId]);
      const got = ctx.staking.events(claimed, 'Distributed')[0].args.amount;
      assert.ok(got <= OPERATOR_BOND && OPERATOR_BOND - got < 10n ** 6n, `forfeit reached ${got}`);
      assert.equal((await ctx.chain.balanceOf(ctx.bond.address)) - before, got);
      assert.equal(await ctx.bond.call('outstandingPrincipal'), 1_000_000n * QRL, 'a forfeit is not principal');
    });
  });

  describe('principal is recalled, and an exit asked for, only under a real shortfall (D5)', () => {
    test('no recall while the bond itself holds the principal it owes', async () => {
      const ctx = await owingBook();
      assert.ok((await ctx.bond.call('principalOwedNow')) > 0n, 'the release is owed');
      assert.equal(await ctx.bond.call('unencumbered'), 0n);
      await assert.rejects(() => ctx.staking.send('recall', [F.ONE]), /NoShortfall/);
    });

    test('a maturity the bond can pay from its own balance asks nothing of staking', async () => {
      const ctx = await F.deployBondStack({ stage: 4 });
      const id = await F.subscribe(ctx, { term: F.TERM.QUARTER, value: 100_000n * F.ONE });
      const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
      F.toEpoch(ctx, m + 1n);
      await F.distributeDue(ctx);
      assert.equal(await ctx.bond.call('principalOwedNow'), 100_000n * F.ONE);
      await assert.rejects(() => ctx.staking.send('recall', [F.ONE]), /NoShortfall/);
    });

    test('a real shortfall is recalled; the pool asks for exits, each counting toward the next', async () => {
      // A quarter-term holding matures into a gate closed by the fourth stage:
      // queued principal is owed, and every wei of it is deployed at validators.
      const ctx = await F.deployBondStack({ stage: 4 });
      const id = await F.subscribe(ctx, { term: F.TERM.QUARTER, value: 100_000n * F.ONE });
      await ctx.bond.send('placeWithStaking', [100_000n * F.ONE]);
      await ctx.delegation.send('deployIdle', [100_000n * F.ONE]);
      const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
      F.toEpoch(ctx, m + 1n);
      await F.distributeDue(ctx);
      assert.equal(await ctx.bond.call('principalOwedNow'), 100_000n * F.ONE);

      await ctx.staking.send('recall', [100_000n * F.ONE]);
      await assert.rejects(() => ctx.staking.send('recall', [F.ONE]), /NoShortfall/, 'principal on its way back counts');
      // Nothing idle at the pool: three exits of 40,000 cover 100,000, and a fourth is refused.
      // The third leaves a shortfall of exactly half a stake (20,000), which still asks (OC-LEGB-04).
      for (let i = 1; i <= 3; i++) await ctx.pool.send('requestExit', []);
      assert.equal(await ctx.delegation.call('exitsPending'), 100_000n * F.ONE);
      await assert.rejects(() => ctx.pool.send('requestExit', []), /NoShortfall/);
    });
  });
});

describe('receipts before a report are forwarded only up to the reward cap (I32)', () => {
  const YEAR = 365n * BigInt(DAY);
  const capFor = (validators, rMaxBps = 1000n) => (validators * VALIDATOR * rMaxBps * BigInt(EPOCH)) / (10_000n * YEAR);

  test('the cap is activeValidators * VALIDATOR_STAKE * r_max * EPOCH / YEAR, truncated', async () => {
    const ctx = await fixture({ fundWith: 400_000n * QRL });
    assert.equal(await ctx.delegation.call('rewardCap'), 0n, 'no validator, no cap');
    await funded(ctx);
    assert.equal(await ctx.delegation.call('activeValidators'), 1n);
    assert.equal(await ctx.delegation.call('rewardCap'), capFor(1n));
  });

  test('an epoch forwards what arrived, up to its cap, and the cap does not carry forward', async () => {
    const ctx = await fixture({ fundWith: 400_000n * QRL });
    await funded(ctx);
    const cap = capFor(1n);
    await assert.rejects(() => ctx.delegation.send('distributeProvisional', [], { from: ACCOUNTS.mallory }), /NothingToDistribute/);
    // A beacon withdrawal credits the balance without running code.
    await ctx.chain.credit(ctx.delegation.address, cap * 3n);
    const before = await ctx.chain.balanceOf(BOND);
    await ctx.delegation.send('distributeProvisional', [], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.chain.balanceOf(BOND)) - before, cap, 'no more than the cap, the rest held');
    await assert.rejects(() => ctx.delegation.send('distributeProvisional', [], { from: ACCOUNTS.mallory }), /NothingToDistribute/);
    ctx.chain.advanceTime(EPOCH);
    await ctx.delegation.send('distributeProvisional', [], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.chain.balanceOf(BOND)) - before, 2n * cap, 'one more cap in the next epoch, not two');
    assert.equal(await ctx.delegation.call('idle'), 400_000n * QRL - VALIDATOR, 'principal held here is untouched');
  });

  test('a report that shows a provisional payment was principal writes it off principal, and the venue stays solvent (OC-LEGB-01)', async () => {
    // Before 2026-10-04 the forward stood against later distribution while
    // principal still counted it: the balance fell short of idle + bonds +
    // refunds, and every returnIdle and claimRefund reverted Insolvent.
    const ctx = await fixture({ fundWith: 400_000n * QRL });
    const d = deposits.ours[0];
    await funded(ctx, d);
    const cap = capFor(1n);
    await ctx.chain.credit(ctx.delegation.address, cap);
    await ctx.delegation.send('distributeProvisional', [], { from: ACCOUNTS.mallory });
    // The report: the validator exited, and what came back was principal.
    await report(ctx, d, STATUS.exited, cap);
    assert.equal(await ctx.delegation.call('distributionReconciled'), 0n);
    assert.equal(await ctx.delegation.call('distributed'), 0n, 'the forward is written off, not left standing against distribution');
    assert.equal(await ctx.delegation.call('principal'), 400_000n * QRL - cap, 'the principal it was has left');
    assert.ok((await ctx.chain.balanceOf(ctx.delegation.address)) >= (await owed(ctx)), 'solvent');
    // Fees the report shows as distribution are paid as they come.
    const e = epochOf(ctx);
    await ctx.chain.credit(ctx.delegation.address, cap / 2n);
    await ctx.attest.send('seal', [reportKey(e), feesLeaf(ctx, e, cap / 2n)]);
    await ctx.delegation.send('noteRoot', [e]).catch(() => {});
    await clearWindow(ctx, e);
    await ctx.delegation.send('reconcileFees', [e, cap / 2n, []]);
    const before = await ctx.chain.balanceOf(BOND);
    await ctx.delegation.send('distribute', [], { from: ACCOUNTS.mallory });
    assert.equal((await ctx.chain.balanceOf(BOND)) - before, cap / 2n);
  });
});
