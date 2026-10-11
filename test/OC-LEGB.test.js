/**
 * The OC round's Leg B findings (audit 2026-10-03, docs/review/audit-2026-10-03
 * LEG-B/REPORT.md, PRESCREEN OC-PS-01, FINDINGS.md OC-LEGB-13, LEG-A OC-LEGA-01,
 * ECON OC-ECON-09), each held as the specification states it. Every test is
 * the round's PoC turned round: the exploit the PoC showed succeeding is
 * refused, or its effect is gone.
 *
 * The stacks are the real ArkStakingPool in front of the real
 * ArkBondDelegation on the chain's own genesis deposit contract, with the
 * qrysm deposits of test/fixtures (test/ArkBondDelegation.test.js `realStack`),
 * except where a double is named.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Interface, keccak256, AbiCoder, toUtf8Bytes, getBytes } = require('ethers');
const { Chain, ACCOUNTS } = require('./harness');
const F = require('./stake-fixture');
const snapshot = require('./fixtures/zond-deposit-contract.json');
const deposits = require('./fixtures/zond-deposits.json');

const DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242';
const QRL = 10n ** 18n;
const VALIDATOR = 40_000n * QRL;
const OPERATOR = ACCOUNTS.bob;
const OPERATOR_BOND = 4_000n * QRL;
const DAY = 24 * 60 * 60;
const EPOCH = 7 * DAY;
const YEAR = 365n * BigInt(DAY);
const coder = AbiCoder.defaultAbiCoder();
const REPORT_DOMAIN = keccak256(toUtf8Bytes('ARK_DELEGATION_REPORT_V2'));
const DEPOSIT_CHECK_DOMAIN = keccak256(toUtf8Bytes('ARK_DELEGATION_DEPOSIT_CHECK_V1'));
const MASK = 2n ** 256n - 1n;
const REPORT_KEYSPACE = (BigInt(keccak256(toUtf8Bytes('ARK_DELEGATION_REPORTS_V1'))) << 128n) & MASK;
const DEPOSIT_KEYSPACE = (BigInt(keccak256(toUtf8Bytes('ARK_DELEGATION_DEPOSIT_CHECKS_V1'))) << 128n) & MASK;
const reportKey = (e) => REPORT_KEYSPACE | BigInt(e);
const STATUS = { pending: 0, active: 2, exiting: 3, slashed: 4, exited: 5, exitedSlashed: 6, possible: 7, done: 8 };
const EXIT = keccak256(toUtf8Bytes('a pre-signed voluntary exit, held by the quorum'));
const REPORT_TYPES = ['bytes32', 'address', 'uint256', 'bytes32', 'uint8', 'bool', 'uint64', 'bytes32', 'uint256', 'uint256'];
const depositIface = new Interface([
  'function get_deposit_root() view returns (bytes32)',
  'function get_deposit_count() view returns (bytes)',
]);

const A = ACCOUNTS.alice;
const B = ACCOUNTS.attester;
const MALLORY = ACCOUNTS.mallory;
const near = (x, y, tol = 10n ** 9n) => (x > y ? x - y : y - x) <= tol;
const epochOf = (ctx) => ctx.chain.timestamp / BigInt(EPOCH);

/** The real pool and its real delegation (concentration 10,000 bps), `eligible` epochs to exit eligibility. */
async function poolStack({ attestation = 'MockAttestationResealable', eligible = 0n } = {}) {
  const chain = await Chain.create();
  for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 30n);
  await chain.installCode(DEPOSIT_CONTRACT, snapshot.code, snapshot.storage);
  const params = await F.deployParams(chain);
  const attest = await chain.deploy(attestation);
  const pool = await chain.deploy('ArkStakingPool');
  const deployed = await chain.deploy(
    'ArkBondDelegation',
    ['address', 'address', 'address', 'address', 'address', 'uint256', 'uint256'],
    [pool.address, ACCOUNTS.admin, DEPOSIT_CONTRACT, params.address, attest.address, 10_000n, eligible],
  );
  const delegation = await chain.relocate(deployed, deposits.delegationAddress, [0, 1]);
  await pool.send('setDelegation', [delegation.address], { from: ACCOUNTS.admin });
  return withHelpers({ chain, params, attest, pool, delegation, value: (w) => pool.call('positionValue', [w]) });
}

function withHelpers(ctx) {
  ctx.depositView = async (fn) => {
    const res = await ctx.chain.execute(DEPOSIT_CONTRACT, ACCOUNTS.admin, depositIface.encodeFunctionData(fn), 0n, true);
    return depositIface.decodeFunctionResult(fn, res.returnValue)[0];
  };
  ctx.depositCount = async () => getBytes(await ctx.depositView('get_deposit_count')).reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return ctx;
}

const checkLeaf = (ctx, d, root) =>
  keccak256(coder.encode(['bytes32', 'address', 'bytes32', 'bytes32'], [DEPOSIT_CHECK_DOMAIN, ctx.delegation.address, keccak256(d.pubkey), root]));
const admit = (ctx, d) => ctx.delegation.send('admitValidator', [d.pubkey, d.deposit_data_root, EXIT, OPERATOR], { from: ACCOUNTS.admin, value: OPERATOR_BOND });

/** The relayer's funding steps: the check sealed at the deposit-check key, then `delegate`. */
async function fundValidator(ctx, d = deposits.ours[0]) {
  await admit(ctx, d);
  const root = await ctx.depositView('get_deposit_root');
  const key = await ctx.delegation.call('depositCheckKey');
  await ctx.attest.send('seal', [key, checkLeaf(ctx, d, root)]);
  await ctx.delegation.send('delegate', [d.pubkey, d.signature, root, []], { from: MALLORY });
  return keccak256(d.pubkey);
}

function reportOf(e, d, status, withdrawn, { slashed = false, exitInitiated } = {}) {
  const init = exitInitiated ?? (status >= STATUS.exiting ? e : 0n);
  return [e, keccak256(d.pubkey), status, slashed, init, keccak256(d.withdrawal_credentials), VALIDATOR, withdrawn];
}
const leafOf = (ctx, r) => keccak256(coder.encode(REPORT_TYPES, [REPORT_DOMAIN, ctx.delegation.address, ...r]));

/** Seal a one-line report for the epoch in progress, note it, let its window pass, apply it. */
async function report(ctx, d, status, withdrawn, opts = {}) {
  const e = epochOf(ctx);
  const r = reportOf(e, d, status, withdrawn, opts);
  await ctx.attest.send('seal', [reportKey(e), leafOf(ctx, r)]);
  await ctx.delegation.send('noteRoot', [e]);
  const clears = await ctx.delegation.call('reportClearsAt', [e]);
  if (clears > ctx.chain.timestamp) ctx.chain.advanceTime(Number(clears - ctx.chain.timestamp));
  return ctx.delegation.send('reconcile', [r, []], { from: MALLORY });
}

/** What ranks ahead of distribution, and distribution cleared and unpaid: the venue solvency predicate. */
async function solvent(ctx) {
  const c = (n) => ctx.delegation.call(n);
  const rec = await c('distributionReconciled');
  const dist = await c('distributed');
  const owed = (await c('idle')) + (await c('bondsHeld')) + (await c('refundsOwed')) + (rec > dist ? rec - dist : 0n);
  return (await ctx.chain.balanceOf(ctx.delegation.address)) >= owed;
}

describe('OC-LEGB-01 (QL-11): exited principal is never forwarded as distribution, and the venue stays solvent', () => {
  test('a provisional forward the report shows was principal is written off principal: withdrawals and refunds still pay, the pool counts it once', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 80_000n * QRL });
    const d = deposits.ours[0];
    await fundValidator(ctx, d);
    F.toNextEpoch(ctx);
    await ctx.pool.send('roll', [], { from: A });

    // The validator exits on its own and the sweep lands before any report: the cap is forwarded (I32).
    await ctx.chain.credit(ctx.delegation.address, VALIDATOR);
    const cap = (VALIDATOR * 1000n * BigInt(EPOCH)) / (10_000n * YEAR);
    const fwd = await ctx.delegation.send('distributeProvisional', [], { from: MALLORY });
    assert.equal(ctx.delegation.events(fwd, 'ProvisionallyDistributed')[0].args.amount, cap);

    await report(ctx, d, STATUS.done, VALIDATOR);
    assert.ok(await solvent(ctx), 'balance >= idle + bonds + refunds + reconciled-unpaid');
    assert.equal(await ctx.delegation.call('distributed'), 0n, 'the forward no longer stands as distributed-not-reconciled');
    assert.equal(await ctx.delegation.call('principal'), 80_000n * QRL - cap, 'the principal forwarded is written off');
    assert.ok(near(await ctx.pool.call('totalValue'), 80_000n * QRL), 'the pool counts the forward once: 80,000, not 80,000 + the forward');

    const shares = await ctx.pool.call('sharesOf', [A]);
    await ctx.pool.send('requestWithdrawal', [shares / 4n], { from: A });
    assert.equal(await ctx.pool.call('queueHead'), 1n, 'a withdrawal needing idle principal settles');
    await ctx.delegation.send('claimRefund', [], { from: OPERATOR });
  });

  test('stake asked to exit, or reported exiting, is held ahead of the provisional forward', async () => {
    const ctx = await poolStack();
    await ctx.pool.send('deposit', [], { from: A, value: 80_000n * QRL });
    const [d0, d1] = deposits.ours;
    await fundValidator(ctx, d0);
    await fundValidator(ctx, d1);
    F.toNextEpoch(ctx);
    await ctx.pool.send('roll', [], { from: A });
    // The second validator is slashed: a report shows it exiting, nobody asked.
    await report(ctx, d1, STATUS.slashed, 0n, { slashed: true });
    assert.equal(await ctx.delegation.call('exitsPending'), VALIDATOR, 'reported exiting: its stake is on its way home');
    // Its sweep arrives: none of it is forwarded.
    await ctx.chain.credit(ctx.delegation.address, 30_000n * QRL);
    await assert.rejects(() => ctx.delegation.send('distributeProvisional', [], { from: MALLORY }), /NothingToDistribute/);
    // A reward above the pending stake still goes, up to the cap.
    await ctx.chain.credit(ctx.delegation.address, 15_000n * QRL);
    const fwd = await ctx.delegation.send('distributeProvisional', [], { from: MALLORY });
    assert.ok(ctx.delegation.events(fwd, 'ProvisionallyDistributed')[0].args.amount > 0n);
    assert.ok(await solvent(ctx));
  });
});

describe('OC-LEGB-02 (QL-12): the deposit check has a keyspace of its own', () => {
  test('on the write-once verifier two validators are funded in one epoch, and that epoch\'s report is still sealed and reconciled', async () => {
    const ctx = await poolStack({ attestation: 'MockAttestation' });
    await ctx.pool.send('deposit', [], { from: A, value: 80_000n * QRL });
    const [d0, d1] = deposits.ours;
    const e = epochOf(ctx);
    assert.equal(await ctx.delegation.call('DEPOSIT_KEYSPACE'), DEPOSIT_KEYSPACE);
    assert.equal(await ctx.delegation.call('depositCheckKey'), DEPOSIT_KEYSPACE | (await ctx.depositCount()));
    await fundValidator(ctx, d0);
    await fundValidator(ctx, d1);
    assert.equal(epochOf(ctx), e, 'both in one epoch');
    assert.equal(await ctx.delegation.call('activeValidators'), 2n);
    assert.equal(await ctx.attest.call('rootOf', [reportKey(e)]), '0x' + '00'.repeat(32), 'no check occupies the report key');
    const res = await report(ctx, d0, STATUS.active, 0n);
    assert.equal(ctx.delegation.events(res, 'Reconciled').length, 1, 'the funding epoch\'s report is sealed and applied');
  });
});

/** Two holders of 40,000 each; one validator slashed, its report cleared; optionally A asks to leave before the close. */
async function slashedPool({ earlyExit }) {
  const ctx = await poolStack();
  await ctx.pool.send('deposit', [], { from: A, value: 40_000n * QRL });
  await ctx.pool.send('deposit', [], { from: B, value: 40_000n * QRL });
  const d = deposits.ours[0];
  await fundValidator(ctx, d);
  F.toNextEpoch(ctx);
  await ctx.pool.send('roll', [], { from: A });
  await ctx.pool.send('roll', [], { from: B });
  const r1 = await report(ctx, d, STATUS.slashed, 0n, { slashed: true });
  assert.equal(ctx.delegation.events(r1, 'BondForfeited')[0].args.reason, 1n, 'forfeited at the slashing report');
  assert.equal(await ctx.delegation.call('slashedOpen'), 1n);
  assert.ok(near(await ctx.value(A), 40_000n * QRL), 'held at the delegation: no share is raised by the forfeit before the loss is known');
  let id = null;
  if (earlyExit) {
    const res = await ctx.pool.send('requestWithdrawal', [await ctx.pool.call('sharesOf', [A])], { from: A });
    id = ctx.pool.events(res, 'WithdrawalRequested')[0].args.requestId;
    assert.equal(ctx.pool.events(res, 'WithdrawalSettled').length, 0, 'bunker: nothing settles while the slashed validator is open');
    await ctx.pool.send('settle', [8n], { from: MALLORY });
    assert.equal(await ctx.pool.call('withdrawalAmount', [id]), 0n);
  }
  ctx.chain.advanceTime(5 * EPOCH);
  await ctx.chain.credit(ctx.delegation.address, 30_000n * QRL);
  const r2 = await report(ctx, d, STATUS.done, 30_000n * QRL, { slashed: true });
  assert.equal(ctx.delegation.events(r2, 'StakeLost')[0].args.loss, 10_000n * QRL);
  assert.equal(await ctx.delegation.call('slashedOpen'), 0n);
  assert.equal(await ctx.delegation.call('bondsHeld'), 0n, 'the held forfeit is paid at the close');
  await ctx.pool.send('settle', [8n], { from: MALLORY });
  const a = earlyExit ? await ctx.pool.call('withdrawalAmount', [id]) : await ctx.value(A);
  return { a, b: await ctx.value(B) };
}

describe('OC-LEGB-03 (QL-13): a slashing forfeit is held to the close; the pool settles nothing while one is open', () => {
  test('a holder who asks to leave between the slashing report and the close bears its share of the loss, net of the forfeit', async () => {
    const control = await slashedPool({ earlyExit: false });
    const run = await slashedPool({ earlyExit: true });
    // 80,000 - 10,000 + 4,000, split evenly, whoever asked to leave.
    assert.ok(near(control.a, 37_000n * QRL) && near(control.b, 37_000n * QRL));
    assert.ok(near(run.a, 37_000n * QRL), `A leaves with ${run.a}`);
    assert.ok(near(run.b, 37_000n * QRL), `B keeps ${run.b}`);
  });

  test('the bunker reads the delegation: a request waits while slashedOpen is non-zero (double)', async () => {
    const chain = await Chain.create();
    for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 27n);
    const pool = await chain.deploy('ArkStakingPool');
    const delegation = await chain.deploy('MockDelegation', ['address'], [pool.address]);
    await pool.send('setDelegation', [delegation.address], { from: ACCOUNTS.admin });
    await pool.send('deposit', [], { from: A, value: 10_000n * QRL });
    F.toNextEpoch({ chain });
    await delegation.send('setSlashedOpen', [1n]);
    const res = await pool.send('requestWithdrawal', [(await pool.call('sharesOf', [A])) / 2n], { from: A });
    assert.equal(pool.events(res, 'WithdrawalSettled').length, 0);
    await delegation.send('setSlashedOpen', [0n]);
    await pool.send('settle', [8n]);
    assert.equal(await pool.call('queueHead'), 1n);
  });
});

describe('OC-LEGB-04 (QL-14): an exit is forced only by half a stake of shortfall, on the oldest validator, with a deadline it can meet', () => {
  test('a dust shortfall forces nothing; the pool names no validator; the deadline runs from exit eligibility', async () => {
    const ELIGIBLE = 6n;
    const ctx = await poolStack({ eligible: ELIGIBLE });
    assert.equal(await ctx.delegation.call('ELIGIBLE_EPOCHS'), ELIGIBLE);
    await ctx.pool.send('deposit', [], { from: A, value: 80_000n * QRL });
    const [d0, d1] = deposits.ours;
    const first = await fundValidator(ctx, d0);
    const funded = epochOf(ctx);
    F.toNextEpoch(ctx);
    await fundValidator(ctx, d1);
    await ctx.pool.send('roll', [], { from: A });
    const before = await ctx.value(A);

    await ctx.pool.send('requestWithdrawal', [10n ** 9n], { from: A });
    await assert.rejects(() => ctx.pool.send('requestExit', [], { from: MALLORY }), /NoShortfall/, 'a dust request forces no exit');
    // Half a stake of shortfall: an exit, of the oldest validator.
    await ctx.pool.send('requestWithdrawal', [(await ctx.pool.call('sharesOf', [A])) / 4n + 1n], { from: A });
    const res = await ctx.pool.send('requestExit', [], { from: MALLORY });
    const [ev] = ctx.delegation.events(res, 'ExitRequested');
    assert.equal(ev.args.pubkeyHash, first, 'the delegation picks its oldest validator');
    const requested = epochOf(ctx);
    const X = BigInt((await ctx.params.call('params')).exitDeadlineEpochs);
    const deadline = await ctx.delegation.call('exitDeadlineEpoch', [first]);
    assert.equal(deadline, funded + ELIGIBLE + X, 'max(request, funded + ELIGIBLE_EPOCHS) + exitDeadlineEpochs');
    assert.ok(deadline > requested + X);

    // Past the request's own two epochs, still active and not yet eligible: no forfeit.
    ctx.chain.advanceTime(Number(X) * EPOCH);
    const r = await report(ctx, d0, STATUS.active, 0n);
    assert.equal(ctx.delegation.events(r, 'BondForfeited').length, 0, 'no forfeit for a deadline before the validator could exit');
    assert.ok((await ctx.value(A)) < before + 1n * QRL, 'the forcing holder collects no operator bond');
    // At its true deadline the operator who has not exited does forfeit.
    while (epochOf(ctx) < deadline) F.toNextEpoch(ctx);
    const late = await report(ctx, d0, STATUS.active, 0n);
    assert.equal(ctx.delegation.events(late, 'BondForfeited')[0].args.reason, 2n);
  });
});

describe('OC-LEGB-05 and OC-ECON-09: the parameter set\'s history and the queue relation', () => {
  test('a diff executed in the epoch the previous one took effect leaves the epoch before reading the set in force in it', async () => {
    const chain = await Chain.create();
    const params = await F.deployParams(chain);
    const ctx = { chain };
    const e0 = epochOf(ctx);
    await F.voteParams(params, { seniorCouponBps: 0, runoffTriggerBps: 2000 });
    F.toNextEpoch(ctx);
    await F.voteParams(params, { jurorSlashBps: 2000 });
    assert.equal(await params.call('seniorCouponBpsAt', [e0]), 100n, 'e0 still reads the set in force in e0');
    assert.equal((await params.call('runoffParamsAt', [e0]))[0], 2500n);
    assert.equal(await params.call('seniorCouponBpsAt', [e0 + 1n]), 0n, 'e0 + 1 reads diff A');
    assert.equal((await params.call('runoffParamsAt', [e0 + 1n]))[0], 2000n);
    F.toNextEpoch(ctx);
    assert.equal(await params.call('seniorCouponBpsAt', [e0 + 2n]), 0n, 'B changed nothing the coupon reads');
    assert.equal(BigInt((await params.call('params')).jurorSlashBps), 2000n);
  });

  test('8 x decay >= BPS - floor holds at the corner of the ranges and is part of every check', async () => {
    const chain = await Chain.create();
    // The corner: decay 1,000, floor 2,000 (8,000 = 10,000 - 2,000) is accepted.
    const params = await F.deployParams(chain, { params: { queueDecayBps: 1000, queueExposureFloorBps: 2000 } });
    const p = await params.call('params');
    assert.equal(BigInt(p.queueDecayBps) * 8n >= 10_000n - BigInt(p.queueExposureFloorBps), true);
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'contracts', 'ArkStakeParamsChecks.hyp'), 'utf8');
    assert.match(src, /_relation\("8 x decay >= BPS - floor"/);
  });
});

describe('OC-LEGB-07: principal in flight is valued at its locked shares', () => {
  test('a loss on shares locked in a recall reaches syncLoss before the claim, and a recall records no more than its shares are worth', async () => {
    const ctx = await F.deployBondStack({ stage: 4 });
    const id = await F.subscribe(ctx, { term: F.TERM.QUARTER, value: 100_000n * F.ONE });
    await ctx.bond.send('placeWithStaking', [100_000n * F.ONE]);
    await ctx.delegation.send('deployIdle', [100_000n * F.ONE]);
    const m = (await ctx.bond.call('holdingOf', [id])).maturityEpoch;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    // A loss before the recall: the shares held are worth 90,000, and the recall records that, not 100,000.
    await ctx.delegation.send('loseStake', [10_000n * F.ONE]);
    const res = await ctx.staking.send('recall', [100_000n * F.ONE]);
    const [rq] = ctx.staking.events(res, 'Requested');
    assert.ok(rq.args.amount <= 90_000n * F.ONE && rq.args.amount > 89_999n * F.ONE, `recorded ${rq.args.amount}`);
    assert.equal(await ctx.staking.call('principalInFlight'), rq.args.amount);
    const booked = await ctx.staking.send('syncLoss');
    const lost0 = ctx.staking.events(booked, 'LossRecorded')[0].args.amount;
    assert.ok(near(lost0, 10_000n * F.ONE, F.ONE / 1000n));
    // A loss on the locked shares, while the request waits, reaches syncLoss now.
    await ctx.delegation.send('loseStake', [9_000n * F.ONE]);
    const again = await ctx.staking.send('syncLoss');
    const lost1 = ctx.staking.events(again, 'LossRecorded')[0].args.amount;
    assert.ok(near(lost1, 9_000n * F.ONE, F.ONE / 1000n), `in-flight loss booked: ${lost1}`);
    assert.ok((await ctx.staking.call('principalSharesInFlight')) > 0n);
  });
});

describe('OC-LEGB-08: buffer reports are kept per escrow', () => {
  test('two escrows of one asset sum, and neither replaces the other', async () => {
    const ctx = await F.deployStack();
    const E1 = F.ESCROW;
    const E2 = '0x' + 'e2'.repeat(20);
    const e = F.epochNow(ctx);
    const send = async (escrow, units, epoch = e) => {
      await ctx.attest.send('seal', [epoch, F.bufferLeaf(F.CHAIN_ID, F.ASSET_A, epoch, units, escrow)]);
      return ctx.registry.send('recordBuffer', [F.CHAIN_ID, escrow, F.ASSET_A, epoch, units, []], { from: MALLORY });
    };
    await send(E1, 30n * QRL);
    await send(E2, 12n * QRL);
    assert.equal(await ctx.registry.call('bufferOrig'), 42n * QRL, 'summed, not overwritten');
    const key = await ctx.registry.call('assetKey', [F.CHAIN_ID, F.ASSET_A]);
    const [units, at] = await ctx.registry.call('bufferOf', [key]);
    assert.equal(units, 42n * QRL);
    assert.equal(at, e);
    await assert.rejects(() => send(E1, 99n * QRL), /BufferReportNotNewer/, 'the same escrow, the same epoch');
    F.toNextEpoch(ctx);
    await send(E1, 10n * QRL, F.epochNow(ctx));
    assert.equal(await ctx.registry.call('bufferOrig'), 22n * QRL, 'an escrow\'s newer report replaces its own figure only');
  });
});

describe('OC-LEGB-10 / OC-PS-01: a batch converted after a near-total loss keeps every share it minted', () => {
  test('the batch records the full count; its depositor holds what it deposited', async () => {
    const chain = await Chain.create();
    for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 27n);
    const pool = await chain.deploy('ArkStakingPool');
    const delegation = await chain.deploy('MockDelegation', ['address'], [pool.address]);
    await pool.send('setDelegation', [delegation.address], { from: ACCOUNTS.admin });
    await pool.send('deposit', [], { from: A, value: 40_000n * QRL });
    F.toNextEpoch({ chain });
    await pool.send('roll', [], { from: A });
    const sharesA = await pool.call('sharesOf', [A]);
    await delegation.send('deployIdle', [40_000n * QRL]);
    await delegation.send('loseStake', [40_000n * QRL]);
    await pool.send('deposit', [], { from: B, value: 10_000n * QRL });
    F.toNextEpoch({ chain });
    await pool.send('roll', [], { from: B });
    const minted = (await pool.call('totalShares')) - sharesA;
    assert.ok(minted >= 1n << 128n, 'more than uint128 holds');
    assert.ok((await pool.call('sharesOf', [B])) >= minted - 1n, 'B holds the whole batch, not its residue mod 2^128');
    assert.ok(near(await pool.call('positionValue', [B]), 10_000n * QRL, QRL / 1000n));
  });
});

describe('OC-LEGB-11: a caller cannot starve the premium mark of gas', () => {
  test('no gas limit lets instructRelease succeed with the mark skipped', async () => {
    const ctx = await F.deployStack();
    const { id } = await F.anchor(ctx, { notional: 10n * QRL });
    F.toNextEpoch(ctx); // the first touch of a fresh epoch takes its boundary reading
    const data = ctx.registry.iface.encodeFunctionData('instructRelease', [id, A]);
    const full = ctx.chain.gasPool;
    let starved = 0;
    let first = null;
    for (let g = 60_000; g <= 2_000_000 && first === null; g += 1_000) {
      ctx.chain.gasPool = BigInt(g);
      try {
        first = await ctx.chain.execute(ctx.registry.address, A, data);
      } catch (e) {
        if (/MarkStarved/.test(e.message)) starved += 1;
      }
    }
    ctx.chain.gasPool = full;
    assert.ok(first, 'the release goes through with gas enough');
    assert.ok(starved > 0, 'a starved mark is refused (MarkStarved), not skipped');
    const marked = ctx.registry.events(first, 'BoundaryReading').length + ctx.registry.events(first, 'PremiumMarked').length;
    assert.ok(marked > 0, 'the first success took the mark');
  });
});

describe('OC-LEGB-13: a loss the delegation books behind the pool reaches the bond in the same transaction', () => {
  test('the pool passes syncLoss to its listener: PrincipalLost in the reconcile receipt', async () => {
    const chain = await Chain.create();
    const admin = ACCOUNTS.admin;
    for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 30n);
    await chain.installCode(DEPOSIT_CONTRACT, snapshot.code, snapshot.storage);
    const params = await F.deployParams(chain);
    await F.stepToStage(chain, params, 4, admin);
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
    await assert.rejects(() => pool.send('setLossListener', [staking.address], { from: MALLORY }), /OnlyDeployer/);
    await pool.send('setLossListener', [staking.address], { from: admin });
    await assert.rejects(() => pool.send('setLossListener', [staking.address], { from: admin }), /AlreadySet/);
    await oracle.send('set', [F.REF_PRICE, F.REF_PRICE, F.REF_PRICE]);
    await oracle.send('setYield', [0n, F.ZERO, F.BOOK_YIELD_BPS]);
    for (const a of [{ asset: F.ASSET_A, group: F.GROUP_A }, { asset: F.ASSET_B, group: F.GROUP_B }]) {
      await registry.send('admitAsset', [F.assetInput(a)], { from: admin });
    }
    const ctx = withHelpers({ chain, params, attest, bond, staking, pool, delegation });

    await F.subscribe(ctx, { class_: F.CLASS.JUNIOR, value: 1_000_000n * F.ONE });
    await bond.send('placeWithStaking', [400_000n * QRL]);
    await fundValidator(ctx);
    await chain.credit(delegation.address, 39_000n * QRL);
    const res = await report(ctx, deposits.ours[0], STATUS.done, 39_000n * QRL);
    assert.equal(delegation.events(res, 'StakeLost')[0].args.loss, 1_000n * QRL);
    const lost = staking.events(res, 'LossRecorded');
    assert.equal(lost.length, 1, 'the bond\'s staking contract booked the loss in the reconcile transaction');
    assert.ok(lost[0].args.amount >= 1_000n * QRL && lost[0].args.amount - 1_000n * QRL < 10n);
    assert.ok((await bond.call('outstandingPrincipal')) <= 999_000n * QRL);
  });
});

describe('OC-LEGA-01 (QRL half): a censorship-ground claimant is held in the book until its escrow\'s recovery is applied or the hold lapses', () => {
  test('held while the ground stands and the recovery is not applied; free once applied, once lapsed, and for a position anchored after T', async () => {
    const ctx = await F.deployStack();
    // Four positions anchored before T (the harness `call` commits, so each case releases its own).
    const ids = [];
    for (let i = 0n; i < 4n; i++) ids.push((await F.anchor(ctx, { notional: 10n * QRL, nonce: i })).id);
    const T = BigInt(ctx.chain.timestamp) + 60n;
    ctx.chain.advanceTime(120);
    const late = await F.anchor(ctx, { notional: 5n * QRL, nonce: 9n });
    await ctx.bond.send('setClaimants', [2n, T, 0n]);
    await assert.rejects(() => ctx.registry.send('instructRelease', [ids[0], A], { from: A }), /ClaimantHeld/);
    await ctx.registry.send('instructRelease', [late.id, A], { from: A });
    // A declaration ground (1) holds nothing here: a declaration closes releases on its own.
    await ctx.bond.send('setClaimants', [1n, T, 0n]);
    await ctx.registry.send('instructRelease', [ids[1], A], { from: A });
    // Applied: the escrow's ledger has passed slot 0.
    await ctx.bond.send('setClaimants', [2n, T, 1n]);
    await ctx.registry.send('instructRelease', [ids[2], A], { from: A });
    // Lapsed: CLAIMANT_HOLD_EPOCHS after T.
    await ctx.bond.send('setClaimants', [2n, T, 0n]);
    const hold = 24n; // ArkStakeRegistry CLAIMANT_HOLD_EPOCHS (private), equal to the relayer's RECOVERY_HOLD_EPOCHS
    ctx.chain.advanceTime(Number(T + hold * BigInt(EPOCH) - BigInt(ctx.chain.timestamp)) - 1);
    await assert.rejects(() => ctx.registry.send('instructRelease', [ids[3], A], { from: A }), /ClaimantHeld/);
    ctx.chain.advanceTime(1);
    await ctx.registry.send('instructRelease', [ids[3], A], { from: A });
  });

  test('the registry reads the real bond\'s record: no ground, no hold', async () => {
    const ctx = await F.deployBondStack();
    const { id } = await F.anchor(ctx, { notional: 10n * QRL });
    await ctx.registry.send('instructRelease', [id, A], { from: A });
    const c = await ctx.chain.at('ArkCatBondRecovery', ctx.bond.address).call('claimants');
    assert.equal(BigInt(c.ground), 0n);
  });
});
