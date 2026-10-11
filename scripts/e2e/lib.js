/**
 * What a scenario is written against: both legs, the relayer, and a record.
 *
 * The one rule this module exists to enforce: **a scenario states the rule it
 * defends, not the call it makes.** `check` takes the rule as its message and
 * writes it into the report beside the values it held for, so the report is
 * readable by someone who never opens the scenario.
 *
 * The relayer runs in this process rather than beside it. On the rehearsal
 * chain both legs are the same enclave and the same ML-DSA-87 account, and two
 * processes sending from one account race on the nonce; in one process the
 * sends are ordered by construction. It also means a scenario can seal a root
 * at the instant it wants one, which a separate daemon cannot be asked for.
 */
const fs = require('fs');
const path = require('path');

const { Relayer, ownerFromWords } = require('../../ecdsa-stakings/relayer/engine/relayer');
const { replacer } = require('../../ecdsa-stakings/relayer/engine/state');
const { revertName } = require('../../ecdsa-stakings/relayer/engine/errors');
const crypto = require('crypto');
const { keccak256, toUtf8Bytes } = require('ethers');
const { MLDSA87, Seed } = require('@theqrl/wallet.js');
const { iface, parseLogs, qrlBuild, qrlClient, harnessAccount, ROOT } = require('../lib/chains');
const { supply: supplyAsset, REBASE_MARGIN } = require('../lib/assets');
const { proofFor, buildTree } = require('../../ecdsa-stakings/relayer/lib/merkle');
const { toHex } = require('../../ecdsa-stakings/relayer/lib/addresses');

const ONE = 10n ** 18n;
const BPS = 10000n;

class ScenarioError extends Error {}

/**
 * The harness address of an actor label (see Ctx.actor). Static, so a
 * scenario's `governance` overrides can name actors as owners or attesters.
 * A live chain derives actors from the signing key instead.
 */
const harnessActorAddress = (label) => '0x' + keccak256(toUtf8Bytes(`ark-e2e-actor:${label}`)).slice(-40);

class Ctx {
  constructor(relayer, name, opts = {}) {
    this.r = relayer;
    this.name = name;
    this.opts = opts;
    this.started = new Date();
    this.records = [];
    this.checks = 0;
    this.pollSeconds = Number(opts.poll || 20);
    // Processes that run beside the relayer with keys of their own — the
    // reference solver (scenario solver-service) — ticked after it, in order.
    this.sidecars = [];
    // Processes that run on their own clock beside everything — the reporters
    // of ArkReferenceOracle (helpers/oracle.js) — stepped before each tick
    // and, on the harness, every `feedStep` seconds of every sleep, as a
    // daemon posting each round interval would be.
    this.feeds = [];
    this.feedStep = 300;
  }

  get origin() {
    return this.r.origin;
  }

  get qrl() {
    return this.r.qrl;
  }

  get clock() {
    return this.r.clock;
  }

  log(...args) {
    console.log(...args);
  }

  note(what, detail = {}) {
    // `detail` first: a detail field named `at`, `kind` or `ok` must not overwrite the record's own.
    this.records.push({ ...detail, at: new Date().toISOString(), kind: 'note', what });
    this.log(`   ${what}`);
  }

  /** Assert a rule of the specification. The message is the rule, not the call. */
  check(cond, rule, detail = {}) {
    this.checks += 1;
    this.records.push({ ...detail, at: new Date().toISOString(), kind: 'check', rule, ok: Boolean(cond) });
    if (!cond) throw new ScenarioError(`${rule} — ${JSON.stringify(detail, replacer)}`);
    this.log(`   held    ${rule}`);
  }

  /** Assert a call is refused, by name, against live state and without mining. */
  /**
   * A rule an open finding says the code breaks. Asserts the rule as the spec
   * states it, but a breach is recorded (`kind: 'known-finding'`) instead of
   * failing the scenario, so a live run reproduces the finding on chain and
   * carries on to the steps after it. Once the finding is fixed, the call
   * becomes `check`.
   */
  knownIssue(finding, cond, rule, detail = {}) {
    this.checks += 1;
    const reproduced = !cond;
    this.records.push({ ...detail, at: new Date().toISOString(), kind: 'known-finding', finding, rule, ok: Boolean(cond), reproduced });
    this.log(`   ${reproduced ? 'REPRODUCED' : 'held    '} ${finding}: ${rule}`);
    return reproduced;
  }

  async refuses(rule, name, fn) {
    this.checks += 1;
    let got = null;
    try {
      await fn();
    } catch (e) {
      got = revertName(this.r.errors, e);
    }
    const ok = got !== null && got.includes(name);
    this.records.push({ at: new Date().toISOString(), kind: 'refusal', rule, expected: name, got, ok });
    if (!ok) throw new ScenarioError(`${rule}: expected ${name}, got ${got === null ? 'success' : got}`);
    this.log(`   refused ${rule.padEnd(58)} ${name}`);
  }

  /* ----------------------------------------------------------------- legs */

  asset(symbol) {
    const a = this.r.assets.find((x) => x.symbol === symbol) || this.r.assets[0];
    const abi = this.r.escrowAbi(a);
    return {
      ...a,
      abi,
      call: async (m, args = []) => (await this.origin.call(a.escrow, abi, m, args))[0],
      send: (m, args = [], opts) => this.origin.send(a.escrow, abi, m, args, opts),
      token: {
        call: async (m, args = []) => (await this.origin.call(a.asset, this.r.tokenAbi(a), m, args))[0],
        send: (m, args = [], opts) => this.origin.send(a.asset, this.r.tokenAbi(a), m, args, opts),
      },
    };
  }

  registry(m, args = []) {
    return this.qrl.call(this.r.q.ArkStakeRegistry, this.r.abi.registry, m, args).then((x) => x[0]);
  }

  registrySend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ArkStakeRegistry, this.r.abi.registry, m, args, opts);
  }

  ledger(m, args = []) {
    return this.qrl.call(this.r.q.ProceedsLedger, this.r.abi.ledger, m, args).then((x) => x[0]);
  }

  ledgerSend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ProceedsLedger, this.r.abi.ledger, m, args, opts);
  }

  /**
   * The bond's coupon account, which the relayer distributes each tick (R38);
   * a scenario reads it and asserts refusals against it.
   */
  get couponAbi() {
    if (!this._couponAbi) this._couponAbi = iface('ArkBondCoupon', qrlBuild(this.r.manifest.profile));
    return this._couponAbi;
  }

  coupon(m, args = []) {
    return this.qrl.call(this.r.q.ArkBondCoupon, this.couponAbi, m, args).then((x) => x[0]);
  }

  couponSend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ArkBondCoupon, this.couponAbi, m, args, opts);
  }

  /**
   * The bond's build-2 surface (phase C3): the settlement module's functions,
   * reached at the bond's own address through its `fallback`.
   */
  bond(m, args = []) {
    return this.qrl.call(this.r.q.ArkCatBond, this.r.abi.bond, m, args).then((x) => (x.length === 1 ? x[0] : x));
  }

  bondSend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ArkCatBond, this.r.abi.bond, m, args, opts);
  }

  /**
   * The bond's fourth body (phase C3b): the claimant record and the
   * subrogation recovery, reached at the bond's address through the bond's
   * fallback and the settlement module's.
   */
  get recoveryAbi() {
    if (!this._recoveryAbi) this._recoveryAbi = iface('ArkCatBondRecovery', qrlBuild(this.r.manifest.profile));
    return this._recoveryAbi;
  }

  recovery(m, args = []) {
    return this.qrl.call(this.r.q.ArkCatBond, this.recoveryAbi, m, args).then((x) => (x.length === 1 ? x[0] : x));
  }

  recoverySend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ArkCatBond, this.recoveryAbi, m, args, opts);
  }

  /** The bond's own surface (build 1), read with `eth_call` — for a refusal asserted against live state. */
  bondCall(m, args = []) {
    if (!this._bondAbi) this._bondAbi = iface('ArkCatBond', qrlBuild(this.r.manifest.profile));
    return this.qrl.call(this.r.q.ArkCatBond, this._bondAbi, m, args);
  }

  /**
   * The product's court (phase C4): `ArkStakeCourt` and its juror pool, where
   * the deployment has them (`deployQrlLeg`'s default). A finding reaches the
   * bond only through an assertion and the court's verdict on it.
   */
  get courtAbi() {
    if (!this._courtAbi) this._courtAbi = iface('ArkStakeCourt', qrlBuild(this.r.manifest.profile));
    return this._courtAbi;
  }

  court(m, args = []) {
    if (!this.r.q.ArkStakeCourt) throw new ScenarioError('this deployment has no ArkStakeCourt (ARK_COURT=mock)');
    return this.qrl.call(this.r.q.ArkStakeCourt, this.courtAbi, m, args).then((x) => (x.length === 1 ? x[0] : x));
  }

  courtSend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ArkStakeCourt, this.courtAbi, m, args, opts);
  }

  /** A payload the court decodes on the QRL leg: 32-byte words on the harness, 64-byte on a QIP-55 node. */
  encodeQrl(types, values) {
    if (this.qrl.kind === 'qrl') {
      // The QIP-55 coder takes an address in the Q form only (as toQrlArg in
      // chains.js does for call arguments); a 0x+128 value, a widened origin
      // address among them, is converted by its declared type.
      const { toQ } = require('../../ecdsa-stakings/relayer/lib/addresses');
      const q = (t, v) => (t.endsWith('[]') ? Array.from(v, (x) => q(t.slice(0, -2), x)) : t === 'address' && /^0x[0-9a-fA-F]{128}$/.test(String(v)) ? toQ(v) : v);
      return require('@theqrl/abi').defaultAbiCoder.encode(types, types.map((t, i) => q(t, values[i])));
    }
    return require('ethers').AbiCoder.defaultAbiCoder().encode(types, values);
  }

  /**
   * Open the juror pool to a case of seat `seat`: each open case reserves its
   * first round's seven seats against the pool's stake (audit 2026-09-29,
   * QL-19; PV-01), so the deployer stakes what the pool lacks
   * for this one, at least the minimum stake, and the stake joins the draw at
   * the next epoch boundary. On a network with core's ARK the deployer must
   * hold it.
   */
  async openJurorPool(seat) {
    const build = qrlBuild(this.r.manifest.profile);
    const q = this.r.q;
    const ark = q.ArkToken || q.ArkTokenDouble;
    const poolIface = iface('ArkJurorPool', build);
    const minStake = BigInt((await this.qrl.call(q.ArkJurorPool, poolIface, 'MIN_STAKE'))[0]);
    const pool = BigInt((await this.qrl.call(q.ArkJurorPool, poolIface, 'poolStake'))[0]);
    const open = BigInt(await this.court('openSeatStake'));
    const need = open + 7n * BigInt(seat ?? minStake);
    if (need <= pool) return;
    const amount = need - pool > minStake ? need - pool : minStake;
    await this.qrl.send(ark, iface('ArkToken', build), 'approve', [q.ArkJurorPool, amount]);
    await this.qrl.send(q.ArkJurorPool, poolIface, 'stake', [amount]);
    this.note(`staked ${amount / ONE} ARK into the juror pool; it joins the draw at the next boundary`);
    await this.waitEpochs(1);
  }

  /**
   * Assert a finding at its quoted deposit and, unchallenged, close it when
   * its challenge window ends — the court's optimistic path (whitepaper §6.2).
   * Returns the case id, which is also the determination or recovery id the
   * bond records it under.
   */
  async assertUnchallenged(kind, payload, label) {
    // The quote is the findings module's since the value slices of
    // 2026-09-30 (EC-04): V, the seat, each case's deposit and the slices.
    const findings = await this.court('FINDINGS');
    const findingsAbi = iface('ArkCourtFindings', qrlBuild(this.r.manifest.profile));
    const quote = () => this.qrl.call(findings, findingsAbi, 'quote', [kind, payload]);
    let q = await quote();
    // Each slice reserves its first round's seven seats.
    await this.openJurorPool(BigInt(q[2]) * BigInt(q[4]));
    q = await quote();
    const deposit = BigInt(q[3]);
    const slices = BigInt(q[4]);
    await this.courtSend('assertFinding', [kind, payload, '0x' + '00'.repeat(32)], { value: deposit * slices });
    const last = BigInt(await this.court('caseCount'));
    const ids = [];
    for (let n = last - slices + 1n; n <= last; n++) ids.push(await this.court('caseAt', [n]));
    const c = await this.court('caseOf', [ids[0]]);
    // The determination or recovery id the bond records: the group's where sliced.
    const caseId = slices > 1n ? c.group : ids[0];
    const day = BigInt(await this.court('COURT_DAY'));
    const closes = BigInt(c.openedAt) + BigInt(c.challengeDays) * day;
    this.note(`${label}: asserted as case ${String(caseId).slice(0, 12)}… in ${slices} slice(s), deposit ${deposit / ONE} QRL each, unchallenged until ${closes}`);
    await this.waitFor(`the challenge window of ${label}`, async () => (await this.qrl.head()).timestamp >= closes, { timeoutEpochs: 3 });
    for (const id of ids) await this.courtSend('finalize', [id, payload]);
    return { caseId, deposit: deposit * slices, value: BigInt(q[0]) };
  }

  paramsSend(m, args = [], opts) {
    return this.qrl.send(this.r.q.ArkStakeParams, this.r.abi.params, m, args, opts);
  }

  /**
   * Another account on the QRL leg, by label: a juror, an attester, a
   * multisig owner. On the harness a sender needs no key. On a live chain the
   * QRL client signs only from its own key and ignores `from`, so the actor
   * gets a key of its own, derived from the relayer's signing key and the
   * label: the same label is the same account on every run, and nobody
   * without that key can derive it. Topped up to `fund` wei when below it.
   */
  async actor(label, { fund = 0n } = {}) {
    if (!this._actors) this._actors = new Map();
    if (!this._actors.has(label)) {
      let client;
      if (this.qrl.kind === 'qrl') {
        const base = MLDSA87.newWalletFromMnemonic(this.qrl.env[this.qrl.signerKey]).getHexExtendedSeed();
        const seed = crypto.createHash('sha512').update(`${base}:ark-e2e-actor:${label}`).digest().subarray(0, 48);
        client = qrlClient({ name: `actor:${label}`, extendedSeed: MLDSA87.newWalletFromSeed(new Seed(seed)).getHexExtendedSeed() });
      } else {
        client = harnessAccount(this.qrl, harnessActorAddress(label));
      }
      this._actors.set(label, client);
    }
    const client = this._actors.get(label);
    if (fund > 0n) {
      const have = BigInt(await this.qrl.balance(client.address));
      if (have < fund) await this.qrl.transfer(client.address, fund - have);
    }
    return client;
  }

  /** Runs the read-only invariant checks of e2e/invariants.js now; `strict` throws on a violation no open finding predicts. */
  invariants(tag, opts = {}) {
    return require('./invariants').checkInvariants(this, { tag, ...opts });
  }

  /** `n` actors labelled `${prefix}-0` … `${prefix}-(n-1)`, each funded as `actor` does. */
  async actors(prefix, n, opts = {}) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await this.actor(`${prefix}-${i}`, opts));
    return out;
  }

  /* ----------------------------------------------------------------- time */

  async originEpoch() {
    return this.clock.epochOf((await this.origin.head()).timestamp);
  }

  async tick(opts = {}) {
    for (const feed of this.feeds) await feed();
    await this.r.tick(opts);
    for (const side of this.sidecars) await side();
  }

  /**
   * Waiting. On a chain with a clock of its own this is real time; on the
   * harness it *is* the clock, which is what lets a scenario that spans ten
   * hours of epochs run offline in seconds (CLAUDE.md §4.1).
   */
  async sleep(seconds) {
    if (this.origin.advance) {
      if (!this.feeds.length) {
        this.origin.advance(seconds);
        return;
      }
      // A feed keeps its own cadence through a long wait: the clock moves in
      // steps of `feedStep`, and each feed acts after each step.
      let left = Number(seconds);
      while (left > 0) {
        const s = Math.min(left, this.feedStep);
        this.origin.advance(s);
        left -= s;
        for (const feed of this.feeds) await feed();
      }
      return;
    }
    await new Promise((res) => setTimeout(res, seconds * 1000));
  }

  /** Tick until `predicate()` holds. The timeout is in epochs, because every wait here is. */
  async waitFor(label, predicate, { timeoutEpochs = 8, sealNow = false, tickOpts = {} } = {}) {
    // The deadline is on the chain's clock, not the wall clock. On the harness
    // time passes only because `sleep` moves it, so a wall-clock deadline never
    // arrives and a scenario that will never succeed hangs instead of failing.
    const deadline = (await this.origin.head()).timestamp + this.clock.EPOCH_LENGTH * BigInt(timeoutEpochs);
    for (;;) {
      await this.tick({ sealNow, ...tickOpts });
      if (await predicate()) {
        this.note(`waited for: ${label}`);
        return;
      }
      if ((await this.origin.head()).timestamp > deadline) {
        throw new ScenarioError(`timed out after ${timeoutEpochs} epochs waiting for: ${label}`);
      }
      await this.sleep(this.pollSeconds);
    }
  }

  /** Tick through `n` whole epochs from now. */
  async waitEpochs(n, tickOpts = {}) {
    const target = (await this.originEpoch()) + BigInt(n);
    await this.waitFor(`epoch ${target}`, async () => (await this.originEpoch()) >= target, { timeoutEpochs: n + 2, tickOpts });
  }

  /* -------------------------------------------------------------- actions */

  /** Seed an escrow to its minimum, if it is not seeded yet. */
  async seedIfNeeded(a) {
    const minimum = await a.call('SEED_MINIMUM');
    const seeded = await a.call('seededUnits');
    if (seeded >= minimum) return 0n;
    // A rebasing asset's share rounding would leave `seededUnits` a wei short.
    const amount = minimum - seeded + (a.rebasing ? REBASE_MARGIN : 0n);
    await this.supply(a, amount);
    await a.token.send('approve', [a.escrow, amount]);
    await a.send('seed', [amount]);
    this.note(`seeded ${a.symbol} with ${amount} units (whitepaper §4.2)`);
    return amount;
  }

  /** Put `amount` units of the asset in the deployer's hands, minting if it is a double. */
  async supply(a, amount) {
    try {
      await supplyAsset(this.origin, { ...a, address: a.asset }, amount, this.r.tokenAbi(a));
    } catch (e) {
      throw new ScenarioError(e.message);
    }
  }

  /**
   * Anchor, returning the identifier the escrow emitted. The beneficiary is a
   * QRL account into the escrow's `bytes` parameter (QIP-55): it crosses as
   * its raw bytes at its own width — 0x+40 on the harness, 0x+128 against v3
   * (`toHex` is width-preserving and takes the Q form too). The owner is no
   * longer an event field of its own: the escrow emits its two canonical
   * words, rebuilt here for anything that asserts on it.
   */
  async anchor(a, amount, beneficiary = this.qrl.address) {
    const owner = toHex(beneficiary);
    await this.supply(a, amount);
    await a.token.send('approve', [a.escrow, amount]);
    const receipt = await a.send('anchor', [owner, amount], { gas: 500_000 });
    const ev = parseLogs(a.abi, receipt.logs).find((x) => x.name === 'Anchored');
    if (!ev) throw new ScenarioError('no Anchored event');
    return {
      id: ev.args.stakeAssetId,
      shares: ev.args.shares,
      notional: ev.args.anchoredNotional,
      epoch: BigInt(ev.args.epoch),
      boundQrlOwner: ownerFromWords(ev.args.qrlOwnerHi, ev.args.qrlOwnerLo),
    };
  }

  /** Yield, as the origin chain produces it: a balance above recorded principal. */
  async produceYield(a, units) {
    if (!a.mock) throw new ScenarioError(`${a.symbol} is not a double; its yield arrives on its own`);
    if (a.rebasing) await a.token.send('rebase', [units]);
    else await a.token.send('mint', [a.escrow, units]);
    this.note(`${a.symbol}: ${units} units of yield`);
  }

  /** The last `name` event the escrow emitted since `fromBlock`, decoded. */
  async lastEvent(a, name, fromBlock) {
    const head = await this.origin.head();
    const found = parseLogs(a.abi, await this.origin.logs(a.escrow, fromBlock, head.latest)).filter((x) => x.name === name);
    if (!found.length) throw new ScenarioError(`no ${name} from ${a.symbol} since block ${fromBlock}`);
    return found[found.length - 1].args;
  }

  /**
   * Units the asset moved to `to` since `fromBlock`, read from its Transfer
   * events. A balance difference will not do on a rebasing asset: the
   * recipient's balance also grows with every rebase after the transfer.
   */
  async transferredTo(a, to, fromBlock) {
    const head = await this.origin.head();
    const abi = this.r.tokenAbi(a);
    const target = toHex(to);
    return parseLogs(abi, await this.origin.logs(a.asset, fromBlock, head.latest))
      .filter((x) => x.name === 'Transfer' && toHex(x.args.to) === target)
      .reduce((sum, x) => sum + BigInt(x.args.value), 0n);
  }

  /** Wait until the forward path has recorded an anchor on QRL. */
  async waitAnchorRecorded(id) {
    await this.waitFor(`the anchor ${id.slice(0, 12)}… recorded on QRL`, async () => Number((await this.registry('anchorOf', [id])).status) === 1);
  }

  /** The epoch of the admitted root carrying a leaf. */
  rootEpochOf(leaf) {
    for (const [epoch, root] of Object.entries(this.r.state.data.roots)) {
      if (root.items.some((x) => x.leaf === leaf)) return BigInt(epoch);
    }
    throw new ScenarioError(`no admitted root carries ${leaf}`);
  }

  /**
   * A new relayer process over the same state file: the old one releases its
   * lock and everything it knew is read back from disk, which is the only
   * thing standing between a crash and a leaf signing twice.
   */
  async restart() {
    const old = this.r;
    old.close();
    const next = new Relayer({
      chain: old.chain,
      seeds: old.injected ? old.injected.seeds : null,
      treeHeight: old.injected ? old.injected.height : null,
      log: old.log,
      sealAt: old.sealAt,
    });
    await next.init();
    this.r = next;
    this.note('the relayer was restarted: a second process reading the same state file');
    return next;
  }

  /** Every admitted root's epoch carrying this leaf; more than one means it was resealed. */
  epochsCarrying(leaf) {
    return Object.entries(this.r.state.data.roots)
      .filter(([, root]) => root.items.some((x) => x.leaf === leaf))
      .map(([epoch]) => BigInt(epoch));
  }

  /** A sealed leaf of a kind, with the epoch of the root that carried it. */
  sealed(kind, predicate = () => true) {
    for (const [epoch, root] of Object.entries(this.r.state.data.roots)) {
      const item = root.items.find((x) => x.kind === kind && predicate(x));
      if (item) return { ...item, epoch: BigInt(epoch) };
    }
    throw new ScenarioError(`no admitted root carries a ${kind} leaf`);
  }

  /**
   * The specification's own model, or null where the sibling repository is
   * absent (CLAUDE.md §11): a comparison that cannot be made is stated in the
   * report rather than quietly passing.
   */
  async model() {
    if (this._model === undefined) {
      try {
        this._model = await require('../../test/spec-model').loadModel();
      } catch {
        this._model = null;
      }
    }
    return this._model;
  }

  /** The proof for a leaf of an admitted root, for a call the scenario makes itself. */
  proof(epoch, leaf) {
    const root = this.r.state.data.roots[String(epoch)];
    if (!root) throw new ScenarioError(`no admitted root for epoch ${epoch}`);
    return proofFor(buildTree(root.items.map((x) => x.leaf)), leaf);
  }

  /* -------------------------------------------------------------- report */

  save(extra = {}) {
    const dir = path.join(ROOT, 'reports', 'e2e');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.name}-${this.started.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          scenario: this.name,
          chain: this.r.chain,
          profile: this.r.manifest.profile,
          epochLengthSeconds: this.clock.EPOCH_LENGTH,
          startedAt: this.started.toISOString(),
          endedAt: new Date().toISOString(),
          checks: this.checks,
          outOfScope: extra.outOfScope || [],
          standIns: this.r.state.data.pending.concat(Object.values(this.r.state.data.roots).flatMap((r) => r.items)).filter((x) => x.standIn).map((x) => ({ kind: x.kind, standIn: x.standIn })),
          records: this.records,
          ...extra,
        },
        replacer,
        2,
      ),
    );
    return file;
  }
}

/**
 * A scenario amount from a CLI option, in whole asset units with up to 18
 * decimals (`--notional 0.02`), or `fallback` whole units when unset. A live
 * run on a real asset (stETH on Hoodi) anchors fractions of a unit.
 */
function units(value, fallback) {
  const text = String(value === undefined || value === null || value === '' ? fallback : value).trim();
  const m = text.match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!m) throw new ScenarioError(`not an amount: ${text}`);
  return BigInt(m[1]) * ONE + BigInt((m[2] || '').padEnd(18, '0') || '0');
}

module.exports = { Ctx, ScenarioError, Relayer, ONE, BPS, harnessActorAddress, units };
