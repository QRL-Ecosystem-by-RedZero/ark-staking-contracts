/**
 * The valuation oracle of yellow paper §6.1 (`ArkReferenceOracle`, written
 * 2026-10-05 for the on-chain audit round OC, ORACLE stream), and the rule
 * of silence its consumers apply (I40).
 *
 * Each guard of technical reference §1.4 and §3.7 is asserted as a property
 * of the contract, and I38, I40 and I41 as the verification of technical
 * reference §4.3 states them:
 *  - I41: no entry other than `submit` changes an observation; a round with
 *    fewer than k_o reports inside d_rep is not accepted; a reporter key
 *    equal to another role key is refused at construction and at every change
 *    of the set.
 *  - I38: over random sequences of accepted rounds and silences across the
 *    admissible range of m_epoch, the series never leaves the band of its
 *    opening boundary, and each mark stays in the band of the one before.
 *  - I40: a stale read, a read under a pause, a read in the warm-up, a zero
 *    read and a reverting read are silence for every consumer named: no
 *    boundary reading is recorded, settlement strikes at the carried price,
 *    the court values at the ARK reference price, issuance is suspended.
 *
 * The OC-ORC PoCs (docs/review/audit-2026-10-03/ORACLE/oracle-poc.test.js)
 * are re-run here against the production oracle or the double's silence:
 * OC-ORC-01 (a 100x post), -02 (a stale feed HOLDs), -05 (a silent loss is
 * valued at the carried price), -08 (P_t of a closed epoch).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes, Interface } = require('ethers');

const F = require('./stake-fixture');
const { Chain, coder, artifact } = require('./harness');

const { ACCOUNTS, ONE, BPS, PRICE_SCALE, EPOCH, DAY, ZERO, TERM, CLASS } = F;
const P = PRICE_SCALE;
const HOUR = 3600;
const BOOK = [0n, ZERO];
const VENUES = keccak256(toUtf8Bytes('venues'));
const FREEZE_VENUES = keccak256(toUtf8Bytes('venues:freeze'));
const SETTINGS = 'tuple(uint16,uint32,uint32,uint16,uint16,uint16,uint16,bytes32,bytes32,uint256)';
const REPORTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => '0x' + (0xa0 + i).toString(16).repeat(20));
const key = (n) => keccak256(toUtf8Bytes(n));

function settingsOf(o = {}) {
  return [
    o.quorum ?? 3,
    o.interval ?? HOUR,
    o.heartbeat ?? DAY,
    o.step ?? 1000,
    o.dispersion ?? 300,
    o.alarm ?? 1500,
    o.pauseMax ?? 2,
    o.venues ?? VENUES,
    o.freezeVenues ?? FREEZE_VENUES,
    o.ark ?? 100n * P,
  ];
}

/** An oracle on a fresh chain: five reporters, k_o = 3, a one-day heartbeat (the top of its range) so a test can feed daily. */
async function setup(o = {}) {
  const chain = o.chain || (await Chain.create());
  for (const r of REPORTERS) await chain.fund(r);
  // m_epoch below 2,000 needs a longer retention to admit the whole ladder (2 + (d_floor - m) / step).
  const mParams = o.m ? { maxEpochMoveBps: o.m, ...(o.m < 2000 ? { unsoldEpochs: 9 } : {}) } : null;
  const params = o.params || (await F.deployParams(chain, mParams ? { params: mParams } : {}));
  const qday = o.qday || (await chain.deploy('MockQDayOracle'));
  const n = o.reporters ?? 5;
  const reporters = REPORTERS.slice(0, n);
  const governance = o.governance || ACCOUNTS.admin;
  const oracle = await chain.deploy(
    'ArkReferenceOracle',
    ['address', 'address', 'address', 'address[]', 'address[]', SETTINGS],
    [governance, params.address, qday.address, reporters, o.roleKeys || [ACCOUNTS.attester, ACCOUNTS.oracle], settingsOf(o)],
  );
  return { chain, params, qday, oracle, reporters, quorum: o.quorum ?? 3 };
}

/** The open round of a key: one past the last accepted. */
async function openRound(ctx, k = BOOK) {
  const [roundId] = await ctx.oracle.call('latestRound', k);
  return roundId + 1n;
}

/** One round at `price` from the first k_o reporters (or `from`), each reporting `prices[i]` where given. */
async function round(ctx, price, { k = BOOK, from, prices, list = VENUES } = {}) {
  const id = await openRound(ctx, k);
  const who = from || ctx.reporters.slice(0, ctx.quorum);
  let res;
  for (let i = 0; i < who.length; i++) {
    res = await ctx.oracle.send('submit', [id, k[0], k[1], prices ? prices[i] : price, list], { from: who[i] });
  }
  return res;
}

/** Rounds at `price`, `every` seconds apart, for `count` rounds (the clock moves first). */
async function feed(ctx, price, count, every = DAY, k = BOOK) {
  for (let i = 0; i < count; i++) {
    ctx.chain.advanceTime(every);
    await round(ctx, price, { k });
  }
}

/** Daily rounds at `price` until the key reads live: the warm-up of thirty days and twenty-four hours, and the first mark. */
async function warm(ctx, price, k = BOOK) {
  await round(ctx, price, { k });
  for (let i = 0; i < 60; i++) {
    ctx.chain.advanceTime(DAY);
    await round(ctx, price, { k });
    if (!(await ctx.oracle.call('silent', k))) return i + 1;
  }
  throw new Error('never warmed up');
}

const now = (ctx) => BigInt(ctx.chain.timestamp);
const epochOf = (t) => BigInt(t) / BigInt(EPOCH);
const band = (b, m) => [(b * (BPS - BigInt(m))) / BPS, (b * (BPS + BigInt(m))) / BPS];

describe('ArkReferenceOracle: construction and the reporter keys (I41)', () => {
  test('a reporter that is governance or a role key named at construction is refused, as is a set outside 3 - 9 or a quorum at or below half', async () => {
    await assert.rejects(() => setup({ roleKeys: [REPORTERS[2]] }), /ReporterHoldsRole/);
    const chain = await Chain.create();
    const params = await F.deployParams(chain);
    const qday = await chain.deploy('MockQDayOracle');
    const deploy = (reporters, s, gov = ACCOUNTS.admin) =>
      chain.deploy('ArkReferenceOracle', ['address', 'address', 'address', 'address[]', 'address[]', SETTINGS], [gov, params.address, qday.address, reporters, [], s]);
    await assert.rejects(() => deploy([ACCOUNTS.admin, ...REPORTERS.slice(0, 4)], settingsOf()), /ReporterHoldsRole/);
    await assert.rejects(() => deploy([REPORTERS[0], REPORTERS[0], REPORTERS[1]], settingsOf()), /ReporterKnown/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 2), settingsOf({ quorum: 2 })), /ReporterSetSize/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 10), settingsOf({ quorum: 6 })), /ReporterSetSize/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 4), settingsOf({ quorum: 2 })), /ReporterSetSize/, 'k_o > n_o / 2');
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ quorum: 6 })), /ReporterSetSize/, 'k_o <= n_o');
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ interval: 600 })), /ParameterOutOfRange/, 'tau_o below 15 minutes');
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ interval: 4 * HOUR, heartbeat: 6 * HOUR })), /ParameterOutOfRange/, 'T_hb >= 3 tau_o');
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ heartbeat: DAY + 1 })), /ParameterOutOfRange/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ step: 2501 })), /ParameterOutOfRange/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ dispersion: 99 })), /ParameterOutOfRange/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ alarm: 5001 })), /ParameterOutOfRange/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ pauseMax: 5 })), /ParameterOutOfRange/);
    await assert.rejects(() => deploy(REPORTERS.slice(0, 5), settingsOf({ ark: 0n })), /ParameterOutOfRange/);
    const ok = await deploy(REPORTERS.slice(0, 5), settingsOf());
    assert.equal(await ok.call('reporterCount'), 5n);
    assert.equal(await ok.call('arkReferencePrice'), 100n * P);
  });

  test('a reporter that is the timelock guardian or proposer is refused at every change of the set; governance cannot be handed to a reporter', async () => {
    const chain = await Chain.create();
    const roles = await chain.deploy('MockTimelockRoles', ['address', 'address'], [ACCOUNTS.guardian, ACCOUNTS.mallory]);
    const ctx = await setup({ chain, governance: roles.address, quorum: 4 });
    const exec = (fn, args) => roles.send('exec', [ctx.oracle.address, ctx.oracle.iface.encodeFunctionData(fn, args)]);
    await assert.rejects(() => exec('addReporter', [ACCOUNTS.guardian]), /call failed/);
    await assert.rejects(() => exec('addReporter', [ACCOUNTS.mallory]), /call failed/);
    await exec('addReporter', [REPORTERS[6]]);
    assert.equal(await ctx.oracle.call('isReporter', [REPORTERS[6]]), true);
    // Governance is the role here: a direct call from anyone else is refused.
    await assert.rejects(() => ctx.oracle.send('addReporter', [REPORTERS[7]], { from: ACCOUNTS.admin }), /OnlyGovernance/);
    await exec('proposeGovernance', [REPORTERS[0]]);
    await assert.rejects(() => ctx.oracle.send('acceptGovernance', [], { from: REPORTERS[0] }), /ReporterHoldsRole/);
  });
});

describe('ArkReferenceOracle: the round rule (I41)', () => {
  test('no entry but submit changes an observation: the only state-changing functions are the round, the yield, governance and the pause', () => {
    const abi = artifact('ArkReferenceOracle').abi;
    const writes = abi.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure').map((f) => f.name).sort();
    assert.deepEqual(writes, ['acceptGovernance', 'addReporter', 'pause', 'proposeGovernance', 'removeReporter', 'setParamsDiff', 'submit', 'submitYield']);
  });

  test('a report is refused from a non-reporter, governance included, at zero, under another venue list, for another round, or twice', async () => {
    const ctx = await setup();
    const [r0, r1] = ctx.reporters;
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 10n * P, VENUES], { from: ACCOUNTS.mallory }), /NotReporter/);
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 10n * P, VENUES], { from: ACCOUNTS.admin }), /NotReporter/);
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 0n, VENUES], { from: r0 }), /ZeroValue/);
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 10n * P, FREEZE_VENUES], { from: r0 }), /WrongVenueList/);
    await assert.rejects(() => ctx.oracle.send('submit', [2n, 0n, ZERO, 10n * P, VENUES], { from: r0 }), /NotOpenRound/);
    await ctx.oracle.send('submit', [1n, 0n, ZERO, 10n * P, VENUES], { from: r0 });
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 11n * P, VENUES], { from: r0 }), /AlreadyReported/);
    await ctx.oracle.send('submit', [1n, 0n, ZERO, 10n * P, VENUES], { from: r1 });
    const [roundId] = await ctx.oracle.call('latestRound', BOOK);
    assert.equal(roundId, 0n, 'two of k_o = 3 reports accept nothing');
  });

  test('a round is accepted at the first report after which k_o lie within d_rep of the median, at the median of those', async () => {
    const ctx = await setup();
    const [a, b, c, d] = ctx.reporters;
    await ctx.oracle.send('submit', [1n, 0n, ZERO, 10_000n * P, VENUES], { from: a });
    await ctx.oracle.send('submit', [1n, 0n, ZERO, 10_100n * P, VENUES], { from: b });
    // A minority outlier: three reports, only two within 300 bps of their median 10,100.
    await ctx.oracle.send('submit', [1n, 0n, ZERO, 15_000n * P, VENUES], { from: c });
    assert.equal((await ctx.oracle.call('latestRound', BOOK))[0], 0n, 'not accepted: two inside d_rep');
    const res = await ctx.oracle.send('submit', [1n, 0n, ZERO, 10_200n * P, VENUES], { from: d });
    const [ev] = ctx.oracle.events(res, 'RoundAccepted');
    assert.equal(ev.args.observation, 10_100n * P, 'the median of 10,000, 10,100 and 10,200; 15,000 moved nothing');
    assert.equal(ev.args.clamped, false);
    const [roundId, updatedAt, observation] = await ctx.oracle.call('latestRound', BOOK);
    assert.equal(roundId, 1n);
    assert.equal(updatedAt, now(ctx));
    assert.equal(observation, 10_100n * P);
    // The next round opens no sooner than tau_o after the last accepted one.
    await assert.rejects(() => ctx.oracle.send('submit', [2n, 0n, ZERO, 10_000n * P, VENUES], { from: a }), /RoundTooSoon/);
    ctx.chain.advanceTime(HOUR);
    await ctx.oracle.send('submit', [2n, 0n, ZERO, 10_000n * P, VENUES], { from: a });
  });

  test('a round that stood one round interval without a quorum lapses, and the next id opens', async () => {
    const ctx = await setup();
    const [a, b, c] = ctx.reporters;
    await ctx.oracle.send('submit', [1n, 0n, ZERO, 10_000n * P, VENUES], { from: a });
    await assert.rejects(() => ctx.oracle.send('submit', [2n, 0n, ZERO, 10_000n * P, VENUES], { from: b }), /NotOpenRound/);
    ctx.chain.advanceTime(HOUR);
    await ctx.oracle.send('submit', [2n, 0n, ZERO, 10_000n * P, VENUES], { from: b });
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 10_000n * P, VENUES], { from: c }), /NotOpenRound/);
    await ctx.oracle.send('submit', [2n, 0n, ZERO, 10_000n * P, VENUES], { from: c });
    await ctx.oracle.send('submit', [2n, 0n, ZERO, 10_000n * P, VENUES], { from: a });
    assert.equal((await ctx.oracle.call('latestRound', BOOK))[0], 2n);
  });

  test('the freeze venue list is the one in force under the protective freeze and after a declaration (yellow paper §6.1)', async () => {
    const ctx = await setup();
    assert.equal(await ctx.oracle.call('venueListInForce'), VENUES);
    await ctx.qday.send('setFrozen', [true]);
    assert.equal(await ctx.oracle.call('venueListInForce'), FREEZE_VENUES);
    await assert.rejects(() => round(ctx, 10_000n * P), /WrongVenueList/);
    await round(ctx, 10_000n * P, { list: FREEZE_VENUES });
    await ctx.qday.send('setFrozen', [false]);
    await ctx.qday.send('declare', [now(ctx)]);
    assert.equal(await ctx.oracle.call('venueListInForce'), FREEZE_VENUES);
  });
});

describe('ArkReferenceOracle: the step limit and the per-epoch band (OC-ORC-01, I38)', () => {
  test('a quorum posting 100x moves the observation by s_obs and the series by at most m_epoch of its opening mark; a 1/100 post cannot fire the breaker', async () => {
    const ctx = await setup();
    await warm(ctx, 10_000n * P);
    const before = await ctx.oracle.call('observe', BOOK);
    ctx.chain.advanceTime(HOUR);
    const res = await round(ctx, 1_000_000n * P);
    const [ev] = ctx.oracle.events(res, 'RoundAccepted');
    assert.equal(ev.args.observation, 11_000n * P, 'clamped at +1,000 bps of the last observation');
    assert.equal(ev.args.clamped, true);
    // The coalition keeps posting 100x every hour for the rest of the epoch.
    const e = epochOf(now(ctx));
    const b = await ctx.oracle.call('boundOf', [0n, ZERO, e]);
    const [, high] = band(b, 2500);
    while (epochOf(now(ctx) + BigInt(HOUR)) === e) {
      ctx.chain.advanceTime(HOUR);
      await round(ctx, 1_000_000n * P);
      const [, twap30d] = await ctx.oracle.call('observe', BOOK);
      assert.ok(twap30d <= high, 'the series stays inside B_e (1 + m_epoch)');
    }
    const after = await ctx.oracle.call('observe', BOOK);
    console.log('100x post for the rest of the epoch: twap30d', before[1] / P, '->', after[1] / P, 'QRL per unit; band top', high / P);
    // A 1/100 post: one round clamped at -1,000 bps; the breaker reads 24-hour averages and does not fire on it.
    const fresh = await setup();
    await warm(fresh, 10_000n * P);
    fresh.chain.advanceTime(HOUR);
    const r2 = await round(fresh, 100n * P);
    assert.equal(fresh.oracle.events(r2, 'RoundAccepted')[0].args.observation, 9_000n * P);
    assert.equal((await fresh.oracle.call('breakerActive', BOOK))[0], false);
  });

  for (const m of [1500, 2500, 3000]) {
    test(`over random rounds and silences at m_epoch = ${m}, the series never leaves the band of its opening mark, nor a mark the band of the one before`, async () => {
      const ctx = await setup({ m, step: 2500 });
      await warm(ctx, 10_000n * P);
      let seed = 0x5eed + m;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      let spot = 10_000;
      const start = epochOf(now(ctx));
      let checked = 0;
      while (epochOf(now(ctx)) < start + 6n) {
        // A move of up to +-60% (clamped at 25% a round), or a silence of up to three days.
        if (rand() < 0.15) {
          ctx.chain.advanceTime(Math.floor((1 + rand() * 2) * DAY));
        } else {
          spot = Math.max(100, Math.round(spot * (0.4 + rand() * 1.2)));
          ctx.chain.advanceTime(Math.floor(HOUR + rand() * 11 * HOUR));
        }
        await round(ctx, BigInt(spot) * P);
        const t = now(ctx);
        const e = epochOf(t);
        const b = await ctx.oracle.call('boundOf', [0n, ZERO, e]);
        const prev = await ctx.oracle.call('boundOf', [0n, ZERO, e - 1n]);
        if (b !== 0n && prev !== 0n) {
          const [lo, hi] = band(prev, m);
          assert.ok(b >= lo && b <= hi, `B_${e} inside the band of B_${e - 1n}`);
        }
        if (!(await ctx.oracle.call('silent', BOOK))) {
          const [, twap30d, ago] = await ctx.oracle.call('observe', BOOK);
          const [lo, hi] = band(b, m);
          assert.ok(twap30d >= lo && twap30d <= hi, `P30 inside the band of B_${e}`);
          if (ago !== 0n) {
            const b24 = await ctx.oracle.call('boundOf', [0n, ZERO, epochOf(t - BigInt(DAY))]);
            const [lo24, hi24] = band(b24, m);
            assert.ok(ago >= lo24 && ago <= hi24, 'the series 24 hours ago inside its own band');
          }
          const [carried] = await ctx.oracle.call('lastAccepted', BOOK);
          assert.equal(carried, twap30d, 'lastAccepted is the series at this round');
          checked++;
        }
      }
      assert.ok(checked > 10, `checked ${checked} live readings`);
    });
  }

  test('a constant spot gives exactly that series, epoch average, 24-hour-ago series and mark', async () => {
    const ctx = await setup();
    await warm(ctx, 7_777n * P);
    // The 24-hour-ago series needs the epoch a day back marked: the first marked epoch reads zero there for a day.
    await feed(ctx, 7_777n * P, 2);
    const [twapEpoch, twap30d, ago] = await ctx.oracle.call('observe', BOOK);
    assert.deepEqual([twapEpoch, twap30d, ago], [7_777n * P, 7_777n * P, 7_777n * P]);
    assert.equal(await ctx.oracle.call('boundOf', [0n, ZERO, epochOf(now(ctx))]), 7_777n * P);
    assert.equal(await ctx.oracle.call('epochAverage', [0n, ZERO, epochOf(now(ctx)) - 1n]), 7_777n * P);
  });
});

describe('ArkReferenceOracle: silence (I40)', () => {
  test('the warm-up: silent, and observe and epochAverage revert OracleSilent, until rounds cover thirty days and twenty-four hours and the epoch has a mark', async () => {
    const ctx = await setup();
    await round(ctx, 10_000n * P);
    const first = now(ctx);
    assert.equal(await ctx.oracle.call('silent', BOOK), true);
    await assert.rejects(() => ctx.oracle.call('observe', BOOK), /OracleSilent/);
    await feed(ctx, 10_000n * P, 30);
    assert.equal(await ctx.oracle.call('silent', BOOK), true, 'thirty days are not thirty days and twenty-four hours');
    assert.equal((await ctx.oracle.call('breakerActive', BOOK))[0], false, 'no breaker over a partial window');
    let days = 30;
    while (await ctx.oracle.call('silent', BOOK)) {
      ctx.chain.advanceTime(DAY);
      await round(ctx, 10_000n * P);
      days++;
    }
    assert.ok(now(ctx) - first >= BigInt(31 * DAY), `live after ${days} days`);
    await ctx.oracle.call('observe', BOOK);
  });

  test('a stopped feed is silent past T_hb, with OracleSilent(updatedAt), while lastAccepted and latestRound answer; a fresh round ends it (OC-ORC-02)', async () => {
    const ctx = await setup({ heartbeat: 6 * HOUR, interval: HOUR });
    // Daily rounds would fall silent between them at a six-hour heartbeat: feed every six hours.
    await round(ctx, 10_000n * P);
    for (let i = 0; i < 160 && (await ctx.oracle.call('silent', BOOK)); i++) {
      ctx.chain.advanceTime(6 * HOUR);
      await round(ctx, 10_000n * P);
    }
    assert.equal(await ctx.oracle.call('silent', BOOK), false);
    const [, updatedAt] = await ctx.oracle.call('latestRound', BOOK);
    ctx.chain.advanceTime(6 * HOUR);
    assert.equal(await ctx.oracle.call('silent', BOOK), false, 'at T_hb exactly the series is live');
    ctx.chain.advanceTime(1);
    assert.equal(await ctx.oracle.call('silent', BOOK), true);
    const iface = new Interface(artifact('ArkReferenceOracle').abi);
    await assert.rejects(() => ctx.oracle.call('observe', BOOK), (e) => {
      assert.match(String(e.message || e), /OracleSilent/);
      return true;
    });
    assert.ok(iface.getError('OracleSilent'));
    await assert.rejects(() => ctx.oracle.call('epochAverage', [0n, ZERO, epochOf(now(ctx)) - 1n]), /OracleSilent/);
    const [carried, at] = await ctx.oracle.call('lastAccepted', BOOK);
    assert.equal(carried, 10_000n * P, 'the carried price: the series at the last accepted round');
    assert.equal(at, updatedAt);
    await round(ctx, 10_000n * P);
    assert.equal(await ctx.oracle.call('silent', BOOK), false);
  });

  test('the pause: the guardian of the governing timelock pauses for pauseMaxEpochs, once; the timelock renews; none at S0 or once the guardian is renounced', async () => {
    const chain = await Chain.create();
    const roles = await chain.deploy('MockTimelockRoles', ['address', 'address'], [ACCOUNTS.guardian, ACCOUNTS.mallory]);
    const ctx = await setup({ chain, governance: roles.address });
    await warm(ctx, 10_000n * P);
    await assert.rejects(() => ctx.oracle.send('pause', [], { from: ACCOUNTS.bob }), /NotGuardian/);
    await ctx.oracle.send('pause', [], { from: ACCOUNTS.guardian });
    const until = await ctx.oracle.call('pausedUntil');
    assert.equal(until, now(ctx) + 2n * BigInt(EPOCH));
    assert.equal(await ctx.oracle.call('silent', BOOK), true, 'a pause is silence');
    await assert.rejects(() => ctx.oracle.call('observe', BOOK), /OracleSilent/);
    await assert.rejects(() => ctx.oracle.send('pause', [], { from: ACCOUNTS.guardian }), /PauseInForce/, 'the guardian alone cannot extend it');
    ctx.chain.advanceTime(DAY);
    await roles.send('exec', [ctx.oracle.address, ctx.oracle.iface.encodeFunctionData('pause', [])]);
    assert.equal(await ctx.oracle.call('pausedUntil'), now(ctx) + 2n * BigInt(EPOCH), 'renewed by the timelock');
    // Rounds continue through the pause; it lapses and the series is live again.
    for (let i = 0; i < 16; i++) {
      ctx.chain.advanceTime(DAY);
      await round(ctx, 10_000n * P);
    }
    assert.equal(await ctx.oracle.call('silent', BOOK), false, 'lapsed');
    await roles.send('setGuardian', [ZERO]);
    await assert.rejects(() => ctx.oracle.send('pause', [], { from: ACCOUNTS.guardian }), /NoPause/);
    const s0 = await setup();
    await assert.rejects(() => s0.oracle.send('pause', [], { from: ACCOUNTS.admin }), /NoPause/, 'S0: an account governs, no guardian');
  });
});

describe('ArkReferenceOracle: the breaker, the emergency valuation, the epoch average and the drawdown', () => {
  test('the breaker is computed from the cumulative sums: a 24-hour average 5,000 bps below the one a day earlier fires it; twap_e reads zero for an epoch, then the average since', async () => {
    const ctx = await setup({ heartbeat: DAY });
    await warm(ctx, 10_000n * P);
    for (let i = 0; i < 8; i++) {
      ctx.chain.advanceTime(3 * HOUR);
      await round(ctx, 10_000n * P);
    }
    let fired = null;
    for (let h = 0; h < 72 && !fired; h++) {
      ctx.chain.advanceTime(HOUR);
      await round(ctx, 4_000n * P);
      const [active, firedAt] = await ctx.oracle.call('breakerActive', BOOK);
      if (active) fired = firedAt;
    }
    assert.ok(fired, 'the breaker fired on the 24-hour average');
    const [, twap30d] = await ctx.oracle.call('observe', BOOK);
    assert.ok(twap30d > 5_000n * P, 'the bounded thirty-day series alone fell nowhere near 5,000 bps');
    assert.equal(await ctx.oracle.call('emergencyValuation', BOOK), 0n, 'zero until the window spans an epoch');
    // Once both 24-hour windows are past the fall the breaker clears: on this
    // definition it holds for at most about two days, so twap_e, which needs
    // an epoch since the firing, is never read while it holds (reported).
    for (let i = 0; i < 12; i++) {
      ctx.chain.advanceTime(6 * HOUR);
      await round(ctx, 4_000n * P);
    }
    assert.equal((await ctx.oracle.call('breakerActive', BOOK))[0], false, 'cleared within three days of a step fall');
    assert.equal(await ctx.oracle.call('emergencyValuation', BOOK), 0n);
  });

  test('P_e is the average of a closed epoch from the cumulative sums at its boundaries, the same whenever read; the epoch in progress is refused (OC-ORC-08)', async () => {
    const ctx = await setup();
    await warm(ctx, 10_000n * P);
    // Into a fresh epoch, then half of it at 10,000 and half at 11,000.
    const e = epochOf(now(ctx)) + 1n;
    F.toEpoch({ chain: ctx.chain }, e);
    await round(ctx, 10_000n * P);
    ctx.chain.advanceTime(EPOCH / 2);
    await round(ctx, 11_000n * P);
    await assert.rejects(() => ctx.oracle.call('epochAverage', [0n, ZERO, e]), /EpochOpen/);
    F.toEpoch({ chain: ctx.chain }, e + 1n);
    ctx.chain.advanceTime(HOUR);
    await round(ctx, 12_000n * P);
    const early = await ctx.oracle.call('epochAverage', [0n, ZERO, e]);
    assert.equal(early, 10_500n * P);
    ctx.chain.advanceTime(20 * HOUR);
    await round(ctx, 15_000n * P);
    assert.equal(await ctx.oracle.call('epochAverage', [0n, ZERO, e]), early, 'a later read, after a move, reads the same P_e');
  });

  test('the drawdown is the largest 1 - B_i / B_j over the marks inside the window, i before j', async () => {
    const ctx = await setup({ step: 2500 });
    await warm(ctx, 10_000n * P);
    let spot = 10_000n;
    const marks = [];
    for (let i = 0; i < 5; i++) {
      F.toEpoch({ chain: ctx.chain }, epochOf(now(ctx)) + 1n);
      spot = i === 2 ? spot / 2n : (spot * 13n) / 10n;
      await round(ctx, spot * P);
      for (let d = 0; d < 6; d++) {
        ctx.chain.advanceTime(DAY);
        await round(ctx, spot * P);
      }
    }
    const cur = epochOf(now(ctx));
    for (let e = cur - 12n; e <= cur; e++) marks.push(await ctx.oracle.call('boundOf', [0n, ZERO, e]));
    let mdd = 0n;
    let low = 0n;
    for (const b of marks) {
      if (b === 0n) continue;
      if (low !== 0n && b > low) {
        const dd = ((b - low) * BPS) / b;
        if (dd > mdd) mdd = dd;
      }
      if (low === 0n || b < low) low = b;
    }
    assert.ok(mdd > 0n);
    assert.equal(await ctx.oracle.call('maxDrawdownBps', [0n, ZERO, 90n * BigInt(DAY)]), mdd);
  });

  test('the realised yield is the median of the first k_o reporters\' figures for the epoch just closed', async () => {
    const ctx = await setup();
    const closed = epochOf(now(ctx)) - 1n;
    await assert.rejects(() => ctx.oracle.send('submitYield', [closed - 1n, 1n, F.ASSET_A, 300n], { from: ctx.reporters[0] }), /YieldEpoch/);
    await assert.rejects(() => ctx.oracle.send('submitYield', [closed, 1n, F.ASSET_A, 300n], { from: ACCOUNTS.bob }), /NotReporter/);
    await ctx.oracle.send('submitYield', [closed, 1n, F.ASSET_A, 300n], { from: ctx.reporters[0] });
    await ctx.oracle.send('submitYield', [closed, 1n, F.ASSET_A, 9_000n], { from: ctx.reporters[1] });
    assert.equal(await ctx.oracle.call('realisedYieldBps', [1n, F.ASSET_A]), 0n);
    await ctx.oracle.send('submitYield', [closed, 1n, F.ASSET_A, 280n], { from: ctx.reporters[2] });
    assert.equal(await ctx.oracle.call('realisedYieldBps', [1n, F.ASSET_A]), 300n);
    await ctx.oracle.send('submitYield', [closed, 1n, F.ASSET_A, 1n], { from: ctx.reporters[3] });
    assert.equal(await ctx.oracle.call('realisedYieldBps', [1n, F.ASSET_A]), 300n, 'later reports move nothing');
  });
});

describe('ArkReferenceOracle: governance (technical reference §3.3, §3.7)', () => {
  test('a keyed compare-and-swap diff inside the ranges and relations; arkReferencePrice moves at most 2,500 bps of the value in force; no key sets a price', async () => {
    const ctx = await setup();
    const gov = { from: ACCOUNTS.admin };
    const diff = (changes, o = gov) => ctx.oracle.send('setParamsDiff', [changes], o);
    await assert.rejects(() => diff([[key('heartbeatSeconds'), BigInt(DAY), 7200n]], { from: ACCOUNTS.bob }), /OnlyGovernance/);
    await assert.rejects(() => diff([]), /EmptyDiff/);
    await assert.rejects(() => diff([[key('heartbeatSeconds'), 1n, 7200n]]), /StaleParameter/);
    await assert.rejects(() => diff([[key('heartbeatSeconds'), BigInt(DAY), 7200n]]), /ParameterOutOfRange/, 'T_hb < 3 tau_o');
    await assert.rejects(() => diff([[key('twap30d'), 0n, 1n]]), /UnknownParameter/);
    await assert.rejects(() => diff([[key('heartbeatSeconds'), BigInt(DAY), 2n * BigInt(HOUR) * 3n], [key('heartbeatSeconds'), BigInt(DAY), 7200n]]), /DuplicateParameter/);
    await diff([[key('heartbeatSeconds'), BigInt(DAY), 6n * BigInt(HOUR)], [key('roundIntervalSeconds'), BigInt(HOUR), 2n * BigInt(HOUR)]]);
    const s = await ctx.oracle.call('settings');
    assert.equal(s[2], 6n * BigInt(HOUR));
    assert.equal(s[1], 2n * BigInt(HOUR));
    await assert.rejects(() => diff([[key('arkReferencePrice'), 100n * P, 126n * P]]), /ParameterStepTooLarge/);
    await diff([[key('arkReferencePrice'), 100n * P, 125n * P]]);
    assert.equal(await ctx.oracle.call('arkReferencePrice'), 125n * P);
    await assert.rejects(() => diff([[key('reporterQuorum'), 3n, 2n]]), /ReporterSetSize/);
    await assert.rejects(() => ctx.oracle.send('removeReporter', [ctx.reporters[0]], { from: ACCOUNTS.bob }), /OnlyGovernance/);
    await assert.rejects(() => ctx.oracle.send('addReporter', [REPORTERS[5]], gov), /ReporterSetSize/, 'k_o = 3 is not above half of six');
    await diff([[key('reporterQuorum'), 3n, 4n]]);
    await ctx.oracle.send('addReporter', [REPORTERS[5]], gov);
    await ctx.oracle.send('addReporter', [REPORTERS[6]], gov);
    await assert.rejects(() => ctx.oracle.send('addReporter', [REPORTERS[7]], gov), /ReporterSetSize/, 'k_o = 4 is not above half of eight');
    await assert.rejects(() => ctx.oracle.send('addReporter', [REPORTERS[6]], gov), /ReporterKnown/);
    for (const r of [REPORTERS[6], REPORTERS[5], ctx.reporters[4]]) await ctx.oracle.send('removeReporter', [r], gov);
    assert.equal(await ctx.oracle.call('reporterCount'), 4n);
    await assert.rejects(() => ctx.oracle.send('removeReporter', [ctx.reporters[3]], gov), /ReporterSetSize/, 'k_o = 4 above a set of three');
    await assert.rejects(() => ctx.oracle.send('removeReporter', [ACCOUNTS.bob], gov), /NotReporter/);
    await assert.rejects(() => ctx.oracle.send('submit', [1n, 0n, ZERO, 1n, VENUES], { from: ctx.reporters[4] }), /NotReporter/, 'a removed reporter posts nothing');
  });
});

/* ------------------------------------------------------------------ */
/* The consumers (I40)                                                 */
/* ------------------------------------------------------------------ */

/** A registry wired to the production oracle, with the doubles for the rest. */
async function registryOnOracle() {
  const chain = await Chain.create();
  const params = await F.deployParams(chain);
  const registry = await chain.deploy('ArkStakeRegistry', ['address', 'address', 'address'], [ACCOUNTS.admin, params.address, ACCOUNTS.admin]);
  await params.send('setRegistry', [registry.address]);
  const attest = await chain.deploy('MockAttestationResealable');
  const qday = await chain.deploy('MockQDayOracle');
  const bond = await chain.deploy('MockBond');
  await bond.send('set', [1_000_000n * ONE]);
  const ctx = await setup({ chain, params, qday });
  await registry.send('setDependencies', [attest.address, qday.address, ctx.oracle.address, bond.address]);
  return { ...ctx, registry, bond, attest };
}

describe('the registry on the production oracle (I38, I40)', () => {
  test('live: the registry reads the bounded series, P_t of the closed epoch and the oracle\'s breaker; silent: no boundary reading is recorded and settlement strikes at the carried price', async () => {
    const ctx = await registryOnOracle();
    await assert.rejects(() => ctx.registry.call('referencePrice'), /OracleSilent/, 'the warm-up is silence');
    assert.equal(await ctx.registry.call('settlementPrice'), 0n, 'nothing carried yet');
    await warm(ctx, 10_000n * P);
    assert.equal(await ctx.registry.call('referencePrice'), 10_000n * P);
    assert.equal(await ctx.registry.call('settlementPrice'), 10_000n * P);
    assert.equal(await ctx.registry.call('epochPrice'), 10_000n * P);
    assert.equal(await ctx.registry.call('breakerActive'), false);
    await ctx.registry.send('markPremium', []);
    const [carried] = await ctx.registry.call('carriedPrice');
    assert.equal(carried, 10_000n * P);
    // The feed stops. Two days later it is silent; the next boundary is touched under silence.
    const next = epochOf(now(ctx)) + 1n;
    F.toEpoch({ chain: ctx.chain }, next);
    ctx.chain.advanceTime(2 * DAY);
    assert.equal(await ctx.oracle.call('silent', BOOK), true);
    await assert.rejects(() => ctx.registry.call('referencePrice'), /OracleSilent/);
    await assert.rejects(() => ctx.registry.call('epochPrice'), /OracleSilent/);
    assert.equal(await ctx.registry.call('settlementPrice'), 10_000n * P, 'settlement strikes at the carried price, never reverting');
    await assert.rejects(() => ctx.registry.send('markPremium', []), /OracleSilent/, 'a mark under silence records nothing');
    const [price] = await ctx.registry.call('readingFrom', [next]);
    assert.equal(price, 0n, 'no boundary reading under silence (the severity holds)');
    // The feed resumes: the first touch records the reading.
    await round(ctx, 10_000n * P);
    await ctx.registry.send('markPremium', []);
    const [resumed, at] = await ctx.registry.call('readingFrom', [next]);
    assert.equal(resumed, 10_000n * P);
    assert.equal(at, next);
  });
});

describe("the allocation leaf on the production oracle's silence (I40)", () => {
  test("through the warm-up and a stopped feed, premiumShareBps and allocation answer at the carried mark, and the relayer's leaf rebuilds", async () => {
    const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
    const leafOk = async (ctx) => {
      const a = await ctx.registry.call('allocation');
      const [epoch, leaf] = await ctx.registry.call('currentAllocationLeaf', [F.ESCROW]);
      const values = { escrow: F.ESCROW, epoch, ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, Number(f === 'sigmaBps' ? a.premiumBps : a[f])])) };
      assert.equal(ids.allocationLeaf(values), leaf, 'the leaf the relayer seals');
      return a;
    };
    const ctx = await registryOnOracle();
    await ctx.registry.send('admitAsset', [F.assetInput()]);
    await F.anchor(ctx, { notional: 100n * ONE });
    // The warm-up (5.2 - 6.2 h on the testnet profile): silent, never marked, so the share carried is zero.
    assert.equal(await ctx.oracle.call('silent', BOOK), true);
    await assert.rejects(() => ctx.registry.call('referencePrice'), /OracleSilent/);
    assert.equal(await ctx.registry.call('premiumShareBps'), 0n);
    assert.equal((await leafOk(ctx)).premiumBps, 0n);
    await warm(ctx, 10_000n * P);
    await ctx.registry.send('markPremium', []);
    const [, marked] = await ctx.registry.call('premiumMark');
    const live = await leafOk(ctx);
    assert.ok(marked > 0n && live.coveredBps > 0n, 'a priced book');
    assert.equal(live.premiumBps, marked);
    // The feed stops: silent past T_hb (a lapsed heartbeat; a pause is the same rule).
    ctx.chain.advanceTime(2 * DAY);
    assert.equal(await ctx.oracle.call('silent', BOOK), true);
    await assert.rejects(() => ctx.registry.call('referencePrice'), /OracleSilent/);
    assert.equal(await ctx.registry.call('premiumShareBps'), marked, 'the mark carried');
    const s = await leafOk(ctx);
    assert.equal(s.premiumBps, marked);
    assert.equal(s.coveredBps, live.coveredBps, 'cover at the carried price');
  });
});

/** The PoC's declared book, on the double: 100 units anchored, 70k junior + 30k senior, vested. */
async function declaredBook({ court = 'mock' } = {}) {
  const ctx = await F.deployBondStack({ court });
  ctx.s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
  ctx.r = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
  ctx.pos = [await F.anchor(ctx, { owner: ACCOUNTS.alice, depositor: ACCOUNTS.alice, nonce: 0n, notional: 100n * ONE })];
  ctx.chain.advanceTime(91 * DAY);
  await ctx.oracle.send('set', [F.REF_PRICE, F.REF_PRICE, F.REF_PRICE]);
  await F.subscribe(ctx, { from: ACCOUNTS.alice, class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 70_000n * ONE });
  await F.subscribe(ctx, { from: ACCOUNTS.bob, class_: CLASS.SENIOR, term: TERM.QUARTER, value: 30_000n * ONE });
  return ctx;
}

describe('the consumers on the double\'s silence (I40)', () => {
  test('OC-ORC-02: a feed that stopped at the opening is silent past T_hb, so the severity balance is held, not settled at D_0', async () => {
    const ctx = await declaredBook();
    await F.declare(ctx, BigInt(ctx.chain.timestamp));
    await ctx.r.send('recordClaimants', [ctx.pos.map((p) => p.id)], { from: ACCOUNTS.mallory });
    await ctx.s.send('settleDeclaration', [], { from: ACCOUNTS.mallory });
    const t2 = await ctx.s.call('declaration');
    await ctx.oracle.send('setHeartbeat', [6n * BigInt(HOUR)]);
    F.toEpoch(ctx, t2.epoch + 4n);
    const res = await ctx.s.send('settleSeverity');
    assert.equal(ctx.s.events(res, 'SeveritySettled').length, 0, 'no severity measured on a stopped feed');
    const [held] = ctx.s.events(res, 'SeverityHeld');
    assert.ok(held && held.args.heldQrl > 0n, 'the balance above D_0 is held');
  });

  test('OC-ORC-05: a trigger-1 loss is valued at the carried price while the series is silent, reverting or zero', async () => {
    const ctx = await declaredBook({ court: 'real' });
    // The court's ARK reference, a stored value of the real oracle (deployQrlLeg sets the double's).
    await ctx.oracle.send('setArkReferencePrice', [100n * P]);
    await ctx.registry.send('markPremium', []);
    const [carried] = await ctx.registry.call('carriedPrice');
    const payload = coder.encode(['bytes32[]', 'uint256[]'], [[ctx.pos[0].id], [10n * ONE]]);
    const live = await ctx.findings.call('quote', [1, payload]);
    await ctx.oracle.send('setReverting', [true]);
    const dead = await ctx.findings.call('quote', [1, payload]);
    assert.equal(dead[0], live[0], 'valued at the carried price, which is the series it carried');
    assert.equal(dead[0], (10n * ONE * carried + P - 1n) / P);
    await ctx.oracle.send('setReverting', [false]);
    await ctx.oracle.send('set', [0n, 0n, 0n]);
    const zero = await ctx.findings.call('quote', [1, payload]);
    assert.equal(zero[0], live[0], 'a zero read is silence, not a loss below the floor');
    await ctx.oracle.send('set', [F.REF_PRICE, F.REF_PRICE, F.REF_PRICE]);
    await ctx.oracle.send('setSilent', [true]);
    assert.equal(await ctx.registry.call('settlementPrice'), carried);
  });

  test('p_ARK: the reference value while no ARK market is read; the lesser of it and the market; the market last read while silent, never above the reference', async () => {
    const ctx = await declaredBook({ court: 'real' });
    const ark = ctx.ark.address;
    const payload = coder.encode(['bytes32[]', 'uint256[]'], [[ctx.pos[0].id], [10n * ONE]]);
    const arkValue = async () => (await ctx.findings.call('quote', [1, payload]))[1];
    const v = (await ctx.findings.call('quote', [1, payload]))[0];
    const at = (p) => (v * P + p - 1n) / p;
    await ctx.oracle.send('setArkReferencePrice', [200n * P]);
    // A dead oracle: the reference is a stored value, so the court route stays open.
    await ctx.oracle.send('setReverting', [true]);
    assert.equal(await arkValue(), at(200n * P), 'p_ARK = p^ref with no market read and none carried');
    await ctx.oracle.send('setReverting', [false]);
    // A market below the reference: p_ARK is the market, V in ARK larger.
    await ctx.oracle.send('setPriceFor', [0n, ark, 100n * P]);
    assert.equal(await arkValue(), at(100n * P));
    // A market above it cannot lower V in ARK, nor the stake a verdict needs.
    await ctx.oracle.send('setPriceFor', [0n, ark, 1_000n * P]);
    assert.equal(await arkValue(), at(200n * P));
    // Read at 150, then silent: the value last read, never above the reference.
    await ctx.oracle.send('setPriceFor', [0n, ark, 150n * P]);
    await ctx.findings.send('carryArkPrice', []);
    await ctx.oracle.send('setReverting', [true]);
    assert.equal(await arkValue(), at(150n * P));
    await ctx.oracle.send('setReverting', [false]);
    await ctx.oracle.send('setPriceFor', [0n, ark, 1_000n * P]);
    await ctx.findings.send('carryArkPrice', []);
    await ctx.oracle.send('setReverting', [true]);
    assert.equal(await arkValue(), at(200n * P), 'a carried print above the reference is capped at it');
  });

  test('a trigger-1 determination is converted at the carried price while the series is dead: an outage halts no determination (yellow paper §5.2)', async () => {
    const run = async (dead) => {
      const ctx = await declaredBook();
      await ctx.registry.send('markPremium', []);
      if (dead) await ctx.oracle.send('setReverting', [true]);
      const id = keccak256(toUtf8Bytes('oc-orc-t1'));
      await ctx.court.send('open', [id]);
      const res = await ctx.court.send('determineLoss', [id, [ctx.pos[0].id], [10n * ONE]]);
      const [ev] = ctx.chain.at('ArkCatBondDeterminations', ctx.bond.address).events(res, 'LossDetermined');
      return ev.args;
    };
    const live = await run(false);
    const dead = await run(true);
    assert.ok(live.drawQrl > 0n);
    assert.equal(dead.drawQrl, live.drawQrl, 'the carried price is the series the last mark read');
    assert.equal(dead.obligation, live.obligation);
  });

  test('issuance is suspended while the series is silent, and resumes with it', async () => {
    const ctx = await F.deployBondStack();
    await ctx.oracle.send('setSilent', [true]);
    await assert.rejects(() => F.subscribe(ctx, { value: 1_000n * ONE }), /OracleSilent/);
    await ctx.oracle.send('setSilent', [false]);
    await F.subscribe(ctx, { value: 1_000n * ONE });
  });
});
