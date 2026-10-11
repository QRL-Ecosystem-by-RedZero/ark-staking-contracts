/**
 * The reporter side of `ArkReferenceOracle` (yellow paper §6.1, technical
 * reference §1.4 and §3.7; staking CLAUDE.md item 122): one or more reporter
 * keys posting one spot observation each per round, and each key's figure
 * for the realised yield once per epoch. `scripts/oracle-report.js` runs it
 * as a daemon against a node; the e2e harness runs it in-process
 * (`scripts/e2e/helpers/oracle.js`), where its clock is the scenario's.
 *
 * The one rule this module exists to enforce: **a key reports a round once,
 * and only a round the contract will take.** Before every send the report is
 * simulated from the key's own account (`eth_call`), and the contract's own
 * answer decides: `RoundTooSoon` waits, `NotOpenRound` names the open round,
 * `AlreadyReported` passes the key over (or, where the open round lapsed,
 * opens the next), `WrongVenueList` stops every key. A key also keeps the
 * rounds it sent in memory, so a send whose receipt was lost is not sent
 * again; the contract would refuse it anyway.
 *
 * THE ROUND (contract `submit`)
 * -----------------------------
 * A round is due `roundIntervalSeconds` (τ_o, read from `settings()` every
 * step) after the last accepted round. The open round is `lastRound + 1`
 * unless a round without a quorum lapsed (it stood τ_o; the next id opens
 * it); the revert `NotOpenRound(roundId, open)` names it. Every selected key
 * posts the same spot, read once per round, in rotating order, and the keys
 * stop as soon as the round is accepted: a report after the k_o-th lands on a
 * closed round. Nothing is posted where the spot cannot be formed (a failed
 * market read, the freeze list in force for a key whose stETH/ETH leg the
 * freeze list does not name): the feed then falls silent after its
 * heartbeat, by design (I40).
 *
 * THE YIELD (contract `submitYield`)
 * ----------------------------------
 * `submitYield(epoch, chainId, asset, bps)` takes only the epoch just closed
 * (`now / EPOCH − 1`), once per key; the figure is the median of the first
 * k_o reports, and the last figure accepted is read until a later one is.
 * Every selected key posts its figure once per closed epoch and per yield
 * key, at the first step after the boundary. The figure comes from the
 * caller's `yieldSource(key)`; null or a throw posts nothing for that key.
 */
const fs = require('fs');
const { revertName } = require('../../ecdsa-stakings/relayer/engine/errors');

const ZERO20 = '0x' + '00'.repeat(20);

/** Revert data carried by an error from either client, or null. */
function revertData(e) {
  for (const c of [e?.data, e?.info?.error?.data, e?.cause?.data, e?.innerError?.data, e?.error?.data, e?.cause?.cause?.data]) {
    const data = typeof c === 'string' ? c : c?.data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data;
  }
  const m = /0x[0-9a-fA-F]{8,}/.exec(String(e?.message || ''));
  return m ? m[0] : null;
}

/**
 * The n-th of `count` static words of a revert's arguments, whatever the
 * word width: 32 bytes on the harness, 64 on a QIP-55 node.
 */
function revertWord(e, index, count) {
  const data = revertData(e);
  if (!data) return null;
  const body = data.slice(10);
  if (!body.length || body.length % count !== 0) return null;
  const w = body.length / count;
  return BigInt('0x' + body.slice(index * w, (index + 1) * w));
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** A read, retried on any error (the QRL client already retries a dropped connection for a minute). */
async function withRetry(fn, { attempts = 4, backoffMs = 5000, label = 'read', log = () => {} } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= attempts) throw e;
      log(`oracle   ${label} failed (${(e.shortMessage || e.message || String(e)).slice(0, 160)}); retrying`);
      await sleep(backoffMs * (i + 1));
    }
  }
}

class OracleReporter {
  /**
   * @param o.reporters   [{ label, client }]: each client signs as one reporter key (a QRL client, or a harness account)
   * @param o.oracle      the ArkReferenceOracle address
   * @param o.abi         its ethers Interface
   * @param o.errors      the custom-error Interface revert names are read against
   * @param o.priceKey    { chainId, asset } of the series the reporters quote: the book's (0, address(0))
   * @param o.yieldKeys   [{ label, chainId, asset }]: every key a figure is posted at
   * @param o.epochLength seconds of an epoch on this profile
   * @param o.priceSource async () => { wei, line } — throws where no spot can be formed
   * @param o.yieldSource async (yieldKey, epoch) => bps or null
   * @param o.holdFile    a path whose existence holds every report (another process asked for silence)
   * @param o.now         async () => the chain's timestamp, as a BigInt
   */
  constructor(o) {
    this.reporters = o.reporters;
    this.oracle = o.oracle;
    this.abi = o.abi;
    this.errors = o.errors;
    this.priceKey = o.priceKey || { chainId: 0n, asset: ZERO20 };
    this.yieldKeys = o.yieldKeys || [];
    this.epochLength = BigInt(o.epochLength);
    this.priceSource = o.priceSource;
    this.yieldSource = o.yieldSource || (async () => null);
    this.holdFile = o.holdFile || null;
    this.now = o.now;
    this.log = o.log || console.log;
    this.paused = false;
    this.turn = 0;
    /** label -> Set of round ids this key sent. */
    this.sentRounds = new Map(this.reporters.map((r) => [r.label, new Set()]));
    /** `${label}|${yieldKey}|${epoch}` this process sent. */
    this.sentYields = new Set();
    this.lastRoundLogged = null;
    this.heldLogged = false;
    this.stats = { rounds: 0, reports: 0, yields: 0, failures: 0 };
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.heldLogged = false;
  }

  held() {
    if (this.paused) return 'paused';
    if (this.holdFile && fs.existsSync(this.holdFile)) return `hold file ${this.holdFile}`;
    return null;
  }

  async view(method, args = [], from) {
    const res = await withRetry(() => this.reporters[0].client.call(this.oracle, this.abi, method, args, from ? { from } : {}), { label: method, log: this.log });
    return res.length === 1 ? res[0] : res;
  }

  /** settings(), the venue list in force, the last round and the chain's time. */
  async state() {
    const s = await this.view('settings');
    const pick = (name, i) => (s[name] !== undefined ? s[name] : s[i]);
    const settings = {
      quorum: Number(pick('reporterQuorum', 0)),
      interval: BigInt(pick('roundIntervalSeconds', 1)),
      heartbeat: BigInt(pick('heartbeatSeconds', 2)),
      maxStepBps: BigInt(pick('maxStepBps', 3)),
      maxDispersionBps: BigInt(pick('maxDispersionBps', 4)),
      venueListHash: String(pick('venueListHash', 7)),
      freezeVenueListHash: String(pick('freezeVenueListHash', 8)),
    };
    const inForce = String(await this.view('venueListInForce'));
    const lr = await this.view('latestRound', [this.priceKey.chainId, this.priceKey.asset]);
    const latest = { roundId: BigInt(lr[0]), updatedAt: BigInt(lr[1]), observation: BigInt(lr[2]), clamped: Boolean(lr[3]) };
    const now = BigInt(await withRetry(() => this.now(), { label: 'head', log: this.log }));
    return { settings, inForce, latest, now };
  }

  /** Reporters in this step's order: rotated, so every key carries the gas in turn. */
  order(only = null) {
    const list = only ? this.reporters.filter((r) => only.includes(r.label)) : this.reporters;
    const n = list.length;
    if (!n) return [];
    const k = this.turn % n;
    return [...list.slice(k), ...list.slice(0, k)];
  }

  /** The revert name of simulating `method(args)` from `r`, or null where it would succeed. */
  async simulate(r, method, args) {
    try {
      await r.client.call(this.oracle, this.abi, method, args, { from: r.client.address });
      return { ok: true };
    } catch (e) {
      const name = revertName(this.errors, e);
      // A transport failure is not a refusal: let the caller's retry see it.
      if (/ECONNREFUSED|ECONNRESET|socket hang up|ETIMEDOUT|CONNECTION TIMEOUT|fetch failed/i.test(name)) throw e;
      return { ok: false, name, error: e };
    }
  }

  /**
   * One report of `r` for the open round, at `spot`: finds the round the
   * contract takes from this key, simulates, sends. Returns
   * { sent, round, why } and never throws for a refusal.
   */
  async reportOnce(r, firstGuess, spot, venueList) {
    const key = this.priceKey;
    const args = (round) => [round, key.chainId, key.asset, spot, venueList];
    let round = firstGuess;
    for (let hop = 0; hop < 4; hop += 1) {
      if (this.sentRounds.get(r.label).has(round)) {
        // Sent before (perhaps its receipt was lost): never again. A lapse may have opened the next.
        round += 1n;
        continue;
      }
      const sim = await this.simulate(r, 'submit', args(round));
      if (sim.ok) {
        try {
          await r.client.send(this.oracle, this.abi, 'submit', args(round));
        } catch (e) {
          this.stats.failures += 1;
          return { sent: false, round, why: `send failed: ${(e.shortMessage || e.message || String(e)).slice(0, 200)}` };
        }
        this.sentRounds.get(r.label).add(round);
        this.stats.reports += 1;
        return { sent: true, round };
      }
      if (sim.name === 'NotOpenRound') {
        const open = revertWord(sim.error, 1, 2);
        if (open === null || open === round) return { sent: false, round, why: 'NotOpenRound' };
        round = open;
        continue;
      }
      if (sim.name === 'AlreadyReported') {
        // This key reported in the open round, which has no quorum yet; once it
        // has stood τ_o it lapses and the next id opens (contract `submit`).
        this.sentRounds.get(r.label).add(round);
        round += 1n;
        continue;
      }
      return { sent: false, round, why: sim.name, opensAt: sim.name === 'RoundTooSoon' ? revertWord(sim.error, 0, 1) : null };
    }
    return { sent: false, round, why: 'no round open to this key' };
  }

  /**
   * One round if one is due: the spot read once, then each selected key in
   * turn until the round is accepted. `spots` (label -> wei) overrides the
   * spot per key and `only` restricts the keys, `sequence` fixes their order:
   * the scenarios' injected reports. Returns what happened, and when the
   * next round is due.
   */
  async stepRound({ spots = null, only = null, sequence = null, force = false } = {}) {
    const st = await this.state();
    const { settings, latest, now } = st;
    const due = latest.updatedAt === 0n ? now : latest.updatedAt + settings.interval;
    if (now < due) return { due, posted: false, reason: 'not due' };
    if (st.inForce.toLowerCase() !== settings.venueListHash.toLowerCase() && !force) {
      // The freeze list is in force: it names no stETH/ETH venue, so this leg is not formed (technical reference §3.7).
      this.logRound(`round ${latest.roundId + 1n}: the freeze venue list is in force; the stETH/ETH leg is not formed, nothing posted`);
      return { due: now + settings.interval, posted: false, reason: 'freeze list in force' };
    }
    let spot = null;
    let line = '';
    if (!spots) {
      try {
        const p = await this.priceSource();
        spot = BigInt(p.wei);
        line = p.line || '';
      } catch (e) {
        this.stats.failures += 1;
        this.logRound(`round ${latest.roundId + 1n}: market read failed (${(e.message || String(e)).slice(0, 200)}); nothing posted`);
        return { due: now + (settings.interval < 60n ? settings.interval : 60n), posted: false, reason: 'market read failed' };
      }
    }
    const reporters = sequence ? sequence.map((l) => this.reporters.find((r) => r.label === l)).filter(Boolean) : this.order(only);
    this.turn += 1;
    const sent = [];
    const refused = [];
    let accepted = null;
    let nextGuess = latest.roundId + 1n;
    for (const r of reporters) {
      const value = spots ? BigInt(spots[r.label]) : spot;
      if (spots && spots[r.label] === undefined) continue;
      const res = await this.reportOnce(r, nextGuess, value, st.inForce);
      if (res.sent) {
        sent.push(`${r.label}@${res.round}`);
        nextGuess = res.round;
      } else {
        refused.push(`${r.label}: ${res.why}`);
        if (res.why === 'RoundTooSoon' || res.why === 'WrongVenueList') break;
      }
      const lr = await this.view('latestRound', [this.priceKey.chainId, this.priceKey.asset]);
      if (BigInt(lr[0]) > latest.roundId) {
        accepted = { roundId: BigInt(lr[0]), updatedAt: BigInt(lr[1]), observation: BigInt(lr[2]), clamped: Boolean(lr[3]) };
        break;
      }
    }
    if (accepted) {
      this.stats.rounds += 1;
      this.logRound(`round ${accepted.roundId} accepted ${fmt(accepted.observation)} QRL/stETH${accepted.clamped ? ' (clamped to s_obs)' : ''}; reports ${sent.join(', ') || 'none from here'}${refused.length ? `; passed over ${refused.join('; ')}` : ''}${line ? `; ${line}` : ''}`);
      return { due: accepted.updatedAt + settings.interval, posted: true, accepted, sent, refused };
    }
    this.logRound(`round ${nextGuess}: no quorum yet; reports ${sent.join(', ') || 'none'}${refused.length ? `; passed over ${refused.join('; ')}` : ''}`);
    return { due: now + settings.interval, posted: sent.length > 0, sent, refused };
  }

  logRound(line) {
    this.log(`oracle   ${line}`);
  }

  /** Each key's figure for the epoch just closed, at every yield key not yet reported from here. */
  async stepYields() {
    if (!this.yieldKeys.length) return { posted: 0 };
    const now = BigInt(await withRetry(() => this.now(), { label: 'head', log: this.log }));
    const epoch = now / this.epochLength;
    if (epoch === 0n) return { posted: 0 };
    const closed = epoch - 1n;
    let posted = 0;
    for (const yk of this.yieldKeys) {
      const pending = this.order().filter((r) => !this.sentYields.has(`${r.label}|${yk.label}|${closed}`));
      if (!pending.length) continue;
      let bps = null;
      try {
        bps = await this.yieldSource(yk, closed);
      } catch (e) {
        this.log(`oracle   yield ${yk.label} epoch ${closed}: no figure (${(e.message || String(e)).slice(0, 160)}); nothing posted, the last figure accepted stands`);
        continue;
      }
      if (bps === null || bps === undefined) continue;
      const done = [];
      for (const r of pending) {
        const args = [closed, yk.chainId, yk.asset, BigInt(bps)];
        const sim = await this.simulate(r, 'submitYield', args);
        if (!sim.ok) {
          if (sim.name === 'AlreadyReported') this.sentYields.add(`${r.label}|${yk.label}|${closed}`);
          else done.push(`${r.label}: ${sim.name}`);
          continue;
        }
        try {
          await r.client.send(this.oracle, this.abi, 'submitYield', args);
          this.sentYields.add(`${r.label}|${yk.label}|${closed}`);
          this.stats.yields += 1;
          posted += 1;
          done.push(r.label);
        } catch (e) {
          this.stats.failures += 1;
          done.push(`${r.label}: send failed`);
        }
      }
      const figure = await this.view('realisedYieldBps', [yk.chainId, yk.asset]);
      this.log(`oracle   yield ${yk.label} epoch ${closed}: ${bps} bps from ${done.join(', ') || 'nobody'}; in force ${figure} bps`);
    }
    return { posted, epoch: closed };
  }

  /** One pass: a round if one is due, the yields if a boundary passed. Nothing while held. */
  async step(opts = {}) {
    const held = this.held();
    if (held) {
      if (!this.heldLogged) this.log(`oracle   held (${held}): nothing posted`);
      this.heldLogged = true;
      return { held: true };
    }
    this.heldLogged = false;
    const round = await this.stepRound(opts);
    const yields = await this.stepYields();
    return { round, yields };
  }

  /**
   * The daemon: a step, then a wall-clock wait until the next round is due
   * (bounded by the next epoch boundary and `maxWaitSeconds`). A failed
   * step is logged and retried; nothing here exits on a transient error.
   */
  async run({ once = false, maxWaitSeconds = 60, stop = () => false } = {}) {
    for (;;) {
      let wait = maxWaitSeconds;
      try {
        const r = await this.step();
        if (once) return r;
        if (!r.held && r.round && r.round.due !== undefined) {
          const now = BigInt(await this.now());
          const boundary = (now / this.epochLength + 1n) * this.epochLength;
          const next = r.round.due < boundary ? r.round.due : boundary;
          const gap = Number(next > now ? next - now : 0n) + 2;
          wait = Math.max(3, Math.min(maxWaitSeconds, gap));
        }
      } catch (e) {
        this.stats.failures += 1;
        this.log(`oracle   step failed: ${(e.shortMessage || e.message || String(e)).slice(0, 300)}`);
        if (once) throw e;
      }
      for (let s = 0; s < wait; s += 1) {
        if (stop()) return null;
        await sleep(1000);
      }
      if (stop()) return null;
    }
  }
}

function fmt(wei) {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n) / 10n ** 12n;
  return `${whole}.${String(frac).padStart(6, '0')}`;
}

/**
 * The round rule of the contract (`_quorum`, `_step`), for a scenario to
 * state what a round must be accepted at: the median of the reports within
 * d_rep of the median of all of them, where k_o of them are, clamped to s_obs
 * of the last accepted observation. Null where there is no quorum.
 */
function expectedObservation(reports, { quorum, maxDispersionBps, maxStepBps, last }) {
  const v = reports.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = v.length;
  if (n < quorum) return null;
  const med = (lo, hi) => {
    const m = hi - lo;
    const mid = lo + Math.floor(m / 2);
    return m % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2n;
  };
  const median = med(0, n);
  let lo = n;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const gap = v[i] > median ? v[i] - median : median - v[i];
    if (gap * 10000n <= BigInt(maxDispersionBps) * median) {
      if (lo === n) lo = i;
      hi = i + 1;
    }
  }
  if (lo === n || hi - lo < quorum) return null;
  let obs = med(lo, hi);
  let clamped = false;
  if (last && BigInt(last) > 0n) {
    const L = BigInt(last);
    const s = BigInt(maxStepBps);
    const low = (L * (10000n - s)) / 10000n;
    const high = (L * (10000n + s)) / 10000n;
    if (obs < low) [obs, clamped] = [low, true];
    else if (obs > high) [obs, clamped] = [high, true];
  }
  return { observation: obs, clamped, kept: v.slice(lo, hi) };
}

module.exports = { OracleReporter, expectedObservation, revertWord, revertData, withRetry, fmt };
