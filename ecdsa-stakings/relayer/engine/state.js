/**
 * The relayer's durable state, one JSON file per origin chain.
 *
 * The one rule this module exists to enforce: **a one-time leaf is recorded as
 * spent on disk before it signs anything.** `save()` writes a temporary file,
 * fsyncs it and renames it over the old one, so a crash leaves either the old
 * state or the new, never half of one. The relayer records the message a leaf
 * will sign, saves, and only then signs; a relayer that dies in between finds
 * the record on restart and resubmits that same message, which the relay still
 * admits — nothing but an admission advances `lastEpoch` — rather than signing
 * a second message from the leaf, which would hand an observer of both
 * signatures chain positions the key never meant to reveal.
 *
 * A second process must not write the same file, so the directory is locked
 * by pid, and the lock is taken with an exclusive create: two processes
 * starting together cannot both find it absent and both write it. `relay.js
 * seal` does not write here at all: it drops a file into `inbox/`, which the
 * owning process ingests. `relay.js status` reads and never saves.
 *
 * `save()` is defended as well against a writer that should not exist. A
 * `signed` record on disk and missing from memory is merged in before the
 * write, and a record whose message differs from the one on disk stops the
 * save: a state read before another process recorded a signature, and saved
 * after it, must not erase that record, because the record is the only thing
 * that stops the leaf signing again.
 */
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  version: 1,
  chain: null,
  relay: null,
  authority: null,
  origin: { scannedTo: null },
  qrl: { scannedTo: null },
  /** stakeAssetId -> the anchor as the escrow emitted it. */
  anchors: {},
  /** origin epoch -> leaves for the attester quorum's root on QRL. */
  forward: {},
  /** return-path leaves not yet in a root. */
  pending: [],
  /** epoch -> an admitted root and what it carried. */
  roots: {},
  /** leaf index -> the one message it signs. Never deleted. */
  signed: {},
  /** "<leaf>@<target>" -> the outcome of consuming a leaf on the origin chain. */
  consumed: {},
  /** Unused since the premium swap replaced the stand-in auction; kept so an old state still loads. */
  deliveries: [],
  /** lotId -> a premium lot: its epoch, its status on QRL, the preimage once revealed. */
  lots: {},
  /** "<asset>@<epoch>" -> an offering recorded on QRL, and whether its lots were selected. */
  offerings: {},
  /** escrow -> the last epoch its premium was offered in. */
  offered: {},
  /** escrow -> the last epoch its buffer was reported in (whitepaper §4.3, buffer_orig). */
  reported: {},
  /** escrow -> last epoch swept. */
  swept: {},
  /** stakeAssetId -> why this relayer no longer records it on QRL (a replaced leg, X5). */
  retired: {},
  /** inbox file name -> ingested; the file is removed after the save that records it. */
  inboxDone: {},
  /** digest of an accepted inbox envelope -> when; a copy is refused as a replay (lib/inbox.js). */
  inboxSeen: {},
  /** The Q-Day oracle's freeze as this relayer last read it, for edge detection. */
  qday: { frozen: null },
  /** lotId -> a premium lock pruned unsealed at its evmExpiry (OC-SWAP-01). */
  expiredLocks: {},
  /** release leaf -> why its presentation is withheld from a censorship-ground claimant (OC-LEGA-01). */
  claimantHold: {},
  /** The authority chain's extension window as last watched (OC-LEGA-06). */
  extensionWatch: null,
  /** The delegation's reports on the attestation double (OC-LEGB-06); null until a validator is funded. */
  reports: null,
});

/** JSON with BigInt as decimal strings tagged `n`, so a notional round-trips exactly. */
const replacer = (_k, v) => (typeof v === 'bigint' ? `${v}n` : v);
const reviver = (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** A lock file still empty this long after it was created is a crash between create and write. */
const EMPTY_LOCK_GRACE_MS = 10_000;

let postSeq = 0;
const unique = () => `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'), reviver);

class StateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateConflictError';
  }
}

class RelayerState {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.inbox = path.join(dir, 'inbox');
    this.lockFile = path.join(dir, 'lock');
    fs.mkdirSync(this.inbox, { recursive: true });
    // Fields added since a state was written start empty rather than undefined.
    this.data = { ...EMPTY(), ...(fs.existsSync(this.file) ? readJson(this.file) : {}) };
  }

  /** The pid in a lock file: 0 where it is empty, null where there is none. */
  static lockHolder(dir) {
    try {
      const text = fs.readFileSync(path.join(dir, 'lock'), 'utf8').trim();
      return text ? Number(text) : 0;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** The live process holding `dir`, or null where nobody does. */
  static liveHolder(dir) {
    const pid = RelayerState.lockHolder(dir);
    return pid && pidAlive(pid) ? pid : null;
  }

  /**
   * Take the directory for this process. Re-entrant within one process: a
   * relayer rebuilt after a QRL redeploy takes the lock it already holds, so
   * the lock is never let go between the two (engine/loop.js).
   */
  lock() {
    const held = (pid) => new Error(`relayer state ${this.dir} is held by process ${pid}; one writer per relay`);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        try {
          fs.writeSync(fd, String(process.pid));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return this._releaser();
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const pid = RelayerState.lockHolder(this.dir);
      if (pid === null) continue; // released between the create and the read
      if (pid === process.pid) return this._releaser();
      if (pid === 0) {
        // Created and not yet written, or a crash in between: only age tells.
        let age = 0;
        try {
          age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
        } catch {
          continue;
        }
        if (age < EMPTY_LOCK_GRACE_MS) throw held('(starting)');
      } else if (pidAlive(pid)) {
        throw held(pid);
      }
      // A stale lock, moved aside by rename, which exactly one taker wins. The
      // winner checks that what it moved is the stale lock it judged and not a
      // fresh one another taker wrote in between.
      const aside = `${this.lockFile}.stale-${unique()}`;
      try {
        fs.renameSync(this.lockFile, aside);
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
      const moved = fs.readFileSync(aside, 'utf8').trim();
      if (moved !== (pid ? String(pid) : '')) {
        // Another taker's live lock: put it back, by link so it cannot
        // overwrite a third process's lock.
        try {
          fs.linkSync(aside, this.lockFile);
        } catch {
          /* a third process holds it now; either way it is not ours */
        }
        fs.unlinkSync(aside);
        throw held(moved || '(starting)');
      }
      fs.unlinkSync(aside);
    }
    throw held('(contended)');
  }

  _releaser() {
    const release = () => {
      try {
        if (Number(fs.readFileSync(this.lockFile, 'utf8')) === process.pid) fs.unlinkSync(this.lockFile);
      } catch {
        /* already gone */
      }
    };
    process.once('exit', release);
    return release;
  }

  /**
   * Fold what is on disk into memory where memory lacks it. Only `signed` and
   * `roots`: both are facts of the origin chain that only grow, and losing one
   * is how a leaf signs twice or a root's leaves are never consumed. Everything
   * else is the lock holder's to decide.
   */
  _mergeFromDisk() {
    if (!fs.existsSync(this.file)) return;
    const disk = readJson(this.file);
    const mine = this.data;
    for (const [k, rec] of Object.entries(disk.signed || {})) {
      const own = mine.signed[k];
      if (!own) {
        mine.signed[k] = rec;
      } else if (String(own.message).toLowerCase() !== String(rec.message).toLowerCase()) {
        throw new StateConflictError(
          `leaf ${k} carries message ${rec.message} on disk and ${own.message} in this process: two writers recorded ` +
            'different messages for one leaf. Nothing was written; stop every relayer for this chain and reconcile by hand',
        );
      } else if (rec.admitted && !own.admitted) {
        own.admitted = true;
      }
    }
    for (const [k, root] of Object.entries(disk.roots || {})) {
      if (!mine.roots[k]) mine.roots[k] = root;
    }
  }

  save() {
    this._mergeFromDisk();
    // A name of this writer's own: two writers sharing one temporary file
    // could rename each other's half-written bytes into place.
    const tmp = `${this.file}.${unique()}.tmp`;
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(this.data, replacer, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  /**
   * Hand each inbox entry to `handle`, oldest first, exactly once.
   *
   * One file at a time: parsed, handled, recorded as ingested in a save, and
   * only then removed. A crash after the save and before the removal finds the
   * name recorded and removes the file without handling it again — which
   * matters, because a premium entry schedules a delivery and a second copy
   * would schedule a second one. A file that does not parse, or that `handle`
   * refuses, is moved to `inbox/bad/` with the reason beside it, so one bad
   * entry neither blocks the ones after it nor fails every tick.
   *
   * `handle(json, fileName)` decides whether a file is acceptable at all: the
   * relayer's handler authenticates it as an operator's signed envelope
   * (lib/inbox.js). `onRefused(fileName, error)` is told of every refusal.
   */
  drainInbox(handle, log = () => {}, onRefused = () => {}) {
    const done = (this.data.inboxDone ||= {});
    const files = fs.readdirSync(this.inbox).filter((f) => f.endsWith('.json')).sort();
    for (const name of Object.keys(done)) if (!files.includes(name)) delete done[name];
    let handled = 0;
    for (const f of files) {
      const p = path.join(this.inbox, f);
      if (done[f]) {
        fs.rmSync(p, { force: true });
        continue;
      }
      try {
        handle(readJson(p), f);
      } catch (e) {
        this._quarantine(f, e);
        log(`inbox    ${f} refused and moved to inbox/bad/: ${e.message}`);
        onRefused(f, e);
        continue;
      }
      done[f] = true;
      this.save();
      fs.rmSync(p, { force: true });
      handled += 1;
    }
    return handled;
  }

  _quarantine(name, error) {
    const bad = path.join(this.inbox, 'bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.renameSync(path.join(this.inbox, name), path.join(bad, name));
    fs.writeFileSync(path.join(bad, `${name}.error.txt`), String(error && error.stack ? error.stack : error));
  }

  /** Written by a process that does not hold the lock. */
  static post(dir, entry) {
    const inbox = path.join(dir, 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    // The sequence orders two posts made in one millisecond by one process;
    // the random suffix alone would sort them by chance.
    postSeq += 1;
    const name = `${Date.now()}-${String(postSeq).padStart(6, '0')}-${process.pid}-${Math.random().toString(16).slice(2, 8)}.json`;
    const tmp = path.join(inbox, `${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(entry, replacer, 2));
    fs.renameSync(tmp, path.join(inbox, name));
    return name;
  }
}

module.exports = { RelayerState, StateConflictError, replacer, reviver, pidAlive };
