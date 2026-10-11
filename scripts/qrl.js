/**
 * QRL Zond (Hyperion) connection helpers.
 *
 * Notes on this chain that differ from a stock EVM setup:
 *  - Addresses are 64 bytes (QIP-55, testnet v3), rendered as `Q` + 128 hex,
 *    not `0x`. The first 20 bytes coincide with the pre-v3 short form, so a
 *    wallet keeps its identity across the format change.
 *  - Signatures are ML-DSA-87 (post-quantum), not secp256k1. There is no
 *    private key in the ECDSA sense; accounts come from a 34-word mnemonic
 *    -> 51-byte extended seed.
 *  - The RPC exposes a `qrl_*` namespace instead of `eth_*`.
 *    @theqrl/web3@1.0.x is the release line matching both the namespace and the
 *    64-byte address format (0.5.x was the 20-byte line).
 *
 * Adapted from infra/devnet's scripts/qrl.js, which is the reference
 * implementation for this toolchain on testnet v3.
 */
const fs = require('fs');
const path = require('path');
const { Web3 } = require('@theqrl/web3');
const { MLDSA87 } = require('@theqrl/wallet.js');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  // `ARK_ENV_FILE` names another file in the repository's .env format: the
  // reference solver's service reads its own (/etc/ark-staking/solver.env),
  // which holds its keys and none of the relayer's.
  const file = process.env.ARK_ENV_FILE || path.join(ROOT, '.env');
  if (!fs.existsSync(file)) {
    throw new Error(process.env.ARK_ENV_FILE ? `ARK_ENV_FILE ${file} missing` : '.env missing — copy .env.example and fill in DEPLOYER_MNEMONIC');
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    // The key class accepts digits: QRL_RPC_URL sits beside keys like
    // HOODI_VPS_OTS_SEED and EIP-numbered flags, none of which may be dropped.
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  // `ARK_SIGNER=TESTER` signs with `TESTER_MNEMONIC` from this same file. The key
  // never comes from the shell, only the choice of which one: a run beside the
  // VPS relayer must not send from its account, or the two collide on the nonce
  // (CLAUDE.md §4.3, "one account per running relayer").
  const pick = process.env.ARK_SIGNER;
  if (pick) {
    const key = `${pick.toUpperCase()}_MNEMONIC`;
    if (!env[key]) throw new Error(`ARK_SIGNER=${pick} but ${key} is not in .env`);
    env.DEPLOYER_MNEMONIC = env[key];
  }
  return env;
}

/**
 * Refuses to connect to anything but a private network.
 *
 * Deploying throwaway iterations to the shared public testnet leaves permanent
 * contract litter, so the guard is here rather than in a comment. Override with
 * ALLOW_PUBLIC_RPC=1 in .env only when a public deployment is genuinely wanted.
 */
function assertPrivate(env) {
  if (env.ALLOW_PUBLIC_RPC === '1') return;
  const url = env.QRL_RPC_URL || '';
  const isLocal =
    /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url);
  if (!isLocal) {
    throw new Error(
      `QRL_RPC_URL "${url}" is not a private network.\n` +
        'Point it at a local enclave (see CLAUDE.md section 4), or set ALLOW_PUBLIC_RPC=1 to override.',
    );
  }
}

/**
 * `mnemonicKey` names another mnemonic of the same .env to sign with — the
 * relayer's `QRL_SEALER_MNEMONIC`, so the attestation sealer can be an account
 * other than the one that deploys and relays (audit 2026-09-27, D2).
 */
function connect({ mnemonicKey = 'DEPLOYER_MNEMONIC', extendedSeed } = {}) {
  const env = loadEnv();
  if (!extendedSeed && !env[mnemonicKey]) throw new Error(`${mnemonicKey} missing from .env`);
  assertPrivate(env);

  const web3 = new Web3(env.QRL_RPC_URL);
  // An e2e actor (scripts/e2e/lib.js) arrives as its derived extended seed.
  const seed = extendedSeed || MLDSA87.newWalletFromMnemonic(env[mnemonicKey]).getHexExtendedSeed();
  const account = web3.qrl.accounts.seedToAccount(seed);
  web3.qrl.accounts.wallet.add(account);

  return { web3, account, env };
}

/**
 * A compiled artifact. `buildDir` defaults to hypc's output; the origin-chain
 * leg's solc output lives under ecdsa-stakings/<chain>/build and is passed
 * explicitly, so the two toolchains are never read from one directory.
 */
function artifact(name, buildDir = path.join(ROOT, 'build')) {
  return JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.json`), 'utf8'));
}

/**
 * Signs locally and submits via qrl_sendRawTransaction.
 *
 * A contract built as `new Contract(abi, address)` is not bound to the local
 * wallet, so web3 would otherwise fall back to `qrl_sendTransaction` and ask the
 * node to sign. Signing explicitly avoids depending on that distinction.
 *
 * The nonce is the pool's, not the chain's. On the devnet this key is also the
 * QRL faucet's operator, and a `'latest'` nonce read while the faucet has a
 * transaction pending replaces that transaction rather than following it.
 */
async function sendRaw(web3, account, { to, data, value = 0n, gas }) {
  const [nonce, chainId, block] = await Promise.all([
    web3.qrl.getTransactionCount(account.address, 'pending'),
    web3.qrl.getChainId(),
    web3.qrl.getBlock('latest'),
  ]);

  const baseFee = BigInt(block.baseFeePerGas || 7);
  const tip = 1_000_000_000n;

  const signed = await account.signTransaction({
    to,
    data,
    value: value.toString(),
    gas,
    nonce: Number(nonce),
    chainId: Number(chainId),
    type: 2,
    maxPriorityFeePerGas: tip.toString(),
    maxFeePerGas: (baseFee * 2n + tip).toString(),
  });

  return web3.qrl.sendSignedTransaction(signed.rawTransaction);
}

async function deploy(web3, account, name, args = [], gas = 6_000_000, buildDir) {
  const art = artifact(name, buildDir);
  const instance = new web3.qrl.Contract(art.abi);
  const deployed = await instance
    .deploy({ data: art.bytecode, arguments: args })
    .send({ from: account.address, gas, type: 2 });
  return deployed;
}

function creationCode(web3, name, args = []) {
  const art = artifact(name);
  const instance = new web3.qrl.Contract(art.abi);
  return instance.deploy({ data: art.bytecode, arguments: args }).encodeABI();
}

function saveDeployment(name, data) {
  const dir = path.join(ROOT, 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
  return path.join(dir, `${name}.json`);
}

module.exports = { connect, artifact, deploy, sendRaw, creationCode, saveDeployment, loadEnv, ROOT };
