/**
 * The court sweep (audit 2026-10-03, OC-OPS-26): every case the court holds
 * open, the next permissionless step that moves it toward `CaseFinal`, and,
 * where asked, that step sent.
 *
 * Why it exists: an open loss or censorship case keeps a determination open on
 * the bond (`openDetermination` at the assertion, `closeDetermination` only at
 * the case's end), and while any is open the bond refuses issuance with
 * `DeterminationOpen(n)`. A live court-live run that fails midway leaves its
 * cases open, and nothing closes them unless someone drives each one to
 * `finalize` or a lapse path.
 *
 * The steps it takes, and only these (each permissionless, none paying the
 * caller anything):
 *   - `finalize(caseId, payload)`: an unchallenged assertion after its
 *     challenge window (it stands, the finding reaches the bond); a drawn round
 *     after its appeal window (tallied on the votes revealed, a tie rejects);
 *     an escalation after `ESCALATION_LAPSE` (the appeal verdict); a case the
 *     governor or a lapse decided.
 *   - `lapseDraw(caseId)`: a challenged case nobody armed, four draw windows
 *     after its evidence window (OC-COURT-08); a round armed and never drawn,
 *     once its draw block has left reach and four draw windows have run. Round
 *     one rejects and refunds every deposit; a later round leaves the previous
 *     verdict standing (`Decided`), finalized next.
 *   - `closeEpochs(32)` on the bond, where the bond's strict epoch close would
 *     refuse the `closeDetermination` inside a finalize (`EpochGapTooLong`).
 *
 * The steps it never takes: `armDraw` and `drawPanel` (a panel drawn on a case
 * nobody attends seats jurors who never vote, and every silent seat is
 * slashed), votes of any kind, `appeal`, `escalateToGovernance`,
 * `ArkGovernor.resolve` (a retrial pushes the case away from closure),
 * `claim`, and `nameLossDestination` (it routes value to the beneficiary).
 *
 * Transport-neutral: `client` is any of scripts/lib/chains.js's clients
 * (`call`, `send`, `head`, `logs`, `timestampOf`), or the test adapter.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { defaultAbiCoder: qrlAbi } = require('@theqrl/abi');
const { revertName } = require('../../ecdsa-stakings/relayer/engine/errors');

const KIND = { 1: 'loss', 2: 'censorship', 3: 'severity', 4: 'recovery' };
const STAGE = { NONE: 0, CHALLENGE: 1, ROUNDS: 2, ESCALATED: 3, DECIDED: 4, FINAL: 5 };
const STAGE_NAME = ['none', 'challenge', 'rounds', 'escalated', 'decided', 'final'];
const UPHOLD = 1;
const REJECT = 2;
/** The bond's MAX_CLOSE: a gap longer than this refuses every path that closes epochs strictly. */
const MAX_CLOSE = 32n;
/** A case is stepped at most this many times in one sweep (a lapse, then the finalize it leaves due). */
const STEPS_PER_CASE = 3;

const ASSERTION_OPENED = 'AssertionOpened(bytes32,uint8,address,bytes,bytes32,uint256,uint256,uint256)';
const ASSERTION_TOPIC = keccak256(toUtf8Bytes(ASSERTION_OPENED)).toLowerCase();

const big = (x) => BigInt(x);
const n = (x) => Number(x);
const holdsDetermination = (kind) => kind === 1 || kind === 2;

/** One value, or a struct read by position (OC-OPS-02): the same reading as helpers/court.js `view`. */
async function view(client, address, abi, method, args = []) {
  const res = await client.call(address, abi, method, args);
  const outs = abi.getFunction(method).outputs;
  if (outs.length === 1 && !outs[0].components) return res[0];
  if (outs.length === 1 && outs[0].components) {
    const t = res[0];
    return Object.fromEntries(outs[0].components.map((c, i) => [c.name, t[i]]));
  }
  return Object.fromEntries(outs.map((o, i) => [o.name || String(i), res[i]]));
}

/**
 * The payload of every `AssertionOpened` the court emitted in `[fromBlock,
 * toBlock]`, by case id. The event carries a dynamic `bytes`, which the
 * QIP-55 table decoder does not read, so a v3 log (130-character topics) is
 * decoded here with @theqrl/abi's 64-byte-word coder; a harness log (66) with
 * the court's ethers interface. A scan range the node refuses is halved.
 */
async function assertionPayloads(client, court, courtAbi, fromBlock, toBlock, { chunk = 5000n, log = () => {} } = {}) {
  const out = new Map();
  let from = big(fromBlock);
  let step = big(chunk);
  while (from <= big(toBlock)) {
    const to = from + step - 1n < big(toBlock) ? from + step - 1n : big(toBlock);
    let logs;
    try {
      logs = await client.logs(court, from, to);
    } catch (e) {
      if (step <= 64n) throw e;
      step /= 2n;
      log(`log scan ${from}-${to} refused (${String(e.message).slice(0, 60)}); chunk ${step}`);
      continue;
    }
    for (const l of logs) {
      const t0 = String(l.topics[0] || '').toLowerCase();
      if (t0.slice(0, 66) !== ASSERTION_TOPIC) continue;
      try {
        if (t0.length === 130) {
          const caseId = `0x${String(l.topics[1]).slice(2, 66).toLowerCase()}`;
          const [payload] = qrlAbi.decode(['bytes', 'bytes32', 'uint256', 'uint256', 'uint256'], l.data);
          out.set(caseId, String(payload).toLowerCase());
        } else {
          const ev = courtAbi.parseLog({ topics: l.topics, data: l.data });
          out.set(String(ev.args.caseId).toLowerCase(), String(ev.args.payload).toLowerCase());
        }
      } catch (e) {
        log(`an AssertionOpened log at block ${l.blockNumber} did not decode: ${String(e.message).slice(0, 80)}`);
      }
    }
    from = to + 1n;
  }
  return out;
}

/** Seconds per block over the last `span` blocks; `fallback` where the client cannot say. */
async function blockSeconds(client, head, { span = 200n, fallback = 12 } = {}) {
  try {
    if (typeof client.timestampOf !== 'function' || head.latest <= span) return fallback;
    const then = await client.timestampOf(head.latest - span);
    const s = Number(head.timestamp - then) / Number(span);
    return s > 0 ? s : fallback;
  } catch {
    return fallback;
  }
}

/** The court's constants, read from the court: every one is scaled by the build profile. */
async function constants(client, court, abi) {
  const k = {};
  for (const name of ['COURT_DAY', 'DRAW_WINDOW', 'MAX_DRAW_LAPSES', 'ESCALATION_LAPSE', 'BLOCKHASH_REACH']) k[name] = big(await view(client, court, abi, name));
  return k;
}

/**
 * What a case's next permissionless step is, and when it becomes possible.
 * Pure: `c` is `caseOf`, `r` the round in progress (`roundOf(id, c.round)`),
 * `prev` the round before it (the verdict a later round's lapse leaves
 * standing), `r2` round two (an escalation's verdict). Returns
 *   { step: 'finalize' | 'lapseDraw' | null, at, atBlock, outcome, note }
 * where `at` is the earliest second and `atBlock` the earliest block number
 * (null where none applies), and `outcome` what the case closes on
 * ('uphold', 'reject', or 'uphold?'/'reject?' where votes may still be revealed).
 */
function nextStep(c, r, prev, r2, k, now) {
  const stage = n(c.stage);
  const day = k.COURT_DAY;
  const challengeEnd = big(c.openedAt) + big(c.challengeDays) * day;
  const evidenceEnd = challengeEnd + big(c.evidenceDays) * day;
  const lapses = k.MAX_DRAW_LAPSES * k.DRAW_WINDOW;
  const verdict = (x) => (n(x) === UPHOLD ? 'uphold' : 'reject');
  const unchallenged = /^(0x)?0*$/.test(String(c.challenger).toLowerCase().replace(/^q/, '0x'));
  if (stage === STAGE.FINAL) return { step: null, at: null, atBlock: null, outcome: verdict(c.outcome), note: 'final' };
  if (stage === STAGE.CHALLENGE && unchallenged) {
    return { step: 'finalize', at: challengeEnd, atBlock: null, outcome: 'uphold', note: 'unchallenged: stands at the close of its challenge window; the finding reaches the bond' };
  }
  if (stage === STAGE.CHALLENGE) {
    return { step: 'lapseDraw', at: evidenceEnd + lapses, atBlock: null, outcome: 'reject', note: 'challenged, never armed (OC-COURT-08): lapses four draw windows after the evidence window, every deposit refunded' };
  }
  if (stage === STAGE.ROUNDS) {
    const round = n(c.round);
    if (big(r.commitEnd) === 0n) {
      if (big(r.armedAt) === 0n) return { step: null, at: null, atBlock: null, outcome: '?', note: `round ${round} is due and unarmed: only armDraw moves it, which the sweep does not take (it seats jurors who will not vote)` };
      const atBlock = big(r.drawBlock) === 0n ? null : big(r.drawBlock) + k.BLOCKHASH_REACH + 1n;
      const at = n(r.lapses) >= n(k.MAX_DRAW_LAPSES) ? 0n : big(r.armedAt) + lapses;
      return round === 1
        ? { step: 'lapseDraw', at, atBlock, outcome: 'reject', note: 'round 1 armed, never drawn: lapses against the assertion, every deposit refunded, no seat drawn' }
        : { step: 'lapseDraw', at, atBlock, outcome: verdict(prev ? prev.verdict : 0), note: `round ${round} armed, never drawn (QL-19): round ${round - 1}'s verdict stands, then finalize` };
    }
    const tallied = n(r.verdict) !== 0 ? verdict(r.verdict) : n(r.upholds) > n(r.rejects) ? 'uphold' : 'reject';
    const final = n(r.verdict) !== 0 || now >= big(r.revealEnd);
    return { step: 'finalize', at: big(r.appealEnd), atBlock: null, outcome: final ? tallied : `${tallied}?`, note: `round ${round} drawn (${n(r.upholds)} uphold, ${n(r.rejects)} reject revealed): closes on its tally after the ${round === 3 ? 'reveal' : round === 2 ? 'escalation' : 'appeal'} window; unrevealed seats are slashed` };
  }
  if (stage === STAGE.ESCALATED) {
    return { step: 'finalize', at: big(c.escalatedAt) + k.ESCALATION_LAPSE, atBlock: null, outcome: verdict(r2 ? r2.verdict : 0), note: 'escalated: closes on the appeal verdict at its lapse (the governor is not asked to resolve)' };
  }
  if (stage === STAGE.DECIDED) return { step: 'finalize', at: 0n, atBlock: null, outcome: verdict(c.outcome), note: 'decided: finalize' };
  return { step: null, at: null, atBlock: null, outcome: '?', note: `stage ${stage}` };
}

/** Whether `plan` is possible at `now` and `block`. */
const due = (plan, now, block) => plan.step !== null && (plan.at === null || now >= plan.at) && (plan.atBlock === null || block >= plan.atBlock);

/**
 * The court, read: every case from `fromIndex` (one-based) to `caseCount`, its
 * state, its payload, and its next step. `payloads` (a Map) supplies payloads
 * the caller already holds; the rest are recovered from `AssertionOpened`.
 */
async function survey(o) {
  const { client, at, abi, fromIndex = 1n, ids = null, payloads = new Map(), fromBlock = 0n, log = () => {} } = o;
  const k = o.k || (await constants(client, at.court, abi.court));
  const head = await client.head();
  const now = head.timestamp;
  const block = head.latest;
  const spb = await blockSeconds(client, head);
  const count = big(await view(client, at.court, abi.court, 'caseCount'));
  const list = [];
  for (let i = big(fromIndex); i <= count; i++) {
    const id = String(await view(client, at.court, abi.court, 'caseAt', [i])).toLowerCase();
    if (ids && !ids.has(id)) continue;
    list.push({ index: i, id });
  }
  const cases = [];
  for (const { index, id } of list) {
    const c = await view(client, at.court, abi.court, 'caseOf', [id]);
    const round = n(c.round);
    const r = round > 0 ? await view(client, at.court, abi.court, 'roundOf', [id, round]) : null;
    const prev = round >= 2 ? await view(client, at.court, abi.court, 'roundOf', [id, round - 1]) : null;
    const r2 = round === 2 ? r : round > 2 ? await view(client, at.court, abi.court, 'roundOf', [id, 2]) : null;
    cases.push({ index, id, kind: n(c.kind), stage: n(c.stage), round, c, r, prev, r2 });
  }
  // Payloads: the caller's, else the assertion's log, checked against the hash the court holds.
  const want = cases.filter((x) => x.stage !== STAGE.FINAL && !payloads.has(x.id));
  let found = new Map();
  if (want.length) found = await assertionPayloads(client, at.court, abi.court, fromBlock, block, { log, ...(o.chunk ? { chunk: o.chunk } : {}) });
  for (const x of cases) {
    const p = payloads.get(x.id) ?? found.get(x.id) ?? null;
    x.payload = p !== null && keccak256(p).toLowerCase() === String(x.c.payloadHash).toLowerCase() ? p : null;
    x.payloadNote = p === null ? 'not found' : x.payload === null ? 'hash mismatch' : 'ok';
    x.plan = nextStep(x.c, x.r, x.prev, x.r2, k, now);
    // A finding that may stand needs its payload: without it the finalize reverts BadPayload.
    if (x.plan.step === 'finalize' && x.plan.outcome.startsWith('uphold') && x.payload === null) {
      x.plan = { ...x.plan, blocked: `payload ${x.payloadNote}: an upheld finalize needs the asserted payload` };
    }
  }
  const bond = await bondState(client, at.bond, abi.bond, k, now);
  // Determinations the open cases hold: one per loss or censorship case, a slice group once.
  const held = new Set();
  for (const x of cases) {
    if (x.stage === STAGE.FINAL || !holdsDetermination(x.kind)) continue;
    held.add(n(x.c.slices) !== 0 ? String(x.c.group).toLowerCase() : x.id);
  }
  return { k, now, block, spb, count, cases, bond, heldByOpenCases: held.size };
}

async function bondState(client, bond, abi, k, now) {
  const s = await view(client, bond, abi, 'state');
  const lastClosed = big(s.lastClosedEpoch);
  const current = now / k.DRAW_WINDOW;
  const gap = current > lastClosed + 1n ? current - lastClosed - 1n : 0n;
  return { determinationsOpen: big(s.determinationsOpen), lastClosedEpoch: lastClosed, currentEpoch: current, epochGap: gap };
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

function span(seconds) {
  let s = Number(seconds);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.ceil(s / 60);
  return `in ${d ? `${d}d ` : ''}${h ? `${h}h ` : ''}${m}m`;
}

/** When a plan becomes possible: the later of its second and its block (estimated at `spb` s per block). */
function whenOf(plan, now, block, spb) {
  if (plan.step === null) return null;
  let at = plan.at === null ? now : plan.at;
  if (plan.atBlock !== null && plan.atBlock > block) {
    const byBlock = now + BigInt(Math.ceil(Number(plan.atBlock - block) * spb));
    if (byBlock > at) at = byBlock;
  }
  return at;
}

function table(s) {
  const rows = [['#', 'case', 'kind', 'stage', 'next step', 'closes on', 'possible', 'eth_call', 'note']];
  for (const x of s.cases) {
    if (x.stage === STAGE.FINAL) continue;
    const when = whenOf(x.plan, s.now, s.block, s.spb);
    const possible = x.plan.blocked ? 'BLOCKED' : when === null ? 'never (by the sweep)' : `${span(when - s.now)} (${new Date(Number(when) * 1000).toISOString().replace('.000', '')})`;
    rows.push([
      String(x.index),
      `${x.id.slice(0, 12)}…`,
      `${KIND[x.kind] || x.kind}${n(x.c.slices) ? ` ${n(x.c.sliceIndex) + 1}/${n(x.c.slices)}` : ''}`,
      `${STAGE_NAME[x.stage]}${x.round ? ` r${x.round}` : ''}`,
      x.plan.step || '-',
      x.plan.outcome,
      possible,
      x.preflight === undefined ? '-' : x.preflight === 'ok' ? 'ok' : `REFUSED ${String(x.preflight).slice(0, 40)}`,
      x.plan.blocked || x.plan.note,
    ]);
  }
  if (rows.length === 1) return '   (no open case)';
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => (i === 8 ? 0 : r[i].length))));
  return rows.map((r) => `   ${r.map((v, i) => (i === 8 ? v : v.padEnd(width[i]))).join('  ')}`).join('\n');
}

function summary(s) {
  const open = s.cases.filter((x) => x.stage !== STAGE.FINAL);
  const lines = [
    `court: ${s.count} case(s) ever opened, ${open.length} open; head block ${s.block} at ${new Date(Number(s.now) * 1000).toISOString()} (~${s.spb.toFixed(1)} s/block)`,
    `bond: determinationsOpen ${s.bond.determinationsOpen} (open loss/censorship cases hold ${s.heldByOpenCases}); epoch ${s.bond.currentEpoch}, last closed ${s.bond.lastClosedEpoch}${s.bond.epochGap > MAX_CLOSE ? ` — gap ${s.bond.epochGap} > ${MAX_CLOSE}: closeEpochs batches first` : ''}`,
  ];
  if (s.bond.determinationsOpen !== BigInt(s.heldByOpenCases)) lines.push(`WARNING: the bond counts ${s.bond.determinationsOpen} open determination(s), the open cases account for ${s.heldByOpenCases}: something the sweep cannot see holds issuance`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/**
 * Survey, then (with `execute`) send every step possible now, one at a time,
 * re-reading the case after each (a later-round lapse leaves a finalize due).
 * Each step is first read with `call` at the head; a refusal is reported and
 * the case skipped, except the bond's `EpochGapTooLong`, which is cleared with
 * `closeEpochs(32)` batches and the step retried.
 */
async function sweep(o) {
  const { client, at, abi, execute = false, errors, log = () => {} } = o;
  const name = (e) => (errors ? revertName(errors, e) : String(e.message || e));
  let s = await survey(o);
  const results = [];
  if (!execute) {
    // The plan reads each step possible now at the head (eth_call): a refusal shows before anything is sent.
    for (const x of s.cases) {
      if (x.stage === STAGE.FINAL || x.plan.blocked || !due(x.plan, s.now, s.block)) continue;
      const args = x.plan.step === 'finalize' ? [x.id, x.payload ?? '0x'] : [x.id];
      try {
        await client.call(at.court, abi.court, x.plan.step, args);
        x.preflight = 'ok';
      } catch (e) {
        x.preflight = name(e);
      }
    }
    return { before: s, after: s, results };
  }
  for (const x of s.cases) {
    if (x.stage === STAGE.FINAL) continue;
    let cur = x;
    for (let i = 0; i < STEPS_PER_CASE; i++) {
      const head = await client.head();
      if (!due(cur.plan, head.timestamp, head.latest) || cur.plan.blocked) break;
      const args = cur.plan.step === 'finalize' ? [cur.id, cur.payload ?? '0x'] : [cur.id];
      let refused = null;
      for (let tries = 0; tries < 8; tries++) {
        try {
          await client.call(at.court, abi.court, cur.plan.step, args);
          refused = null;
          break;
        } catch (e) {
          refused = name(e);
          if (!/EpochGapTooLong/.test(refused)) break;
          log(`${x.id.slice(0, 12)}…: the bond's epoch gap refuses the close; closeEpochs(${MAX_CLOSE})`);
          await client.send(at.bond, abi.bond, 'closeEpochs', [MAX_CLOSE]);
          results.push({ id: x.id, step: 'closeEpochs', ok: true });
        }
      }
      if (refused) {
        log(`${x.id.slice(0, 12)}… ${cur.plan.step} refused at the head: ${refused}`);
        results.push({ id: x.id, step: cur.plan.step, ok: false, error: refused });
        break;
      }
      try {
        const rc = await client.send(at.court, abi.court, cur.plan.step, args);
        log(`${x.id.slice(0, 12)}… ${cur.plan.step} sent (block ${rc.blockNumber}, gas ${rc.gasUsed})`);
        results.push({ id: x.id, step: cur.plan.step, ok: true, block: rc.blockNumber });
      } catch (e) {
        const why = name(e);
        log(`${x.id.slice(0, 12)}… ${cur.plan.step} failed: ${why}`);
        results.push({ id: x.id, step: cur.plan.step, ok: false, error: why });
        break;
      }
      // Re-read and re-plan the one case.
      const again = await survey({ ...o, k: s.k, ids: new Set([x.id]), payloads: new Map(x.payload ? [[x.id, x.payload]] : []) });
      cur = again.cases[0];
      if (!cur || cur.stage === STAGE.FINAL) break;
    }
  }
  const after = await survey({ ...o, k: s.k, payloads: new Map(s.cases.filter((x) => x.payload).map((x) => [x.id, x.payload])) });
  return { before: s, after, results };
}

module.exports = { sweep, survey, nextStep, due, table, summary, whenOf, span, assertionPayloads, constants, view, STAGE, KIND, MAX_CLOSE };
