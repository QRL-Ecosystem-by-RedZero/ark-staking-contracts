/**
 * Validator deposit data for the private enclave, written by qrysm's own tool.
 *
 * The one rule this module exists to enforce: **a deposit the delegation
 * contract funds is produced by the chain's own tooling, naming that contract
 * as its withdrawal address** — never assembled here, where a wrong SSZ root
 * or a wrong fork version would be a bug in this repository rather than a
 * refusal by the chain.
 *
 * `deposit new-seed` runs from the genesis-generator image the enclave was
 * built with, `--chain-name dev`, whose fork version is the enclave's
 * GENESIS_FORK_VERSION (0x10000038). It writes a keystore per validator as well
 * as the deposit data. The keystores are kept under `.kurtosis/` (gitignored)
 * so a validator could be imported into the enclave's validator client; they
 * protect nothing of value and are never committed.
 *
 * The image is the QIP-55 (testnet v3) generator, matching kurtosis-up.sh's
 * IMAGE_TAG=v3 default: its `deposit` tool takes only 64-byte addresses, so
 * the `--execution-address` handed in here is the Q+128 form. On a v2
 * rollback (IMAGE_TAG=main) pass the 20-byte-era image instead:
 * qrledger/qrysm:qrl-genesis-generator-latest, whose tool is the reverse,
 * 20-byte only.
 *
 * Docker is invoked from the host rather than from WSL: Docker Desktop cannot
 * mount a `/mnt/<drive>` path given from inside the distro.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const IMAGE = 'qrledger/qrysm:qrl-genesis-generator-main-linux-amd64';

/**
 * Generate `count` validators whose withdrawal credentials name
 * `executionAddress` (Q form). Returns the deposit data records, each with
 * 0x-prefixed hex fields, and the directory holding the keystores.
 */
function generateDeposits(root, executionAddress, count, label = 'run') {
  const dir = path.join(root, '.kurtosis', 'deposits', `${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pw.txt'), crypto.randomBytes(16).toString('hex'));

  const res = spawnSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${dir}:/data`,
      '--entrypoint', '/usr/local/bin/deposit',
      IMAGE,
      'new-seed',
      '--num-validators', String(count),
      '--folder', '/data/keys',
      '--chain-name', 'dev',
      '--execution-address', executionAddress,
      '--keystore-password-file', '/data/pw.txt',
      '--lightkdf',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`qrysm deposit tool failed (${res.status}): ${(res.stderr || res.stdout || '').slice(-500)}`);
  }
  // The tool prints the validator seed and mnemonic; keep them with the
  // keystores rather than in a log.
  fs.writeFileSync(path.join(dir, 'tool-output.txt'), res.stdout);

  const keys = path.join(dir, 'keys');
  const file = fs.readdirSync(keys).find((f) => f.startsWith('deposit_data'));
  const hex = (v) => (String(v).startsWith('0x') ? String(v) : `0x${v}`);
  const records = JSON.parse(fs.readFileSync(path.join(keys, file), 'utf8')).map((d) => ({
    pubkey: hex(d.pubkey),
    withdrawal_credentials: hex(d.withdrawal_credentials),
    amount: BigInt(d.amount),
    signature: hex(d.signature),
    deposit_data_root: hex(d.deposit_data_root),
    fork_version: d.fork_version,
  }));
  return { dir, records };
}

module.exports = { generateDeposits, IMAGE };
