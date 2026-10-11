/**
 * A Hardhat node for the origin leg's stress run — never a compiler here.
 *
 *   npx hardhat node --config ecdsa-stakings/stress/hardhat.config.cjs --port 8546
 *   FORK_URL=<hoodi rpc> npx hardhat node --config ecdsa-stakings/stress/hardhat.config.cjs --port 8546
 *
 * The artifacts are solc's, from scripts/compile-evm.js, deployed by the stress
 * run over JSON-RPC; Hardhat only runs the chain. Port 8546, because 8545 is the
 * SSH tunnel to the QRL devnet on this machine. Forked, the chain is Hoodi at
 * its latest block with the real stETH at 0x3508…176a, and keeps Hoodi's chain
 * id so every identifier the escrow derives from `block.chainid` is Hoodi's.
 */
const fork = process.env.FORK_URL;

module.exports = {
  paths: { root: __dirname, sources: __dirname + '/.none', cache: __dirname + '/.cache', artifacts: __dirname + '/.artifacts' },
  networks: {
    hardhat: {
      chainId: fork ? 560048 : 31337,
      hardfork: 'shanghai',
      // Deterministic, so a failing seed replays against the same chain.
      initialDate: fork ? undefined : '2026-01-01T00:00:00Z',
      // Hoodi enforces the EIP-7825 per-transaction cap (16,777,216), and Hardhat
      // gives an eth_call the block limit as its gas, so a forked block stays under it.
      blockGasLimit: fork ? 16_000_000 : 60_000_000,
      allowUnlimitedContractSize: false,
      mining: { auto: true },
      accounts: { count: 20 },
      forking: fork ? { url: fork, enabled: true } : undefined,
    },
  },
};
