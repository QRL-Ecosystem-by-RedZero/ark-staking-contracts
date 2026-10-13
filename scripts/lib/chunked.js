/**
 * Deploying a contract whose creation code is too large for one QRL request.
 *
 * The one rule this module exists to enforce: **a contract is sent whole when it
 * fits and in pieces when it does not, and the choice is made from the artifact's
 * own size, never by hand** — so a contract that grows past the ceiling in a later
 * commit is deployed the other way without anybody remembering to change a script.
 *
 * The ceiling is the request, not the chain (CLAUDE.md §3.1). The public QRL proxy
 * caps a body at 50KB and an ML-DSA-87 signature with its public key adds about
 * 7.2KB to every transaction, on top of hex doubling the payload, so creation code
 * above about 18,000 bytes cannot be sent at once. EIP-3860 admits initcode to
 * 49,152 bytes, so the same code can be assembled on chain by `ChunkedDeployer`
 * from pieces that each fit, and created there.
 *
 * WHAT THE DEPLOYED CONTRACT MUST NOT DO
 * -------------------------------------
 * A contract created through `ChunkedDeployer` sees that contract as `msg.sender`
 * in its constructor. Any contract that may be deployed this way therefore takes
 * the account allowed to wire it as an argument — `ArkCatBond` does, and its test
 * holds it to that (test/ChunkedDeployer.test.js). Deploying a contract that reads
 * `msg.sender` for authority through here would hand that authority to a contract
 * that can make no call with it, so `deployLarge` refuses to without being told it
 * is safe.
 *
 * WHOSE DEPLOYER (audit D19, 2026-09-29)
 * --------------------------------------
 * A `ChunkedDeployer` serves only the account that created it (`owner`,
 * immutable), so nobody else can advance its CREATE nonce between two of this
 * account's creations and move the address of the next one. Every deployment
 * path here creates its own deployer from the deploying account and passes it
 * down; `deployLarge` checks `owner()` against the client before sending a piece.
 */
const { keccak256 } = require('ethers');
const { QRL_EVENTS, decodeQrlLogs, iface, parseLogs, qrlEncodeDeploy } = require('./chains');
const { toHex } = require('../../ecdsa-stakings/relayer/lib/addresses');
const { DIRECT_DEPLOY_LIMIT } = require('./limits');
const qrl = require('../qrl');

/** Each piece stays far enough under the ceiling that the envelope around it cannot push it over. */
const PIECE_BYTES = 12000;

/**
 * Contracts known to take their wiring authority as an argument rather than from
 * `msg.sender`, and so safe to create through `ChunkedDeployer`.
 * `ArkStakeRegistry` takes governance as its first constructor argument and
 * `ArkBondDelegation` its governance as its second; both cross the ceiling on
 * the QRVM (v3) build, where 512-bit codegen roughly doubles the init code.
 * `ArkStakeParams` takes governance and the account that names its registry
 * as its first two (2026-09-28): its constructor carries the launch set and
 * its checks, 27,884 bytes of init code on the harness build. Since item 128
 * (2026-10-06) its constructor creates the checks module,
 * `ArkStakeParamsChecks`, whose one caller is the set that created it (its
 * `msg.sender` is the set, never the deployer), so the module's init code
 * rides inside the set's and needs no entry of its own.
 * `PremiumSwap` takes no wiring authority at all — four immutables and no
 * setter — and crosses the ceiling on the v3 build since the commitment bond
 * and the shortfall carry arrived (2026-09-28, phase C2). Since item 123
 * (2026-10-05) its constructor creates its judgement module,
 * `PremiumSwapJudge`, which reads no `msg.sender` either, so the module's
 * init code rides inside the swap's and needs no entry of its own.
 * `ArkCatBondSettlement` (phase C3) takes no wiring authority either — five
 * immutables, and the bond it serves checks them — and crosses the ceiling on
 * both lines.
 * `ArkStakeCourt` (phase C4) takes no wiring authority: every dependency is
 * an immutable and it creates its findings module in its constructor (23,240
 * bytes of init code on the harness build, 28,113 on v3). `ArkJurorPool`
 * takes its deployer explicitly for `setCourt` and fits one request today.
 * `ArkGovernor` is contracts/core's, deployed from the vendored governance
 * artifacts (scripts/lib/governance.js): it takes its authority from
 * constructor arguments only (core CLAUDE.md §4), and its init code crosses
 * the ceiling on both lines (19,367 harness, 23,706 v3 at the testnet profile).
 * Its siblings `VeArk` and `ArkQDayOracle` fix `msg.sender` as the account
 * that names their governor and must stay direct — they fit.
 * `ArkReferenceOracle` (2026-10-05) takes its governance, parameter contract
 * and Q-Day oracle as constructor arguments and reads no `msg.sender` there;
 * 18,013 bytes of init code on the harness build.
 * `ArkTimelock` (core) takes its proposer and guardian as its two constructor
 * arguments and reads no `msg.sender` there; the treasury transfer row of
 * 2026-10-13 put it over the ceiling (about 19,600 bytes on the harness build).
 */
const CHUNK_SAFE = new Set(['ArkCatBond', 'ArkCatBondSettlement', 'ArkCatBondRecovery', 'ArkStakeRegistry', 'ArkBondDelegation', 'ArkStakeParams', 'PremiumSwap', 'ArkStakeCourt', 'ArkJurorPool', 'ArkGovernor', 'ArkReferenceOracle', 'ArkTimelock']);

const sizeOf = (bytecode) => (bytecode.length - 2) / 2;

function pieces(bytecode, size = PIECE_BYTES) {
  const body = bytecode.replace(/^0x/, '');
  const out = [];
  for (let i = 0; i < body.length; i += size * 2) out.push('0x' + body.slice(i, i + size * 2));
  return out;
}

/**
 * Deploy `name`, whole if it fits and through `chunked` if it does not. Returns
 * the address, hex, as `client.deploy` does.
 *
 * `chunked` is the address of a deployed `ChunkedDeployer`; it may be omitted
 * where the caller knows every contract it deploys fits.
 */
async function deployLarge(client, name, args, buildDir, { chunked, log = () => {} } = {}) {
  const { bytecode } = qrl.artifact(name, buildDir);
  const bytes = sizeOf(bytecode);
  if (bytes <= DIRECT_DEPLOY_LIMIT) return client.deploy(name, args, buildDir);

  if (!CHUNK_SAFE.has(name)) {
    throw new Error(
      `${name} is ${bytes} bytes and has not been declared safe to create through ChunkedDeployer: ` +
        'it may take its wiring authority from msg.sender (see scripts/lib/chunked.js)',
    );
  }
  if (!chunked) throw new Error(`${name} is ${bytes} bytes and needs a ChunkedDeployer; none was given`);

  const deployer = iface('ChunkedDeployer', buildDir);
  // Only the account that created a ChunkedDeployer can use it (audit D19): a
  // deployer shared between accounts would let one of them advance its CREATE
  // nonce and move the addresses the other's plan expects. Asked before any
  // piece is sent, so a deployment handed somebody else's deployer fails for
  // the price of one call rather than a refused append.
  const [owner] = await client.call(chunked, deployer, 'owner', []);
  if (toHex(String(owner)) !== toHex(String(client.address))) {
    throw new Error(`${name}: the ChunkedDeployer at ${chunked} belongs to ${owner}, not to ${client.address}; each deploying account creates its own`);
  }
  const codeHash = keccak256(bytecode);
  // One upload id per code hash: a retry after a failed create reuses the pieces
  // already on chain rather than sending them again.
  const uploadId = codeHash;
  const parts = pieces(bytecode);

  // Resume rather than restart, but only over pieces that are exactly this
  // code's, in this order. The upload id is the code hash, yet that says what
  // the upload was meant to be, not what landed: a piece re-sent after an
  // attempt that did mine sits there twice. Each piece on chain is compared by
  // hash; the first that differs, or a surplus, clears the upload and it is
  // sent again from the start.
  const [have] = await client.call(chunked, deployer, 'piecesOf', [client.address, uploadId]);
  let done = Number(have);
  let intact = done <= parts.length;
  for (let i = 0; intact && i < done; i++) {
    const [h] = await client.call(chunked, deployer, 'pieceHash', [client.address, uploadId, i]);
    intact = h === keccak256(parts[i]);
  }
  if (!intact) {
    log(`   ${name}: the ${done} pieces on chain are not this code's; clearing the upload`);
    await client.send(chunked, deployer, 'clear', [uploadId]);
    done = 0;
  }
  for (let i = done; i < parts.length; i++) {
    await client.send(chunked, deployer, 'append', [uploadId, parts[i]]);
    log(`   ${name} piece ${i + 1}/${parts.length}`);
  }

  // On the QRL (v3) leg the constructor arguments are 64-byte words, which
  // ethers cannot produce, and the Deployed log is a QIP-55 log the manual
  // decoder reads; the harness and EVM paths keep the 32-byte coder. A decode
  // failure on a matched signature throws out of decodeQrlLogs — it is never
  // swallowed the way parseLogs swallows another contract's event.
  const onQrl = client.kind === 'qrl';
  const abi = iface(name, buildDir);
  const ctorArgs = onQrl ? qrlEncodeDeploy(abi, args) : abi.encodeDeploy(args);
  const receipt = await client.send(chunked, deployer, 'deploy', [uploadId, codeHash, ctorArgs]);
  const [ev] = (onQrl ? decodeQrlLogs(QRL_EVENTS.ChunkedDeployer, receipt.logs) : parseLogs(deployer, receipt.logs)).filter((e) => e.name === 'Deployed');
  if (!ev) throw new Error(`${name}: ChunkedDeployer emitted no Deployed event`);
  log(`   ${name} created from ${parts.length} pieces (${bytes} bytes)`);
  // Hex at the chain's own width: the QIP-55 decoder returns the created
  // address Q+128, `client.deploy`'s contract is the 0x form.
  return onQrl ? toHex(ev.args.deployed) : String(ev.args.deployed).toLowerCase();
}

module.exports = { DIRECT_DEPLOY_LIMIT, PIECE_BYTES, CHUNK_SAFE, deployLarge, pieces, sizeOf };
