#!/usr/bin/env node
/**
 * An adversarial, model-checked fuzz of the origin leg: one relay, one escrow,
 * many depositors, and an attacker who may present any leaf, any number of
 * times, in any order, with any tampering, while the asset rebases both ways.
 *
 *   node ecdsa-stakings/stress/leg-a-fuzz.js [--backend harness|hardhat] [--url http://127.0.0.1:8546]
 *        [--form units|shares|both] [--steps 400] [--seed 1] [--runs 1] [--wave 120]
 *        [--strict] [--twin]
 *
 * The one rule it exists to enforce: **every refusal is a named error, and no
 * sequence of permissionless calls breaks an accounting identity.** After every
 * step it reads the escrow and checks:
 *
 *   S1  sharesHeld >= positionShares + bufferShares + auctionShares + queuedShares + unclaimedShares + psrShares
 *   S2  queuedShares == the queue's own entries summed (releases excluded once reclaimed)
 *   S3  queuedReleaseShares == the release entries summed, and <= queuedShares
 *   S4  an empty queue has no base; head <= tail
 *   S5  shares paid out of the queue in one epoch <= the bound on the base (+1 floor)
 *   S6  no release is paid while frozen or after closure
 *   S7  no release receipt is consumed before its root's epoch + 4
 *   S8  no leaf pays twice; no tampered leaf pays at all
 *   S9  no call to the escrow or the relay reverts with a Panic, a string or nothing
 *   S10 unclaimedShares == the credits of every payee summed
 *   S11 a premium lock pays only against the preimage of its hashlock, only
 *       before its evmExpiry, once, and the shares it names, worth their units
 *       at the claim
 *   S12 a release receipt presented before its unbonding (or under the
 *       freeze) moves its position into transit once and consumes nothing
 *       (X7, 2026-09-29); S2 and S3 count the transit with the queue
 *
 * and, at the end, liveness: with the freeze lifted and the clock moved on,
 * the queue empties (L1), a sweep leaves held == owed (L2), and every credit
 * whose payee the asset will now pay is paid by `withdrawOwed` (L3).
 *
 * `--strict` swaps in the assets that refuse payments the way real ones do —
 * `MockStrictRebasingAsset` (Lido: refuses its own address, truncates, not 1:1)
 * or `MockStrictAsset` (a blocklist the run toggles, refuses its own address
 * and zero) — names the token's own address among the payees and as the
 * operations destination, and adds E1: `drainQueue` never reverts, whatever
 * the payee.
 *
 * `--twin` puts a second escrow, on a second asset, on the same relay, anchors
 * into both, and presents every loss leaf and recovery share to both: X1, a
 * loss leaf or a recovery share pays at most once across the escrows — every
 * leaf binds the escrow that pays it since 2026-09-28 (D10), which closed R25.
 *
 * `--wave N` then runs the stress case of whitepaper §3.3 on a fresh escrow: N
 * positions all released at once must clear within the unbonding plus four
 * draining epochs (I25), with the gas of each drain bounded by its entries.
 *
 * Exit status is the number of violations, so CI can gate on it.
 */
const path = require('path');
const { Interface, getAddress, keccak256, toUtf8Bytes, AbiCoder } = require('ethers');

const { harnessBackend, hardhatBackend, Reverted, artifact } = require('./backend');
const ids = require('../relayer/lib/identifiers');
const { buildTree, proofFor } = require('../relayer/lib/merkle');
const { SignerSet, sigsArg } = require('../relayer/lib/authority');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const BUILD = path.join(__dirname, '..', 'ethereum', 'build');
const EPOCH = 7n * 86400n;
const BPS = 10_000n;
const BOUND_BPS = 2_500n;
const ONE = 10n ** 18n;
const TREE_HEIGHT = 9;
const coder = AbiCoder.defaultAbiCoder();

/** mulberry32: a seed reproduces a failing run exactly. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
    big: (lo, hi) => lo + BigInt(Math.floor(next() * Number(hi - lo + 1n))),
  };
}

const ABI = {
  relay: new Interface(artifact('ArkEpochRootRelay', BUILD).abi),
  units: new Interface(artifact('ArkStakeEscrowUnits', BUILD).abi),
  shares: new Interface(artifact('ArkStakeEscrowShares', BUILD).abi),
  asset: new Interface(artifact('MockAsset', BUILD).abi),
  rebasing: new Interface(artifact('MockRebasingAsset', BUILD).abi),
  strict: new Interface(artifact('MockStrictAsset', BUILD).abi),
  strictRebasing: new Interface(artifact('MockStrictRebasingAsset', BUILD).abi),
};

const SIGNER_SEED = keccak256(toUtf8Bytes('ark-stake:stress-root-authority'));
let signerCache = null;
/** A one-of-one signer set (phase 1 of whitepaper §3.7); the threshold itself is shared/test/relay.test.js's. */
const signer = () => (signerCache ||= new SignerSet({ seeds: [SIGNER_SEED], threshold: 1, treeHeight: TREE_HEIGHT }));

/** Refusals the escrow and the relay intend. Anything else from them is S9. */
const isDefect = (name) => /^(Panic|Error|<)/.test(name);

class World {
  constructor(b, form, r, log, { strict = false, twin = false } = {}) {
    this.b = b;
    this.form = form;
    this.r = r;
    this.log = log;
    this.strict = strict;
    this.twinMode = twin;
    this.lossPaidAt = new Map(); // loss leaf -> escrows that paid it
    this.recoveryPaidTwice = 0;
    this.deferred = 0;
    this.withdrawn = 0;
    this.violations = [];
    this.reverts = new Map();
    this.gas = new Map();
    this.positions = new Map(); // id -> { depositor, owner, released }
    this.sealed = []; // { kind, leaf, epoch, proof, args, consumed }
    this.claims = { sealed: 0, paid: 0 }; // premium locks sealed, and paid
    this.consumedKeys = new Set();
    this.paidInEpoch = new Map(); // epoch -> shares
    this.baseInEpoch = new Map(); // epoch -> max base seen
    this.frozen = false;
    this.closed = false;
    this.accounts = Array.from({ length: 40 }, (_, i) => getAddress('0x' + keccak256(toUtf8Bytes(`depositor-${i}`)).slice(26)));
    this.recipients = Array.from({ length: 12 }, (_, i) => getAddress('0x' + keccak256(toUtf8Bytes(`recipient-${i}`)).slice(26)));
  }

  violate(code, detail) {
    this.violations.push({ code, detail });
    this.log(`   VIOLATION ${code}: ${detail}`);
  }

  async setup() {
    const b = this.b;
    this.relay = await b.deploy('ArkEpochRootRelay', [signer().roots(), 1, TREE_HEIGHT, ids.TERMINAL_COMMIT]);
    const rebasing = this.form === 'shares';
    const tokenName = this.strict
      ? rebasing ? 'MockStrictRebasingAsset' : 'MockStrictAsset'
      : rebasing ? 'MockRebasingAsset' : 'MockAsset';
    this.tokenAbi = this.strict ? (rebasing ? ABI.strictRebasing : ABI.strict) : rebasing ? ABI.rebasing : ABI.asset;
    this.escrowAbi = rebasing ? ABI.shares : ABI.units;

    const deployBook = async () => {
      const asset = await b.deploy(tokenName, []);
      // Strict: the one immutable payee is one the asset refuses for ever.
      const ops = this.strict ? asset : getAddress('0x' + 'ab'.repeat(20));
      const seedMin = ONE;
      const escrow = await b.deploy(
        rebasing ? 'ArkStakeEscrowShares' : 'ArkStakeEscrowUnits',
        // The last argument: the audit's reference yield per epoch, 2.20% a year (EC-08).
        rebasing ? [asset, asset, this.relay, ops, seedMin, 20, 421917808219179n] : [asset, this.relay, ops, seedMin, 20, 421917808219179n],
      );
      if (rebasing) {
        // A pool that is not 1:1, so shares and units differ from the start.
        await b.send(asset, this.tokenAbi, 'mint', [b.deployer, 1000n * ONE]);
        await b.send(asset, this.tokenAbi, 'rebase', [37n * ONE]);
      }
      await b.send(asset, this.tokenAbi, 'mint', [b.deployer, 2n * ONE]);
      await b.send(asset, this.tokenAbi, 'approve', [escrow, 2n * ONE]);
      const seeded = await this.attempt(escrow, this.escrowAbi, 'seed', [2n * ONE], b.deployer);
      if (!seeded.ok) this.violate('SETUP', `seed refused ${seeded.name}`);
      return { asset, escrow, ops };
    };

    ({ asset: this.asset, escrow: this.escrow, ops: this.ops } = await deployBook());
    if (this.twinMode) this.twin = await deployBook();

    // Strict: the token's own address is a payee QRL may name, as a depositor
    // naming the stETH contract by mistake would.
    if (this.strict) {
      this.recipients.push(getAddress(this.asset), getAddress(this.asset));
      this.blocked = new Set();
    }
    this.payees = [...new Set([...this.recipients.map((x) => getAddress(x)), getAddress(this.ops)])];
  }

  /* -------------------------------------------------------------- plumbing */

  async mint(to, amount) {
    await this.b.send(this.asset, this.tokenAbi, 'mint', [to, amount]);
  }

  async view(fn, args = []) {
    return (await this.b.call(this.escrow, this.escrowAbi, fn, args))[0];
  }

  async relayView(fn, args = []) {
    return (await this.b.call(this.relay, ABI.relay, fn, args))[0];
  }

  async epoch() {
    return (await this.b.now()) / EPOCH;
  }

  /** Send; returns `{ ok, logs }` or `{ ok: false, name }`, recording S9 and gas. */
  async attempt(target, abi, method, args, from) {
    // The base in force as the call starts: a payment in this call is bounded
    // by it, or by the base of a queue the call itself opens (QueueOpened).
    if (target === this.escrow) {
      let base = BigInt(await this.view('queueBase'));
      const e = await this.epoch();
      // The base ratchets at the first drain of an epoch to the holding then
      // (D8, whitepaper §3.3): until a call of this epoch has drained, the
      // holding at the start of a call on an open queue is the base its drain
      // may take. Nothing a call does before its drain moves the holding.
      if (this.drainedIn !== e && BigInt(await this.view('queueHead')) !== BigInt(await this.view('queueTail'))) {
        const held = BigInt(await this.view('sharesHeld'));
        if (held > base) base = held;
      }
      if (base > (this.baseInEpoch.get(e) || 0n)) this.baseInEpoch.set(e, base);
    }
    try {
      const r = await this.b.send(target, abi, method, args, from ?? this.b.deployer);
      const g = this.gas.get(method) || 0n;
      if (r.gasUsed > g) this.gas.set(method, r.gasUsed);
      return { ok: true, logs: r.logs };
    } catch (e) {
      if (!(e instanceof Reverted)) throw e;
      const key = `${method}:${e.revertName}`;
      this.reverts.set(key, (this.reverts.get(key) || 0) + 1);
      if (isDefect(e.revertName)) this.violate('S9', `${method}(${args.map(String).join(', ').slice(0, 160)}) reverted ${e.revertName}`);
      return { ok: false, name: e.revertName };
    }
  }

  escrowSend(method, args, from) {
    return this.attempt(this.escrow, this.escrowAbi, method, args, from);
  }

  parse(logs) {
    const out = [];
    for (const l of logs) {
      if (l.address.toLowerCase() !== this.escrow.toLowerCase()) continue;
      try {
        out.push(this.escrowAbi.parseLog(l));
      } catch {
        /* the token's own events */
      }
    }
    return out;
  }

  /** Record the queue's payments of one call against S5 and S6. */
  async account(logs, context) {
    const nowEpoch = await this.epoch();
    if (process.env.FUZZ_DEBUG) {
      for (const ev of this.parse(logs)) {
        if (['QueueOpened', 'EntryPaid', 'ReleaseQueued', 'LossQueued', 'ShareQueued', 'ReleasesReclaimed', 'ReleaseDropped'].includes(ev.name)) {
          this.log(`      [${context} @${nowEpoch}] ${ev.name} ${ev.args.map((x) => String(x)).join(' ').slice(0, 200)}`);
        }
      }
    }
    for (const ev of this.parse(logs)) {
      if (ev.name === 'PaymentDeferred') this.deferred += 1;
      if (ev.name === 'QueueOpened') {
        const e = BigInt(ev.args.epoch);
        const prior = this.baseInEpoch.get(e) || 0n;
        if (BigInt(ev.args.queueBase) > prior) this.baseInEpoch.set(e, BigInt(ev.args.queueBase));
      }
      if (ev.name === 'EntryPaid') {
        const e = BigInt(ev.args.epoch);
        this.drainedIn = e;
        this.paidInEpoch.set(e, (this.paidInEpoch.get(e) || 0n) + BigInt(ev.args.shares));
        if (Number(ev.args.kind) === 1 && (this.frozen || this.closed)) {
          this.violate('S6', `release entry ${ev.args.queueIndex} paid while ${this.closed ? 'closed' : 'frozen'} (${context})`);
        }
      }
      if (ev.name === 'ReleaseQueued' && nowEpoch < BigInt(ev.args.sealedEpoch) + 4n) {
        this.violate('S7', `release of ${ev.args.stakeAssetId.slice(0, 12)} consumed in epoch ${nowEpoch}, sealed in ${ev.args.sealedEpoch}`);
      }
    }
  }

  /* -------------------------------------------------------------- the relay */

  async seal(leaves) {
    const b = this.b;
    const last = await this.relayView('lastEpoch');
    const next = await this.relayView('nextLeaf');
    const horizon = await this.relayView('MIGRATION_HORIZON');
    if (next >= BigInt(2 ** TREE_HEIGHT) - 1n) return null;
    let now = await this.epoch();
    if (next > 0n && now <= last) {
      await b.advance((last + 1n) * EPOCH - (await b.now()) + 1n);
      now = await this.epoch();
    }
    const tree = buildTree(leaves);
    const message = ids.rootMessage({ chainId: b.chainId, relay: this.relay, epoch: now, epochRoot: tree.root, leafCount: tree.leaves.length });
    const leaf = Number(next);
    const sig = sigsArg(signer()._signUnchecked(message, leaf));
    const r = await this.attempt(this.relay, ABI.relay, 'admitEpochRoot', [now, tree.root, tree.leaves.length, leaf, sig]);
    if (!r.ok) {
      this.violate('R', `root for epoch ${now} refused: ${r.name}`);
      return null;
    }
    // Tamper: the same signature on another root must be refused.
    if (this.r.chance(0.2)) {
      const forged = await this.attempt(this.relay, ABI.relay, 'admitEpochRoot', [now + 1n, tree.root, tree.leaves.length, leaf + 1, sig]);
      if (forged.ok) this.violate('S8', `a signature for leaf ${leaf} admitted a root at leaf ${leaf + 1}`);
    }
    void horizon;
    return { epoch: now, proof: (l) => proofFor(tree, l) };
  }

  /* -------------------------------------------------------------- operations */

  async opAnchor() {
    const r = this.r;
    const from = r.pick(this.accounts);
    const owner = r.chance(0.05) ? '0x' + '00'.repeat(20) : r.pick(this.recipients);
    const amount = r.pick([1n, 3n, 1000n, ONE / 7n, ONE, 13n * ONE, r.big(1n, 500n) * ONE]);
    if (this.twin && r.chance(0.3)) {
      // Into the second escrow on the relay: its positions are what a loss
      // leaf presented at the first must not pay against.
      const t = this.twin;
      await this.b.send(t.asset, this.tokenAbi, 'mint', [from, amount]);
      await this.b.send(t.asset, this.tokenAbi, 'approve', [t.escrow, amount], from);
      const res = await this.attempt(t.escrow, this.escrowAbi, 'anchor', [owner, amount], from);
      if (res.ok) {
        for (const l of res.logs) {
          if (l.address.toLowerCase() !== t.escrow.toLowerCase()) continue;
          try {
            const ev = this.escrowAbi.parseLog(l);
            if (ev && ev.name === 'Anchored') this.positions.set(ev.args.stakeAssetId, { depositor: from, owner, released: true, twin: true });
          } catch {
            /* the token's own events */
          }
        }
      }
      return;
    }
    await this.mint(from, amount);
    await this.b.send(this.asset, this.tokenAbi, 'approve', [this.escrow, amount], from);
    const res = await this.escrowSend('anchor', [owner, amount], from);
    if (res.ok) {
      for (const ev of this.parse(res.logs)) {
        if (ev.name === 'Anchored') this.positions.set(ev.args.stakeAssetId, { depositor: from, owner, released: false });
      }
    } else if (owner === '0x' + '00'.repeat(20) && !['NoBeneficiary', 'AnchoringIsClosed', 'ReleaseClosed', 'MigrationHorizonReached'].includes(res.name)) {
      this.violate('S9', `anchor with no beneficiary refused as ${res.name}`);
    }
  }

  async opYield() {
    const r = this.r;
    if (this.form === 'shares' && r.chance(0.7)) {
      const pooled = BigInt(await this.b.call(this.asset, this.tokenAbi, 'totalSupply').then((x) => x[0]));
      // Mostly positive; one in six a slashing of up to 3%.
      const delta = r.chance(0.17) ? -((pooled * BigInt(r.int(300) + 1)) / 10_000n) : (pooled * BigInt(r.int(40) + 1)) / 100_000n;
      await this.b.send(this.asset, this.tokenAbi, 'rebase', [delta]);
      return;
    }
    // A donation straight to the escrow: the inflation-attack primitive.
    const amt = r.pick([1n, 7n, ONE / 1000n, ONE, 50n * ONE]);
    await this.mint(this.b.deployer, amt);
    await this.b.send(this.asset, this.tokenAbi, 'transfer', [this.escrow, amt]);
  }

  async opSweep() {
    const res = await this.escrowSend('sweep', [], this.r.pick(this.accounts));
    if (res.ok) for (const ev of this.parse(res.logs)) if (ev.name === 'PaymentDeferred') this.deferred += 1;
  }

  async opDrain() {
    const res = await this.escrowSend('drainQueue', [BigInt(this.r.pick([0, 1, 2, 5, 16, 64]))], this.r.pick(this.accounts));
    if (res.ok) await this.account(res.logs, 'drainQueue');
    // drainQueue has no refusal of its own; a revert is a payee holding the queue.
    else this.violate('E1', `drainQueue reverted ${res.name}`);
  }

  /** Strict, non-rebasing: an outside party blocks or unblocks a payee. */
  async opBlock() {
    if (!this.strict || this.form !== 'units') return;
    const who = this.r.pick(this.recipients.filter((x) => getAddress(x) !== getAddress(this.asset)));
    const on = !this.blocked.has(who);
    await this.b.send(this.asset, this.tokenAbi, 'setBlocked', [who, on]);
    if (on) this.blocked.add(who);
    else this.blocked.delete(who);
  }

  /** Anyone pays a payee its credit; the payee, and only the payee, receives it. */
  async opWithdraw() {
    const who = this.r.pick(this.payees);
    await this.withdrawFor(who, 'opWithdraw');
  }

  async balanceOf(who, asset = this.asset) {
    return BigInt((await this.b.call(asset, this.tokenAbi, 'balanceOf', [who]))[0]);
  }

  async withdrawFor(who, context) {
    const owedBefore = BigInt(await this.view('owedShares', [who]));
    const before = await this.balanceOf(who);
    const caller = this.r.pick(this.accounts);
    const callerBefore = await this.balanceOf(caller);
    const res = await this.escrowSend('withdrawOwed', [who], caller);
    if (!res.ok) {
      if (!['NothingOwed', 'PaymentRefused'].includes(res.name)) this.violate('S9', `withdrawOwed refused ${res.name}`);
      if (res.name === 'PaymentRefused' && BigInt(await this.view('owedShares', [who])) !== owedBefore) this.violate('S10', 'a refused withdrawal moved the credit');
      return res;
    }
    this.withdrawn += 1;
    const ev = this.parse(res.logs).find((e) => e.name === 'OwedWithdrawn');
    const units = BigInt(ev.args.units);
    const got = (await this.balanceOf(who)) - before;
    // A rebasing transfer may deliver a wei or two less; never more.
    if (got > units || units - got > 2n) this.violate('L3', `${context}: withdrawOwed paid ${got}, event says ${units}`);
    if (BigInt(await this.view('owedShares', [who])) !== 0n) this.violate('L3', `${context}: credit left after withdrawal`);
    if (caller !== who && (await this.balanceOf(caller)) !== callerBefore) this.violate('L3', `${context}: the caller of withdrawOwed was paid`);
    return res;
  }

  async opTime() {
    const r = this.r;
    await this.b.advance(r.pick([60n, 3600n, 86400n, EPOCH, EPOCH + 1n, 3n * EPOCH]));
  }

  /** Seal a root carrying a random mix of every leaf kind. */
  async opSeal() {
    const r = this.r;
    const c = this.b.chainId;
    const now = await this.epoch();
    const items = [];

    if (r.chance(0.7)) {
      const bad = r.chance(0.1);
      const a = { epoch: now, sigmaBps: bad ? 4001 : r.int(4001), bufferBps: 250 + r.int(751), operationsBps: 250 + r.int(500), jurorFeeShareBps: r.int(5001), levyBps: r.int(501), sigmaTargetBps: r.int(4001), coveredBps: r.int(10001), psrCapBps: r.int(25801), commitTermEpochs: r.int(27) };
      if (a.sigmaBps + a.bufferBps + a.operationsBps + a.levyBps > 10_000) a.sigmaBps = 0;
      items.push({ kind: 'allocation', leaf: ids.allocationLeaf({ ...a, escrow: this.escrow }), a, forged: bad });
    }
    const open = [...this.positions.entries()].filter(([, p]) => !p.released);
    for (let i = 0; i < r.int(4) && open.length; i++) {
      const [id, p] = open.splice(r.int(open.length), 1)[0];
      const recipient = r.pick(this.recipients);
      const leaf = ids.releaseLeaf(this.escrow, ids.releasePayload({ id, recipient, claimNonce: 1n, chainId: c }));
      items.push({ kind: 'release', leaf, id, recipient });
      p.sealedRelease = true;
    }
    if (r.chance(0.35)) {
      const pot = BigInt(await this.view('auctionShares'));
      // A lot of up to the whole pot, one in three larger than it.
      const shares = r.chance(0.3) ? pot + ONE : (pot * BigInt(r.int(60) + 1)) / 100n;
      if (shares > 0n) {
        // Mostly an expiry an epoch or two out; sometimes one already past by
        // the time the lock is presented.
        const nowTs = await this.b.now();
        const evmExpiry = nowTs + (r.chance(0.8) ? EPOCH + BigInt(r.int(Number(EPOCH))) : BigInt(r.int(3600)));
        const secret = keccak256(toUtf8Bytes(`secret-${now}-${r.int(1e9)}`));
        const lock = { chainId: c, escrow: this.escrow, asset: this.asset, lotId: keccak256(toUtf8Bytes(`lot-${now}-${r.int(1e9)}`)), hashlock: ids.hashlockOf(secret), recipient: r.pick(this.recipients), shares, evmExpiry, epoch: now, bond: shares / 40n };
        items.push({ kind: 'premium', leaf: ids.premiumLockLeaf(lock), lock, secret });
        this.claims.sealed += 1;
      }
    }
    if (r.chance(0.2)) {
      const buf = await this.view('bufferShares');
      const q = r.chance(0.3) ? BigInt(await this.view('toUnits', [buf])) + ONE : (BigInt(await this.view('toUnits', [buf])) * BigInt(r.int(40) + 1)) / 100n;
      const ids_ = [...this.positions.keys()];
      if (q > 0n && ids_.length) {
        // One in ten names a position no escrow ever recorded.
        const bogus = r.chance(0.1);
        const stakeAssetId = bogus ? keccak256(toUtf8Bytes(`nobody-${r.int(1e9)}`)) : r.pick(ids_);
        const l = { chainId: c, escrow: this.escrow, determinationId: keccak256(toUtf8Bytes(`det-${now}-${r.int(1e9)}`)), stakeAssetId, destination: r.pick(this.recipients), quantity: q };
        items.push({ kind: 'loss', leaf: ids.lossLeaf(l), l, bogus });
      }
    }
    if (r.chance(0.1)) {
      const q = r.big(1n, 20n) * ONE;
      const s = { chainId: c, escrow: this.escrow, successorId: '0x' + '00'.repeat(32), recoveryId: keccak256(toUtf8Bytes(`rec-${now}-${r.int(1e9)}`)), recipient: keccak256(toUtf8Bytes(`who-${r.int(1e9)}`)), destination: r.pick(this.recipients), quantity: q };
      items.push({ kind: 'recovery', leaf: ids.shareLeaf(s), s });
    }
    if (!this.closed && r.chance(0.15)) {
      const frozen = !this.frozen;
      items.push({ kind: 'freeze', leaf: ids.freezeLeaf(c, this.escrow, frozen), frozen });
    }
    if (r.chance(0.01)) items.push({ kind: 'close', leaf: ids.closeLeaf(c, this.escrow) });
    if (r.chance(0.01)) items.push({ kind: 'delist', leaf: ids.delistLeaf(c, this.escrow, this.asset) });
    if (!items.length) return;

    const s = await this.seal(items.map((x) => x.leaf));
    if (!s) return;
    for (const it of items) this.sealed.push({ ...it, epoch: s.epoch, proof: s.proof(it.leaf), consumed: false });
    // A solver claims its lot as soon as the root carrying it is in, because
    // its window closes at evmExpiry; most are claimed here.
    for (const it of this.sealed.slice(-items.length)) {
      if (it.kind === 'premium' && r.chance(0.7)) await this.claimLot(it);
    }
  }

  /** Present a sealed leaf — honestly, twice, early, or tampered. */
  async opPresent() {
    const r = this.r;
    if (!this.sealed.length) return;
    const it = r.pick(this.sealed);
    const tamper = r.chance(0.25);
    const e = it.epoch;
    const p = it.proof;
    let res;
    switch (it.kind) {
      case 'allocation': {
        const a = it.a;
        const rates = ids.ALLOCATION_FIELDS.map((f) => a[f]);
        if (tamper) rates[3] = (a.jurorFeeShareBps + 1) % 5001;
        res = await this.escrowSend('recordEpochAllocation', [e, rates, p]);
        if (res.ok && (it.forged || tamper)) this.violate('S8', `allocation ${tamper ? 'tampered' : 'out of range'} recorded for epoch ${e}`);
        break;
      }
      case 'release': {
        const recipient = tamper ? r.pick(this.recipients.filter((x) => x !== it.recipient)) : it.recipient;
        res = await this.escrowSend('release', [it.id, recipient, 1n, e, p], r.pick(this.accounts));
        if (res.ok) {
          if (tamper) this.violate('S8', `release paid to a substituted recipient ${recipient}`);
          const names = this.parse(res.logs).map((ev) => ev.name);
          if (!names.includes('ReleaseQueued')) {
            // Presented before its unbonding, or under the freeze: into
            // transit, consumed later (X7). Once only (S12).
            if (!names.includes('TransitMarked')) this.violate('S12', `release of ${it.id.slice(0, 12)} succeeded doing nothing`);
            if (it.transit) this.violate('S12', `release of ${it.id.slice(0, 12)} marked into transit twice`);
            it.transit = true;
            this.positions.get(it.id).transit = true;
            await this.account(res.logs, 'transit');
            break;
          }
          if (it.consumed) this.violate('S8', `release ${it.id.slice(0, 12)} consumed twice`);
          it.consumed = true;
          this.positions.get(it.id).released = true;
          this.positions.get(it.id).transit = false;
          await this.account(res.logs, 'release');
        }
        break;
      }
      case 'premium':
        res = await this.claimLot(it, { tamper, guess: r.chance(0.15) });
        break;
      case 'loss': {
        const l = it.l;
        const args = [l.determinationId, l.stakeAssetId, tamper ? r.pick(this.recipients) : l.destination, l.quantity, e, p];
        const targets = this.twin ? (r.chance(0.5) ? ['primary', 'twin'] : ['twin', 'primary']) : ['primary'];
        for (const target of targets) {
          const escrow = target === 'twin' ? this.twin.escrow : this.escrow;
          res = await this.attempt(escrow, this.escrowAbi, 'settleLoss', args);
          if (!res.ok) continue;
          if (target === 'twin') this.violate('X1', 'a loss leaf bound to the primary escrow paid at its twin (D10)');
          const paid = this.lossPaidAt.get(it.leaf) || new Set();
          paid.add(target);
          this.lossPaidAt.set(it.leaf, paid);
          if (paid.size > 1) this.violate('X1', `one loss leaf paid at ${[...paid].join(' and ')}`);
          if (target === 'primary') {
            if (it.consumed) this.violate('S8', 'loss settlement consumed twice');
            it.consumed = true;
            await this.account(res.logs, 'settleLoss');
          }
        }
        break;
      }
      case 'recovery': {
        const s = it.s;
        res = await this.escrowSend('releaseShare', [s.successorId, s.recoveryId, s.recipient, s.destination, tamper ? s.quantity - 1n : s.quantity, e, p]);
        if (res.ok) {
          if (tamper) this.violate('S8', 'recovery share paid a tampered quantity');
          if (it.consumed) this.violate('S8', 'recovery share consumed twice');
          it.consumed = true;
          await this.account(res.logs, 'releaseShare');
        }
        if (this.twin && !tamper && !it.twinConsumed) {
          // The share binds the escrow that pays it (D10): at the twin it is a
          // leaf no root carries. Paid there, R25 is open again.
          const t = await this.attempt(this.twin.escrow, this.escrowAbi, 'releaseShare', [s.successorId, s.recoveryId, s.recipient, s.destination, s.quantity, e, p]);
          if (t.ok) {
            it.twinConsumed = true;
            this.recoveryPaidTwice += 1;
            this.violate('X1', 'a recovery share bound to the primary escrow paid at its twin (D10)');
          }
        }
        break;
      }
      case 'freeze': {
        res = await this.attempt(this.relay, ABI.relay, 'setFrozen', [this.escrow, tamper ? !it.frozen : it.frozen, e, p]);
        if (res.ok) {
          if (tamper) this.violate('S8', 'freeze set from a leaf naming the other value');
          this.frozen = (await this.relayView('controlOf', [this.escrow])).frozen;
        }
        break;
      }
      case 'close': {
        res = await this.attempt(this.relay, ABI.relay, 'close', [this.escrow, e, p]);
        if (res.ok) {
          this.closed = true;
          this.log(`   closed at epoch ${await this.epoch()}`);
        }
        break;
      }
      case 'delist': {
        res = await this.escrowSend('closeAnchoring', [e, p]);
        break;
      }
      default:
    }
  }

  /** Claim a premium lot: honestly, with its shares tampered, or with a guessed preimage. */
  async claimLot(it, { tamper = false, guess = false } = {}) {
    const w = it.lock;
    const shares = tamper ? w.shares + 1n : w.shares;
    const secret = guess ? keccak256(toUtf8Bytes(`guess-${this.r.int(1e9)}`)) : it.secret;
    const before = BigInt((await this.b.call(this.asset, this.tokenAbi, 'balanceOf', [w.recipient]))[0]);
    // What the shares are worth now: the solver bought shares, so a rebase
    // since the quote, either way, is the solver's.
    const due = BigInt(await this.view('toUnits', [w.shares]));
    const nowTs = await this.b.now();
    const res = await this.escrowSend('claimPremium', [[w.lotId, w.hashlock, w.recipient, shares, w.evmExpiry, w.epoch, w.bond], it.epoch, it.proof, secret], this.r.pick(this.accounts));
    if (!res.ok) return res;
    if (tamper) this.violate('S8', 'a premium lock paid a tampered share count');
    if (guess) this.violate('S11', 'a premium lock paid against a guessed preimage');
    if (it.consumed) this.violate('S8', 'a premium lock paid twice');
    if (nowTs >= w.evmExpiry) this.violate('S11', 'a premium lock paid at or after its evmExpiry');
    it.consumed = true;
    this.claims.paid += 1;
    const after = BigInt((await this.b.call(this.asset, this.tokenAbi, 'balanceOf', [w.recipient]))[0]);
    // The claim settles first, and the operations share it pays may be the
    // payment deferred; only a deferral to the lot's recipient is the lot's.
    const deferred = this.parse(res.logs).some((ev) => ev.name === 'PaymentDeferred' && getAddress(ev.args.recipient) === getAddress(w.recipient));
    if (deferred) {
      this.deferred += 1;
      if (after !== before) this.violate('S11', `a deferred premium claim still moved ${after - before}`);
    } else if (after - before > due || due - (after - before) > 2n) {
      // A rebasing transfer may deliver a wei or two less; never more.
      this.violate('S11', `a lot paid ${after - before}; its shares are worth ${due}`);
    }
    return res;
  }

  /* -------------------------------------------------------------- invariants */

  async check(step) {
    const v = (f, a) => this.view(f, a).then(BigInt);
    const held = await v('sharesHeld');
    const pos = await v('positionShares');
    const buf = await v('bufferShares');
    const pot = await v('auctionShares');
    const queued = await v('queuedShares');
    const queuedRel = await v('queuedReleaseShares');
    const head = await v('queueHead');
    const tail = await v('queueTail');
    const base = await v('queueBase');
    const reclaimed = await this.view('releasesReclaimed');
    const unclaimed = await v('unclaimedShares');

    if (held < pos + buf + pot + queued + unclaimed) this.violate('S1', `step ${step}: held ${held} < owed ${pos + buf + pot + queued + unclaimed}`);

    let credits = 0n;
    for (const who of this.payees) credits += await v('owedShares', [who]);
    if (credits !== unclaimed) this.violate('S10', `step ${step}: credits sum ${credits}, unclaimedShares ${unclaimed}`);

    if (this.twin) {
      const tv = async (f) => BigInt((await this.b.call(this.twin.escrow, this.escrowAbi, f, []))[0]);
      const tHeld = await tv('sharesHeld');
      let tOwed = 0n;
      for (const f of ['positionShares', 'bufferShares', 'auctionShares', 'queuedShares', 'unclaimedShares', 'psrShares']) tOwed += await tv(f);
      if (tHeld < tOwed) this.violate('S1', `step ${step}: twin held ${tHeld} < owed ${tOwed}`);
    }
    if (head > tail) this.violate('S4', `step ${step}: head ${head} > tail ${tail}`);
    if (head === tail && base !== 0n) this.violate('S4', `step ${step}: empty queue with base ${base}`);
    if (queuedRel > queued) this.violate('S3', `step ${step}: queuedReleaseShares ${queuedRel} > queuedShares ${queued}`);

    // Walk the queue only while it is short enough to read cheaply.
    if (tail - head <= 400n) {
      let sum = 0n;
      let rel = 0n;
      for (let i = head; i < tail; i++) {
        const q = await this.view('queueEntry', [i]);
        const kind = Number(q.kind);
        if (kind === 0) continue;
        if (kind === 1) {
          if (reclaimed) continue;
          rel += BigInt(q.sharesRemaining);
        }
        sum += BigInt(q.sharesRemaining);
      }
      // A position in transit (X7) is counted with the releases and has no
      // entry until its receipt is consumed; at the declaration it went to
      // the recovered pool with them.
      let transit = 0n;
      if (!reclaimed) {
        for (const [id, pos] of this.positions) if (pos.transit && !pos.twin) transit += await v('transitShares', [id]);
      }
      if (sum + transit !== queued) this.violate('S2', `step ${step}: queue entries sum ${sum} + transit ${transit}, queuedShares ${queued}`);
      if (!reclaimed && rel + transit !== queuedRel) this.violate('S3', `step ${step}: release entries ${rel} + transit ${transit}, queuedReleaseShares ${queuedRel}`);
    }

    for (const [e, paid] of this.paidInEpoch) {
      const b = this.baseInEpoch.get(e) || 0n;
      let bound = (b * BOUND_BPS) / BPS;
      if (bound === 0n) bound = 1n;
      // A queue that empties and reopens inside one epoch keeps its count; the
      // largest base seen in the epoch is the most the rule could allow.
      if (paid > bound && b !== 0n) this.violate('S5', `epoch ${e}: paid ${paid} shares, bound ${bound} on base ${b}`);
    }
  }

  /* -------------------------------------------------------------- liveness */

  /** Every entry still in the queue is a loss claim, and the buffer that pays them is empty. */
  async onlyOutstandingLoss() {
    if (BigInt(await this.view('bufferShares')) !== 0n) return false;
    const head = BigInt(await this.view('queueHead'));
    const tail = BigInt(await this.view('queueTail'));
    for (let i = head; i < tail; i++) {
      const kind = Number((await this.view('queueEntry', [i])).kind);
      if (kind !== 0 && kind !== 2) return false;
    }
    return head !== tail;
  }

  async finish() {
    const b = this.b;
    // Lift a standing freeze the honest way: a later root naming the lift.
    if (this.frozen && !this.closed) {
      const lift = ids.freezeLeaf(b.chainId, this.escrow, false);
      const s = await this.seal([lift]);
      if (s) {
        await this.attempt(this.relay, ABI.relay, 'setFrozen', [this.escrow, false, s.epoch, s.proof(lift)]);
        this.frozen = (await this.relayView('controlOf', [this.escrow])).frozen;
      }
    }
    // L1 is progress, not a deadline: every epoch with the queue open must pay
    // something. How long clearing takes is recorded, not judged — a base fixed
    // at a small opening holding makes a later large release wait many epochs
    // (E4), which whitepaper §3.3 as written allows and the audit raises.
    let drainEpochs = 0;
    for (; drainEpochs < 600; drainEpochs++) {
      const head = BigInt(await this.view('queueHead'));
      const tail = BigInt(await this.view('queueTail'));
      if (head === tail) break;
      // Progress is shares paid out of the queue or units paid on a loss
      // claim: `queuedShares` alone also counts positions in transit (X7),
      // which no drain moves, and a loss settlement is paid in units.
      const owing = async () => BigInt(await this.view('queuedShares')) + BigInt(await this.view('lossOwedUnits'));
      const before = await owing();
      await b.advance(EPOCH);
      const res = await this.escrowSend('drainQueue', [256n]);
      if (res.ok) await this.account(res.logs, 'final drain');
      const after = await owing();
      if (after >= before && !this.closed) {
        // An outstanding loss claim on an empty buffer waits for the buffer's
        // next inflow (D17, whitepaper §5.2), and nothing in this drain brings
        // one; it holds nothing behind it. Anything else is a stall.
        if (await this.onlyOutstandingLoss()) {
          this.outstandingLoss = true;
          break;
        }
        this.violate('L1', `an epoch with the queue open paid nothing (${before} queued)`);
        break;
      }
    }
    this.drainEpochs = drainEpochs;
    if (drainEpochs > 5) this.log(`   E4 observed: the final queue took ${drainEpochs} draining epochs on its fixed base`);
    const head = BigInt(await this.view('queueHead'));
    const tail = BigInt(await this.view('queueTail'));
    if (head !== tail && !this.outstandingLoss && (await this.onlyOutstandingLoss())) this.outstandingLoss = true;
    if (head !== tail && !this.outstandingLoss) this.violate('L1', `queue ${head}..${tail} never emptied (frozen ${this.frozen}, closed ${this.closed})`);
    if (this.outstandingLoss) this.log(`   L1: the queue ends on an outstanding loss claim, the buffer empty (D17)`);

    // L3: lift every block; each credit is then paid to its payee, except a
    // credit to the token itself, which the asset refuses for ever and which
    // must say so by name.
    if (this.strict && this.form === 'units') {
      for (const who of [...this.blocked]) await b.send(this.asset, this.tokenAbi, 'setBlocked', [who, false]);
      this.blocked.clear();
    }
    for (const who of this.payees) {
      const owedShares = BigInt(await this.view('owedShares', [who]));
      if (owedShares === 0n) continue;
      const res = await this.withdrawFor(who, 'final');
      const selfRefusing = this.strict && getAddress(who) === getAddress(this.asset);
      if (selfRefusing) {
        if (res.ok || res.name !== 'PaymentRefused') this.violate('L3', `a credit to the token itself answered ${res.ok ? 'ok' : res.name}`);
      } else if (!res.ok && !(res.name === 'NothingOwed' && BigInt(await this.view('toUnits', [owedShares])) === 0n)) {
        this.violate('L3', `credit of ${owedShares} to ${who} not paid: ${res.name}`);
      }
    }

    await this.escrowSend('sweep', []);
    const held = BigInt(await this.view('sharesHeld'));
    const owed = ['positionShares', 'bufferShares', 'auctionShares', 'queuedShares', 'unclaimedShares', 'psrShares'].map(async (f) => BigInt(await this.view(f)));
    const sum = (await Promise.all(owed)).reduce((a, x) => a + x, 0n);
    // A remainder worth zero units cannot be swept and belongs to nobody; it
    // is dust, not a leak. Anything worth a unit is.
    if (held < sum || (held > sum && BigInt(await this.view('toUnits', [held - sum])) > 0n)) {
      this.violate('L2', `after a final sweep held ${held} != owed ${sum}`);
    }
  }
}

/* ------------------------------------------------------------------ */

async function fuzz(backend, form, seed, steps, log, flags = {}) {
  const r = rng(seed);
  const w = new World(backend, form, r, log, flags);
  await w.setup();
  const table = [
    [w.opAnchor, 18],
    [w.opYield, 10],
    [w.opSweep, 8],
    [w.opSeal, 12],
    [w.opPresent, 30],
    [w.opDrain, 10],
    [w.opTime, 12],
    [w.opBlock, flags.strict && form === 'units' ? 4 : 0],
    [w.opWithdraw, flags.strict ? 5 : 1],
  ];
  const total = table.reduce((a, [, x]) => a + x, 0);
  for (let step = 0; step < steps; step++) {
    let roll = r.int(total);
    const [fn] = table.find(([, x]) => (roll -= x) < 0);
    await fn.call(w);
    await w.check(step);
    if (w.violations.length > 20) break;
  }
  await w.finish();
  await w.check('final');
  return w;
}

/**
 * The release wave of whitepaper §3.3 at scale: every position released at
 * once must clear in the unbonding plus four draining epochs (I25).
 */
async function wave(backend, form, n, log, flags = {}) {
  const r = rng(424242);
  const w = new World(backend, form, r, log, { strict: flags.strict });
  await w.setup();
  const c = backend.chainId;
  for (let i = 0; i < n; i++) {
    const from = w.accounts[i % w.accounts.length];
    const amount = r.big(1n, 50n) * ONE;
    await w.mint(from, amount);
    await backend.send(w.asset, w.tokenAbi, 'approve', [w.escrow, amount], from);
    const res = await w.escrowSend('anchor', [w.recipients[i % w.recipients.length], amount], from);
    for (const ev of w.parse(res.logs || [])) if (ev.name === 'Anchored') w.positions.set(ev.args.stakeAssetId, { recipient: w.recipients[i % w.recipients.length] });
  }
  const leaves = [...w.positions.entries()].map(([id, p]) => ({ id, recipient: p.recipient, leaf: ids.releaseLeaf(w.escrow, ids.releasePayload({ id, recipient: p.recipient, claimNonce: 1n, chainId: c })) }));
  const s = await w.seal(leaves.map((x) => x.leaf));
  await backend.advance(4n * EPOCH);
  const firstEpoch = await w.epoch();
  let maxGas = 0n;
  for (const l of leaves) {
    const res = await w.escrowSend('release', [l.id, l.recipient, 1n, s.epoch, s.proof(l.leaf)]);
    if (!res.ok) w.violate('W', `release ${l.id.slice(0, 12)} refused ${res.name}`);
    else await w.account(res.logs, 'wave release');
  }
  maxGas = w.gas.get('release') || 0n;
  let epochs = 0;
  for (; epochs < 12; epochs++) {
    const head = BigInt(await w.view('queueHead'));
    const tail = BigInt(await w.view('queueTail'));
    if (head === tail) break;
    for (let k = 0; k < 64; k++) {
      const res = await w.escrowSend('drainQueue', [32n]);
      if (res.ok) await w.account(res.logs, 'wave drain');
      if (BigInt(await w.view('releaseBudgetRemaining')) === 0n) break;
      if (BigInt(await w.view('queueHead')) === BigInt(await w.view('queueTail'))) break;
    }
    await backend.advance(EPOCH);
  }
  await w.check('wave');
  // Four epochs of 2,500 bps on a fixed base clear the whole book; the epoch the
  // releases arrive in counts as the first.
  if (epochs > 4) w.violate('I25', `a wave of ${n} took ${epochs} draining epochs from epoch ${firstEpoch}`);
  log(`   wave: ${n} positions cleared in ${epochs} draining epoch(s); max release gas ${maxGas}, max drain gas ${w.gas.get('drainQueue') || 0n}`);
  return w;
}

async function main() {
  const kind = opt('backend', 'harness');
  const forms = opt('form', 'both') === 'both' ? ['units', 'shares'] : [opt('form')];
  const steps = Number(opt('steps', '400'));
  const runs = Number(opt('runs', '1'));
  const seed0 = Number(opt('seed', '1'));
  const waveN = Number(opt('wave', '0'));
  const flags = { strict: argv.includes('--strict'), twin: argv.includes('--twin') };
  const log = console.log;
  let violations = 0;

  const make = () => (kind === 'hardhat' ? hardhatBackend({ buildDir: BUILD, url: opt('url', 'http://127.0.0.1:8546') }) : harnessBackend({ buildDir: BUILD }));

  for (const form of forms) {
    for (let k = 0; k < runs; k++) {
      const seed = seed0 + k;
      const b = await make();
      const t0 = Date.now();
      const w = await fuzz(b, form, seed, steps, log, flags);
      violations += w.violations.length;
      const top = [...w.reverts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k2, n]) => `${k2}×${n}`).join(', ');
      const mode = [flags.strict && 'strict', flags.twin && 'twin'].filter(Boolean).join('+');
      log(`${kind} ${form}${mode ? ` [${mode}]` : ''} seed ${seed}: ${steps} steps, ${w.positions.size} positions, ${w.sealed.length} sealed leaves, ${w.violations.length} violation(s), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      log(`   refusals: ${top}`);
      log(`   payments deferred ${w.deferred}, credits withdrawn ${w.withdrawn}${flags.twin ? `, loss leaves paid, each at one escrow only, ${w.lossPaidAt.size}, recovery shares paid at both (must be 0 since D10) ${w.recoveryPaidTwice}` : ''}`);
      log(`   premium locks sealed ${w.claims.sealed}, paid ${w.claims.paid}`);
      log(`   max gas: ${[...w.gas.entries()].map(([m, g]) => `${m} ${g}`).join(', ')}`);
      await b.close();
    }
    if (waveN) {
      const b = await make();
      const w = await wave(b, form, waveN, log, flags);
      violations += w.violations.length;
      await b.close();
    }
  }
  log(violations ? `\n${violations} violation(s)` : '\nno violations');
  process.exit(Math.min(violations, 100));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(101);
  });
}

module.exports = { fuzz, wave, World, rng };
void coder;
