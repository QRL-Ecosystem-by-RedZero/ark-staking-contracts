/**
 * The seeding deposit of one escrow on a testnet-profile origin chain.
 *
 *   npm run seed:escrow -- --chain hoodi-vps --asset stETH [--signer hoodi]
 *
 * `--signer <name>` signs with `<NAME>_PRIVATE_KEY` / `<NAME>_MNEMONIC` instead
 * of the chain's own key, on the same chain id. The chain's own key is usually
 * the account a running relayer pays gas from, and a second sender on that
 * account collides with it on the nonce (CLAUDE.md §4.3).
 *
 * `anchor` refuses until `SEED_MINIMUM` has been seeded (whitepaper §4.2), so an
 * escrow nobody seeded cannot be anchored into at all. This seeds exactly the
 * shortfall — plus a few wei on a rebasing asset, whose share rounding would
 * otherwise leave `seededUnits` a wei below the minimum — and nothing when the
 * escrow is already seeded. The asset comes from `scripts/lib/assets.js`:
 * minted for a double, staked through Lido for stETH.
 *
 * A seed cannot be withdrawn: no function takes it back out of the buffer.
 */
const { originClient, evmClient, iface } = require('./lib/chains');
const { supply, REBASE_MARGIN } = require('./lib/assets');
const { toHex } = require('../ecdsa-stakings/relayer/lib/addresses');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const chain = arg('chain');
  const symbol = arg('asset');
  if (!chain || !symbol) throw new Error('usage: npm run seed:escrow -- --chain <name> --asset <symbol>');
  const origin = await originClient(chain);
  const { manifest: m, build } = origin;
  const signer = arg('signer');
  if (signer && m.client !== 'evm') throw new Error('--signer is for an EVM origin chain');
  // Same manifest, so the chain id is checked against it before anything is
  // signed; only the key (and the RPC URL read beside it) comes from `signer`.
  const client = signer ? evmClient({ ...m, name: signer }) : origin.client;
  await client.chainId();
  const a = m.assets.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`${chain} lists no asset ${symbol}; it lists ${m.assets.map((x) => x.symbol).join(', ')}`);
  if (!a.escrow) throw new Error(`${chain} ${symbol} has no escrow yet — run deploy:evm first`);

  const escrow = toHex(a.escrow);
  const asset = toHex(a.address);
  const abi = iface(a.rebasing ? 'ArkStakeEscrowShares' : 'ArkStakeEscrowUnits', build);
  const tokenAbi = iface(a.mock || (a.rebasing ? 'MockRebasingAsset' : 'MockAsset'), build);
  const view = async (fn) => (await client.call(escrow, abi, fn))[0];

  const minimum = await view('SEED_MINIMUM');
  const seeded = await view('seededUnits');
  console.log(`${chain} ${symbol}  escrow ${escrow}  seeded ${seeded} of ${minimum}  from ${client.address}`);
  if (seeded >= minimum) {
    console.log('already seeded; nothing sent');
    return;
  }

  const amount = minimum - seeded + (a.rebasing ? REBASE_MARGIN : 0n);
  const got = await supply(client, { ...a, address: asset }, amount, tokenAbi);
  if (got) console.log(`   acquired ${got} ${symbol}${a.mock ? ' (minted, test double)' : ` (staked through ${a.source})`}`);
  await client.send(asset, tokenAbi, 'approve', [escrow, amount]);
  await client.send(escrow, abi, 'seed', [amount]);

  const after = await view('seededUnits');
  if (after < minimum) throw new Error(`seeded ${after} of ${minimum} after sending ${amount}; run again for the rest`);
  console.log(`   seeded ${amount}; seededUnits ${after} >= ${minimum}, anchoring is open (whitepaper §4.2)`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
