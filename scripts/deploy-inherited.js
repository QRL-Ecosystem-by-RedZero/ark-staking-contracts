/**
 * Deploys the three contracts inherited from NFT Insurance — ArkToken, VeArk
 * and StakingVault (CLAUDE.md §0 and §8.2) — on the private network, then
 * exercises them with real ML-DSA-87 signed transactions. They are not Ark
 * Staking; `npm run deploy` deploys that.
 *
 *   npm run deploy:inherited
 *
 * The ZVM harness in test/ proves the logic. This proves the deployment: that
 * every contract fits in a single transaction, that the wiring holds against a
 * real gqrl node, and that the one property the local suite cannot demonstrate
 * on a live chain — stake staying slashable while it unbonds — behaves the same
 * way here.
 *
 * WHAT THIS SCRIPT CANNOT CHECK, AND WHY
 * --------------------------------------
 * A live chain has no `advanceTime`. The 21-day unbonding release and the
 * four-year vesting curve therefore cannot be walked here; they are covered in
 * test/StakingVault.test.js and test/ArkToken.test.js against the harness. What
 * IS checked live is the half that matters for a deployment: that the exit is
 * refused before its deadline, and that a slash lands on stake mid-exit.
 */
const { connect, artifact, deploy, sendRaw, saveDeployment } = require('./qrl');

const ONE = 10n ** 18n;
const TIER_NOAH = 0;
const YEAR = 365 * 24 * 60 * 60;

/**
 * Placeholder holders for the two vesting buckets.
 *
 * Nothing signs from these; they exist so the deployer keeps the unlocked
 * incentives bucket and the vesting logic is exercised against addresses whose
 * allocation really is locked.
 */
const CONTRIBUTORS = 'Q' + '1'.repeat(40);
const BACKERS = 'Q' + '2'.repeat(40);

function log(label, receipt) {
  console.log(`   ${label.padEnd(26)} block ${receipt.blockNumber}  gas ${receipt.gasUsed}`);
  return BigInt(receipt.gasUsed);
}

async function main() {
  const { web3, account, env } = connect();
  const chainId = await web3.qrl.getChainId();
  const me = account.address;

  console.log(`network  ${env.QRL_RPC_URL}  chainId ${chainId}`);
  console.log(`deployer ${me}\n`);

  const now = Number((await web3.qrl.getBlock('latest')).timestamp);
  const gas = {};

  // ---------------------------------------------------------------- deploy
  console.log('deploying');

  const ark = await deploy(web3, account, 'ArkToken', [
    me, // incentives  35%, unlocked, the bucket this script spends from
    me, // treasury    20%
    CONTRIBUTORS, // 18%, vesting
    BACKERS, // 12%, vesting
    me, // backstop    10%
    me, // liquidity    5%
    now,
  ]);
  console.log(`   ArkToken           ${ark.options.address}`);

  const veArk = await deploy(web3, account, 'VeArk', [ark.options.address]);
  console.log(`   VeArk              ${veArk.options.address}`);

  const vault = await deploy(web3, account, 'StakingVault', [
    ark.options.address,
    veArk.options.address,
  ]);
  console.log(`   StakingVault       ${vault.options.address}\n`);

  // ------------------------------------------------------------------ wire
  //
  // The deployer stands in for the court here. DisputeCourt is not built yet,
  // and `setDisputeCourt` is one-shot by design, so on a real launch this call
  // is the last chance to name the right address — see CLAUDE.md.
  console.log('wiring');
  gas.setDisputeCourt = log(
    'setDisputeCourt',
    await sendRaw(web3, account, {
      to: vault.options.address,
      data: vault.methods.setDisputeCourt(me).encodeABI(),
      gas: 120_000,
    }),
  );

  // ------------------------------------------------------------- ArkToken
  console.log('\nArkToken');
  const supply = BigInt(await ark.methods.totalSupply().call());
  const mine = BigInt(await ark.methods.balanceOf(me).call());
  const lockedContrib = BigInt(await ark.methods.lockedOf(CONTRIBUTORS).call());

  console.log(`   totalSupply        ${supply / ONE} ARK`);
  console.log(`   deployer balance   ${mine / ONE} ARK  (incentives+treasury+backstop+liquidity)`);
  console.log(`   contributor locked ${lockedContrib / ONE} ARK  (pre-cliff, must equal 18%)`);
  if (lockedContrib !== (supply * 1800n) / 10000n) throw new Error('contributor bucket not fully locked');
  if (BigInt(await ark.methods.vestedBalanceOf(CONTRIBUTORS).call()) !== 0n) {
    throw new Error('unvested allocation reported as vested');
  }

  gas.delegate = log(
    'delegate (self)',
    await sendRaw(web3, account, {
      to: ark.options.address,
      data: ark.methods.delegate(me).encodeABI(),
      gas: 200_000,
    }),
  );
  const votes = BigInt(await ark.methods.getVotes(me).call());
  console.log(`   votes after        ${votes / ONE} ARK`);
  if (votes !== mine) throw new Error('vested weight did not activate on delegation');

  // ---------------------------------------------------------------- VeArk
  console.log('\nVeArk');
  gas.approveVe = log(
    'approve veARK',
    await sendRaw(web3, account, {
      to: ark.options.address,
      data: ark.methods.approve(veArk.options.address, (10_000n * ONE).toString()).encodeABI(),
      gas: 120_000,
    }),
  );
  gas.createLock = log(
    'createLock (4y)',
    await sendRaw(web3, account, {
      to: veArk.options.address,
      data: veArk.methods.createLock((10_000n * ONE).toString(), now + 4 * YEAR).encodeABI(),
      // Two extra cold SSTOREs since the dividend index landed: _units and
      // _rewardDebt. The old 300k ceiling put this just over the line.
      gas: 500_000,
    }),
  );
  const boost = Number(await veArk.methods.boostBpsOf(me).call());
  console.log(`   boost              ${boost} bps  (40000 = 4x)`);
  if (boost < 39_000) throw new Error(`expected close to 4x, got ${boost}`);

  // The 5% premium slice that tokenomics assigns to lockers, in native QRL.
  // On a live protocol the caller is CapitalPool, which sits in the insurance
  // repository; here the deployer pays it directly.
  gas.distributeDividend = log(
    'distributeDividend 5',
    await sendRaw(web3, account, {
      to: veArk.options.address,
      data: veArk.methods.distributeDividend().encodeABI(),
      value: 5n * ONE,
      gas: 300_000,
    }),
  );
  const due = BigInt(await veArk.methods.pendingDividend(me).call());
  const dust = BigInt(await veArk.methods.carriedDust().call());
  console.log(`   dividend due       ${due} wei  (sole locker takes the whole slice)`);
  console.log(`   carried dust       ${dust} wei  (goes into the next round)`);
  // Not an equality check: the boost lands on 39,999 bps rather than a round
  // 40,000, so the index division leaves a remainder by construction. What must
  // hold is that nothing escapes -- paid plus carried equals what was sent.
  if (due + dust !== 5n * ONE) throw new Error(`dividend leaked: due ${due} + dust ${dust}`);

  gas.claimDividend = log(
    'claimDividend',
    await sendRaw(web3, account, {
      to: veArk.options.address,
      data: veArk.methods.claimDividend().encodeABI(),
      gas: 300_000,
    }),
  );
  if (BigInt(await veArk.methods.pendingDividend(me).call()) !== 0n) {
    throw new Error('dividend still owed after claim');
  }
  console.log('   claimed, nothing left owed');

  // --------------------------------------------------------- StakingVault
  console.log('\nStakingVault');
  gas.registerOperator = log(
    'registerOperator',
    await sendRaw(web3, account, {
      to: vault.options.address,
      data: vault.methods.registerOperator(TIER_NOAH, 1000).encodeABI(),
      gas: 200_000,
    }),
  );
  gas.approveVault = log(
    'approve vault',
    await sendRaw(web3, account, {
      to: ark.options.address,
      data: ark.methods.approve(vault.options.address, (100_000n * ONE).toString()).encodeABI(),
      gas: 120_000,
    }),
  );
  gas.stake = log(
    'stake 100k',
    await sendRaw(web3, account, {
      to: vault.options.address,
      data: vault.methods.stake(TIER_NOAH, me, (100_000n * ONE).toString()).encodeABI(),
      gas: 400_000,
    }),
  );
  console.log(`   tier stake         ${BigInt(await vault.methods.totalStaked(TIER_NOAH).call()) / ONE} ARK`);
  console.log(`   draw weight        ${BigInt(await vault.methods.drawWeight(me, TIER_NOAH).call()) / ONE} ARK`);

  // The property this whole exercise exists to confirm on a real node.
  console.log('\n   an exit does not outrun a slash');
  gas.beginUnbonding = log(
    'beginUnbonding 40k',
    await sendRaw(web3, account, {
      to: vault.options.address,
      data: vault.methods.beginUnbonding((40_000n * ONE).toString()).encodeABI(),
      gas: 300_000,
    }),
  );
  const stillStaked = BigInt(await vault.methods.totalStaked(TIER_NOAH).call());
  const exiting = BigInt(await vault.methods.exitingValueOf(me).call());
  console.log(`   tier stake         ${stillStaked / ONE} ARK  (unchanged: still slashable)`);
  console.log(`   exiting            ${exiting / ONE} ARK`);
  if (stillStaked !== 100_000n * ONE) throw new Error('unbonding removed stake from the slashable pool');

  gas.slash = log(
    'slash 50k',
    await sendRaw(web3, account, {
      to: vault.options.address,
      data: vault.methods.slash(me, (50_000n * ONE).toString(), '0x' + 'cd'.repeat(32)).encodeABI(),
      gas: 300_000,
    }),
  );
  const exitingAfter = BigInt(await vault.methods.exitingValueOf(me).call());
  console.log(`   exiting after      ${exitingAfter / ONE} ARK  (halved by the slash)`);
  if (exitingAfter !== 20_000n * ONE) throw new Error(`exiting stake escaped the slash: ${exitingAfter}`);

  console.log('   withdraw before the deadline must revert...');
  let refused = false;
  try {
    await sendRaw(web3, account, {
      to: vault.options.address,
      data: vault.methods.withdraw().encodeABI(),
      gas: 300_000,
    });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error('withdraw succeeded inside the unbonding window');
  console.log('   refused, as it must be');

  // ------------------------------------------------------------------ out
  const out = saveDeployment('private', {
    network: env.QRL_RPC_URL,
    chainId: Number(chainId),
    deployer: me,
    deployedAt: new Date().toISOString(),
    contracts: {
      ArkToken: ark.options.address,
      VeArk: veArk.options.address,
      StakingVault: vault.options.address,
    },
    vestingHolders: { contributors: CONTRIBUTORS, backers: BACKERS },
  });

  console.log('\nlive gas (total, including the 21,000 intrinsic cost and calldata)');
  for (const [k, v] of Object.entries(gas)) console.log(`   ${k.padEnd(20)} ${v}`);
  console.log(`\nsaved -> ${out}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
