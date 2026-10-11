/**
 * Keeps the rehearsal-v3 Hardhat node's clock on wall time: an empty block
 * every 12 s, as Hoodi's slot would make one. Hardhat stamps a mined block
 * with the current time, so both legs agree on the epoch (`ts / EPOCH_LENGTH`)
 * even when nobody sends to the origin chain. See hardhat.config.cjs.
 *
 *   node ecdsa-stakings/rehearsal-v3/ticker.js [--url http://127.0.0.1:8548]
 */
const i = process.argv.indexOf('--url');
const url = i >= 0 ? process.argv[i + 1] : 'http://127.0.0.1:8548';

async function mine() {
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) });
  } catch (e) {
    console.error(`ticker: ${e.message}`);
  }
}

setInterval(mine, 12_000);
mine();
