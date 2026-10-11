#!/usr/bin/env node
/**
 * The reference solver, as a service: an always-on market maker for the
 * premium swap of whitepaper §4.7 on a testnet deployment, which has no other.
 *
 *   npm run solver -- --chain hoodi-vps [--asset stETH] [--share 10000] [--once] [--interval 60]
 *   npm run solver -- check  --chain hoodi-vps   # the keys it would sign with, and the separation rule; sends nothing
 *   npm run solver -- status --chain hoodi-vps   # its last status and open lots (never a secret)
 *
 * Each tick (engine/solver.js, SolverService): in the quote window of the
 * offering of the epoch before this one, one lot per asset at the reserve —
 * read after the offering is judged, by a judging quote of one planck where
 * nobody has quoted it yet (OC-SWAP-03); each lot of its own followed to its
 * end — claimed on the origin chain once its premium lock is among the
 * leaves the relay published (D15, never a relayer's state file), refunded
 * when not selected, its bond recovered once claimed, its QRL recovered if it
 * lapsed, and never where the escrow paid it (`isSpent`, OC-SWAP-04).
 *
 * ITS OWN KEYS (2026-09-29). It signs QRL with `SOLVER_MNEMONIC` (or
 * `<CHAIN>_SOLVER_QRL_MNEMONIC`) and the origin chain with
 * `<CHAIN>_SOLVER_PRIVATE_KEY` (or `<CHAIN>_SOLVER_MNEMONIC`). On a shared
 * manifest it refuses to start without them, or where either is the
 * relayer's or a role's account — one account per running process, or the
 * two collide on the nonce, as observed on 2026-09-28 — unless
 * `ALLOW_SHARED_KEYS=1`. Exit status 78 (configuration) for a refusal, which
 * the systemd unit does not restart.
 *
 * Its state is `.relayer/<chain>/solver.json` (secrets of open lots included;
 * the file is the solver's, locked by `solver.lock`), and a status report
 * `.relayer/<chain>/solver-status.json` that `devnet:up` waits on.
 *
 * Settings, each `<CHAIN>_SOLVER_<NAME>` before `SOLVER_<NAME>`:
 * `SHARE_BPS` (10,000: the whole offering, raised to the D4 minimum lot),
 * `PRICE_BPS` above the reserve (0), `MAX_LOT_QRL` (1,000), `QRL_RESERVE`
 * kept back for gas (50), `CLAIM_GAS` one origin claim needs (300,000),
 * `CARRY_AFTER` seconds before it carries its own preimage to QRL (half the
 * reveal budget), `INTERVAL` seconds (60).
 */
const fs = require('fs');
const path = require('path');

const manifestLib = require('../lib/manifest');
const { toHex } = require('../lib/addresses');
const { clockFor, revealBudgetSeconds } = require('../lib/epoch');
const { errorInterface } = require('../engine/errors');
const { replacer } = require('../engine/state');
const { Solver, SolverService, solverKeyNames, solverSetting, relayerQrlAccounts, keySeparation, fmt, envKey } = require('../engine/solver');
const { evmClient, qrlClient, originClient, originAddressOf, iface, qrlBuild, originBuild, ROOT } = require('../../../scripts/lib/chains');
const { profile: buildProfile } = require('../../../scripts/lib/profile');
const qrl = require('../../../scripts/qrl');

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const EX_CONFIG = 78;

class ConfigError extends Error {}

/** The QRL address of a mnemonic in the environment, offline. */
function qrlAddressOf(env, name) {
  if (!env[name]) return null;
  return toHex(qrl.connect({ mnemonicKey: name }).account.address);
}

/**
 * The solver's clients and the verdict of the key-separation rule. Builds
 * clients (no request is made until one is used).
 */
function resolveKeys(chain, m, env) {
  const K = envKey(chain);
  const names = solverKeyNames(env, chain);
  const shared = manifestLib.isShared(m);
  const onQrlOrigin = m.client === 'qrl';
  const solverQrl = names.qrlMnemonic ? qrlAddressOf(env, names.qrlMnemonic) : null;
  // On a manifest whose origin chain is the enclave itself, the QRL account is the origin account.
  const solverOrigin = onQrlOrigin ? solverQrl : originAddressOf(env, m, 'SOLVER');
  const derived = { deployer: qrlAddressOf(env, 'DEPLOYER_MNEMONIC'), sealer: qrlAddressOf(env, 'QRL_SEALER_MNEMONIC') };
  const relayerOrigin = [];
  const own = onQrlOrigin ? derived.deployer : originAddressOf(env, m);
  if (own) relayerOrigin.push({ address: own, label: "the relayer's origin-chain account" });
  if (env[`${K}_RELAYER_ADDRESS`]) relayerOrigin.push({ address: env[`${K}_RELAYER_ADDRESS`], label: "the relayer's origin-chain account" });
  const verdict = keySeparation({
    shared,
    allowShared: env.ALLOW_SHARED_KEYS === '1',
    names,
    chain,
    solver: { qrl: solverQrl, origin: solverOrigin },
    relayer: { qrl: relayerQrlAccounts(env, chain, derived), origin: relayerOrigin },
    declared: { qrl: names.qrlAddress, origin: onQrlOrigin ? null : names.originAddress },
  });
  return { names, shared, solverQrl, solverOrigin, verdict };
}

function settings(env, chain, m) {
  const get = (name, fallback) => solverSetting(env, chain, name, fallback);
  const ONE = 10n ** 18n;
  const clock = clockFor(buildProfile(m.profile).day);
  const blockSeconds = BigInt(m.blockSeconds || 12);
  return {
    shareBps: BigInt(flag('share', get('SHARE_BPS', '10000'))),
    priceBps: BigInt(get('PRICE_BPS', '0')),
    maxLotValue: BigInt(get('MAX_LOT_QRL', '1000')) * ONE,
    qrlReserve: BigInt(get('QRL_RESERVE', '50')) * ONE,
    claimGas: BigInt(get('CLAIM_GAS', '300000')),
    carryAfter: get('CARRY_AFTER', null) === null ? null : BigInt(get('CARRY_AFTER')),
    interval: Number(flag('interval', get('INTERVAL', '60'))),
    // A first scan reaches back two epochs: a lock is published within its offering's lifetime.
    lookbackBlocks: (2n * clock.EPOCH_LENGTH) / blockSeconds,
    scanChunk: BigInt(m.logChunkBlocks || 2000),
  };
}

const escrowForm = (a) => (a.source === 'lido' ? 'ArkStakeEscrowLido' : a.rebasing ? 'ArkStakeEscrowShares' : 'ArkStakeEscrowUnits');

async function build(chain) {
  const m = manifestLib.load(chain);
  if (m.client === 'harness') throw new ConfigError(`${chain} is the in-process harness: the solver runs there inside npm run e2e:local (scenario solver-service)`);
  if (m.profile === 'spec') throw new ConfigError(`${chain} is a spec-profile manifest; the reference solver serves testnet deployments only`);
  const env = qrl.loadEnv();
  const keys = resolveKeys(chain, m, env);
  if (keys.verdict.errors.length) throw new ConfigError(`the reference solver refuses to run on ${chain}:\n  ${keys.verdict.errors.join('\n  ')}`);

  const log = (s) => console.log(s);
  const qrlSide = keys.verdict.fallback.qrl ? qrlClient() : qrlClient({ name: 'qrl-solver', mnemonicKey: keys.names.qrlMnemonic });
  let origin;
  if (m.client === 'qrl') origin = qrlSide;
  else if (keys.verdict.fallback.origin) origin = (await originClient(chain)).client;
  else origin = evmClient(m, { role: 'SOLVER' });
  if (keys.verdict.fallback.qrl || keys.verdict.fallback.origin) log(`solver   ${chain} is not shared: signing from the relayer's accounts where no solver key is set`);
  await origin.chainId();

  const clock = clockFor(buildProfile(m.profile).day);
  const oBuild = originBuild(chain, m.profile);
  const qBuild = qrlBuild(m.profile);
  const errors = errorInterface([qBuild, oBuild]);
  const swapAbi = iface('PremiumSwap', qBuild);
  const relayAbi = iface('ArkEpochRootRelay', oBuild);
  const cfg = settings(env, chain, m);
  const revealBudget = revealBudgetSeconds(m, Number(flag('relayer-interval', '60')));
  const only = flag('asset');
  const assets = m.assets.filter((a) => a.escrow && (!only || a.symbol === only));
  if (!assets.length) throw new ConfigError(`no escrow of ${chain}${only ? ` is ${only}` : ''} to serve`);
  const depFile = path.join(ROOT, 'deployments', `testnet-${chain}.json`);
  const deployment = () => {
    try {
      return JSON.parse(fs.readFileSync(depFile, 'utf8'));
    } catch {
      return null;
    }
  };
  const makeSolver = (a, swap) =>
    new Solver({
      qrl: qrlSide,
      origin,
      swap,
      swapAbi,
      chainId: m.chainId,
      escrow: { asset: toHex(a.address), escrow: toHex(a.escrow), abi: iface(escrowForm(a), oBuild) },
      clock,
      // No reveal inside the time the relayer needs to carry it (D12).
      revealBudget,
      relay: m.addresses.relay,
      relayAbi,
      fromBlock: BigInt(m.deployedFromBlock || 0),
      errors,
      log,
    });
  const service = new SolverService({
    chain,
    qrl: qrlSide,
    origin,
    assets,
    deployment,
    makeSolver,
    clock,
    dir: path.join(ROOT, '.relayer', chain),
    relay: m.addresses.relay,
    relayAbi,
    fromBlock: BigInt(m.deployedFromBlock || 0),
    errors,
    log,
    warn: (s) => console.error(s),
    ...cfg,
  });
  return { m, keys, service, cfg, clock, qrlSide, origin };
}

async function check(chain) {
  const m = manifestLib.load(chain);
  const env = qrl.loadEnv();
  const k = resolveKeys(chain, m, env);
  console.log(`solver   ${chain} (${k.shared ? 'shared' : 'local'} manifest)`);
  console.log(`   QRL key     ${k.names.qrlMnemonic || '(none)'} -> ${k.solverQrl || '-'}${k.names.qrlAddress ? `, declared ${k.names.qrlAddress}` : ''}`);
  console.log(`   origin key  ${k.names.originKey || k.names.originMnemonic || (m.client === 'qrl' ? '(the QRL key)' : '(none)')} -> ${k.solverOrigin || '-'}`);
  if (k.verdict.errors.length) {
    console.error(`REFUSED:\n  ${k.verdict.errors.join('\n  ')}`);
    process.exit(EX_CONFIG);
  }
  console.log(`   ok: ${k.verdict.fallback.qrl || k.verdict.fallback.origin ? "falls back to the relayer's accounts (local manifest)" : 'accounts of its own'}; nothing was sent`);
}

function status(chain) {
  const dir = path.join(ROOT, '.relayer', chain);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  const st = read('solver-status.json');
  const s = read('solver.json');
  const strip = (lot) => {
    const { secret, item, leaf, ...rest } = lot;
    return rest;
  };
  console.log(JSON.stringify({ status: st, pending: s && s.pending ? strip(s.pending) : null, lots: s ? s.lots.map(strip) : [], recent: s ? s.done.slice(-10) : [] }, replacer, 2));
}

async function run(chain) {
  const { service, cfg, clock, qrlSide, origin } = await build(chain);
  service.lock();
  console.log(`solver   ${chain}: QRL ${qrlSide.address}, origin ${origin.address}; share ${cfg.shareBps} bps at reserve+${cfg.priceBps} bps, lot cap ${fmt(cfg.maxLotValue)} QRL, tick ${cfg.interval}s`);
  const once = argv.includes('--once');
  let lastEpoch = null;
  let wasReady = null;
  // A devnet powered off overnight fails every tick the same way: said once, then hourly.
  let failing = null;
  for (;;) {
    try {
      const st = await service.tick();
      if (failing) console.log('solver   ticking again');
      failing = null;
      if (st.ready !== wasReady) {
        console.log(st.ready ? `solver   ready on genesis ${st.qrlGenesis}: PremiumSwap ${st.swap}, ${fmt(st.qrl.balance)} QRL` : `solver   not ready: ${st.reason}`);
        wasReady = st.ready;
      }
      const epoch = clock.epochOf((await qrlSide.head()).timestamp);
      if (st.ready && epoch !== lastEpoch) {
        lastEpoch = epoch;
        console.log(`solver   epoch ${epoch}: ${st.openLots} open lot(s), ${fmt(st.qrl.balance)} QRL${st.origin.balance === null ? '' : `, ${st.origin.balance} wei on the origin chain`}`);
      }
    } catch (e) {
      const at = Date.now();
      if (!failing || failing.message !== e.message || at - failing.at > 3_600_000) {
        console.error(`solver   tick failed: ${e.message}`);
        failing = { message: e.message, at };
      }
      if (once) process.exit(1);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, cfg.interval * 1000));
  }
  service.close();
}

async function main() {
  const chain = flag('chain');
  if (!chain) throw new ConfigError('--chain is required');
  if (command === 'check') return check(chain);
  if (command === 'status') return status(chain);
  if (command !== 'run') throw new ConfigError(`unknown command ${command}: run, check or status`);
  return run(chain);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e.stack || e.message);
  process.exit(e instanceof ConfigError ? EX_CONFIG : 1);
});
