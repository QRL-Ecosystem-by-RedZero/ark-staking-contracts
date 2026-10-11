/**
 * The inbox, authenticated (audit 2026-09-27, D3), and the two other
 * operator-trust fixes of that audit that live in the relayer: the Q-Day
 * double not read into leaves on a shared network (D2), and a solver that does
 * not reveal its secret where the reveal could lose the lot (D12).
 *
 * The rule under test: **a file in the inbox is a request from an operator
 * named in advance, or it is nothing** — and every decision leaves a line in
 * an append-only log.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Wallet } = require('ethers');

const { signEnvelope, openEnvelope, allowedSigners, InboxRefusal } = require('../lib/inbox');
const { RelayerState } = require('../engine/state');
const { mockQdayActs, qdayOracleOf } = require('../engine/relayer');
const { Solver } = require('../engine/solver');
const { clockFor, revealBudgetSeconds, marginShortfall } = require('../lib/epoch');
const ids = require('../lib/identifiers');
const { World, tmpDir, ASSET } = require('./fake-chains');

const OPERATOR = Wallet.createRandom();
const STRANGER = Wallet.createRandom();
const SIGNERS = [OPERATOR.address.toLowerCase()];
const E = 4_000_000n;

describe('an inbox envelope is accepted only from an allowlisted operator, for this chain, once', () => {
  test('a signed envelope opens to its entry and names its signer', async () => {
    const env = await signEnvelope({ chain: 'hoodi', entry: { kind: 'freeze', frozen: true }, privateKey: OPERATOR.privateKey });
    const opened = openEnvelope(JSON.parse(JSON.stringify(env)), { chain: 'hoodi', signers: SIGNERS });
    assert.deepEqual(opened.entry, { kind: 'freeze', frozen: true });
    assert.equal(opened.signer, OPERATOR.address.toLowerCase());
  });

  test('a bare entry, as the inbox used to take, is refused', () => {
    assert.throws(() => openEnvelope({ kind: 'close' }, { chain: 'hoodi', signers: SIGNERS }), /unsigned/);
  });

  test('a signer not on the allowlist, an empty allowlist, a tampered entry and another chain are all refused', async () => {
    const theirs = await signEnvelope({ chain: 'hoodi', entry: { kind: 'close' }, privateKey: STRANGER.privateKey });
    assert.throws(() => openEnvelope(theirs, { chain: 'hoodi', signers: SIGNERS }), /not allowlisted/);
    const ours = await signEnvelope({ chain: 'hoodi', entry: { kind: 'close' }, privateKey: OPERATOR.privateKey });
    assert.throws(() => openEnvelope(ours, { chain: 'hoodi', signers: [] }), /no inbox signer is allowlisted/);
    const tampered = { ...ours, entry: { kind: 'loss', destination: '0x' + '66'.repeat(20), quantity: '1n' } };
    assert.throws(() => openEnvelope(tampered, { chain: 'hoodi', signers: SIGNERS }), InboxRefusal);
    assert.throws(() => openEnvelope(ours, { chain: 'hoodi-vps', signers: SIGNERS }), /signed for chain hoodi/);
  });

  test('an envelope accepted once is a replay the second time', async () => {
    const env = await signEnvelope({ chain: 'hoodi', entry: { kind: 'freeze', frozen: false }, privateKey: OPERATOR.privateKey });
    const seen = {};
    const { digest } = openEnvelope(env, { chain: 'hoodi', signers: SIGNERS, seen });
    seen[digest] = 'earlier';
    assert.throws(() => openEnvelope(env, { chain: 'hoodi', signers: SIGNERS, seen }), /replay/);
  });

  test('the operator key is not the one-time seed', async () => {
    const seed = OPERATOR.privateKey;
    await assert.rejects(() => signEnvelope({ chain: 'hoodi', entry: { kind: 'close' }, privateKey: seed, otsSeed: seed }), /equals the one-time seed/);
    await assert.rejects(() => signEnvelope({ chain: 'hoodi', entry: { kind: 'close' } }), /RELAYER_INBOX_KEY/);
  });

  test('the allowlist is read per chain first, then globally, checksummed', () => {
    const env = { RELAYER_INBOX_SIGNERS: OPERATOR.address, HOODI_VPS_INBOX_SIGNERS: `${STRANGER.address}, ${OPERATOR.address}` };
    assert.deepEqual(allowedSigners(env, 'hoodi'), [OPERATOR.address.toLowerCase()]);
    assert.deepEqual(allowedSigners(env, 'hoodi-vps'), [STRANGER.address.toLowerCase(), OPERATOR.address.toLowerCase()]);
    assert.throws(() => allowedSigners({ RELAYER_INBOX_SIGNERS: 'not an address' }, 'hoodi'));
  });
});

describe('the relayer ingests only signed inbox files, and logs every decision', () => {
  test('an unsigned close is quarantined and never queued; a signed one is queued; a copy is refused', async () => {
    const world = new World();
    world.at(E, 0.1);
    const dir = tmpDir();
    const r = await world.relayer(dir, { env: { RELAYER_INBOX_SIGNERS: OPERATOR.address } });
    // `relay.js seal` before 2026-09-27: the bare entry.
    RelayerState.post(dir, { kind: 'close' });
    await r.tick();
    assert.equal(r.state.data.pending.filter((p) => p.kind === 'close').length, 0, 'the unsigned close was not queued');
    assert.equal(world.relay.closed, false);
    assert.ok(fs.readdirSync(path.join(dir, 'inbox', 'bad')).some((f) => f.endsWith('.json')));

    const signed = await signEnvelope({ chain: 'fake', entry: { kind: 'delist', asset: ASSET }, privateKey: OPERATOR.privateKey });
    RelayerState.post(dir, signed);
    await r.tick();
    const queued = [...r.state.data.pending, ...Object.values(r.state.data.roots).flatMap((x) => x.items)].filter((p) => p.kind === 'delist');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].operator, OPERATOR.address.toLowerCase());

    RelayerState.post(dir, signed);
    await r.tick();
    const log = fs.readFileSync(path.join(dir, 'inbox-audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => l.outcome), ['refused', 'accepted', 'refused']);
    assert.match(log[2].reason, /replay/);
    r.close();
  });
});

describe('the Q-Day double becomes a leaf only where the origin chain is a stand-in (D2)', () => {
  test('on a shared network a declaration is logged and no close leaf is queued', async () => {
    const world = new World();
    world.at(E, 0.6);
    const lines = [];
    const r = await world.relayer(tmpDir(), { qdayActs: false, log: (m) => lines.push(m) });
    world.qday.declared = true;
    world.qday.frozen = true;
    world.at(E + 1n, 0.05);
    await r.tick();
    assert.equal(world.relay.closed, false);
    assert.equal(world.relay.frozen, false);
    assert.equal(r.state.data.pending.filter((p) => p.kind === 'close' || p.kind === 'freeze').length, 0);
    assert.ok(lines.some((l) => /NOT queueing a close leaf/.test(l)));
  });

  test('core\'s ArkQDayOracle is the protocol\'s own declaration: its close and freeze leaves are sealed on a shared network, not as stand-ins (C4 follow-up)', async () => {
    const world = new World();
    // The record names the real oracle (deployQrlLeg with core's governance record).
    world.deployment.qrl = { ...world.deployment.qrl, ArkQDayOracle: world.deployment.qrl.MockQDayOracle, MockQDayOracle: undefined };
    world.deployment.qday = { kind: 'real', address: world.deployment.qrl.ArkQDayOracle };
    world.at(E, 0.6);
    const r = await world.relayer(tmpDir(), { qdayActs: false });
    await r.tick();
    world.qday.frozen = true;
    world.at(E + 1n, 0.05);
    await r.tick();
    assert.equal(world.relay.frozen, true, 'the advisory\'s freeze reaches the escrow');
    world.qday.declared = true;
    world.at(E + 2n, 0.05);
    await r.tick();
    assert.equal(world.relay.closed, true, 'the ratified declaration closes the escrow');
    const items = Object.values(r.state.data.roots).flatMap((x) => x.items);
    const close = items.find((x) => x.kind === 'close');
    assert.equal(close.standIn, null, 'not a stand-in: the declaration procedure itself');
    assert.equal(close.source, 'ArkQDayOracle.declared');
  });

  test('the record says which oracle is wired; an older record is read by its address names', () => {
    const q = '0x' + '5a'.repeat(20);
    assert.deepEqual(qdayOracleOf({ qday: { kind: 'real', address: q }, qrl: {} }), { kind: 'real', address: q });
    assert.deepEqual(qdayOracleOf({ qrl: { ArkQDayOracle: q } }), { kind: 'real', address: q });
    assert.deepEqual(qdayOracleOf({ qrl: { MockQDayOracle: q } }), { kind: 'mock', address: q });
    assert.equal(qdayOracleOf({ qrl: {} }), null);
  });

  test('the default acts on the harness and the enclave only; the per-chain flag overrides both ways', () => {
    assert.equal(mockQdayActs({ client: 'harness' }, {}, 'local'), true);
    assert.equal(mockQdayActs({ client: 'qrl' }, {}, 'rehearsal'), true);
    assert.equal(mockQdayActs({ client: 'evm' }, {}, 'hoodi-vps'), false);
    assert.equal(mockQdayActs({}, {}, 'hoodi-vps'), false, 'an absent client is a real origin chain');
    assert.equal(mockQdayActs({ client: 'evm' }, { HOODI_VPS_QDAY_MOCK_ACTS: '1' }, 'hoodi-vps'), true);
    assert.equal(mockQdayActs({ client: 'harness' }, { LOCAL_QDAY_MOCK_ACTS: '0' }, 'local'), false);
  });
});

describe('the solver does not reveal where the reveal could lose the lot (D12)', () => {
  const clock = clockFor(600);
  const lotEpoch = 100n;
  const lot = { lotId: '0x' + '11'.repeat(32), hashlock: ids.hashlockOf('0x' + '22'.repeat(32)), secret: '0x' + '22'.repeat(32), epoch: lotEpoch };
  const relayerState = {
    roots: { 102: { items: [{ kind: 'premium', lotId: lot.lotId, leaf: '0x' + '33'.repeat(32), recipient: '0x' + '44'.repeat(20), shares: 5n, evmExpiry: clock.evmExpiry(lotEpoch) }] } },
  };
  const origin = (now, { failCall = null } = {}) => {
    const sent = [];
    return {
      sent,
      async head() {
        return { timestamp: now };
      },
      async call() {
        if (failCall) throw new Error(failCall);
        return [];
      },
      async send(...args) {
        sent.push(args);
        return {};
      },
    };
  };
  const solverOn = (o) => new Solver({ qrl: { kind: 'fake' }, origin: o, swap: null, swapAbi: null, chainId: 1, escrow: { asset: ASSET, escrow: ASSET, abi: null }, recipient: ASSET, clock, revealBudget: revealBudgetSeconds({ confirmations: 64 }) });

  test('inside the time the relayer needs to carry the preimage, nothing is sent', async () => {
    const o = origin(clock.settlementCloses(lotEpoch) - 1000n);
    const l = { ...lot };
    assert.equal(await solverOn(o).claim(l, relayerState), false);
    assert.equal(o.sent.length, 0);
    assert.match(l.refused, /too late to reveal/);
  });

  test('a claim that would fail as a call — the pot drawn, the settlement closed — is never sent', async () => {
    const o = origin(clock.quoteCloses(lotEpoch) + 700n, { failCall: 'execution reverted: PremiumExceedsPot' });
    const l = { ...lot };
    assert.equal(await solverOn(o).claim(l, relayerState), false);
    assert.equal(o.sent.length, 0);
    assert.match(l.refused, /PremiumExceedsPot/);
  });

  test('in time, and succeeding as a call, the claim is sent', async () => {
    const o = origin(clock.quoteCloses(lotEpoch) + 700n);
    assert.equal(await solverOn(o).claim({ ...lot }, relayerState), true);
    assert.equal(o.sent.length, 1);
  });

  test('D12: on the testnet profile the QRL margin clears Hoodi\'s budget, twice finality and a tick (whitepaper §4.7)', () => {
    // 2 x 64 x 12 + 60 = 1,596 s, above the two ten-minute "days" (1,200 s)
    // the factor alone gives, so the profile runs at the bound
    // (scripts/lib/profile.js). Until 2026-09-28 the shortfall here was 396 s.
    assert.equal(revealBudgetSeconds({ confirmations: 64 }), 1596n);
    assert.equal(clock.QRL_CLAIM_MARGIN, 1596n);
    assert.equal(marginShortfall(clock, { confirmations: 64 }), 0n);
    // A chain one second a block slower is short again, by two finalities of
    // 64 seconds, and the solver-side cutoff is what protects its solvers.
    assert.equal(marginShortfall(clock, { confirmations: 64, blockSeconds: 13 }), 128n);
    // The spec clock's two days cover it many times over; the rapid enclave's two minutes cover one confirmation.
    assert.equal(marginShortfall(clockFor(86400), { confirmations: 64 }), 0n);
    assert.equal(marginShortfall(clockFor(60), { confirmations: 1 }), 0n);
  });
});
