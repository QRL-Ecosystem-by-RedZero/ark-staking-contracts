/**
 * The court sweep (scripts/lib/court-sweep.js; audit 2026-10-03, OC-OPS-26),
 * on the harness with the real court and the real bond behind it.
 *
 * The one rule this file exists to defend: **a court run abandoned midway
 * does not freeze the bond for good.** Each open loss holds a determination
 * on the bond, which refuses issuance (`DeterminationOpen`) while any is open;
 * the sweep finds every open case, names the permissionless step that closes
 * it and when, and — asked to — sends it from an account that is no party to
 * any case, after which the bond issues again. Asked only for a plan, it
 * sends nothing.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const F = require('./stake-fixture');
const { coder } = require('./harness');
const { errorInterface } = require('../ecdsa-stakings/relayer/engine/errors');
const S = require('../scripts/lib/court-sweep');

const { ACCOUNTS, ONE, TERM, CLASS, JUROR_MIN_STAKE } = F;
const DAY = 24 * 3600;
const HOLDER = ACCOUNTS.alice;
const CHALLENGER = ACCOUNTS.attester;
/** No party to any case: the sweep is permissionless. */
const SWEEPER = '0x' + '5e'.repeat(20);
const EVIDENCE = keccak256(toUtf8Bytes('court-sweep'));
const LOSS = 1;

const juror = (i) => '0x' + (0x3000 + i).toString(16).padStart(40, '0');
const lossPayload = (id, loss) => coder.encode(['bytes32[]', 'uint256[]'], [[id], [loss]]);

/**
 * The harness as scripts/lib/chains.js's client shape: `call` is a real
 * eth_call (state checkpointed and reverted, as the harness client does — the
 * fixture's `call` commits), `send` records its logs, `logs` reads them back.
 */
function clientOf(ctx, from) {
  const chain = ctx.chain;
  const log = [];
  const record = (res) => {
    for (const l of res.logs) log.push({ ...l, address: l.address.toLowerCase(), blockNumber: BigInt(chain.blockNumber) });
    return { blockNumber: BigInt(chain.blockNumber), gasUsed: BigInt(res.gasUsed), logs: res.logs };
  };
  const client = {
    kind: 'harness',
    address: from,
    sent: [],
    record,
    async call(to, abi, method, args = [], { value = 0n } = {}) {
      await chain.vm.stateManager.checkpoint();
      try {
        const res = await chain.execute(to, from, abi.encodeFunctionData(method, args), value, true);
        return abi.decodeFunctionResult(method, res.returnValue);
      } finally {
        await chain.vm.stateManager.revert();
      }
    },
    async send(to, abi, method, args = [], { value = 0n } = {}) {
      client.sent.push(method);
      return record(await chain.execute(to, from, abi.encodeFunctionData(method, args), value));
    },
    async logs(address, fromBlock, toBlock) {
      const a = address.toLowerCase();
      return log.filter((l) => l.address === a && l.blockNumber >= BigInt(fromBlock) && l.blockNumber <= BigInt(toBlock));
    },
    async head() {
      return { latest: BigInt(chain.blockNumber), safe: BigInt(chain.blockNumber), timestamp: BigInt(chain.timestamp) };
    },
  };
  return client;
}

/** A book behind the real court, ten jurors of three minimum stakes each: room for four cases at the minimum seat. */
async function book() {
  const ctx = await F.deployBondStack({ court: 'real' });
  ctx.pos = await F.anchor(ctx, { owner: HOLDER, depositor: HOLDER, nonce: 0n, notional: 500n * ONE });
  await F.subscribe(ctx, { from: HOLDER, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: ACCOUNTS.bob, class_: CLASS.SENIOR, term: TERM.YEAR, value: 30_000n * ONE });
  ctx.chain.advanceTime(91 * DAY);
  const stake = 3n * JUROR_MIN_STAKE;
  for (let i = 0; i < 10; i++) {
    const j = juror(i);
    await ctx.ark.send('transfer', [j, stake], { from: ACCOUNTS.admin });
    await ctx.ark.send('approve', [ctx.jurorPool.address, stake], { from: j });
    await ctx.jurorPool.send('stake', [stake], { from: j });
  }
  F.toNextEpoch(ctx);
  await ctx.oracle.send('setPriceFor', [0n, ctx.ark.address, 100n * ONE]);
  await ctx.chain.fund(SWEEPER);
  ctx.client = clientOf(ctx, SWEEPER);
  ctx.o = {
    client: ctx.client,
    at: { court: ctx.court.address, bond: ctx.bond.address },
    abi: { court: ctx.court.iface, bond: ctx.bond.iface },
    errors: errorInterface([ctx.chain.buildDir]),
  };
  return ctx;
}

/** A loss asserted by the position's beneficiary; its receipt's logs reach the client, as a node's log index would. */
async function assertLoss(ctx, loss) {
  const payload = lossPayload(ctx.pos.id, loss);
  const q = await ctx.findings.call('quote', [LOSS, payload], { from: HOLDER });
  const res = await ctx.court.send('assertFinding', [LOSS, payload, EVIDENCE], { from: HOLDER, value: q[3] * q[4] });
  ctx.client.record(res);
  return { id: ctx.court.events(res, 'AssertionOpened')[0].args.caseId.toLowerCase(), deposit: q[3], payload };
}

const determinationsOpen = async (ctx) => (await ctx.bond.call('state')).determinationsOpen;
// Junior: the upheld loss drew the junior class, so a senior subscription would meet JuniorTooThin, which is not the gate here.
const issues = (ctx) => F.subscribe(ctx, { from: ACCOUNTS.bob, class_: CLASS.JUNIOR, term: TERM.YEAR, value: 1_000n * ONE });
const stageOf = async (ctx, id) => (await ctx.court.call('caseOf', [id])).stage;

test('a run abandoned midway: the sweep plans without sending, closes every open case by its permissionless path, and the bond issues again', async () => {
  const ctx = await book();
  // Three cases a failed court-live run leaves behind:
  //   K  unchallenged (it stands at the close of its challenge window);
  //   N  challenged and never armed (lapses four draw windows after its evidence window, OC-COURT-08);
  //   D  challenged, drawn, and nobody votes (closes on its tally after the appeal window: a tie rejects).
  const K = await assertLoss(ctx, 50n * ONE);
  const N = await assertLoss(ctx, 40n * ONE);
  const D = await assertLoss(ctx, 30n * ONE);
  await ctx.court.send('challenge', [N.id], { from: CHALLENGER, value: N.deposit });
  await ctx.court.send('challenge', [D.id], { from: CHALLENGER, value: D.deposit });
  const c = await ctx.court.call('caseOf', [D.id]);
  ctx.chain.advanceTime(Number(c.openedAt + (c.challengeDays + c.evidenceDays) * BigInt(DAY) - BigInt(ctx.chain.timestamp)));
  await ctx.court.send('armDraw', [D.id]);
  const r = await ctx.court.call('roundOf', [D.id, 1]);
  while (BigInt(ctx.chain.blockNumber) <= r.drawBlock) ctx.chain.advanceTime(0);
  await ctx.court.send('drawPanel', [D.id]);

  assert.equal(await determinationsOpen(ctx), 3n, 'each open loss holds a determination');
  await assert.rejects(() => issues(ctx), /DeterminationOpen/, 'and the bond refuses issuance while any is open');

  // The plan: every case found, its payload recovered from AssertionOpened, its step named; nothing sent.
  const plan = await S.sweep({ ...ctx.o, execute: false });
  assert.deepEqual(ctx.client.sent, [], 'a plan sends nothing');
  const by = (id) => plan.before.cases.find((x) => x.id === id);
  assert.equal(plan.before.cases.length, 3);
  assert.equal(by(K.id).payload, K.payload.toLowerCase(), 'the payload is recovered from the assertion and matches the hash the court holds');
  assert.deepEqual([by(K.id).plan.step, by(N.id).plan.step, by(D.id).plan.step], ['finalize', 'lapseDraw', 'finalize']);
  assert.equal(plan.before.bond.determinationsOpen, 3n);
  assert.equal(plan.before.heldByOpenCases, 3, 'the open cases account for every open determination');
  assert.equal(by(K.id).preflight, 'ok', 'K stands already: its challenge window closed with the evidence window');
  assert.equal(by(N.id).preflight, undefined, 'N lapses only four draw windows after its evidence window');
  assert.equal(by(D.id).preflight, undefined, 'D closes only after its appeal window');
  assert.match(S.table(plan.before), /lapseDraw/);
  assert.equal(await stageOf(ctx, K.id), 1n, 'the plan left K where it was');

  // An execute now closes what is due (K) and leaves the rest, with their times.
  let run = await S.sweep({ ...ctx.o, execute: true });
  assert.deepEqual(ctx.client.sent, ['finalize']);
  assert.equal(await stageOf(ctx, K.id), 5n, 'K is final');
  assert.equal(run.after.bond.determinationsOpen, 2n);
  await assert.rejects(() => issues(ctx), /DeterminationOpen/);

  // Past every window: the rest close.
  const later = run.after.cases.filter((x) => x.stage !== S.STAGE.FINAL).map((x) => x.plan.at).reduce((a, b) => (a > b ? a : b));
  ctx.chain.advanceTime(Number(later - BigInt(ctx.chain.timestamp)) + 1);
  run = await S.sweep({ ...ctx.o, execute: true });
  assert.deepEqual(ctx.client.sent, ['finalize', 'lapseDraw', 'finalize'], 'N lapses and D is finalized; nothing else is sent (no arm, no draw, no vote, no claim)');
  assert.equal(await stageOf(ctx, N.id), 5n);
  assert.equal(await stageOf(ctx, D.id), 5n);
  assert.equal((await ctx.court.call('caseOf', [N.id])).outcome, 2n, 'N rejected at its lapse');
  assert.equal((await ctx.court.call('caseOf', [D.id])).outcome, 2n, 'D rejected on a silent panel');
  assert.equal(await ctx.court.call('owed', [CHALLENGER]) >= N.deposit, true, 'the lapse refunds the challenger');
  assert.equal(await ctx.court.call('owed', [SWEEPER]), 0n, 'the sweeper is owed nothing');
  assert.equal(run.after.bond.determinationsOpen, 0n, 'every determination is closed');
  assert.equal(await determinationsOpen(ctx), 0n);
  await issues(ctx);
  // Nothing left: a second sweep sends nothing.
  await S.sweep({ ...ctx.o, execute: true });
  assert.equal(ctx.client.sent.length, 3);
});

test('the plan of the paths the live run did not leave: a later round armed and never drawn, an escalation, a round due and unarmed', () => {
  const k = { COURT_DAY: 600n, DRAW_WINDOW: 4200n, MAX_DRAW_LAPSES: 4n, ESCALATION_LAPSE: 8400n, BLOCKHASH_REACH: 256n };
  const c = { stage: 2, round: 2, challenger: '0x' + '22'.repeat(20), openedAt: 0n, challengeDays: 7n, evidenceDays: 3n, outcome: 0 };
  const r = { commitEnd: 0n, armedAt: 10_000n, drawBlock: 500n, lapses: 0, verdict: 0 };
  const prev = { verdict: 1 };
  const p = S.nextStep(c, r, prev, null, k, 10_000n);
  assert.equal(p.step, 'lapseDraw');
  assert.equal(p.outcome, 'uphold', 'the first round\'s verdict stands (QL-19)');
  assert.equal(p.at, 10_000n + 4n * 4200n);
  assert.equal(p.atBlock, 500n + 256n + 1n, 'not while the draw block is in reach (COURT-07)');
  assert.equal(S.due(p, p.at, p.atBlock - 1n), false);
  assert.equal(S.due(p, p.at, p.atBlock), true);
  const esc = S.nextStep({ ...c, stage: 3, escalatedAt: 50_000n }, r, prev, { verdict: 2 }, k, 0n);
  assert.deepEqual([esc.step, esc.at, esc.outcome], ['finalize', 50_000n + 8400n, 'reject'], 'an escalation closes on the appeal verdict at its lapse');
  assert.equal(S.nextStep({ ...c, round: 1 }, { ...r, armedAt: 0n }, null, null, k, 0n).step, null, 'a round due and unarmed is not armed by the sweep');
});
