/**
 * Where the validators `npm run deploy` funded stand, on both layers.
 *
 *   npm run delegation:status
 *
 * The one rule this script exists to report on: **a validator funded by
 * ArkBondDelegation is a real validator of the enclave's beacon chain,
 * withdrawing to the delegation contract.** `npm run deploy` can only show the
 * execution-layer half — the deposit contract accepted the deposit — because the
 * beacon chain reads deposits after the execution follow distance (512 blocks,
 * about 1.7 hours at 12-second slots) and a voting period (16 epochs of 128
 * slots, about 6.8 hours), and activates them only once finalised. So this is
 * run afterwards, as often as wanted, and exits non-zero if a funded validator
 * ever appears with withdrawal credentials that do not name the contract.
 */
const fs = require('fs');
const path = require('path');
const { connect, ROOT } = require('./qrl');

async function main() {
  const { web3, env } = connect();
  const file = path.join(ROOT, 'deployments', 'private.json');
  if (!fs.existsSync(file)) throw new Error('no deployments/private.json — run npm run deploy first');
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const delegation = dep.delegation;
  if (!delegation) throw new Error('the last deployment funded no validator');

  const beacon = env.QRL_BEACON_URL;
  if (!beacon) throw new Error('QRL_BEACON_URL missing from .env (kurtosis-up.sh writes it)');

  const head = await (await fetch(`${beacon}/qrl/v1/beacon/headers/head`)).json();
  const slot = Number(head.data.header.message.slot);
  const block = await web3.qrl.getBlockNumber();
  console.log(`execution block ${block}, beacon slot ${slot} (epoch ${Math.floor(slot / 128)})`);
  console.log(`delegation ${delegation.address}, credentials ${delegation.withdrawalCredentials}\n`);

  let bad = 0;
  for (const v of delegation.validators) {
    const res = await fetch(`${beacon}/qrl/v1/beacon/states/head/validators/${v.pubkey}`);
    const age = Number(block) - Number(v.depositBlock);
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    const d = body.data;
    // qrysm answers an unknown validator with a 4xx rather than a 404 alone.
    if (!d || !d.validator) {
      console.log(`   ${v.pubkey.slice(0, 18)}…  not yet in the beacon state (deposit ${age} blocks ago, HTTP ${res.status}; the follow distance is 512)`);
      continue;
    }
    const creds = d.validator.withdrawal_credentials;
    const ok = creds.toLowerCase() === delegation.withdrawalCredentials.toLowerCase();
    if (!ok) bad += 1;
    console.log(
      `   ${v.pubkey.slice(0, 18)}…  index ${d.index}  ${d.status}  balance ${Number(BigInt(d.balance)) / 1e9} QRL  ` +
        `withdraws to the contract: ${ok ? 'yes' : 'NO'}`,
    );
  }
  if (bad) {
    console.error(`\n${bad} validator(s) withdraw somewhere other than the delegation contract`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
