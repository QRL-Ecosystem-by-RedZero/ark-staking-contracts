/**
 * Local ZVM execution harness — the private network this project tests against.
 *
 * QRL Zond's ZVM is an EVM fork and hypc emits standard EVM bytecode, so the
 * compiled artifacts execute unmodified under @ethereumjs/vm. That buys two
 * things the public testnet cannot give us: control over `block.timestamp`,
 * which every timelock and Q-Day path depends on, and the freedom to deploy
 * throwaway contracts without leaving permanent litter on a shared chain.
 *
 * Addresses here are plain 0x/20-byte EVM addresses. On the live network the
 * same 20 bytes are rendered with a `Q` prefix; the difference is presentation
 * only and does not affect execution.
 *
 * CAVEAT: this harness runs stock EVM, so precompiles the real ZVM may not ship
 * would silently appear to work. Never rely on one the Hyperion compiler itself
 * refuses to expose — `ecrecover` above all.
 *
 * ONE PRECOMPILE IS ZVM'S, NOT ETHEREUM'S
 * ---------------------------------------
 * ZVM has no `ecrecover`. Address 0x01 is instead `depositroot`: the SSZ
 * hash-tree-root, under SHA-256, of a beacon-chain DepositData whose input is
 * pubkey (2,592 bytes, ML-DSA-87) ‖ withdrawal credentials (32) ‖ amount (8,
 * little-endian) ‖ signature (4,627). The genesis deposit contract calls it to
 * check a deposit's root, so without it the real contract cannot run here.
 * Established against the Kurtosis node: its 0x02 is SHA-256, and its 0x01
 * reproduces the root qrysm's `deposit` tool writes, byte for byte. The QRL
 * build gets it; the origin-chain build, which stands in for a stock EVM chain,
 * keeps `ecrecover`.
 */
const fs = require('fs');
const path = require('path');
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork, createCustomCommon } = require('@ethereumjs/common');
const {
  createAddressFromString,
  hexToBytes,
  bytesToHex,
  createAccount,
} = require('@ethereumjs/util');
const { Interface, AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const ROOT = path.join(__dirname, '..');
const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });

const ZVM_PUBKEY = 2592;
const ZVM_SIGNATURE = 4627;
const DEPOSIT_DATA = ZVM_PUBKEY + 32 + 8 + ZVM_SIGNATURE;

const sha256 = (b) => require('crypto').createHash('sha256').update(b).digest();
function merkleize(chunks) {
  let width = 1;
  while (width < chunks.length) width *= 2;
  let layer = [...chunks];
  while (layer.length < width) layer.push(Buffer.alloc(32));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256(Buffer.concat([layer[i], layer[i + 1]])));
    layer = next;
  }
  return layer[0];
}
const chunked = (b) => {
  const chunks = [];
  for (let i = 0; i < b.length; i += 32) {
    const c = Buffer.alloc(32);
    b.copy(c, 0, i, Math.min(i + 32, b.length));
    chunks.push(c);
  }
  return merkleize(chunks);
};

/** ZVM precompile 0x01. Gas is priced as SHA-256 over the input, an approximation. */
function depositRoot(opts) {
  const data = Buffer.from(opts.data);
  const gas = 60n + 12n * BigInt(Math.ceil(data.length / 32));
  if (data.length !== DEPOSIT_DATA || opts.gasLimit < gas) {
    return { executionGasUsed: opts.gasLimit, returnValue: new Uint8Array(0), exceptionError: { error: 'depositroot input' } };
  }
  const amount = Buffer.alloc(32);
  data.copy(amount, 0, ZVM_PUBKEY + 32, ZVM_PUBKEY + 40);
  const root = merkleize([
    chunked(data.subarray(0, ZVM_PUBKEY)),
    data.subarray(ZVM_PUBKEY, ZVM_PUBKEY + 32),
    amount,
    chunked(data.subarray(ZVM_PUBKEY + 40)),
  ]);
  return { executionGasUsed: gas, returnValue: new Uint8Array(root) };
}

const coder = AbiCoder.defaultAbiCoder();

/**
 * Where hypc writes. The Solidity leg writes somewhere else on purpose — see
 * scripts/compile-evm.js. Artifacts are keyed by contract name alone, so one
 * directory holding both toolchains would let OpenZeppelin's Hyperion
 * MerkleProof and its Solidity twin silently overwrite each other.
 */
const DEFAULT_BUILD = path.join(ROOT, 'build');

function artifact(name, buildDir = DEFAULT_BUILD) {
  return JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.json`), 'utf8'));
}

/** Deterministic test accounts. */
const ACCOUNTS = {
  admin: '0x' + '11'.repeat(20),
  attester: '0x' + '22'.repeat(20),
  oracle: '0x' + '33'.repeat(20),
  alice: '0x' + '44'.repeat(20),
  bob: '0x' + '55'.repeat(20),
  mallory: '0x' + '66'.repeat(20),
  guardian: '0x' + '77'.repeat(20),
};

const role = (name) => keccak256(toUtf8Bytes(name));
const DEFAULT_ADMIN_ROLE = '0x' + '00'.repeat(32);

/** keccak256(abi.encodePacked(ethContract, tokenId)), matching the registry docs. */
function assetHash(ethContract, tokenId) {
  return keccak256(
    Buffer.concat([
      Buffer.from(ethContract.replace(/^0x/, ''), 'hex'),
      Buffer.from(BigInt(tokenId).toString(16).padStart(64, '0'), 'hex'),
    ]),
  );
}

/**
 * A deployed contract bound to the chain, with ABI-typed methods.
 *
 * `send` mutates state and throws a decoded custom error on revert; `call`
 * is the read path. Both take `{ from, value }` as an optional final argument.
 */
class Contract {
  constructor(chain, name, address) {
    this.chain = chain;
    this.name = name;
    this.address = address;
    this.iface = new Interface(artifact(name, chain.buildDir).abi);
  }

  async send(method, args = [], opts = {}) {
    const data = this.iface.encodeFunctionData(method, args);
    const res = await this.chain.execute(this.address, opts.from || ACCOUNTS.admin, data, opts.value || 0n);
    return { ...res, decoded: this._decodeResult(method, res.returnValue) };
  }

  async call(method, args = [], opts = {}) {
    const data = this.iface.encodeFunctionData(method, args);
    const res = await this.chain.execute(this.address, opts.from || ACCOUNTS.admin, data, 0n, true);
    const out = this._decodeResult(method, res.returnValue);
    return out && out.length === 1 ? out[0] : out;
  }

  _decodeResult(method, returnValue) {
    const frag = this.iface.getFunction(method);
    if (!frag.outputs.length) return [];
    return this.iface.decodeFunctionResult(frag, returnValue);
  }

  /** Decoded logs this contract emitted in a receipt, filtered by event name. */
  events(res, name) {
    const out = [];
    for (const log of res.logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      let parsed;
      try {
        parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        continue;
      }
      if (parsed && (!name || parsed.name === name)) out.push(parsed);
    }
    return out;
  }
}

class Chain {
  constructor(vm, buildDir = DEFAULT_BUILD) {
    this.vm = vm;
    this.buildDir = buildDir;
    this.blockNumber = 1n;
    this.timestamp = 1_700_000_000n;
    this.gasPool = 30_000_000n;
  }

  static async create(opts = {}) {
    let chain;
    const blockchain = {
      getBlock: async (n) => {
        const num = BigInt(n);
        const outOfRange = num >= chain.blockNumber || chain.blockNumber - num > 256n;
        return {
          hash: () =>
            hexToBytes(outOfRange ? '0x' + '00'.repeat(32) : keccak256(toUtf8Bytes(`block-${num}`))),
        };
      },
    };
    const buildDir = opts.buildDir || DEFAULT_BUILD;
    const evmOpts =
      buildDir === DEFAULT_BUILD
        ? { customPrecompiles: [{ address: '0x0000000000000000000000000000000000000001', function: depositRoot }] }
        : {};
    // `block.chainid` is inside every identifier of CLAUDE.md §7.6, so a test
    // standing in for a named chain has to answer with that chain's id. The
    // default stays mainnet's, which is what the suites were written against.
    const chainCommon = opts.chainId === undefined
      ? common
      : createCustomCommon({ chainId: Number(opts.chainId) }, Mainnet, { hardfork: Hardfork.Shanghai });
    chain = new Chain(await createVM({ common: chainCommon, blockchain, evmOpts }), buildDir);
    chain.chainId = BigInt(chainCommon.chainId());
    for (const addr of Object.values(ACCOUNTS)) await chain.fund(addr);
    return chain;
  }

  advanceTime(seconds) {
    this.timestamp += BigInt(seconds);
    this.blockNumber += BigInt(seconds) / 12n + 1n;
  }

  blockContext() {
    return {
      header: {
        number: this.blockNumber,
        timestamp: this.timestamp,
        gasLimit: 30_000_000n,
        baseFeePerGas: 7n,
        difficulty: 0n,
        prevRandao: hexToBytes(keccak256(toUtf8Bytes(`randao-${this.blockNumber}`))),
        coinbase: createAddressFromString('0x' + '11'.repeat(20)),
      },
    };
  }

  async fund(addr, wei = 10n ** 21n) {
    await this.vm.stateManager.putAccount(
      createAddressFromString(addr),
      createAccount({ balance: wei }),
    );
  }

  async balanceOf(addr) {
    const acc = await this.vm.stateManager.getAccount(createAddressFromString(addr));
    return acc ? acc.balance : 0n;
  }

  /**
   * Deploys an artifact. `argTypes`/`argValues` are the constructor signature;
   * hypc places constructor args after the creation code as usual.
   */
  async deploy(name, argTypes = [], argValues = [], from = ACCOUNTS.admin) {
    const art = artifact(name, this.buildDir);
    let data = art.bytecode;
    if (argTypes.length) data += coder.encode(argTypes, argValues).replace(/^0x/, '');

    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: undefined,
      data: hexToBytes(data),
      gasLimit: this.gasPool,
      value: 0n,
      block: this.blockContext(),
    });
    if (res.execResult.exceptionError) {
      // A constructor's custom error is named, as a call's is: the parameter
      // set checks its launch values in its constructor (2026-09-28).
      const ret = bytesToHex(res.execResult.returnValue);
      const e = new Error(`deploy ${name} failed: ${decodeRevert(ret, this.buildDir) || res.execResult.exceptionError.error}`);
      e.reverted = true;
      e.data = ret;
      throw e;
    }
    return new Contract(this, name, res.createdAddress.toString());
  }

  /**
   * Put runtime code and storage at a fixed address, as a genesis allocation
   * would. For contracts that exist on the real chain at a known address — the
   * QRL deposit contract — and for a contract whose address must match data
   * produced outside the suite, such as validator deposit data naming it.
   */
  async installCode(address, codeHex, storage = {}) {
    const addr = createAddressFromString(address);
    const existing = await this.vm.stateManager.getAccount(addr);
    if (!existing) await this.vm.stateManager.putAccount(addr, createAccount({}));
    await this.vm.stateManager.putCode(addr, hexToBytes(codeHex));
    for (const [slot, value] of Object.entries(storage)) {
      await this.vm.stateManager.putStorage(
        addr,
        hexToBytes('0x' + BigInt(slot).toString(16).padStart(64, '0')),
        hexToBytes('0x' + BigInt(value).toString(16).padStart(64, '0')),
      );
    }
  }

  /**
   * Move a deployed contract to `address`, copying its runtime code and the
   * storage slots named. Immutables live in runtime code, so a contract whose
   * constructor writes nothing else to storage moves whole.
   */
  async relocate(contract, address, slots = []) {
    const from = createAddressFromString(contract.address);
    const code = await this.vm.stateManager.getCode(from);
    const storage = {};
    for (const slot of slots) {
      const key = hexToBytes('0x' + BigInt(slot).toString(16).padStart(64, '0'));
      const v = await this.vm.stateManager.getStorage(from, key);
      storage[slot] = v.length ? bytesToHex(v) : '0x0';
    }
    await this.installCode(address, bytesToHex(code), storage);
    return new Contract(this, contract.name, address);
  }

  /** Credit an account without running any code, as a beacon-chain withdrawal does. */
  async credit(address, wei) {
    const addr = createAddressFromString(address);
    const acc = (await this.vm.stateManager.getAccount(addr)) || createAccount({});
    acc.balance += BigInt(wei);
    await this.vm.stateManager.putAccount(addr, acc);
  }

  /** Attaches an already-deployed address under a different ABI. */
  at(name, address) {
    return new Contract(this, name, address);
  }

  async execute(to, from, dataHex, value = 0n, readOnly = false) {
    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(dataHex),
      gasLimit: this.gasPool,
      value,
      block: this.blockContext(),
    });

    const ret = bytesToHex(res.execResult.returnValue);
    if (res.execResult.exceptionError) {
      const e = new Error(decodeRevert(ret, this.buildDir) || res.execResult.exceptionError.error);
      e.reverted = true;
      e.data = ret;
      throw e;
    }
    if (readOnly) {
      // runCall commits; for a view path there is nothing to roll back because
      // the callee is `view` and wrote nothing.
    }
    return {
      returnValue: ret,
      gasUsed: res.execResult.executionGasUsed,
      logs: (res.execResult.logs || []).map(([address, topics, data]) => ({
        address: '0x' + Buffer.from(address).toString('hex'),
        topics: topics.map((t) => '0x' + Buffer.from(t).toString('hex')),
        data: '0x' + Buffer.from(data).toString('hex'),
      })),
    };
  }
}

/**
 * All custom errors declared across the project, for revert decoding.
 *
 * Keyed by signature and not by name. Two contracts may declare the same error
 * name with different arguments — `StillUnbonding(address)` in StakingVault and
 * `StillUnbonding(bytes32,uint64)` in ArkStakeRegistry are different errors —
 * and deduplicating by name kept whichever artifact was read last, so a revert
 * from the other one decoded as a bare `revert` with no name. A test asserting
 * on that name then failed for a reason that had nothing to do with the rule it
 * was defending.
 */
const errorIfaces = new Map();
function revertInterface(buildDir = DEFAULT_BUILD) {
  const cached = errorIfaces.get(buildDir);
  if (cached) return cached;
  const frags = new Map();
  for (const f of fs.readdirSync(buildDir)) {
    if (!f.endsWith('.json')) continue;
    for (const item of artifact(f.replace(/\.json$/, ''), buildDir).abi) {
      if (item.type !== 'error') continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
      frags.set(sig, item);
    }
  }
  const iface = new Interface([...frags.values()]);
  errorIfaces.set(buildDir, iface);
  return iface;
}

function decodeRevert(ret, buildDir = DEFAULT_BUILD) {
  if (!ret || ret === '0x') return null;
  if (ret.startsWith('0x08c379a0')) {
    return coder.decode(['string'], '0x' + ret.slice(10))[0];
  }
  if (ret.startsWith('0x4e487b71')) {
    return `Panic(${coder.decode(['uint256'], '0x' + ret.slice(10))[0]})`;
  }
  try {
    const parsed = revertInterface(buildDir).parseError(ret);
    return parsed ? parsed.name : null;
  } catch {
    return null;
  }
}

module.exports = {
  Chain,
  Contract,
  artifact,
  ACCOUNTS,
  role,
  DEFAULT_ADMIN_ROLE,
  assetHash,
  coder,
  DEFAULT_BUILD,
};
