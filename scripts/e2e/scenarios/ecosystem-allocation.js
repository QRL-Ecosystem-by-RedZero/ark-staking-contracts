/**
 * The ARK allocation and the Treasury on chain (core ArkAllocation-Design.md
 * §5-§7 with the Genesis campaign A7-A12, QuantumArk-Treasury-Flows.md §3-§7;
 * both adopted 2026-10-13). Scripted actors play every human step.
 *
 *   A  the Genesis campaign: the root publisher (the relayer account) writes
 *      the campaign root; one actor claims liquid and receives 2/3, another
 *      locks for a year and receives the full amount as veARK; a second claim,
 *      a wrong amount and a lock shorter than a year are refused by name.
 *   B  a channel root for the first closed epoch: within its budget, written
 *      once; a year-1 claim asked liquid is paid as a four-year lock.
 *   C  the treasury's ARK: the proposer multisig names the token once
 *      (`setArkToken`); a transfer over the quarterly cap is refused at
 *      scheduling, one within it is queued at 30 profile-days and objectable,
 *      then cancelled (nothing leaves the treasury on a devnet run).
 *   D  the treasury router: an actor deposits on the Qurrl primary lane (the
 *      splitter's lane; anyone may deposit, IArkFlow rule 3), `rebalance`
 *      splits it, the Cushion takes its shortfall first, and `dispatch` pays
 *      the bond on the CUSHION lane, once per epoch.
 *
 * NOT TERMINAL. Nothing irreversible beyond ARK paid to e2e actors.
 *
 * Wall-clock: B waits for the epoch after the stack's deployment to close
 * (up to two epochs: 70 min each at testnet, 7 at rapid); the rest is
 * immediate. The campaign window's close (120 profile-days) and the 30-day
 * execution are not waited for.
 */
const { keccak256, concat, getBytes, toBeHex, zeroPadValue } = require('ethers');
const { ONE, harnessActorAddress } = require('../lib');
const H = require('../helpers/governance');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

const CH = { STAKING: 0, ACORN: 1, CAMPAIGN: 4 };
const GAS_FLOAT = 100n * ONE;
/** A zero bytes32 (a root never written); H.isZero is for addresses. */
const zero32 = (v) => BigInt(v) === 0n;
const PRIMARY = keccak256(Buffer.from('quantumark.lane.treasury.qurrl-primary.v1'));

module.exports = {
  description: 'the ARK allocation and the Treasury: Genesis campaign claims (liquid 2/3, locked in full), a channel root and its year-1 lock, the treasury transfer row and its quarterly cap, the router splitting a Qurrl deposit and topping up the Cushion',
  terminal: false,
  // Read by scripts/e2e-local.js: core's stack with a 2-of-3 proposer multisig of e2e actors.
  governance: {
    proposerOwners: ['gov-proposer-0', 'gov-proposer-1', 'gov-proposer-2'].map(harnessActorAddress),
    proposerThreshold: 2,
    guardianOwners: ['gov-guardian-0'].map(harnessActorAddress),
    guardianThreshold: 1,
    attesters: ['gov-attester-0', 'gov-attester-1', 'gov-attester-2', 'gov-attester-3', 'gov-attester-4'].map(harnessActorAddress),
    attesterBond: 10n * ONE,
  },
  outOfScope: [
    'the campaign window closing after 120 profile-days, and the reserve window: the harness tests (core test/ArkEmissionVault.test.js) drive the clock',
    'the 30-day execution of a treasury transfer: queued, checked and cancelled here; executed in core test/ArkTreasurySpend.test.js',
    'Qurrl\'s own side (mint, sweep, claimTreasury to the router; its budget lane; Phase 0): projects/qurrl/contracts scripts/ecosystem-live.js',
    'the per-epoch root publisher in the relayer: the roots here are built by this scenario',
  ],

  async run(ctx) {
    const h = H.stack(ctx);
    ctx.check(Boolean(h && h.G.ArkEmissionVault && h.G.ArkTreasuryRouter), 'the governance record names the emission vault and the treasury router (2026-10-13 stack)', { addresses: h && Object.keys(h.G) });
    const { G } = h;
    const onQrl = ctx.qrl.kind === 'qrl';
    const me = ctx.qrl.address;
    const E = BigInt(ctx.clock.EPOCH_LENGTH);
    const day = BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'GRACE_PERIOD')) / 14n;

    /** abi.encodePacked(address, uint8, uint256) at this chain's address width. */
    const packedAddress = (a) => zeroPadValue(toHex(a), onQrl ? 64 : 20);
    const leaf = (a, ch, amount) => keccak256(concat([packedAddress(a), toBeHex(ch, 1), zeroPadValue(toBeHex(amount), 32)]));
    const tree = (leaves) => {
      const layers = [leaves.slice()];
      while (layers[layers.length - 1].length > 1) {
        const prev = layers[layers.length - 1];
        const next = [];
        for (let i = 0; i < prev.length; i += 2) {
          if (i + 1 === prev.length) next.push(prev[i]);
          else {
            const [a, b] = [prev[i], prev[i + 1]].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
            next.push(keccak256(concat([a, b])));
          }
        }
        layers.push(next);
      }
      return {
        root: layers[layers.length - 1][0],
        proof(i) {
          const out = [];
          let idx = i;
          for (let l = 0; l < layers.length - 1; l++) {
            const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
            if (sib < layers[l].length) out.push(layers[l][sib]);
            idx = Math.floor(idx / 2);
          }
          return out;
        },
      };
    };
    const balance = async (a) => BigInt(await h.call(G.ArkToken, 'ArkToken', 'balanceOf', [a]));
    const lockOf = (a) => h.call(G.VeArk, 'VeArk', 'lockOf', [a]);

    /* -------------------------------------------- A: the Genesis campaign */
    const [liquid, locker] = [await ctx.actor('eco-campaign-liquid', { fund: GAS_FLOAT }), await ctx.actor('eco-campaign-lock', { fund: GAS_FLOAT })];
    const entitlement = [300n * ONE, 600n * ONE];
    const camp = tree([leaf(liquid.address, CH.CAMPAIGN, entitlement[0]), leaf(locker.address, CH.CAMPAIGN, entitlement[1])]);
    const existing = await h.call(G.ArkEmissionVault, 'ArkEmissionVault', 'campaignRootOf', [CH.CAMPAIGN]);
    if (zero32(existing)) {
      await h.send(G.ArkEmissionVault, 'ArkEmissionVault', 'setCampaignRoot', [CH.CAMPAIGN, camp.root]);
      ctx.check(true, 'the root publisher writes the campaign root', { root: camp.root });
    } else {
      ctx.note(`the campaign root was written by an earlier run (${existing}); A runs only on a fresh stack`);
    }
    if (zero32(existing)) {
      await ctx.refuses('a campaign root is written once (AL11)', 'RootAlreadySet', () => ctx.qrl.call(G.ArkEmissionVault, h.abi('ArkEmissionVault'), 'setCampaignRoot', [CH.CAMPAIGN, camp.root]));
      const b0 = await balance(liquid.address);
      await h.send(G.ArkEmissionVault, 'ArkEmissionVault', 'claimCampaign', [CH.CAMPAIGN, entitlement[0], camp.proof(0), 0], { as: liquid });
      ctx.check((await balance(liquid.address)) - b0 === (entitlement[0] * 2n) / 3n, 'a liquid campaign claim pays 2/3 of the entitlement (A9)', { paid: (await balance(liquid.address)) - b0 });
      await ctx.refuses('a campaign leaf is claimed once', 'AlreadyClaimed', () => ctx.qrl.call(G.ArkEmissionVault, h.abi('ArkEmissionVault'), 'claimCampaign', [CH.CAMPAIGN, entitlement[0], camp.proof(0), 0], { from: liquid.address }));
      const now = await h.now();
      await ctx.refuses('a campaign lock shorter than a year is refused (A9)', 'CampaignLockTooShort', () => ctx.qrl.call(G.ArkEmissionVault, h.abi('ArkEmissionVault'), 'claimCampaign', [CH.CAMPAIGN, entitlement[1], camp.proof(1), now + 300n * day], { from: locker.address }));
      await ctx.refuses('a wrong amount fails the proof', 'InvalidProof', () => ctx.qrl.call(G.ArkEmissionVault, h.abi('ArkEmissionVault'), 'claimCampaign', [CH.CAMPAIGN, entitlement[1] + 1n, camp.proof(1), now + 400n * day], { from: locker.address }));
      await h.send(G.ArkEmissionVault, 'ArkEmissionVault', 'claimCampaign', [CH.CAMPAIGN, entitlement[1], camp.proof(1), now + 400n * day], { as: locker });
      const lk = await lockOf(locker.address);
      ctx.check(BigInt(lk.amount) === entitlement[1], 'a locked campaign claim receives the full entitlement as veARK, owned by the claimant (A9, lockFor)', { amount: lk.amount, end: lk.end });
      ctx.check(BigInt(await h.call(G.ArkEmissionVault, 'ArkEmissionVault', 'campaignSpent')) === entitlement[0] + entitlement[1], 'the campaign pool counts the entitlement, not the payout (AL11)');
    }

    /* ----------------------------------------------- B: a channel root */
    const start = BigInt(await h.call(G.ArkEmissionVault, 'ArkEmissionVault', 'startEpoch'));
    const epoch = start;
    await h.untilEpoch(`epoch ${epoch + 1n} begins, closing the schedule's first epoch`, epoch + 1n);
    const staker = await ctx.actor('eco-channel-staker', { fund: GAS_FLOAT });
    const amount = 1_000n * ONE;
    const ch = tree([leaf(staker.address, CH.STAKING, amount), leaf(me, CH.STAKING, 1n)]);
    const [rootNow] = await h.call(G.ArkEmissionVault, 'ArkEmissionVault', 'rootOf', [epoch, CH.STAKING]);
    if (zero32(rootNow)) {
      const budget = BigInt(await h.call(G.ArkEmissionVault, 'ArkEmissionVault', 'budgetOf', [epoch, CH.STAKING]));
      await ctx.refuses('a root above the channel\'s epoch budget is refused', 'RootOverBudget', () => ctx.qrl.call(G.ArkEmissionVault, h.abi('ArkEmissionVault'), 'setRoot', [epoch, CH.STAKING, ch.root, budget + 1n]));
      await h.send(G.ArkEmissionVault, 'ArkEmissionVault', 'setRoot', [epoch, CH.STAKING, ch.root, amount + 1n]);
      await ctx.refuses('a channel root is written once (AL5)', 'RootAlreadySet', () => ctx.qrl.call(G.ArkEmissionVault, h.abi('ArkEmissionVault'), 'setRoot', [epoch, CH.STAKING, ch.root, amount + 1n]));
      const before = await balance(staker.address);
      await h.send(G.ArkEmissionVault, 'ArkEmissionVault', 'claim', [epoch, CH.STAKING, amount, ch.proof(0), false], { as: staker });
      const lk = await lockOf(staker.address);
      ctx.check(BigInt(lk.amount) === amount && (await balance(staker.address)) === before, 'year 1: a channel claim asked liquid is paid as a veARK lock, nothing liquid (AL6)', { amount: lk.amount, end: lk.end });
      ctx.check(BigInt(lk.end) >= (await h.now()) + 4n * 365n * day - 2n * E, 'the Genesis lock runs four years (A3)', { end: lk.end });
    } else {
      ctx.note(`the epoch ${epoch} staking root was written by an earlier run; B skipped`);
    }

    /* ----------------------------------------- C: the treasury's ARK row */
    const owners = (await h.call(G.ProposerMultisig, 'ArkMultisig', 'owners')).map(toHex);
    const k = BigInt(await h.call(G.ProposerMultisig, 'ArkMultisig', 'threshold'));
    const P = H.multisig(h, G.ProposerMultisig, await H.signersFor(ctx, owners, ['gov-proposer-0', 'gov-proposer-1', 'gov-proposer-2'], GAS_FLOAT), k);
    if (!P.able) {
      ctx.note(`SKIPPED C: this run holds ${P.signers.length} of the ${k} proposer keys`);
    } else {
      if (H.isZero(await h.call(G.ArkTimelock, 'ArkTimelock', 'arkToken'))) {
        await P.run(G.ArkTimelock, h.encode('ArkTimelock', 'setArkToken', [G.ArkToken]));
      }
      ctx.check(H.same(await h.call(G.ArkTimelock, 'ArkTimelock', 'arkToken'), G.ArkToken), 'the proposer multisig named the ARK token once: the only target of a treasury transfer');
      const room = BigInt(await h.call(G.ArkTimelock, 'ArkTimelock', 'arkSpendRoom'));
      const supply = BigInt(await h.call(G.ArkToken, 'ArkToken', 'totalSupply'));
      ctx.check(room <= (supply * 50n) / 10000n, 'the quarter\'s room is at most 50 bps of supply (AL7)', { room });
      let refused = false;
      try {
        await P.schedule(G.ArkToken, h.encode('ArkToken', 'transfer', [me, room + 1n]));
      } catch (e) {
        refused = /ArkSpendCapExceeded/.test(e.message) || /reverted/.test(e.message);
      }
      ctx.check(refused, 'a transfer over the quarterly cap cannot be scheduled (AL7)');
      const op = await P.schedule(G.ArkToken, h.encode('ArkToken', 'transfer', [me, ONE]));
      ctx.check(op.delay === 30n * day, 'a treasury transfer waits 30 profile-days (A5)', { delay: op.delay });
      const [objectable] = await h.call(G.ArkTimelock, 'ArkTimelock', 'objectionOf', [op.opId]);
      ctx.check(objectable === true, 'a treasury transfer scheduled at S1 is objectable by Leg B');
      await P.cancel(op.opId);
      ctx.note('the queued transfer was cancelled: nothing leaves the treasury on a devnet run');
    }

    /* --------------------------------------------- D: the treasury router */
    const router = G.ArkTreasuryRouter;
    const cushion = await h.call(router, 'ArkTreasuryRouter', 'cushion');
    ctx.note(`router Cushion port ${cushion}; Qurrl budget port ${await h.call(router, 'ArkTreasuryRouter', 'qurrlBudget')}`);
    const payer = await ctx.actor('eco-qurrl-stand-in', { fund: 20n * ONE });
    const deposit = 10n * ONE;
    const routerAbi = h.abi('ArkTreasuryRouter');
    await payer.send(router, routerAbi, 'deposit', [PRIMARY, '0x' + '00'.repeat(32)], { value: deposit });
    ctx.check(BigInt(await h.call(router, 'ArkTreasuryRouter', 'unallocated')) >= deposit, 'the router accepts the Qurrl primary lane from any sender (IArkFlow rule 3)');
    const ops0 = BigInt(await h.call(router, 'ArkTreasuryRouter', 'operationsBalance'));
    await h.send(router, 'ArkTreasuryRouter', 'rebalance', []);
    const ops1 = BigInt(await h.call(router, 'ArkTreasuryRouter', 'operationsBalance'));
    ctx.check(ops1 - ops0 >= (deposit * 2700n) / 10000n, 'rebalance credits the operations line first, 27% (Treasury-Flows §3, tier 2)', { credited: ops1 - ops0 });
    const last = BigInt(await h.call(router, 'ArkTreasuryRouter', 'lastDispatchEpoch'));
    if (last === (await h.epoch())) {
      ctx.note('the router already dispatched this epoch; D\'s dispatch skipped');
    } else {
      const bondBefore = H.isZero(cushion) ? 0n : BigInt(await ctx.qrl.balance(cushion));
      await h.send(router, 'ArkTreasuryRouter', 'dispatch', []);
      if (!H.isZero(cushion)) {
        ctx.note(`Cushion received ${BigInt(await ctx.qrl.balance(cushion)) - bondBefore} wei on the CUSHION lane`);
      }
      await ctx.refuses('the router dispatches once per epoch', 'AlreadyDispatched', () => ctx.qrl.call(router, routerAbi, 'dispatch', []));
    }
  },
};
