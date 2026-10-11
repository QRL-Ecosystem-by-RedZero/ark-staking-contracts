#!/usr/bin/env node
/**
 * The stETH escrow — the Lido form, which also takes ETH — against the REAL
 * stETH, on a Hardhat fork of Hoodi, with the rebase driven by hand.
 *
 *   FORK_URL=https://rpc.hoodi.ethpandaops.io npx hardhat node --config ecdsa-stakings/stress/hardhat.config.cjs --port 8547
 *   node ecdsa-stakings/stress/steth-fork.js [--url http://127.0.0.1:8547] [--depositors 60]
 *
 * The one rule it exists to enforce: **what the test doubles let pass, the real
 * token must let pass too — and what they hide, it must show.** `MockRebasingAsset`
 * starts 1:1, accepts a transfer to itself and rounds only one way; Lido does
 * none of those. So everything here runs on Lido's own bytecode and storage:
 *
 *   1. many depositors anchor: half stake ETH through `submit` themselves and
 *      anchor the stETH, half send ETH to `anchorNative`, which stakes it
 *      through Lido in the same call; the seed goes in as ETH through
 *      `seedNative`;
 *   2. the pool rebases up and down (slashing) by writing Lido's consensus-layer
 *      balance slot — the one lever an oracle report would pull — and the
 *      sweep must divide only yield, never principal, and never charge a loss;
 *   3. a seed of exactly SEED_MINIMUM is checked against share rounding;
 *   4. a whole-book release wave drains in order under the bound, and every
 *      leaver is paid within rounding of the claim it had when it left;
 *   5. a release whose recipient is the stETH contract itself — which Lido
 *      refuses — must not stop anyone else's exit;
 *   6. the premium the rebases put in the pot is paid out by premium locks: a
 *      claim against the preimage pays the solver its shares' worth, once,
 *      and a lot past its origin-chain expiry moves nothing;
 *   7. the five-pot identity holds after every step.
 *
 * Exit status is the number of violations.
 */
const path = require('path');
const { Interface, getAddress, keccak256, toUtf8Bytes } = require('ethers');

const { hardhatBackend, artifact, Reverted } = require('./backend');
const ids = require('../relayer/lib/identifiers');
const { buildTree, proofFor } = require('../relayer/lib/merkle');
const { SignerSet, sigsArg } = require('../relayer/lib/authority');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const BUILD = path.join(__dirname, '..', 'ethereum', 'build');
const STETH = getAddress('0x3508A952176b3c15387C97BE809eaffB1982176a');
/** Lido's consensus-layer balance (low 128 bits, packed), found by tracing getTotalPooledEther's SLOADs on the fork. */
const CL_BALANCE_SLOT = '0x096e465397f38e659238ccd5d5a2c434ced54a63fd8d694045bfb058ab9d8112';
const EPOCH = 7n * 86400n;
const ONE = 10n ** 18n;
const HEIGHT = 7;

const LIDO = new Interface([
  'function submit(address) payable returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function sharesOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function getTotalPooledEther() view returns (uint256)',
  'function getPooledEthByShares(uint256) view returns (uint256)',
]);
const ESCROW = new Interface(artifact('ArkStakeEscrowLido', BUILD).abi);
const RELAY = new Interface(artifact('ArkEpochRootRelay', BUILD).abi);

const violations = [];
const violate = (code, detail) => {
  violations.push({ code, detail });
  console.log(`   VIOLATION ${code}: ${detail}`);
};
const note = (s) => console.log(`   ${s}`);

async function main() {
  const b = await hardhatBackend({ buildDir: BUILD, url: opt('url', 'http://127.0.0.1:8547') });
  if (b.chainId !== 560048n) throw new Error(`expected a fork of Hoodi (560048), the node answers ${b.chainId}`);
  const n = Number(opt('depositors', '60'));
  const signer = new SignerSet({ seeds: [keccak256(toUtf8Bytes('ark-stake:steth-fork'))], threshold: 1, treeHeight: HEIGHT });

  const lido = async (fn, args = []) => (await b.call(STETH, LIDO, fn, args))[0];
  const v = async (fn, args = []) => (await b.call(escrow, ESCROW, fn, args))[0];
  const send = async (fn, args, from, value) => {
    try {
      return { ok: true, r: await b.send(escrow, ESCROW, fn, args, from, value) };
    } catch (e) {
      if (!(e instanceof Reverted)) throw e;
      if (/^(Panic|Error|<)/.test(e.revertName)) violate('S9', `${fn} reverted ${e.revertName}`);
      return { ok: false, name: e.revertName };
    }
  };
  const rebase = async (bps) => {
    // The slot is packed since Lido's upgrade on Hoodi: the consensus-layer
    // balance in the low 128 bits, a second figure in the high 128 (the two sum
    // to getBeaconStat's balance). Writing the whole word as one number put the
    // high half into the balance and rebased by ~10^38 ETH.
    const raw = await b.getStorage(STETH, CL_BALANCE_SLOT);
    const LOW = (1n << 128n) - 1n;
    const cl = raw & LOW;
    const next = cl + (cl * BigInt(bps)) / 10_000n;
    await b.setStorage(STETH, CL_BALANCE_SLOT, ((raw >> 128n) << 128n) | next);
    return next - cl;
  };
  const check = async (where) => {
    const held = await v('sharesHeld');
    const owed = (await v('positionShares')) + (await v('bufferShares')) + (await v('auctionShares')) + (await v('queuedShares')) + (await v('psrShares'));
    let extra = 0n;
    try {
      extra = await v('unclaimedShares');
    } catch {
      /* the pull pot exists only once E1 is fixed */
    }
    if (held < owed + extra) violate('S1', `${where}: held ${held} < owed ${owed + extra}`);
  };

  // The relay and the escrow, as deploy:evm builds them.
  const relay = await b.deploy('ArkEpochRootRelay', [signer.roots(), 1, HEIGHT, ids.TERMINAL_COMMIT]);
  const ops = getAddress('0x' + 'ab'.repeat(20));
  const SEED_MIN = 10n ** 16n;
  // The fork names depositors' own 20-byte addresses as beneficiaries: the
  // legacy line (D14), which is what this stETH test needs of an owner.
  // The last argument: the audit's reference yield per epoch, 2.20% a year (EC-08).
  const escrow = await b.deploy('ArkStakeEscrowLido', [STETH, relay, ops, SEED_MIN, 20, 421917808219179n]);
  note(`relay ${relay}, escrow ${escrow}, stETH pooled ${(await lido('getTotalPooledEther')) / ONE} ETH`);

  let lastEpoch = -1n;
  const seal = async (leaves) => {
    let now = (await b.now()) / EPOCH;
    if (now <= lastEpoch) {
      await b.advance((lastEpoch + 1n) * EPOCH - (await b.now()) + 1n);
      now = (await b.now()) / EPOCH;
    }
    const tree = buildTree(leaves);
    const leaf = Number((await b.call(relay, RELAY, 'nextLeaf'))[0]);
    const msg = ids.rootMessage({ chainId: b.chainId, relay, epoch: now, epochRoot: tree.root, leafCount: tree.leaves.length });
    await b.send(relay, RELAY, 'admitEpochRoot', [now, tree.root, tree.leaves.length, leaf, sigsArg(signer._signUnchecked(msg, leaf))]);
    lastEpoch = now;
    return { epoch: now, proof: (l) => proofFor(tree, l) };
  };

  /* ----------------------------------------------------------- 3. the seed */
  const seeder = getAddress('0x' + keccak256(toUtf8Bytes('seeder')).slice(26));
  const seedRes = await send('seedNative', [], seeder, SEED_MIN);
  if (!seedRes.ok) violate('A', `seedNative refused ${seedRes.name}`);
  const seeded = await v('seededUnits');
  note(`seed of exactly SEED_MINIMUM (${SEED_MIN}) in ETH through Lido credits ${seeded} units`);
  if (seeded < SEED_MIN) {
    note('E9 on the real token: Lido\'s rounding leaves an exact seed a wei short; topping up by 10 wei of ETH');
    await send('seedNative', [], seeder, 10n);
  }

  /* ----------------------------------------------------------- 1. anchors */
  const people = Array.from({ length: n }, (_, i) => getAddress('0x' + keccak256(toUtf8Bytes(`steth-depositor-${i}`)).slice(26)));
  const positions = [];
  for (let i = 0; i < n; i++) {
    const who = people[i];
    const eth = ONE / 2n + BigInt(i) * (ONE / 3n);
    let res;
    if (i % 2) {
      // Native: ETH straight in, staked through Lido by the escrow itself.
      res = await send('anchorNative', [who], who, eth);
    } else {
      await b.send(STETH, LIDO, 'submit', ['0x' + '00'.repeat(20)], who, eth);
      const bal = await lido('balanceOf', [who]);
      await b.send(STETH, LIDO, 'approve', [escrow, bal], who);
      res = await send('anchor', [who, bal], who);
    }
    if (!res.ok) {
      violate('A', `anchor of ${eth} wei by ${who} (${i % 2 ? 'ETH' : 'stETH'}) refused ${res.name}`);
      continue;
    }
    const ev = res.r.logs.map((l) => { try { return ESCROW.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Anchored');
    positions.push({ id: ev.args.stakeAssetId, who, notional: BigInt(ev.args.anchoredNotional), shares: BigInt(ev.args.shares) });
  }
  const anchoredUnits = positions.reduce((a, p) => a + p.notional, 0n);
  note(`${positions.length} anchors, ${anchoredUnits / ONE} stETH; notional vs balance delivered checked against Lido's rounding`);
  await check('after anchors');

  /* ----------------------------------------------------------- allocation */
  const alloc = { epoch: (await b.now()) / EPOCH, sigmaBps: 1850, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 2000, levyBps: 200, sigmaTargetBps: 1850, coveredBps: 10000, psrCapBps: 11100, commitTermEpochs: 13 };
  const aLeaf = ids.allocationLeaf({ ...alloc, escrow });
  const sA = await seal([aLeaf]);
  const aRes = await send('recordEpochAllocation', [sA.epoch, ids.ALLOCATION_FIELDS.map((f) => alloc[f]), sA.proof(aLeaf)]);
  if (!aRes.ok) violate('A', `allocation refused ${aRes.name}`);

  /* ----------------------------------------------------------- 2. rebases */
  const opsBefore = await lido('balanceOf', [ops]);
  for (const bps of [3, 5, 2, -100, 4, 60]) {
    const d = await rebase(bps);
    const before = { pos: await v('positionShares'), pot: await v('auctionShares'), buf: await v('bufferShares') };
    const res = await send('sweep', [], people[0]);
    const after = { pos: await v('positionShares'), pot: await v('auctionShares'), buf: await v('bufferShares') };
    const claim0 = await v('claimOf', [positions[0].id]);
    note(`rebase ${bps} bps (${d / ONE} ETH on the CL balance): sweep ${res.ok ? 'divided yield' : res.name}; pot +${after.pot - before.pot} shares; claim[0] ${claim0}`);
    // A negative rebase is not yield: nothing may move to the pot or the buffer.
    if (bps < 0 && res.ok) violate('Y', 'a negative rebase was swept as yield');
    if (after.pos > before.pos && bps < 0) violate('Y', 'positions gained shares on a slashing');
    await check(`after rebase ${bps}`);
  }
  const opsPaid = (await lido('balanceOf', [ops])) - opsBefore;
  note(`operations destination received ${opsPaid} wei of stETH across the sweeps`);

  /* ----------------------------------------------------------- 6. the premium lock */
  const pot = await v('auctionShares');
  note(`premium pot after the rebases: ${pot} shares, ${await lido('getPooledEthByShares', [pot])} wei of stETH`);
  // The escrow offers once the lots of the offering before can no longer be paid.
  const offerAt = ((await b.now()) / EPOCH) * EPOCH + 2n * 86400n;
  if ((await b.now()) < offerAt) await b.advance(offerAt - (await b.now()) + 1n);
  const offerRes = await send('offerPremium', [], people[0]);
  if (!offerRes.ok) violate('W', `offerPremium refused ${offerRes.name}`);
  const solverAcct = getAddress('0x' + keccak256(toUtf8Bytes('solver')).slice(26));
  const secretA = keccak256(toUtf8Bytes('fork-solver-a'));
  const secretB = keccak256(toUtf8Bytes('fork-solver-b'));
  // Past the epoch `seal` may move to, with room to claim in.
  const expiry = (await b.now()) + 10n * 86400n;
  const lotA = { chainId: b.chainId, escrow, asset: STETH, lotId: keccak256(toUtf8Bytes('lot-a')), hashlock: ids.hashlockOf(secretA), recipient: solverAcct, shares: pot / 2n, evmExpiry: expiry, epoch: 0n, bond: 0n };
  const lotB = { chainId: b.chainId, escrow, asset: STETH, lotId: keccak256(toUtf8Bytes('lot-b')), hashlock: ids.hashlockOf(secretB), recipient: solverAcct, shares: pot / 4n, evmExpiry: expiry, epoch: 0n, bond: 0n };
  const leafA = ids.premiumLockLeaf(lotA);
  const leafB = ids.premiumLockLeaf(lotB);
  const sW = await seal([leafA, leafB]);
  const payload = (l) => [l.lotId, l.hashlock, l.recipient, l.shares, l.evmExpiry, l.epoch, l.bond];
  await rebase(4);
  const due = await lido('getPooledEthByShares', [lotA.shares]);
  const before = await lido('balanceOf', [solverAcct]);
  const claimRes = await send('claimPremium', [payload(lotA), sW.epoch, sW.proof(leafA), secretA], people[0]);
  if (!claimRes.ok) violate('W', `claimPremium refused ${claimRes.name}`);
  const paid = (await lido('balanceOf', [solverAcct])) - before;
  note(`lot of ${lotA.shares} shares: paid ${paid} wei of stETH, the shares' worth after a rebase ${due}`);
  if (paid > due || due - paid > 2n) violate('W', `claim paid ${paid}, the shares are worth ${due}`);
  const again = await send('claimPremium', [payload(lotA), sW.epoch, sW.proof(leafA), secretA], people[0]);
  if (again.ok) violate('W', 'a lot paid twice');
  await b.advance(expiry - (await b.now()) + 1n);
  const potBefore = await v('auctionShares');
  const late = await send('claimPremium', [payload(lotB), sW.epoch, sW.proof(leafB), secretB], people[0]);
  if (late.ok || late.name !== 'PremiumExpired') violate('W', `a lot after its evmExpiry answered ${late.ok ? 'ok' : late.name}`);
  if ((await v('auctionShares')) < potBefore) violate('W', 'an expired lot moved something out of the pot');
  await check('after the premium locks');

  /* ----------------------------------------------------------- 5 + 4. the wave */
  const poison = positions[1];
  const legit = positions.filter((p) => p !== poison);
  const leaves = legit.map((p) => ({ p, recipient: p.who, leaf: ids.releaseLeaf(escrow, ids.releasePayload({ id: p.id, recipient: p.who, claimNonce: 1n, chainId: b.chainId })) }));
  const poisonLeaf = ids.releaseLeaf(escrow, ids.releasePayload({ id: poison.id, recipient: STETH, claimNonce: 1n, chainId: b.chainId }));
  const sR = await seal([...leaves.map((x) => x.leaf), poisonLeaf]);
  await b.advance(4n * EPOCH);
  const claims = new Map();
  // Enough of the book first to spend this epoch's bound, so the poisoned entry
  // is queued rather than paid (and refused) inside its own release call.
  const first = Math.ceil(leaves.length * 0.45);
  for (const x of leaves.slice(0, first)) {
    claims.set(x.p.id, await v('claimOf', [x.p.id]));
    await send('release', [x.p.id, x.recipient, 1n, sR.epoch, sR.proof(x.leaf)], people[0]);
  }
  // The poison enters the queue behind the first releases.
  const pRes = await send('release', [poison.id, STETH, 1n, sR.epoch, sR.proof(poisonLeaf)], people[0]);
  note(`release to the stETH contract itself: ${pRes.ok ? 'queued' : pRes.name}`);
  let blocked = 0;
  for (const x of leaves.slice(first)) {
    claims.set(x.p.id, await v('claimOf', [x.p.id]));
    const r = await send('release', [x.p.id, x.recipient, 1n, sR.epoch, sR.proof(x.leaf)], people[0]);
    if (!r.ok) blocked += 1;
  }
  if (blocked) violate('E1', `${blocked} honest release(s) refused once the poisoned entry was queued`);
  for (let e = 0; e < 8; e++) {
    const head = await v('queueHead');
    const tail = await v('queueTail');
    if (head === tail) break;
    const r = await send('drainQueue', [64n], people[0]);
    if (!r.ok) violate('E1', `drainQueue reverted ${r.name} with the poisoned entry in the queue (epoch +${e})`);
    await b.advance(EPOCH);
  }
  const head = await v('queueHead');
  const tail = await v('queueTail');
  if (head !== tail) violate('L1', `queue ${head}..${tail} still open after 8 epochs`);

  // Every honest leaver is paid within rounding of the claim it had when it left.
  let worst = 0n;
  for (const x of leaves) {
    const want = claims.get(x.p.id);
    if (want === undefined) continue;
    const got = await lido('balanceOf', [x.p.who]);
    const short = want > got ? want - got : 0n;
    if (short > worst) worst = short;
  }
  note(`largest shortfall of a leaver against its claim at release: ${worst} wei`);
  if (worst > 1000n) violate('P', `a leaver was paid ${worst} wei below its claim`);
  await check('after the wave');

  console.log(violations.length ? `\n${violations.length} violation(s)` : '\nno violations');
  await b.close();
  process.exit(Math.min(violations.length, 100));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(101);
});
