/**
 * Two ways to run the origin leg under an adversary: the ZVM harness in this
 * process, and a Hardhat node over JSON-RPC.
 *
 * The one rule this module exists to enforce: **the stress run is the same code
 * on both.** Each backend offers the same five things — deploy, call, send from
 * any address, move the clock, read the clock — so a sequence that breaks an
 * invariant offline can be replayed, seed for seed, against a real node with
 * real receipts, real gas accounting and (on a fork) the real stETH.
 *
 * A revert is always returned as `{ name, data }`: the decoded custom error, or
 * `Panic(n)`, or `Error(msg)`, or `<empty>`. The stress run treats the last
 * three from an escrow or the relay as defects, because every refusal those
 * contracts intend is a named custom error.
 */
const fs = require('fs');
const path = require('path');
const { AbiCoder, Interface, JsonRpcProvider, getAddress } = require('ethers');

const coder = AbiCoder.defaultAbiCoder();

function artifact(name, buildDir) {
  return JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.json`), 'utf8'));
}

/** Every custom error in a build directory, keyed by signature (see test/harness.js). */
function errorInterface(buildDir) {
  const frags = new Map();
  for (const f of fs.readdirSync(buildDir)) {
    if (!f.endsWith('.json')) continue;
    for (const item of artifact(f.replace(/\.json$/, ''), buildDir).abi || []) {
      if (item.type === 'error') frags.set(`${item.name}(${item.inputs.map((i) => i.type).join(',')})`, item);
    }
  }
  return new Interface([...frags.values()]);
}

function decodeRevert(errors, data) {
  if (!data || data === '0x') return '<empty>';
  if (data.startsWith('0x08c379a0')) return `Error(${coder.decode(['string'], '0x' + data.slice(10))[0]})`;
  if (data.startsWith('0x4e487b71')) return `Panic(0x${coder.decode(['uint256'], '0x' + data.slice(10))[0].toString(16)})`;
  try {
    return errors.parseError(data).name;
  } catch {
    return `<unknown ${data.slice(0, 10)}>`;
  }
}

class Reverted extends Error {
  constructor(name, data) {
    super(name);
    this.revertName = name;
    this.data = data;
  }
}

/* ------------------------------------------------------------------ */

async function harnessBackend({ buildDir }) {
  const { Chain } = require('../../test/harness');
  const { createAddressFromString, hexToBytes } = require('@ethereumjs/util');
  const chain = await Chain.create({ buildDir });
  const errors = errorInterface(buildDir);
  const deployer = '0x' + '11'.repeat(20);

  const run = async (to, from, data, value = 0n, readOnly = false) => {
    let res;
    try {
      if (readOnly) await chain.vm.stateManager.checkpoint();
      res = await chain.execute(to, from, data, value);
    } catch (e) {
      if (readOnly) await chain.vm.stateManager.revert();
      if (e.reverted) throw new Reverted(decodeRevert(errors, e.data), e.data);
      throw e;
    }
    if (readOnly) await chain.vm.stateManager.revert();
    return res;
  };

  return {
    kind: 'harness',
    chainId: 1n,
    deployer,
    errors,
    async deploy(name, args = []) {
      const art = artifact(name, buildDir);
      const abi = new Interface(art.abi);
      const res = await chain.vm.evm.runCall({
        caller: createAddressFromString(deployer),
        data: hexToBytes(art.bytecode + abi.encodeDeploy(args).slice(2)),
        gasLimit: chain.gasPool,
        block: chain.blockContext(),
      });
      if (res.execResult.exceptionError) throw new Error(`deploy ${name}: ${res.execResult.exceptionError.error}`);
      return getAddress(res.createdAddress.toString());
    },
    async call(to, abi, method, args = [], from = deployer) {
      const r = await run(to, from, abi.encodeFunctionData(method, args), 0n, true);
      return abi.decodeFunctionResult(method, r.returnValue);
    },
    async send(to, abi, method, args = [], from = deployer, value = 0n) {
      const r = await run(to, from, abi.encodeFunctionData(method, args), value);
      return { gasUsed: BigInt(r.gasUsed), logs: r.logs };
    },
    async now() {
      return BigInt(chain.timestamp);
    },
    async advance(seconds) {
      chain.advanceTime(Number(seconds));
    },
    async fund(addr, wei) {
      await chain.fund(addr, wei);
    },
    async close() {},
  };
}

/* ------------------------------------------------------------------ */

/**
 * A Hardhat (or Anvil) node. Every sender is impersonated, so the run can use
 * thousands of distinct depositors without keys, and the clock is moved with
 * `evm_increaseTime` — the lever a public chain does not have.
 */
async function hardhatBackend({ buildDir, url = 'http://127.0.0.1:8546' }) {
  const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const chainId = BigInt(await provider.send('eth_chainId', []));
  const errors = errorInterface(buildDir);
  const accounts = await provider.send('eth_accounts', []);
  const deployer = getAddress(accounts[0]);
  const impersonated = new Set();

  const impersonate = async (addr) => {
    const a = getAddress(addr);
    if (impersonated.has(a)) return a;
    await provider.send('hardhat_impersonateAccount', [a]);
    const bal = BigInt(await provider.send('eth_getBalance', [a, 'latest']));
    if (bal < 10n ** 18n) await provider.send('hardhat_setBalance', [a, '0x' + (10n ** 21n).toString(16)]);
    impersonated.add(a);
    return a;
  };

  const revertData = (e) => {
    const d = e?.info?.error?.data ?? e?.error?.data ?? e?.data;
    if (typeof d === 'string') return d;
    if (d && typeof d.data === 'string') return d.data;
    return '0x';
  };

  const ethCall = async (tx) => {
    try {
      return await provider.send('eth_call', [tx, 'latest']);
    } catch (e) {
      const data = revertData(e);
      throw new Reverted(decodeRevert(errors, data), data);
    }
  };

  const sendTx = async (tx) => {
    // Pre-flight with eth_call so a refusal is decoded from its data, then send.
    await ethCall(tx);
    const hash = await provider.send('eth_sendTransaction', [{ ...tx, gas: '0x' + (14_000_000).toString(16) }]);
    const r = await provider.send('eth_getTransactionReceipt', [hash]);
    if (!r || r.status !== '0x1') throw new Reverted('<receipt failed>', '0x');
    return r;
  };

  const hex = (v) => '0x' + BigInt(v).toString(16);

  return {
    kind: 'hardhat',
    chainId,
    deployer,
    errors,
    provider,
    impersonate,
    async deploy(name, args = []) {
      const art = artifact(name, buildDir);
      const abi = new Interface(art.abi);
      const r = await sendTx({ from: deployer, data: art.bytecode + abi.encodeDeploy(args).slice(2) });
      return getAddress(r.contractAddress);
    },
    async call(to, abi, method, args = [], from = deployer) {
      const raw = await ethCall({ from: getAddress(from), to, data: abi.encodeFunctionData(method, args) });
      return abi.decodeFunctionResult(method, raw);
    },
    async send(to, abi, method, args = [], from = deployer, value = 0n) {
      const f = await impersonate(from);
      const r = await sendTx({ from: f, to, data: abi.encodeFunctionData(method, args), value: hex(value) });
      return {
        gasUsed: BigInt(r.gasUsed),
        logs: r.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })),
      };
    },
    async now() {
      const b = await provider.send('eth_getBlockByNumber', ['latest', false]);
      return BigInt(b.timestamp);
    },
    async advance(seconds) {
      if (BigInt(seconds) <= 0n) return;
      await provider.send('evm_increaseTime', [Number(seconds)]);
      await provider.send('evm_mine', []);
    },
    async fund(addr, wei) {
      await provider.send('hardhat_setBalance', [getAddress(addr), hex(wei)]);
    },
    async setStorage(addr, slot, value) {
      await provider.send('hardhat_setStorageAt', [getAddress(addr), slot, '0x' + BigInt(value).toString(16).padStart(64, '0')]);
    },
    async getStorage(addr, slot) {
      return BigInt(await provider.send('eth_getStorageAt', [getAddress(addr), slot, 'latest']));
    },
    async close() {
      provider.destroy();
    },
  };
}

module.exports = { harnessBackend, hardhatBackend, Reverted, artifact, errorInterface };
