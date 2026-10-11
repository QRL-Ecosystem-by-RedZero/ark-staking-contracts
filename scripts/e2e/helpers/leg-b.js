/**
 * Leg B as a scenario holds it (OC audit 2026-10-03, LEG-B "On-chain
 * scenarios needed"): the QRL registry, the parameter set, the staking pool,
 * its delegation and the bond's staking contract, read and driven the same
 * way on the harness and on a QIP-55 node.
 *
 * What it settles once:
 *   - the two transports. On the harness an ethers Interface encodes and
 *     decodes 32-byte words; on a QRL node the client's 64-byte codec does,
 *     and events are decoded with `decodeQrlLogs` against a table built here
 *     from the ABI (ethers cannot read a 64-byte slot).
 *   - the beacon chain's stand-ins, harness only, each refused on a live
 *     chain by name: a validator's deposit data written for this
 *     delegation's own credentials (the genesis deposit contract recomputes
 *     the deposit data root and checks no signature, test/ArkBondDelegation),
 *     ZVM's `depositroot` precompile at 0x01 (the harness client is built on
 *     the origin build, which keeps stock `ecrecover` there), a withdrawal
 *     sweep (a balance credit that runs no code), and the attester quorum's
 *     reports, sealed into MockAttestation.
 *
 * Nothing here decides a rule; the scenarios do.
 */
const crypto = require('crypto');
const { keccak256, toUtf8Bytes, Interface, getBytes } = require('ethers');
const { iface, qrlBuild, parseLogs, decodeQrlLogs } = require('../../lib/chains');
const { revertName } = require('../../../ecdsa-stakings/relayer/engine/errors');
const { buildTree, proofFor } = require('../../../ecdsa-stakings/relayer/lib/merkle');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

const ONE = 10n ** 18n;
const VALIDATOR = 40_000n * ONE;
/** Beacon API status ordinals, as a report carries them (IArkBondDelegation). */
const STATUS = { pending: 0, active: 2, exiting: 3, slashed: 4, exited: 5, exitedSlashed: 6, possible: 7, done: 8 };
/** `ArkBondDelegation` forfeit reasons. */
const FORFEIT = { slashed: 1, deadline: 2, credentials: 3 };
/** `ArkBondStaking` request kinds. */
const KIND = { principal: 1, distribution: 2 };

const K = (name) => keccak256(toUtf8Bytes(name));
/** Lowercase 0x form of an account (Q form accepted); any other hex (bytes, words) lowercased as it is. */
const lower = (a) => {
  try {
    return toHex(String(a)).toLowerCase();
  } catch {
    return String(a).replace(/^Q/, '0x').toLowerCase();
  }
};
const same = (a, b) => Boolean(a) && Boolean(b) && lower(a) === lower(b);
const isZero = (a) => !a || /^0x0*$/.test(lower(a));
/** Two encodings of one origin-chain account: 20 bytes, or zero-extended to the 64-byte QRVM slot. */
const sameEvm = (a, b) => {
  const x = lower(a).slice(2);
  const y = lower(b).slice(2);
  return x.slice(-40) === y.slice(-40) && /^0*$/.test(x.slice(0, -40)) && /^0*$/.test(y.slice(0, -40));
};

const NAMES = {
  D: 'ArkBondDelegation',
  P: 'ArkStakingPool',
  S: 'ArkBondStaking',
  Pa: 'ArkStakeParams',
  R: 'ArkStakeRegistry',
  A: 'MockAttestation',
  B: 'ArkCatBond',
};

/** A function's result as plain values: one value, or an object by output name (a struct by position, OC-OPS-02). */
function plain(abi, method, res) {
  const out = abi.getFunction(method).outputs;
  if (out.length === 1 && out[0].components) {
    const t = res[0];
    return Object.fromEntries(out[0].components.map((c, i) => [c.name, t[i]]));
  }
  if (out.length === 1) return res[0];
  return Object.fromEntries(out.map((o, i) => [o.name || String(i), res[i]]));
}

/** The QIP-55 decode table of one event, from its ABI fragment: indexed members as topics, then the static data members. */
function v3Spec(abi, name, overrides = {}) {
  const ev = abi.getEvent(name);
  const topics = [];
  const data = [];
  let dynamic = false;
  for (const i of ev.inputs) {
    const type = overrides[i.name] || i.type;
    if (i.indexed) topics.push({ name: i.name, type });
    else if (!dynamic && /^(uint\d*|bool|bytes32|address)$/.test(i.type)) data.push({ name: i.name, type });
    else dynamic = true;
  }
  return { signature: `${name}(${ev.inputs.map((i) => i.type).join(',')})`, topics, data };
}

/** Origin-chain accounts carried in QRL event slots. */
const EVM_FIELDS = { ReleaseInstructed: { recipient: 'evmAddress' } };

/* -------------------------------------------------------- deposit data */

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
/** The SSZ root of a DepositData, as qrysm and ZVM's `depositroot` compute it (test/ArkBondDelegation.test.js). */
function depositDataRoot(pubkey, credentials, amountWei, signature) {
  const amount = Buffer.alloc(32);
  amount.writeBigUInt64LE(amountWei / 10n ** 9n);
  const hex = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
  return '0x' + merkleize([packed(hex(pubkey)), hex(credentials), amount, packed(hex(signature))]).toString('hex');
}

const ZVM_PUBKEY = 2592;
const ZVM_SIGNATURE = 4627;
const DEPOSIT_DATA = ZVM_PUBKEY + 32 + 8 + ZVM_SIGNATURE;

const DEPOSIT_IFACE = new Interface([
  'function get_deposit_count() view returns (bytes)',
  'function get_deposit_root() view returns (bytes32)',
]);

class LegB {
  constructor(ctx) {
    this.ctx = ctx;
    this.q = ctx.r.q;
    this.build = qrlBuild(ctx.r.manifest.profile);
    this.live = ctx.qrl.kind === 'qrl';
    this.harness = !this.live && Boolean(ctx.qrl.chain);
    this.addr = Object.fromEntries(Object.entries(NAMES).map(([k, n]) => [k, this.q[n]]));
  }

  abi(k) {
    return iface(NAMES[k] || k, this.build);
  }

  /** A view as plain values. `opts.from` names the caller of an eth_call. */
  async view(k, m, args = [], opts = {}) {
    const abi = this.abi(k);
    return plain(abi, m, await this.ctx.qrl.call(this.addr[k], abi, m, args, opts));
  }

  async big(k, m, args = [], opts = {}) {
    return BigInt(await this.view(k, m, args, opts));
  }

  /** An eth_call that may revert: for `ctx.refuses`. */
  call(k, m, args = [], opts = {}) {
    return this.ctx.qrl.call(this.addr[k], this.abi(k), m, args, opts);
  }

  /** A send, from `as` (a client: the relayer's, or an actor's). */
  send(k, m, args = [], { as = this.ctx.qrl, ...opts } = {}) {
    return as.send(this.addr[k], this.abi(k), m, args, opts);
  }

  /** The revert name of `fn()`, or null where it succeeds. */
  async outcome(fn) {
    try {
      await fn();
      return null;
    } catch (e) {
      return revertName(this.ctx.r.errors, e);
    }
  }

  /** Events `name` of contract `k` in `logs`, args as plain values (addresses 0x, numbers BigInt). */
  decode(k, logs, name) {
    const at = this.addr[k];
    const mine = (logs || []).filter((l) => same(l.address, at));
    const abi = this.abi(k);
    let found;
    if (this.live) {
      found = decodeQrlLogs({ [name]: v3Spec(abi, name, EVM_FIELDS[name]) }, mine);
    } else {
      found = parseLogs(abi, mine).filter((x) => x.name === name).map((x) => {
        const ev = abi.getEvent(name);
        return { ...x, args: Object.fromEntries(ev.inputs.map((i, n) => [i.name, x.args[n]])) };
      });
    }
    return found.map((x) => ({
      ...x,
      args: Object.fromEntries(Object.entries(x.args).map(([n, v]) => [n, typeof v === 'string' && /^(0x|Q)[0-9a-fA-F]{40,128}$/.test(v) && v.length !== 66 ? lower(v) : typeof v === 'number' ? BigInt(v) : v])),
    }));
  }

  /** Events `name` of contract `k` since `fromBlock`. */
  async events(k, name, fromBlock = this.deployedFrom) {
    const head = await this.ctx.qrl.head();
    return this.decode(k, await this.ctx.qrl.logs(this.addr[k], fromBlock, head.latest), name);
  }

  get deployedFrom() {
    return BigInt(this.ctx.r.deployment.deployedFromBlock || 0);
  }

  async head() {
    return (await this.ctx.qrl.head()).latest;
  }

  async now() {
    return (await this.ctx.qrl.head()).timestamp;
  }

  async epoch() {
    return this.ctx.clock.epochOf(await this.now());
  }

  /** Tick until epoch `e` has begun. */
  async untilEpoch(label, e) {
    const left = Number(BigInt(e) - (await this.epoch()));
    await this.ctx.waitFor(label, async () => (await this.epoch()) >= BigInt(e), { timeoutEpochs: Math.max(left, 0) + 2 });
  }

  /** Tick until the chain's clock reaches `t`. */
  async until(label, t) {
    const left = BigInt(t) - (await this.now());
    const E = BigInt(this.ctx.clock.EPOCH_LENGTH);
    await this.ctx.waitFor(label, async () => (await this.now()) >= BigInt(t), { timeoutEpochs: left > 0n ? Number(left / E) + 2 : 1 });
  }

  /* ------------------------------------------------------- the venue */

  /** The delegation's balance against what ranks ahead of distribution (I21, I32; venue solvency). */
  async solvency() {
    const v = (m) => this.big('D', m);
    const balance = BigInt(await this.ctx.qrl.balance(this.addr.D));
    const idle = await v('idle');
    const bondsHeld = await v('bondsHeld');
    const refundsOwed = await v('refundsOwed');
    const reconciled = await v('distributionReconciled');
    const distributed = await v('distributed');
    const owed = idle + bondsHeld + refundsOwed + (reconciled > distributed ? reconciled - distributed : 0n);
    return { ok: balance >= owed, balance, owed, short: owed > balance ? owed - balance : 0n, idle, bondsHeld, refundsOwed, distributionReconciled: reconciled, distributed };
  }

  /**
   * The delegation's ledger rebuilt from its `Delegated` events (LEG-B
   * probe "D ledger"): Σ(stake − returned) over open validators is
   * `delegated`, and their count is `activeValidators`.
   */
  async ledger() {
    const keys = [...new Set((await this.events('D', 'Delegated')).map((x) => x.args.pubkeyHash))];
    let open = 0n;
    let count = 0n;
    let exiting = 0n;
    for (const k of keys) {
      const v = await this.view('D', 'validatorOf', [k]);
      if (BigInt(v.stake) !== 0n && !v.closed) {
        count += 1n;
        open += BigInt(v.stake) - BigInt(v.principalReturned);
        if (BigInt(v.exitRequestedEpoch) !== 0n) exiting += BigInt(v.stake) - BigInt(v.principalReturned);
      }
    }
    const delegated = await this.big('D', 'delegated');
    const active = await this.big('D', 'activeValidators');
    const exitsPending = await this.big('D', 'exitsPending');
    return { ok: open === delegated && count === active && exiting === exitsPending, validators: keys.length, open, delegated, count, active, exiting, exitsPending };
  }

  async poolValue(who) {
    return this.big('P', 'positionValue', [who]);
  }

  /* ----------------------------------------- the beacon chain, harness */

  refuseLive(what) {
    if (!this.harness) throw new Error(`${what} is a harness stand-in; refused on a live chain`);
  }

  /**
   * ZVM's `depositroot` at 0x01 on this harness chain, beside `ecrecover`:
   * an input of exactly one DepositData (7,259 bytes) is answered with its
   * SSZ root, as the node does; anything else goes to the stock precompile,
   * so the origin leg on the same chain is unaffected. Idempotent.
   */
  installDepositRoot() {
    this.refuseLive('the depositroot precompile');
    const evm = this.ctx.qrl.chain.vm.evm;
    const key = '0000000000000000000000000000000000000001';
    const original = evm.getPrecompile(`0x${key}`);
    if (original && original.__arkDepositRoot) return;
    const wrapped = (opts) => {
      const data = Buffer.from(opts.data);
      if (data.length !== DEPOSIT_DATA) return original(opts);
      const gas = 60n + 12n * BigInt(Math.ceil(data.length / 32));
      const amount = Buffer.alloc(32);
      data.copy(amount, 0, ZVM_PUBKEY + 32, ZVM_PUBKEY + 40);
      const root = merkleize([packed(data.subarray(0, ZVM_PUBKEY)), data.subarray(ZVM_PUBKEY, ZVM_PUBKEY + 32), amount, packed(data.subarray(ZVM_PUBKEY + 40))]);
      return { executionGasUsed: gas, returnValue: new Uint8Array(root) };
    };
    wrapped.__arkDepositRoot = true;
    evm._precompiles.set(key, wrapped);
  }

  /** Deposit data for fixture key `i`, written for this delegation's own withdrawal credentials. */
  async depositData(i) {
    const fx = require('../../../test/fixtures/zond-deposits.json').ours[i];
    const credentials = String(await this.view('D', 'withdrawalCredentials'));
    return {
      pubkey: fx.pubkey.startsWith('0x') ? fx.pubkey : `0x${fx.pubkey}`,
      signature: fx.signature.startsWith('0x') ? fx.signature : `0x${fx.signature}`,
      root: depositDataRoot(fx.pubkey, credentials, VALIDATOR, fx.signature),
      pkh: keccak256(fx.pubkey.startsWith('0x') ? fx.pubkey : `0x${fx.pubkey}`),
    };
  }

  async depositContract() {
    return lower(await this.view('D', 'DEPOSIT_CONTRACT'));
  }

  async depositRoot() {
    return (await this.ctx.qrl.call(await this.depositContract(), DEPOSIT_IFACE, 'get_deposit_root'))[0];
  }

  async depositCount() {
    const le = getBytes((await this.ctx.qrl.call(await this.depositContract(), DEPOSIT_IFACE, 'get_deposit_count'))[0]);
    return le.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
  }

  /** Admission behind the operator bond, by governance (the deployer on the harness). */
  async admit(d, operator, label = 'e2e leg-b') {
    this.refuseLive('admitting a synthetic validator');
    const bond = await this.big('D', 'requiredBond');
    const exit = K(`${label}: a pre-signed voluntary exit, held by the quorum`);
    const r = await this.send('D', 'admitValidator', [d.pubkey, d.root, exit, operator], { value: bond });
    return { receipt: r, bond, exit };
  }

  /** The quorum's deposit check sealed at the delegation's depositCheckKey() (the deposit count, OC-LEGB-02), then `delegate`, back to back (pool-validator.js steps 3-4). */
  async delegate(d, { as } = {}) {
    this.refuseLive('a synthetic deposit');
    const root = await this.depositRoot();
    const epoch = await this.epoch();
    const leaf = await this.view('D', 'depositCheckLeaf', [d.pkh, root]);
    const key = await this.big('D', 'depositCheckKey');
    await this.seal(key, leaf);
    const receipt = await this.send('D', 'delegate', [d.pubkey, d.signature, root, []], as ? { as } : {});
    return { receipt, epoch, root, leaf, key };
  }

  /** Seal a root into MockAttestation, as the attestation's sealer. */
  seal(key, root) {
    return this.ctx.r.sealer.send(this.addr.A, this.abi('A'), 'seal', [key, root]);
  }

  /** A beacon-chain withdrawal: a balance credit that runs no code. Harness only. */
  async credit(address, wei) {
    this.refuseLive('a withdrawal credit');
    await this.ctx.qrl.chain.credit(address, wei);
  }

  /** One validator's report line, as `IArkBondDelegation.Report`. */
  async reportOf(epoch, pkh, status, withdrawn, { slashed = false, exitInitiated = null, credentialsHash = null, balance = VALIDATOR } = {}) {
    const init = exitInitiated ?? (status >= STATUS.exiting ? BigInt(epoch) : 0n);
    return [BigInt(epoch), pkh, status, slashed, init, credentialsHash || (await this.view('D', 'credentialsHash')), balance, withdrawn];
  }

  /**
   * The attester quorum's report root for `epoch`: every validator line and
   * an optional fees line, sealed at `reportKey(epoch)` and noted. Returns the
   * proofs, keyed by leaf, and the noting receipt.
   */
  async sealReport(epoch, lines, fees = null) {
    this.refuseLive('a synthetic reconciliation report');
    const leaves = [];
    for (const r of lines) leaves.push(await this.view('D', 'validatorReportLeaf', [r]));
    const feesLeaf = fees === null ? null : await this.view('D', 'feesReportLeaf', [BigInt(epoch), fees]);
    if (feesLeaf) leaves.push(feesLeaf);
    const tree = buildTree(leaves);
    const key = await this.big('D', 'reportKey', [BigInt(epoch)]);
    await this.seal(key, tree.root);
    const noted = await this.send('D', 'noteRoot', [BigInt(epoch)]);
    return { root: tree.root, key, noted, leaves, feesLeaf, proof: (leaf) => proofFor(tree, leaf) };
  }

  /** Tick until the report of `epoch` has stood for its challenge window. */
  async untilCleared(epoch) {
    const clears = await this.big('D', 'reportClearsAt', [BigInt(epoch)]);
    await this.until(`the report of epoch ${epoch} past its challenge window`, clears);
    return clears;
  }
}

module.exports = { LegB, STATUS, FORFEIT, KIND, VALIDATOR, K, same, sameEvm, isZero, lower, depositDataRoot, plain, ONE };
