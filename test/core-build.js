/**
 * contracts/core's compiled contracts, run on this repository's harness.
 *
 * The repositories do not import each other's sources. Where the umbrella
 * checkout has core's `build/` (hypc 0.0.2, the same line as this harness),
 * a test can deploy core's own bytecode beside this tree's and prove the two
 * meet at the interface a deployment wires — veARK for the juror pool, the
 * Q-Day oracle for the registry and the bond. Where it has not, `coreBuild()`
 * is null and those tests skip, naming the path.
 */
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');
const { createAddressFromString, hexToBytes } = require('@ethereumjs/util');
const { ACCOUNTS, coder } = require('./harness');

const CORE = process.env.ARK_CORE_DIR || path.join(__dirname, '..', '..', '..', 'ecosystem', 'contracts');
const CORE_BUILD = path.join(CORE, 'build');

/** The directory of core's artifacts, or null. */
function coreBuild(name = 'ArkQDayOracle') {
  return fs.existsSync(path.join(CORE_BUILD, `${name}.json`)) ? CORE_BUILD : null;
}

/**
 * Deploy core's `name` with constructor `types`/`values`; returns a handle
 * whose `send`/`call` encode against core's ABI and decode reverts against
 * this tree's error set (the harness's), which carries the names the tests
 * assert on.
 */
async function deployCore(chain, name, types = [], values = [], from = ACCOUNTS.admin) {
  const art = JSON.parse(fs.readFileSync(path.join(CORE_BUILD, `${name}.json`), 'utf8'));
  const iface = new Interface(art.abi);
  const res = await chain.vm.evm.runCall({
    caller: createAddressFromString(from),
    to: undefined,
    data: hexToBytes(art.bytecode + (types.length ? coder.encode(types, values).slice(2) : '')),
    gasLimit: chain.gasPool,
    value: 0n,
    block: chain.blockContext(),
  });
  if (res.execResult.exceptionError) throw new Error(`deploy core ${name} failed: ${res.execResult.exceptionError.error}`);
  const address = res.createdAddress.toString();
  return {
    address,
    iface,
    send: (m, args = [], opts = {}) => chain.execute(address, opts.from || ACCOUNTS.admin, iface.encodeFunctionData(m, args), opts.value || 0n),
    call: async (m, args = []) => {
      const r = await chain.execute(address, ACCOUNTS.admin, iface.encodeFunctionData(m, args), 0n, true);
      const out = iface.decodeFunctionResult(m, r.returnValue);
      return out.length === 1 ? out[0] : out;
    },
  };
}

module.exports = { CORE, CORE_BUILD, coreBuild, deployCore };
