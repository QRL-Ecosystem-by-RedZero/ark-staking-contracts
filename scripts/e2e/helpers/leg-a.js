/**
 * Shared reads and waits for the Leg A scenarios of the on-chain audit round
 * of 2026-10-03 (docs/review/audit-2026-10-03/LEG-A/REPORT.md): the origin
 * chain's escrow and epoch-root relay.
 *
 * Everything here reads, or waits on the clock. Nothing sends a transaction
 * and nothing signs, so no helper can spend a one-time key or move value.
 */
const fs = require('fs');
const path = require('path');
const { keccak256, toUtf8Bytes } = require('ethers');

const { ScenarioError } = require('../lib');
const { revertName } = require('../../../ecdsa-stakings/relayer/engine/errors');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');
const { parseLogs, iface, qrlBuild } = require('../../lib/chains');

/** EIP-1967's three slots, each keccak256(label) - 1. */
const EIP1967 = Object.fromEntries(
  ['implementation', 'admin', 'beacon'].map((k) => [k, '0x' + (BigInt(keccak256(toUtf8Bytes(`eip1967.proxy.${k}`))) - 1n).toString(16).padStart(64, '0')]),
);

/** Opcodes an escrow or the relay must not contain (the escrow's header: no proxy, no delegatecall, no selfdestruct). */
const FORBIDDEN_OPCODES = { 0xf2: 'CALLCODE', 0xf4: 'DELEGATECALL', 0xff: 'SELFDESTRUCT' };

const MASK160 = (1n << 160n) - 1n;

/** The revert name of `fn`, or null where it succeeds. */
async function outcome(ctx, fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return revertName(ctx.r.errors, e);
  }
}

/** An artifact of the origin build the relayer runs against. */
function originArtifact(ctx, name) {
  const file = path.join(ctx.r.originBuild, `${name}.json`);
  if (!fs.existsSync(file)) throw new ScenarioError(`no artifact ${path.relative(process.cwd(), file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The runtime code against the artifact's `deployedBytecode`, every
 * difference required to sit inside the 32 zero bytes of a PUSH32 the
 * compiler left for an immutable, and the word there required to be one of
 * `expected` (addresses compared on their low 160 bits).
 */
function compareCode(onchain, artifactCode, expected) {
  const c = Buffer.from(String(onchain).replace(/^0x/, ''), 'hex');
  const a = Buffer.from(String(artifactCode).replace(/^0x/, ''), 'hex');
  const res = { codeHash: keccak256('0x' + c.toString('hex')), length: c.length, artifactLength: a.length, masked: [], unexpected: [], outside: [] };
  if (c.length !== a.length || c.length === 0) {
    res.ok = false;
    return res;
  }
  const want = expected.map((x) => BigInt(x));
  const matches = (w) => want.some((x) => x === w || (x <= MASK160 && w <= MASK160 && (x & MASK160) === (w & MASK160)));
  let i = 0;
  while (i < a.length) {
    if (a[i] === c[i]) {
      i += 1;
      continue;
    }
    let at = -1;
    for (let p = Math.max(0, i - 32); p < i; p += 1) {
      if (a[p] === 0x7f && p + 33 <= a.length && a.subarray(p + 1, p + 33).every((b) => b === 0)) {
        at = p;
        break;
      }
    }
    if (at < 0) {
      res.outside.push(i);
      i += 1;
      continue;
    }
    const word = BigInt('0x' + c.subarray(at + 1, at + 33).toString('hex'));
    (matches(word) ? res.masked : res.unexpected).push({ offset: at + 1, word });
    i = at + 33;
  }
  res.ok = res.outside.length === 0 && res.unexpected.length === 0;
  return res;
}

/** The opcodes of runtime code, push data skipped and the trailing CBOR metadata dropped. */
function opcodesOf(hex) {
  const b = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
  let end = b.length;
  if (b.length > 2) {
    const len = b.readUInt16BE(b.length - 2);
    if (len + 2 <= b.length) end = b.length - len - 2;
  }
  const seen = new Set();
  for (let i = 0; i < end; i += 1) {
    const op = b[i];
    seen.add(op);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return seen;
}

function forbiddenIn(hex) {
  const ops = opcodesOf(hex);
  return Object.entries(FORBIDDEN_OPCODES).filter(([op]) => ops.has(Number(op))).map(([, name]) => name);
}

/**
 * One storage word of an origin-chain account, or null where the client
 * offers no way to read it: the harness through its VM, any client that
 * exposes `storageAt` (none of the live ones do yet).
 */
async function readSlot(ctx, address, slot) {
  const o = ctx.origin;
  if (typeof o.storageAt === 'function') return BigInt(await o.storageAt(address, slot));
  if (o.chain && o.chain.vm) {
    const { createAddressFromString, hexToBytes, bytesToHex } = require('@ethereumjs/util');
    const v = await o.chain.vm.stateManager.getStorage(createAddressFromString(toHex(address)), hexToBytes(slot));
    return v && v.length ? BigInt(bytesToHex(v)) : 0n;
  }
  return null;
}

/** Decoded events of `abi` emitted by `address` since `fromBlock`, in chain order, each with its block and log index. */
async function eventsOf(ctx, address, abi, fromBlock, names = null) {
  const head = await ctx.origin.head();
  const chunk = BigInt(ctx.r.manifest.logChunkBlocks || 2000);
  const out = [];
  for (let from = BigInt(fromBlock); from <= head.latest; from += chunk) {
    const to = from + chunk - 1n < head.latest ? from + chunk - 1n : head.latest;
    for (const ev of parseLogs(abi, await ctx.origin.logs(address, from, to))) {
      if (!names || names.includes(ev.name)) out.push(ev);
    }
  }
  return out.sort((x, y) => (BigInt(x.blockNumber) === BigInt(y.blockNumber) ? Number(x.logIndex || 0) - Number(y.logIndex || 0) : BigInt(x.blockNumber) < BigInt(y.blockNumber) ? -1 : 1));
}

/** Whether the deployer's QRL account is `governance()` of a QRL contract: the one case a scenario may vote. */
async function governs(ctx, address, name) {
  if (!address) return false;
  try {
    const g = (await ctx.qrl.call(address, iface(name, qrlBuild(ctx.r.manifest.profile)), 'governance'))[0];
    return toHex(g).toLowerCase() === toHex(ctx.qrl.address).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Bring the origin chain's clock to `ts` without the relayer acting at `ts`
 * itself: ticks (with `tickOpts`) until within one poll of it, then no more.
 * On the harness the clock is moved to exactly `ts`; on a live chain the head
 * is polled, without ticking, until a block at or past `ts` exists, and the
 * timestamp reached is returned (it may overshoot by a block).
 */
async function reach(ctx, ts, { label = `timestamp ${ts}`, tickOpts = { seal: false }, timeoutEpochs = 8 } = {}) {
  const target = BigInt(ts);
  const poll = BigInt(ctx.pollSeconds);
  const now = async () => (await ctx.origin.head()).timestamp;
  if ((await now()) < target - poll) {
    await ctx.waitFor(`within one poll of ${label}`, async () => (await now()) >= target - poll, { tickOpts, timeoutEpochs });
  }
  const head = await now();
  if (ctx.origin.advance) {
    // Through `sleep`, so a feed (the oracle's reporters) keeps its cadence.
    if (head < target) await ctx.sleep(Number(target - head));
    return now();
  }
  const deadline = Date.now() + Number(poll + 120n) * 1000;
  while ((await now()) < target) {
    if (Date.now() > deadline) throw new ScenarioError(`the origin chain did not reach ${label}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  return now();
}

/** A sealed leaf, or null where no admitted root carries one yet. */
function sealedOrNull(ctx, kind, predicate = () => true) {
  try {
    return ctx.sealed(kind, predicate);
  } catch {
    return null;
  }
}

/** The relay's views, read on the origin chain. */
function relayView(ctx) {
  return async (m, args = []) => (await ctx.origin.call(ctx.r.relay, ctx.r.abi.relay, m, args))[0];
}

/** The ratio a loss of `before - after` is of `before`, in bps; zero for an empty `before`. */
const lossBps = (before, after) => (BigInt(before) === 0n ? 0n : ((BigInt(before) - BigInt(after)) * 10_000n) / BigInt(before));

module.exports = { EIP1967, FORBIDDEN_OPCODES, outcome, originArtifact, compareCode, opcodesOf, forbiddenIn, readSlot, eventsOf, governs, reach, sealedOrNull, relayView, lossBps };
