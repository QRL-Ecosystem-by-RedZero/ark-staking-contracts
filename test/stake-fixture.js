/**
 * The QRL leg of Ark Staking, deployed on the local harness, and the
 * identifiers recomputed off chain exactly as the contracts compute them.
 *
 * Shared by the registry, parameter and relay suites so that the stack they
 * test is one stack. Each suite still builds its own instance per test: the
 * harness has no snapshots, and a state leaking between two tests would let a
 * test pass on the other's book.
 */
const { keccak256, AbiCoder, toUtf8Bytes, concat } = require('ethers');
const { Chain, ACCOUNTS } = require('./harness');

const coder = AbiCoder.defaultAbiCoder();

const DAY = 24 * 60 * 60;
const EPOCH = 7 * DAY;
const BPS = 10000n;
const PRICE_SCALE = 10n ** 18n;
const ONE = 10n ** 18n;

/** 10,000 QRL to one unit of the origin asset — the modelled price of the scenario report. */
const REF_PRICE = 10_000n * PRICE_SCALE;

const GROUP_A = keccak256(toUtf8Bytes('group:lido-like'));
const GROUP_B = keccak256(toUtf8Bytes('group:rocket-like'));
const ASSET_A = '0x' + 'aa'.repeat(20);
const ASSET_B = '0x' + 'bb'.repeat(20);
const CHAIN_ID = 1n;
const ZERO = '0x' + '00'.repeat(20);

const STAKE_DOMAIN = keccak256(toUtf8Bytes('ARK_STAKE_V1'));
const ALLOCATION_DOMAIN = keccak256(toUtf8Bytes('ARK_STAKE_ALLOCATION_V4'));
const RELEASED_DOMAIN = keccak256(toUtf8Bytes('ARK_STAKE_RELEASED_V1'));
const INSURANCE_DOMAIN = keccak256(toUtf8Bytes('QUANTUM_ARK_CLAIM_V1'));
const BUFFER_DOMAIN = keccak256(toUtf8Bytes('ARK_STAKE_BUFFER_V1'));
// V2 since the re-audit of 2026-09-30 (BOND-02): the count is cumulative through the epoch.
const ANCHOR_COUNT_DOMAIN = keccak256(toUtf8Bytes('ARK_STAKE_ANCHOR_COUNT_V2'));

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

/**
 * The canonical two-word form of a QRL account (identifiers.js
 * `qrlOwnerWords`): a QIP-55 address is 64 bytes and enters a preimage as its
 * two halves; the legacy 20-byte form is a zero high word and the
 * right-aligned low word.
 */
const qrlOwnerWords = (owner) => {
  const hex = String(owner).replace(/^0x|^Q/, '').toLowerCase();
  if (hex.length === 128) return { hi: `0x${hex.slice(0, 64)}`, lo: `0x${hex.slice(64)}` };
  if (hex.length === 40) return { hi: `0x${'0'.repeat(64)}`, lo: `0x${'0'.repeat(24)}${hex}` };
  throw new Error(`a QRL account is 64 bytes (or the legacy 20): got ${hex.length / 2}`);
};

const stakeAssetId = (chainId, asset, depositor, boundQrlOwner, nonce) => {
  const owner = qrlOwnerWords(boundQrlOwner);
  return keccak256(
    coder.encode(
      ['uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint64'],
      [chainId, asset, depositor, owner.hi, owner.lo, nonce],
    ),
  );
};

/**
 * The origin-chain escrow the suite's positions are anchored in. Every leaf
 * binds the escrow that pays or emits it since 2026-09-28 (D10); a test that
 * needs a second escrow passes its own.
 */
const ESCROW = '0x' + 'e5'.repeat(20);

const stakeLeafKey = (id, notional, escrow = ESCROW) =>
  keccak256(coder.encode(['bytes32', 'address', 'bytes32', 'uint256'], [STAKE_DOMAIN, escrow, id, notional]));

const insuranceLeafKey = (id, notional) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'uint256'], [INSURANCE_DOMAIN, id, notional]));

const releasePayload = (id, recipient, claimNonce, chainId) =>
  keccak256(coder.encode(['bytes32', 'address', 'uint64', 'uint256'], [id, recipient, claimNonce, chainId]));

const releaseLeaf = (payload, escrow = ESCROW) =>
  keccak256(coder.encode(['bytes32', 'address', 'bytes32'], [STAKE_DOMAIN, escrow, payload]));

const releasedLeaf = (id, claimNonce, escrow = ESCROW) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'address', 'bytes32', 'uint64'], [STAKE_DOMAIN, RELEASED_DOMAIN, escrow, id, claimNonce]));

/**
 * The V3 allocation leaf (gap item 19): the premium, buffer, operations and
 * juror fraction, then the levy, the target rung, the cover, the reserve's cap
 * factor and the commitment term. `a` is the registry's `Allocation`, or any
 * object with its field names.
 */
const ALLOCATION_FIELDS = ['premiumBps', 'bufferBps', 'operationsBps', 'jurorFeeShareBps', 'levyBps', 'sigmaTargetBps', 'coveredBps', 'psrCapBps', 'commitTermEpochs', 'stepQueued'];
const allocationLeaf = (epoch, a, escrow = ESCROW) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'address', 'uint256', ...ALLOCATION_FIELDS.map((f) => (f === 'stepQueued' ? 'bool' : 'uint16'))],
      [STAKE_DOMAIN, ALLOCATION_DOMAIN, escrow, epoch, ...ALLOCATION_FIELDS.map((f) => (f === 'stepQueued' ? Boolean(a[f]) : a[f]))],
    ),
  );

/** An escrow's buffer carried forward (ArkStakeIds.bufferLeaf): chain, escrow, asset, epoch, units. */
const bufferLeaf = (chainId, asset, epoch, units, escrow = ESCROW) =>
  keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256'],
      [STAKE_DOMAIN, BUFFER_DOMAIN, chainId, escrow, asset, epoch, units],
    ),
  );

/** The forward root's count of its anchors (ArkStakeIds.anchorCountLeaf; audit 2026-09-29, QL-05, QL-06). */
const anchorCountLeaf = (epoch, count) =>
  keccak256(coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [STAKE_DOMAIN, ANCHOR_COUNT_DOMAIN, epoch, count]));

/** OpenZeppelin's sorted-pair hash, so a two-leaf root matches on chain. */
const pairHash = (a, b) =>
  BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));

/* ------------------------------------------------------------------ */
/* Parameters                                                          */
/* ------------------------------------------------------------------ */

/**
 * The reference values of whitepaper chapter 6, as the `Params` tuple, in the
 * order the struct declares them. `withParams({ premiumSlopeRatioBps: 2500 })` returns
 * the tuple with one field replaced, so a test states only what it changes.
 */
const PARAM_FIELDS = [
  ['threatStage1Bps', 1850],
  ['threatStage2Bps', 2500],
  ['threatStage3Bps', 3000],
  ['threatStage4Bps', 3700],
  // A ratio of the stage's target since 2026-09-30 (EC-07).
  ['premiumSlopeRatioBps', 5000],
  ['premiumCeilingBps', 7400],
  ['surgeCeilingBps', 8500],
  ['tailPremiumFloorBps', 200],
  ['indemnityBps', 10000],
  ['pmlFloorBps', 2000],
  ['maxAssetShareBps', 2000],
  ['bufferBps', 250],
  ['operationsBps', 250],
  ['jurorFeeShareBps', 2000],
  ['maxEpochMoveBps', 2500],
  ['fxHaircutMaxBps', 2500],
  ['fxWindowDays', 90],
  ['releaseBoundBps', 2500],
  ['maturityLadderBps', 1428],
  ['runoffTriggerBps', 2500],
  ['runoffBoundBps', 2000],
  ['juniorThicknessBps', 7000],
  ['seniorCouponBps', 100],
  ['reserveStepBps', 500],
  ['reserveFloorBps', 5000],
  ['clearingFloorBps', 5000],
  ['unsoldEpochs', 7],
  ['graceEpochs', 2],
  ['validatorConcentrationBps', 1000],
  ['exitDeadlineEpochs', 2],
  ['operatorBondBps', 1000],
  ['rewardRateCapBps', 1000],
  ['stabilizationLevyBps', 200],
  ['commitmentTermEpochs', 13],
  ['psrCapEpochs', 6],
  ['trigger2FloorBps', 6000],
  ['severityFloorBps', 6000],
  ['assessmentWindowEpochs', 4],
  ['queueDecayBps', 1500],
  ['queueExposureFloorBps', 2500],
  ['jurorSlashBps', 3000],
  ['verdictCoverBps', 6666],
  // Appended 2026-09-28 (phase C1b): the keys of contracts/core's timelock
  // table that were not fields before.
  ['bufferEscalatorCapBps', 1500],
  ['solverBondCeilingBps', 750],
  ['solverBondFloorBps', 150],
  ['successorLimit', 3],
  ['challengeWindowDays', 7],
  ['evidenceDays', 3],
  ['commitDays', 2],
  ['revealDays', 1],
  ['appealDays', 2],
  // Appended 2026-09-28 (phase C3): the admitted bond terms, one bit per term.
  ['admittedTermsMask', 7],
  // Appended 2026-09-30 (the papers' EC revision): d_first, batching, the ramp.
  ['firstReserveDiscountBps', 400],
  ['offeringBatchMultiple', 50],
  ['claimCostGwei', 600000],
  ['bufferRampThresholdBps', 1000],
  // Appended 2026-10-06: the Cushion's target and ceiling (technical reference §3.2).
  ['cushionTargetBps', 500],
  ['cushionCeilingBps', 1500],
];

/** The one field wider than sixteen bits. */
const PARAM_TYPES = { claimCostGwei: 'uint32' };

const REFERENCE_PARAMS = Object.fromEntries(PARAM_FIELDS);

function withParams(overrides = {}) {
  for (const k of Object.keys(overrides)) {
    if (!(k in REFERENCE_PARAMS)) throw new Error(`no parameter ${k}`);
  }
  return PARAM_FIELDS.map(([k, v]) => (k in overrides ? overrides[k] : v));
}

/** The ABI type of `Params`, for the constructor argument. */
const PARAMS_TYPE = `tuple(${PARAM_FIELDS.map(([k]) => PARAM_TYPES[k] || 'uint16').join(',')})`;

/** The all-zero set: the constructor reads a zero first rung as "the reference values". */
const ZERO_PARAMS = PARAM_FIELDS.map(() => 0);

/** A parameter's key, as the timelock and `setParamsDiff` name it. */
const paramKey = (name) => keccak256(toUtf8Bytes(name));

/* ------------------------------------------------------------------ */
/* The ecosystem phase (staking CLAUDE.md item 129)                    */
/* ------------------------------------------------------------------ */

/** The three fields kept per phase, in `PhaseRow` order. */
const PHASE_ROW_FIELDS = ['admittedTermsMask', 'cushionTargetBps', 'cushionCeilingBps'];
const PHASE_ROW_TYPE = 'tuple(uint16,uint16,uint16)[5]';
/** The threat stage of each phase before any band step (QuantumArk-Phases.md §4). */
const STAGE_OF_PHASE = [1, 1, 2, 4, 1];
/** The reference rows of QuantumArk-Phases.md §4, the deployment profile: what a zero row 0 stands for. */
const REFERENCE_ROWS = [
  [7, 500, 1500],
  [7, 500, 1500],
  [3, 1000, 2000],
  [0, 1500, 3000],
  [7, 500, 1500],
];
/**
 * Every phase at row 0's values: the fixture's default. A suite written about
 * the threat stage reaches stages 2 - 4 by moving the phase (`stepToStage`),
 * and with these rows that move changes the stage and nothing else, as a stage
 * vote did before the phase existed. `test/ArkStakePhase.test.js` deploys the
 * reference rows.
 */
const FLAT_ROWS = REFERENCE_ROWS.map(() => [...REFERENCE_ROWS[0]]);
/** The all-zero rows: the constructor reads a zero mask in row 0 as "the reference rows". */
const ZERO_ROWS = REFERENCE_ROWS.map(() => [0, 0, 0]);
/** A per-phase cell's name as its key spells it: `cushionTargetBps@3`. */
const isRowCell = (name) => /^(admittedTermsMask|cushionTargetBps|cushionCeilingBps)@[0-4]$/.test(name);

/**
 * Deploy the parameter set on a `MockArkPhase` (phase 0 from now), which it
 * carries as `.phase`. `params` overrides fields of the reference set at
 * construction — the one moment a whole set is written (design §6.2); without
 * it the constructor's own reference values are used. An override of one of
 * the three per-phase fields is written into every row, so a suite that set
 * it flat before the rows existed still launches with that value in force
 * whatever the phase. `rows` replaces the rows outright; `phase` names an
 * existing phase contract, whose epoch length must be `ArkEpoch`'s.
 */
async function deployParams(chain, { params, rows, phase, governance = ACCOUNTS.admin, deployer = ACCOUNTS.admin } = {}) {
  let launchRows = rows || FLAT_ROWS.map((r) => [...r]);
  if (!rows && params) {
    PHASE_ROW_FIELDS.forEach((f, i) => {
      if (f in params) launchRows = launchRows.map((r) => r.map((v, j) => (j === i ? params[f] : v)));
    });
  }
  const phaseContract = phase ? chain.at('MockArkPhase', phase) : await chain.deploy('MockArkPhase', [], [], deployer);
  // The double's operator, the one account its setters answer.
  phaseContract.operatorAccount = await phaseContract.call('operator');
  const set = await chain.deploy(
    'ArkStakeParams',
    ['address', 'address', PARAMS_TYPE, 'address', PHASE_ROW_TYPE],
    [governance, deployer, params ? withParams(params) : ZERO_PARAMS, phaseContract.address, launchRows],
    deployer,
  );
  set.phase = phaseContract;
  return set;
}

/**
 * A governance vote on the parameter set, as the timelock executes it: a keyed
 * diff of the fields `overrides` changes, each naming the value it replaces
 * (read back through `paramOf`, so a diff builds on one already staged).
 * Returns the transaction; the change is in force from the next epoch. A
 * per-phase cell is named as its key is, `cushionTargetBps@3`.
 */
async function voteParams(paramSet, overrides, { from = ACCOUNTS.admin } = {}) {
  const changes = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in REFERENCE_PARAMS) && !isRowCell(k)) throw new Error(`no parameter ${k}`);
    const key = paramKey(k);
    changes.push([key, await paramSet.call('paramOf', [key]), BigInt(v)]);
  }
  return paramSet.send('setParamsDiff', [changes], { from });
}

/** `voteParams`, then the clock moved to the epoch in which it is in force. */
async function enactParams(chain, paramSet, overrides, opts) {
  const res = await voteParams(paramSet, overrides, opts);
  toNextEpoch({ chain });
  return res;
}

/* ------------------------------------------------------------------ */
/* Stack                                                               */
/* ------------------------------------------------------------------ */

/**
 * One `AssetInput`, defaulted so a test that does not care about admission is
 * not silently fighting it: a 4.0 per cent yield clears the floor of whitepaper
 * §4.5 at every stage and every concentration.
 */
const assetInput = ({
  chainId = CHAIN_ID,
  asset = ASSET_A,
  group = GROUP_A,
  upgradeAuthority = ZERO,
  exitBoundBps = 2500,
  yieldBps = 400,
  rebasing = false,
  transferVerified = true,
  permissionlessYieldPath = true,
} = {}) => [
  chainId,
  asset,
  group,
  upgradeAuthority,
  exitBoundBps,
  yieldBps,
  rebasing,
  transferVerified,
  permissionlessYieldPath,
];

/**
 * Walk the threat ladder to `stage` one step per epoch, as governance would
 * since the stage became the phase's (item 129): phase 2 at the next
 * boundary (stage 2), the band of phase 2 voted to 3 (stage 3), then phase 3
 * (stage 4), each in force from the next epoch, so the walk ends one boundary
 * after the last step and takes as many epochs as the stage votes did. Done
 * right after the parameter set is deployed and before anything else exists,
 * so the rest of the stack is born at the later time and no test sees a
 * clock that moved under it. `from` is governance (the band vote's caller).
 */
async function stepToStage(chain, paramSet, stage, from) {
  const phase = paramSet.phase;
  const next = () => BigInt(chain.timestamp) / BigInt(EPOCH) + 1n;
  for (let s = 1; s < stage; s++) {
    if (s === 1) await phase.send('setPending', [2, next()], { from: phase.operatorAccount });
    else if (s === 2) await paramSet.send('setThreatStage', [2, 3], { from });
    else await phase.send('setPending', [3, next()], { from: phase.operatorAccount });
    toNextEpoch({ chain });
  }
}

/**
 * The stack: parameters, registry, and the doubles for the four contracts the
 * registry reads. `stage` moves the threat ladder there one step at a time, as
 * a vote would; `assets` defaults to two admitted assets in two groups.
 */
async function deployStack({
  bondQrl = 1_000_000n * ONE,
  price = REF_PRICE,
  stage = 1,
  params,
  rows,
  assets = [
    { asset: ASSET_A, group: GROUP_A, upgradeAuthority: ACCOUNTS.mallory },
    { asset: ASSET_B, group: GROUP_B },
  ],
} = {}) {
  const chain = await Chain.create();
  const paramSet = await deployParams(chain, { params, rows });
  await stepToStage(chain, paramSet, stage, ACCOUNTS.admin);
  const registry = await chain.deploy(
    'ArkStakeRegistry',
    ['address', 'address', 'address'],
    [ACCOUNTS.admin, paramSet.address, ACCOUNTS.admin],
  );
  await paramSet.send('setRegistry', [registry.address], { from: ACCOUNTS.admin });

  const attest = await chain.deploy('MockAttestationResealable');
  const qday = await chain.deploy('MockQDayOracle');
  const oracle = await chain.deploy('MockPriceOracle');
  const bond = await chain.deploy('MockBond');

  await oracle.send('set', [price, price, price]);
  await bond.send('set', [bondQrl]);
  await registry.send(
    'setDependencies',
    [attest.address, qday.address, oracle.address, bond.address],
    { from: ACCOUNTS.admin },
  );

  for (const a of assets) {
    await registry.send('admitAsset', [assetInput(a)], { from: ACCOUNTS.admin });
  }

  return { chain, params: paramSet, registry, attest, qday, oracle, bond };
}

/* ------------------------------------------------------------------ */
/* The bond                                                            */
/* ------------------------------------------------------------------ */

/** The admitted terms of whitepaper §6.3, by the ordinal `subscribe` takes. */
const TERM = { QUARTER: 0, YEAR: 1, THREE_YEAR: 2 };
/** The same terms in epochs: 91, 364 and 1,092 days. */
const TERM_EPOCHS = [13n, 52n, 156n];
/** The classes of whitepaper §4.6. An ordinal that appears in event topics: append, never reorder. */
const CLASS = { JUNIOR: 0, SENIOR: 1 };
/** The realised origin yield the book is read at: the 2.20 per cent of the scenario report. */
const BOOK_YIELD_BPS = 220n;

/**
 * The QRL leg with the real bond in place of `MockBond`.
 *
 * Deployment order resolves two cycles. The registry's constructor takes only
 * governance and the parameters, so it exists before the bond and the bond holds
 * it as an immutable. `ArkBondStaking` holds the bond as an immutable and the
 * delegation holds the staking contract as one, so each is deployed after the
 * thing it names and wired back with a one-shot setter.
 *
 * THE LEDGER'S BOND IS THE COUPON ACCOUNT, NOT ArkCatBond. `ArkBondCoupon` is what
 * draws from `ProceedsLedger` and carries its residue, and both of those are the
 * ledger's bond-only calls — so it is the coupon account that the ledger names.
 */
async function deployBondStack({
  price = REF_PRICE,
  stage = 1,
  params,
  rows,
  yieldBps = BOOK_YIELD_BPS,
  assets = [
    { asset: ASSET_A, group: GROUP_A },
    { asset: ASSET_B, group: GROUP_B },
  ],
  swapStandIn = true,
  court: courtKind = 'mock',
  courtOpts = {},
  qday: qdayFactory = null,
} = {}) {
  const chain = await Chain.create();
  const admin = ACCOUNTS.admin;
  // A bond is bought in thousands of QRL and the harness funds each account with
  // one thousand; give the accounts a book's worth.
  for (const who of Object.values(ACCOUNTS)) await chain.fund(who, 10n ** 30n);

  const paramSet = await deployParams(chain, { params, rows, governance: admin, deployer: admin });
  await stepToStage(chain, paramSet, stage, admin);
  const registry = await chain.deploy('ArkStakeRegistry', ['address', 'address', 'address'], [admin, paramSet.address, admin]);
  await paramSet.send('setRegistry', [registry.address], { from: admin });

  const attest = await chain.deploy('MockAttestationResealable');
  // A Q-Day oracle other than the double (contracts/core's, test/core-build.js)
  // is deployed by the caller's factory and read through the double's ABI,
  // whose three views are the ones the registry and the bond call.
  const qday = qdayFactory ? chain.at('MockQDayOracle', await qdayFactory(chain)) : await chain.deploy('MockQDayOracle');
  const oracle = await chain.deploy('MockPriceOracle');
  const ledger = await chain.deploy('ProceedsLedger');

  const coupon = await chain.deploy(
    'ArkBondCoupon',
    ['address', 'address', 'address'],
    [paramSet.address, ledger.address, registry.address],
  );
  const bond = await deployBond(chain, [registry.address, paramSet.address, coupon.address, qday.address, attest.address], admin);

  await coupon.send('setBond', [bond.address], { from: admin });
  await ledger.send('setBond', [coupon.address], { from: admin });
  // The ledger's one depositor is the premium swap. The bond's suite is not a
  // test of the swap (test/PremiumSwap.test.js is), so bob stands in for it
  // and credits proceeds directly; the window rule is the ledger's own.
  if (swapStandIn) await ledger.send('setSwap', [ACCOUNTS.bob], { from: admin });
  await registry.send(
    'setDependencies',
    [attest.address, qday.address, oracle.address, bond.address],
    { from: admin },
  );

  // The court (phase C4): the stand-in states findings for the bond's own
  // suites; `court: 'real'` puts the product's court and its juror pool there.
  let court;
  let courtStack = {};
  if (courtKind === 'real') {
    courtStack = await deployCourt(chain, { bond: bond.address, registry: registry.address, params: paramSet.address, admin, ...courtOpts });
    court = courtStack.court;
  } else {
    court = await chain.deploy('MockDisputeCourt', ['address'], [bond.address]);
  }
  await bond.send('setCourt', [court.address], { from: admin });

  const staking = await chain.deploy('ArkBondStaking', ['address'], [bond.address]);
  await bond.send('setStaking', [staking.address], { from: admin });
  // Bond principal is a depositor in a staking pool; the pool's validators are
  // a double here, whose principal can fall (test/ArkBondDelegation.test.js is
  // where the real delegation is established, test/ArkStakingPool.test.js the pool).
  const pool = await chain.deploy('ArkStakingPool');
  const delegation = await chain.deploy('MockDelegation', ['address'], [pool.address]);
  await pool.send('setDelegation', [delegation.address], { from: admin });
  await staking.send('setVenue', [pool.address], { from: admin });

  await oracle.send('set', [price, price, price]);
  await oracle.send('setYield', [0n, ZERO, yieldBps]);

  for (const a of assets) {
    await registry.send('admitAsset', [assetInput(a)], { from: admin });
  }

  return { chain, params: paramSet, registry, attest, qday, oracle, ledger, coupon, bond, court, staking, pool, delegation, ...courtStack };
}

/**
 * The court's constructor constants (technical reference §3.4). The fixture's
 * `base_orig` is 0.1 of the origin asset, not the reference deployment's 0.01
 * (`DEPOSIT_BASE_ORIG_REFERENCE`): at `REF_PRICE` it is 1,000 QRL exactly,
 * `DEPOSIT_BASE`, the base in QRL every court test before 2026-10-06 was
 * written against (yellow paper §5.1).
 */
const JUROR_MIN_STAKE = 10_000n * ONE;
const DEPOSIT_BASE_ORIG = 10n ** 17n;
const DEPOSIT_BASE_ORIG_REFERENCE = 10n ** 16n;
const DEPOSIT_BASE = (DEPOSIT_BASE_ORIG * REF_PRICE + PRICE_SCALE - 1n) / PRICE_SCALE;
const JUROR_FEE = 100n * ONE;

/**
 * The product's court (phase C4): ARK (the tree's copy of core's ArkToken,
 * its incentive allocation to `admin`), a veARK double, the juror pool and the
 * court, whose findings module it creates. The governor is `governor`, an
 * account standing in for contracts/core's ArkGovernor. The bond is wired to
 * the court by the caller (`setCourt` is one-shot).
 */
async function deployCourt(chain, { bond, registry, params, admin = ACCOUNTS.admin, governor = ACCOUNTS.guardian, minStake = JUROR_MIN_STAKE, depositBaseOrig = DEPOSIT_BASE_ORIG, jurorFee = JUROR_FEE }) {
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
    [admin, '0x' + '91'.repeat(20), '0x' + '92'.repeat(20), '0x' + '93'.repeat(20), '0x' + '94'.repeat(20), '0x' + '95'.repeat(20), chain.timestamp],
  );
  const veark = await chain.deploy('MockVeArk');
  const jurorPool = await chain.deploy('ArkJurorPool', ['address', 'address', 'uint256', 'address'], [ark.address, veark.address, minStake, admin]);
  const court = await chain.deploy(
    'ArkStakeCourt',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint256', 'uint256'],
    [jurorPool.address, bond, registry, params, ark.address, governor, depositBaseOrig, jurorFee],
  );
  await jurorPool.send('setCourt', [court.address], { from: admin });
  const findings = chain.at('ArkCourtFindings', await court.call('FINDINGS'));
  return { ark, veark, jurorPool, court, findings, governor };
}


/**
 * The bond and its settlement module (phase C3): the module first, on the
 * bond's five dependencies, then the bond naming it — the module is too large
 * to sit inside the bond's creation code (EIP-3860), so it is an argument
 * the bond's constructor checks.
 */
async function deployBond(chain, deps, deployer = ACCOUNTS.admin) {
  // Phase C3b: the claimant record and the per-escrow subrogation are a
  // fourth body, named in the settlement module's constructor the way the
  // settlement module is named in the bond's.
  const recovery = await chain.deploy('ArkCatBondRecovery', ['address', 'address', 'address', 'address', 'address'], deps, deployer);
  const settlement = await chain.deploy('ArkCatBondSettlement', ['address', 'address', 'address', 'address', 'address', 'address'], [...deps, recovery.address], deployer);
  return chain.deploy(
    'ArkCatBond',
    ['address', 'address', 'address', 'address', 'address', 'address', 'address'],
    [...deps, deployer, settlement.address],
    deployer,
  );
}

/**
 * A staking reward reaching the holders the way it does on a live leg: the
 * pool's validators pay it into the pool (here the double pushes it), the
 * bond's position is worth that much more, `harvest` asks the pool for the
 * gain, and `claim` passes it to the bond as the staking distribution.
 */
async function stakingDistribution(ctx, amount) {
  // A reward needs a position to accrue to: place a little where the bond has none.
  if ((await ctx.bond.call('placedWithStaking')) === 0n) await ctx.bond.send('placeWithStaking', [ONE]);
  // A deposit joins the pool's distribution at the next epoch (whitepaper
  // §3.4, D16): a position placed in this one has no share of it yet.
  if ((await ctx.pool.call('sharesOf', [ctx.staking.address])) === 0n) toNextEpoch(ctx);
  await ctx.delegation.send('pushDistribution', [], { value: amount });
  const res = await ctx.staking.send('harvest');
  const [ev] = ctx.staking.events(res, 'Harvested');
  await ctx.pool.send('settle', [8n]);
  return ctx.staking.send('claim', [ev.args.requestId]);
}

/** Subscribe, and return the holding id the bond assigned. */
async function subscribe(ctx, { from = ACCOUNTS.alice, term = TERM.YEAR, class_ = CLASS.JUNIOR, value }) {
  const res = await ctx.bond.send('subscribe', [term, class_], { from, value });
  const [ev] = ctx.bond.events(res, 'Subscribed');
  return ev.args.id;
}

/** Move to `plus` seconds past the start of the next epoch. */
function toNextEpoch(ctx, plus = 1) {
  const next = (BigInt(ctx.chain.timestamp) / BigInt(EPOCH) + 1n) * BigInt(EPOCH);
  ctx.chain.advanceTime(Number(next - BigInt(ctx.chain.timestamp)) + plus);
}

/** Move to the first second of `epoch`. */
function toEpoch(ctx, epoch) {
  const at = BigInt(epoch) * BigInt(EPOCH);
  const now = BigInt(ctx.chain.timestamp);
  if (at > now) ctx.chain.advanceTime(Number(at - now));
}

/**
 * When the settlement window of `epoch` closes: the QRL expiry of its swap
 * lots, four days into `epoch + 2` (ArkEpoch.settlementCloses).
 */
const settlementCloses = (epoch) => (BigInt(epoch) + 2n) * BigInt(EPOCH) + 4n * BigInt(DAY);

/**
 * Credit `amount` of proceeds to `epoch` inside its settlement window, then move
 * past the window and distribute it, and every epoch before it still due.
 */
async function deliverAndDistribute(ctx, epoch, amount) {
  toEpoch(ctx, BigInt(epoch) + 1n);
  if (amount > 0n) {
    await ctx.ledger.send('deliver', [epoch], { from: ACCOUNTS.bob, value: amount });
  }
  const closes = settlementCloses(epoch);
  const now = BigInt(ctx.chain.timestamp);
  if (closes > now) ctx.chain.advanceTime(Number(closes - now));
  let res;
  for (let next = BigInt(await ctx.coupon.call('lastDistributed')) + 1n; next <= BigInt(epoch); next++) {
    res = await ctx.coupon.send('distribute', [next]);
  }
  return res;
}

/**
 * Distribute every epoch whose settlement window has closed, and move no
 * clock: what a keeper does, and all a transfer or a payout waits for.
 */
async function distributeDue(ctx) {
  for (;;) {
    const next = BigInt(await ctx.coupon.call('lastDistributed')) + 1n;
    if (BigInt(ctx.chain.timestamp) < settlementCloses(next)) break;
    await ctx.coupon.send('distribute', [next]);
  }
  // A keeper crosses the boundary too, which `distribute` used to do for it.
  await ctx.bond.send('closeEpoch');
}

/** Distribute every epoch still due, up to the one just closed, with no proceeds. */
async function distributeThrough(ctx, epoch) {
  let next = BigInt(await ctx.coupon.call('lastDistributed')) + 1n;
  for (; next <= BigInt(epoch); next++) {
    const closes = settlementCloses(next);
    const now = BigInt(ctx.chain.timestamp);
    if (closes > now) ctx.chain.advanceTime(Number(closes - now));
    await ctx.coupon.send('distribute', [next]);
  }
}

const epochNow = (ctx) => BigInt(ctx.chain.timestamp) / BigInt(EPOCH);

/** Seal a one-leaf root and record the anchor against it. */
async function anchor(ctx, { asset = ASSET_A, depositor = ACCOUNTS.alice, owner = ACCOUNTS.alice, nonce = 0n, notional, escrow = ESCROW }) {
  const epoch = epochNow(ctx);
  const id = stakeAssetId(CHAIN_ID, asset, depositor, owner, nonce);
  const leaf = stakeLeafKey(id, notional, escrow);

  await ctx.attest.send('seal', [epoch, leaf]);
  await ctx.registry.send(
    'recordAnchor',
    [[CHAIN_ID, asset, depositor, owner, nonce, notional, escrow], epoch, []],
    { from: ACCOUNTS.bob },
  );
  return { id, leaf, epoch };
}

/**
 * Ratify a declaration at `at` (now by default), seal the forward root of the
 * epoch before the ratification's as a quiet epoch's — its anchor count leaf
 * alone, of zero — and prove that count on the bond. Since the re-audit of
 * 2026-09-30 (BOND-02) a relayer's count is cumulative; a count of zero is a
 * floor the claimant record always meets, so the suites that do not test the
 * wait itself open at once. The wait is tested with the true cumulative count,
 * which the trigger-2 settlement of a declaration waits for (whitepaper §5.2;
 * audit 2026-09-22, G6; audit 2026-09-29, QL-05, QL-06): a relayer seals one
 * root, with its count, for every closed epoch. A test of the wait itself
 * declares through `ctx.qday` directly.
 */
async function declare(ctx, at = BigInt(ctx.chain.timestamp)) {
  await ctx.qday.send('declare', [at]);
  const prior = BigInt(at) / BigInt(EPOCH) - 1n;
  await ctx.attest.send('seal', [prior, anchorCountLeaf(prior, 0n)]);
  if (ctx.bond) await ctx.chain.at('ArkCatBondRecovery', ctx.bond.address).send('provePriorAnchors', [0n, []]);
}

module.exports = {
  declare,
  ESCROW,
  stepToStage,
  ACCOUNTS,
  DAY,
  EPOCH,
  BPS,
  PRICE_SCALE,
  ONE,
  REF_PRICE,
  GROUP_A,
  GROUP_B,
  ASSET_A,
  ASSET_B,
  CHAIN_ID,
  ZERO,
  STAKE_DOMAIN,
  ALLOCATION_DOMAIN,
  RELEASED_DOMAIN,
  INSURANCE_DOMAIN,
  stakeAssetId,
  stakeLeafKey,
  insuranceLeafKey,
  releasePayload,
  releaseLeaf,
  releasedLeaf,
  allocationLeaf,
  bufferLeaf,
  BUFFER_DOMAIN,
  anchorCountLeaf,
  ANCHOR_COUNT_DOMAIN,
  pairHash,
  PARAM_FIELDS,
  REFERENCE_PARAMS,
  PARAMS_TYPE,
  ZERO_PARAMS,
  withParams,
  paramKey,
  PHASE_ROW_FIELDS,
  PHASE_ROW_TYPE,
  STAGE_OF_PHASE,
  REFERENCE_ROWS,
  FLAT_ROWS,
  ZERO_ROWS,
  isRowCell,
  deployParams,
  voteParams,
  enactParams,
  assetInput,
  deployStack,
  deployBondStack,
  deployBond,
  deployCourt,
  JUROR_MIN_STAKE,
  DEPOSIT_BASE,
  DEPOSIT_BASE_ORIG,
  DEPOSIT_BASE_ORIG_REFERENCE,
  JUROR_FEE,
  epochNow,
  anchor,
  TERM,
  TERM_EPOCHS,
  CLASS,
  BOOK_YIELD_BPS,
  subscribe,
  stakingDistribution,
  toNextEpoch,
  toEpoch,
  settlementCloses,
  deliverAndDistribute,
  distributeDue,
  distributeThrough,
};
