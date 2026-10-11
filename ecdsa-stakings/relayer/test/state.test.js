/**
 * The relayer's durable state. The rule under test throughout: what a one-time
 * leaf signs is on disk before it signs it, and a second process cannot write
 * over that record.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { RelayerState, StateConflictError } = require('../engine/state');
const { Relayer } = require('../engine/relayer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-'));

describe('the relayer state', () => {
  test('a notional survives the round trip as a BigInt', () => {
    const dir = tmp();
    const s = new RelayerState(dir);
    s.data.anchors.x = { anchoredNotional: 2n ** 200n + 7n, depositNonce: 0n };
    s.save();
    const back = new RelayerState(dir);
    assert.equal(back.data.anchors.x.anchoredNotional, 2n ** 200n + 7n);
    assert.equal(back.data.anchors.x.depositNonce, 0n);
  });

  test('a signing record is readable again after the process that wrote it is gone', () => {
    // This is what stops a leaf signing a second message: the relayer finds the
    // record, resubmits that one message, and never signs another from the leaf.
    const dir = tmp();
    const s = new RelayerState(dir);
    s.data.signed[3] = { message: '0x' + '11'.repeat(32), epoch: 42n, root: '0x' + '22'.repeat(32), admitted: false };
    s.save();
    const back = new RelayerState(dir);
    assert.equal(back.data.signed[3].epoch, 42n);
    assert.equal(back.data.signed[3].admitted, false);
  });

  test('a save leaves no half-written file behind', () => {
    const dir = tmp();
    const s = new RelayerState(dir);
    s.data.roots['7'] = { root: '0x' + '33'.repeat(32), items: [] };
    s.save();
    s.data.roots['8'] = { root: '0x' + '44'.repeat(32), items: [] };
    s.save();
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
    assert.equal(Object.keys(new RelayerState(dir).data.roots).length, 2);
  });

  test('a second writer is refused while the first is alive', () => {
    const dir = tmp();
    const first = new RelayerState(dir);
    first.lock();
    // This process's parent: another live process, which is what the lock is
    // there to detect.
    fs.writeFileSync(path.join(dir, 'lock'), String(process.ppid));
    assert.throws(() => new RelayerState(dir).lock(), /held by process/);
  });

  test('a lock held by a process that is gone is taken over', () => {
    const dir = tmp();
    // A pid no process can have: the relayer must not be stopped for ever by a
    // crash, only by a live writer.
    fs.writeFileSync(path.join(dir, 'lock'), '2147483647');
    assert.doesNotThrow(() => new RelayerState(dir).lock());
  });

  test('the inbox carries an entry between processes, oldest first, once each', () => {
    const dir = tmp();
    RelayerState.post(dir, { kind: 'close' });
    RelayerState.post(dir, { kind: 'freeze', frozen: true, quantity: 5n });
    const s = new RelayerState(dir);
    const got = [];
    s.drainInbox((e) => got.push(e));
    assert.equal(got.length, 2);
    assert.equal(got[0].kind, 'close');
    assert.equal(got[1].quantity, 5n);
    s.drainInbox((e) => got.push(e));
    assert.equal(got.length, 2);
  });

  test('a malformed inbox file is set aside, and the entries after it still arrive', () => {
    const dir = tmp();
    const inbox = path.join(dir, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, '001-close.json'), JSON.stringify({ kind: 'close' }));
    fs.writeFileSync(path.join(inbox, '002-bad.json'), '{ not json');
    fs.writeFileSync(path.join(inbox, '003-freeze.json'), JSON.stringify({ kind: 'freeze', frozen: true }));
    const s = new RelayerState(dir);
    const got = [];
    s.drainInbox((e) => got.push(e.kind));
    assert.deepEqual(got, ['close', 'freeze']);
    assert.ok(fs.existsSync(path.join(dir, 'inbox', 'bad')) && fs.readdirSync(path.join(dir, 'inbox', 'bad')).some((f) => f.endsWith('-bad.json')));
    // It does not fail every tick afterwards.
    assert.doesNotThrow(() => s.drainInbox(() => got.push('again')));
    assert.deepEqual(got, ['close', 'freeze']);
  });

  test('an entry its handler refuses does not take the entries after it with it', () => {
    const dir = tmp();
    RelayerState.post(dir, { kind: 'loss' });
    RelayerState.post(dir, { kind: 'close' });
    const s = new RelayerState(dir);
    const got = [];
    s.drainInbox((e) => {
      if (e.kind === 'loss') throw new Error('no asset for this position');
      got.push(e.kind);
    });
    assert.deepEqual(got, ['close']);
    assert.equal(fs.readdirSync(path.join(dir, 'inbox', 'bad')).filter((f) => f.endsWith('.json')).length, 1);
  });

  test('an entry handled and saved, whose file outlived a crash, is not handled twice', () => {
    // A loss entry mints a determination id; handled twice it seals two leaves.
    const dir = tmp();
    const name = RelayerState.post(dir, { kind: 'loss' });
    const body = fs.readFileSync(path.join(dir, 'inbox', name), 'utf8');
    const s = new RelayerState(dir);
    let handled = 0;
    s.drainInbox(() => (handled += 1));
    // The crash: the save happened, the removal did not.
    fs.writeFileSync(path.join(dir, 'inbox', name), body);
    const revived = new RelayerState(dir);
    revived.drainInbox(() => (handled += 1));
    assert.equal(handled, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'inbox', name)));
  });

  test('a save does not lose a signing record another process wrote after this one read (relay:status)', () => {
    const dir = tmp();
    const status = new RelayerState(dir); // reads
    const service = new RelayerState(dir);
    service.data.signed[0] = { message: '0x' + '11'.repeat(32), epoch: 5n, root: '0x' + '22'.repeat(32), admitted: false };
    service.save(); // writes
    status.data.origin.scannedTo = 1n;
    status.save(); // writes what it read, over the record
    assert.equal(new RelayerState(dir).data.signed[0].message, '0x' + '11'.repeat(32));
  });

  test('a save that would record a second message for a leaf stops, and leaves the first on disk', () => {
    const dir = tmp();
    const a = new RelayerState(dir);
    const b = new RelayerState(dir);
    a.data.signed[0] = { message: '0x' + '11'.repeat(32), epoch: 5n, root: '0x01', admitted: false };
    a.save();
    b.data.signed[0] = { message: '0x' + '33'.repeat(32), epoch: 5n, root: '0x02', admitted: false };
    assert.throws(() => b.save(), StateConflictError);
    assert.equal(new RelayerState(dir).data.signed[0].message, '0x' + '11'.repeat(32));
  });

  test('two writers never share a temporary file', () => {
    // A leftover at the one shared name used to make every save fail.
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'state.json.tmp'));
    const s = new RelayerState(dir);
    s.data.roots['1'] = { root: '0x01', items: [] };
    assert.doesNotThrow(() => s.save());
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp') && f !== 'state.json.tmp'));
  });

  test('two processes locking at once: exactly one wins', async () => {
    const dir = tmp();
    const script = `
      const { RelayerState } = require(${JSON.stringify(require.resolve('../engine/state'))});
      const s = new RelayerState(${JSON.stringify(dir)});
      const go = Number(process.argv[1]);
      while (Date.now() < go) {}
      try { s.lock(); process.stdout.write('won'); setTimeout(() => {}, 800); }
      catch (e) { process.stdout.write('refused'); }
    `;
    const go = Date.now() + 700;
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script, String(go)]);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('exit', () => resolve(out));
    });
    const outcomes = await Promise.all([run(), run(), run(), run()]);
    assert.equal(outcomes.filter((o) => o === 'won').length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter((o) => o === 'refused').length, 3);
  });
  test('a replaced QRL leg resets what was recorded on QRL and nothing of the origin chain (R40)', () => {
    // The devnet regenerates from genesis and the origin leg persists. Every
    // forward fact must be sealed and recorded again on the new leg, and the QRL
    // scan must restart; the one-time leaves already used on the origin chain
    // must survive untouched, or a leaf gets signed twice.
    const dir = tmp();
    const state = new RelayerState(dir);
    const d = state.data;
    d.origin.scannedTo = 900n;
    d.qrl.scannedTo = 5000n;
    d.forward['7'] = { items: [{ kind: 'anchor', id: '0x01', leaf: '0x02', applied: 'recorded' }], root: '0x03', sealed: true };
    d.signed[0] = { message: '0x' + '44'.repeat(32), epoch: 7n, root: '0x05', items: [], admitted: true };
    d.roots['7'] = { root: '0x05', leafIndex: 0, items: [] };
    d.consumed['0x06@0x07'] = { outcome: 'release', epoch: 7n };
    d.anchors['0x01'] = { anchoredNotional: 10n };
    state.save();
    const signedBefore = JSON.stringify(d.signed, (_k, v) => (typeof v === 'bigint' ? String(v) : v));

    const r = Object.create(Relayer.prototype);
    r.state = state;
    r.log = () => {};
    r.resetQrlSide({ registry: '0xaa', deployedAt: 'yesterday' }, { registry: '0xaa', deployedAt: 'today' });

    assert.equal(d.qrl.scannedTo, null);
    assert.deepEqual(d.forward['7'], { items: [{ kind: 'anchor', id: '0x01', leaf: '0x02', applied: null }], root: null, sealed: false });
    assert.equal(d.origin.scannedTo, 900n);
    assert.equal(JSON.stringify(d.signed, (_k, v) => (typeof v === 'bigint' ? String(v) : v)), signedBefore);
    assert.ok(d.roots['7'] && d.consumed['0x06@0x07'] && d.anchors['0x01']);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.before-qrl-reset-')), 'the state before the reset is kept');
  });
});
