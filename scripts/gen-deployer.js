/**
 * Generates a fresh ML-DSA-87 deployer wallet and records it in .env.
 *
 * Why generate rather than reuse the network's prefunded accounts: the QRL
 * Kurtosis package inherits its genesis account table from the upstream
 * ethereum-package, so `prefunded_accounts` there carries 32-byte secp256k1
 * seeds. A QRL Zond account is ML-DSA-87 and derives from a 51-byte extended
 * seed, so those seeds cannot be signed with. Instead we mint our own wallet
 * and have kurtosis-up.sh fund its address at genesis.
 *
 * On @theqrl/web3 1.0.x (QIP-55, testnet v3) `seedToAccount(...).address` is
 * the 64-byte form, Q + 128 hex. The first 40 hex equal the address the same
 * mnemonic had on the 0.5.x line, so rerunning this against an existing .env
 * extends DEPLOYER_ADDRESS in place without changing the wallet's identity —
 * the mnemonic is kept, only the rendering grows.
 *
 * The mnemonic is written to .env only. .env is gitignored and must stay that
 * way -- it is the deployer secret.
 */
const fs = require('fs');
const path = require('path');
const { MLDSA87 } = require('@theqrl/wallet.js');
const { Web3 } = require('@theqrl/web3');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');

/** Rewrites one KEY="value" line in place, appending it when absent. */
function upsert(text, key, value) {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return (text.endsWith('\n') || text === '' ? text : text + '\n') + line + '\n';
}

function main() {
  const force = process.argv.includes('--force');

  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const existing = env.match(/^\s*DEPLOYER_MNEMONIC\s*=\s*"?(.+?)"?\s*$/m);

  if (existing && !existing[1].startsWith('<') && !force) {
    const wallet = MLDSA87.newWalletFromMnemonic(existing[1]);
    const address = new Web3().qrl.accounts.seedToAccount(wallet.getHexExtendedSeed()).address;
    console.log('.env already holds a deployer; reusing it.');
    console.log(`  address ${address}`);
    console.log('  pass --force to replace it (the old key becomes unrecoverable)');
    writeAddress(env, address);
    return;
  }

  const wallet = MLDSA87.newWallet();
  const mnemonic = wallet.getMnemonic().trim();
  const address = new Web3().qrl.accounts.seedToAccount(wallet.getHexExtendedSeed()).address;

  if (!env) {
    const example = path.join(ROOT, '.env.example');
    env = fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '';
  }
  env = upsert(env, 'DEPLOYER_MNEMONIC', mnemonic);
  env = upsert(env, 'DEPLOYER_ADDRESS', address);
  fs.writeFileSync(ENV, env);

  console.log('generated a new ML-DSA-87 deployer');
  console.log(`  address  ${address}`);
  console.log(`  mnemonic ${mnemonic.split(/\s+/).length} words -> .env (never commit it)`);
  console.log('\nnext: npm run net:up   (funds this address at genesis)');
}

/** Keeps DEPLOYER_ADDRESS in sync so kurtosis-up.sh can read it without the seed. */
function writeAddress(env, address) {
  fs.writeFileSync(ENV, upsert(env, 'DEPLOYER_ADDRESS', address));
}

main();
