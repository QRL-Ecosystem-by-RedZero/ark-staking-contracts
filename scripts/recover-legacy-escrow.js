#!/usr/bin/env node
/**
 * Recover the stETH stranded in the legacy Hoodi escrow 0x33E3…9c2E (relay
 * 0xA3AB…0e75c) to the deployer, by sealing one epoch root with the legacy
 * relay's one-time seed. docs/review/audit-2026-09-29/audit-r3/STRANDED-RECOVERY.md §4.
 *
 * WHAT IT DOES
 *   1. Pre-flight reads: relay open (not closed/frozen), nextLeaf == 43,
 *      ROOT_AUTHORITY == WotsSigner(HOODI_VPS_LEGACY_OTS_SEED, 11).root, the
 *      position and buffer, the epoch, and a sealing epoch E with
 *      lastEpoch < E and E + 4 <= current (the escrow's RELEASE_EPOCH_DELAY).
 *   2. Builds three leaves under E (e0d742f formats, escrow-unbound):
 *        release   (position → deployer, claimNonce = claimNonceUsed + 1)
 *        loss      (whole buffer → deployer)
 *        loss-fb   (99.5 % of the buffer → deployer; used only if a negative
 *                   rebase makes the full-buffer leaf exceed bufferShares)
 *      the sorted-pair Merkle root, and the relay's rootMessage.
 *   3. WOTS SAFETY: writes a lock under .relayer/recovery/ (gitignored) BEFORE
 *      signing. Once a lock exists, the plan inside it is reused verbatim and a
 *      different message at that relay + index is refused. Never delete the lock
 *      once the signature has left this process (see `exposed` in the lock).
 *   4. Signs rootMessage at leaf 43 with the e0d742f WotsSigner.
 *   5. Runs admitEpochRoot → release → settleLoss → drainQueue (once per 70-min
 *      epoch until the queue is empty), from the account in --sender-env, which
 *      must not be the deployer (the deployer key is the live relayer's gas key).
 *
 * MODES
 *   (default) --dry-run   Nothing is sent to Hoodi. Reads Hoodi, builds and locks
 *                         the plan, then runs the WHOLE sequence on a local Hardhat fork of
 *                         Hoodi (spawned automatically, or --fork-url), advancing
 *                         fork time for the drains.
 *   --broadcast           Sends the transactions to Hoodi from --sender-env.
 *   --resume              Requires the lock; reads on-chain state and continues
 *                         from the first step not yet done. Combine with either.
 *   --watch               With --broadcast: wait for each epoch and drain until
 *                         the queue is empty (otherwise stop and say when).
 *
 * USAGE (from contracts/staking)
 *   node scripts/recover-legacy-escrow.js [--sender-env TESTER_MNEMONIC]
 *   node scripts/recover-legacy-escrow.js --sender-env TESTER_MNEMONIC --broadcast [--watch]
 *   node scripts/recover-legacy-escrow.js --sender-env TESTER_MNEMONIC --resume --broadcast --watch
 *   options: --rpc-env NAME (default HOODI_VPS_LEGACY_RPC_URL, then HOODI_VPS_RPC_URL)
 *            --fork-url http://127.0.0.1:PORT (use a running fork) | --no-fork
 *            --hoodi-call (also eth_call the next step against Hoodi; for admitEpochRoot
 *                          this sends the signature to the RPC node and marks the
 *                          lock exposed, so the plan can no longer change)
 *
 * The leaf builders and signer are the e0d742f files copied verbatim into
 * ./legacy-e0d742f/ (checked against `git show e0d742f:…` at start). The current
 * relayer engine binds the escrow into its leaves and must NOT be used here.
 *
 * Secrets are read from .env by NAME and never printed, logged or written.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const {
  JsonRpcProvider, Contract, Interface, Wallet, HDNodeWallet, Mnemonic,
  getAddress, keccak256, toUtf8Bytes, formatEther, formatUnits, AbiCoder,
} = require('ethers');

const LEGACY = path.join(__dirname, 'legacy-e0d742f');
const { WotsSigner, verify: wotsVerify } = require(path.join(LEGACY, 'wots.js'));
const ids = require(path.join(LEGACY, 'identifiers.js'));
const { buildTree, proofFor, verify: merkleVerify } = require(path.join(LEGACY, 'merkle.js'));

/* ------------------------------------------------------------------ */
/* Fixed target                                                        */
/* ------------------------------------------------------------------ */

const ROOT = path.join(__dirname, '..');
const CHAIN_ID = 560048n;
const RELAY = getAddress('0xA3AB8C3D689E3149D74a2426d1807CFC2BD0e75c');
const ESCROW = getAddress('0x33E36f8ED46EC6Be892759Df1C911842a95f9c2E');
const STETH = getAddress('0x3508A952176b3c15387C97BE809eaffB1982176a');
const DEPLOYER = getAddress('0xed2010b5b89A7D4DD03C0f74454dEb7a0f5711Aa');
const POSITION_ID = '0xaea3271ba364474f2794f34ed2ee4b537a119e6f3183098830a69f9eb0acd5b7';
const EXPECTED_LEAF = 43;
const TREE_HEIGHT = 11;
const EPOCH_LENGTH = 4200n; // testnet profile: 7 × 600 s, as compiled into the legacy bytecode
const RELEASE_EPOCH_DELAY = 4n;
const SEED_ENV = 'HOODI_VPS_LEGACY_OTS_SEED';
const DRAIN_MAX = 8;
const FALLBACK_BPS = 9950n; // loss-fb leaf: 99.5 % of the buffer
const LOCK_DIR = path.join(ROOT, '.relayer', 'recovery');
const LOCK_FILE = path.join(LOCK_DIR, `wots-${CHAIN_ID}-${RELAY.toLowerCase()}-leaf${EXPECTED_LEAF}.json`);
const LEGACY_FILES = ['wots.js', 'identifiers.js', 'merkle.js', 'addresses.js'];
const DET_PRIMARY = keccak256(toUtf8Bytes('ark-recovery:hoodi-vps-legacy:0x33e3:buffer:v1'));
const DET_FALLBACK = keccak256(toUtf8Bytes('ark-recovery:hoodi-vps-legacy:0x33e3:buffer:fallback:v1'));

const RELAY_ABI = new Interface([
  'error AlreadyClosed(uint64 closedEpoch)',
  'error BadAuthPathLength(uint256 expected, uint256 supplied)',
  'error BadProof(uint256 epoch, bytes32 leaf)',
  'error BadRootSignature(uint64 epoch, uint32 leafIndex)',
  'error EpochNotForward(uint64 epoch, uint64 lastEpoch)',
  'error FutureEpochRoot(uint256 epoch, uint256 current)',
  'error LeafSetExhausted(uint32 leafCount)',
  'error NoRootForEpoch(uint256 epoch)',
  'error WrongLeafIndex(uint32 expected, uint32 supplied)',
  'error ZeroRoot()',
  'function ROOT_AUTHORITY() view returns (bytes32)',
  'function TREE_HEIGHT() view returns (uint8)',
  'function LEAF_COUNT() view returns (uint32)',
  'function nextLeaf() view returns (uint32)',
  'function lastEpoch() view returns (uint64)',
  'function closed() view returns (bool)',
  'function frozen() view returns (bool)',
  'function currentEpoch() view returns (uint256)',
  'function acceptedRoot(uint64 epoch) view returns (bytes32)',
  'function rootMessage(uint64 epoch, bytes32 epochRoot) view returns (bytes32)',
  'function admitEpochRoot(uint64 epoch, bytes32 epochRoot, uint32 leafIndex, bytes32[67] otsSig, bytes32[] authPath)',
]);
const ESCROW_ABI = new Interface([
  'error BadProof(uint256 epoch, bytes32 leaf)',
  'error LossExceedsBuffer(uint256 shares, uint256 bufferShares)',
  'error NoRootForEpoch(uint256 epoch)',
  'error ProofSpent(bytes32 spendKey)',
  'error ReleaseClosed()',
  'error ReleaseFrozen()',
  'error UnbondingNotServed(uint256 sealedEpoch, uint256 usableFromEpoch)',
  'error UnknownPosition(bytes32 stakeAssetId)',
  'error WrongClaimNonce(uint64 expected, uint64 supplied)',
  'error ZeroAddress()',
  'error ZeroValue()',
  'event EntryPaid(uint256 indexed queueIndex, bytes32 indexed ref, uint256 indexed epoch, uint8 kind, uint256 units, uint256 shares, uint256 sharesRemaining)',
  'function ASSET() view returns (address)',
  'function RELAY() view returns (address)',
  'function positionOf(bytes32 id) view returns ((uint128 stake, uint64 claimNonceUsed, uint64 anchoredAt))',
  'function claimOf(bytes32 id) view returns (uint256)',
  'function positionShares() view returns (uint256)',
  'function totalStake() view returns (uint256)',
  'function bufferShares() view returns (uint256)',
  'function auctionShares() view returns (uint256)',
  'function queuedShares() view returns (uint256)',
  'function queueHead() view returns (uint256)',
  'function queueTail() view returns (uint256)',
  'function queueBase() view returns (uint256)',
  'function sharesHeld() view returns (uint256)',
  'function releaseBudgetRemaining() view returns (uint256)',
  'function toUnits(uint256 shares) view returns (uint256)',
  'function isSpent(bytes32 key) view returns (bool)',
  'function release(bytes32 id, address recipient, uint64 claimNonce, uint256 epoch, bytes32[] proof)',
  'function settleLoss(bytes32 determinationId, bytes32 stakeAssetId, address destination, uint256 quantity, uint64 epoch, bytes32[] proof)',
  'function drainQueue(uint256 maxEntries) returns (uint256)',
]);
const STETH_ABI = new Interface(['function balanceOf(address) view returns (uint256)']);
const coder = AbiCoder.defaultAbiCoder();

/* ------------------------------------------------------------------ */
/* Arguments, env, redaction                                           */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f, d) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const KNOWN = ['dry-run', 'broadcast', 'resume', 'watch', 'sender-env', 'rpc-env', 'fork-url', 'no-fork', 'hoodi-call', 'help'];
const BROADCAST = has('broadcast');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) fail('.env missing');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const ENV = loadEnv();
// Every value that could be a secret (keys, phrases, seeds, RPC URLs with tokens) is scrubbed from output.
const SECRETS = Object.values(ENV).filter((v) => v && v.length >= 16 && !/^0x[0-9a-fA-F]{40}$/.test(v));
function redact(s) {
  let out = String(s);
  for (const v of SECRETS) out = out.split(v).join('<redacted>');
  return out;
}
function log(...a) { console.log(redact(a.join(' '))); }
function fail(msg) { console.error(redact(`\nREFUSED: ${msg}`)); process.exit(2); }

for (const a of argv) if (a.startsWith('--') && !KNOWN.includes(a.slice(2))) fail(`unknown option ${a}`);
if (has('help')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
if (BROADCAST && has('dry-run')) fail('--broadcast and --dry-run are exclusive');

/** A sender from an env var: a 32-byte hex key, or a phrase at m/44'/60'/0'/0/0 (scripts/lib/chains.js). */
function walletFromEnv(name) {
  const v = ENV[name];
  if (!v) return null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return new Wallet(v.startsWith('0x') ? v : `0x${v}`);
  if (v.trim().split(/\s+/).length >= 12) {
    try { return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(v.trim()), "m/44'/60'/0'/0/0"); } catch { return null; }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ERRORS = new Interface([...RELAY_ABI.fragments, ...ESCROW_ABI.fragments].filter((f) => f.type === 'error')
  .filter((f, i, a) => a.findIndex((g) => g.format() === f.format()) === i));
function revertName(e) {
  const d = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  const data = typeof d === 'string' ? d : (d && typeof d.data === 'string' ? d.data : null);
  if (data && data !== '0x') {
    try { const p = ERRORS.parseError(data); return `${p.name}(${p.args.map(String).join(', ')})`; } catch { return `revert ${data.slice(0, 10)}`; }
  }
  return redact((e?.shortMessage || e?.message || String(e)).slice(0, 200));
}
const eth = (w) => `${formatEther(w)} ETH`;
const st = (w) => `${formatUnits(w, 18)} stETH`;
const epochStart = (e) => BigInt(e) * EPOCH_LENGTH;

function checkLegacyCopies() {
  for (const f of LEGACY_FILES) {
    let want;
    try {
      want = execFileSync('git', ['show', `e0d742f:ecdsa-stakings/relayer/lib/${f}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { log(`  (git unavailable: could not re-check legacy-e0d742f/${f} against e0d742f)`); continue; }
    const have = fs.readFileSync(path.join(LEGACY, f), 'utf8');
    if (have.replace(/\r\n/g, '\n') !== want.replace(/\r\n/g, '\n')) fail(`legacy-e0d742f/${f} differs from e0d742f`);
  }
  log('  legacy-e0d742f/* identical to e0d742f:ecdsa-stakings/relayer/lib/*');
}

async function readState(p) {
  const r = new Contract(RELAY, RELAY_ABI, p);
  const e = new Contract(ESCROW, ESCROW_ABI, p);
  const s = new Contract(STETH, STETH_ABI, p);
  const [nextLeaf, lastEpoch, closed, frozen, currentEpoch, pos, bufferShares, positionShares, totalStake,
    queuedShares, queueHead, queueTail, queueBase, sharesHeld, budget, deployerSt, escrowSt] = await Promise.all([
    r.nextLeaf(), r.lastEpoch(), r.closed(), r.frozen(), r.currentEpoch(), e.positionOf(POSITION_ID),
    e.bufferShares(), e.positionShares(), e.totalStake(), e.queuedShares(), e.queueHead(), e.queueTail(),
    e.queueBase(), e.sharesHeld(), e.releaseBudgetRemaining(), s.balanceOf(DEPLOYER), s.balanceOf(ESCROW),
  ]);
  const [bufferUnits, claim] = await Promise.all([e.toUnits(bufferShares), e.claimOf(POSITION_ID)]);
  return {
    nextLeaf: Number(nextLeaf), lastEpoch, closed, frozen, currentEpoch, stake: pos.stake, claimNonceUsed: pos.claimNonceUsed,
    bufferShares, bufferUnits, positionShares, totalStake, claim, queuedShares, queueHead, queueTail, queueBase,
    sharesHeld, budget, deployerSt, escrowSt,
  };
}

/* ------------------------------------------------------------------ */
/* Plan and lock                                                       */
/* ------------------------------------------------------------------ */

function leavesOf(plan) {
  const release = ids.releaseLeaf(ids.releasePayload({ id: POSITION_ID, recipient: DEPLOYER, claimNonce: plan.claimNonce, chainId: CHAIN_ID }));
  const loss = ids.lossLeaf({ chainId: CHAIN_ID, determinationId: DET_PRIMARY, stakeAssetId: POSITION_ID, destination: DEPLOYER, quantity: BigInt(plan.lossQuantity) });
  const lossFb = ids.lossLeaf({ chainId: CHAIN_ID, determinationId: DET_FALLBACK, stakeAssetId: POSITION_ID, destination: DEPLOYER, quantity: BigInt(plan.lossFallbackQuantity) });
  const tree = buildTree([release, loss, lossFb]);
  const message = ids.rootMessage({ chainId: CHAIN_ID, relay: RELAY, epoch: BigInt(plan.epoch), epochRoot: tree.root });
  return { release, loss, lossFb, tree, root: tree.root, message };
}

function newPlan(s) {
  const current = BigInt(s.currentEpoch);
  const epoch = current - RELEASE_EPOCH_DELAY; // largest E already past the unbonding delay
  if (!(BigInt(s.lastEpoch) < epoch)) fail(`no admissible epoch: lastEpoch ${s.lastEpoch}, current ${current}`);
  const lossQuantity = BigInt(s.bufferUnits); // toSharesUp(floor(B·P/S)) <= B at this rate or any higher one
  return {
    epoch: epoch.toString(),
    claimNonce: (BigInt(s.claimNonceUsed) + 1n).toString(),
    lossQuantity: lossQuantity.toString(),
    lossFallbackQuantity: ((lossQuantity * FALLBACK_BPS) / 10000n).toString(),
  };
}

function readLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
}

function writeLockExclusive(lock) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  // 'wx': fails if another run created it in the meantime.
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2), { flag: 'wx' });
}

function appendLockEvent(what) {
  const lock = readLock();
  lock.events.push({ at: new Date().toISOString(), what });
  if (/exposed|broadcast/.test(what)) lock.exposed = true;
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2));
}

/** The one place a plan becomes a signature. Lock first, then sign, and refuse any other message. */
function lockAndSign(plan, built, signer, mode) {
  const lock = readLock();
  if (lock) {
    if (lock.relay.toLowerCase() !== RELAY.toLowerCase() || lock.leafIndex !== EXPECTED_LEAF || String(lock.chainId) !== String(CHAIN_ID)) {
      fail(`lock ${LOCK_FILE} names another relay/index`);
    }
    if (lock.rootMessage.toLowerCase() !== built.message.toLowerCase()) {
      fail(`a lock already holds a DIFFERENT message for relay ${RELAY} leaf ${EXPECTED_LEAF}; signing a second message would leak the one-time key`);
    }
    log(`  lock present, same message: re-signing is deterministic and reveals nothing new`);
  } else {
    writeLockExclusive({
      version: 1,
      note: 'WOTS one-time key lock. NEVER delete once `exposed` is true: a second message at this leaf leaks the key.',
      chainId: CHAIN_ID.toString(), relay: RELAY, escrow: ESCROW, leafIndex: EXPECTED_LEAF,
      epoch: plan.epoch, epochRoot: built.root, rootMessage: built.message,
      plan: { ...plan, positionId: POSITION_ID, recipient: DEPLOYER, determinationPrimary: DET_PRIMARY, determinationFallback: DET_FALLBACK,
        leaves: { release: built.release, loss: built.loss, lossFallback: built.lossFb } },
      exposed: false,
      events: [{ at: new Date().toISOString(), what: `created (${mode})` }],
    });
    log(`  lock written ${path.relative(ROOT, LOCK_FILE)}`);
  }
  const sig = signer.sign(built.message, EXPECTED_LEAF);
  const auth = signer.authPath(EXPECTED_LEAF);
  if (!wotsVerify(built.message, sig, EXPECTED_LEAF, auth, signer.root)) fail('local WOTS verification failed');
  return { sig, auth };
}

/* ------------------------------------------------------------------ */
/* The step machine (same for fork and Hoodi)                          */
/* ------------------------------------------------------------------ */

async function nextStep(p, plan, built, signed) {
  const r = new Contract(RELAY, RELAY_ABI, p);
  const e = new Contract(ESCROW, ESCROW_ABI, p);
  const E = BigInt(plan.epoch);
  const accepted = await r.acceptedRoot(E);
  if (accepted.toLowerCase() !== built.root.toLowerCase()) {
    if (accepted !== '0x' + '0'.repeat(64)) fail(`epoch ${E} holds a different root ${accepted}`);
    const [nl, le] = [Number(await r.nextLeaf()), await r.lastEpoch()];
    if (nl !== EXPECTED_LEAF) fail(`relay nextLeaf is ${nl}, expected ${EXPECTED_LEAF}; the index was consumed elsewhere — do NOT sign again`);
    if (BigInt(le) >= E) fail(`relay lastEpoch ${le} >= planned epoch ${E}; the plan can no longer be admitted`);
    return { name: 'admitEpochRoot', to: RELAY, data: RELAY_ABI.encodeFunctionData('admitEpochRoot', [E, built.root, EXPECTED_LEAF, signed.sig, signed.auth]) };
  }
  const releaseKey = ids.spendKey(E, built.release);
  if (!(await e.isSpent(releaseKey))) {
    return { name: 'release', to: ESCROW, data: ESCROW_ABI.encodeFunctionData('release', [POSITION_ID, DEPLOYER, BigInt(plan.claimNonce), E, proofFor(built.tree, built.release)]) };
  }
  if (!(await e.isSpent(built.loss)) && !(await e.isSpent(built.lossFb))) {
    const primary = ESCROW_ABI.encodeFunctionData('settleLoss', [DET_PRIMARY, POSITION_ID, DEPLOYER, BigInt(plan.lossQuantity), E, proofFor(built.tree, built.loss)]);
    const fallback = ESCROW_ABI.encodeFunctionData('settleLoss', [DET_FALLBACK, POSITION_ID, DEPLOYER, BigInt(plan.lossFallbackQuantity), E, proofFor(built.tree, built.lossFb)]);
    try { await p.call({ to: ESCROW, data: primary }); return { name: 'settleLoss', to: ESCROW, data: primary }; } catch (err) {
      const why = revertName(err);
      if (!/LossExceedsBuffer/.test(why)) return { name: 'settleLoss', to: ESCROW, data: primary };
      log(`  full-buffer loss leaf would revert (${why}); using the 99.5 % fallback leaf`);
      return { name: 'settleLoss(fallback)', to: ESCROW, data: fallback };
    }
  }
  const [head, tail] = [await e.queueHead(), await e.queueTail()];
  if (head === tail) return { done: true };
  if ((await e.releaseBudgetRemaining()) === 0n) {
    const now = BigInt((await p.getBlock('latest')).timestamp);
    const next = epochStart(now / EPOCH_LENGTH + 1n);
    return { wait: next - now, nextEpochAt: next };
  }
  return { name: 'drainQueue', to: ESCROW, data: ESCROW_ABI.encodeFunctionData('drainQueue', [DRAIN_MAX]) };
}

function paidToDeployer(receipt) {
  let units = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== ESCROW.toLowerCase()) continue;
    try { const ev = ESCROW_ABI.parseLog(l); if (ev && ev.name === 'EntryPaid') units += ev.args.units; } catch { /* other event */ }
  }
  return units;
}

/* ------------------------------------------------------------------ */
/* Fork                                                                */
/* ------------------------------------------------------------------ */

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function spawnFork(rpcUrl, blockNumber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-recover-fork-'));
  // The fork URL reaches the node through the environment only; it is never written to disk.
  fs.writeFileSync(path.join(dir, 'hardhat.config.js'), `module.exports = {
  paths: { root: ${JSON.stringify(dir)}, sources: ${JSON.stringify(path.join(dir, 'none'))}, cache: ${JSON.stringify(path.join(dir, 'cache'))}, artifacts: ${JSON.stringify(path.join(dir, 'artifacts'))} },
  networks: { hardhat: { chainId: 560048, hardfork: 'cancun', blockGasLimit: 16000000, mining: { auto: true },
    forking: { url: process.env.ARK_RECOVER_FORK_URL, blockNumber: ${Number(blockNumber)}, enabled: true } } },
};\n`);
  const port = await freePort();
  const cli = require.resolve('hardhat/internal/cli/cli.js', { paths: [ROOT] });
  // Output to a file, not a pipe: a node orphaned by a dying parent must not block on a dead pipe.
  const logFile = path.join(dir, 'node.log');
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [cli, 'node', '--config', path.join(dir, 'hardhat.config.js'), '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: ROOT, env: { ...process.env, ARK_RECOVER_FORK_URL: rpcUrl, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' }, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const stop = () => { try { child.kill(); } catch { /* gone */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stop(); process.exit(130); });
  log(`  fork node pid ${child.pid} on 127.0.0.1:${port}`);
  const url = `http://127.0.0.1:${port}`;
  const probe = new JsonRpcProvider(url, Number(CHAIN_ID), { staticNetwork: true });
  for (let i = 0; i < 240; i += 1) {
    if (child.exitCode !== null) break;
    try { await probe.send('eth_chainId', []); probe.destroy(); return { url, stop }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  probe.destroy();
  let tail = '';
  try { tail = fs.readFileSync(logFile, 'utf8').slice(-2000); } catch { /* none */ }
  stop();
  throw new Error(`hardhat fork did not start: ${redact(tail)}`);
}

async function assertLocalFork(p, url) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url)) fail(`--fork-url must be a local node (http://127.0.0.1:PORT), got ${url}`);
  const client = await p.send('web3_clientVersion', []);
  if (!/hardhat|anvil|edr/i.test(client)) fail(`${url} is not a Hardhat/Anvil fork (${client})`);
  if (BigInt(await p.send('eth_chainId', [])) !== CHAIN_ID) fail('fork does not answer chain id 560048');
}

async function runOnFork(forkUrl, plan, built, signed, senderAddr) {
  const p = new JsonRpcProvider(forkUrl, Number(CHAIN_ID), { staticNetwork: true, batchMaxCount: 1 });
  await assertLocalFork(p, forkUrl);
  await p.send('hardhat_impersonateAccount', [senderAddr]);
  const bal = BigInt(await p.send('eth_getBalance', [senderAddr, 'latest']));
  if (bal < 10n ** 17n) await p.send('hardhat_setBalance', [senderAddr, '0x' + (10n ** 18n).toString(16)]);
  const before = await readState(p);
  log(`\n== FORK SIMULATION (${forkUrl}, block ${await p.getBlockNumber()}, sender ${senderAddr} impersonated)`);
  log(`  deployer stETH before ${st(before.deployerSt)}   escrow stETH ${st(before.escrowSt)}`);
  const rows = [];
  let totalGas = 0n;
  const drainEpochs = new Set();
  for (let guard = 0; guard < 40; guard += 1) {
    const step = await nextStep(p, plan, built, signed);
    if (step.done) break;
    if (step.wait !== undefined) {
      await p.send('evm_increaseTime', [Number(step.wait) + 30]);
      await p.send('evm_mine', []);
      log(`  … fork clock advanced ${step.wait + 30n}s to epoch ${(step.nextEpochAt + 30n) / EPOCH_LENGTH}`);
      continue;
    }
    const d0 = await new Contract(STETH, STETH_ABI, p).balanceOf(DEPLOYER);
    let hash;
    try {
      const gas = await p.estimateGas({ from: senderAddr, to: step.to, data: step.data });
      hash = await p.send('eth_sendTransaction', [{ from: senderAddr, to: step.to, data: step.data, gas: '0x' + ((gas * 13n) / 10n).toString(16) }]);
    } catch (err) { fail(`fork: ${step.name} reverted: ${revertName(err)}`); }
    const rc = await p.waitForTransaction(hash);
    if (rc.status !== 1) fail(`fork: ${step.name} failed in ${hash}`);
    const blk = await p.getBlock(rc.blockNumber);
    const ep = BigInt(blk.timestamp) / EPOCH_LENGTH;
    const d1 = await new Contract(STETH, STETH_ABI, p).balanceOf(DEPLOYER);
    if (step.name === 'drainQueue') drainEpochs.add(ep.toString());
    totalGas += rc.gasUsed;
    rows.push({ step: step.name, epoch: ep.toString(), gas: rc.gasUsed, paid: paidToDeployer(rc), delta: d1 - d0 });
    log(`  ok  ${step.name.padEnd(20)} epoch ${ep}  gas ${String(rc.gasUsed).padStart(7)}  paid ${st(paidToDeployer(rc))}  deployer Δ ${st(d1 - d0)}`);
  }
  const after = await readState(p);
  const delta = after.deployerSt - before.deployerSt;
  log(`  deployer stETH after  ${st(after.deployerSt)}   Δ ${st(delta)}`);
  log(`  escrow left: stETH ${st(after.escrowSt)}; positionShares ${after.positionShares} bufferShares ${after.bufferShares} queue ${after.queueHead}/${after.queueTail}`);
  log(`  relay nextLeaf ${after.nextLeaf}, lastEpoch ${after.lastEpoch}; total gas ${totalGas}; drain txs ${rows.filter((r) => r.step === 'drainQueue').length} over ${drainEpochs.size} later epoch(s)`);
  p.destroy();
  return { rows, totalGas, delta, before, after, drainEpochs: drainEpochs.size };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function senderReport(p, feePerGas) {
  const need = 1_600_000n * feePerGas * 2n; // ~1.1M gas for the whole run, twice over
  const rows = [];
  const skipped = [];
  for (const name of Object.keys(ENV).filter((k) => /(_PRIVATE_KEY|_MNEMONIC|_KEY)(_|$)/.test(k) && !/SEED/.test(k)).sort()) {
    const w = walletFromEnv(name);
    if (!w) { if (ENV[name]) skipped.push(name); continue; }
    const [bal, nonce, pending] = await Promise.all([p.getBalance(w.address), p.getTransactionCount(w.address, 'latest'), p.getTransactionCount(w.address, 'pending')]);
    rows.push({ name, address: w.address, bal, nonce, pending });
  }
  log(`\n== SENDER CANDIDATES (Hoodi ETH; need ≈ ${eth(need)} at ${formatUnits(feePerGas, 'gwei')} gwei)`);
  for (const r of rows) {
    const tag = r.address === DEPLOYER ? 'REFUSED: deployer / live relayer gas key' : (r.bal >= need ? 'enough' : 'insufficient');
    log(`  ${r.name.padEnd(36)} ${r.address}  ${formatEther(r.bal).padStart(22)} ETH  nonce ${r.nonce}${r.pending !== r.nonce ? ` (pending ${r.pending})` : ''}  ${tag}`);
  }
  if (skipped.length) log(`  not an EVM key (non-BIP-39 phrase, e.g. a QRL wallet, or not a key): ${skipped.join(', ')}`);
  return { rows, need };
}

async function main() {
  const rpcEnv = opt('rpc-env', ENV.HOODI_VPS_LEGACY_RPC_URL ? 'HOODI_VPS_LEGACY_RPC_URL' : 'HOODI_VPS_RPC_URL');
  const rpcUrl = ENV[rpcEnv];
  if (!rpcUrl) fail(`${rpcEnv} is not set in .env`);
  if (!ENV[SEED_ENV]) fail(`${SEED_ENV} is not set in .env`);
  log(`mode: ${BROADCAST ? 'BROADCAST to Hoodi' : 'dry-run (nothing is sent to Hoodi)'}${has('resume') ? ' + resume' : ''}   rpc: ${rpcEnv}`);
  checkLegacyCopies();

  const hoodi = new JsonRpcProvider(rpcUrl, Number(CHAIN_ID), { staticNetwork: true });
  if (BigInt((await hoodi.getNetwork()).chainId) !== CHAIN_ID) fail('RPC is not Hoodi');

  // 1. Pre-flight.
  const r = new Contract(RELAY, RELAY_ABI, hoodi);
  const e = new Contract(ESCROW, ESCROW_ABI, hoodi);
  const [authority, height, leafCount, escRelay, escAsset] = await Promise.all([r.ROOT_AUTHORITY(), r.TREE_HEIGHT(), r.LEAF_COUNT(), e.RELAY(), e.ASSET()]);
  if (getAddress(escRelay) !== RELAY || getAddress(escAsset) !== STETH) fail('escrow does not point at the legacy relay / stETH');
  if (Number(height) !== TREE_HEIGHT) fail(`relay TREE_HEIGHT ${height}, expected ${TREE_HEIGHT}`);
  const s = await readState(hoodi);
  log('\n== PRE-FLIGHT (Hoodi, read-only)');
  log(`  relay ${RELAY}: closed ${s.closed} frozen ${s.frozen} nextLeaf ${s.nextLeaf}/${leafCount} lastEpoch ${s.lastEpoch} currentEpoch ${s.currentEpoch}`);
  log(`  escrow ${ESCROW}: stETH ${st(s.escrowSt)} sharesHeld ${s.sharesHeld}`);
  log(`  position ${POSITION_ID.slice(0, 10)}…: stake ${s.stake} claimNonceUsed ${s.claimNonceUsed} claim ≈ ${st(s.claim)}`);
  log(`  buffer: ${s.bufferShares} shares ≈ ${st(s.bufferUnits)}; queue ${s.queueHead}/${s.queueTail}`);
  log(`  deployer ${DEPLOYER} stETH ${st(s.deployerSt)}`);
  if (s.closed) fail('relay is closed: release is refused');
  if (s.frozen) fail('relay is frozen: release is refused');

  process.stdout.write(`  building the WOTS tree for ${SEED_ENV} (height ${TREE_HEIGHT})… `);
  const t0 = Date.now();
  const signer = new WotsSigner(ENV[SEED_ENV], TREE_HEIGHT);
  const ok = signer.root.toLowerCase() === authority.toLowerCase();
  log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!ok) fail(`${SEED_ENV} does not open ROOT_AUTHORITY ${authority}`);
  log(`  ROOT_AUTHORITY ${authority} == WotsSigner(${SEED_ENV}, ${TREE_HEIGHT}).root  ✔`);

  // 2. Plan: from the lock if one exists, else from state now.
  let lock = readLock();
  if (has('resume') && !lock) fail(`--resume needs the lock ${path.relative(ROOT, LOCK_FILE)}`);
  const plan = lock ? { epoch: lock.plan.epoch, claimNonce: lock.plan.claimNonce, lossQuantity: lock.plan.lossQuantity, lossFallbackQuantity: lock.plan.lossFallbackQuantity } : null;
  const admitted = lock && (await r.acceptedRoot(BigInt(lock.epoch))).toLowerCase() === lock.epochRoot.toLowerCase();
  if (!admitted) {
    if (s.nextLeaf !== EXPECTED_LEAF) fail(`relay nextLeaf is ${s.nextLeaf}, expected ${EXPECTED_LEAF}`);
    if (!s.stake && !lock) fail('position already released');
  }
  const thePlan = plan || newPlan(s);
  const built = leavesOf(thePlan);
  if (lock && built.root.toLowerCase() !== lock.epochRoot.toLowerCase()) fail('lock plan does not rebuild to the locked root (tampered?)');
  const E = BigInt(thePlan.epoch);
  if (!admitted && !(BigInt(s.lastEpoch) < E && E + RELEASE_EPOCH_DELAY <= BigInt(s.currentEpoch))) {
    fail(`epoch ${E} not admissible now (need lastEpoch ${s.lastEpoch} < E and E + 4 <= ${s.currentEpoch})`);
  }
  const onchainMsg = await r.rootMessage(E, built.root);
  if (onchainMsg.toLowerCase() !== built.message.toLowerCase()) fail('relay.rootMessage disagrees with the e0d742f builder');
  for (const [n, l] of [['release', built.release], ['loss', built.loss], ['loss-fb', built.lossFb]]) {
    if (!merkleVerify(proofFor(built.tree, l), built.root, l)) fail(`proof for ${n} does not verify`);
  }
  log('\n== PLAN');
  log(`  epoch E ${E} (lastEpoch ${s.lastEpoch} < E; E + 4 = ${E + 4n} <= current ${s.currentEpoch})`);
  log(`  release  leaf ${built.release}  (position → ${DEPLOYER}, claimNonce ${thePlan.claimNonce})`);
  log(`  loss     leaf ${built.loss}  (${st(BigInt(thePlan.lossQuantity))} → deployer)`);
  log(`  loss-fb  leaf ${built.lossFb}  (${st(BigInt(thePlan.lossFallbackQuantity))} → deployer, only if the full leaf reverts)`);
  log(`  epochRoot ${built.root}`);
  log(`  rootMessage ${built.message} (== relay.rootMessage ✔)`);

  // 5 (report). Sender candidates.
  const fee = await hoodi.getFeeData();
  const feePerGas = fee.maxFeePerGas ?? fee.gasPrice ?? 10n ** 9n;
  const { rows: candidates, need } = await senderReport(hoodi, feePerGas);
  const senderEnv = opt('sender-env');
  let sender = null;
  if (senderEnv) {
    sender = walletFromEnv(senderEnv);
    if (!sender) fail(`${senderEnv} does not hold a private key or mnemonic`);
  } else if (BROADCAST) {
    fail('--broadcast needs --sender-env <VAR>');
  } else {
    const pick = candidates.find((c) => c.address !== DEPLOYER && c.bal >= need);
    if (pick) { sender = { address: pick.address }; log(`  (dry-run: no --sender-env; simulating from ${pick.name})`); }
    else { sender = { address: getAddress('0x000000000000000000000000000000000000dEaD') }; log('  (dry-run: no funded candidate; simulating from 0x…dEaD)'); }
  }
  if (getAddress(sender.address) === DEPLOYER) fail(`--sender-env ${senderEnv} resolves to the deployer ${DEPLOYER}, the live relayer's gas key`);
  log(`  sender: ${senderEnv || '(simulation only)'} ${sender.address}`);

  // 3 + 4. Lock, then sign.
  log('\n== SIGN');
  const signed = lockAndSign(thePlan, built, signer, BROADCAST ? 'broadcast' : 'dry-run');
  log(`  signed rootMessage at leaf ${EXPECTED_LEAF}; verifies to ROOT_AUTHORITY locally ✔`);

  if (!BROADCAST) {
    // Hoodi eth_call of the first pending step (read-only; the signature reaches the RPC node, so the lock is marked exposed).
    if (has('hoodi-call')) {
      const step = await nextStep(hoodi, thePlan, built, signed);
      if (step.to) {
        if (step.name === 'admitEpochRoot') appendLockEvent('exposed: eth_call admitEpochRoot to the Hoodi RPC');
        try {
          await hoodi.call({ from: sender.address, to: step.to, data: step.data });
          const gas = await hoodi.estimateGas({ from: sender.address, to: step.to, data: step.data });
          log(`\n== HOODI eth_call: ${step.name} would succeed now (estimateGas ${gas})`);
        } catch (err) { log(`\n== HOODI eth_call: ${step.name} REVERTS: ${revertName(err)}`); process.exitCode = 1; }
      } else log(`\n== HOODI: next step is ${step.done ? 'none (done)' : `wait ${step.wait}s for the next epoch`}`);
    }
    if (has('no-fork')) { log('\n(--no-fork: fork simulation skipped)'); return; }
    let fork = null;
    let forkUrl = opt('fork-url');
    if (!forkUrl) {
      const head = await hoodi.getBlockNumber();
      log(`\n  spawning a Hardhat fork of Hoodi at block ${head - 2}…`);
      fork = await spawnFork(rpcUrl, head - 2);
      forkUrl = fork.url;
    }
    try {
      const res = await runOnFork(forkUrl, thePlan, built, signed, getAddress(sender.address));
      log(`\n== DRY-RUN RESULT: ${res.rows.length} fork transactions succeeded; deployer +${st(res.delta)}; total gas ${res.totalGas} (≈ ${eth(res.totalGas * feePerGas)} at current fees)`);
    } finally { if (fork) fork.stop(); }
    log(`\nNothing was sent to Hoodi. To broadcast:\n  node scripts/recover-legacy-escrow.js --sender-env ${senderEnv || '<VAR>'} --broadcast --watch`);
    return;
  }

  // 6. Broadcast.
  const w = sender.connect(hoodi);
  const [latestN, pendingN] = [await hoodi.getTransactionCount(w.address, 'latest'), await hoodi.getTransactionCount(w.address, 'pending')];
  if (latestN !== pendingN) fail(`${senderEnv} has ${pendingN - latestN} pending transaction(s); settle them first`);
  const bal = await hoodi.getBalance(w.address);
  if (bal < need / 2n) fail(`${senderEnv} holds ${eth(bal)}; need ≈ ${eth(need / 2n)}`);
  log('\n== BROADCAST');
  for (let guard = 0; guard < 60; guard += 1) {
    const step = await nextStep(hoodi, thePlan, built, signed);
    if (step.done) { log('  queue empty: recovery complete'); break; }
    if (step.wait !== undefined) {
      if (!has('watch')) { log(`  drain budget for this epoch is spent; next epoch starts ${new Date(Number(step.nextEpochAt) * 1000).toISOString()}. Re-run with --resume --broadcast (or add --watch).`); break; }
      const ms = Number(step.wait + 90n) * 1000;
      log(`  waiting ${Math.round(ms / 60000)} min for epoch ${step.nextEpochAt / EPOCH_LENGTH}…`);
      await new Promise((res) => setTimeout(res, ms));
      continue;
    }
    let gas;
    try { gas = await hoodi.estimateGas({ from: w.address, to: step.to, data: step.data }); } catch (err) { fail(`${step.name} would revert on Hoodi: ${revertName(err)}`); }
    if (step.name === 'admitEpochRoot') appendLockEvent('broadcast: admitEpochRoot');
    const tx = await w.sendTransaction({ to: step.to, data: step.data, gasLimit: (gas * 13n) / 10n, chainId: CHAIN_ID });
    log(`  sent ${step.name} ${tx.hash}`);
    if (step.name === 'admitEpochRoot') appendLockEvent(`broadcast: admitEpochRoot tx ${tx.hash}`);
    const rc = await tx.wait(1);
    if (rc.status !== 1) fail(`${step.name} failed in ${tx.hash}`);
    log(`  ok   ${step.name} block ${rc.blockNumber} gas ${rc.gasUsed} paid ${st(paidToDeployer(rc))}`);
  }
  const end = await readState(hoodi);
  log(`  deployer stETH ${st(end.deployerSt)} (was ${st(s.deployerSt)}); escrow ${st(end.escrowSt)}; queue ${end.queueHead}/${end.queueTail}`);
}

main().catch((err) => { console.error(redact(`\nERROR: ${err?.shortMessage || err?.message || err}`)); process.exit(1); });
