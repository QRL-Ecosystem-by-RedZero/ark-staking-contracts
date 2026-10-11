/**
 * Gas profile of the main Ark Staking flows, measured on the local ZVM harness.
 *
 * Numbers are execution gas only — they exclude the 21000 intrinsic cost and
 * calldata cost, and on the live network they exclude whatever the ML-DSA-87
 * signature and public key add to the transaction envelope. `npm run deploy`
 * prints the live totals for the same flows.
 */
const { Chain, ACCOUNTS } = require('../test/harness');

const ONE = 10n ** 18n;
const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const T1 = 0; // NoahArk

async function fixture() {
  const chain = await Chain.create();
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'address', 'uint64'],
    [
      ACCOUNTS.admin,
      ACCOUNTS.bob,
      ACCOUNTS.attester,
      ACCOUNTS.oracle,
      ACCOUNTS.guardian,
      ACCOUNTS.mallory,
      chain.timestamp,
    ],
  );
  const ve = await chain.deploy('VeArk', ['address'], [ark.address]);
  const vault = await chain.deploy('StakingVault', ['address', 'address'], [ark.address, ve.address]);
  await vault.send('setDisputeCourt', [ACCOUNTS.guardian], { from: ACCOUNTS.admin });
  return { chain, ark, ve, vault };
}

async function main() {
  const rows = [];
  const record = (label, res) => rows.push([label, Number(res.gasUsed)]);

  // ARK: the transfer/delegate path a staker walks before they can stake.
  {
    const { ark } = await fixture();
    record(
      'transfer (cold recipient)',
      await ark.send('transfer', [ACCOUNTS.alice, 100_000n * ONE], { from: ACCOUNTS.admin }),
    );
    record('delegate (self)', await ark.send('delegate', [ACCOUNTS.admin], { from: ACCOUNTS.admin }));
    record('syncVotingWeight', await ark.send('syncVotingWeight', [ACCOUNTS.admin], { from: ACCOUNTS.alice }));
  }

  // veARK: the lock that boosts jury weight and earns the dividend.
  {
    const { chain, ark, ve } = await fixture();
    await ark.send('transfer', [ACCOUNTS.alice, 100_000n * ONE], { from: ACCOUNTS.admin });
    await ark.send('approve', [ve.address, 10n ** 30n], { from: ACCOUNTS.alice });

    record(
      'createLock (4y)',
      await ve.send('createLock', [10_000n * ONE, chain.timestamp + BigInt(4 * YEAR)], { from: ACCOUNTS.alice }),
    );
    record(
      'increaseAmount',
      await ve.send('increaseAmount', [1_000n * ONE], { from: ACCOUNTS.alice }),
    );
    record(
      'distributeDividend',
      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 5n * ONE }),
    );
    record('claimDividend', await ve.send('claimDividend', [], { from: ACCOUNTS.alice }));
  }

  // StakingVault: register, stake, exit, and the slash that the exit cannot outrun.
  {
    const { ark, vault } = await fixture();
    for (const who of [ACCOUNTS.alice, ACCOUNTS.bob]) {
      await ark.send('transfer', [who, 100_000n * ONE], { from: ACCOUNTS.admin });
      await ark.send('approve', [vault.address, 10n ** 30n], { from: who });
    }

    record('registerOperator', await vault.send('registerOperator', [T1, 1000], { from: ACCOUNTS.bob }));
    record(
      'stake (first into a pool)',
      await vault.send('stake', [T1, ACCOUNTS.bob, 50_000n * ONE], { from: ACCOUNTS.bob }),
    );
    record(
      'stake (delegator joins)',
      await vault.send('stake', [T1, ACCOUNTS.bob, 50_000n * ONE], { from: ACCOUNTS.alice }),
    );
    record(
      'distributeRewards',
      await vault.send('distributeRewards', [T1], { from: ACCOUNTS.admin, value: 10n * ONE }),
    );
    record('claimRewards', await vault.send('claimRewards', [], { from: ACCOUNTS.alice }));
    record(
      'beginUnbonding',
      await vault.send('beginUnbonding', [20_000n * ONE], { from: ACCOUNTS.alice }),
    );
    record(
      'slash',
      await vault.send('slash', [ACCOUNTS.bob, 10_000n * ONE, '0x' + 'cd'.repeat(32)], {
        from: ACCOUNTS.guardian,
      }),
    );
  }

  // The 21-day exit, which only the harness can walk because only it can move
  // block.timestamp. `npm run deploy` proves the refusal side on a live node.
  {
    const { chain, ark, vault } = await fixture();
    await ark.send('transfer', [ACCOUNTS.alice, 100_000n * ONE], { from: ACCOUNTS.admin });
    await ark.send('approve', [vault.address, 10n ** 30n], { from: ACCOUNTS.alice });
    await vault.send('registerOperator', [T1, 1000], { from: ACCOUNTS.bob });
    await vault.send('stake', [T1, ACCOUNTS.bob, 50_000n * ONE], { from: ACCOUNTS.alice });
    await vault.send('beginUnbonding', [50_000n * ONE], { from: ACCOUNTS.alice });
    chain.advanceTime(21 * DAY + 1);
    record('withdraw (after 21 days)', await vault.send('withdraw', [], { from: ACCOUNTS.alice }));
  }

  await bondLeg(record);
  await originLeg(record);

  const width = Math.max(...rows.map((r) => r[0].length));
  console.log(`${'flow'.padEnd(width)}  ${'gas'.padStart(9)}`);
  console.log('-'.repeat(width + 11));
  for (const [label, gas] of rows) {
    console.log(`${label.padEnd(width)}  ${gas.toLocaleString('en-US').padStart(9)}`);
  }
}

/**
 * Build 2 of the bond (phase C3), on the harness build: the settlement of each
 * trigger, the entitlement, the recovery, and the epoch boundary with a queued
 * cohort weighed (gap item 24). The court's calls go through the stand-in
 * court, so their gas includes its one forwarding call.
 */
async function bondLeg(record) {
  const F = require('../test/stake-fixture');
  const { keccak256, toUtf8Bytes } = require('ethers');
  const { ACCOUNTS: A, CLASS, TERM } = F;
  const DEST = '0x' + '33'.repeat(20);
  const det = '0x' + '01'.repeat(32);
  {
    const ctx = await F.deployBondStack();
    const s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
    const a = await F.anchor(ctx, { notional: 100n * ONE });
    const b = await F.anchor(ctx, { owner: A.bob, depositor: A.bob, nonce: 1n, notional: 300n * ONE });
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, value: 70_000n * ONE });
    await F.subscribe(ctx, { from: A.bob, class_: CLASS.SENIOR, value: 30_000n * ONE });
    ctx.chain.advanceTime(91 * DAY);
    const epoch = F.epochNow(ctx);
    await ctx.attest.send('seal', [epoch, F.bufferLeaf(F.CHAIN_ID, F.ASSET_A, epoch, 2n * ONE)]);
    await ctx.registry.send('recordBuffer', [F.CHAIN_ID, F.ESCROW, F.ASSET_A, epoch, 2n * ONE, []]);
    await ctx.court.send('open', [det]);
    record('bond.determineLoss, two positions (through the stand-in court)', await ctx.court.send('determineLoss', [det, [a.id, b.id], [40n * ONE, 120n * ONE]]));
    record('bond.nameLossDestination', await s.send('nameLossDestination', [det, a.id, DEST], { from: A.alice }));
    F.toNextEpoch(ctx);
    record('bond.claimSettlement (first claim, serves)', await s.send('claimSettlement', [det, a.id], { from: A.alice }));
  }
  {
    const ctx = await F.deployBondStack();
    const s = ctx.chain.at('ArkCatBondSettlement', ctx.bond.address);
    const rc = ctx.chain.at('ArkCatBondRecovery', ctx.bond.address);
    const a = await F.anchor(ctx, { notional: 100n * ONE });
    const others = [];
    for (let i = 1n; i <= 9n; i++) others.push((await F.anchor(ctx, { owner: A.bob, depositor: A.bob, nonce: i, notional: 10n * ONE })).id);
    ctx.chain.advanceTime(91 * DAY);
    const j = await F.subscribe(ctx, { class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 70_000n * ONE });
    await F.subscribe(ctx, { from: A.bob, class_: CLASS.SENIOR, term: TERM.QUARTER, value: 30_000n * ONE });
    await ctx.qday.send('declare', [BigInt(ctx.chain.timestamp)]);
    record('bond.recordClaimants, one position (grounds the declaration)', await rc.send('recordClaimants', [[a.id]]));
    // The root of the epoch before T, a quiet one: its anchor count leaf alone (QL-05, QL-06).
    const prior = BigInt(ctx.chain.timestamp) / BigInt(F.EPOCH) - 1n;
    await ctx.attest.send('seal', [prior, F.anchorCountLeaf(prior, 0n)]);
    record('bond.provePriorAnchors (the count of the root before T)', await rc.send('provePriorAnchors', [0n, []]));
    record('bond.recordClaimants, nine positions', await rc.send('recordClaimants', [others]));
    record('bond.settleDeclaration (D_0 of S_full)', await s.send('settleDeclaration'));
    const t2 = await s.call('declaration');
    F.toEpoch(ctx, t2.epoch + 4n);
    await ctx.oracle.send('set', [2000n * F.PRICE_SCALE, 2000n * F.PRICE_SCALE, 2000n * F.PRICE_SCALE]);
    record('bond.settleSeverity (measured, balance drawn)', await s.send('settleSeverity'));
    const sid = '0x' + 'a1'.repeat(32);
    record('params.admitSuccessor', await ctx.params.send('admitSuccessor', [F.CHAIN_ID, sid]));
    const rid = '0x' + '5e'.repeat(32);
    record('bond.openRecovery (through the stand-in court)', await ctx.court.send('openRecovery', [rid, F.CHAIN_ID, sid, F.ESCROW, 10n * ONE, 100n * ONE]));
    record('bond.claimRecovery (a holding)', await rc.send('claimRecovery', [rid, j, DEST], { from: A.alice }));
    record('bond.claimPositionRecovery', await rc.send('claimPositionRecovery', [rid, a.id, DEST], { from: A.alice }));
  }
  {
    // The boundary with and without a queued cohort to weigh (I26′).
    const ctx = await F.deployBondStack({ stage: 4 });
    await F.subscribe(ctx, { class_: CLASS.JUNIOR, term: TERM.QUARTER, value: 1000n * ONE });
    F.toNextEpoch(ctx);
    record('bond.closeEpoch, one epoch, no queue', await ctx.bond.send('closeEpoch'));
    const m = F.epochNow(ctx) + 12n;
    F.toEpoch(ctx, m + 1n);
    await F.distributeDue(ctx);
    F.toNextEpoch(ctx);
    record('bond.closeEpoch, one epoch, a queued cohort weighed', await ctx.bond.send('closeEpoch'));
  }
  void keccak256;
  void toUtf8Bytes;
}

/**
 * The origin leg (ecdsa-stakings, the spec build of the `ethereum` manifest):
 * root admission under the threshold at the deployed height (11), 1 of 1
 * and 2 of 3 (whitepaper §3.6, D1); the publication of a root's leaves (D15);
 * an extension of the authority chain; and the escrow's main flows. Skipped,
 * with a line saying so, where `npm run compile:evm` has not been run.
 * `ORIGIN_BUILD` points it at another build directory, which is how the
 * optimizer settings of phase C5 were compared.
 */
async function originLeg(record) {
  const path = require('path');
  const fs = require('fs');
  const ids = require('../ecdsa-stakings/relayer/lib/identifiers');
  const { buildTree } = require('../ecdsa-stakings/relayer/lib/merkle');
  const { SignerSet, authorityChain, sigsArg } = require('../ecdsa-stakings/relayer/lib/authority');
  const buildDir = process.env.ORIGIN_BUILD || path.join(__dirname, '..', 'ecdsa-stakings', 'ethereum', 'build');
  if (!fs.existsSync(path.join(buildDir, 'ArkEpochRootRelay.json'))) {
    console.log(`(origin leg skipped: no artifacts in ${buildDir}; run npm run compile:evm)`);
    return;
  }
  const EPOCH = 7n * BigInt(DAY);
  const HEIGHT = 11;
  const seedOf = (i) => '0x' + (i + 1).toString(16).padStart(64, '0');
  const epochOf = (chain) => BigInt(chain.timestamp) / EPOCH;

  const relayOf = async (chain, k, n, height = HEIGHT, commit = ids.TERMINAL_COMMIT, generations = null) => {
    const set = new SignerSet({ seeds: Array.from({ length: n }, (_, i) => seedOf(i)), threshold: k, treeHeight: height });
    const relay = await chain.deploy('ArkEpochRootRelay', ['bytes32[]', 'uint8', 'uint8', 'bytes32'], [generations ? generations[0] : set.roots(), k, height, commit]);
    let last = 0n;
    const admit = async (root) => {
      let e = epochOf(chain);
      if (e <= last) {
        chain.advanceTime(Number((last + 1n) * EPOCH - BigInt(chain.timestamp)));
        e = epochOf(chain);
      }
      const leaf = Number(await relay.call('nextLeaf'));
      const message = ids.rootMessage({ chainId: 1n, relay: relay.address, epoch: e, epochRoot: root, leafCount: 1 });
      const res = await relay.send('admitEpochRoot', [e, root, 1, leaf, sigsArg(set._signUnchecked(message, leaf))], { from: ACCOUNTS.mallory });
      last = e;
      return { res, epoch: e };
    };
    return { relay, set, admit };
  };

  const leaves = Array.from({ length: 8 }, (_, i) => ids.stakeLeafKey('0x' + 'e5'.repeat(20), '0x' + (i + 7).toString(16).padStart(64, '0'), 1n));
  const tree = buildTree(leaves);
  for (const [k, n] of [[1, 1], [2, 3]]) {
    const chain = await Chain.create({ buildDir });
    const { relay, admit } = await relayOf(chain, k, n);
    const { res, epoch } = await admit(tree.root);
    record(`relay.admitEpochRoot, ${k} of ${n}, height ${HEIGHT}`, res);
    if (k === 1) record('relay.publishLeaves (8 leaves)', await relay.send('publishLeaves', [epoch, tree.leaves]));
  }
  {
    // Height 2 so the extension window [2, 3) is one root away.
    const chain = await Chain.create({ buildDir });
    const seeds = [0, 1, 2].map(seedOf);
    const auth = authorityChain(seeds, 2);
    const { relay, admit } = await relayOf(chain, 2, 3, 2, auth.commits[0], auth.generations);
    await admit(ids.TERMINAL_COMMIT);
    await admit(ids.TERMINAL_COMMIT);
    chain.advanceTime(Number(EPOCH));
    const e = epochOf(chain);
    const message = ids.extensionMessage({ chainId: 1n, relay: relay.address, epoch: e, nextGeneration: 2, link: auth.commits[0] });
    const set = new SignerSet({ seeds, threshold: 2, treeHeight: 2 });
    record('relay.scheduleExtension, 2 of 3', await relay.send('scheduleExtension', [auth.generations[1], auth.commits[1], e, 2, sigsArg(set._signUnchecked(message, 2))]));
    chain.advanceTime(Number(6n * EPOCH));
    record('relay.activateNextGeneration (3 roots)', await relay.send('activateNextGeneration', []));
  }
  {
    const chain = await Chain.create({ buildDir });
    const { relay, admit } = await relayOf(chain, 1, 1, 4);
    const asset = await chain.deploy('MockAsset');
    // The last argument: the audit's reference yield per epoch, 2.20% a year (EC-08).
    const escrow = await chain.deploy('ArkStakeEscrowUnits', ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'], [asset.address, relay.address, '0x' + 'ef'.repeat(20), ONE, 20, 421917808219179n]);
    for (const who of [ACCOUNTS.admin, ACCOUNTS.alice, ACCOUNTS.bob]) {
      await asset.send('mint', [who, 1_000n * ONE]);
      await asset.send('approve', [escrow.address, 10n ** 30n], { from: who });
    }
    record('escrow.seed', await escrow.send('seed', [10n * ONE]));
    const owner = '0x' + '66'.repeat(20);
    record('escrow.anchor (first)', await escrow.send('anchor', [owner, 100n * ONE], { from: ACCOUNTS.bob }));
    const res = await escrow.send('anchor', [owner, 100n * ONE], { from: ACCOUNTS.alice });
    record('escrow.anchor (second)', res);
    const id = escrow.events(res, 'Anchored')[0].args.stakeAssetId;
    const rates = [3000, 250, 250, 2000, 200, 3000, 10000, 11100, 13];
    const alloc = ids.allocationLeaf({ escrow: escrow.address, epoch: epochOf(chain), ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f, i) => [f, rates[i]])) });
    const release = ids.releaseLeaf(escrow.address, ids.releasePayload({ id, recipient: ACCOUNTS.alice, claimNonce: 1n, chainId: 1n }));
    const t = buildTree([alloc, release]);
    const { epoch } = await admit(t.root);
    const proof = (leaf) => require('../ecdsa-stakings/relayer/lib/merkle').proofFor(t, leaf);
    record('escrow.recordEpochAllocation', await escrow.send('recordEpochAllocation', [epoch, rates, proof(alloc)]));
    await asset.send('mint', [escrow.address, 10n * ONE]);
    record('escrow.sweep (five pots and the reserve)', await escrow.send('sweep', []));
    chain.advanceTime(Number(4n * EPOCH));
    record('escrow.release (into the queue, part paid)', await escrow.send('release', [id, ACCOUNTS.alice, 1n, epoch, proof(release)], { from: ACCOUNTS.mallory }));
    chain.advanceTime(Number(EPOCH));
    record('escrow.drainQueue (first drain of an epoch, ratchet)', await escrow.send('drainQueue', [8n]));
    // D13, D17: a loss above the buffer pays the buffer and leaves a claim; the
    // next inflow's drain discharges it.
    const det = '0x' + '0d'.repeat(32);
    const quantity = 30n * ONE;
    const loss = ids.lossLeaf({ chainId: 1n, escrow: escrow.address, determinationId: det, stakeAssetId: id, destination: ACCOUNTS.bob, quantity });
    const lt = buildTree([loss]);
    const { epoch: le } = await admit(lt.root);
    record('escrow.settleLoss (buffer short: paid in part, the rest a claim)', await escrow.send('settleLoss', [det, id, ACCOUNTS.bob, quantity, le, require('../ecdsa-stakings/relayer/lib/merkle').proofFor(lt, loss)], { from: ACCOUNTS.mallory }));
    await asset.send('mint', [escrow.address, 400n * ONE]);
    await escrow.send('sweep', []);
    chain.advanceTime(Number(EPOCH));
    record('escrow.drainQueue (an outstanding loss claim met from inflow)', await escrow.send('drainQueue', [8n]));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
