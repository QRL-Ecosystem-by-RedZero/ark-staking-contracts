/**
 * ArkStakeParamsChecks: the ranges and relations of whitepaper §6.3, moved out
 * of ArkStakeParams into a module the parameter set creates and reaches by a
 * static call (staking CLAUDE.md item 128, 2026-10-06), because with the
 * Cushion's two keys the set was 320 bytes over EIP-170 on the v3 line.
 *
 * The split is held to its contract here: the module is the set's first
 * creation and answers no one else; every range and relation still refuses
 * through `ArkStakeParams` with the error, the arguments and the very revert
 * bytes the set raised before the split, on the launch path and on the diff
 * path alike; and the set's storage is where it was, with nothing written by
 * the module, which a static call could not do in any case.
 *
 * Expected arguments are derived here from the rule, never read back from the
 * contract: the range cases from the module's source text (every `_range`,
 * each bound one past on each side it has), the relations by hand.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Interface, getCreateAddress } = require('ethers');
const { createAddressFromString, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { Chain, artifact } = require('./harness');
const {
  ACCOUNTS,
  ASSET_A,
  GROUP_A,
  REFERENCE_PARAMS,
  PARAM_FIELDS,
  FLAT_ROWS,
  withParams,
  assetInput,
  deployStack,
  deployParams,
  voteParams,
  paramKey,
  toNextEpoch,
} = require('./stake-fixture');

const iface = new Interface(artifact('ArkStakeParams').abi);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'ArkStakeParamsChecks.hyp'), 'utf8');
const MATH = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'utils', 'ArkStakeMath.hyp'), 'utf8');

const BPS = 10000n;
const DAY = 86400n;
const EPOCH = 7n * DAY;
const UNBONDING = 21n * DAY;
const U16_MAX = 65535n;
const U32_MAX = 4294967295n;
const WIDTH = { claimCostGwei: 4 };
/** The registry argument before one is named: no floor under the release bound. */
const NO_REGISTRY = '0x' + '00'.repeat(20);

/**
 * Rows packed as the set stores them and the module reads them (item 129):
 * the cell of field f of phase p in the sixteen bits from bit 16 x (3p + f).
 */
const packRows = (rows) => rows.reduce((w, row, ph) => row.reduce((acc, v, f) => acc | (BigInt(v) << BigInt(16 * (3 * ph + f))), w), 0n);
/** The fixture's rows with one cell replaced. */
const rowsWith = (ph, f, v) => FLAT_ROWS.map((r, i) => r.map((x, j) => (i === ph && j === f ? v : x)));
const ROW_FIELDS = ['admittedTermsMask', 'cushionTargetBps', 'cushionCeilingBps'];

/** The module's address: the parameter set's first CREATE (a contract's nonce starts at 1). */
const moduleOf = (params) => getCreateAddress({ from: params.address, nonce: 1 });

/** The raw revert bytes of a refused promise. */
async function revertData(promise) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e.data && e.data !== '0x', `a revert with data: ${e.message}`);
    return e.data.toLowerCase();
  }
  throw new Error('expected a revert');
}

async function slot(chain, address, n) {
  const key = typeof n === 'string' ? n : '0x' + BigInt(n).toString(16).padStart(64, '0');
  const v = await chain.vm.stateManager.getStorage(createAddressFromString(address), hexToBytes(key));
  return v.length ? BigInt(bytesToHex(v)) : 0n;
}

/* ------------------------------------------------------------------ */
/* Every range, read out of the module's source                        */
/* ------------------------------------------------------------------ */

/** A bound expression of the source, evaluated at the reference values. */
function evalBound(expr) {
  const text = expr
    .trim()
    .replace(/type\(uint16\)\.max/g, String(U16_MAX))
    .replace(/ArkStakeMath\.BUFFER_ESCALATOR_CAP_BPS/g, /BUFFER_ESCALATOR_CAP_BPS = (\d+)/.exec(MATH)[1])
    .replace(/MAX_RELEASE_BOUND_BPS/g, /MAX_RELEASE_BOUND_BPS = (\d+)/.exec(SRC)[1])
    .replace(/uint256\(([^)]*)\)/g, '($1)')
    .replace(/p\.(\w+)/g, (_, k) => {
      assert.ok(k in REFERENCE_PARAMS, `bound names ${k}`);
      return String(REFERENCE_PARAMS[k]);
    });
  assert.match(text, /^[\d\s()+-]+$/, `a plain bound: ${expr}`);
  return BigInt(Function(`return ${text}`)());
}

const RANGES = [...SRC.matchAll(/_range\("(\w+)", p\.(\w+), ([^,]+), ([^;]+)\);/g)].map(([, name, field, lo, hi]) => {
  assert.equal(name, field, 'a range names the field it bounds');
  return { name, lo: evalBound(lo), hi: evalBound(hi) };
});

/** Each range one past each side it has inside the field's width: [name, value]. */
const RANGE_CASES = RANGES.flatMap(({ name, lo, hi }) => {
  const max = WIDTH[name] === 4 ? U32_MAX : U16_MAX;
  const out = [];
  if (lo > 0n) out.push([name, lo - 1n]);
  if (hi < max) out.push([name, hi + 1n]);
  return out;
});

/* ------------------------------------------------------------------ */
/* Every relation, by hand, with the bound the rule names              */
/* ------------------------------------------------------------------ */

const R = REFERENCE_PARAMS;
const drain = (bound) => (BPS + bound - 1n) / bound;
const ladderMax = (release) => BPS / ((UNBONDING + EPOCH - 1n) / EPOCH + (BPS + release - 1n) / release);
const reserveLadder = (floor, move, step) => (floor <= move ? 2n : 2n + (floor - move + step - 1n) / step);
const firstRound = BigInt(R.challengeWindowDays + R.evidenceDays + R.commitDays + R.revealDays + R.appealDays);

/** [overrides, relation, supplied, bound]. */
const RELATION_CASES = [
  [{ premiumCeilingBps: R.threatStage4Bps }, 'target < ceiling <= BPS - buffer - ops', BigInt(R.threatStage4Bps), BigInt(R.threatStage4Bps) + 1n],
  [{ premiumCeilingBps: 9501 }, 'target < ceiling <= BPS - buffer - ops', 9501n, BPS - BigInt(R.bufferBps) - BigInt(R.operationsBps)],
  [{ surgeCeilingBps: R.premiumCeilingBps }, 'ceiling < surge <= BPS - ops - seed buffer', BigInt(R.premiumCeilingBps), BigInt(R.premiumCeilingBps) + 1n],
  [{ surgeCeilingBps: 8751 }, 'ceiling < surge <= BPS - ops - seed buffer', 8751n, BPS - BigInt(R.operationsBps) - 1000n],
  [{ maturityLadderBps: 0 }, 'ladder <= BPS / settlement horizon', 0n, 1n],
  [{ maturityLadderBps: Number(ladderMax(BigInt(R.releaseBoundBps))) + 1 }, 'ladder <= BPS / settlement horizon', ladderMax(BigInt(R.releaseBoundBps)) + 1n, ladderMax(BigInt(R.releaseBoundBps))],
  [{ runoffBoundBps: 2500 }, 'runoff drain >= 1.5 x unbonding', 2500n, drain(2500n)],
  [{ seniorCouponBps: R.tailPremiumFloorBps + 1 }, 'senior coupon <= tail floor', BigInt(R.tailPremiumFloorBps) + 1n, BigInt(R.tailPremiumFloorBps)],
  [{ unsoldEpochs: 6 }, 'retention >= reserve ladder', 6n, reserveLadder(BigInt(R.reserveFloorBps), BigInt(R.maxEpochMoveBps), BigInt(R.reserveStepBps))],
  [{ unsoldEpochs: 13 }, 'retention >= reserve ladder', 13n, 12n],
  // Per phase since item 129: the fixture writes a flat override into every row, and row 0 refuses first.
  [{ cushionCeilingBps: R.cushionTargetBps - 1 }, 'c_tgt <= c_max <= 3000@0', BigInt(R.cushionTargetBps) - 1n, BigInt(R.cushionTargetBps)],
  [{ cushionCeilingBps: 3001 }, 'c_tgt <= c_max <= 3000@0', 3001n, 3000n],
  [{ trigger2FloorBps: R.severityFloorBps - 1 }, 'D0 >= severity floor', BigInt(R.severityFloorBps) - 1n, BigInt(R.severityFloorBps)],
  [{ trigger2FloorBps: 10001 }, 'D0 >= severity floor', 10001n, BPS],
  // Relation 9: the drain at 1,600 is seven epochs, so the floor may be at most BPS - 6 x decay.
  [{ runoffBoundBps: 1600 }, 'exposure floor <= BPS - (n_d - 1) x decay', BigInt(R.queueExposureFloorBps),
    (() => { const m = BPS - (drain(1600n) - 1n) * BigInt(R.queueDecayBps); return m < 0n ? 0n : m; })()],
  [{ appealDays: R.appealDays + 1 }, 'court cycle with appeal < unbonding',
    firstRound + 1n + BigInt(R.commitDays + R.revealDays + R.appealDays + 1), UNBONDING / DAY],
  [{ graceEpochs: 3 }, 'grace <= first-round cycle', 3n * EPOCH, firstRound * DAY],
];

describe('ArkStakeParamsChecks: the ranges and relations run in a module the parameter set created, by static call', () => {
  test('the module is the set\'s first creation, carries the set as its one caller, and the set\'s ABI is the one before the split', async () => {
    const chain = await Chain.create();
    const params = await deployParams(chain);
    const addr = moduleOf(params);
    const code = bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(addr)));
    const runtime = artifact('ArkStakeParamsChecks').deployedBytecode;
    assert.equal(code.length, runtime.length, 'the module\'s runtime, created by the set\'s constructor at CREATE nonce 1');
    assert.ok(code.includes(params.address.slice(2).toLowerCase()), 'the set\'s address is the immutable HOST');
    const acct = await chain.vm.stateManager.getAccount(createAddressFromString(params.address));
    assert.equal(acct.nonce, 2n, 'one creation, the module, and no other');
    // No getter, no setter, no entry for the module on the set.
    for (const f of ['check', 'CHECKS_MODULE', 'checksModule']) assert.equal(iface.getFunction(f), null, f);
    const errors = iface.fragments.filter((f) => f.type === 'error').map((f) => f.format('sighash'));
    for (const e of ['ParameterOutOfRange(string,uint256)', 'RelationViolated(string,uint256,uint256)', 'ReleaseBoundBelowAssetExit(uint256,uint256)']) {
      assert.ok(errors.includes(e), e);
    }
  });

  test('a direct call is refused, whoever makes it; the set\'s own address is answered', async () => {
    const chain = await Chain.create();
    const params = await deployParams(chain);
    const m = chain.at('ArkStakeParamsChecks', moduleOf(params));
    const set = withParams({});
    const rows = packRows(FLAT_ROWS);
    for (const who of [ACCOUNTS.admin, ACCOUNTS.mallory]) {
      const data = await revertData(m.call('check', [set, NO_REGISTRY, rows], { from: who }));
      assert.equal(data, iface.encodeErrorResult('OnlyDeployer', [who]).toLowerCase(), who);
    }
    // As the set calls it: a set inside every range returns, one outside does not.
    await m.call('check', [set, NO_REGISTRY, rows], { from: params.address });
    const data = await revertData(m.call('check', [withParams({ successorLimit: 4 }), NO_REGISTRY, rows], { from: params.address }));
    assert.equal(data, iface.encodeErrorResult('ParameterOutOfRange', ['successorLimit', 4n]).toLowerCase());
    // The rows are checked by the same call, the set's per-phase fields not at all (item 129).
    const bad = await revertData(m.call('check', [set, NO_REGISTRY, packRows(rowsWith(4, 1, 2001))], { from: params.address }));
    assert.equal(bad, iface.encodeErrorResult('ParameterOutOfRange', ['cushionTargetBps@4', 2001n]).toLowerCase());
    await m.call('check', [withParams({ admittedTermsMask: 0, cushionTargetBps: 9999, cushionCeilingBps: 0 }), NO_REGISTRY, rows], { from: params.address });
  });

  test(`every range of the source (${RANGES.length} of them) refuses at construction with ParameterOutOfRange(name, supplied), byte for byte`, async () => {
    // Fifty until the mask and the Cushion's target moved into the rows (item 129).
    assert.ok(RANGES.length >= 48, `read ${RANGES.length} ranges`);
    for (const f of ROW_FIELDS) assert.ok(!RANGES.some((r) => r.name === f), `${f} is per phase, not a field range`);
    assert.equal(new Set(RANGES.map((r) => r.name)).size, RANGES.length, 'each field bounded once');
    const chain = await Chain.create();
    for (const [name, value] of RANGE_CASES) {
      const data = await revertData(deployParams(chain, { params: { [name]: value } }));
      assert.equal(data, iface.encodeErrorResult('ParameterOutOfRange', [name, value]).toLowerCase(), `${name} = ${value}`);
    }
  });

  test('every reachable relation refuses at construction with RelationViolated(relation, supplied, bound), byte for byte', async () => {
    const chain = await Chain.create();
    const named = new Set();
    for (const [overrides, relation, supplied, bound] of RELATION_CASES) {
      const data = await revertData(deployParams(chain, { params: overrides }));
      assert.equal(data, iface.encodeErrorResult('RelationViolated', [relation, supplied, bound]).toLowerCase(), relation);
      named.add(relation);
    }
    // Every relation of the source is above but the one the ranges imply at
    // their corner (8 x decay >= BPS - floor, OC-ECON-09), which no set
    // inside the ranges can break.
    const inSource = new Set([...SRC.matchAll(/(?:_relation|RelationViolated)\(\s*"([^"]+)"/g)].map(([, r]) => r));
    const unreachable = [...inSource].filter((r) => !named.has(r));
    assert.deepEqual(unreachable, ['8 x decay >= BPS - floor']);
  });

  test('every phase row is checked at construction, cell by cell, named as its key (item 129)', async () => {
    const chain = await Chain.create();
    for (let ph = 0; ph < 5; ph++) {
      // The mask: 1 - 7, but 0 - 7 in Q-Day's row (settlement only). A zero
      // mask in row 0 is the constructor's sentinel for the reference rows, so
      // row 0's lower edge is refused on the diff path only (the settlement suite).
      if (ph === 0) {
        const ref = await deployParams(chain, { rows: rowsWith(0, 0, 0) });
        assert.deepEqual([...(await ref.call('phaseRow', [2]))].map(Number), [3, 1000, 2000], 'row 0 mask 0: the reference rows');
      } else if (ph !== 3) {
        const data = await revertData(deployParams(chain, { rows: rowsWith(ph, 0, 0) }));
        assert.equal(data, iface.encodeErrorResult('ParameterOutOfRange', [`admittedTermsMask@${ph}`, 0n]).toLowerCase(), `mask 0 in row ${ph}`);
      } else {
        await deployParams(chain, { rows: rowsWith(ph, 0, 0) });
      }
      let data = await revertData(deployParams(chain, { rows: rowsWith(ph, 0, 8) }));
      assert.equal(data, iface.encodeErrorResult('ParameterOutOfRange', [`admittedTermsMask@${ph}`, 8n]).toLowerCase(), `mask 8 in row ${ph}`);
      // c_tgt 0 - 2,000; relation 10, c_tgt <= c_max <= 3,000.
      const wide = FLAT_ROWS.map((r, i) => (i === ph ? [7, 2001, 3000] : r));
      data = await revertData(deployParams(chain, { rows: wide }));
      assert.equal(data, iface.encodeErrorResult('ParameterOutOfRange', [`cushionTargetBps@${ph}`, 2001n]).toLowerCase(), `c_tgt in row ${ph}`);
      data = await revertData(deployParams(chain, { rows: rowsWith(ph, 2, 3001) }));
      assert.equal(data, iface.encodeErrorResult('RelationViolated', [`c_tgt <= c_max <= 3000@${ph}`, 3001n, 3000n]).toLowerCase(), `c_max in row ${ph}`);
      data = await revertData(deployParams(chain, { rows: rowsWith(ph, 2, 499) }));
      assert.equal(data, iface.encodeErrorResult('RelationViolated', [`c_tgt <= c_max <= 3000@${ph}`, 499n, 500n]).toLowerCase(), `c_max below c_tgt in row ${ph}`);
      // Both edges admitted.
      await deployParams(chain, { rows: FLAT_ROWS.map((r, i) => (i === ph ? [1, 2000, 3000] : r)) });
      await deployParams(chain, { rows: FLAT_ROWS.map((r, i) => (i === ph ? [7, 0, 0] : r)) });
    }
  });

  test('the diff path raises the same bytes as the launch path, and a refused diff stages nothing', async () => {
    const ctx = await deployStack({ assets: [] });
    const chain = await Chain.create();
    // Inside each key's D7 step, so the range or relation is what refuses.
    const cases = [
      [{ operationsBps: 249 }, 'ParameterOutOfRange', ['operationsBps', 249n]],
      [{ fxWindowDays: 29 }, 'ParameterOutOfRange', ['fxWindowDays', 29n]],
      [{ successorLimit: 4 }, 'ParameterOutOfRange', ['successorLimit', 4n]],
      [{ indemnityBps: 10001 }, 'ParameterOutOfRange', ['indemnityBps', 10001n]],
      [{ releaseBoundBps: 2501 }, 'ParameterOutOfRange', ['releaseBoundBps', 2501n]],
      [{ seniorCouponBps: 201 }, 'RelationViolated', ['senior coupon <= tail floor', 201n, 200n]],
      [{ appealDays: 3 }, 'RelationViolated', ['court cycle with appeal < unbonding', 22n, 21n]],
      [{ trigger2FloorBps: 5999 }, 'RelationViolated', ['D0 >= severity floor', 5999n, 6000n]],
    ];
    for (const [overrides, error, args] of cases) {
      const want = iface.encodeErrorResult(error, args).toLowerCase();
      assert.equal(await revertData(voteParams(ctx.params, overrides)), want, `diff ${JSON.stringify(overrides)}`);
      assert.equal(await revertData(deployParams(chain, { params: overrides })), want, `launch ${JSON.stringify(overrides)}`);
    }
    const [, effective] = await ctx.params.call('pendingParams');
    assert.equal(effective, 0n, 'nothing staged by a refused diff');
  });

  test('the floor the registry publishes is read by the module through the set\'s registry, in its pre-split place: ReleaseBoundBelowAssetExit(bound, exit)', async () => {
    const ctx = await deployStack({ assets: [] });
    await ctx.registry.send('admitAsset', [assetInput({ asset: ASSET_A, group: GROUP_A, exitBoundBps: 2200 })], { from: ACCOUNTS.admin });
    const data = await revertData(voteParams(ctx.params, { releaseBoundBps: 2100, maturityLadderBps: 1250 }));
    assert.equal(data, iface.encodeErrorResult('ReleaseBoundBelowAssetExit', [2100n, 2200n]).toLowerCase());
    // Checked before the ladder's relation, as before the split: 2,100 with the
    // reference ladder breaks both, and the asset's exit is what is reported.
    const both = await revertData(voteParams(ctx.params, { releaseBoundBps: 2100 }));
    assert.equal(both, iface.encodeErrorResult('ReleaseBoundBelowAssetExit', [2100n, 2200n]).toLowerCase());
    await voteParams(ctx.params, { releaseBoundBps: 2200, maturityLadderBps: 1250 });
  });
});

describe('ArkStakeParamsChecks: the set\'s storage is where it was, and the module writes none', () => {
  /**
   * The declarations of ArkStakeParams, unchanged by the split (an immutable
   * takes no slot): governance 0, pendingGovernance 1, registry 2, _bank 3 -
   * 14 (three sets of four words: fifty-seven sixteen-bit fields and the
   * thirty-two-bit claim cost, packed in order), _live 15, _pendingEpoch 16,
   * _stage and _pendingStage 17, _pendingStageEpoch 18, lastStageEpoch 19,
   * _liveSince 20, _prevStage 21, _stageSince 22, _successorCount 23,
   * _successorIndex 24; appended 2026-10-07 (item 129): _prevStageSince 25,
   * _rows 26 - 28 (one packed word per bank). `_stage` is the band of phase
   * 2 since then, and launches at 2.
   */
  const SET_WORDS = 4;
  const BANK = 3;
  /** Each field's word and byte offset inside a set. */
  const LAYOUT = (() => {
    const out = {};
    let word = 0;
    let offset = 0;
    for (const [k] of PARAM_FIELDS) {
      const size = WIDTH[k] || 2;
      if (offset + size > 32) {
        word += 1;
        offset = 0;
      }
      out[k] = { word, offset, size };
      offset += size;
    }
    assert.equal(word + 1, SET_WORDS, 'a set is four words');
    return out;
  })();

  async function bankAt(chain, address, i) {
    const words = [];
    for (let w = 0; w < SET_WORDS; w++) words.push(await slot(chain, address, BANK + SET_WORDS * i + w));
    const set = {};
    for (const [k, { word, offset, size }] of Object.entries(LAYOUT)) {
      set[k] = Number((words[word] >> BigInt(offset * 8)) & ((1n << BigInt(size * 8)) - 1n));
    }
    return set;
  }

  test('the launch set, a staged diff and the wiring sit at the pre-split slots, and a refused diff moves none of them', async () => {
    const ctx = await deployStack({ assets: [] });
    const { chain, params } = ctx;
    const addr = params.address;
    assert.equal(await slot(chain, addr, 0), BigInt(ACCOUNTS.admin), 'governance at slot 0');
    assert.equal(await slot(chain, addr, 2), BigInt(ctx.registry.address), 'registry at slot 2');
    assert.deepEqual(await bankAt(chain, addr, 0), REFERENCE_PARAMS, '_bank[0] is the launch set');
    assert.equal(await slot(chain, addr, 17) & 0xffn, 2n, '_stage (the band) at slot 17');
    assert.equal(await slot(chain, addr, 26), packRows(FLAT_ROWS), '_rows[0] at slot 26');

    const before = [];
    for (let n = 0; n < 29; n++) before.push(await slot(chain, addr, n));
    await revertData(voteParams(params, { successorLimit: 4 }));
    await revertData(voteParams(params, { trigger2FloorBps: 5999 }));
    await revertData(voteParams(params, { 'cushionCeilingBps@3': 400 }));
    for (let n = 0; n < 29; n++) assert.equal(await slot(chain, addr, n), before[n], `slot ${n} after refused diffs`);

    await voteParams(params, { 'cushionTargetBps@0': 600, jurorSlashBps: 2500 });
    const epoch = BigInt(chain.timestamp) / EPOCH;
    assert.equal(await slot(chain, addr, 16), epoch + 1n, '_pendingEpoch at slot 16');
    assert.deepEqual(await bankAt(chain, addr, 1), { ...REFERENCE_PARAMS, jurorSlashBps: 2500 }, '_bank[1] is the staged set; its per-phase copies are not written');
    assert.equal(await slot(chain, addr, 27), packRows(rowsWith(0, 1, 600)), '_rows[1] is staged with it');
    assert.equal(await params.call('paramOf', [paramKey('cushionTargetBps@0')]), 600n);
    toNextEpoch(ctx);
    assert.equal(Number((await params.call('params')).cushionTargetBps), 600);
  });

  test('the module\'s own storage is empty after a launch, diffs and refusals', async () => {
    const ctx = await deployStack({ assets: [] });
    await voteParams(ctx.params, { 'cushionTargetBps@0': 600 });
    await revertData(voteParams(ctx.params, { successorLimit: 4 }));
    const m = moduleOf(ctx.params);
    for (let n = 0; n < 29; n++) assert.equal(await slot(ctx.chain, m, n), 0n, `module slot ${n}`);
    const acct = await ctx.chain.vm.stateManager.getAccount(createAddressFromString(m));
    assert.equal(acct.balance, 0n);
  });
});
