/**
 * The threat stage as a scenario moves it, on both deployments in service.
 *
 * Since item 129 (2026-10-07) the stage is the ecosystem phase's: phase 0, 1
 * and 4 read stage 1, phase 3 stage 4, and phase 2 a band 2 - 3 that
 * `setThreatStage` moves under its old rules (refused elsewhere,
 * `StageFixedByPhase`); each entry into phase 2 starts at 2. A parameter set
 * from before then (the hoodi-vps deployment of 2026-10-05, audited as this
 * is written) has no `arkPhase()` and votes every step with `setThreatStage`.
 * `stageKit` tells the three apart with a guarded call and moves the stage
 * the way the deployment allows:
 *
 *   legacy  ArkStakeParams.setThreatStage(from, to), one step per epoch
 *   mock    MockArkPhase (the harness, the enclave): the operator puts the
 *           phase whose stage is `to` in force at the next boundary
 *           (`setPending`), or votes the band inside phase 2
 *   core    the network's ArkPhase, moved only through the timelock
 *           (`setPhase` 30 days, `enterQDay` 48 hours): not driven here;
 *           governance-live schedules and cancels a phase step instead
 *
 * Every step is in force from the next epoch boundary, as a vote always was.
 */
const { Interface } = require('ethers');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

/** `ArkStakeParams.STAGE_OF_PHASE`: phase 2 is the band 2 - 3, entered at 2. */
const STAGE_OF_PHASE = [1, 1, 2, 4, 1];
const BAND_PHASE = 2;

const PARAMS_PHASE = new Interface(['function arkPhase() view returns (address)']);
const PHASE = new Interface([
  'function phase() view returns (uint8)',
  'function phaseAt(uint256 epoch) view returns (uint8)',
  'function pendingPhase() view returns (uint8, uint256)',
  'function governance() view returns (address)',
]);
const MOCK = new Interface([
  'function operator() view returns (address)',
  'function setPhase(uint8 p)',
  'function setPending(uint8 to, uint256 epoch)',
  'function setDeclared(bool value)',
]);

const same = (a, b) => Boolean(a) && Boolean(b) && toHex(a).toLowerCase() === toHex(b).toLowerCase();

/** The phase source of the deployment's parameter set: `{ kind: 'legacy' | 'mock' | 'core', address }`. */
async function phaseSource(ctx) {
  const params = ctx.r.q.ArkStakeParams;
  let address;
  try {
    [address] = await ctx.qrl.call(params, PARAMS_PHASE, 'arkPhase');
  } catch {
    return { kind: 'legacy', address: null };
  }
  const q = ctx.r.q;
  const named = ctx.r.deployment.governance && ctx.r.deployment.governance.addresses && ctx.r.deployment.governance.addresses.ArkPhase;
  if (q.MockArkPhase && same(q.MockArkPhase, address)) return { kind: 'mock', address: toHex(address) };
  if (named && same(named, address)) return { kind: 'core', address: toHex(address) };
  // Neither named: a double answers operator(), core's ArkPhase does not.
  try {
    await ctx.qrl.call(address, MOCK, 'operator');
    return { kind: 'mock', address: toHex(address) };
  } catch {
    return { kind: 'core', address: toHex(address) };
  }
}

/**
 * A kit bound to one scenario. `home` is the phase in force when it was
 * made, where a step back to stage 1 returns.
 */
async function stageKit(ctx) {
  const src = await phaseSource(ctx);
  const params = ctx.r.q.ArkStakeParams;
  const P = ctx.r.abi.params;
  const epoch = () => ctx.originEpoch();
  const readPhase = async (e) => Number((await ctx.qrl.call(src.address, PHASE, 'phaseAt', [e]))[0]);
  const kit = {
    kind: src.kind,
    address: src.address,
    home: src.kind === 'legacy' ? null : await readPhase(await epoch()),

    async stage() {
      return Number((await ctx.qrl.call(params, P, 'threatStage'))[0]);
    },

    /** The phase in force now (null on a legacy deployment). */
    async phase() {
      return src.kind === 'legacy' ? null : readPhase(await epoch());
    },

    /**
     * Whether this run's key may move the stage: governance of the parameter
     * set (the band, and every step on a legacy deployment) and, on the
     * double, its operator. Never on core's ArkPhase, which the timelock moves.
     */
    async may() {
      const [gov] = await ctx.qrl.call(params, P, 'governance');
      if (!same(gov, ctx.qrl.address)) return false;
      if (src.kind === 'legacy') return true;
      if (src.kind === 'core') return false;
      const [op] = await ctx.qrl.call(src.address, MOCK, 'operator');
      return same(op, ctx.qrl.address);
    },

    /**
     * One stage step `from` -> `to`, in force from the next epoch boundary,
     * which it returns. On the double: the band where phase 2 is in force and
     * both stages are in it; else the phase whose stage is `to`, pending for
     * the next boundary (stage 3 from outside phase 2 is two steps: phase 2
     * at the next boundary, then the band, in force one epoch later).
     */
    async step(from, to) {
      if (src.kind === 'legacy') {
        await ctx.paramsSend('setThreatStage', [from, to]);
        const [, effective] = await ctx.qrl.call(params, P, 'pendingThreatStage');
        return BigInt(effective);
      }
      if (src.kind === 'core') throw new Error('the stage follows core\'s ArkPhase here: a phase step is a timelock operation (setPhase, 30 days), which this kit does not drive');
      const now = await epoch();
      const ph = await readPhase(now);
      const band = (s) => s === 2 || s === 3;
      if (ph === BAND_PHASE && band(from) && band(to)) {
        await ctx.paramsSend('setThreatStage', [from, to]);
        const [, effective] = await ctx.qrl.call(params, P, 'pendingThreatStage');
        ctx.note(`threat stage ${from} -> ${to}: the band of phase 2, in force from epoch ${effective}`);
        return BigInt(effective);
      }
      if (to === 3) {
        const entered = await kit.toPhase(BAND_PHASE);
        await ctx.waitFor(`phase 2 in force (epoch ${entered})`, async () => (await epoch()) >= entered, { timeoutEpochs: 3 });
        return kit.step(2, 3);
      }
      const target = to === 1 && STAGE_OF_PHASE[kit.home] === 1 ? kit.home : STAGE_OF_PHASE.indexOf(to);
      if (target < 0) throw new Error(`no phase reads stage ${to}`);
      return kit.toPhase(target);
    },

    /** The double puts phase `p` in force at the next boundary; returns that epoch. */
    async toPhase(p) {
      if (src.kind !== 'mock') throw new Error(`the phase is moved by ${src.kind === 'core' ? 'the timelock' : 'nobody'} here`);
      const effective = (await epoch()) + 1n;
      await ctx.qrl.send(src.address, MOCK, 'setPending', [p, effective]);
      ctx.note(`MockArkPhase: phase ${p} (stage ${p === BAND_PHASE ? '2, the band\'s low end' : STAGE_OF_PHASE[p]}) in force from epoch ${effective}`);
      return effective;
    },

    /**
     * Phase 2 in force, so the band can be voted: on the double, entered at
     * the next boundary and waited for; a no-op where it is in force, and on
     * a legacy deployment, whose every stage is voted.
     */
    async enterBand() {
      if (src.kind === 'legacy') return false;
      if ((await kit.phase()) === BAND_PHASE) return false;
      const effective = await kit.toPhase(BAND_PHASE);
      await ctx.waitFor(`phase 2 in force (epoch ${effective})`, async () => (await epoch()) >= effective, { timeoutEpochs: 3 });
      return true;
    },

    /** Back to the phase in force when the kit was made, from the next boundary. */
    async restore() {
      if (src.kind !== 'mock' || (await kit.phase()) === kit.home) return null;
      return kit.toPhase(kit.home);
    },
  };
  return kit;
}

module.exports = { STAGE_OF_PHASE, BAND_PHASE, phaseSource, stageKit, PHASE_VIEWS: PHASE };
