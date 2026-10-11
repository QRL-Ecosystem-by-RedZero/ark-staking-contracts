/**
 * The reporter side of `ArkReferenceOracle` (scripts/lib/oracle-reporter.js,
 * run by scripts/oracle-report.js and in-process by the e2e harness) and the
 * market legs it posts (scripts/lib/market-price.js, shared with
 * scripts/oracle-post.js). Staking CLAUDE.md item 124.
 *
 * Against the contract on the harness: a round is posted only when due, the
 * keys stop at the quorum, a key never reports a round twice, a round that
 * lapsed without a quorum is passed for the next id, a yield is posted once
 * per key and closed epoch, a hold posts nothing, and `expectedObservation`
 * (what the e2e scenario asserts against) equals what the contract accepts.
 * Against a stubbed CoinGecko: the 5% cut, the two-venue rule, the peg check,
 * the 429 / 5xx retries.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { keccak256, toUtf8Bytes, Interface } = require('ethers');

const F = require('./stake-fixture');
const { Chain, artifact } = require('./harness');
const { OracleReporter, expectedObservation } = require('../scripts/lib/oracle-reporter');
const { errorInterface } = require('../ecdsa-stakings/relayer/engine/errors');
const market = require('../scripts/lib/market-price');

const { ACCOUNTS, PRICE_SCALE: P, ZERO, EPOCH, DAY } = F;
const HOUR = 3600;
const VENUES = keccak256(toUtf8Bytes('venues'));
const SETTINGS = 'tuple(uint16,uint32,uint32,uint16,uint16,uint16,uint16,bytes32,bytes32,uint256)';
const REPORTERS = [1, 2, 3, 4, 5].map((i) => '0x' + (0xb0 + i).toString(16).repeat(20));
const BUILD = path.join(__dirname, '..', 'build');
const one = (v) => (Array.isArray(v) ? v[0] : v);

/** The harness chain as a client of `OracleReporter`: call (rolled back) and send, as `from`. */
function clientOf(chain, address) {
  return {
    address,
    async call(to, abi, method, args = [], { from = address, value = 0n } = {}) {
      await chain.vm.stateManager.checkpoint();
      try {
        const res = await chain.execute(to, from, abi.encodeFunctionData(method, args), value, true);
        return abi.decodeFunctionResult(method, res.returnValue);
      } finally {
        await chain.vm.stateManager.revert();
      }
    },
    async send(to, abi, method, args = [], { value = 0n } = {}) {
      return chain.execute(to, address, abi.encodeFunctionData(method, args), value);
    },
  };
}

async function setup({ quorum = 3, interval = HOUR, heartbeat = DAY } = {}) {
  const chain = await Chain.create();
  for (const r of REPORTERS) await chain.fund(r);
  const params = await F.deployParams(chain);
  const qday = await chain.deploy('MockQDayOracle');
  const settings = [quorum, interval, heartbeat, 1000, 300, 1500, 2, VENUES, keccak256(toUtf8Bytes('freeze')), 100n * P];
  const oracle = await chain.deploy('ArkReferenceOracle', ['address', 'address', 'address', 'address[]', 'address[]', SETTINGS], [ACCOUNTS.admin, params.address, qday.address, REPORTERS, [ACCOUNTS.attester], settings]);
  const abi = new Interface(artifact('ArkReferenceOracle').abi);
  const logs = [];
  let price = 3000n * P;
  let fail = false;
  const yields = { book: 220, asset: 300 };
  const rep = new OracleReporter({
    reporters: REPORTERS.map((a, i) => ({ label: `r${i + 1}`, client: clientOf(chain, a) })),
    oracle: oracle.address,
    abi,
    errors: errorInterface([BUILD]),
    priceKey: { chainId: 0n, asset: ZERO },
    yieldKeys: [{ label: 'book', chainId: 0n, asset: ZERO }, { label: 'asset', chainId: 1n, asset: '0x' + 'aa'.repeat(20) }],
    epochLength: BigInt(EPOCH),
    priceSource: async () => {
      if (fail) throw new Error('market down');
      return { wei: price, line: '' };
    },
    yieldSource: async (yk) => yields[yk.label],
    now: async () => chain.timestamp,
    log: (l) => logs.push(l),
  });
  const latest = async () => {
    const r = await oracle.call('latestRound', [0n, ZERO]);
    return { roundId: r[0], updatedAt: r[1], observation: r[2], clamped: r[3] };
  };
  return { chain, oracle, abi, rep, logs, latest, setPrice: (p) => (price = p), setFail: (f) => (fail = f), yields };
}

describe('OracleReporter against ArkReferenceOracle', () => {
  test('a due round is posted by exactly k_o keys and accepted; nothing is posted before τ_o', async () => {
    const t = await setup();
    const r1 = await t.rep.step();
    assert.equal(r1.round.posted, true);
    assert.equal(r1.round.sent.length, 3, 'the keys stop at the quorum: a fourth report would land on a closed round');
    let l = await t.latest();
    assert.equal(l.roundId, 1n);
    assert.equal(l.observation, 3000n * P);
    t.chain.advanceTime(HOUR - 10);
    const r2 = await t.rep.step();
    assert.equal(r2.round.posted, false);
    assert.equal(r2.round.reason, 'not due');
    t.chain.advanceTime(10);
    t.setPrice(3100n * P);
    await t.rep.step();
    l = await t.latest();
    assert.equal(l.roundId, 2n);
    assert.equal(l.observation, 3100n * P);
    // Rotation: round 2 starts from the second key.
    assert.equal(t.rep.stats.reports, 6);
  });

  test('a failed market read posts nothing, and the feed falls silent after its heartbeat', async () => {
    const t = await setup();
    await t.rep.step();
    t.setFail(true);
    for (let i = 0; i < 25; i++) {
      t.chain.advanceTime(HOUR);
      const r = await t.rep.step();
      assert.equal(r.round.posted, false);
    }
    assert.equal((await t.latest()).roundId, 1n);
    assert.ok(t.logs.some((x) => /market read failed/.test(x)));
    assert.equal(one(await t.oracle.call('silent', [0n, ZERO])), true);
  });

  test('a key never reports a round twice, and a round that lapsed without a quorum is passed for the next id', async () => {
    const t = await setup();
    // Two keys only, below the quorum of three: round 1 stays open.
    const a = await t.rep.stepRound({ only: ['r1', 'r2'] });
    assert.deepEqual(a.sent, ['r1@1', 'r2@1']);
    assert.equal((await t.latest()).roundId, 0n);
    // r1 again inside τ_o: it has reported round 1, and round 2 has not opened.
    const b = await t.rep.stepRound({ only: ['r1'] });
    assert.equal(b.sent.length, 0);
    assert.equal(t.rep.stats.reports, 2, 'nothing was sent for a round the key already reported');
    // After τ_o round 1 has lapsed: the same two keys report round 2 (naming it opens it).
    t.chain.advanceTime(HOUR);
    const c = await t.rep.stepRound({ only: ['r1', 'r2'] });
    assert.deepEqual([...c.sent].sort(), ['r1@2', 'r2@2']);
    assert.equal((await t.latest()).roundId, 0n);
    // A third key, guessing round 1, is told the open round by the revert (NotOpenRound) and completes round 2.
    const d = await t.rep.stepRound({ only: ['r3'] });
    assert.deepEqual(d.sent, ['r3@2']);
    assert.ok(d.accepted, JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.equal(d.accepted.roundId, 2n);
  });

  test('each key posts the yield once per closed epoch and key; the figure is the median of the first k_o', async () => {
    const t = await setup();
    await t.rep.step();
    assert.equal(t.rep.stats.yields, 10, 'five keys, two yield keys, for the epoch just closed');
    assert.equal(one(await t.oracle.call('realisedYieldBps', [0n, ZERO])), 220n);
    assert.equal(one(await t.oracle.call('realisedYieldBps', [1n, '0x' + 'aa'.repeat(20)])), 300n);
    t.chain.advanceTime(HOUR);
    await t.rep.step();
    assert.equal(t.rep.stats.yields, 10, 'not again in the same epoch');
    const e0 = t.chain.timestamp / BigInt(EPOCH);
    t.chain.advanceTime(Number((e0 + 1n) * BigInt(EPOCH) - t.chain.timestamp) + 5);
    t.yields.book = 250;
    await t.rep.step();
    assert.equal(t.rep.stats.yields, 20, 'once more after the boundary');
    assert.equal(one(await t.oracle.call('realisedYieldBps', [0n, ZERO])), 250n);
  });

  test('a hold posts nothing; a resume posts again', async () => {
    const t = await setup();
    t.rep.pause();
    assert.deepEqual(await t.rep.step(), { held: true });
    assert.equal((await t.latest()).roundId, 0n);
    t.rep.resume();
    await t.rep.step();
    assert.equal((await t.latest()).roundId, 1n);
  });

  test('expectedObservation is the round the contract accepts: the dispersion cut and the step clamp', async () => {
    const t = await setup({ quorum: 3 });
    await t.rep.step();
    const cfg = { quorum: 3, maxDispersionBps: 300, maxStepBps: 1000 };
    const cases = [
      [3000n, 3001n, 3002n],
      [3600n, 3000n, 3003n, 3006n],
      [4500n, 4500n, 4500n],
      [2000n, 2010n, 2005n],
    ];
    for (const raw of cases) {
      t.chain.advanceTime(HOUR);
      const before = await t.latest();
      const spots = Object.fromEntries(raw.map((v, i) => [`r${i + 1}`, v * P]));
      const res = await t.rep.stepRound({ spots, sequence: raw.map((_, i) => `r${i + 1}`) });
      const sent = res.sent.map((x) => spots[x.split('@')[0]]);
      const want = expectedObservation(sent, { ...cfg, last: before.observation });
      const after = await t.latest();
      assert.ok(want, `a quorum for ${raw}`);
      assert.equal(after.observation, want.observation, `${raw}`);
      assert.equal(after.clamped, want.clamped, `${raw}`);
    }
  });
});

describe('market-price: the legs and the retries', () => {
  const realFetch = global.fetch;
  const ticker = (venue, usd, vol) => ({ market: { name: venue }, base: 'QRL', target: 'USDT', converted_last: { usd }, converted_volume: { usd: vol }, is_stale: false, is_anomaly: false });
  const stub = (answers) => {
    let i = 0;
    global.fetch = async () => {
      const a = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (typeof a === 'number') return { ok: false, status: a, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => a };
    };
    return () => i;
  };

  test('the QRL leg: the volume-weighted median after the 5% cut, at least two venues', async () => {
    try {
      stub([{ tickers: [ticker('MEXC', 0.84, 30000), ticker('Biconomy', 0.85, 5000), ticker('XT', 0.83, 400), ticker('Broken', 1.5, 100)] }]);
      const q = await market.qrlUsd();
      assert.equal(q.price, 0.84);
      assert.deepEqual(q.dropped.map((x) => x.venue), ['Broken']);
      stub([{ tickers: [ticker('MEXC', 0.84, 30000), ticker('Broken', 1.5, 100)] }]);
      await assert.rejects(market.qrlUsd(), /fewer than two QRL venues/);
      stub([{ tickers: [ticker('MEXC', 0.84, 30000)] }]);
      await assert.rejects(market.qrlUsd(), /only 1 QRL venue/);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('stETH off its peg by more than 2% posts nothing', async () => {
    try {
      stub([{ 'staked-ether': { usd: 2600 }, ethereum: { usd: 2700 } }]);
      await assert.rejects(market.stethUsd(), /off its ETH peg/);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('429 is retried; 5xx only with retry5xx (the reporter), as oracle-post.js never retried it', async () => {
    try {
      let calls = stub([429, { ok: 1 }]);
      assert.deepEqual(await market.get('x', { backoffMs: 1 }), { ok: 1 });
      assert.equal(calls(), 2);
      stub([502, { ok: 1 }]);
      await assert.rejects(market.get('x', { backoffMs: 1 }), /HTTP 502/);
      calls = stub([502, 503, { ok: 2 }]);
      assert.deepEqual(await market.get('x', { backoffMs: 1, retry5xx: true }), { ok: 2 });
      assert.equal(calls(), 3);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('deployment: the reporters, their gas and the launch values', () => {
  const { fundingPlan } = require('../scripts/lib/governance');
  const { oracleReporterAddressesOf, oracleSettingsOf, oracleOverridesOf } = require('../scripts/lib/deploy');
  const ME = '0x' + '01'.repeat(20);
  const R = ['0x' + 'a1'.repeat(20), '0x' + 'a2'.repeat(20), '0x' + 'a3'.repeat(20)];
  const m = { profile: 'testnet' };

  test('the reporters of the real oracle take the role gas float (QRL_ROLE_FUNDING); none with the double', () => {
    const env = { ARK_PRICE_ORACLE: 'ArkReferenceOracle', ORACLE_REPORTERS: R.join(','), QRL_ROLE_FUNDING: '50' };
    const reporters = oracleReporterAddressesOf({ env, chain: 'hoodi-vps', manifest: m });
    assert.deepEqual(reporters, R);
    const plan = fundingPlan({ env, me: ME, reporters });
    assert.deepEqual(plan.map((p) => [p.address, p.label, p.target]), R.map((a) => [a, 'oracle reporter', 50n * 10n ** 18n]));
    assert.deepEqual(oracleReporterAddressesOf({ env: { ORACLE_REPORTERS: R.join(',') }, chain: 'hoodi-vps', manifest: m }), [], 'the double by default');
    assert.deepEqual(fundingPlan({ env, me: R[0], reporters: [R[0]] }), [], 'never the deployer itself');
  });

  test('the launch values: 120 s / 600 s / 1,000 bps on a compressed profile, overridable per chain inside the contract\'s ranges', () => {
    const base = oracleSettingsOf('testnet', 2);
    assert.deepEqual(base.slice(0, 7), [2, 120, 600, 1000, 300, 1500, 2]);
    assert.deepEqual(oracleSettingsOf('spec', 3).slice(1, 3), [3600, 21600]);
    const o = oracleOverridesOf({ env: { LOCAL_ORACLE_ROUND_INTERVAL_SECONDS: '60', ORACLE_MAX_STEP_BPS: '2500' }, chain: 'local' });
    assert.deepEqual(oracleSettingsOf('testnet', 2, o).slice(1, 4), [60, 600, 2500]);
  });
});
