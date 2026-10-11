/**
 * The reference solver as an independent service (engine/solver.js,
 * bin/solver.js; 2026-09-29): it refuses the relayer's keys on a shared
 * manifest, and it is idempotent across restarts — a quote written before it
 * is sent is resolved against the swap rather than lost or sent twice, and a
 * claim an earlier run landed is recognised rather than retried.
 *
 * Pure logic against fake chains: a swap that keeps PremiumSwap's rules for
 * quote, lotOf, refund and claim, and an origin chain whose relay publishes
 * leaves (D15) and whose escrow pays a lock once. The whole path on the
 * contracts is the e2e scenario `solver-service`.
 */
const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Interface, Wallet } = require('ethers');

const ids = require('../lib/identifiers');
const { clockFor } = require('../lib/epoch');
const { Solver, SolverService, solverKeyNames, keySeparation, relayerQrlAccounts } = require('../engine/solver');
const { fundingPlan, solverFunding, SOLVER_QRL_FUNDING_DEFAULT } = require('../../../scripts/lib/governance');

const ONE = 10n ** 18n;
const acct = (b) => '0x' + b.repeat(20);

/* ------------------------------------------------------------------ keys */

describe('the solver signs from accounts of its own on a shared manifest (2026-09-29)', () => {
  const relayer = {
    qrl: [{ address: acct('11'), label: 'the deployer (the relayer)' }, { address: acct('22'), label: 'the attestation sealer' }],
    origin: [{ address: acct('33'), label: "the relayer's origin-chain account" }],
  };
  const own = { qrl: acct('aa'), origin: acct('bb') };

  test('its own keys pass; the per-chain names win over the shared ones', () => {
    assert.deepEqual(keySeparation({ shared: true, solver: own, relayer, chain: 'hoodi-vps' }).errors, []);
    const names = solverKeyNames({ SOLVER_MNEMONIC: 'x', HOODI_VPS_SOLVER_QRL_MNEMONIC: 'y', HOODI_VPS_SOLVER_PRIVATE_KEY: 'k', HOODI_VPS_SOLVER_MNEMONIC: 'm' }, 'hoodi-vps');
    assert.equal(names.qrlMnemonic, 'HOODI_VPS_SOLVER_QRL_MNEMONIC');
    assert.equal(names.originKey, 'HOODI_VPS_SOLVER_PRIVATE_KEY');
    assert.equal(names.originMnemonic, null, 'a private key wins over a phrase, as for the relayer');
    assert.equal(solverKeyNames({ SOLVER_MNEMONIC: 'x' }, 'hoodi-vps').qrlMnemonic, 'SOLVER_MNEMONIC');
  });

  test("the deployer's, the sealer's or the relayer's origin account is refused, by name", () => {
    for (const [solver, re] of [
      [{ ...own, qrl: acct('11') }, /QRL account is the deployer/],
      [{ ...own, qrl: acct('22') }, /QRL account is the attestation sealer/],
      [{ ...own, origin: acct('33') }, /origin-chain account is the relayer's/],
    ]) {
      const { errors } = keySeparation({ shared: true, solver, relayer, chain: 'hoodi-vps' });
      assert.ok(errors.some((e) => re.test(e)), errors.join('; '));
      assert.ok(errors.some((e) => /ALLOW_SHARED_KEYS=1/.test(e)), 'the override is named');
    }
  });

  test('no key of its own is refused on a shared manifest, and falls back on a local one', () => {
    const shared = keySeparation({ shared: true, solver: {}, relayer, chain: 'hoodi-vps' });
    assert.ok(shared.errors.some((e) => /SOLVER_MNEMONIC/.test(e)));
    assert.ok(shared.errors.some((e) => /HOODI_VPS_SOLVER_PRIVATE_KEY/.test(e)));
    const local = keySeparation({ shared: false, solver: {}, relayer, chain: 'local' });
    assert.deepEqual(local.errors, []);
    assert.deepEqual(local.fallback, { qrl: true, origin: true });
  });

  test('ALLOW_SHARED_KEYS=1 runs it on the relayer\'s accounts knowingly', () => {
    const r = keySeparation({ shared: true, allowShared: true, solver: { qrl: acct('11'), origin: acct('33') }, relayer, chain: 'hoodi-vps' });
    assert.deepEqual(r.errors, []);
  });

  test("unknown relayer accounts cannot be shown distinct, and a declared address must be the key's", () => {
    const blind = keySeparation({ shared: true, solver: own, relayer: { qrl: [], origin: [] }, chain: 'hoodi-vps' });
    assert.ok(blind.errors.some((e) => /DEPLOYER_ADDRESS/.test(e)));
    assert.ok(blind.errors.some((e) => /HOODI_VPS_RELAYER_ADDRESS/.test(e)));
    const wrong = keySeparation({ shared: true, allowShared: true, solver: own, relayer, declared: { qrl: acct('cc') }, chain: 'hoodi-vps' });
    assert.ok(wrong.errors.some((e) => /is not the address of/.test(e)), 'even knowingly: the redeploy would fund another account');
  });

  test('every role the relayer funds counts as the relayer\'s', () => {
    const roles = relayerQrlAccounts({ DEPLOYER_ADDRESS: acct('11'), QDAY_ATTESTERS: `${acct('a1')},${acct('a2')}`, HOODI_VPS_ORACLE_OPERATOR_ADDRESS: acct('44') }, 'hoodi-vps');
    assert.deepEqual(roles.map((r) => r.address), [acct('11'), acct('44'), acct('a1'), acct('a2')]);
  });
});

describe('the CLI refuses with exit status 78 before it builds a client (bin/solver.js check)', () => {
  const { MLDSA87 } = require('@theqrl/wallet.js');
  const bin = path.join(__dirname, '..', 'bin', 'solver.js');
  const m1 = MLDSA87.newWallet().getMnemonic().trim();
  const m2 = MLDSA87.newWallet().getMnemonic().trim();
  const k1 = Wallet.createRandom().privateKey;
  const k2 = Wallet.createRandom().privateKey;
  const run = (vars) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'solver-env-')), 'solver.env');
    const base = { QRL_RPC_URL: 'http://127.0.0.1:8545', HOODI_VPS_RPC_URL: 'http://127.0.0.1:8546' };
    fs.writeFileSync(file, Object.entries({ ...base, ...vars }).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
    const r = spawnSync(process.execPath, [bin, 'check', '--chain', 'hoodi-vps'], { env: { ...process.env, ARK_ENV_FILE: file, ARK_SIGNER: '' }, encoding: 'utf8' });
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    return r;
  };

  test('the QRL key is the deployer\'s', () => {
    const r = run({ DEPLOYER_MNEMONIC: m1, SOLVER_MNEMONIC: m1, HOODI_VPS_PRIVATE_KEY: k1, HOODI_VPS_SOLVER_PRIVATE_KEY: k2 });
    assert.equal(r.status, 78, r.stdout + r.stderr);
    assert.match(r.stderr, /QRL account is the deployer/);
  });

  test("the origin key is the relayer's", () => {
    const r = run({ DEPLOYER_MNEMONIC: m1, SOLVER_MNEMONIC: m2, HOODI_VPS_PRIVATE_KEY: k1, HOODI_VPS_SOLVER_PRIVATE_KEY: k1 });
    assert.equal(r.status, 78, r.stdout + r.stderr);
    assert.match(r.stderr, /origin-chain account is the relayer's/);
  });

  test('no solver key at all', () => {
    const r = run({ DEPLOYER_MNEMONIC: m1, HOODI_VPS_PRIVATE_KEY: k1 });
    assert.equal(r.status, 78, r.stdout + r.stderr);
    assert.match(r.stderr, /SOLVER_MNEMONIC/);
  });

  test('keys of its own, checked against addresses only (the service host holds no relayer key)', () => {
    const relayerOrigin = new Wallet(k1).address;
    const r = run({ DEPLOYER_ADDRESS: acct('11'), SOLVER_MNEMONIC: m2, HOODI_VPS_RELAYER_ADDRESS: relayerOrigin, HOODI_VPS_SOLVER_PRIVATE_KEY: k2 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /accounts of its own/);
  });

  test('ALLOW_SHARED_KEYS=1', () => {
    const r = run({ DEPLOYER_MNEMONIC: m1, SOLVER_MNEMONIC: m1, HOODI_VPS_PRIVATE_KEY: k1, HOODI_VPS_SOLVER_PRIVATE_KEY: k1, ALLOW_SHARED_KEYS: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('the relayer funds the solver at each fresh genesis', () => {
  test('SOLVER_ADDRESS is topped up to SOLVER_QRL_FUNDING, the per-chain value first; none named, nothing planned', () => {
    const me = acct('11');
    const S = acct('5e');
    assert.equal(SOLVER_QRL_FUNDING_DEFAULT, 25_000n);
    const plan = fundingPlan({ env: { SOLVER_ADDRESS: S }, me, chain: 'hoodi-vps' });
    assert.deepEqual(plan.map((p) => [p.address, p.target, p.label]), [[S, 25_000n * ONE, 'reference solver']]);
    assert.equal(solverFunding({ env: { SOLVER_ADDRESS: S, SOLVER_QRL_FUNDING: '10', HOODI_VPS_SOLVER_QRL_FUNDING: '7' }, chain: 'hoodi-vps' }).target, 7n * ONE);
    assert.equal(solverFunding({ env: { SOLVER_ADDRESS: S, HOODI_VPS_SOLVER_QRL_ADDRESS: acct('5f') }, chain: 'hoodi-vps' }).address, acct('5f'));
    assert.deepEqual(fundingPlan({ env: {}, me, chain: 'hoodi-vps' }), []);
    assert.deepEqual(fundingPlan({ env: { SOLVER_ADDRESS: me }, me, chain: 'hoodi-vps' }), [], 'never the deployer itself');
  });
});

/* ------------------------------------------------------------------ fake chains */

const clock = clockFor(600);
const CHAIN_ID = 560048n;
const ASSET = acct('a5');
const ESCROW = acct('e5');
const SWAP = acct('5a');
const RELAY = acct('4e');
const SOLVER_Q = acct('51');
const SOLVER_O = acct('52');
const RESERVE = 3n * ONE; // QRL per share
const relayAbi = new Interface(['event LeavesPublished(uint64 indexed epoch, bytes32[] leaves)']);
const swapErrors = new Interface(['error LotTooSmall(uint256 minimum, uint256 shares)', 'error ExceedsOffer(uint256 shares, uint256 available)', 'error BondMismatch(uint256 required, uint256 supplied)']);
const sha = (...xs) => '0x' + crypto.createHash('sha256').update(xs.map(String).join('|')).digest('hex');
const fail = (name) => Object.assign(new Error(name), { shortMessage: name });

class World {
  constructor() {
    this.genesis = '0x' + '01'.repeat(32);
    this.E = 480_000n;
    this.now = clock.startOf(this.E + 1n) - 300n; // inside the quote window of epoch E - 1's offering
    this.qrlBalance = 10_000n * ONE;
    this.offer = {}; // epoch -> shares it may sell
    this.lots = new Map();
    this.used = new Set();
    this.quotes = 0;
    this.block = 100n;
    this.relayLogs = [];
    this.spent = new Set();
    this.claims = 0;
    this.crash = null; // 'before' | 'after': the next quote send throws, before or after it lands
    this.spentLeaves = new Set();
    // The swap's views read the reserve and the bond rate standing now; the
    // offering's first quote judges the one before it, which may move both
    // (OC-SWAP-03): `judged` false and `afterJudgement` (a reserve per share)
    // set make the views stale until a quote lands, as on the contract.
    this.judged = true;
    this.reserve = RESERVE;
    this.afterJudgement = null;
    this.bondBps = 750n;
    this.raceBond = null; // a bond rate another quote fixes between the solver's read and its call
    // Suspended pricing (yellow paper §4.6, item 123): 'breaker' or 'silent'
    // while no quote has fixed the reserve. A quote is refused without a
    // revert, recorded and refunded; under 'silent' the views revert too.
    this.suspended = null;
    this.refusals = 0;
    this.pendingLogs = [];
  }

  swapCall(method, args, { value = 0n } = {}, dry = true) {
    const [a0] = args;
    switch (method) {
      case 'available':
        return [this.offer[String(args[2])] || 0n];
      case 'required':
        if (this.suspended === 'silent') throw fail('OracleSilent');
        return [BigInt(args[3]) * this.reserve];
      case 'bondFor':
        if (this.suspended === 'silent') throw fail('OracleSilent');
        return [(BigInt(args[3]) * this.bondBps) / 10_000n];
      case 'offeringOf':
        return [{ judged: this.judged, recorded: Boolean(this.offer[String(args[2])]) }];
      case 'timetable':
        return [clock.quoteOpens(a0), clock.quoteCloses(a0), clock.evmExpiry(a0), clock.settlementCloses(a0)];
      case 'lotIdOf':
        return [sha(...args)];
      case 'lotOf':
        return [this.lots.get(a0) || { status: 0n, bond: 0n }];
      case 'quote':
        return [this.quote(args, value, dry)];
      case 'refund':
        return [this.refund(a0, dry)];
      case 'claim':
        return [this.claimQrl(a0, args[1], dry)];
      default:
        throw new Error(`fake swap has no ${method}`);
    }
  }

  quote([, , epoch, shares, hashlock, recipient, lotValue], value, dry) {
    const t = BigInt(epoch);
    if (this.now < clock.quoteOpens(t) || this.now >= clock.quoteCloses(t)) throw fail('OutsideQuoteWindow');
    if (this.used.has(`${hashlock}@${SOLVER_Q}`)) throw fail('HashlockUsed');
    if (this.suspended) {
      if (!dry) {
        this.refusals += 1;
        this.pendingLogs.push({ name: 'QuoteRefused', args: { epoch: t } });
      }
      return '0x' + '00'.repeat(32);
    }
    const avail = this.offer[String(t)] || 0n;
    if (shares > avail) throw fail('ExceedsOffer');
    const least = (avail + 31n) / 32n;
    if (shares < least && shares !== avail) throw fail('LotTooSmall');
    // Any price is accepted (whitepaper §4.7 as revised 2026-09-30); the reserve binds at the selection.
    if (this.raceBond !== null) {
      this.bondBps = this.raceBond;
      this.raceBond = null;
    }
    const bond = (lotValue * this.bondBps) / 10_000n;
    if (value < lotValue + bond) throw Object.assign(fail('BondMismatch'), { data: swapErrors.encodeErrorResult('BondMismatch', [lotValue + bond, value]) });
    const id = sha(hashlock, SOLVER_Q, recipient, shares, lotValue, clock.settlementCloses(t));
    if (dry) return id;
    this.used.add(`${hashlock}@${SOLVER_Q}`);
    if (!this.judged) {
      this.judged = true;
      if (this.afterJudgement !== null) this.reserve = this.afterJudgement;
    }
    this.lots.set(id, { status: 1n, epoch: t, hashlock, recipient, shares: BigInt(shares), value: BigInt(lotValue), bond, qrlExpiry: clock.settlementCloses(t) });
    this.quotes += 1;
    this.qrlBalance -= lotValue + bond;
    return id;
  }

  /** Every quoted lot at or above the reserve the window fixed (the fake's offering never runs short). */
  select(epoch) {
    for (const l of this.lots.values()) if (l.epoch === epoch && l.status === 1n && l.value >= l.shares * this.reserve) l.status = 2n;
  }

  refund(id, dry) {
    const l = this.lots.get(id);
    if (!l) throw fail('NotRefundable');
    let back = 0n;
    if (l.status === 1n && this.now >= clock.quoteCloses(l.epoch)) back = l.value + l.bond;
    else if (l.status === 5n) back = l.value + l.bond; // evicted by a better quote (QL-17): at once
    else if (l.status === 2n && this.now >= l.qrlExpiry) back = l.value;
    else if (l.status === 3n && l.bond !== 0n) back = l.bond;
    else throw fail('NotRefundable');
    if (dry) return true;
    if (l.status !== 3n) l.status = 4n;
    if (l.status === 3n || back === l.value + l.bond) l.bond = 0n;
    this.qrlBalance += back;
    return true;
  }

  claimQrl(id, secret, dry) {
    const l = this.lots.get(id);
    if (!l || l.status !== 2n) throw fail('NotSelected');
    if (ids.hashlockOf(secret) !== l.hashlock) throw fail('WrongPreimage');
    if (this.now >= l.qrlExpiry) throw fail('LotExpired');
    if (!dry) l.status = 3n;
    return true;
  }

  /** The relayer seals the selected lots' locks and publishes the root's leaves (D15). */
  publish(epoch) {
    const leaves = [...this.lots.entries()]
      .filter(([, l]) => l.status === 2n)
      .map(([lotId, l]) => ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET, epoch: l.epoch, lotId, hashlock: l.hashlock, recipient: SOLVER_O, shares: l.shares, bond: l.bond, evmExpiry: clock.evmExpiry(l.epoch) }));
    leaves.push('0x' + 'ff'.repeat(32));
    leaves.sort();
    this.block += 1n;
    const { data, topics } = relayAbi.encodeEventLog(relayAbi.getEvent('LeavesPublished'), [epoch, leaves]);
    this.relayLogs.push({ address: RELAY, blockNumber: this.block, data, topics });
  }

  escrowClaim(args, dry) {
    const [payload, , , secret] = args;
    const l = this.lots.get(payload[0]);
    if (!l || ids.hashlockOf(secret) !== l.hashlock) throw fail('BadProof');
    if (this.spent.has(payload[0])) throw fail('ProofSpent');
    if (this.now >= clock.evmExpiry(l.epoch)) throw fail('LockExpired');
    if (!dry) {
      this.spent.add(payload[0]);
      this.spentLeaves.add(ids.premiumLockLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET, epoch: payload[5], lotId: payload[0], hashlock: payload[1], recipient: payload[2], shares: payload[3], bond: payload[6], evmExpiry: payload[4] }));
      this.claims += 1;
      this.revealed = secret;
    }
    return true;
  }
}

function clients(w) {
  const qrl = {
    kind: 'harness',
    address: SOLVER_Q,
    genesis: async () => ({ hash: w.genesis }),
    code: async () => '0x6000',
    head: async () => ({ latest: w.block, timestamp: w.now }),
    balance: async () => w.qrlBalance,
    call: async (to, abi, method, args, opts = {}) => w.swapCall(method, args, opts, true),
    send: async (to, abi, method, args, opts = {}) => {
      if (method === 'quote' && w.crash === 'before') {
        w.crash = null;
        throw new Error('socket hang up');
      }
      w.swapCall(method, args, opts, false);
      if (method === 'quote' && w.crash === 'after') {
        w.crash = null;
        throw new Error('timeout waiting for the receipt');
      }
      const logs = w.pendingLogs;
      w.pendingLogs = [];
      return { logs };
    },
  };
  const origin = {
    kind: 'evm',
    address: SOLVER_O,
    head: async () => ({ latest: w.block, timestamp: w.now }),
    logs: async (address, from, to) => w.relayLogs.filter((l) => l.blockNumber >= BigInt(from) && l.blockNumber <= BigInt(to)),
    balance: async () => 10n ** 18n,
    call: async (to, abi, method, args) => {
      // The relay's signed leaf count of a root (OL-01), where a test names one.
      if (method === 'leafCounts') {
        if (w.leafCount === undefined) throw new Error('execution reverted');
        return [w.leafCount];
      }
      // The escrow's record of a spent premium lock (OC-SWAP-04).
      if (method === 'isSpent') return [w.spentLeaves.has(args[0])];
      return w.escrowClaim(args, true);
    },
    send: async (to, abi, method, args) => {
      if (w.crashClaim) {
        w.escrowClaim(args, false);
        w.crashClaim = false;
        throw new Error('the process died after the claim was sent');
      }
      return w.escrowClaim(args, false);
    },
  };
  return { qrl, origin };
}

function service(w, dir, { revealBudget = 100n, errors = null, ...extra } = {}) {
  const { qrl, origin } = clients(w);
  const lines = [];
  const s = new SolverService({
    chain: 'fake',
    qrl,
    origin,
    assets: [{ symbol: 'stETH', address: ASSET, escrow: ESCROW }],
    deployment: () => ({ qrl: { PremiumSwap: SWAP }, qrlGenesisHash: w.genesis }),
    makeSolver: (a, swap) => new Solver({ qrl, origin, swap, swapAbi: { parseLog: (l) => (l && l.name ? l : null) }, chainId: CHAIN_ID, escrow: { asset: ASSET, escrow: ESCROW, abi: null }, recipient: SOLVER_O, clock, revealBudget, relay: RELAY, relayAbi, errors, log: (m) => lines.push(m) }),
    clock,
    dir,
    relay: RELAY,
    relayAbi,
    lookbackBlocks: 1000n,
    log: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    ...extra,
  });
  s.lines = lines;
  return s;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'solver-'));

describe('the service follows a lot from quote to bond, and every step survives a restart', () => {
  test('the whole path: quoted once, selected, claimed on the origin chain from the published leaves, carried, bond back', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    const a = service(w, dir);
    await a.tick();
    assert.equal(w.quotes, 1, 'one quote in the window');
    const [lot] = a.state.lots;
    assert.equal(lot.shares, 1000n, 'SOLVER_SHARE_BPS 10,000: the whole offering');
    assert.equal(lot.value, 1000n * RESERVE, 'at the reserve');
    await a.tick();
    assert.equal(w.quotes, 1, 'never twice for one offering');

    // A second process from the same file quotes nothing more either.
    const b = service(w, dir);
    await b.tick();
    assert.equal(w.quotes, 1, 'nor after a restart');

    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    await b.tick();
    assert.equal(w.claims, 0, 'nothing is revealed before the lock is published');
    w.publish(w.E);
    await b.tick();
    assert.equal(w.claims, 1, 'claimed on the origin chain once the lock was among the published leaves');
    assert.equal(w.revealed, lot.secret);

    w.now += 200n; // past the carry delay (half the reveal budget): the relayer did not carry it
    await b.tick();
    assert.equal(w.lots.get(lot.lotId).status, 3n, 'the solver carried its own preimage to QRL');
    await b.tick();
    assert.equal(w.lots.get(lot.lotId).bond, 0n, 'and took its bond back');
    await b.tick();
    assert.equal(b.state.lots.length, 0);
    assert.equal(b.state.done.at(-1).outcome, 'claimed; bond back');
    assert.equal(b.state.done.at(-1).secret, undefined, 'a finished lot keeps no secret');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'solver-status.json'), 'utf8'));
    assert.equal(st.ready, true);
  });

  test('a lot evicted from a full book by a better quote is refunded at once, QRL and bond (QL-17)', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const a = service(w, tmp());
    await a.tick();
    const [lot] = a.state.lots;
    w.lots.get(lot.lotId).status = 5n; // a strictly better quote took its place
    const before = w.qrlBalance;
    await a.tick();
    assert.equal(w.qrlBalance - before, lot.value + lot.bond, 'all of it back, before the quote window closes');
    assert.equal(a.state.lots.length, 0);
    assert.equal(a.state.done.at(-1).outcome, 'evicted by a better quote; QRL and bond back');
  });

  test('a published list whose length is not the root\'s signed leaf count holds no lock: ignored, ALARM (OL-01)', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const a = service(w, tmp());
    await a.tick();
    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    await a.tick();
    w.leafCount = 7n; // the relay signed seven leaves; the event carries two
    w.publish(w.E);
    await a.tick();
    assert.equal(w.claims, 0, 'nothing claimed from a list the relay did not sign');
    assert.ok(a.lines.some((l) => /ALARM/.test(l) && /published 2 leaves for a root of 7/.test(l)), a.lines.join('\n'));
  });

  test('a quote that landed while the process died is found on the swap, with its secret; none is sent twice', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    w.crash = 'after';
    const a = service(w, dir);
    await a.tick();
    assert.equal(w.quotes, 1);
    assert.equal(a.state.lots.length, 0);
    const pending = JSON.parse(fs.readFileSync(path.join(dir, 'solver.json'), 'utf8')).pending;
    assert.ok(pending && pending.secret, 'the quote was on disk, secret included, before it was sent');

    const b = service(w, dir);
    await b.tick();
    assert.equal(w.quotes, 1, 'not quoted again');
    assert.equal(b.state.pending, null);
    assert.equal(b.state.lots.length, 1);
    assert.equal(ids.hashlockOf(b.state.lots[0].secret), w.lots.get(b.state.lots[0].lotId).hashlock, 'the lot that landed is claimable: its secret survived');
  });

  test('a quote that never landed is sent again with the same secret, once', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    w.crash = 'before';
    const a = service(w, dir);
    await a.tick();
    assert.equal(w.quotes, 0);
    const secret = a.state.pending.secret;
    const b = service(w, dir);
    await b.tick();
    assert.equal(w.quotes, 1);
    assert.equal(b.state.lots[0].secret, secret);
    await b.tick();
    assert.equal(w.quotes, 1);
  });

  test('an unresolved quote past its window is dropped: it can no longer land', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    w.crash = 'before';
    await service(w, dir).tick();
    w.now = clock.quoteCloses(t) + 1n;
    const b = service(w, dir);
    await b.tick();
    assert.equal(b.state.pending, null);
    assert.equal(w.quotes, 0);
  });

  test('a claim an earlier run landed is recognised by the escrow\'s refusal, not sent again', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    const a = service(w, dir);
    await a.tick();
    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    w.publish(w.E);
    w.crashClaim = true;
    await a.tick().catch(() => {});
    assert.equal(w.claims, 1);
    const b = service(w, dir);
    await b.tick();
    assert.equal(w.claims, 1, 'not claimed twice');
    assert.equal(b.state.lots[0].claimedOrigin, true, 'ProofSpent after a recorded attempt: the earlier claim landed');
  });

  test('a lot not selected is refunded, bond included; one lapsed is refunded its QRL and forfeits its bond', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    const s = service(w, dir);
    const before = w.qrlBalance;
    await s.tick();
    w.now = clock.quoteCloses(t) + 10n; // nobody selected it
    await s.tick();
    await s.tick();
    assert.equal(w.qrlBalance, before, 'QRL and bond back');
    assert.match(s.state.done.at(-1).outcome, /not selected/);

    const w2 = new World();
    w2.offer[String(t)] = 1000n;
    const s2 = service(w2, tmp());
    await s2.tick();
    const lot = s2.state.lots[0];
    w2.now = clock.quoteCloses(t) + 10n;
    w2.select(t);
    // Never published: no claim; at the QRL expiry the lot's QRL comes back, not its bond.
    w2.now = clock.settlementCloses(t);
    await s2.tick();
    await s2.tick();
    assert.equal(w2.qrlBalance, 10_000n * ONE - lot.bond);
    assert.match(s2.state.done.at(-1).outcome, /forfeited/);
  });

  test('no reveal inside the reveal budget (D12): a lock published too late is not claimed', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    // A budget longer than the profile's margin: a chain slower than the profile was built for.
    const s = service(w, tmp(), { revealBudget: 2_000n });
    await s.tick();
    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    w.publish(w.E);
    w.now = clock.evmExpiry(t) - 10n; // the escrow still pays, but the preimage could not reach QRL in time
    await s.tick();
    assert.equal(w.claims, 0);
    assert.match(s.state.lots[0].refused, /too late to reveal/);
  });

  test('the lot is at least the D4 minimum, at most SOLVER_MAX_LOT_QRL, and within the balance', async () => {
    const t = new World().E - 1n;
    const small = new World();
    small.offer[String(t)] = 3200n;
    const a = service(small, tmp(), { shareBps: 10n });
    await a.tick();
    assert.equal(a.state.lots[0].shares, 100n, 'ceil(3,200 / 32): the swap refuses less (LotTooSmall)');

    const capped = new World();
    capped.offer[String(t)] = 3200n;
    const b = service(capped, tmp(), { maxLotValue: 600n * ONE });
    await b.tick();
    assert.equal(b.state.lots[0].shares, 200n, 'cut to the lot cap');

    const poor = new World();
    poor.offer[String(t)] = 3200n;
    poor.qrlBalance = 100n * ONE;
    const c = service(poor, tmp(), { maxLotValue: null });
    await c.tick();
    assert.equal(poor.quotes, 0, 'what the balance allows is below the D4 minimum: no quote');
    assert.ok(c.lines.some((l) => /no quote for epoch/.test(l)));
  });

  test('OC-SWAP-03: an offering nobody has judged is judged by a one-planck quote first, and the lot is priced from views read after it, so it is selected', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 100n;
    w.judged = false;
    w.afterJudgement = 4n * ONE; // `required` reads 3 until a quote judges the offering before: a success after a failure resets the ladder
    const s = service(w, tmp(), { errors: swapErrors });
    await s.tick();
    assert.equal(w.quotes, 2, 'the judging quote, then the lot');
    const judging = [...w.lots.values()].find((l) => l.value === 1n);
    assert.ok(judging, 'a judging lot of one planck');
    assert.equal(judging.shares, (100n + 31n) / 32n, 'the least lot the swap takes (D4)');
    assert.equal(judging.bond, 0n, 'and the bond the swap computes for one planck: none');
    assert.equal(s.state.lots.length, 1, 'the judging lot is not one the solver follows');
    const [lot] = s.state.lots;
    assert.equal(lot.value, 400n * ONE, 'at the reserve that holds after the judgement, not the stale 300');
    assert.equal(lot.bond, (400n * ONE * 750n) / 10_000n);
    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    assert.equal(w.lots.get(lot.lotId).status, 2n, 'its lot is selected');
    assert.equal(judging.status, 1n, 'the judging lot never is');
    await s.tick();
    assert.equal(w.quotes, 2, 'one judging quote per offering, never another');
  });

  test('yellow paper §4.6 (item 123): under the breaker the judging quote is sent so the refusal is recorded, refunded, and the offering is sat out', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 100n;
    w.judged = false;
    w.suspended = 'breaker';
    const before = w.qrlBalance;
    const s = service(w, tmp(), { errors: swapErrors });
    await s.tick();
    assert.equal(w.refusals, 1, 'one quote sent, refused and recorded');
    assert.equal(w.lots.size, 0, 'no lot');
    assert.equal(s.state.lots.length, 0, 'nothing followed');
    assert.equal(w.qrlBalance, before, 'nothing locked');
    assert.ok(s.lines.some((l) => /the refusal is recorded/.test(l)), s.lines.join('\n'));
    assert.ok(s.lines.some((l) => /no quote for epoch .*PricingSuspended/.test(l)), s.lines.join('\n'));
    await s.tick();
    assert.equal(w.refusals, 1, 'recorded once per offering');
  });

  test('yellow paper §4.6 (item 123): under a silent series the views revert; the judging quote goes without a bond and records the refusal', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 100n;
    w.judged = false;
    w.suspended = 'silent';
    const s = service(w, tmp(), { errors: swapErrors });
    await s.tick();
    assert.equal(w.refusals, 1, 'recorded, though bondFor could not be read');
    assert.equal(w.lots.size, 0);
  });

  test('OC-SWAP-03: an offering already judged is quoted once, without a judging quote', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 100n;
    const s = service(w, tmp(), { errors: swapErrors });
    await s.tick();
    assert.equal(w.quotes, 1);
    assert.ok(![...w.lots.values()].some((l) => l.value === 1n));
  });

  test('OC-SWAP-03: a BondMismatch (the views moved between the read and the call) is read again and the quote sent at what binds', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 100n;
    w.raceBond = 870n; // another quote judges the offering between the solver's read and its call
    const s = service(w, tmp(), { errors: swapErrors });
    await s.tick();
    assert.equal(w.quotes, 1, 'quoted, not skipped as a named refusal');
    const [lot] = s.state.lots;
    assert.equal(lot.bond, (lot.value * 870n) / 10_000n, 'at the bond read again');
    assert.ok(!s.lines.some((l) => /no quote for epoch/.test(l)), s.lines.join('\n'));
  });

  test('OC-SWAP-04: a claim that landed before a crash is read from the escrow after evmExpiry; the preimage is carried and the QRL is never refunded', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    const a = service(w, dir);
    await a.tick();
    const [lot] = a.state.lots;
    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    w.publish(w.E);
    w.crashClaim = true; // the origin claim lands, then the process dies before it records claimedOrigin
    await a.tick().catch(() => {});
    assert.equal(w.claims, 1);

    // Back after the escrow stopped paying the lot, inside the QRL claim margin.
    w.now = clock.evmExpiry(t) + 10n;
    assert.ok(w.now < clock.settlementCloses(t));
    const before = w.qrlBalance;
    const b = service(w, dir);
    await b.tick();
    assert.equal(w.lots.get(lot.lotId).status, 3n, 'carried to QRL: Claimed before its QRL expiry');
    assert.ok(b.lines.some((l) => /claimed on the origin chain by an earlier run/.test(l)), b.lines.join('\n'));
    await b.tick();
    await b.tick();
    assert.equal(b.state.done.at(-1).outcome, 'claimed; bond back');
    assert.equal(w.qrlBalance - before, lot.bond, 'its bond back, never its QRL');
    assert.equal(w.claims, 1, 'never revealed twice');
  });

  test('OC-SWAP-04: a lot the escrow paid is never refunded its QRL, even where the solver is back only after the QRL expiry: ALARM', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    const a = service(w, dir);
    await a.tick();
    const [lot] = a.state.lots;
    w.now = clock.quoteCloses(t) + 10n;
    w.select(t);
    w.publish(w.E);
    w.crashClaim = true;
    await a.tick().catch(() => {});
    w.now = clock.settlementCloses(t) + 10n;
    const before = w.qrlBalance;
    const b = service(w, dir);
    await b.tick();
    await b.tick();
    assert.equal(w.qrlBalance, before, 'nothing refunded to the solver that holds the shares');
    assert.equal(w.lots.get(lot.lotId).status, 2n, 'the lot stays Selected; its bond is forfeited at the expiry');
    const done = b.state.done.at(-1);
    assert.equal(done.lotId, lot.lotId);
    assert.match(done.outcome, /^ALARM: paid on the origin chain/);
    assert.ok(b.lines.some((l) => /ALARM/.test(l) && /NOT refunded/.test(l)), b.lines.join('\n'));
  });

  test('a regenerated QRL chain retires every open lot; the service waits for the leg of the new genesis', async () => {
    const w = new World();
    const t = w.E - 1n;
    w.offer[String(t)] = 1000n;
    const dir = tmp();
    const s = service(w, dir);
    await s.tick();
    assert.equal(s.state.lots.length, 1);
    w.genesis = '0x' + '02'.repeat(32);
    const next = service(w, dir, { deployment: () => ({ qrl: { PremiumSwap: SWAP }, qrlGenesisHash: '0x' + '01'.repeat(32) }) });
    const st = await next.tick();
    assert.equal(st.ready, false);
    assert.match(st.reason, /waiting for the QRL leg/);
    assert.equal(next.state.lots.length, 0);
    assert.match(next.state.done.at(-1).outcome, /regenerated/);
  });

  test('one process per state file', () => {
    const dir = tmp();
    const w = new World();
    const a = service(w, dir).lock();
    fs.writeFileSync(path.join(dir, 'solver.lock'), String(process.ppid || 1));
    assert.throws(() => service(w, dir).lock(), /held by process/);
    a.close();
  });
});

describe('the relayer tops the solver up on a live leg at start, never on a regenerated one', () => {
  const { topUpSolver } = require('../engine/redeploy');
  const S = acct('5e');
  const make = (genesis, balance) => {
    const sent = [];
    return {
      sent,
      client: {
        kind: 'harness',
        address: acct('11'),
        genesis: async () => ({ hash: genesis }),
        balance: async () => balance,
        transfer: async (to, value) => sent.push([to, value]),
      },
    };
  };
  const dep = (hash) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dep-')), 'testnet-x.json');
    fs.writeFileSync(file, JSON.stringify({ qrlGenesisHash: hash }));
    return file;
  };
  const env = { SOLVER_ADDRESS: S, SOLVER_QRL_FUNDING: '100' };

  test('below half its target on the record\'s genesis: topped up to the target', async () => {
    const { client, sent } = make('0xaa', 10n * ONE);
    await topUpSolver({ client, chain: 'x', env, depFile: dep('0xaa'), log: () => {} });
    assert.deepEqual(sent, [[S, 90n * ONE]]);
  });

  test('at half or more: nothing; on another genesis: nothing (the redeploy funds it, and sends first)', async () => {
    const half = make('0xaa', 50n * ONE);
    await topUpSolver({ client: half.client, chain: 'x', env, depFile: dep('0xaa'), log: () => {} });
    assert.deepEqual(half.sent, []);
    const reset = make('0xbb', 0n);
    await topUpSolver({ client: reset.client, chain: 'x', env, depFile: dep('0xaa'), log: () => {} });
    assert.deepEqual(reset.sent, []);
  });
});
