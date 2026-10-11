/**
 * The relayer's side of audit round OC (2026-10-03), against both legs as
 * fakes (fake-chains.js): one describe per finding, each asserting the rule
 * the finding showed broken.
 *
 *   OC-SWAP-01  root pre-emption: selection before the seal, a hold on an
 *               urgent seal while an offering's selection is not scanned, and
 *               expired premium locks pruned, never urgent;
 *   OC-ECON-05  the bond's book closed in batches while it is further behind
 *               than one close may go, so the coupon is distributed again;
 *   OC-LEGA-01  sealed releases of censorship-ground claimants withheld until
 *               their escrow's recovery is applied or the hold lapses;
 *   OC-LEGA-04  a sweep before an allocation is consumed, in the same tick;
 *   OC-LEGA-06  the extension window watched, an ALARM when it stalls;
 *   OC-LEGB-06  the delegation's reports sealed on the attestation double,
 *               never over another root, and applied once cleared;
 *   OC-OPS-09   the QRL leg's ABIs found on the QRVM line where the harness
 *               line is absent.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keccak256, toUtf8Bytes } = require('ethers');

const ids = require('../lib/identifiers');
const { Solver } = require('../engine/solver');
const { World, tmpDir, CHAIN_ID, ASSET, ESCROW, SWAP, BOND, COUPON, DELEGATION, REPORT_KEYSPACE, ZERO32 } = require('./fake-chains');
const { qrlAbiBuild } = require('../../../scripts/lib/chains');
const { parseValidator, beaconFromEnv } = require('../lib/beacon');

const E = 4_000_000n;
const ASSET_Y = '0x' + 'b0'.repeat(20);

/** A premium lock as the QRL scan adds it, with the evmExpiry of its offering. */
const lock = (world, tag, asset, offered) => ({
  kind: 'premium',
  leaf: keccak256(toUtf8Bytes(`lock-${tag}`)),
  lotId: keccak256(toUtf8Bytes(`lot-${tag}`)),
  asset,
  evmExpiry: world.clock.evmExpiry(offered),
  offeredEpoch: offered,
  standIn: null,
  source: 'PremiumSwap LotSelected',
});

/** Two offerings of epoch `offered`, X already selected by a stranger and scanned. */
function twoOfferings(r, offered) {
  const s = r.state.data;
  r.noteOffering(ASSET, offered);
  r.noteOffering(ASSET_Y, offered);
  Object.assign(s.offerings[`${ASSET}@${offered}`], { selected: true, scanned: true });
  return { X: s.offerings[`${ASSET}@${offered}`], Y: s.offerings[`${ASSET_Y}@${offered}`] };
}

describe('OC-SWAP-01: no lock misses its evmExpiry because another asset sealed the epoch\'s only root', () => {
  test('the relayer selects before it seals, and holds the urgent root until every closed offering\'s selection is scanned', async () => {
    const world = new World();
    world.deployment.qrl.PremiumSwap = SWAP;
    const offered = E - 2n;
    assert.equal(world.clock.quoteCloses(offered), world.clock.startOf(E));
    world.at(E, 0.01);
    const lines = [];
    const r = await world.relayer(tmpDir(), { log: (l) => lines.push(l) });
    const { Y } = twoOfferings(r, offered);
    const X = lock(world, 'X', ASSET, offered);
    r.addPending(X);

    await r.tick();
    assert.deepEqual(world.selections, [[ASSET_Y.toLowerCase(), offered]], 'the relayer selected Y in this tick, before any seal');
    assert.equal(world.relay.lastEpoch, 0n, 'the urgent root waits: Y\'s selection is not scanned yet');
    assert.ok(lines.some((l) => /held: offering .* selection is not scanned/.test(l)), lines.join('\n'));

    // The next tick scans Y's OfferingSelected and its lock.
    world.at(E, 0.02);
    const Ylock = lock(world, 'Y', ASSET_Y, offered);
    Y.scanned = true;
    r.addPending(Ylock);
    await r.tick();
    assert.equal(world.relay.lastEpoch, E, 'sealed at once once nothing is waiting');
    const inX = Solver.lockIn(r.state.data, X.lotId);
    const inY = Solver.lockIn(r.state.data, Ylock.lotId);
    assert.ok(inX && inY && inX.epoch === E && inY.epoch === E, 'both locks ride the root of E, admitted before either evmExpiry');
    assert.ok(world.clock.startOf(E) + world.clock.ADMISSION_WINDOW < Ylock.evmExpiry);
  });

  test('the hold ends half way through the admission window: what is in is sealed then', async () => {
    const world = new World();
    world.deployment.qrl.PremiumSwap = SWAP;
    const offered = E - 2n;
    world.at(E, 0.01);
    const r = await world.relayer(tmpDir());
    twoOfferings(r, offered);
    const X = lock(world, 'X', ASSET, offered);
    r.addPending(X);
    await r.tick();
    assert.equal(world.relay.lastEpoch, 0n);
    // Half an admission window is 300 s of a 4,200 s epoch.
    world.at(E, 0.08);
    await r.tick();
    assert.equal(world.relay.lastEpoch, E, 'Y\'s selection never scanned: the root is not held past qc + ADMISSION/2');
    assert.equal(Solver.lockIn(r.state.data, X.lotId).epoch, E);
  });

  test('a lock past its evmExpiry is pruned, never sealed, and makes no root urgent (the cascade, one asset)', async () => {
    const world = new World();
    world.deployment.qrl.PremiumSwap = SWAP;
    const offered = E - 2n;
    world.at(E, 0.6);
    const lines = [];
    const r = await world.relayer(tmpDir(), { log: (l) => lines.push(l) });
    await r.tick();
    assert.equal(world.relay.lastEpoch, E, 'the root of E is in');
    // A lock that reached the relayer only after that root: it waits, and expires.
    const late = lock(world, 'late', ASSET, offered);
    r.addPending(late);
    // The first tick of E + 1: the expired lock used to seal this root before anything was selected.
    world.at(E + 1n, 0.005);
    assert.ok(world.now >= late.evmExpiry);
    await r.tick();
    assert.equal(world.relay.lastEpoch, E, 'no urgent root at the boundary of E + 1');
    assert.ok(!r.state.data.pending.some((p) => p.leaf === late.leaf), 'the expired lock is no longer pending');
    assert.ok(r.state.data.expiredLocks[late.lotId], 'and recorded as pruned');
    assert.ok(lines.some((l) => /ALARM: lock .* reached no admitted root before its evmExpiry/.test(l)), lines.join('\n'));
    // E + 1's own lock, selected at its quote close, rides E + 1's root.
    const fresh = lock(world, 'fresh', ASSET, offered + 1n);
    r.addPending(fresh);
    world.at(E + 1n, 0.02);
    await r.tick();
    assert.equal(world.relay.lastEpoch, E + 1n);
    assert.equal(Solver.lockIn(r.state.data, fresh.lotId).epoch, E + 1n);
    assert.equal(Solver.lockIn(r.state.data, late.lotId), null, 'the expired lock was never sealed');
  });

  test('an unexpired lock is still urgent: a root is sealed for it at once when no selection is waiting', async () => {
    const world = new World();
    world.deployment.qrl.PremiumSwap = SWAP;
    world.at(E, 0.2);
    const r = await world.relayer(tmpDir());
    const X = lock(world, 'X', ASSET, E - 2n);
    r.addPending(X);
    await r.tick();
    assert.equal(world.relay.lastEpoch, E);
    assert.equal(Solver.lockIn(r.state.data, X.lotId).epoch, E);
  });
});

describe('OC-ECON-05: a keeper gap longer than the bond\'s close batch is closed by the relayer', () => {
  test('closeEpochs(32) while behind, then the coupon is distributed again', async () => {
    const world = new World();
    world.deployment.qrl.ArkCatBond = BOND;
    world.deployment.qrl.ArkBondCoupon = COUPON;
    world.at(E + 40n, 0.6);
    world.bond.lastClosed = E;
    world.coupon.last = E - 5n;
    const r = await world.relayer(tmpDir());
    assert.throws(() => world.qrlDispatch(COUPON, 'distribute', [E - 4n], false), /EpochGapTooLong/);
    await r.distributeCoupons(world.now);
    assert.deepEqual(world.bond.closeCalls, [32n], 'one batch closes the gap below one close');
    assert.ok(world.epoch() - (world.bond.lastClosed + 1n) < 32n);
    assert.ok(world.coupon.distributed.length > 0 && world.coupon.distributed[0] === E - 4n, 'and the coupon is distributed again in the same tick');
  });

  test('a book within one batch is left to the strict paths; a long outage takes several batches', async () => {
    const world = new World();
    world.deployment.qrl.ArkCatBond = BOND;
    world.at(E + 10n, 0.6);
    world.bond.lastClosed = E;
    const r = await world.relayer(tmpDir());
    await r.closeBondGap(world.now);
    assert.deepEqual(world.bond.closeCalls, [], 'nine epochs behind: nothing to do');
    world.at(E + 100n, 0.6);
    await r.closeBondGap(world.now);
    assert.deepEqual(world.bond.closeCalls, [32n, 32n, 32n], 'ninety-nine behind: three batches');
    assert.equal(world.bond.lastClosed, E + 96n);
  });
});

describe('OC-LEGA-01: a censorship-ground claimant\'s sealed release is withheld until its escrow\'s recovery', () => {
  /** A release sealed into an admitted root, for a position anchored at E - 1. */
  async function sealedRelease(world) {
    world.deployment.qrl.ArkCatBond = BOND;
    world.deployment.qrl.ArkCatBondRecovery = BOND;
    world.at(E, 0.6);
    const lines = [];
    const r = await world.relayer(tmpDir(), { log: (l) => lines.push(l) });
    const s = r.state.data;
    const a = { asset: ASSET, escrow: ESCROW, depositor: '0x' + '0d'.repeat(20), boundQrlOwner: '0x' + '0b'.repeat(20), depositNonce: 1n, anchoredNotional: 10n ** 18n, epoch: E - 1n };
    const id = ids.stakeAssetId({ chainId: CHAIN_ID, ...a });
    s.anchors[id] = a;
    const recipient = '0x' + '0c'.repeat(20);
    const leaf = ids.releaseLeaf(ESCROW, ids.releasePayload({ id, recipient, claimNonce: 1n, chainId: CHAIN_ID }));
    // The censorship ground is found; the position is a claimant, its escrow's recovery not applied.
    world.bond.ground = 2;
    world.bond.at = world.clock.startOf(E - 1n);
    world.bond.stage = 3;
    world.bond.claimant.set(id, 1);
    r.addPending({ kind: 'release', leaf, id, recipient, claimNonce: 1n });
    return { r, s, id, leaf, lines };
  }

  test('withheld while the recovery is not applied, presented once it is', async () => {
    const world = new World();
    const { r, s, id, leaf, lines } = await sealedRelease(world);
    await r.tick();
    assert.ok(Object.values(s.roots).some((x) => x.items.some((i) => i.leaf === leaf)), 'the release is sealed: sealing is not presenting');
    assert.equal(world.transit.has(id), false, 'and not presented, not even into transit');
    assert.ok(s.claimantHold[leaf], 'the hold is recorded');
    assert.ok(lines.some((l) => /withheld: a claimant of the censorship ground/.test(l)), lines.join('\n'));

    world.at(E + 1n, 0.6);
    await r.tick();
    assert.equal(world.transit.has(id), false, 'still withheld an epoch later');

    world.bond.cursor = 1; // the origin chain's slot applied
    world.at(E + 1n, 0.7);
    await r.tick();
    assert.ok(world.transit.has(id), 'presented once the escrow\'s recovery is applied');
    assert.equal(s.claimantHold[leaf], undefined);
  });

  test('applied on QRL, the hold lasts while a share of the escrow\'s recovery is not yet drawn on the origin chain', async () => {
    const world = new World();
    const { r, s, id } = await sealedRelease(world);
    await r.tick();
    assert.equal(world.transit.has(id), false, 'sealed and withheld');
    // The recovery is applied on QRL; one of its shares is still to be drawn.
    world.bond.cursor = 1;
    const share = { kind: 'recovery', leaf: '0x' + '5e'.repeat(32), asset: ASSET, escrow: ESCROW, destination: '0x' + '66'.repeat(20), quantity: 1n, recoveryId: '0x' + '01'.repeat(32), recipient: '0x' + '02'.repeat(32), successorId: ZERO32, standIn: null };
    s.pending.push(share);
    world.at(E, 0.7);
    await r.tick({ seal: false });
    assert.equal(world.transit.has(id), false, 'a share still to be drawn: the claimant waits for it');
    s.pending = s.pending.filter((p) => p.kind !== 'recovery');
    world.at(E, 0.8);
    await r.tick({ seal: false });
    assert.ok(world.transit.has(id), 'no share outstanding: presented');
  });

  test('the hold lapses recoveryHoldEpochs after T, with an ALARM', async () => {
    const world = new World();
    const { r, id, lines } = await sealedRelease(world);
    r.manifest.recoveryHoldEpochs = 3;
    await r.tick();
    assert.equal(world.transit.has(id), false);
    world.at(E + 2n, 0.6); // T is E - 1: the hold runs to E + 2
    await r.tick();
    assert.ok(world.transit.has(id), 'presented once the hold lapsed');
    assert.ok(lines.some((l) => /ALARM: the recovery of escrow .* is not applied/.test(l)), lines.join('\n'));
  });

  test('a position the bond refused, or one recorded after T, is no claimant and is never withheld', async () => {
    for (const setup of [(w, s, id) => w.bond.claimant.set(id, 2), (w, s, id) => { w.bond.claimant.delete(id); s.declaration = { skipped: { [id]: 'NotClaimant' } }; }, (w, s, id) => w.bond.claimant.delete(id)]) {
      const world = new World();
      const { r, s, id } = await sealedRelease(world);
      setup(world, s, id);
      await r.tick();
      assert.ok(world.transit.has(id), 'presented at once');
    }
  });

  test('an unrecorded position is withheld while the claimant record is open, and no ground means no hold', async () => {
    const world = new World();
    const { r, id } = await sealedRelease(world);
    world.bond.claimant.delete(id);
    world.bond.stage = 0;
    await r.tick();
    assert.equal(world.transit.has(id), false, 'it may yet be recorded a claimant');
    world.bond.ground = 0;
    world.at(E, 0.7);
    await r.tick();
    assert.ok(world.transit.has(id), 'no censorship ground: presented');
  });
});

describe('OC-LEGA-04: the escrow is swept before an allocation replaces its rates', () => {
  test('in the tick that consumes the allocation, the sweep comes first', async () => {
    const world = new World();
    world.at(E, 0.6);
    world.sweepable = true;
    const r = await world.relayer(tmpDir());
    await r.tick();
    const order = world.escrowCalls.map((c) => c.method).filter((m) => m === 'sweep' || m === 'recordEpochAllocation');
    assert.deepEqual(order, ['sweep', 'recordEpochAllocation'], 'the yield accrued so far is settled at the rates it accrued under');
    assert.equal(r.state.data.swept[ESCROW], E, 'and housekeeping does not sweep the epoch twice');
  });
});

describe('OC-LEGA-06: the extension window is watched', () => {
  test('an ALARM when no extension is scheduled twelve epochs after the window opened, once it is due', async () => {
    const world = new World();
    world.window = { opens: 3, closes: 100, horizon: 10 };
    world.relay.nextLeaf = 3;
    world.at(E, 0.6);
    const lines = [];
    const r = await world.relayer(tmpDir(), { signing: false, log: (l) => lines.push(l) });
    await r.watchExtension(E);
    assert.ok(lines.some((l) => /extension window is open: leaf 3, EXTENSION_OPENS 3/.test(l)), lines.join('\n'));
    await r.watchExtension(E + 11n);
    assert.ok(!lines.some((l) => /ALARM/.test(l)), 'not before twelve epochs');
    await r.watchExtension(E + 12n);
    assert.ok(lines.some((l) => /ALARM: no extension of generation 1 is scheduled 12 epochs after its window opened/.test(l) && /the manifest records no generation 2/.test(l)), lines.join('\n'));
    // Scheduled: the watch is satisfied.
    world.relay.extensionAt = E + 18n;
    const before = lines.length;
    await r.watchExtension(E + 13n);
    assert.ok(lines.slice(before).some((l) => /extension to generation 2 is scheduled/.test(l)));
    await r.watchExtension(E + 14n);
    assert.ok(!lines.slice(before).some((l) => /ALARM/.test(l)));
  });

  test('no ALARM while the extension is deliberately not yet due (signed late in the window)', async () => {
    const world = new World();
    world.window = { opens: 3, closes: 1000, horizon: 600 };
    world.relay.nextLeaf = 3;
    world.at(E, 0.6);
    const lines = [];
    const r = await world.relayer(tmpDir(), { signing: false, log: (l) => lines.push(l) });
    await r.watchExtension(E);
    await r.watchExtension(E + 40n);
    assert.ok(!lines.some((l) => /ALARM/.test(l)), 'due from leaf 588: nothing to alarm on at leaf 3');
    world.relay.nextLeaf = 590;
    await r.watchExtension(E + 41n);
    await r.watchExtension(E + 42n);
    assert.ok(lines.some((l) => /ALARM/.test(l)), 'past due and twelve epochs open: ALARM');
  });
});

describe('OC-LEGB-06: the delegation\'s reports are sealed on the attestation double', () => {
  const PKH = keccak256(toUtf8Bytes('validator-7')).toLowerCase();
  const CREDS = keccak256(toUtf8Bytes('credentials'));
  const ONE = 10n ** 18n;

  async function reporting(world, { beacon = true } = {}) {
    world.deployment.qrl.ArkBondDelegation = DELEGATION;
    world.at(E, 0.2);
    world.delegation.validators.set(PKH, { stake: 40_000n * ONE, closed: false, withdrawn: 0n, lastReportEpoch: 0n });
    world.emitDelegated(PKH);
    const lines = [];
    const r = await world.relayer(tmpDir(), { log: (l) => lines.push(l) });
    if (beacon) {
      r.beacon = { validators: async () => new Map([[PKH, { index: 7n, pubkeyHash: PKH, status: 2, slashed: false, credentialsHash: CREDS, balance: 40_001n * ONE }]]) };
    }
    return { r, lines };
  }

  /** A block of the QRL leg, at a fraction of an epoch, crediting the delegation `withdrawn`. */
  const block = (world, n, epoch, fraction, withdrawn = 0n, fees = 0n) => {
    world.qrlBlocks.push({
      number: BigInt(n),
      timestamp: world.clock.startOf(epoch) + BigInt(Math.floor(Number(world.clock.EPOCH_LENGTH) * fraction)),
      withdrawals: withdrawn ? [{ validatorIndex: 7n, address: DELEGATION, amount: withdrawn }] : [],
      fees,
    });
    if (BigInt(n) > world.qrlHead) world.qrlHead = BigInt(n);
  };

  test('each closed epoch gets a root at reportKey, with the line the beacon shows and the withdrawals through its end; applied once cleared', async () => {
    const world = new World();
    const { r, lines } = await reporting(world);
    await r.tick();
    assert.ok(r.state.data.reports.funded[PKH], 'the funding was scanned');
    block(world, 200, E, 0.5, 2n * ONE, 3n);
    block(world, 201, E + 1n, 0.1, 5n * ONE); // after E's end: not E's
    world.at(E + 1n, 0.3);
    await r.tick();
    const key = REPORT_KEYSPACE | E;
    const root = world.attestation.get(key);
    assert.ok(root, `reportKey(${E}) sealed: ${lines.join('\n')}`);
    const rec = r.state.data.reports.epochs[String(E)];
    assert.equal(rec.root, root);
    assert.deepEqual(rec.lines.map((l) => [l[0], l[1], l[2], l[7]]), [[E, PKH, 2, 2n * ONE]], 'one line: active, its withdrawals through the end of E');
    assert.equal(rec.fees, 3n);
    assert.ok(world.delegation.noted.get(E), 'and noted, which starts its challenge window');
    assert.notEqual(world.attestation.get(E), root, 'never at a forward key: the forward root of E is its own');

    // Inside the challenge window nothing is applied; after it, the line and the fees line are.
    await r.tick();
    assert.deepEqual(world.delegation.reconciled, []);
    world.now = world.clearsAt(E);
    world.at(world.epoch(), Number(world.now - world.clock.startOf(world.epoch())) / Number(world.clock.EPOCH_LENGTH) + 0.001);
    await r.tick();
    assert.deepEqual(world.delegation.reconciled.map((l) => [l[0], l[7]]).slice(0, 1), [[E, 2n * ONE]], 'reconciled once cleared');
    assert.deepEqual(world.delegation.fees[0], [E, 3n]);
    assert.ok(rec.done);
  });

  test('a key a deposit check already took is skipped, never overwritten, and the next epoch is reported', async () => {
    const world = new World();
    const { r, lines } = await reporting(world);
    await r.tick();
    const check = '0x' + 'dc'.repeat(32);
    world.attestation.set(REPORT_KEYSPACE | E, check); // the pool's deposit check, sealed at the epoch it funded in
    block(world, 200, E, 0.5);
    block(world, 201, E + 1n, 0.5);
    block(world, 202, E + 2n, 0.1);
    world.at(E + 2n, 0.3);
    await r.tick();
    assert.equal(world.attestation.get(REPORT_KEYSPACE | E), check, 'the deposit check stands');
    assert.match(r.state.data.reports.epochs[String(E)].skipped, /already holds/);
    assert.ok(lines.some((l) => /never overwritten/.test(l)));
    assert.ok(world.attestation.get(REPORT_KEYSPACE | (E + 1n)), 'E + 1 is reported');
  });

  test('without a beacon node nothing is sealed, and that is said once', async () => {
    const world = new World();
    const { r, lines } = await reporting(world, { beacon: false });
    r.beacon = null;
    block(world, 200, E + 1n, 0.1);
    world.at(E + 1n, 0.3);
    await r.tick();
    await r.tick();
    assert.equal(world.attestation.get(REPORT_KEYSPACE | E), undefined);
    assert.equal(lines.filter((l) => /no beacon node/.test(l)).length, 1);
  });

  test('a delegation verifying against another attestation is the quorum\'s: nothing sealed', async () => {
    const world = new World();
    world.delegation.attestation = '0x' + '99'.repeat(20);
    const { r, lines } = await reporting(world);
    block(world, 200, E + 1n, 0.1);
    world.at(E + 1n, 0.3);
    await r.tick();
    assert.equal(world.attestation.get(REPORT_KEYSPACE | E), undefined);
    assert.ok(lines.some((l) => /not the testnet double/.test(l)));
  });

  test('the beacon API reading: Gplanck to planck, statuses by name, an unknown status yields no line', () => {
    const pubkey = '0x' + 'ab'.repeat(48);
    const v = parseValidator({ index: '7', balance: '40000000000000', status: 'active_exiting', validator: { pubkey, withdrawal_credentials: '0x' + '01'.repeat(64), slashed: false } });
    assert.equal(v.status, 3);
    assert.equal(v.balance, 40_000n * ONE);
    assert.equal(v.pubkeyHash, keccak256(pubkey).toLowerCase());
    assert.equal(parseValidator({ index: '1', balance: '0', status: 'mystery', validator: { pubkey, withdrawal_credentials: '0x', slashed: false } }), null);
    assert.equal(beaconFromEnv({}), null);
    assert.ok(beaconFromEnv({ QRL_BEACON_URL: 'http://127.0.0.1:1/' }, async () => ({})));
  });
});

describe('OC-OPS-09: the QRL leg\'s ABIs are read from the QRVM line where the harness line is absent', () => {
  test('harness line first, QRVM line as the fallback, per artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-abi-line-'));
    const put = (dir, name) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, `${name}.json`), '{"abi":[]}');
    };
    put('build-qrvm-rapid', 'ArkStakingPool');
    assert.equal(qrlAbiBuild('rapid', 'ArkStakingPool', { root }), path.join(root, 'build-qrvm-rapid'), 'a v3-only profile: the QRVM line');
    put('build-rapid', 'ArkStakingPool');
    assert.equal(qrlAbiBuild('rapid', 'ArkStakingPool', { root }), path.join(root, 'build-rapid'), 'both lines: the harness line, as before');
    assert.equal(qrlAbiBuild('rapid', 'ArkStakeRegistry', { root }), path.join(root, 'build-rapid'), 'neither: the harness line, so the error names the build to make');
  });
});

describe('OC-SWAP-05: the preimage is carried before the claim is final on the origin chain', () => {
  test('a PremiumClaimed above the safe head sets the lot\'s secret in the same tick', async () => {
    const world = new World();
    world.at(E, 0.2);
    const r = await world.relayer(tmpDir());
    await r.tick();
    const lotId = keccak256(toUtf8Bytes('oc-swap-05 lot'));
    const secret = keccak256(toUtf8Bytes('oc-swap-05 secret'));
    world.emitPremiumClaimed(lotId, secret);
    world.safeLag = 4n;
    await r.tick();
    assert.ok(r.state.data.origin.scannedTo < world.block, 'the claim sits above the safe head the forward scan stops at');
    assert.equal(r.state.data.lots[lotId].secret, secret, 'the preimage is carried from the latest block');
    assert.equal(r.state.data.origin.claimsScannedTo, world.block, 'and the claim cursor has reached the latest block');
    world.safeLag = 0n;
    await r.tick();
    assert.equal(r.state.data.lots[lotId].secret, secret, 'the forward scan reaching it later changes nothing');
  });
});

void ZERO32;
