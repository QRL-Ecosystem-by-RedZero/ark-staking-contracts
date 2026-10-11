/**
 * A reference solver for the premium swap of whitepaper §4.7: buys lots of an
 * escrow's premium for QRL.
 *
 * The one rule this module exists to enforce: **the solver reveals its secret
 * only by claiming its lot on the origin chain, and only once that lot's
 * premium lock is in an admitted root.** Revealing it earlier would let anyone
 * present it on QRL and turn the solver's QRL into proceeds for a lot the
 * escrow may never pay.
 *
 * It is not part of the protocol. Anyone may run one, and the contracts trust
 * none: `PremiumSwap` takes a quote at or above the reserve from any account
 * and selects by price, and the escrow pays against the preimage alone. It
 * exists so a testnet deployment has a counterparty, and so the e2e scenarios
 * exercise the calls a market maker would make.
 *
 * Two layers. `Solver` is one escrow's calls: size, quote, find the lock among
 * the leaves the relay published (D15), claim, carry, refund. `SolverService`
 * is the always-on market maker (2026-09-29): its own keys, its own state file
 * (`.relayer/<chain>/solver.json`), one quote per offering, and every lot
 * followed to its end across restarts — the quote is written to disk before it
 * is sent and resolved against the swap afterwards, so a crash can neither lose
 * a secret whose lot landed nor quote an offering twice.
 *
 * The secret is kept by the caller. A solver that loses it loses the lot it
 * paid for, and gets its QRL back at the lot's QRL expiry.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ids = require('../lib/identifiers');
const { buildTree, proofFor } = require('../lib/merkle');
const { toHex } = require('../lib/addresses');
const { replacer } = require('./state');
const { revertName } = require('./errors');
const { QRL_EVENTS, decodeQrlLogs, evmToQrl, parseLogs } = require('../../../scripts/lib/chains');

const BPS = 10_000n;
const ONE = 10n ** 18n;

/** A 20-byte origin-chain address from a value a QRL leg may hold zero-extended in a 64-byte slot. */
const originAddress = (v) => {
  const hex = String(v).replace(/^0x|^Q/i, '').toLowerCase();
  return toHex(`0x${hex.slice(-40)}`);
};

// `Evicted`: pushed out of a full book by a better quote (audit 2026-09-29, QL-17), refundable at once.
const STATUS = ['None', 'Quoted', 'Selected', 'Claimed', 'Refunded', 'Evicted'];
/** The swap's refusal of a quote for suspended pricing, the series silent or the breaker active (yellow paper §4.6): not a revert, so named here. */
const SUSPENDED = 'PricingSuspended';
const lower = (a) => String(a || '').toLowerCase();
const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
const short = (id) => `${String(id).slice(0, 14)}…`;
const reviver = (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

class Solver {
  /**
   * `qrl` and `origin` are clients (scripts/lib/chains.js) whose accounts are
   * the solver's; `swap` is the PremiumSwap address and `swapAbi` its ABI;
   * `escrow` is `{ asset, escrow, abi }`; `recipient` is the solver's account
   * on the origin chain, which the escrow pays.
   *
   * On a QIP-55 (testnet v3) QRL leg the solver's own account is Q+128 (web3
   * signs as it; nothing here converts it), while the asset and the recipient
   * are ORIGIN-chain 20-byte values — every one of them feeding a Hyperion
   * `address` parameter is zero-extended with `evmToQrl` on that path only.
   */
  constructor({ qrl, origin, swap, swapAbi, chainId, escrow, recipient, clock = null, revealBudget = null, relay = null, relayAbi = null, fromBlock = 0n, errors = null, log = () => {} }) {
    Object.assign(this, { qrl, origin, swap, swapAbi, escrow, log, clock, relay, relayAbi, errors });
    // Where the relay's published leaves are read from (D15): with a relay and
    // its ABI, a lock is found on the origin chain itself.
    this.fromBlock = BigInt(fromBlock);
    // Seconds a revealed preimage needs to reach QRL (`revealBudgetSeconds`,
    // lib/epoch.js). With a clock, a claim closer than this to the lot's QRL
    // expiry is refused before anything is sent.
    this.revealBudget = revealBudget === null ? null : BigInt(revealBudget);
    this.chainId = BigInt(chainId);
    this.recipient = toHex(recipient || origin.address);
    this.onQrl = qrl.kind === 'qrl';
    this.assetArg = this.onQrl ? evmToQrl(toHex(escrow.asset)) : escrow.asset;
    // The recipient is an EVM address into an `address` parameter: widened on
    // the v3 path like the asset.
    this.recipientArg = this.onQrl ? evmToQrl(this.recipient) : this.recipient;
  }

  errorName(e) {
    return this.errors ? revertName(this.errors, e) : String(e?.shortMessage || e?.reason || e?.message || e);
  }

  /** The arguments of a named custom error, where the revert data carries one; null otherwise. */
  errorArgs(e) {
    if (!this.errors) return null;
    for (const c of [e?.data, e?.info?.error?.data, e?.cause?.data, e?.innerError?.data, e?.error?.data, e?.cause?.cause?.data]) {
      const data = typeof c === 'string' ? c : c?.data;
      if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) continue;
      try {
        return [...this.errors.parseError(data).args];
      } catch {
        /* not one of ours */
      }
    }
    return null;
  }

  async call(method, args) {
    return (await this.qrl.call(this.swap, this.swapAbi, method, args))[0];
  }

  available(epoch) {
    return this.call('available', [this.chainId, this.assetArg, epoch]).then(big);
  }

  required(epoch, shares) {
    return this.call('required', [this.chainId, this.assetArg, epoch, shares]).then(big);
  }

  /** The commitment bond a lot of `value` posts now (I33): what `quote` adds to it. */
  bondFor(epoch, value) {
    return this.call('bondFor', [this.chainId, this.assetArg, epoch, value]).then(big);
  }

  /** The lot id the swap will give a quote of these terms from this account (`PremiumSwap.lotIdOf`). */
  async lotIdFor({ hashlock, shares, value, epoch }) {
    const t = await this.qrl.call(this.swap, this.swapAbi, 'timetable', [epoch]);
    const qrlExpiry = big(t.qrlExpiry ?? t[3]);
    return this.call('lotIdOf', [hashlock, this.qrl.address, this.recipientArg, shares, value, qrlExpiry]);
  }

  /**
   * The terms of a lot of `shares` of `epoch`'s offering at the reserve, or at
   * `value` if given, with a fresh secret, the bond the swap computes and the
   * lot id it will have — nothing sent. The caller writes these down before
   * `send`, so a quote that lands while the process dies is still claimable.
   */
  async prepare(epoch, shares, { value = null, secret = null, bond: given = null } = {}) {
    const s = secret || '0x' + crypto.randomBytes(32).toString('hex');
    const hashlock = ids.hashlockOf(s);
    const v = big(value ?? (await this.required(epoch, shares)));
    // Read before the quote: the swap charges no more than it computes and returns any excess.
    const bond = given === null ? await this.bondFor(epoch, v) : big(given);
    const lot = { asset: toHex(this.escrow.asset), swap: toHex(this.swap), secret: s, hashlock, epoch: big(epoch), shares: big(shares), value: v, bond };
    lot.lotId = await this.lotIdFor(lot);
    return lot;
  }

  quoteArgs(lot) {
    return [this.chainId, this.assetArg, lot.epoch, lot.shares, lot.hashlock, this.recipientArg, lot.value];
  }

  /** The offering of `epoch` as the swap records it (`offeringOf`). */
  offering(epoch) {
    return this.call('offeringOf', [this.chainId, this.assetArg, epoch]);
  }

  /**
   * Make the offering's first quote, if nobody has: a lot of the least size
   * the swap takes, for one planck and the bond it computes for that (zero),
   * never selected and refundable with the rest (audit 2026-10-03,
   * OC-SWAP-03). The first quote judges the offering before it and fixes the
   * reserve, so `required` and `bondFor` read before it price at a failure
   * count that judgement may still move: a success after a failure resets
   * it, the reserve rises, and a lot quoted at the stale reserve is passed
   * over (or, from two failures, refused `BondMismatch`). After this they read
   * what binds. The size is taken from the refusal's arguments where the
   * judgement itself moves what may be sold (a retirement, a release of
   * retained yield): a call of `quote` runs the judgement too.
   * `{ ok, lot }` or `{ ok: false, error }`; `{ ok: true }` where the offering
   * was already judged.
   */
  async judge(epoch) {
    if ((await this.offering(epoch)).judged) return { ok: true };
    const avail = await this.available(epoch);
    if (avail === 0n) return { ok: false, error: 'ExceedsOffer' };
    let shares = (avail + 31n) / 32n;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lot = await this.judgingLot(epoch, shares);
      const why = await this.quoteRefusal(lot);
      if (why === SUSPENDED) {
        // Yellow paper §4.6: the refusal counts only once recorded, and only
        // a quote sent records it. The offering is then carried, with no
        // failure counted, if it sells nothing; this solver sits it out.
        await this.recordRefusal(lot);
        return { ok: false, error: SUSPENDED };
      }
      if (!why) {
        await this.send(lot);
        this.log(`solver   judging quote sent for epoch ${epoch}: the views now read what binds`);
        return { ok: true, lot };
      }
      const args = this.lastRefusal && this.lastRefusal.args;
      if (why === 'LotTooSmall' && args) shares = big(args[0]);
      else if (why === 'ExceedsOffer' && args && big(args[1]) > 0n) shares = (big(args[1]) + 31n) / 32n;
      else return { ok: false, error: why };
    }
    return { ok: false, error: 'the judging quote could not be sized' };
  }

  /**
   * The judging lot of `judge`: one planck and the bond the swap computes for
   * it, or no bond where the views cannot price it — a silent series makes
   * `bondFor` revert while no quote has fixed the reserve, and the quote it
   * would price is refused and recorded before any bond is read (yellow
   * paper §4.6).
   */
  async judgingLot(epoch, shares) {
    try {
      return await this.prepare(epoch, shares, { value: 1n });
    } catch (e) {
      if (!/OracleSilent|OracleUnavailable/.test(this.errorName(e))) throw e;
      return this.prepare(epoch, shares, { value: 1n, bond: 0n });
    }
  }

  /**
   * Send a quote the swap will refuse for suspended pricing, so the refusal
   * is recorded (`QuoteRefused`; yellow paper §4.6, OC-ORC-04). The QRL
   * sent comes back in the same transaction. Throws where it landed as
   * anything else.
   */
  async recordRefusal(lot) {
    const receipt = await this.qrl.send(this.swap, this.swapAbi, 'quote', this.quoteArgs(lot), { value: lot.value + lot.bond });
    const evs = this.swapEvents(receipt);
    if (!evs.some((e) => e.name === 'QuoteRefused')) throw new Error(`the quote for epoch ${lot.epoch} was not refused as suspended: ${evs.map((e) => e.name).join(', ') || 'no swap event'}`);
    this.log(`solver   pricing suspended for epoch ${lot.epoch} of ${this.escrow.asset}: the refusal is recorded, the offering is carried if it sells nothing`);
  }

  /** The swap's events in a receipt, through the relayer's decode switch (QIP-55 logs, or ethers-shaped). */
  swapEvents(receipt) {
    const logs = (receipt && receipt.logs) || [];
    return this.onQrl
      ? decodeQrlLogs(QRL_EVENTS.PremiumSwap, logs)
      : logs.map((l) => { try { return this.swapAbi.parseLog(l); } catch { return null; } }).filter(Boolean);
  }

  /** Whether the escrow spent this premium lock leaf: the lot was paid on the origin chain (`isSpent`). */
  async isSpent(leaf) {
    const r = await this.origin.call(this.escrow.escrow, this.escrow.abi, 'isSpent', [leaf]);
    return Boolean(Array.isArray(r) || (r && typeof r === 'object' && 0 in r) ? r[0] : r);
  }

  /**
   * Why the swap would refuse this quote now, or null: a call, broadcast to
   * nobody. The refusal's arguments are kept in `lastRefusal`.
   */
  async quoteRefusal(lot) {
    this.lastRefusal = null;
    try {
      const r = await this.qrl.call(this.swap, this.swapAbi, 'quote', this.quoteArgs(lot), { value: lot.value + lot.bond });
      // A quote refused for suspended pricing does not revert: it returns
      // the zero lot id, records the refusal and sends the QRL back (yellow
      // paper §4.6, item 123).
      const id = Array.isArray(r) || (r && typeof r === 'object' && 0 in r) ? r[0] : r;
      if (/^0x0{64}$/i.test(String(id))) {
        this.lastRefusal = { name: SUSPENDED, args: null };
        return SUSPENDED;
      }
      return null;
    } catch (e) {
      const name = this.errorName(e);
      this.lastRefusal = { name, args: this.errorArgs(e) };
      return name;
    }
  }

  /** Send a prepared quote. Throws where the transaction did not land as a quote. */
  async send(lot) {
    const receipt = await this.qrl.send(this.swap, this.swapAbi, 'quote', this.quoteArgs(lot), { value: lot.value + lot.bond });
    // The same decode switch as the relayer's: QIP-55 logs through the manual
    // decoder, ethers-shaped logs through the Interface. The lot id was
    // computed before the send; the event only confirms it.
    const evs = this.swapEvents(receipt);
    // Refused for suspended pricing between the check and the send: no lot, the QRL returned (yellow paper §4.6).
    if (evs.some((e) => e.name === 'QuoteRefused')) throw new Error(`${SUSPENDED}: the swap refused the quote of lot ${lot.lotId} and recorded the refusal`);
    const ev = evs.find((e) => e.name === 'LotQuoted');
    if (ev && lower(ev.args.lotId) !== lower(lot.lotId)) throw new Error(`the swap stored lot ${ev.args.lotId}, not the ${lot.lotId} computed for these terms`);
    this.log(`solver   quoted ${fmt(lot.value)} QRL (+${fmt(lot.bond)} bond) for ${lot.shares} shares of ${this.escrow.asset}, epoch ${lot.epoch}: lot ${short(lot.lotId)}`);
    return lot;
  }

  /**
   * Quote a lot of `shares` of `epoch`'s offering at the reserve, or at
   * `value` if given, posting the commitment bond the swap computes for it
   * (whitepaper §4.7, I33): returned with the lot if it is not selected, or once
   * the preimage reaches QRL before the lot's QRL expiry, and forfeited to the
   * coupon of the offered epoch otherwise. Returns the lot, secret included;
   * the caller keeps it.
   */
  async quote(epoch, shares, opts = {}) {
    return this.send(await this.prepare(epoch, shares, opts));
  }

  async lotOf(lotId) {
    return this.call('lotOf', [lotId]);
  }

  async status(lotId) {
    return STATUS[Number((await this.lotOf(lotId)).status)];
  }

  /**
   * Find the lot's premium lock in the roots a relayer has admitted, given
   * its state (`relayer.state.data`), with the proof `claimPremium` needs.
   * For a scenario that holds the relayer in-process; the service never reads
   * a relayer's state.
   */
  static lockIn(state, lotId) {
    for (const [epoch, root] of Object.entries(state.roots || {})) {
      const item = root.items.find((x) => x.kind === 'premium' && x.lotId === lotId);
      if (item) return { item, epoch: BigInt(epoch), proof: proofFor(buildTree(root.items.map((x) => x.leaf)), item.leaf) };
    }
    return null;
  }

  /**
   * The lot's premium lock as the relayer seals it, rebuilt from the lot as
   * the swap records it (`lotOf`) and the clock's `evmExpiry` of its offered
   * epoch, bound to this solver's escrow (the V3 leaf, yellow paper §3.5).
   */
  async lockItem(lotId) {
    const l = await this.lotOf(lotId);
    const epoch = BigInt(l.epoch);
    const item = {
      kind: 'premium',
      lotId,
      hashlock: l.hashlock,
      recipient: originAddress(l.recipient),
      shares: BigInt(l.shares),
      evmExpiry: BigInt(this.clock.evmExpiry(epoch)),
      offeredEpoch: epoch,
      bond: BigInt(l.bond),
    };
    item.leaf = ids.premiumLockLeaf({
      chainId: this.chainId,
      escrow: this.escrow.escrow,
      asset: this.escrow.asset,
      epoch,
      lotId,
      hashlock: item.hashlock,
      recipient: item.recipient,
      shares: item.shares,
      bond: item.bond,
      evmExpiry: item.evmExpiry,
    });
    return item;
  }

  /** The lock and its proof from one published list of leaves, or null where the list does not hold it. */
  static lockFrom(item, epoch, leaves) {
    if (!leaves.some((x) => lower(x) === lower(item.leaf))) return null;
    return { item, epoch: BigInt(epoch), proof: proofFor(buildTree(leaves), item.leaf) };
  }

  /**
   * Find the lot's premium lock among the leaves the relay has published on
   * the origin chain (`LeavesPublished`, whitepaper §3.6, D15), with the
   * proof `claimPremium` needs — from the chain alone, one scan from
   * `fromBlock`. A leaf the relay published is one the relay's root carries,
   * so the proof is the root's. The service scans incrementally instead.
   */
  async lockOnChain(lotId) {
    if (!this.relay || !this.relayAbi || !this.clock) return null;
    const item = await this.lockItem(lotId);
    const head = await this.origin.head();
    for (const ev of parseLogs(this.relayAbi, await this.origin.logs(this.relay, this.fromBlock, head.latest))) {
      if (ev.name !== 'LeavesPublished') continue;
      const found = Solver.lockFrom(item, ev.args.epoch, [...ev.args.leaves]);
      if (found) return found;
    }
    return null;
  }

  claimArgs(lot, { item, epoch, proof }) {
    // The V3 lock binds the offered epoch and the bond as well (yellow paper §3.5).
    const payload = [lot.lotId, lot.hashlock, item.recipient, item.shares, item.evmExpiry, item.offeredEpoch ?? lot.epoch, item.bond ?? 0n];
    return [payload, epoch, proof, lot.secret];
  }

  /**
   * Claim the lot on the origin chain, which publishes the secret. Returns
   * false while its lock is not yet in an admitted root, and false — with
   * `lot.refused` naming why — where revealing now could lose the lot.
   *
   * `found` is the lock with its proof where the caller has it (the service
   * keeps the published leaves); otherwise it is looked up in a relayer's
   * state if one is passed, then among the leaves published on the origin
   * chain (D15).
   *
   * A claim that FAILS still publishes the secret in its calldata: anyone can
   * then present it on QRL and turn the solver's QRL into proceeds, while the
   * escrow paid nothing (audit 2026-09-27, D12). So nothing is sent unless
   *  - there is time left to carry the preimage to QRL before the lot's QRL
   *    expiry — twice the origin chain's finality and one relayer tick
   *    (`revealBudget`). Since 2026-09-28 the testnet profile's margin is
   *    that budget on Hoodi (whitepaper §4.7, D12), and this is what still
   *    keeps a late claim from racing the solver's own refund on a chain
   *    slower than the profile was built for; and
   *  - the claim succeeds as a call first: the pot still covers the lot, the
   *    settlement is not closed, the lock is unexpired and unspent. A call is
   *    answered by the node and broadcast to nobody.
   */
  async claim(lot, relayerState = null, { found = null, beforeSend = null } = {}) {
    found = found || (relayerState && Solver.lockIn(relayerState, lot.lotId)) || (await this.lockOnChain(lot.lotId));
    if (!found) return false;
    // Each refusal is logged once, not at every tick it still holds.
    const refuse = (why, name = null) => {
      if (lot.refused !== why) this.log(`solver   NOT claiming lot ${short(lot.lotId)}: ${why}`);
      lot.refused = why;
      lot.refusedWith = name;
      return false;
    };
    if (this.clock && this.revealBudget !== null) {
      const now = BigInt((await this.origin.head()).timestamp);
      const qrlExpiry = BigInt(this.clock.settlementCloses(lot.epoch));
      if (now + this.revealBudget > qrlExpiry) {
        return refuse(`too late to reveal: ${qrlExpiry - now}s to the QRL expiry, ${this.revealBudget}s needed to carry the preimage`, 'RevealBudget');
      }
    }
    const args = this.claimArgs(lot, found);
    try {
      await this.origin.call(this.escrow.escrow, this.escrow.abi, 'claimPremium', args);
    } catch (e) {
      const why = this.errorName(e);
      return refuse(`the claim would fail (${why}); the secret stays unrevealed`, why);
    }
    if (beforeSend) await beforeSend();
    await this.origin.send(this.escrow.escrow, this.escrow.abi, 'claimPremium', args);
    delete lot.refused;
    delete lot.refusedWith;
    this.log(`solver   claimed lot ${short(lot.lotId)} on the origin chain`);
    return true;
  }

  /**
   * A permissionless call of the swap's, tried as a call first so a refusal
   * costs nothing: `refund(lotId)` (a lot not selected: QRL and bond; a
   * selected lot lapsed: QRL only; a claimed lot: its bond) or
   * `claim(lotId, secret)` (the preimage carried to QRL). `{ ok, error }`.
   */
  async swapTx(method, args) {
    try {
      await this.qrl.call(this.swap, this.swapAbi, method, args);
    } catch (e) {
      return { ok: false, error: this.errorName(e) };
    }
    try {
      await this.qrl.send(this.swap, this.swapAbi, method, args);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: this.errorName(e), sent: true };
    }
  }

  refund(lotId) {
    return this.swapTx('refund', [lotId]);
  }

  carry(lot) {
    return this.swapTx('claim', [lot.lotId, lot.secret]);
  }
}

/** Planck as whole QRL with up to four decimals, for a log line. */
function fmt(v) {
  const x = big(v);
  const whole = x / ONE;
  const frac = ((x % ONE) * 10_000n) / ONE;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(4, '0').replace(/0+$/, '')}`;
}

/* ------------------------------------------------------------------ */
/* Keys: the solver signs from accounts of its own                     */
/* ------------------------------------------------------------------ */

const envKey = (chain) => String(chain).toUpperCase().replace(/-/g, '_');

/** A solver setting, `<CHAIN>_SOLVER_<NAME>` before `SOLVER_<NAME>`. */
function solverSetting(env, chain, name, fallback = null) {
  const v = env[`${envKey(chain)}_SOLVER_${name}`] ?? env[`SOLVER_${name}`];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * Which variables hold the solver's keys (names only, never values).
 *
 *  - QRL (ML-DSA-87): `<CHAIN>_SOLVER_QRL_MNEMONIC`, else `SOLVER_MNEMONIC`;
 *    its address `<CHAIN>_SOLVER_QRL_ADDRESS`, else `SOLVER_ADDRESS` — the
 *    account the relayer's redeploy funds at each fresh genesis.
 *  - The origin chain (secp256k1): `<CHAIN>_SOLVER_PRIVATE_KEY`, else
 *    `<CHAIN>_SOLVER_MNEMONIC` (first account of the standard path); its
 *    address `<CHAIN>_SOLVER_ADDRESS`, checked against the key.
 *
 * `<CHAIN>_SOLVER_MNEMONIC` is the ORIGIN phrase, as `<CHAIN>_MNEMONIC` is the
 * relayer's; the QRL override carries `_QRL_` for that reason.
 */
function solverKeyNames(env, chain) {
  const K = envKey(chain);
  const pick = (...names) => names.find((n) => env[n]) || null;
  return {
    qrlMnemonic: pick(`${K}_SOLVER_QRL_MNEMONIC`, 'SOLVER_MNEMONIC'),
    qrlAddress: env[`${K}_SOLVER_QRL_ADDRESS`] || env.SOLVER_ADDRESS || null,
    originKey: pick(`${K}_SOLVER_PRIVATE_KEY`),
    originMnemonic: env[`${K}_SOLVER_PRIVATE_KEY`] ? null : pick(`${K}_SOLVER_MNEMONIC`),
    originAddress: env[`${K}_SOLVER_ADDRESS`] || null,
  };
}

/**
 * The QRL accounts a solver must not share on a shared network: the relayer's
 * (the deployer), the attestation sealer, the price double's operator, and
 * every governance and Q-Day role the relayer funds — each signs on its own
 * nonce, and a second process on one of them collides (observed 2026-09-28).
 * Addresses only; `derived` adds what a key on this host resolves to.
 */
function relayerQrlAccounts(env, chain, derived = {}) {
  const K = envKey(chain);
  const read = (name) => env[`${K}_${name}`] || env[name] || null;
  const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
  const out = [];
  const add = (address, label) => address && out.push({ address, label });
  add(derived.deployer, 'the deployer (the relayer)');
  add(env.DEPLOYER_ADDRESS, 'the deployer (the relayer)');
  add(derived.sealer, 'the attestation sealer');
  add(read('SEALER_ADDRESS'), 'the attestation sealer');
  add(read('ORACLE_OPERATOR_ADDRESS'), "the price double's operator");
  add(read('GOVERNANCE_ADDRESS'), 'governance');
  list(read('GOV_PROPOSER_OWNERS')).forEach((a) => add(a, 'a proposer multisig owner'));
  list(read('GOV_GUARDIAN_OWNERS')).forEach((a) => add(a, 'a guardian multisig owner'));
  list(read('QDAY_ATTESTERS')).forEach((a) => add(a, 'a Q-Day attester'));
  return out;
}

/**
 * The key-separation rule (item 38's style, 2026-09-29). On a shared manifest
 * the solver runs only on accounts of its own: both keys present, neither the
 * relayer's nor any role's, and each matching the address the environment
 * declares for it (the QRL one is what the redeploy funds). The relayer's
 * accounts must be known to be compared; `ALLOW_SHARED_KEYS=1` overrides all
 * of it knowingly. A local manifest (the harness, the enclave standing in for
 * the origin chain) may fall back to the relayer's accounts.
 *
 * `solver` is `{ qrl, origin }` as resolved from the keys (null where there is
 * no key), `relayer` is `{ qrl: [{address,label}], origin: [{address,label}] }`,
 * `declared` is `{ qrl, origin }` from the environment. Returns
 * `{ errors, fallback: { qrl, origin } }` — where a fallback is allowed.
 */
function keySeparation({ shared, allowShared = false, names = {}, solver = {}, relayer = {}, declared = {}, chain = 'chain' }) {
  const K = envKey(chain);
  const same = (a, b) => Boolean(a) && Boolean(b) && lower(toHex(a)) === lower(toHex(b));
  const errors = [];
  const fallback = { qrl: false, origin: false };
  if (!solver.qrl) {
    if (shared && !allowShared) errors.push(`no QRL key for the solver: set SOLVER_MNEMONIC (or ${K}_SOLVER_QRL_MNEMONIC) to an account of its own`);
    else fallback.qrl = true;
  }
  if (!solver.origin) {
    if (shared && !allowShared) errors.push(`no origin-chain key for the solver: set ${K}_SOLVER_PRIVATE_KEY (or ${K}_SOLVER_MNEMONIC) to an account of its own`);
    else fallback.origin = true;
  }
  // A declared address that is not the key's: funding would go elsewhere.
  if (solver.qrl && declared.qrl && !same(solver.qrl, declared.qrl)) {
    errors.push(`${names.qrlAddress || 'SOLVER_ADDRESS'} ${declared.qrl} is not the address of ${names.qrlMnemonic || 'SOLVER_MNEMONIC'} (${solver.qrl}); the redeploy funds the declared one`);
  }
  if (solver.origin && declared.origin && !same(solver.origin, declared.origin)) {
    errors.push(`${K}_SOLVER_ADDRESS ${declared.origin} is not the address of the solver's origin key (${solver.origin})`);
  }
  if (shared && !allowShared) {
    const qrlRoles = relayer.qrl || [];
    const originRoles = relayer.origin || [];
    if (solver.qrl) {
      if (!qrlRoles.some((r) => r.label.startsWith('the deployer'))) errors.push("the relayer's QRL account is unknown here, so the solver's cannot be shown distinct: set DEPLOYER_ADDRESS");
      for (const r of qrlRoles) if (same(solver.qrl, r.address)) errors.push(`the solver's QRL account is ${r.label}`);
    }
    if (solver.origin) {
      if (!originRoles.length) errors.push(`the relayer's origin-chain account is unknown here, so the solver's cannot be shown distinct: set ${K}_RELAYER_ADDRESS (the installer writes it)`);
      for (const r of originRoles) if (same(solver.origin, r.address)) errors.push(`the solver's origin-chain account is ${r.label}`);
    }
  }
  const unique = [...new Set(errors)];
  if (unique.length && shared && !allowShared) {
    unique.push('the reference solver signs from accounts of its own on a shared network (one account per running process); set ALLOW_SHARED_KEYS=1 to run it on shared keys knowingly');
  }
  return { errors: unique, fallback };
}

/* ------------------------------------------------------------------ */
/* One process per state file                                          */
/* ------------------------------------------------------------------ */

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Take `file` for this process (exclusive create; a dead holder's lock is taken over). Returns the release. */
function lockFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      const release = () => {
        try {
          if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      return () => {
        process.removeListener('exit', release);
        release();
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch {
      continue;
    }
    if (pid === process.pid) return () => {};
    if (pid && pidAlive(pid)) throw new Error(`the solver state ${path.dirname(file)} is held by process ${pid}; one solver per chain`);
    fs.rmSync(file, { force: true });
  }
  throw new Error(`could not take ${file}`);
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

const EMPTY = () => ({
  version: 1,
  /** The QRL leg the open lots belong to: its genesis and its swap. */
  deployment: null,
  /** A quote written before it was sent: resolved against the swap next tick. */
  pending: null,
  /** Lots of ours not yet at their end, secrets included. */
  lots: [],
  /** Lots at their end, with the outcome; kept for the record, secrets dropped. */
  done: [],
  /** The origin-chain scan of `LeavesPublished` (D15). */
  scan: { relay: null, from: null },
  /** epoch -> the ordered leaves the relay published for it, recent ones only. */
  published: {},
});

/** Published lists kept: a lot's lock is in a root sealed within a few epochs of its offering. */
const PUBLISHED_KEEP = 12;
/** Finished lots kept in the file. */
const DONE_KEEP = 200;

class SolverService {
  /**
   * `qrl` and `origin` are the solver's own clients. `deployment()` returns
   * the QRL leg's record as the relayer last wrote it (`qrl.PremiumSwap`,
   * `qrlGenesisHash`, `relay`); `makeSolver(asset, swap)` builds a `Solver`
   * for one manifest asset and one swap. `assets` are the manifest's.
   *
   * Settings (all optional): `shareBps` of what an offering may sell to quote
   * (the D4 minimum lot is honoured), `priceBps` above the reserve,
   * `maxLotValue` in planck, `qrlReserve` kept back for gas, `claimGas` the
   * origin gas one claim needs, `carryAfter` seconds after its own origin
   * claim before the solver carries the preimage to QRL itself (the relayer
   * normally does), `lookbackBlocks` for a first scan, `scanChunk`.
   */
  constructor({ chain, qrl, origin, assets, deployment, makeSolver, clock, dir, relay, relayAbi = null, fromBlock = 0n, lookbackBlocks = 1_000n, scanChunk = 2_000n, shareBps = 10_000n, priceBps = 0n, maxLotValue = null, qrlReserve = 50n * ONE, claimGas = 300_000n, carryAfter = null, errors = null, log = console.log, warn = console.error }) {
    Object.assign(this, { chain, qrl, origin, assets, deployment, makeSolver, clock, errors, log, warn });
    this.dir = dir;
    this.file = path.join(dir, 'solver.json');
    this.statusFile = path.join(dir, 'solver-status.json');
    this.lockPath = path.join(dir, 'solver.lock');
    this.relay = relay ? toHex(relay) : null;
    this.relayAbi = relayAbi;
    this.fromBlock = big(fromBlock);
    this.lookbackBlocks = big(lookbackBlocks);
    this.scanChunk = big(scanChunk);
    this.shareBps = big(shareBps);
    this.priceBps = big(priceBps);
    this.maxLotValue = maxLotValue === null ? null : big(maxLotValue);
    this.qrlReserve = big(qrlReserve);
    this.claimGas = big(claimGas);
    this.carryAfter = carryAfter === null ? null : big(carryAfter);
    this.solvers = new Map();
    this.warned = {};
    this.skipped = new Set();
    this.startedAt = new Date().toISOString();
    this.state = this.load();
  }

  lock() {
    this.release = lockFile(this.lockPath);
    return this;
  }

  close() {
    if (this.release) this.release();
    this.release = null;
  }

  load() {
    const data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'), reviver) : {};
    return { ...EMPTY(), ...data };
  }

  /** Temporary file, fsync, rename: a crash leaves the old state or the new, never half of one. */
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.state, replacer, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  writeStatus(status) {
    this.lastStatus = { chain: this.chain, pid: process.pid, startedAt: this.startedAt, at: new Date().toISOString(), ...status };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.statusFile, JSON.stringify(this.lastStatus, replacer, 2));
    } catch {
      /* the status is a report, never state */
    }
  }

  /** Log a warning once per `key` until it clears, repeated hourly while it holds. */
  warnOnce(key, message) {
    const at = Date.now();
    if (this.warned[key] && at - this.warned[key] < 3_600_000) return;
    this.warned[key] = at;
    this.warn(`solver   WARNING ${message}`);
  }

  clearWarning(key, message = null) {
    if (!this.warned[key]) return;
    delete this.warned[key];
    if (message) this.log(`solver   ${message}`);
  }

  solverFor(assetAddress, swap) {
    const k = `${lower(assetAddress)}@${lower(swap)}`;
    if (!this.solvers.has(k)) {
      const a = this.assets.find((x) => lower(toHex(x.address)) === lower(assetAddress));
      if (!a) return null;
      this.solvers.set(k, this.makeSolver(a, swap));
    }
    return this.solvers.get(k);
  }

  finish(lot, outcome, extra = {}) {
    const { secret, lock, leaf, ...kept } = lot;
    this.state.done.push({ ...kept, ...extra, outcome, at: new Date().toISOString() });
    if (this.state.done.length > DONE_KEEP) this.state.done.splice(0, this.state.done.length - DONE_KEEP);
    this.state.lots = this.state.lots.filter((x) => x.lotId !== lot.lotId);
    this.log(`solver   lot ${short(lot.lotId)} done: ${outcome}`);
  }

  /** One pass. Never throws for a single lot; throws where the chains cannot be read at all. */
  async tick() {
    const s = this.state;
    const dep = this.deployment();
    const genesis = (await this.qrl.genesis()).hash;
    const swap = dep && dep.qrl && dep.qrl.PremiumSwap ? toHex(dep.qrl.PremiumSwap) : null;
    const depGenesis = dep ? lower(dep.qrlGenesisHash) : null;

    // The chain regenerated: every lot of an earlier genesis went with it.
    for (const lot of [...s.lots]) {
      if (lot.genesis && lower(lot.genesis) !== lower(genesis)) this.finish(lot, 'the QRL chain was regenerated; the lot went with it');
    }
    if (s.pending && s.pending.genesis && lower(s.pending.genesis) !== lower(genesis)) s.pending = null;

    if (!swap || !depGenesis || depGenesis !== lower(genesis) || lower(await this.qrl.code(swap)) === '0x') {
      this.save();
      const reason = !swap ? 'no PremiumSwap in the deployment record' : `waiting for the QRL leg of genesis ${genesis} (the record names ${dep && dep.qrlGenesisHash})`;
      this.warnOnce('leg', reason);
      this.writeStatus({ ready: false, reason, qrlGenesis: genesis });
      return { ready: false, reason };
    }
    this.clearWarning('leg', `the QRL leg of genesis ${genesis} is live: PremiumSwap ${swap}`);
    if (!s.deployment || lower(s.deployment.swap) !== lower(swap) || lower(s.deployment.genesis) !== lower(genesis)) {
      s.deployment = { swap, genesis };
    }
    if (s.scan.relay && this.relay && lower(s.scan.relay) !== lower(this.relay)) s.scan = { relay: this.relay, from: null };
    s.scan.relay = this.relay;

    const head = await this.qrl.head();
    const now = big(head.timestamp);

    await this.resolvePending(now);
    await this.scanLeaves();
    for (const lot of [...s.lots]) {
      try {
        await this.follow(lot, now, swap);
      } catch (e) {
        this.warn(`solver   lot ${short(lot.lotId)}: ${this.errorName(e)}`);
      }
      this.save();
    }

    const funds = await this.funds();
    await this.maybeQuote(now, swap, genesis, funds);
    this.save();

    const status = {
      ready: funds.qrl > 0n,
      reason: funds.qrl > 0n ? null : 'the solver holds no QRL on this genesis (the redeploy funds SOLVER_ADDRESS)',
      qrlGenesis: genesis,
      swap,
      qrl: { address: this.qrl.address, balance: funds.qrl },
      origin: { address: this.origin.address, balance: funds.origin, claimCost: funds.claimCost, low: funds.originLow },
      openLots: s.lots.length,
      pending: Boolean(s.pending),
      lastDone: s.done.length ? s.done[s.done.length - 1].outcome : null,
    };
    this.writeStatus(status);
    return status;
  }

  errorName(e) {
    return this.errors ? revertName(this.errors, e) : String(e?.shortMessage || e?.message || e);
  }

  async funds() {
    const qrl = await this.qrl.balance(this.qrl.address);
    let origin = null;
    let claimCost = null;
    let originLow = false;
    if (this.origin !== this.qrl && typeof this.origin.feePerGas === 'function') {
      origin = await this.origin.balance(this.origin.address);
      claimCost = this.claimGas * (await this.origin.feePerGas());
      originLow = origin < claimCost;
      if (originLow) {
        this.warnOnce('eth', `the solver's origin account ${this.origin.address} holds ${origin} wei, below the ${claimCost} one claim needs (${this.claimGas} gas); it quotes nothing until funded, since an unclaimable lot forfeits its bond`);
      } else {
        this.clearWarning('eth', `the solver's origin account is funded again (${origin} wei)`);
      }
    }
    return { qrl, origin, claimCost, originLow };
  }

  /* -------------------------------------------------------------- quotes */

  /**
   * A quote written down and possibly sent: landed (the swap knows its lot
   * id) -> a lot; still inside its quote window -> sent again with the SAME
   * secret (a second landing is refused `HashlockUsed`, so it lands once);
   * past the window -> it can no longer land, and is dropped.
   */
  async resolvePending(now) {
    const p = this.state.pending;
    if (!p) return;
    const sv = this.solverFor(p.asset, p.swap);
    if (!sv) {
      this.state.pending = null;
      return;
    }
    const l = await sv.lotOf(p.lotId);
    if (Number(l.status) !== 0) {
      this.state.lots.push({ ...p, recorded: 'resolved after a restart' });
      this.state.pending = null;
      this.log(`solver   quote of lot ${short(p.lotId)} found on the swap after a restart; followed`);
      this.save();
      return;
    }
    if (now >= this.clock.quoteCloses(p.epoch)) {
      this.state.pending = null;
      this.log(`solver   quote of lot ${short(p.lotId)} (epoch ${p.epoch}) never landed; its window has closed`);
      this.save();
      return;
    }
    const why = await sv.quoteRefusal(p);
    if (why) {
      // Kept: the first send may still land inside the window.
      this.warnOnce(`pending:${p.lotId}`, `the unresolved quote of lot ${short(p.lotId)} would now be refused (${why}); waiting for the window to close`);
      return;
    }
    try {
      await sv.send(p);
    } catch (e) {
      this.warn(`solver   resending lot ${short(p.lotId)}: ${this.errorName(e)}`);
      return;
    }
    this.state.lots.push({ ...p });
    this.state.pending = null;
    this.save();
  }

  /**
   * One quote per offering per asset, in its quote window: `shareBps` of what
   * it may sell, raised to the D4 minimum lot (`ceil(available / MAX_LOTS)`)
   * or the whole of it, at the reserve plus `priceBps`, cut to `maxLotValue`
   * and to what the account holds less `qrlReserve`, and never where the
   * origin account cannot pay for the claim. Priced from views read once the
   * offering is judged: where no quote has judged it yet, the solver's
   * judging quote does first (`Solver.judge`, OC-SWAP-03).
   */
  async maybeQuote(now, swap, genesis, funds) {
    const s = this.state;
    if (s.pending) return;
    const t = this.clock.epochOf(now) - 1n;
    if (t < 0n || now < this.clock.quoteOpens(t) || now >= this.clock.quoteCloses(t)) return;
    for (const a of this.assets) {
      const asset = toHex(a.address);
      if (s.lots.some((x) => lower(x.asset) === lower(asset) && big(x.epoch) === t && lower(x.swap) === lower(swap))) continue;
      if (s.done.some((x) => lower(x.asset) === lower(asset) && big(x.epoch) === t && lower(x.swap) === lower(swap) && lower(x.genesis) === lower(genesis))) continue;
      const mark = `${lower(asset)}@${t}@${lower(swap)}`;
      if (this.skipped.has(mark)) continue;
      const sv = this.solverFor(asset, swap);
      const skip = (why) => {
        this.skipped.add(mark);
        this.log(`solver   no quote for epoch ${t} of ${a.symbol || asset}: ${why}`);
      };
      if (funds.originLow) {
        skip('the origin account cannot pay for a claim');
        continue;
      }
      if ((await sv.available(t)) === 0n) continue; // no offer recorded yet, or nothing left to sell: looked at again next tick
      // A named refusal of the swap's stands for this offering; anything
      // else (a node that did not answer) is looked at again next tick.
      const refused = (why) => {
        if (/^[A-Z][A-Za-z0-9]*$/.test(why)) skip(`the swap would refuse it (${why})`);
        else this.warn(`solver   quote for epoch ${t} not checked (${why}); tried again next tick`);
      };
      // The views price at the failure count the offering's first quote may
      // still move: judged first, then read (OC-SWAP-03).
      let judged;
      try {
        judged = await sv.judge(t);
      } catch (e) {
        judged = { ok: false, error: `the judging quote was not confirmed: ${this.errorName(e)}` };
      }
      if (!judged.ok) {
        refused(judged.error);
        continue;
      }
      let lot = null;
      let why = null;
      // Read, then checked as a call; a `BondMismatch` means the views moved
      // between the two (another quote judged the offering or fixed its
      // reserve): read again and checked once more.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sized = await this.size(sv, t, await sv.available(t), funds.qrl);
        if (sized.skip) {
          why = null;
          lot = null;
          skip(sized.skip);
          break;
        }
        lot = await sv.prepare(t, sized.shares, { value: sized.value });
        why = await sv.quoteRefusal(lot);
        if (why !== 'BondMismatch') break;
      }
      if (!lot) continue;
      if (why) {
        refused(why);
        continue;
      }
      // Written before it is sent: the secret of a lot that lands survives a crash.
      s.pending = { ...lot, genesis, at: new Date().toISOString() };
      this.save();
      try {
        await sv.send(lot);
      } catch (e) {
        this.warn(`solver   quote of lot ${short(lot.lotId)} unconfirmed (${this.errorName(e)}); resolved next tick`);
        return;
      }
      s.lots.push({ ...s.pending });
      s.pending = null;
      this.save();
      funds.qrl -= lot.value + lot.bond;
    }
  }

  /** Shares and value of the lot to quote, or `{ skip }` with the reason. */
  async size(sv, t, avail, balance) {
    const MAX_LOTS = 32n;
    // Rounds up, as the swap's own minimum does (D4).
    const least = (avail + MAX_LOTS - 1n) / MAX_LOTS;
    let shares = (avail * this.shareBps) / BPS;
    if (shares < least) shares = least < avail ? least : avail;
    const priceOf = async (n) => {
      const reserve = await sv.required(t, n);
      // Rounds up, toward the escrow: never below the reserve.
      return (reserve * (BPS + this.priceBps) + BPS - 1n) / BPS;
    };
    let value = await priceOf(shares);
    const budget = balance > this.qrlReserve ? balance - this.qrlReserve : 0n;
    // The bond is at most the governable ceiling's top, 1,500 bps (item 17), of the value.
    const cap = [this.maxLotValue, (budget * BPS) / (BPS + 1_500n)].filter((x) => x !== null).reduce((m, x) => (x < m ? x : m));
    if (value > cap) {
      shares = value === 0n ? 0n : (shares * cap) / value;
      if (shares === 0n || (shares < least && shares !== avail)) {
        return { skip: `the smallest lot the swap takes (${least} shares, D4) costs more than ${fmt(cap)} QRL (${this.maxLotValue !== null && cap === this.maxLotValue ? 'SOLVER_MAX_LOT_QRL' : 'the balance less SOLVER_QRL_RESERVE'})` };
      }
      value = await priceOf(shares);
    }
    if (value === 0n) return { skip: 'the reserve prices the lot at zero' };
    return { shares, value };
  }

  /* -------------------------------------------------------------- the lock */

  /** Read `LeavesPublished` from where the last pass stopped, in chunks, keeping recent lists. */
  async scanLeaves() {
    if (!this.relay || !this.state.lots.some((l) => !l.claimedOrigin)) return;
    const s = this.state;
    const head = await this.origin.head();
    const latest = big(head.latest);
    let from = s.scan.from === null || s.scan.from === undefined ? null : big(s.scan.from);
    if (from === null) {
      from = latest > this.lookbackBlocks ? latest - this.lookbackBlocks : 0n;
      if (from < this.fromBlock) from = this.fromBlock;
    }
    const relayAbi = this.relayAbi || (this.anySolver() && this.anySolver().relayAbi);
    if (!relayAbi) return;
    while (from <= latest) {
      const to = from + this.scanChunk - 1n < latest ? from + this.scanChunk - 1n : latest;
      for (const ev of parseLogs(relayAbi, await this.origin.logs(this.relay, from, to))) {
        if (ev.name !== 'LeavesPublished') continue;
        const leaves = [...ev.args.leaves];
        // A relay binds each root's leaf count into what its signers sign and
        // publishes only a list of that length (audit 2026-09-29, OL-01); a
        // list of any other length is a relay without that rule carrying a
        // front-runner's interior nodes, and holds no lock to find.
        const count = await this.leafCountAt(relayAbi, ev.args.epoch);
        if (count !== null && count !== BigInt(leaves.length)) {
          this.log(`solver   ALARM: epoch ${ev.args.epoch}: the relay published ${leaves.length} leaves for a root of ${count}; ignored`);
          continue;
        }
        s.published[String(ev.args.epoch)] = leaves;
      }
      from = to + 1n;
      s.scan.from = from;
    }
    const keys = Object.keys(s.published).map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    while (keys.length > PUBLISHED_KEEP) delete s.published[String(keys.shift())];
  }

  anySolver() {
    return this.solvers.values().next().value || null;
  }

  /** The leaf count the relay admitted `epoch`'s root with, or null on a relay that records none. */
  async leafCountAt(relayAbi, epoch) {
    try {
      const r = await this.origin.call(this.relay, relayAbi, 'leafCounts', [epoch]);
      return BigInt(Array.isArray(r) ? r[0] : r);
    } catch {
      return null;
    }
  }

  lockOf(lot) {
    if (!lot.item) return null;
    for (const [epoch, leaves] of Object.entries(this.state.published)) {
      const found = Solver.lockFrom(lot.item, epoch, leaves);
      if (found) return found;
    }
    return null;
  }

  /* -------------------------------------------------------------- a lot to its end */

  /**
   * Follow one lot by its status on the swap:
   *  - Quoted: refunded, QRL and bond, once the offering is selected or its
   *    selection window has passed;
   *  - Selected: claimed on the origin chain once its lock is published and
   *    while the reveal budget allows (D12); after its own claim, the
   *    preimage carried to QRL if the relayer has not within `carryAfter`;
   *    at the QRL expiry, unclaimed, refunded — its QRL only, the bond is
   *    forfeited to the offered epoch's proceeds (I33, `releaseForfeits`,
   *    which the coupon pulls; the solver never calls it) — and never where
   *    the escrow paid the lot: an origin claim of an earlier run is read from
   *    the escrow (`isSpent`, OC-SWAP-04), carried even after evmExpiry, and
   *    at the QRL expiry such a lot is reported ALARM and left unrefunded;
   *  - Claimed: its bond refunded (the relayer may have done it: the swap
   *    then holds no bond for it);
   *  - Refunded / gone: finished.
   */
  async follow(lot, now, swap) {
    const sv = this.solverFor(lot.asset, lot.swap || swap);
    if (!sv) return this.finish(lot, 'its asset left the manifest');
    const current = lower(lot.swap) === lower(swap);
    const l = await sv.lotOf(lot.lotId);
    const status = STATUS[Number(l.status)];
    const bondLeft = big(l.bond);
    if (status !== lot.status) {
      if (status === 'Selected') this.log(`solver   lot ${short(lot.lotId)} selected (${lot.shares} shares, epoch ${lot.epoch})`);
      lot.status = status;
    }

    if (status === 'None') return this.finish(lot, 'the swap does not know it (a replaced leg)');
    if (status === 'Refunded') {
      const outcome = lot.claimedOrigin ? 'ALARM: paid on the origin chain and refunded on QRL — the preimage never reached QRL in time' : lot.selected ? `lapsed unclaimed; QRL back, bond ${fmt(lot.bond)} forfeited to epoch ${lot.epoch}` : 'not selected; QRL and bond back';
      return this.finish(lot, outcome);
    }
    if (status === 'Claimed') {
      if (bondLeft === 0n) return this.finish(lot, 'claimed; bond back');
      const r = await sv.refund(lot.lotId);
      if (r.ok) this.log(`solver   bond of lot ${short(lot.lotId)} returned (${fmt(lot.bond)} QRL)`);
      if (r.ok || r.error.includes('NotRefundable')) return this.finish(lot, 'claimed; bond back');
      return undefined;
    }
    if (status === 'Evicted') {
      const r = await sv.refund(lot.lotId);
      if (r.ok) {
        this.log(`solver   lot ${short(lot.lotId)} evicted by a better quote: ${fmt(lot.value + lot.bond)} QRL refunded`);
        return this.finish(lot, 'evicted by a better quote; QRL and bond back');
      }
      return undefined;
    }
    if (status === 'Quoted') {
      if (now < this.clock.quoteCloses(lot.epoch)) return undefined;
      const r = await sv.refund(lot.lotId);
      if (r.ok) {
        this.log(`solver   lot ${short(lot.lotId)} not selected: ${fmt(lot.value + lot.bond)} QRL refunded`);
        return this.finish(lot, 'not selected; QRL and bond back');
      }
      return undefined;
    }

    // Selected.
    lot.selected = true;
    const qrlExpiry = this.clock.settlementCloses(lot.epoch);
    const evmExpiry = this.clock.evmExpiry(lot.epoch);
    // A claim sent by an earlier run that landed before it was recorded is
    // read from the escrow itself (OC-SWAP-04): before evmExpiry the escrow's
    // refusal says so as well (ProofSpent, below), but after it every claim
    // is refused PremiumExpired, and a restart there used to leave the
    // preimage uncarried and refund the QRL of a lot whose shares it held.
    if (!lot.claimedOrigin && lot.claiming && lot.leaf && (await sv.isSpent(lot.leaf).catch(() => false))) {
      lot.claimedOrigin = true;
      // Past evmExpiry the margin is running: carried at once, not after `carryAfter`.
      lot.claimedOriginAt = now >= evmExpiry ? 0n : now;
      this.log(`solver   lot ${short(lot.lotId)} was claimed on the origin chain by an earlier run (the escrow spent its lock)`);
    }
    if (now >= qrlExpiry) {
      if (lot.claimedOrigin) {
        // Never refunded: the lot was paid on the origin chain, and taking its
        // QRL back as well would leave the solver both legs (I31.4).
        this.warn(`solver   ALARM lot ${short(lot.lotId)} was paid on the origin chain and its QRL lock expired before the preimage reached QRL; its QRL is NOT refunded to this solver, its bond is forfeited`);
        return this.finish(lot, `ALARM: paid on the origin chain and expired on QRL before the preimage reached it; QRL left unrefunded, bond ${fmt(lot.bond)} forfeited to epoch ${lot.epoch}`);
      }
      const r = await sv.refund(lot.lotId);
      if (r.ok) this.log(`solver   lot ${short(lot.lotId)} lapsed unclaimed: ${fmt(lot.value)} QRL refunded, bond ${fmt(lot.bond)} forfeited to epoch ${lot.epoch}`);
      return undefined; // finished next pass, as Refunded
    }
    if (!current) return undefined; // a replaced leg on the same genesis: refunds only

    if (lot.claimedOrigin) {
      // The relayer carries the revealed preimage (PremiumClaimed); the solver
      // does it itself if that has not happened within `carryAfter`.
      const after = this.carryAfter ?? (sv.revealBudget !== null ? sv.revealBudget / 2n : 0n);
      if (now >= big(lot.claimedOriginAt || 0) + after) {
        const r = await sv.carry(lot);
        if (r.ok) this.log(`solver   carried the preimage of lot ${short(lot.lotId)} to QRL itself`);
      }
      return undefined;
    }
    if (now >= evmExpiry) return undefined; // the escrow no longer pays it: the refund at the QRL expiry

    if (!lot.item) {
      lot.item = await sv.lockItem(lot.lotId);
      lot.leaf = lot.item.leaf;
    }
    const found = this.lockOf(lot);
    if (!found) return undefined;
    // Written before the claim is sent: a claim of an earlier run that landed
    // is recognised by the escrow's refusal (`ProofSpent`) and not retried.
    const claimed = await sv.claim(lot, null, {
      found,
      beforeSend: async () => {
        lot.claiming = new Date().toISOString();
        this.save();
      },
    });
    if (claimed) {
      lot.claimedOrigin = true;
      lot.claimedOriginAt = now;
      return undefined;
    }
    if (lot.refusedWith && /ProofSpent/.test(lot.refusedWith) && lot.claiming) {
      lot.claimedOrigin = true;
      lot.claimedOriginAt = now;
      this.log(`solver   lot ${short(lot.lotId)} was claimed on the origin chain by an earlier run`);
    }
    return undefined;
  }
}

module.exports = { Solver, SolverService, STATUS, solverKeyNames, solverSetting, relayerQrlAccounts, keySeparation, lockFile, fmt, envKey };
