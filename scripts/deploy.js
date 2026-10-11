/**
 * Deploys Ark Staking on the private network and exercises both legs end to
 * end with real ML-DSA-87 signed transactions.
 *
 *   npm run deploy
 *
 * The ZVM harness in test/ proves the logic. This proves the deployment: that
 * every contract fits in one transaction under the ML-DSA-87 envelope, that the
 * wiring holds against a real gqrl node, and that the rules which carry the
 * product hold on a live chain — the parameter relations, the admission floor,
 * pricing past complete cover, the hash-based admission of an epoch root, the
 * premium held in the escrow and released only against a swap lock and its
 * preimage,
 * the closure at the declaration, and a coupon drawn from delivered proceeds
 * and from nothing else.
 *
 * WHAT STANDS IN FOR WHAT
 * -----------------------
 * The origin-chain leg is EVM bytecode, and ZVM executes it unmodified, so the
 * escrow and its relay are deployed on this same private chain as a stand-in
 * for the origin chain; `block.chainid` is then this chain's id on both legs,
 * which is what the identifiers commit to. The attestation verifier, the Q-Day
 * oracle, the ecosystem phase (`MockArkPhase`, operated by the deployer; no
 * governance stack runs on the enclave, so there is no core `ArkPhase`), the
 * valuation oracle and the bond are the test doubles of
 * contracts/mocks — the real ones live in the insurance repository or are not
 * written — and the attester quorum's one-time key set is a seed generated here
 * and kept in .env. None of this is a deployment of the product; all of it is
 * a private enclave.
 *
 * WHAT THIS SCRIPT CANNOT CHECK, AND WHY
 * --------------------------------------
 * A live chain has no `advanceTime`, and the relay admits one root per epoch.
 * So the release path (four epochs after sealing), the vesting ramp, the yield
 * review's four-epoch run and the residue carry into the next epoch are left to
 * the harness. One root is admitted here, carrying every leaf this run needs,
 * and every refusal is asserted with `eth_call` against live state rather than
 * by mining a failed transaction.
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Interface, keccak256: ethersKeccak } = require('ethers');
const { connect, artifact, deploy, sendRaw, saveDeployment, ROOT } = require('./qrl');
const { generateDeposits } = require('./lib/deposits');
const { qrlClient, qrlBuild } = require('./lib/chains');
const { deployLarge } = require('./lib/chunked');

const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
const { buildTree, proofFor } = require('../ecdsa-stakings/relayer/lib/merkle');
const { SignerSet, sigsArg } = require('../ecdsa-stakings/relayer/lib/authority');
const { toHex, toQ } = require('../ecdsa-stakings/relayer/lib/addresses');

const EVM_BUILD = path.join(ROOT, 'ecdsa-stakings', 'ethereum', 'build');
const ONE = 10n ** 18n;
const BPS = 10000n;
const EPOCH = 7n * 24n * 3600n;
const PRICE = 10_000n * ONE;
const TREE_HEIGHT = 10;
const GROUP = '0x' + Buffer.from('group:lido-like').toString('hex').padEnd(64, '0');
const DEPOSIT_CONTRACT = 'Q4242424242424242424242424242424242424242';
const VALIDATOR = 40_000n * ONE;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Every custom error of both builds, keyed by signature, for decoding a revert. */
const errors = (() => {
  const frags = new Map();
  for (const dir of [path.join(ROOT, 'build'), EVM_BUILD]) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      for (const item of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).abi) {
        if (item.type === 'error') frags.set(`${item.name}(${item.inputs.map((i) => i.type).join(',')})`, item);
      }
    }
  }
  return new Interface([...frags.values()]);
})();

function revertName(e) {
  const candidates = [e?.data, e?.cause?.data, e?.innerError?.data, e?.error?.data, e?.cause?.cause?.data];
  for (const c of candidates) {
    const data = typeof c === 'string' ? c : c?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        const parsed = errors.parseError(data);
        return parsed.name === 'Error' ? String(parsed.args[0]) : parsed.name;
      } catch {
        /* not one of ours */
      }
    }
  }
  const m = /0x[0-9a-fA-F]{8,}/.exec(String(e?.message || ''));
  if (m) {
    try {
      return errors.parseError(m[0]).name;
    } catch {
      /* fall through */
    }
  }
  return String(e?.message || e);
}

let refusals = 0;
/** Assert a call reverts with the named error, against live state and without mining. */
async function refuses(label, name, call) {
  try {
    await call();
  } catch (e) {
    const got = revertName(e);
    if (!got.includes(name)) throw new Error(`${label}: expected ${name}, got ${got}`);
    refusals += 1;
    console.log(`   refused  ${label.padEnd(58)} ${name}`);
    return;
  }
  throw new Error(`${label}: expected ${name}, and the call succeeded`);
}

const gasLog = {};
function logTx(label, receipt) {
  gasLog[label] = BigInt(receipt.gasUsed);
  console.log(`   ${label.padEnd(30)} block ${String(receipt.blockNumber).padStart(6)}  gas ${receipt.gasUsed}`);
  return receipt;
}

// A seed already in .env is archived before it is replaced (audit 2026-09-29, OL-04).
const { replaceSecrets } = require('./lib/env');
const { auditYieldRateOf } = require('./lib/deploy');

function check(cond, message) {
  if (!cond) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const { web3, account, env } = connect();
  const chainId = BigInt(await web3.qrl.getChainId());
  const me = account.address;
  const send = (contract, method, args, gas, value = 0n) =>
    sendRaw(web3, account, { to: contract.options.address, data: contract.methods[method](...args).encodeABI(), gas, value });
  const call = (contract, method, args = []) => contract.methods[method](...args).call({ from: me });

  console.log(`network  ${env.QRL_RPC_URL}  chainId ${chainId}`);
  console.log(`deployer ${me}\n`);

  // The attester quorum's one-time key set, standing in on this enclave. The
  // seed is the whole authority over every root this relay will admit, so it
  // lives in .env beside the deployer mnemonic and nowhere in the repository.
  // A fresh seed per run, never a reused one: every run deploys a new relay,
  // and one seed behind two relays would sign two different root messages
  // with the same one-time leaf — the key reuse the relay exists to prevent.
  const seed = '0x' + crypto.randomBytes(32).toString('hex');
  const { archive } = replaceSecrets({ RELAY_WOTS_SEED: seed }, 'kurtosis-relay');
  if (archive) console.log(`previous RELAY_WOTS_SEED archived to ${path.relative(ROOT, archive)} (gitignored)`);
  const t0 = Date.now();
  // One signer, one of one (phase 1 of whitepaper §3.7); the threshold itself
  // is exercised offline (shared/test/relay.test.js, npm run e2e:local, two of three).
  const signer = new SignerSet({ seeds: [seed], threshold: 1, treeHeight: TREE_HEIGHT });
  const authority = signer.roots();
  console.log(`one-time key set: 2^${TREE_HEIGHT} leaves, root ${authority[0].slice(0, 18)}…  (${Date.now() - t0} ms)\n`);

  /* -------------------------------------------------------------- deploy */
  console.log('deploying the QRL leg');
  // Both the parameter set (since 2026-09-28) and the bond are larger than one
  // QRL request can carry, so they are assembled on chain by `ChunkedDeployer`
  // from pieces (CLAUDE.md §3.1). The same `deployLarge` runs offline in
  // `npm run e2e:local`, so the path reaching this node has already run.
  const chunked = await deploy(web3, account, 'ChunkedDeployer', []);
  // The launch set, written at construction and nowhere else (design §6.2). The
  // reference values, with the ladder lifted so its FIRST rung is 3,700: every
  // figure of whitepaper §4.5 is evaluated at the stage-4 target of 3,700 bps,
  // a live chain cannot wait out the epochs three stage votes need (one per
  // epoch, each in force from the next), and the arithmetic sees only the
  // target share. The slope (1,850) stays under the first rung (I13) and the
  // ceiling (7,400) above the fourth (I22).
  const paramsAbi = new Interface(artifact('ArkStakeParams').abi);
  const launchNames = paramsAbi.deploy.inputs[2].components.map((c) => c.name);
  const lifted = { threatStage1Bps: 3700, threatStage2Bps: 3800, threatStage3Bps: 3900, threatStage4Bps: 4000 };
  const launch = launchNames.map((n) => (n in lifted ? lifted[n] : 0));
  // A zero first rung is the constructor's sentinel for the reference set, so a
  // partial set cannot be sent: fill every field from the reference values.
  const refSrc = fs.readFileSync(path.join(ROOT, 'contracts', 'ArkStakeParams.hyp'), 'utf8');
  const refBody = refSrc.slice(refSrc.indexOf('function _reference()'));
  const REFERENCE = Object.fromEntries([...refBody.slice(0, refBody.indexOf('});')).matchAll(/(\w+):\s*(\d+)/g)].map(([, k, v]) => [k, Number(v)]));
  for (const n of launchNames) if (!(n in REFERENCE) && !(n in lifted)) throw new Error('no reference value for ' + n);
  launchNames.forEach((n, i) => { if (!(n in lifted)) launch[i] = REFERENCE[n]; });
  // The ecosystem phase (item 129): the threat stage is the phase's, so the
  // parameter set is built on one. The enclave runs no governance stack, so
  // the double stands in, operated by the deployer (recorded below); five
  // zero rows select the reference per-phase rows.
  const phase = await deploy(web3, account, 'MockArkPhase', []);
  const rows = [0, 1, 2, 3, 4].map(() => [0, 0, 0]);
  const paramsHex = await deployLarge(
    qrlClient(),
    'ArkStakeParams',
    [toHex(me), toHex(me), launch, toHex(phase.options.address), rows],
    qrlBuild('spec'),
    { chunked: toHex(chunked.options.address), log: (l) => console.log(l) },
  );
  const params = new web3.qrl.Contract(artifact('ArkStakeParams').abi, toQ(paramsHex));
  const registry = await deploy(web3, account, 'ArkStakeRegistry', [me, params.options.address, me]);
  const ledger = await deploy(web3, account, 'ProceedsLedger', []);
  const attest = await deploy(web3, account, 'MockAttestation', []);
  const qday = await deploy(web3, account, 'MockQDayOracle', []);
  const oracle = await deploy(web3, account, 'MockPriceOracle', []);

  const coupon = await deploy(web3, account, 'ArkBondCoupon', [params.options.address, ledger.options.address, registry.options.address]);
  // Build 2's module (phase C3), on the bond's five dependencies; the bond's constructor checks them.
  const bondDeps = [registry, params, coupon, qday, attest].map((c) => toHex(c.options.address));
  // Phase C3b: the recovery module first, named in the settlement module's constructor.
  const recoveryHex = await deployLarge(qrlClient(), 'ArkCatBondRecovery', bondDeps, qrlBuild('spec'), {
    chunked: toHex(chunked.options.address),
    log: (l) => console.log(l),
  });
  const settlementHex = await deployLarge(qrlClient(), 'ArkCatBondSettlement', [...bondDeps, recoveryHex], qrlBuild('spec'), {
    chunked: toHex(chunked.options.address),
    log: (l) => console.log(l),
  });
  const bondHex = await deployLarge(
    qrlClient(),
    'ArkCatBond',
    [...bondDeps, toHex(me), settlementHex],
    qrlBuild('spec'),
    { chunked: toHex(chunked.options.address), log: (l) => console.log(l) },
  );
  const bond = new web3.qrl.Contract(artifact('ArkCatBond').abi, toQ(bondHex));
  const court = await deploy(web3, account, 'MockDisputeCourt', [bond.options.address]);
  const staking = await deploy(web3, account, 'ArkBondStaking', [bond.options.address]);
  for (const [n, c] of Object.entries({ params, registry, ledger, attest, qday, oracle, chunked, coupon, bond, court, staking })) {
    console.log(`   ${n.padEnd(10)} ${c.options.address}`);
  }
  const bondBytes = (artifact('ArkCatBond').bytecode.length - 2) / 2;
  check(bondBytes > 18000, `the bond is ${bondBytes} bytes; ChunkedDeployer is here because it is above the ceiling`);

  console.log('\ndeploying the origin leg (on this chain, as a stand-in)');
  const asset = await deploy(web3, account, 'MockAsset', [], 3_000_000, EVM_BUILD);
  // No later generation is committed here: the terminal link (whitepaper §3.6).
  const relay = await deploy(web3, account, 'ArkEpochRootRelay', [authority, 1, TREE_HEIGHT, ids.TERMINAL_COMMIT], 4_000_000, EVM_BUILD);
  const opsDest = toQ('0x' + crypto.randomBytes(20).toString('hex'));
  // The enclave of CLAUDE.md §4.2 is the legacy line: 20-byte QRL accounts (D14).
  const escrow = await deploy(
    web3,
    account,
    'ArkStakeEscrowUnits',
    // The last argument is the audit's reference yield per epoch, 1e18 fixed
    // point (EC-08): 2.20% a year, `auditYieldRateOf` of scripts/lib/deploy.js.
    [asset.options.address, relay.options.address, opsDest, (10n * ONE).toString(), '20', auditYieldRateOf({}).toString()],
    6_000_000,
    EVM_BUILD,
  );
  for (const [n, c] of Object.entries({ asset, relay, escrow })) console.log(`   ${n.padEnd(10)} ${c.options.address}`);

  /* -------------------------------------------------------------- wire */
  console.log('\nwiring');
  logTx('params.setRegistry', await send(params, 'setRegistry', [registry.options.address], 150_000));
  logTx(
    'registry.setDependencies',
    await send(registry, 'setDependencies', [attest.options.address, qday.options.address, oracle.options.address, bond.options.address], 250_000),
  );
  // The ledger's bond is the coupon account: it is what draws from the ledger and
  // carries its residue, and both are the ledger's bond-only calls.
  logTx('coupon.setBond', await send(coupon, 'setBond', [bond.options.address], 100_000));
  logTx('ledger.setBond (the coupon account)', await send(ledger, 'setBond', [coupon.options.address], 100_000));
  logTx('bond.setCourt', await send(bond, 'setCourt', [court.options.address], 100_000));
  logTx('bond.setStaking', await send(bond, 'setStaking', [staking.options.address], 100_000));
  logTx('oracle.set', await send(oracle, 'set', [PRICE.toString(), PRICE.toString(), PRICE.toString()], 150_000));
  // The book-wide key the bond reads the realised yield at (whitepaper §4.7).
  logTx('oracle.setYield (book)', await send(oracle, 'setYield', ['0', toQ('0x' + '00'.repeat(20)), '220'], 150_000));
  await refuses('dependencies re-pointed', 'AlreadySet', () =>
    call(registry, 'setDependencies', [attest.options.address, qday.options.address, oracle.options.address, bond.options.address]),
  );
  await refuses('the bond re-pointed at another court', 'AlreadySet', () => call(bond, 'setCourt', [me]));
  await refuses('the bond re-pointed at another staking contract', 'AlreadySet', () => call(bond, 'setStaking', [me]));
  await refuses('the coupon account re-pointed at another bond', 'AlreadySet', () => call(coupon, 'setBond', [me]));

  /* -------------------------------------------------------------- the bond */
  // Leg B (whitepaper §3.4). A live chain has no `advanceTime`, so the cliff, a
  // maturity, the run-off queue and the two-epoch conditional release cannot be
  // reached here; those stay with the harness (test/ArkCatBond.test.js). What this
  // asserts is the wiring and every refusal that needs no clock, against live state.
  console.log('\nthe catastrophe bond (whitepaper §3.4, §4.6, §5.3)');
  const junior = 200_000n * ONE;
  logTx('bond.subscribe 200,000 QRL junior, one year', await send(bond, 'subscribe', ['1', '0'], 900_000, junior));
  check(BigInt(await call(bond, 'outstandingPrincipal')) === junior, 'outstanding principal is not what was subscribed');
  check((await call(bond, 'runoffGateClosed')) === false, 'the run-off gate is closed on a growing book at stage 1');
  check(BigInt(await call(registry, 'premiumCeilingInForceBps')) === 7400n, 'the registry does not read the open gate');
  // The registry now prices cover against the real bond rather than a double.
  check(BigInt(await call(registry, 'bondCapacityInOrigin')) > 0n, 'the registry does not see the bond');

  const sub = (term, cls, value, from = me) => bond.methods.subscribe(term, cls).call({ from, value: value.toString() });
  await refuses('a term outside the admitted set of §6.3', 'TermNotAdmitted', () => sub('3', '0', ONE));
  await refuses('a subscription below the minimum', 'SubscriptionTooSmall', () => sub('1', '0', 1000n));
  // 200,000 junior against 200,000 senior is 5,000 bps, below the 7,000 senior is promised.
  await refuses('senior bought past the junior thickness of §4.6', 'JuniorTooThin', () => sub('1', '1', junior));
  await refuses('a bare transfer to the bond', 'ZeroValue', () => web3.qrl.call({ from: me, to: bond.options.address, value: ONE.toString() }));
  await refuses('a determination opened by anyone but the court', 'OnlyCourt', () => call(bond, 'openDetermination', ['0x' + '01'.repeat(32)]));
  await refuses('a loss reported by anyone but the staking contract', 'OnlyStaking', () => call(bond, 'recordLoss', [ONE.toString()]));
  await refuses('a redemption before maturity (I9)', 'NotMatured', () => call(bond, 'redeem', ['1']));
  await refuses('a holding moved by anyone but its holder', 'NotHolder', () =>
    bond.methods.transferHolding('1', me, '1').call({ from: toQ('0x' + '5a'.repeat(20)) }),
  );
  await refuses('the conditional release on a book that has not measured two low epochs (I10)', 'UtilisationNotLow', () => call(bond, 'conditionalRelease'));

  // Suspensions that are states, set and lifted here so each can be read against
  // live state and nothing is left behind.
  logTx('oracle.set (breaker active)', await send(oracle, 'set', [PRICE.toString(), (PRICE / 2n).toString(), PRICE.toString()], 150_000));
  await refuses('issuance while the circuit breaker of §5.5 is active', 'BreakerActive', () => sub('1', '0', ONE));
  logTx('oracle.set (breaker clear)', await send(oracle, 'set', [PRICE.toString(), PRICE.toString(), PRICE.toString()], 150_000));
  logTx('oracle.setYield (book, 100 bps)', await send(oracle, 'setYield', ['0', toQ('0x' + '00'.repeat(20)), '100'], 150_000));
  await refuses('issuance while the coupon at exact cover is below the floor (§4.7)', 'CouponBelowFloor', () => sub('1', '0', ONE));
  logTx('oracle.setYield (book, 220 bps)', await send(oracle, 'setYield', ['0', toQ('0x' + '00'.repeat(20)), '220'], 150_000));
  const det = '0x' + 'de'.repeat(32);
  logTx('court.open', await send(court, 'open', [det], 200_000));
  await refuses('issuance while a determination is open (§4.7)', 'DeterminationOpen', () => sub('1', '0', ONE));
  logTx('court.close', await send(court, 'close', [det], 200_000));

  // The coupon account and the chunked deployer.
  const nextDue = BigInt(await call(coupon, 'lastDistributed')) + 1n;
  await refuses('a coupon distributed before its reveal window closes', 'NotYetPayable', () => call(coupon, 'distribute', [nextDue.toString()]));
  await refuses('an epoch distributed out of order', 'EpochAlreadyDistributed', () => call(coupon, 'distribute', [(nextDue + 1n).toString()]));
  await refuses('value sent to the coupon account by anyone but the ledger', 'OnlyLedger', () =>
    web3.qrl.call({ from: me, to: coupon.options.address, value: ONE.toString() }),
  );
  const bondHash = ethersKeccak(artifact('ArkCatBond').bytecode);
  await refuses('the bond created a second time from a cleared upload', 'EmptyUpload', () =>
    call(chunked, 'deploy', [bondHash, bondHash, '0x']),
  );

  /* -------------------------------------------------------------- parameters */
  // Governance's side (ArkGovernance-Design.md §6.2 - §6.4): keyed diffs with
  // compare-and-swap, checked on the whole draft, in force from the next epoch;
  // the stage bound to the stage it moves from. Every refusal is an eth_call
  // against live state; the one vote sent is a stage step, whose effect a live
  // chain would have to wait an epoch to see, so what is read back is that it
  // is staged and not yet in force.
  console.log('\nthe parameter set of record (whitepaper §6.3), governed by keyed diffs');
  const key = (name) => ethersKeccak(Buffer.from(name));
  const staged = async (name) => BigInt(await call(params, 'paramOf', [key(name)]));
  const change = async (name, value, expected) => [key(name), String(expected ?? (await staged(name))), String(value)];
  const vote = async (changes) => call(params, 'setParamsDiff', [changes]);
  await refuses('ladder past the settlement horizon (I25)', 'RelationViolated', async () => vote([await change('maturityLadderBps', 1429)]));
  await refuses('a slope ratio above the target share (I13, EC-07)', 'ParameterOutOfRange', async () => vote([await change('premiumSlopeRatioBps', 10001)]));
  await refuses('retention below the reserve ladder, first rung included (I28, EC-03)', 'RelationViolated', async () => vote([await change('unsoldEpochs', 6)]));
  await refuses('release bound above the escrow constant', 'ParameterOutOfRange', async () => vote([await change('releaseBoundBps', 2501)]));
  await refuses('D_0 below the severity floor (relation 8)', 'RelationViolated', async () => vote([await change('trigger2FloorBps', 5999)]));
  await refuses('a run-off bound whose drain outlasts the exposure floor (relation 9)', 'RelationViolated', async () => vote([await change('runoffBoundBps', 1600)]));
  await refuses('a change naming a stale value (compare-and-swap)', 'StaleParameter', async () => vote([await change('juniorThicknessBps', 6500, 6999)]));
  await refuses('a value-transfer key moved past a quarter of its range (D7)', 'ParameterStepTooLarge', async () => vote([await change('indemnityBps', 8749)]));
  await refuses('a flat per-phase key (cells are keyed <field>@<p>, item 129)', 'UnknownParameter', async () => vote([[key('admittedTermsMask'), '0', '7']]));
  await refuses('a diff from anyone but governance', 'OnlyGovernance', async () =>
    params.methods.setParamsDiff([await change('fxWindowDays', 60)]).call({ from: toQ('0x' + '5a'.repeat(20)) }),
  );
  // The stage is the ecosystem phase's (item 129): fixed outside phase 2, a
  // band 2 - 3 inside it. The double moves the phase at once; in phase 2 the
  // band vote is staged for the next boundary, then the phase goes back to 0
  // so the figures below read stage 1's (lifted) target, as before.
  await refuses("a stage vote outside phase 2: the stage is the phase's", 'StageFixedByPhase', () => call(params, 'setThreatStage', [1, 2]));
  logTx('MockArkPhase.setPhase(2)', await send(phase, 'setPhase', [2], 150_000));
  check(BigInt(await call(params, 'threatStage')) === 2n, 'entering phase 2 does not put stage 2 in force');
  await refuses('threat stage skipping a step', 'ThreatStageStep', () => call(params, 'setThreatStage', [2, 4]));
  await refuses('threat stage voted from a stage not in force', 'ThreatStageMismatch', () => call(params, 'setThreatStage', [3, 2]));
  logTx('setThreatStage 2 -> 3 (the band of phase 2)', await send(params, 'setThreatStage', [2, 3], 150_000));
  await refuses('a second step in the same epoch', 'ThreatStageAlreadyStepped', () => call(params, 'setThreatStage', [3, 2]));
  const pendingStage = await call(params, 'pendingThreatStage');
  check(BigInt(pendingStage[0]) === 3n, 'the band vote is not staged');
  check(BigInt(await call(params, 'threatStage')) === 2n, 'the band vote is in force before the epoch boundary');
  logTx('MockArkPhase.setPhase(0)', await send(phase, 'setPhase', [0], 150_000));
  check(BigInt(await call(params, 'threatStage')) === 1n, 'back in phase 0 the stage is not 1');
  const sigmaTarget = BigInt(await call(params, 'sigmaTargetBps'));
  console.log(`   target share in force: ${sigmaTarget} bps (first rung, lifted at construction)`);
  check(sigmaTarget === 3700n, 'the target share in force is not 3,700 bps');

  /* -------------------------------------------------------------- admission */
  console.log('\nasset admission (whitepaper §3.2, §4.5)');
  const floor = BigInt(await call(registry, 'admissionYieldFloorBps'));
  console.log(`   admission yield floor: ${floor} bps`);
  check(floor === 109n, `floor ${floor}, the whitepaper signs 109`);
  const input = (yieldBps) => [chainId.toString(), asset.options.address, GROUP, me, 2500, yieldBps, false, true, true];
  await refuses('an asset one bp below the floor', 'YieldBelowAdmissionFloor', () => call(registry, 'admitAsset', [input(108)]));
  logTx('admitAsset (y_A 2.20%)', await send(registry, 'admitAsset', [input(220)], 500_000));

  /* -------------------------------------------------------------- anchoring */
  console.log('\nanchoring on the origin leg');
  logTx('asset.mint', await send(asset, 'mint', [me, (2_000n * ONE).toString()], 120_000));
  logTx('asset.approve', await send(asset, 'approve', [escrow.options.address, (2_000n * ONE).toString()], 120_000));
  // The beneficiary is a `bytes` parameter since QIP-55: the deployer's
  // account crosses as its raw bytes, `0x` + 128 hex on v3 (`toHex` is
  // width-preserving, so a legacy 20-byte account would cross as 0x+40).
  await refuses('an anchor before the seeding deposit', 'SeedingAbsent', () => call(escrow, 'anchor', [toHex(me), (1_000n * ONE).toString()]));
  logTx('escrow.seed 10', await send(escrow, 'seed', [(10n * ONE).toString()], 250_000));
  // Twenty zero bytes: still NoBeneficiary — the owner words of an all-zero
  // beneficiary are all-zero at either width.
  await refuses('a deposit naming no beneficiary', 'NoBeneficiary', () => call(escrow, 'anchor', ['0x' + '00'.repeat(20), ONE.toString()]));
  const anchorReceipt = logTx('escrow.anchor 1,000', await send(escrow, 'anchor', [toHex(me), (1_000n * ONE).toString()], 400_000));

  const escrowIface = new Interface(artifact('ArkStakeEscrowUnits', EVM_BUILD).abi);
  const anchored = anchorReceipt.logs
    .map((l) => {
      try {
        return escrowIface.parseLog({ topics: l.topics, data: l.data });
      } catch {
        return null;
      }
    })
    .find((ev) => ev && ev.name === 'Anchored');
  check(anchored, 'no Anchored event');
  const id = anchored.args.stakeAssetId;
  const notional = anchored.args.anchoredNotional;
  const depositNonce = anchored.args.depositNonce;
  const anchorEpoch = anchored.args.epoch;
  // The owner is emitted as its two canonical words (no longer indexed).
  const ownerWords = ids.qrlOwnerWords(me);
  check(
    anchored.args.qrlOwnerHi.toLowerCase() === ownerWords.hi && anchored.args.qrlOwnerLo.toLowerCase() === ownerWords.lo,
    'the emitted owner words are not qrlOwnerWords(beneficiary)',
  );
  check(
    id === ids.stakeAssetId({ chainId, asset: asset.options.address, depositor: me, boundQrlOwner: me, depositNonce }),
    'the escrow and the relayer disagree on the identifier',
  );
  console.log(`   position ${id.slice(0, 18)}…  ${notional / ONE} units, epoch ${anchorEpoch}`);

  /* -------------------------------------------------------------- forward path */
  console.log('\nthe forward path: the anchor recorded on QRL (whitepaper §3.5)');
  const stakeLeaf = ids.stakeLeafKey(escrow.options.address, id, notional);
  logTx('attest.seal', await send(attest, 'seal', [anchorEpoch.toString(), stakeLeaf], 120_000));
  const anchorInput = [chainId.toString(), asset.options.address, me, me, depositNonce.toString(), notional.toString(), escrow.options.address];
  await refuses('an insurance-domain leaf as a stake leaf', 'BadProof', async () => {
    const other = ids.insuranceLeafKey(id, notional);
    // (The insurance leaf's own preimage names no escrow; it verifies as nothing here.)
    // Checked against a different epoch's root holding the insurance leaf.
    await send(attest, 'seal', [(anchorEpoch + 1000n).toString(), other], 120_000);
    return call(registry, 'recordAnchor', [anchorInput, (anchorEpoch + 1000n).toString(), []]);
  });
  logTx('registry.recordAnchor', await send(registry, 'recordAnchor', [anchorInput, anchorEpoch.toString(), []], 600_000));
  await refuses('the same anchor recorded twice', 'AnchorExists', () => call(registry, 'recordAnchor', [anchorInput, anchorEpoch.toString(), []]));

  // One group holds the whole book, so the measured share is BPS and the
  // bound of §4.3 reduces the indemnity: 2,466 bps of capital per unit.
  const required = BigInt(await call(registry, 'requiredCapital'));
  const covered = BigInt(await call(registry, 'coveredBps'));
  const premium = BigInt(await call(registry, 'premiumShareBps'));
  const expected = (() => {
    const scaled = sigmaTarget * covered + 1850n * (BPS - covered);
    const ceiling = 7400n * covered;
    return (scaled < ceiling ? scaled : ceiling) / BPS;
  })();
  console.log(`   required ${Number(required / 10n ** 16n) / 100} units, covered ${covered} bps, premium ${premium} bps`);
  check(required === (1_000n * ONE * 2466n) / BPS, `required capital ${required}`);
  check(covered < BPS, 'the book should be past complete cover');
  check(premium === expected, `premium ${premium}, the scarcity curve gives ${expected}`);
  console.log('   utilisation above one is priced, not refused (whitepaper §4.3)');

  /* -------------------------------------------------------------- one root */
  console.log('\nthe return path: one epoch root, admitted under a one-time signature (whitepaper §3.6)');
  const [allocEpoch, allocLeaf] = Object.values(await call(registry, 'currentAllocationLeaf', [escrow.options.address]));
  const alloc = await call(registry, 'allocation');
  // The V3 leaf (gap item 19): the premium as sigmaBps, every other rate under
  // its own name, bound to the one escrow it is for (D10).
  const allocArgs = {
    escrow: escrow.options.address,
    epoch: BigInt(allocEpoch),
    ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, Number(f === 'sigmaBps' ? alloc.premiumBps : alloc[f])])),
  };
  check(ids.allocationLeaf(allocArgs) === allocLeaf, 'the registry and the relayer disagree on the allocation leaf');

  // The origin side of the premium swap: a premium lock as PremiumSwap seals
  // it for a selected lot, and the claim that reveals the secret. The QRL
  // side is test/PremiumSwap.test.js and the atomic-yield-flow scenario.
  const bidderDest = toQ('0x' + crypto.randomBytes(20).toString('hex'));
  const quantity = ONE;
  const secret = '0x' + crypto.randomBytes(32).toString('hex');
  const hashlock = ids.hashlockOf(secret);
  const lotId = '0x' + crypto.randomBytes(32).toString('hex');
  const evmExpiry = (BigInt(allocEpoch) + 3n) * EPOCH;
  const premiumLeaf = ids.premiumLockLeaf({
    chainId,
    escrow: escrow.options.address,
    asset: asset.options.address,
    lotId,
    hashlock,
    recipient: bidderDest,
    shares: quantity,
    evmExpiry,
    epoch: BigInt(allocEpoch),
    bond: 0n,
  });
  const closeLeaf = ids.closeLeaf(chainId, escrow.options.address);
  // The two quantity-bearing messages of whitepaper §3.5: the buffer's part of
  // a trigger-1 determination for this position, and one recovery share, paid
  // after the declaration (§5.4). Both settle through the escrow's exit queue.
  const lossDest = toQ('0x' + crypto.randomBytes(20).toString('hex'));
  const shareDest = toQ('0x' + crypto.randomBytes(20).toString('hex'));
  const loss = { chainId, escrow: escrow.options.address, determinationId: '0x' + crypto.randomBytes(32).toString('hex'), stakeAssetId: id, destination: lossDest, quantity: ONE };
  const share = { chainId, escrow: escrow.options.address, successorId: '0x' + '00'.repeat(32), recoveryId: '0x' + crypto.randomBytes(32).toString('hex'), recipient: '0x' + crypto.randomBytes(32).toString('hex'), destination: shareDest, quantity: 2n * ONE };
  const lossLeaf = ids.lossLeaf(loss);
  const shareLeaf = ids.shareLeaf(share);
  const tree = buildTree([allocLeaf, premiumLeaf, closeLeaf, lossLeaf, shareLeaf]);

  const epoch = BigInt((await web3.qrl.getBlock('latest')).timestamp) / EPOCH;
  check(epoch === BigInt(allocEpoch), 'the epoch turned mid-run; run again');
  const leafIndex = Number(await call(relay, 'nextLeaf'));
  // The message binds the leaf count (audit 2026-09-29, OL-01).
  const leafCount = tree.leaves.length;
  const message = ids.rootMessage({ chainId, relay: relay.options.address, epoch, epochRoot: tree.root, leafCount });
  check(message === (await call(relay, 'rootMessage', [epoch.toString(), tree.root, leafCount])), 'the relay and the relayer disagree on the root message');
  const sig = sigsArg(signer.sign(message, leafIndex));
  const admitArgs = [epoch.toString(), tree.root, leafCount, leafIndex, sig];

  await refuses('a root signed for another leaf index', 'WrongLeafIndex', () =>
    call(relay, 'admitEpochRoot', [epoch.toString(), tree.root, leafCount, leafIndex + 1, sig]),
  );
  const tampered = '0x' + (BigInt(tree.root) ^ 1n).toString(16).padStart(64, '0');
  await refuses('a signature carried onto another root', 'ThresholdNotMet', () =>
    call(relay, 'admitEpochRoot', [epoch.toString(), tampered, leafCount, leafIndex, sig]),
  );
  await refuses('a signature carried onto another leaf count', 'ThresholdNotMet', () =>
    call(relay, 'admitEpochRoot', [epoch.toString(), tree.root, leafCount - 1, leafIndex, sig]),
  );
  await refuses('a root for an epoch not yet begun', 'FutureEpochRoot', () =>
    call(relay, 'admitEpochRoot', [(epoch + 1n).toString(), tree.root, leafCount, leafIndex, sig]),
  );
  logTx('relay.admitEpochRoot', await send(relay, 'admitEpochRoot', admitArgs, 1_500_000));
  // Every leaf of the root on the origin chain (whitepaper §3.6, D15).
  logTx('relay.publishLeaves', await send(relay, 'publishLeaves', [epoch.toString(), tree.leaves], 400_000));
  await refuses('a second root in the same epoch', 'EpochNotForward', () => call(relay, 'admitEpochRoot', admitArgs));
  check(BigInt(await call(relay, 'nextLeaf')) === BigInt(leafIndex + 1), 'the leaf was not consumed');

  /* -------------------------------------------------------------- sweep and premium */
  console.log('\nthe allocation, the sweep and the premium held to be swapped (whitepaper §4.2, §4.7)');
  logTx(
    'escrow.recordEpochAllocation',
    await send(
      escrow,
      'recordEpochAllocation',
      [allocEpoch.toString(), ids.ALLOCATION_FIELDS.map((f) => allocArgs[f]), proofFor(tree, allocLeaf)],
      300_000,
    ),
  );
  logTx('asset.mint 40 (yield)', await send(asset, 'mint', [escrow.options.address, (40n * ONE).toString()], 120_000));
  logTx('escrow.sweep', await send(escrow, 'sweep', [], 400_000));
  const gross = 40n * ONE;
  const premiumUnits = (gross * BigInt(allocArgs.sigmaBps)) / BPS;
  const opsUnits = (gross * BigInt(allocArgs.operationsBps)) / BPS;
  const jurorUnits = (opsUnits * BigInt(allocArgs.jurorFeeShareBps)) / BPS;
  const pot = BigInt(await call(escrow, 'auctionShares'));
  const opsPaid = BigInt(await call(asset, 'balanceOf', [opsDest]));
  console.log(`   premium held ${Number(pot) / 1e18} units, operations paid ${Number(opsPaid) / 1e18} units`);
  check(pot === premiumUnits + jurorUnits, `pot ${pot}, expected ${premiumUnits + jurorUnits}`);
  check(opsPaid === opsUnits - jurorUnits, `operations ${opsPaid}, expected ${opsUnits - jurorUnits}`);

  const lock = (recipient) => [lotId, hashlock, recipient, quantity.toString(), evmExpiry.toString(), allocEpoch.toString(), '0'];
  const premiumArgs = [lock(bidderDest), epoch.toString(), proofFor(tree, premiumLeaf), secret];
  await refuses('a premium lot claimed for a substituted recipient', 'BadProof', () =>
    call(escrow, 'claimPremium', [lock(me), epoch.toString(), proofFor(tree, premiumLeaf), secret]),
  );
  await refuses('a premium lot claimed with a wrong preimage', 'WrongPreimage', () =>
    call(escrow, 'claimPremium', [lock(bidderDest), epoch.toString(), proofFor(tree, premiumLeaf), '0x' + '00'.repeat(32)]),
  );
  logTx('escrow.claimPremium', await send(escrow, 'claimPremium', premiumArgs, 300_000));
  check(BigInt(await call(asset, 'balanceOf', [bidderDest])) === quantity, 'the solver was not paid');
  await refuses('a premium lot claimed twice', 'ProofSpent', () => call(escrow, 'claimPremium', premiumArgs));

  console.log('\nthe buffer pays first under trigger 1, by the loss settlement (whitepaper §5.2)');
  const bufferBefore = BigInt(await call(escrow, 'bufferShares'));
  const lossArgs = [loss.determinationId, id, lossDest, ONE.toString(), epoch.toString(), proofFor(tree, lossLeaf)];
  await refuses('a loss settlement restating its quantity', 'BadProof', () =>
    call(escrow, 'settleLoss', [loss.determinationId, id, lossDest, (1_000n * ONE).toString(), epoch.toString(), proofFor(tree, lossLeaf)]),
  );
  logTx('escrow.settleLoss 1', await send(escrow, 'settleLoss', lossArgs, 800_000));
  check(BigInt(await call(asset, 'balanceOf', [lossDest])) === ONE, 'the loss settlement was not paid');
  check(BigInt(await call(escrow, 'bufferShares')) === bufferBefore - ONE, 'the loss was not drawn from the buffer alone');
  await refuses('a loss settlement paid twice', 'ProofSpent', () => call(escrow, 'settleLoss', lossArgs));

  /* -------------------------------------------------------------- proceeds */
  // Epoch t is credited only during its reveal window, the first day of t + 1,
  // and paid only once that window closes. Nothing is delivered here: the one
  // account that credits proceeds is PremiumSwap, from a solver's QRL, and
  // a deployer paying the coupon from its own balance would show a coupon
  // nobody's premium earned. This asserts the refusals that hold now.
  console.log('\nthe coupon is drawn from delivered proceeds and nothing else (whitepaper §4.7)');
  const nowEpoch = BigInt(await call(ledger, 'currentEpoch'));
  await refuses('a credit to the epoch in progress, whose premium has not been sold', 'CreditWindowShut', () =>
    ledger.methods.deliver(nowEpoch.toString()).call({ from: me, value: ONE.toString() }),
  );
  const creditable = await call(ledger, 'creditableEpoch');
  if (!creditable.open) {
    await refuses('a credit to the last epoch after its window closed', 'CreditWindowShut', () =>
      ledger.methods.deliver((nowEpoch - 1n).toString()).call({ from: me, value: ONE.toString() }),
    );
  }
  // The ledger pays its bond and no one else, and its bond is the coupon account:
  // the deployer is refused before the clock is ever consulted.
  await refuses('a coupon drawn by anyone but the coupon account', 'OnlyBond', () => call(ledger, 'draw', [nowEpoch.toString(), me, ONE.toString()]));
  await refuses('a residue carried by anyone but the coupon account', 'OnlyBond', () => call(ledger, 'carryResidue', [nowEpoch.toString()]));

  /* -------------------------------------------------------------- delegation */
  // Bond principal deployed to QRL staking (whitepaper §3.4), against the
  // enclave's real deposit contract and with deposit data written by qrysm's
  // own tool, naming the delegation contract as the withdrawal address. The
  // beacon chain reads the deposits hours later: npm run delegation:status.
  console.log('\nbond principal delegated to QRL staking, on the real deposit contract (whitepaper §3.4, §6.3)');
  // Exit-eligible one spec epoch after funding, plus the activation epoch (OC-LEGB-04; scripts/lib/deploy.js eligibleEpochsOf).
  const delegation = await deploy(web3, account, 'ArkBondDelegation', [me, me, DEPOSIT_CONTRACT, params.options.address, attest.options.address, 0, 2]);
  console.log(`   delegation ${delegation.options.address}`);
  // `withdrawalCredentials()` returns bytes since QIP-55: on v3 the raw
  // 64-byte address, on the v2 harness build 12 zero bytes + the 20-byte
  // address. Either way it names this contract, and the deposit tool's
  // withdrawal_credentials is compared against it directly below.
  const creds = String(await call(delegation, 'withdrawalCredentials')).toLowerCase();
  const delegationHex = toHex(delegation.options.address).slice(2);
  const expectedCreds = delegationHex.length === 128 ? `0x${delegationHex}` : `0x${'00'.repeat(12)}${delegationHex}`;
  check(creds === expectedCreds, 'the credentials do not name the contract');
  const gen = generateDeposits(ROOT, delegation.options.address, 2, 'delegation');
  const [v1, v2] = gen.records;
  check(`0x${String(v1.withdrawal_credentials).replace(/^0x/i, '').toLowerCase()}` === creds, 'qrysm wrote different credentials');
  console.log(`   qrysm wrote 2 deposits (fork ${v1.fork_version}), keystores under ${path.relative(ROOT, gen.dir)}`);

  const depositIface = new Interface([
    'function get_deposit_count() view returns (bytes)',
    'function get_deposit_root() view returns (bytes32)',
    'event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index)',
  ]);
  const depositRead = async (fn) =>
    depositIface.decodeFunctionResult(fn, await web3.qrl.call({ to: DEPOSIT_CONTRACT, data: depositIface.encodeFunctionData(fn) }))[0];
  const depositCount = async () => {
    const le = Buffer.from((await depositRead('get_deposit_count')).slice(2), 'hex');
    return [...le].reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
  };
  const countBefore = await depositCount();

  // `delegate` deposits only the data governance admitted, and only onto a key
  // the quorum has said has no deposit at the live deposit-contract root. The
  // quorum is the mock here: the statement is sealed at the delegation's
  // deposit-check key — the deposit contract's count (OC-LEGB-02) — against
  // the root read just before, and a deposit in between refuses it.
  const sealCheck = async (v) => {
    const root = await depositRead('get_deposit_root');
    const leaf = await call(delegation, 'depositCheckLeaf', [ethersKeccak(v.pubkey), root]);
    logTx('attest.seal (no prior deposit)', await send(attest, 'seal', [(await call(delegation, 'depositCheckKey')).toString(), leaf], 120_000));
    return root;
  };
  const dargs = (v, root) => [v.pubkey, v.signature, root, []];
  const operatorBond = BigInt(await call(delegation, 'requiredBond'));
  check(operatorBond === 4_000n * ONE, `operator bond ${operatorBond}`);
  // The pre-signed exit names the validator's index, which exists only once
  // the beacon chain has processed the deposit, so admission carries no
  // commitment yet; commitExit records it later. The deposit data root is
  // qrysm's, for 40,000 QRL to the delegation's credentials.
  const noExit = '0x' + '00'.repeat(32);
  const admitV = (v, value) =>
    send(delegation, 'admitValidator', [v.pubkey, v.deposit_data_root, noExit, me], 300_000, value);
  const liveRoot = await depositRead('get_deposit_root');
  await refuses('a validator governance has not admitted', 'ValidatorNotAdmitted', () => call(delegation, 'delegate', dargs(v1, liveRoot)));
  logTx('delegation.fund 399,999 QRL', await send(delegation, 'fund', [], 150_000, 399_999n * ONE));
  await refuses('an operator bond one wei short', 'OperatorBondShort', () =>
    delegation.methods.admitValidator(v1.pubkey, v1.deposit_data_root, noExit, me).call({ from: me, value: (operatorBond - 1n).toString() }),
  );
  logTx('delegation.admitValidator 1 (bond 4,000)', await admitV(v1, operatorBond));
  logTx('delegation.admitValidator 2 (bond 4,000)', await admitV(v2, operatorBond));
  await refuses('a validator past 1,000 bps of principal (39,999.9 QRL)', 'ConcentrationExceeded', () => call(delegation, 'delegate', dargs(v1, liveRoot)));
  logTx('delegation.fund 1 QRL (bound 40,000)', await send(delegation, 'fund', [], 150_000, ONE));

  await refuses('a delegation the quorum has not cleared of a prior deposit', 'BadProof', () => call(delegation, 'delegate', dargs(v1, liveRoot)));
  const root1 = await sealCheck(v1);
  const r1 = logTx('delegation.delegate validator 1', await send(delegation, 'delegate', dargs(v1, root1), 1_500_000));
  await refuses('a second deposit to the same validator', 'AlreadyFunded', () => call(delegation, 'delegate', dargs(v1, root1)));
  await refuses('a check made before the last deposit', 'DepositRootChanged', () => call(delegation, 'delegate', dargs(v2, root1)));
  const other = require('../test/fixtures/zond-deposits.json').theirs[0];
  logTx('delegation.admitValidator (foreign)', await admitV(other, operatorBond));
  const rootOther = await sealCheck(other);
  await refuses('deposit data withdrawing to another address', 'reconstructed DepositData does not match', () =>
    call(delegation, 'delegate', dargs(other, rootOther)),
  );
  logTx('delegation.withdrawAdmission (foreign, never funded)', await send(delegation, 'withdrawAdmission', [ethersKeccak(other.pubkey)], 200_000));
  const root2 = await sealCheck(v2);
  const r2 = logTx('delegation.delegate validator 2', await send(delegation, 'delegate', dargs(v2, root2), 1_500_000));

  const countAfter = await depositCount();
  check(countAfter === countBefore + 2n, `deposit count ${countBefore} -> ${countAfter}`);
  for (const r of [r1, r2]) {
    const ev = r.logs
      .map((l) => {
        try {
          return depositIface.parseLog({ topics: l.topics, data: l.data });
        } catch {
          return null;
        }
      })
      .find(Boolean);
    check(ev && ev.args.withdrawal_credentials.toLowerCase() === creds.toLowerCase(), 'a DepositEvent without our credentials');
  }
  const pkh1 = ethersKeccak(v1.pubkey);
  // The delegation picks the validator: its oldest (OC-LEGB-04).
  const reqRes = logTx('delegation.requestExit (the oldest, validator 1)', await send(delegation, 'requestExit', [], 200_000));
  check(reqRes.logs.length > 0, 'no ExitRequested');
  check((await call(delegation, 'validatorOf', [pkh1])).exitRequestedEpoch.toString() !== '0', 'the oldest validator was not the one asked to exit');
  check(BigInt(await call(delegation, 'exitsPending')) === VALIDATOR, 'the exit asked for is not pending');

  // The reconciliation report: a line for validator 2, sealed for an epoch two
  // back. Its challenge window runs from when this contract first saw the root,
  // so on a live chain the line is refused for a week after `noteRoot`; the
  // harness is where one clears (test/ArkBondDelegation.test.js).
  const pkh2 = ethersKeccak(v2.pubkey);
  const current = BigInt(await call(ledger, 'currentEpoch'));
  const reportEpoch = current - 2n;
  // The Report carries `credentialsHash` — keccak256 of the raw credential
  // bytes — since the 64-byte v3 credential no longer fits a word.
  const line = [reportEpoch.toString(), pkh2, 0, false, 0, ethersKeccak(creds), VALIDATOR.toString(), '0'];
  await refuses('a report whose root this contract has not seen', 'RootNotNoted', () => call(delegation, 'reconcile', [line, []]));
  const reportLeaf = await call(delegation, 'validatorReportLeaf', [line]);
  // In the delegation's own keyspace (D10): a report is no forward fact.
  const reportAt = (await call(delegation, 'reportKey', [reportEpoch.toString()])).toString();
  logTx('attest.seal (report, 2 epochs back)', await send(attest, 'seal', [reportAt, reportLeaf], 120_000));
  logTx('delegation.noteRoot', await send(delegation, 'noteRoot', [reportEpoch.toString()], 150_000));
  await refuses('a root sealed late for a past epoch, inside the window since it was noted', 'ReportNotCleared', () =>
    call(delegation, 'reconcile', [line, []]),
  );
  await refuses('the same root noted twice to push its window', 'RootAlreadyNoted', () => call(delegation, 'noteRoot', [reportEpoch.toString()]));
  await refuses('nothing to distribute before a report shows any', 'NothingToDistribute', () => call(delegation, 'distribute'));
  const depositBalance = BigInt(await web3.qrl.getBalance(DEPOSIT_CONTRACT));
  console.log(`   deposit contract: ${countBefore} -> ${countAfter} deposits, balance ${depositBalance / ONE} QRL`);
  const delegationRecord = {
    address: delegation.options.address,
    withdrawalCredentials: creds,
    keystores: path.relative(ROOT, gen.dir),
    validators: [v1, v2].map((v, i) => ({ pubkey: v.pubkey, depositBlock: Number([r1, r2][i].blockNumber) })),
  };

  /* -------------------------------------------------------------- declaration */
  console.log('\nthe declaration closes both directions (whitepaper §3.5, I15)');
  logTx('qday.declare', await send(qday, 'declare', [Math.floor(Date.now() / 1000)], 100_000));
  await refuses('a release instructed after the declaration', 'ReleaseClosed', () => call(registry, 'instructRelease', [id, me]));
  logTx('relay.close', await send(relay, 'close', [escrow.options.address, epoch.toString(), proofFor(tree, closeLeaf)], 200_000));
  await refuses('an anchor into a closed escrow', 'ReleaseClosed', () => call(escrow, 'anchor', [toHex(me), ONE.toString()]));
  await refuses('a premium lot claimed after closure', 'SettlementClosed', () =>
    call(escrow, 'claimPremium', [lock(bidderDest), epoch.toString(), [], secret]),
  );
  const shareArgs = [share.successorId, share.recoveryId, share.recipient, shareDest, share.quantity.toString(), epoch.toString(), proofFor(tree, shareLeaf)];
  logTx('escrow.releaseShare 2 (after closure)', await send(escrow, 'releaseShare', shareArgs, 800_000));
  check(BigInt(await call(asset, 'balanceOf', [shareDest])) === share.quantity, 'the recovery share was not paid');
  await refuses('a recovery share paid twice', 'ProofSpent', () => call(escrow, 'releaseShare', shareArgs));
  console.log('   the recovered escrow pays out after the declaration, under the per-epoch bound (whitepaper §5.4)');

  /* -------------------------------------------------------------- out */
  const out = saveDeployment('private', {
    network: env.QRL_RPC_URL,
    chainId: Number(chainId),
    deployer: me,
    deployedAt: new Date().toISOString(),
    qrl: {
      ArkStakeParams: params.options.address,
      ArkStakeRegistry: registry.options.address,
      ProceedsLedger: ledger.options.address,
      MockAttestation: attest.options.address,
      MockQDayOracle: qday.options.address,
      MockArkPhase: phase.options.address,
      MockPriceOracle: oracle.options.address,
      ChunkedDeployer: chunked.options.address,
      ArkBondCoupon: coupon.options.address,
      ArkCatBond: bond.options.address,
      ArkBondStaking: staking.options.address,
      MockDisputeCourt: court.options.address,
    },
    originStandIn: {
      MockAsset: asset.options.address,
      ArkEpochRootRelay: relay.options.address,
      ArkStakeEscrowUnits: escrow.options.address,
      rootAuthority: authority,
      treeHeight: TREE_HEIGHT,
      operationsDestination: toHex(opsDest),
    },
    // The ecosystem phase the parameter set reads: the double, operated by the
    // deployer, which moves the phase (hence the threat stage) at once.
    arkPhase: { kind: 'mock', contract: 'MockArkPhase', address: phase.options.address, operator: me, rows: 'reference' },
    position: { stakeAssetId: id, anchoredNotional: notional.toString(), epoch: anchorEpoch.toString() },
    delegation: delegationRecord,
    refusalsAsserted: refusals,
  });

  console.log('\nlive gas (total, including the 21,000 intrinsic cost and calldata)');
  for (const [k, v] of Object.entries(gasLog)) console.log(`   ${k.padEnd(30)} ${v}`);
  console.log(`\n${refusals} refusals asserted against live state`);
  console.log(`saved -> ${out}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
