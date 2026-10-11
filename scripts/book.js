/**
 * Seed an escrow and anchor into it, by hand.
 *
 *   npm run book -- --chain hoodi-vps --asset mUNIT --seed --anchor 1000
 *   npm run book -- --chain hoodi-vps --yield 40
 *   npm run book -- --chain hoodi-vps            # just report
 *
 * The scenarios of scripts/e2e/ do this inside a rule they are asserting; this
 * does it for a deployment that has to carry a book for someone to look at.
 * Everything it does is permissionless on the escrow: the seeding deposit, an
 * anchor naming a QRL beneficiary, and — for a test double only — minting the
 * yield a real asset would earn on its own.
 *
 * The relayer does the rest: the anchor reaches QRL once its epoch has closed
 * and been sealed, and the sweep divides the yield at the allocation in force.
 */
const { originClient, iface, parseLogs } = require('./lib/chains');
const { qrlClient } = require('./lib/chains');
const { toHex } = require('../ecdsa-stakings/relayer/lib/addresses');

const ONE = 10n ** 18n;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

async function main() {
  const chain = flag('chain');
  if (!chain) throw new Error('usage: npm run book -- --chain <name> [--asset SYM] [--seed] [--anchor N] [--yield N]');
  const { client, manifest, build } = await originClient(chain);

  const symbol = flag('asset');
  const a = manifest.assets.find((x) => x.symbol === symbol) || manifest.assets[0];
  if (!a.escrow) throw new Error(`${chain}: ${a.symbol} has no escrow; deploy the origin leg first`);
  const escrow = toHex(a.escrow);
  const asset = toHex(a.address);
  const escrowAbi = iface(a.rebasing ? 'ArkStakeEscrowShares' : 'ArkStakeEscrowUnits', build);
  const tokenAbi = iface(a.mock || (a.rebasing ? 'MockRebasingAsset' : 'MockAsset'), build);

  const read = async (m, args = []) => (await client.call(escrow, escrowAbi, m, args))[0];
  const token = {
    read: async (m, args = []) => (await client.call(asset, tokenAbi, m, args))[0],
    send: (m, args = []) => client.send(asset, tokenAbi, m, args),
  };

  console.log(`chain    ${chain} (${client.kind})  asset ${a.symbol}  escrow ${escrow}`);

  const supply = async (amount) => {
    if (!a.mock) {
      const held = await token.read('balanceOf', [client.address]);
      if (held < amount) throw new Error(`${a.symbol} is not a test double: need ${amount}, hold ${held}`);
      return;
    }
    await token.send('mint', [client.address, amount]);
  };

  if (has('seed')) {
    const minimum = await read('SEED_MINIMUM');
    const seeded = await read('seededUnits');
    if (seeded >= minimum) console.log(`   seeded already: ${seeded} >= ${minimum}`);
    else {
      const amount = minimum - seeded;
      await supply(amount);
      await token.send('approve', [escrow, amount]);
      await client.send(escrow, escrowAbi, 'seed', [amount]);
      console.log(`   seeded ${amount} units (whitepaper §4.2)`);
    }
  }

  const anchorUnits = flag('anchor');
  if (anchorUnits) {
    const amount = BigInt(anchorUnits) * ONE;
    // The beneficiary is a QRL address, and it is part of the identifier rather
    // than a field beside it (whitepaper §3.2): the position and the account
    // entitled to release it are one object.
    const beneficiary = flag('owner') || qrlClient().address;
    await supply(amount);
    await token.send('approve', [escrow, amount]);
    const receipt = await client.send(escrow, escrowAbi, 'anchor', [beneficiary, amount], { gas: 500_000 });
    const ev = parseLogs(escrowAbi, receipt.logs).find((x) => x.name === 'Anchored');
    console.log(`   anchored ${anchorUnits} ${a.symbol} for ${beneficiary}`);
    console.log(`   stakeAssetId ${ev.args.stakeAssetId}  epoch ${ev.args.epoch}`);
  }

  const yieldUnits = flag('yield');
  if (yieldUnits) {
    if (!a.mock) throw new Error(`${a.symbol} is not a double; its yield arrives on its own`);
    const amount = BigInt(yieldUnits) * ONE;
    if (a.rebasing) await token.send('rebase', [amount]);
    else await token.send('mint', [escrow, amount]);
    console.log(`   ${yieldUnits} units of yield into the escrow`);
  }

  console.log('\nthe escrow now holds');
  for (const m of ['positionShares', 'bufferShares', 'auctionShares', 'queuedShares', 'seededUnits']) {
    console.log(`   ${m.padEnd(16)} ${await read(m)}`);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
