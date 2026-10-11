/**
 * One client shape for both legs, so the relayer and the scenarios are written
 * once and do not know which chain answers them.
 *
 * The one rule this module exists to enforce: **a client is only ever handed
 * to a chain whose id it has checked.** The origin client compares the RPC's
 * chain id with the manifest before it will sign anything, which is the EVM
 * counterpart of `assertPrivate` in scripts/qrl.js — a mistyped RPC URL must
 * not be how a time-compressed escrow reaches a chain holding real value.
 *
 * Every address crossing this interface is `0x`-hex, lowercased (CLAUDE.md
 * §4.2), at its chain's own width: 20 bytes on the origin chain and the
 * harness, 64 bytes on the QRL leg (QIP-55, testnet v3). The Q form exists
 * only at the QRL transport. Every quantity is a BigInt.
 *
 * Since QIP-55 the two legs no longer share a coder: an origin-chain (and
 * harness) word is 32 bytes and ethers encodes it; a QRVM abi slot is the
 * 64-byte machine word and @theqrl/abi (the coder web3 1.0.x itself uses)
 * encodes it. Callers still hand every client the same ethers Interface —
 * on the QRL path it is read only as a carrier of the ABI JSON.
 */
const fs = require('fs');
const path = require('path');
const { HDNodeWallet, Interface, JsonRpcProvider, Mnemonic, Wallet } = require('ethers');
const { Web3 } = require('@theqrl/web3');
const { ConstructorFragment, FormatTypes, FunctionFragment, defaultAbiCoder: qrlAbi } = require('@theqrl/abi');

const qrl = require('../qrl');
const { toHex, toQ } = require('../../ecdsa-stakings/relayer/lib/addresses');
const manifest = require('../../ecdsa-stakings/relayer/lib/manifest');
const { profile: buildProfile } = require('./profile');

const ROOT = path.join(__dirname, '..', '..');

/** Where every Zond genesis puts the beacon deposit contract (CLAUDE.md §4.1). */
const QRL_DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242';

class ChainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChainError';
  }
}

const ifaceCache = new Map();
/** An ethers Interface for a compiled artifact, cached by build directory and name. */
function iface(name, buildDir) {
  const key = `${buildDir}:${name}`;
  if (!ifaceCache.has(key)) ifaceCache.set(key, new Interface(qrl.artifact(name, buildDir).abi));
  return ifaceCache.get(key);
}

/** The QRL leg's artifacts at a build profile; both legs of a deployment share one. */
const qrlBuild = (profileName) => path.join(ROOT, `build${buildProfile(profileName).suffix}`);
const originBuild = (chain, profileName) => path.join(ROOT, 'ecdsa-stakings', chain, `build${buildProfile(profileName).suffix}`);
/** The QRVM (QIP-55, testnet v3) line of the QRL leg's artifacts at a profile (`ARK_QRVM=1`). */
const qrvmBuild = (profileName) => path.join(ROOT, `build-qrvm${buildProfile(profileName).suffix}`);

/**
 * Where a reader of the QRL leg — the relayer — finds `name`'s ABI at a
 * profile (OC-OPS-09): the harness line `build<suffix>/` where it holds the
 * artifact, else the QRVM line `build-qrvm<suffix>/`. A profile built for v3
 * only has no harness line, and the ABI JSON of the two lines is the same;
 * only the bytecode differs, which a reader never runs. Where neither holds it
 * the harness line is returned, so the error names the build to make.
 */
function qrlAbiBuild(profileName, name = 'ArkStakeRegistry', { root = ROOT } = {}) {
  const suffix = buildProfile(profileName).suffix;
  const harness = path.join(root, `build${suffix}`);
  if (fs.existsSync(path.join(harness, `${name}.json`))) return harness;
  const qrvm = path.join(root, `build-qrvm${suffix}`);
  if (fs.existsSync(path.join(qrvm, `${name}.json`))) return qrvm;
  return harness;
}

/**
 * `{ address, topics, data, blockNumber, transactionHash, logIndex }`,
 * addresses hex. `toHex` is width-preserving, so a QRL log keeps all 64 bytes
 * of its emitting address (never squeezed to the 40-hex origin form) while an
 * origin-chain or harness log keeps its 20.
 */
const normaliseLog = (l) => ({
  address: toHex(l.address),
  topics: l.topics.map(String),
  data: String(l.data),
  blockNumber: BigInt(l.blockNumber),
  transactionHash: String(l.transactionHash),
  logIndex: Number(l.logIndex),
});

/* ------------------------------------------------------------------ */
/* QIP-55 ABI: the QRL leg encodes and decodes with 64-byte words      */
/* ------------------------------------------------------------------ */

/**
 * Converts one argument to what the 64-byte coder accepts, guided by the
 * declared parameter type — never by the value's shape, because a dynamic
 * `bytes` value can be exactly 128 hex characters without being an address.
 *
 * A v3 QRL address crosses this interface as `0x`+128 lowercase and the coder
 * wants the Q form back. A 20-byte `0x` value reaching an `address` parameter
 * is passed through for the validator to refuse loudly: on v3 the QRVM
 * address is 64 bytes, so an origin-chain address is carried as bytes32/uint,
 * never as `address`.
 */
function toQrlArg(param, value) {
  if (param.baseType === 'array') return Array.from(value, (v) => toQrlArg(param.arrayChildren, v));
  if (param.baseType === 'tuple') return param.components.map((c, i) => toQrlArg(c, value[i]));
  if (param.type === 'address' && typeof value === 'string' && /^0x[0-9a-fA-F]{128}$/.test(value)) return toQ(value);
  return value;
}

/**
 * Back to the interface's own forms: the coder's BigNumbers become the
 * BigInts every quantity here is, and a Q+128 address becomes the internal
 * `0x`+128 lowercase. The result stays a real array, since callers
 * destructure and index it exactly as they did the ethers Result.
 */
function fromQrlValue(v) {
  if (Array.isArray(v)) {
    // A decoded struct is an array that also carries its field names as keys
    // (`al.premiumBps`); `map` alone keeps only the indices, and every caller
    // that reads a struct by name then sees undefined - the relayer's seal
    // turned that into NaN and failed every tick.
    const out = v.map(fromQrlValue);
    for (const key of Object.keys(v)) if (!/^\d+$/.test(key)) out[key] = fromQrlValue(v[key]);
    return out;
  }
  if (v && typeof v === 'object' && v._isBigNumber) return BigInt(v.toString());
  if (typeof v === 'string' && /^Q[0-9a-fA-F]{128}$/.test(v)) return toHex(v);
  return v;
}

/**
 * The 64-byte-word codec for one ethers Interface. Since QIP-55 a QRVM abi
 * slot is the 64-byte machine word, so ethers — 32-byte words,
 * non-negotiably — cannot produce the QRL leg's calldata; @theqrl/abi@1.0.3
 * is 64-byte-word native. The function selector is unchanged by QIP-55: the
 * first 4 bytes of keccak256 of the canonical signature. Cached per
 * Interface instance, which `iface()` already caches per artifact.
 */
/**
 * A QRVM revert reaches web3 as "Error happened while trying to execute a
 * function inside a smart contract", with no method and no target: live runs
 * failed with nothing else to go on (2026-10-09). Prefix the message with the
 * method, the target and the revert selector; the error object (and its
 * `data` for `revertName`) is kept.
 */
function nameRevert(e, kind, method, to) {
  try {
    const d = [e && e.data, e && e.innerError && e.innerError.data, e && e.cause && e.cause.data].find(Boolean);
    const raw = typeof d === 'string' ? d : d && d.data;
    const sel = typeof raw === 'string' && raw.startsWith('0x') ? raw.slice(0, 10) : 'no data';
    e.message = `${kind} ${method} on ${String(to).slice(0, 12)}… reverted (${sel}): ${e.message}`;
  } catch {
    /* leave it as it came */
  }
  return e;
}

const codecCache = new WeakMap();
function qrlCodec(abi) {
  if (codecCache.has(abi)) return codecCache.get(abi);
  const fns = new Map();
  for (const entry of JSON.parse(abi.formatJson())) {
    if (entry.type !== 'function') continue;
    const frag = FunctionFragment.from(entry);
    const sig = frag.format(FormatTypes.sighash);
    const fn = { frag, selector: String(Web3.utils.sha3(sig)).slice(0, 10) };
    fns.set(frag.name, fn);
    fns.set(sig, fn); // overloads stay reachable by full signature
  }
  const lookup = (method) => {
    const fn = fns.get(method);
    if (!fn) throw new ChainError(`${method} is not a function of this interface`);
    return fn;
  };
  const codec = {
    encode(method, args) {
      const fn = lookup(method);
      return fn.selector + qrlAbi.encode(fn.frag.inputs, args.map((a, i) => toQrlArg(fn.frag.inputs[i], a))).slice(2);
    },
    decode(method, raw) {
      return Array.from(qrlAbi.decode(lookup(method).frag.outputs, raw), fromQrlValue);
    },
  };
  codecCache.set(abi, codec);
  return codec;
}

/**
 * The QIP-55 manual log decode, the counter.js idiom from infra/devnet: since
 * the 512-bit QRVM a log slot is the 64-byte machine word, and web3 1.0.x
 * still filters and decodes logs with 32-byte words, so raw logs are decoded
 * here against a hand-written event table:
 *
 *   { Named: { signature: 'Named(address,uint256)',
 *              topics: [{ name: 'who', type: 'address' }],   // indexed, in order
 *              data:   [{ name: 'amount', type: 'uint256' }] } }
 *
 * ONE ALIGNMENT RULE, verified against counter.js's live-chain decode: a
 * 64-byte slot is filled exactly as a 32-byte ABI slot is, scaled up.
 *   - fixed-size `bytesN` is LEFT-aligned: the value is the first 2N hex
 *     chars and the tail is zero. topic0 proves it — the 32-byte keccak
 *     signature hash occupies chars 2..66 of the 130-char topic
 *     (`slice(0, 66) === sha3(signature)`), zeros behind it.
 *   - numeric values (uint*, bool) are RIGHT-aligned: the whole slot read as
 *     one big-endian integer, which is why counter.js's `BigInt(l.data)`
 *     yields the count directly.
 *   - `address` is neither: it IS the full 64-byte slot, returned Q+128.
 *   - an EVM 20-byte address travelling in a QRL slot (`evmAddress`) has
 *     uint160 semantics, so it is numeric-shaped: the LOW 20 bytes.
 *
 * Scalar fields only — none of this repo's QRL events carries a dynamic or
 * array member. Returns `{ ...log, name, args }` per matched log, unknown
 * logs dropped, the same contract as `parseLogs`.
 */
function decodeQrlLogs(events, logs) {
  const table = Object.entries(events).map(([name, spec]) => ({
    name,
    spec,
    topic0: String(Web3.utils.sha3(spec.signature)),
  }));
  const word = (type, hex) => {
    if (hex.length !== 128) throw new ChainError(`a QIP-55 log slot is 64 bytes, got ${hex.length / 2}`);
    if (type === 'address') return `Q${hex.toLowerCase()}`;
    if (type === 'bytes32') return `0x${hex.slice(0, 64).toLowerCase()}`;
    if (type === 'evmAddress') return `0x${hex.slice(88).toLowerCase()}`;
    if (type === 'bool') return BigInt(`0x${hex}`) !== 0n;
    if (/^uint(\d+)?$/.test(type)) return BigInt(`0x${hex}`);
    throw new ChainError(`decodeQrlLogs does not decode type ${type}`);
  };
  const out = [];
  for (const l of logs) {
    // topic0 match is on the high half only: the hash is 32 bytes, the slot 64.
    const hit = table.find((e) => String(l.topics[0]).slice(0, 66) === e.topic0);
    if (!hit) continue;
    const args = {};
    (hit.spec.topics || []).forEach((f, i) => {
      args[f.name] = word(f.type, String(l.topics[i + 1]).replace(/^0x/, ''));
    });
    const data = String(l.data).replace(/^0x/, '');
    (hit.spec.data || []).forEach((f, i) => {
      args[f.name] = word(f.type, data.slice(i * 128, (i + 1) * 128));
    });
    out.push({ ...l, name: hit.name, args });
  }
  return out;
}

/**
 * An origin-chain 20-byte address, zero-extended to the QRVM's 64-byte
 * `address` slot: `0x` + 88 zeros + the 40 hex. This is THE convention for
 * every EVM address that feeds a Hyperion `address` parameter on the v3 leg —
 * `toQrlArg` then maps the 128-hex form to the Q form the coder wants, where a
 * bare 20-byte value on an `address` parameter is refused. The widening is
 * semantically lossless: the QRVM address has uint semantics, and the
 * two-word owner preimage of a legacy 20-byte account is exactly these bytes
 * (identifiers.js `qrlOwnerWords`). Callers keep it off the harness and EVM
 * paths, whose `address` is still 20 bytes.
 */
function evmToQrl(addr20) {
  const hex = toHex(addr20);
  if (hex.length !== 42) throw new ChainError(`evmToQrl widens a 20-byte origin-chain address to the 64-byte slot; got ${addr20}`);
  return `0x${'0'.repeat(88)}${hex.slice(2)}`;
}

/**
 * Constructor arguments for a QRL (v3) deployment, encoded with the 64-byte
 * words of @theqrl/abi — ethers' `encodeDeploy` is 32-byte-word and cannot
 * produce QIP-55 calldata. The same argument mapping as `qrlCodec.encode`,
 * over the constructor fragment: a v3 QRL address (0x+128) becomes the Q form,
 * everything else passes at its own width.
 */
function qrlEncodeDeploy(abi, args) {
  const entry = JSON.parse(abi.formatJson()).find((e) => e.type === 'constructor');
  if (!entry) {
    if (!args.length) return '0x';
    throw new ChainError('constructor arguments given for an interface that declares no constructor');
  }
  const frag = ConstructorFragment.from(entry);
  return qrlAbi.encode(frag.inputs, args.map((a, i) => toQrlArg(frag.inputs[i], a)));
}

/**
 * The hand-written event tables `decodeQrlLogs` reads the QRL leg's logs
 * against, one per contract, transcribed from the declarations in
 * contracts/interfaces. The field types follow the alignment rule above:
 * `address` is a QRL account (the full slot, returned Q+128) and `evmAddress`
 * an origin-chain 20-byte value carried in a QRL slot (the low 20 bytes,
 * returned 0x+40). A change to an event here without the matching change in
 * the contract — or the reverse — makes topic0 stop matching, so the log is
 * dropped rather than misread.
 */
const QRL_EVENTS = {
  // Build 2 of the bond (phase C3): the return leaves its settlement seals.
  // Emitted at the bond's address (the settlement module runs there by
  // delegatecall); the escrow and the destination are origin-chain accounts.
  ArkCatBond: {
    LossLeafSealed: {
      signature: 'LossLeafSealed(bytes32,bytes32,uint256,address,address,uint256,bytes32)',
      topics: [
        { name: 'determinationId', type: 'bytes32' },
        { name: 'stakeAssetId', type: 'bytes32' },
      ],
      data: [
        { name: 'chainId', type: 'uint256' },
        { name: 'escrow', type: 'evmAddress' },
        { name: 'destination', type: 'evmAddress' },
        { name: 'quantity', type: 'uint256' },
        { name: 'leaf', type: 'bytes32' },
      ],
    },
    RecoveryLeafSealed: {
      signature: 'RecoveryLeafSealed(bytes32,bytes32,uint256,address,bytes32,address,uint256,bytes32)',
      topics: [
        { name: 'recoveryId', type: 'bytes32' },
        { name: 'recipient', type: 'bytes32' },
      ],
      data: [
        { name: 'chainId', type: 'uint256' },
        { name: 'escrow', type: 'evmAddress' },
        { name: 'successorId', type: 'bytes32' },
        { name: 'destination', type: 'evmAddress' },
        { name: 'quantity', type: 'uint256' },
        { name: 'leaf', type: 'bytes32' },
      ],
    },
  },
  ArkStakeRegistry: {
    ReleaseInstructed: {
      signature: 'ReleaseInstructed(bytes32,address,uint64,bytes32,uint64,uint256)',
      topics: [
        { name: 'stakeAssetId', type: 'bytes32' },
        // The destination of a release is an account on the ORIGIN chain.
        { name: 'recipient', type: 'evmAddress' },
      ],
      data: [
        { name: 'claimNonce', type: 'uint64' },
        { name: 'releaseLeaf', type: 'bytes32' },
        { name: 'releasableAt', type: 'uint64' },
        { name: 'notional', type: 'uint256' },
      ],
    },
    AssetDelisted: {
      signature: 'AssetDelisted(bytes32,uint8)',
      topics: [{ name: 'assetKey', type: 'bytes32' }],
      data: [{ name: 'reason', type: 'uint8' }],
    },
  },
  PremiumSwap: {
    // An offering on record, whoever carried it (audit 2026-09-29, QL-16).
    OfferRecorded: {
      signature: 'OfferRecorded(uint256,address,uint256,uint256,uint256)',
      topics: [
        { name: 'chainId', type: 'uint256' },
        { name: 'asset', type: 'evmAddress' },
        { name: 'epoch', type: 'uint256' },
      ],
      data: [
        { name: 'shares', type: 'uint256' },
        { name: 'units', type: 'uint256' },
      ],
    },
    LotQuoted: {
      signature: 'LotQuoted(bytes32,bytes32,uint256,bytes32,address,address,uint256,uint256,uint256)',
      topics: [
        { name: 'lotId', type: 'bytes32' },
        { name: 'key', type: 'bytes32' },
        { name: 'epoch', type: 'uint256' },
      ],
      data: [
        { name: 'hashlock', type: 'bytes32' },
        // The solver is the swap's msg.sender: a QRL account.
        { name: 'solver', type: 'address' },
        // Where the escrow pays: an origin-chain account.
        { name: 'recipient', type: 'evmAddress' },
        { name: 'shares', type: 'uint256' },
        { name: 'value', type: 'uint256' },
        // The commitment bond posted beside the lot (I33).
        { name: 'bond', type: 'uint256' },
      ],
    },
    LotSelected: {
      signature: 'LotSelected(bytes32,uint256,address,bytes32,address,uint256,uint64,bytes32,uint256,uint256)',
      topics: [
        { name: 'lotId', type: 'bytes32' },
        { name: 'chainId', type: 'uint256' },
        // The escrowed asset lives on the origin chain.
        { name: 'asset', type: 'evmAddress' },
      ],
      data: [
        { name: 'hashlock', type: 'bytes32' },
        { name: 'recipient', type: 'evmAddress' },
        { name: 'shares', type: 'uint256' },
        { name: 'evmExpiry', type: 'uint64' },
        { name: 'premiumLockLeaf', type: 'bytes32' },
        // The offered epoch and the commitment bond the V3 lock leaf binds.
        { name: 'epoch', type: 'uint256' },
        { name: 'bond', type: 'uint256' },
      ],
    },
    OfferingSelected: {
      signature: 'OfferingSelected(bytes32,uint256,uint256,uint256,uint256,uint256)',
      topics: [
        { name: 'key', type: 'bytes32' },
        { name: 'epoch', type: 'uint256' },
      ],
      data: [
        { name: 'available', type: 'uint256' },
        { name: 'sold', type: 'uint256' },
        { name: 'failedOfferings', type: 'uint256' },
        { name: 'retained', type: 'uint256' },
      ],
    },
    LotClaimed: {
      signature: 'LotClaimed(bytes32,bytes32,address)',
      topics: [{ name: 'lotId', type: 'bytes32' }],
      data: [
        { name: 'secret', type: 'bytes32' },
        { name: 'caller', type: 'address' },
      ],
    },
    LotRefunded: {
      signature: 'LotRefunded(bytes32,uint256,uint256)',
      topics: [{ name: 'lotId', type: 'bytes32' }],
      data: [
        { name: 'value', type: 'uint256' },
        { name: 'bond', type: 'uint256' },
      ],
    },
    // Suspended pricing (yellow paper §4.6, OC-ORC-04; item 123): a quote
    // refused and recorded, and the offering it touched carried at its
    // judgement with no failure counted.
    QuoteRefused: {
      signature: 'QuoteRefused(bytes32,uint256,address)',
      topics: [
        { name: 'key', type: 'bytes32' },
        { name: 'epoch', type: 'uint256' },
      ],
      data: [{ name: 'solver', type: 'address' }],
    },
    OfferingSuspended: {
      signature: 'OfferingSuspended(bytes32,uint256,uint256)',
      topics: [
        { name: 'key', type: 'bytes32' },
        { name: 'epoch', type: 'uint256' },
      ],
      data: [{ name: 'shares', type: 'uint256' }],
    },
  },
  // The validators the delegation funded, which the relayer's report sealer
  // reports (OC-LEGB-06).
  ArkBondDelegation: {
    Delegated: {
      signature: 'Delegated(bytes32,uint256,bytes32,uint256)',
      topics: [{ name: 'pubkeyHash', type: 'bytes32' }],
      data: [
        { name: 'amount', type: 'uint256' },
        { name: 'depositRoot', type: 'bytes32' },
        { name: 'delegated', type: 'uint256' },
      ],
    },
  },
  ArkBondStaking: {
    Requested: {
      signature: 'Requested(uint256,uint8,uint256)',
      topics: [{ name: 'requestId', type: 'uint256' }],
      data: [
        { name: 'kind', type: 'uint8' },
        { name: 'amount', type: 'uint256' },
      ],
    },
  },
  ChunkedDeployer: {
    Deployed: {
      signature: 'Deployed(address,bytes32,address,bytes32)',
      topics: [
        { name: 'uploader', type: 'address' },
        { name: 'uploadId', type: 'bytes32' },
      ],
      data: [
        { name: 'deployed', type: 'address' },
        { name: 'codeHash', type: 'bytes32' },
      ],
    },
  },
};

/* ------------------------------------------------------------------ */
/* QRL transport: the enclave, for the QRL leg and the rehearsal origin */
/* ------------------------------------------------------------------ */

function qrlClient({ name = 'qrl', confirmations = 2, mnemonicKey, extendedSeed } = {}) {
  const { web3, account, env } = qrl.connect({ ...(mnemonicKey ? { mnemonicKey } : {}), ...(extendedSeed ? { extendedSeed } : {}) });
  // Q+128 on v3; toHex is width-preserving, so all 64 bytes are kept.
  const me = toHex(account.address);

  const client = {
    name,
    kind: 'qrl',
    env,
    address: me,
    /** The .env key this client signs from; e2e actors are derived from it. */
    signerKey: extendedSeed ? null : mnemonicKey || 'DEPLOYER_MNEMONIC',
    async chainId() {
      return BigInt(await web3.qrl.getChainId());
    },
    async call(to, abi, method, args = [], { value = 0n, from = me } = {}) {
      const codec = qrlCodec(abi);
      let raw;
      try {
        raw = await web3.qrl.call({ to: toQ(to), from: toQ(from), data: codec.encode(method, args), value: value.toString() });
      } catch (e) {
        throw nameRevert(e, 'call', method, to);
      }
      return codec.decode(method, raw);
    },
    async send(to, abi, method, args = [], { value = 0n, gas } = {}) {
      const data = qrlCodec(abi).encode(method, args);
      if (!gas) {
        let est;
        try {
          est = await web3.qrl.estimateGas({ to: toQ(to), from: account.address, data, value: value.toString() });
        } catch (e) {
          throw nameRevert(e, 'send', method, to);
        }
        // QRL_GAS_MARGIN_PCT (default 130): the bond closes epochs on first
        // touch, so a call estimated before an epoch boundary and mined after
        // it needs far more than the estimate (704k against ~250k measured on
        // rehearsal-v3, 2026-10-03, OC-OPS-10); a fast-epoch rehearsal raises it.
        gas = Number((BigInt(est) * BigInt(process.env.QRL_GAS_MARGIN_PCT || env.QRL_GAS_MARGIN_PCT || 130)) / 100n) + 10_000;
        // Never above the block: a large margin on a chunk upload "exceeds block gas limit".
        const limit = Number(BigInt((await web3.qrl.getBlock('latest')).gasLimit));
        if (gas > limit - 100_000) gas = Math.max(Number(BigInt(est)) + 10_000, limit - 100_000);
      }
      let r;
      try {
        r = await qrl.sendRaw(web3, account, { to: toQ(to), data, value, gas });
      } catch (e) {
        // A reverted send carries no reason on QRVM; replay it as a call at the
        // head so the report names the error, the method and the target (the
        // live audit could not otherwise tell an out-of-gas from a refusal).
        let replay = 'replay succeeded (state moved, or out of gas)';
        try {
          await web3.qrl.call({ to: toQ(to), from: account.address, data, value: value.toString() });
        } catch (c) {
          replay = `replay reverts: ${c.data || (c.innerError && c.innerError.data) || c.message}`.slice(0, 400);
        }
        const used = e.receipt && e.receipt.gasUsed !== undefined ? `, gasUsed ${e.receipt.gasUsed} of ${gas}` : '';
        e.message = `${method} -> ${toQ(to).slice(0, 14)}… reverted${used}; ${replay}. ${e.message}`;
        throw e;
      }
      return { blockNumber: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), logs: (r.logs || []).map(normaliseLog) };
    },
    async deploy(artifactName, args, buildDir, gas = 6_000_000) {
      // Constructor args go through web3's own coder, which wants a v3 QRL
      // address (crossing this interface as 0x+128) back in the Q form. A
      // 20-byte 0x value is an origin-chain address and stays as it is: on v3
      // it is carried as bytes32/uint — the QRVM `address` is 64 bytes — and
      // the coder takes those in the 0x form. A bytes32 is 64 hex digits and
      // is likewise left alone.
      // An array of accounts — a multisig's owners, an oracle's attesters —
      // is mapped element by element, as the coder wants each in the Q form.
      const qArg = (a) => {
        if (Array.isArray(a)) return a.map(qArg);
        if (typeof a === 'bigint') return a.toString();
        if (typeof a === 'string' && /^0x[0-9a-fA-F]{128}$/.test(a)) return toQ(a);
        return a;
      };
      const qArgs = args.map(qArg);
      const c = await qrl.deploy(web3, account, artifactName, qArgs, gas, buildDir);
      // The deployed address comes back Q+128 and keeps all 64 bytes.
      return toHex(c.options.address);
    },
    async logs(address, fromBlock, toBlock) {
      // Address filter only, never a `topics` filter: web3 1.0.x's validator
      // (`isTopic`) still wants exactly 64 hex per topic and rejects the
      // 128-hex QIP-55 slots outright. Topic matching happens client-side —
      // see decodeQrlLogs.
      const raw = await web3.qrl.getPastLogs({ address: toQ(address), fromBlock: Number(fromBlock), toBlock: Number(toBlock) });
      return raw.map(normaliseLog);
    },
    /** The latest block, and the newest one this client treats as final. */
    async head() {
      const b = await web3.qrl.getBlock('latest');
      const latest = BigInt(b.number);
      const safe = latest > BigInt(confirmations) ? latest - BigInt(confirmations) : 0n;
      return { latest, safe, timestamp: BigInt(b.timestamp) };
    },
    async timestampOf(blockNumber) {
      return BigInt((await web3.qrl.getBlock(Number(blockNumber))).timestamp);
    },
    async balance(address) {
      return BigInt(await web3.qrl.getBalance(toQ(address)));
    },
    /** Plain value to an account: how a fresh genesis's one funded key funds every other role. */
    async transfer(to, value) {
      const r = await qrl.sendRaw(web3, account, { to: toQ(to), data: '0x', value: BigInt(value), gas: 100_000 });
      return { blockNumber: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), logs: [] };
    },
    /** Runtime code at an address, `0x` where there is none. */
    async code(address) {
      return String(await web3.qrl.getCode(toQ(address)));
    },
    /**
     * What the relayer's report sealer reads of blocks `from`..`to`
     * (OC-LEGB-06): each block's time, the beacon withdrawals it credited
     * (the beacon chain counts them in Gplanck; returned in planck), and the
     * priority fees paid to `recipient` where it was the block's fee
     * recipient — read from the receipts of that block only.
     */
    async blockFacts(fromBlock, toBlock, recipient) {
      const want = toHex(recipient).toLowerCase();
      const out = [];
      for (let n = BigInt(fromBlock); n <= BigInt(toBlock); n++) {
        const b = await web3.qrl.getBlock(Number(n));
        const withdrawals = (b.withdrawals || []).map((w) => ({
          validatorIndex: BigInt(w.validatorIndex),
          address: toHex(w.address).toLowerCase(),
          amount: BigInt(w.amount) * 10n ** 9n,
        }));
        let fees = 0n;
        if (b.miner && toHex(b.miner).toLowerCase() === want) {
          const base = BigInt(b.baseFeePerGas || 0);
          for (const t of b.transactions || []) {
            const r = await web3.qrl.getTransactionReceipt(typeof t === 'string' ? t : t.hash);
            const price = BigInt(r.effectiveGasPrice || 0);
            if (price > base) fees += BigInt(r.gasUsed) * (price - base);
          }
        }
        out.push({ number: n, timestamp: BigInt(b.timestamp), withdrawals, fees });
      }
      return out;
    },
    /**
     * Block 0. Its hash is what tells a devnet regenerated from genesis from a
     * node that is merely behind (R40); the chain id cannot, it survives a regeneration.
     */
    async genesis() {
      const b = await web3.qrl.getBlock(0);
      return { hash: String(b.hash).toLowerCase(), timestamp: BigInt(b.timestamp) };
    },
  };
  // The devnet RPC reaches this machine through an SSH tunnel, which drops and
  // comes back (OC-OPS-17, hoodi-vps 2026-10-04: a 10 s gap killed a 4-hour
  // scenario). A read is retried for up to a minute while the connection is
  // refused or reset. A send is not: a drop after the broadcast would sign the
  // same intent twice.
  for (const name of ['chainId', 'call', 'logs', 'head', 'timestampOf', 'balance', 'code', 'blockFacts', 'genesis']) {
    const read = client[name];
    if (typeof read !== 'function') continue;
    client[name] = async (...args) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await read.apply(client, args);
        } catch (e) {
          if (attempt >= 12 || !/ECONNREFUSED|ECONNRESET|socket hang up|CONNECTION TIMEOUT|ETIMEDOUT/i.test(`${e.code || ''} ${e.message || ''}`)) throw e;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* EVM transport: the origin chain                                     */
/* ------------------------------------------------------------------ */

/**
 * The origin-chain key a client of `m` signs with: `<CHAIN>_PRIVATE_KEY` or
 * `<CHAIN>_MNEMONIC` (the relayer's), or with `role` — `SOLVER` — the role's
 * own `<CHAIN>_<ROLE>_PRIVATE_KEY` / `<CHAIN>_<ROLE>_MNEMONIC`, which never
 * falls back to the relayer's.
 */
function originKeyOf(env, m, role = null) {
  const upper = m.name.toUpperCase().replace(/-/g, '_');
  const isNamed = (env.ORIGIN_CHAIN || '').trim() === m.name;
  const prefix = role ? `${upper}_${role}` : upper;
  const key = env[`${prefix}_PRIVATE_KEY`] || (!role && isNamed ? env.RELAYER_PRIVATE_KEY : null) || null;
  const phrase = env[`${prefix}_MNEMONIC`] || null;
  return { key, phrase, names: `${prefix}_PRIVATE_KEY or ${prefix}_MNEMONIC` };
}

/** The address of an origin-chain key, offline, or null where there is none. */
function originAddressOf(env, m, role = null) {
  const { key, phrase } = originKeyOf(env, m, role);
  if (key) return toHex(new Wallet(key).address);
  if (phrase) return toHex(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase.trim()), "m/44'/60'/0'/0/0").address);
  return null;
}

function evmClient(m, { role = null } = {}) {
  const env = qrl.loadEnv();
  const upper = m.name.toUpperCase().replace(/-/g, '_');
  // Per-chain keys, so two origin chains can be served from one .env. The
  // ORIGIN_* fallback is the older single-chain naming, and it applies only
  // where ORIGIN_CHAIN names this chain — otherwise a second chain would
  // silently borrow the first one's RPC.
  const isNamed = (env.ORIGIN_CHAIN || '').trim() === m.name;
  const url = env[`${upper}_RPC_URL`] || (isNamed ? env.ORIGIN_RPC_URL : null);
  // A role (the reference solver) signs from its own key and never borrows the relayer's.
  const { key, phrase, names } = originKeyOf(env, m, role);
  if (!url) throw new ChainError(`${upper}_RPC_URL missing from .env`);
  if (!key && !phrase) throw new ChainError(`${names} missing from .env`);
  // A public origin RPC is a deliberate act, and the flag is separate from
  // ALLOW_PUBLIC_RPC because enabling one must never enable the other: the QRL
  // leg stays on the private enclave (CLAUDE.md §4) whatever the origin leg does.
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(url);
  if (!isLocal && env.ALLOW_PUBLIC_ORIGIN_RPC !== '1') {
    throw new ChainError(
      `${upper}_RPC_URL "${url}" is not a private network.\n` +
        'A public origin chain is allowed for a testnet-profile manifest — set ALLOW_PUBLIC_ORIGIN_RPC=1 in .env to say so.',
    );
  }
  // cacheTimeout -1: ethers v6 answers an identical request made within 250 ms
  // from cache, so a nonce read right after a mined tx came back stale on an
  // automining node (two deployments in a row, "nonce too low": rehearsal-v3,
  // 2026-10-03). A public chain's 12 s blocks only hid it.
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true, cacheTimeout: -1 });
  // A mnemonic is accepted because that is how an origin-chain account is
  // usually handed over; the first account of the standard path, so the
  // address is the one any wallet shows for that phrase.
  const wallet = key
    ? new Wallet(key, provider)
    : HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase.trim()), "m/44'/60'/0'/0/0").connect(provider);
  const me = toHex(wallet.address);
  let checked = false;

  async function assertChain() {
    if (checked) return;
    const id = BigInt(await provider.send('eth_chainId', []));
    if (id !== BigInt(m.chainId)) {
      throw new ChainError(`${upper}_RPC_URL answers chain ${id}; the ${m.name} manifest names ${m.chainId}. Nothing was sent`);
    }
    checked = true;
  }

  const blockTag = m.finality === 'finalized' ? 'finalized' : null;

  const client = {
    name: m.name,
    kind: 'evm',
    env,
    address: me,
    async chainId() {
      await assertChain();
      return BigInt(m.chainId);
    },
    async call(to, abi, method, args = [], { value = 0n, from = me } = {}) {
      await assertChain();
      const data = abi.encodeFunctionData(method, args);
      const raw = await provider.call({ to, from, data, value });
      return abi.decodeFunctionResult(method, raw);
    },
    async send(to, abi, method, args = [], { value = 0n, gas } = {}) {
      await assertChain();
      const tx = await wallet.sendTransaction({ to, data: abi.encodeFunctionData(method, args), value, gasLimit: gas });
      const r = await tx.wait();
      if (r.status !== 1) throw new ChainError(`${method} reverted in ${r.hash}`);
      return { blockNumber: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), logs: r.logs.map(normaliseLog), hash: r.hash };
    },
    async deploy(artifactName, args, buildDir) {
      await assertChain();
      const art = qrl.artifact(artifactName, buildDir);
      const abi = new Interface(art.abi);
      const data = art.bytecode + abi.encodeDeploy(args).slice(2);
      const tx = await wallet.sendTransaction({ data });
      const r = await tx.wait();
      if (r.status !== 1 || !r.contractAddress) throw new ChainError(`deploying ${artifactName} failed in ${r.hash}`);
      return toHex(r.contractAddress);
    },
    async logs(address, fromBlock, toBlock) {
      await assertChain();
      // A load-balanced public RPC (publicnode on Hoodi) answers `head()` from
      // one backend and `eth_getLogs` from another a block or two behind, which
      // refuses a range past its own head (-32602 "block range extends beyond
      // current head block"; OC-OPS-15, hoodi-vps 2026-10-04). The lagging
      // backend catches up within a slot, so wait and ask again.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const raw = await provider.getLogs({ address, fromBlock: Number(fromBlock), toBlock: Number(toBlock) });
          return raw.map((l) => normaliseLog({ ...l, logIndex: l.index }));
        } catch (e) {
          const text = `${e.message || ''} ${e.error && e.error.message ? e.error.message : ''}`;
          if (attempt >= 8 || !/beyond current head|block range extends|after last accepted block/i.test(text)) throw e;
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
    },
    async head() {
      await assertChain();
      const latest = await provider.getBlock('latest');
      let safe;
      if (blockTag) safe = BigInt((await provider.getBlock(blockTag)).number);
      else safe = BigInt(latest.number) > BigInt(m.confirmations) ? BigInt(latest.number) - BigInt(m.confirmations) : 0n;
      return { latest: BigInt(latest.number), safe, timestamp: BigInt(latest.timestamp) };
    },
    async timestampOf(blockNumber) {
      return BigInt((await provider.getBlock(Number(blockNumber))).timestamp);
    },
    async balance(address) {
      return BigInt(await provider.getBalance(address));
    },
    /** What one unit of gas costs now, in wei: the fee cap a send would offer. */
    async feePerGas() {
      const f = await provider.getFeeData();
      return BigInt(f.maxFeePerGas ?? f.gasPrice ?? 0n);
    },
    async code(address) {
      await assertChain();
      return String(await provider.getCode(address));
    },
    async genesis() {
      await assertChain();
      const b = await provider.getBlock(0);
      return { hash: String(b.hash).toLowerCase(), timestamp: BigInt(b.timestamp) };
    },
  };
  // A public origin RPC drops out briefly: DNS (ENOTFOUND, EAI_AGAIN), resets,
  // timeouts, a 5xx from the load balancer (OC-OPS-18, hoodi-vps 2026-10-05: a
  // DNS miss killed a seven-hour scenario). A read is retried for up to two
  // minutes; a send is not, since a drop after the broadcast would sign twice.
  for (const name of ['chainId', 'call', 'logs', 'head', 'timestampOf', 'balance', 'feePerGas', 'code', 'genesis']) {
    const read = client[name];
    if (typeof read !== 'function') continue;
    client[name] = async (...args) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await read.apply(client, args);
        } catch (e) {
          const text = `${e.code || ''} ${e.message || ''} ${e.error && e.error.message ? e.error.message : ''}`;
          if (attempt >= 12 || !/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|TIMEOUT|SERVER_ERROR|NETWORK_ERROR|fetch failed|50[234]/i.test(text)) throw e;
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
    };
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* Harness transport: both legs inside one ZVM, with a clock that moves */
/* ------------------------------------------------------------------ */

/**
 * The local harness as a chain, so the relayer and the scenarios can be run
 * end to end before any node exists.
 *
 * Two things make it a chain rather than a fixture. `advance` moves
 * `block.timestamp`, which is the only way a 70-minute epoch, a four-epoch
 * unbonding and a reveal window are crossed in one run — a live chain has no
 * such lever (CLAUDE.md §4.1). And `call` is a **real** read: `Chain.execute`
 * commits, so a call of a state-changing function would apply it and the send
 * that follows would apply it twice. Every call here runs inside a state
 * checkpoint that is reverted, which is what `eth_call` means.
 */
async function harnessClient(m) {
  const { Chain, ACCOUNTS } = require('../../test/harness');
  const { bytesToHex, createAddressFromString, hexToBytes } = require('@ethereumjs/util');
  const chain = await Chain.create({ buildDir: originBuild(m.name, m.profile), chainId: m.chainId });
  const me = toHex(ACCOUNTS.admin);
  // The deployment subscribes bond principal so the book has cover to price, and
  // the harness funds each account with a thousand QRL. Funding the account here,
  // in the environment, keeps `deployQrlLeg` the same code on every chain.
  await chain.fund(ACCOUNTS.admin, 10n ** 30n);
  // The genesis deposit contract, where the enclave's genesis puts it, so the
  // bond's delegation is deployed and wired here exactly as it is on a node.
  const deposit = require('../../test/fixtures/zond-deposit-contract.json');
  await chain.installCode(QRL_DEPOSIT_CONTRACT, deposit.code, deposit.storage);
  const log = [];
  // Every harness client is a new chain, so each has a genesis of its own.
  const genesis = { hash: '0x' + require('crypto').randomBytes(32).toString('hex'), timestamp: chain.timestamp };
  const tsOfBlock = new Map();
  const note = () => tsOfBlock.set(chain.blockNumber, chain.timestamp);
  note();

  const record = (res) => {
    res.logs.forEach((l, i) =>
      log.push({ ...normaliseLog({ ...l, blockNumber: chain.blockNumber, transactionHash: `0x${chain.blockNumber.toString(16).padStart(64, '0')}`, logIndex: i }) }),
    );
    // One block per transaction, so a scan range means what it means elsewhere.
    chain.blockNumber += 1n;
    note();
    return { blockNumber: chain.blockNumber - 1n, gasUsed: BigInt(res.gasUsed), logs: res.logs.map((l) => normaliseLog({ ...l, blockNumber: chain.blockNumber - 1n, transactionHash: '0x', logIndex: 0 })) };
  };

  return {
    name: m.name,
    kind: 'harness',
    env: safeEnv(),
    chain,
    address: me,
    async chainId() {
      return BigInt(m.chainId);
    },
    async call(to, abi, method, args = [], { value = 0n, from = me } = {}) {
      const data = abi.encodeFunctionData(method, args);
      await chain.vm.stateManager.checkpoint();
      try {
        const res = await chain.execute(to, from, data, value, true);
        return abi.decodeFunctionResult(method, res.returnValue);
      } finally {
        await chain.vm.stateManager.revert();
      }
    },
    async send(to, abi, method, args = [], { value = 0n, from = me } = {}) {
      return record(await chain.execute(to, from, abi.encodeFunctionData(method, args), value));
    },
    async deploy(artifactName, args, buildDir) {
      const art = qrl.artifact(artifactName, buildDir);
      const abi = new Interface(art.abi);
      const res = await chain.vm.evm.runCall({
        caller: createAddressFromString(me),
        to: undefined,
        data: hexToBytes(art.bytecode + abi.encodeDeploy(args).slice(2)),
        gasLimit: chain.gasPool,
        value: 0n,
        block: chain.blockContext(),
      });
      if (res.execResult.exceptionError) throw new ChainError(`deploying ${artifactName} failed: ${res.execResult.exceptionError.error}`);
      chain.blockNumber += 1n;
      note();
      return toHex(res.createdAddress.toString());
    },
    async logs(address, fromBlock, toBlock) {
      const a = toHex(address);
      return log.filter((l) => l.address === a && l.blockNumber >= BigInt(fromBlock) && l.blockNumber <= BigInt(toBlock));
    },
    async head() {
      const latest = chain.blockNumber;
      const safe = latest > BigInt(m.confirmations) ? latest - BigInt(m.confirmations) : 0n;
      return { latest, safe, timestamp: chain.timestamp };
    },
    async timestampOf(blockNumber) {
      const b = BigInt(blockNumber);
      if (tsOfBlock.has(b)) return tsOfBlock.get(b);
      let best = 0n;
      for (const [k, v] of tsOfBlock) if (k <= b && k >= best) best = k;
      return tsOfBlock.get(best) ?? chain.timestamp;
    },
    async balance(address) {
      return chain.balanceOf(address);
    },
    async transfer(to, value, { from = me } = {}) {
      return record(await chain.execute(toHex(to), from, '0x', BigInt(value)));
    },
    async code(address) {
      return bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(toHex(address))));
    },
    async genesis() {
      return { ...genesis };
    },
    /** What a scenario's `sleep` becomes here: the clock this chain runs on. */
    advance(seconds) {
      chain.advanceTime(Number(seconds));
      note();
    },
  };
}

function safeEnv() {
  try {
    return qrl.loadEnv();
  } catch {
    return {};
  }
}

/**
 * The origin chain a manifest names. A `qrl` manifest is the enclave standing
 * in; its chain id is checked here exactly as the EVM client checks its own.
 */
const CLIENTS = new Map();

async function originClient(chainName) {
  const m = manifest.load(chainName);
  // Only a time-compressed deployment is driven from here. The specification's
  // own build is deployed by hand, from artifacts somebody inspected (R13).
  if (m.profile === 'spec') {
    throw new ChainError(`${chainName} is a spec-profile manifest; these tools drive time-compressed deployments only`);
  }
  // One client per chain for the life of the process: the harness client owns
  // a VM, and a second one would be a second chain with the same name.
  if (!CLIENTS.has(chainName)) {
    if (m.client === 'harness') CLIENTS.set(chainName, await harnessClient(m));
    else if (m.client === 'qrl') CLIENTS.set(chainName, qrlClient({ name: m.name, confirmations: m.confirmations }));
    else CLIENTS.set(chainName, evmClient(m));
  }
  const client = CLIENTS.get(chainName);
  const id = await client.chainId();
  if (id !== BigInt(m.chainId)) throw new ChainError(`${chainName}: the node answers chain ${id}, the manifest names ${m.chainId}`);
  return { client, manifest: m, build: originBuild(chainName, m.profile), qrlBuild: qrlBuild(m.profile) };
}

/** Decode every log of `abi` in `logs`, dropping the ones it does not know. */
function parseLogs(abi, logs) {
  const out = [];
  for (const l of logs) {
    try {
      const ev = abi.parseLog({ topics: l.topics, data: l.data });
      if (ev) out.push({ ...l, name: ev.name, args: ev.args });
    } catch {
      /* another contract's event */
    }
  }
  return out;
}

/** Drops the cached clients, so the next originClient builds a fresh chain. */
const resetClients = () => CLIENTS.clear();

/**
 * The harness client as another of its accounts: every call and send from
 * `address` unless told otherwise. What a second process with keys of its own
 * is on a real chain (the reference solver in the e2e run); on the harness a
 * sender needs no key.
 */
function harnessAccount(client, address) {
  const me = toHex(address);
  return {
    ...client,
    address: me,
    call: (to, abi, method, args = [], opts = {}) => client.call(to, abi, method, args, { from: me, ...opts }),
    send: (to, abi, method, args = [], opts = {}) => client.send(to, abi, method, args, { from: me, ...opts }),
    transfer: (to, value, opts = {}) => client.transfer(to, value, { from: me, ...opts }),
  };
}

module.exports = { QRL_DEPOSIT_CONTRACT, QRL_EVENTS, qrlClient, evmClient, harnessClient, harnessAccount, originClient, originKeyOf, originAddressOf, resetClients, iface, qrlCodec, parseLogs, decodeQrlLogs, evmToQrl, qrlEncodeDeploy, qrlBuild, qrvmBuild, qrlAbiBuild, originBuild, ChainError, ROOT };
