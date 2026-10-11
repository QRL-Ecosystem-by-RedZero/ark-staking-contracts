/**
 * The origin leg of the `rehearsal-v3` manifest: a Hardhat node on this
 * machine, with the QRL leg on the v3 (QIP-55) devnet enclave.
 *
 *   npx hardhat node --config ecdsa-stakings/rehearsal-v3/hardhat.config.cjs --port 8548
 *
 * The old `rehearsal` manifest ran both legs on the enclave; since the devnet
 * moved to QRVM (512-bit words, 64-byte addresses) solc's EVM bytecode no
 * longer runs there, so the origin leg is a real EVM here instead (audit
 * 2026-10-03). Unlike the stress node it keeps wall-clock time: block
 * timestamps must agree with the QRL leg's, because both legs count epochs as
 * `timestamp / EPOCH_LENGTH`. Automine only: with interval mining on as well,
 * Hardhat answers a stale `pending` nonce and the second deployment reverts
 * "nonce too low" (seen 2026-10-03). The clock is kept moving with no traffic
 * by `ecdsa-stakings/rehearsal-v3/ticker.js`, which mines an empty block every
 * 12 s. Port 8548: 8545 is the SSH tunnel to the devnet, 8546/8547 the stress
 * nodes; a second node for reruns serves 8549.
 */
module.exports = {
  paths: { root: __dirname, sources: __dirname + '/.none', cache: __dirname + '/.cache', artifacts: __dirname + '/.artifacts' },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: 'shanghai',
      blockGasLimit: 30_000_000,
      allowUnlimitedContractSize: false,
      mining: { auto: true },
      // Without it every block is at least one second after the last, so ten
      // lanes automining ran the origin clock 490 s ahead of wall time, more
      // than an epoch, and cross-chain timing assertions failed for that alone
      // (2026-10-03). Real chains' clocks agree within seconds.
      allowBlocksWithSameTimestamp: true,
      accounts: { count: 20 },
    },
  },
};
