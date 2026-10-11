/**
 * The court's side of an e2e scenario: its events read off a receipt on
 * either word width, its structs read by position, and sends from many
 * accounts at once where the chain allows it.
 *
 * Every court event this reads has scalar members only (`PanelDrawn`, whose
 * jurors are an array, and `AssertionOpened`, whose payload is bytes, are
 * read through `panelOf` and `caseOf` instead), so the QIP-55 decoder of
 * scripts/lib/chains.js reads them on a v3 leg and ethers on the harness.
 */
const { iface, qrlBuild, parseLogs, decodeQrlLogs, qrlCodec } = require('../../lib/chains');

const norm = (a) => String(a).toLowerCase().replace(/^q/, '0x');
const same = (a, b) => norm(a) === norm(b);
const isZero = (a) => /^0x0*$/.test(norm(a));

const f = (name, type) => ({ name, type });
const id = (name) => f(name, 'bytes32');
const u = (name) => f(name, 'uint256');
const who = (name) => f(name, 'address');

/** Event tables by emitting contract: the QIP-55 decoder's form, and the field order a harness log is read in. */
const SPECS = {
  court: {
    CaseFinal: { signature: 'CaseFinal(bytes32,uint8,uint256,uint256,uint256)', topics: [id('caseId')], data: [u('outcome'), u('jurorFees'), u('fromFeePool'), u('toBuffer')] },
    RoundDecided: { signature: 'RoundDecided(bytes32,uint8,uint8,uint16,uint16)', topics: [id('caseId')], data: [u('round'), u('verdict'), u('upholds'), u('rejects')] },
    JuryDrawn: { signature: 'JuryDrawn(bytes32,uint8,uint16,bytes32)', topics: [id('caseId')], data: [u('round'), u('jurySize'), id('drawSeed')] },
    DrawArmed: { signature: 'DrawArmed(bytes32,uint8,uint256)', topics: [id('caseId')], data: [u('round'), u('drawBlock')] },
    PanelUnseatable: { signature: 'PanelUnseatable(bytes32,uint8)', topics: [id('caseId')], data: [u('round')] },
    DrawLapsed: { signature: 'DrawLapsed(bytes32,uint8,uint8)', topics: [id('caseId')], data: [u('round'), u('lapses')] },
    Challenged: { signature: 'Challenged(bytes32,address,uint256)', topics: [id('caseId'), who('challenger')], data: [u('deposit')] },
    Appealed: { signature: 'Appealed(bytes32,uint8,uint256)', topics: [id('caseId')], data: [u('newRound'), u('newBond')] },
    EscalatedToGovernance: { signature: 'EscalatedToGovernance(bytes32,address,uint256)', topics: [id('caseId'), who('by')], data: [u('bond')] },
    EscalationResolved: { signature: 'EscalationResolved(bytes32,bool)', topics: [id('caseId')], data: [f('retrial', 'bool')] },
    FindingApplied: { signature: 'FindingApplied(bytes32,uint8)', topics: [id('caseId')], data: [u('kind')] },
    Claimed: { signature: 'Claimed(address,uint256)', topics: [who('to')], data: [u('amount')] },
  },
  pool: {
    SeatSettled: { signature: 'SeatSettled(bytes32,address,bool,uint256,uint256)', topics: [id('caseId'), who('juror')], data: [f('coherent', 'bool'), u('slashed'), u('reward')] },
    Staked: { signature: 'Staked(address,uint256,uint256)', topics: [who('juror')], data: [u('amount'), u('activeFromEpoch')] },
    Unbonding: { signature: 'Unbonding(address,uint256,uint256)', topics: [who('juror')], data: [u('amount'), u('withdrawableAt')] },
    Withdrawn: { signature: 'Withdrawn(address,uint256)', topics: [who('juror')], data: [u('amount')] },
    RewardClaimed: { signature: 'RewardClaimed(address,uint256)', topics: [who('juror')], data: [u('amount')] },
  },
  bond: {
    LossDetermined: {
      signature: 'LossDetermined(bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
      topics: [id('determinationId')],
      data: [u('obligation'), u('available'), u('haircutBps'), u('bufferUnits'), u('drawQrl'), u('drawJunior'), u('drawSenior')],
    },
    DeterminationOpened: { signature: 'DeterminationOpened(bytes32,uint256)', topics: [id('determinationId')], data: [u('openedAt')] },
    DeterminationClosed: { signature: 'DeterminationClosed(bytes32)', topics: [id('determinationId')], data: [] },
  },
};

const ABI_OF = { court: 'ArkStakeCourt', pool: 'ArkJurorPool', bond: 'ArkCatBond' };

function value(type, v) {
  if (type === 'address') return norm(v);
  if (type === 'bytes32') return String(v).toLowerCase();
  if (type === 'bool') return Boolean(v);
  return BigInt(v);
}

/**
 * Every court, pool and bond event of a receipt, as `{ on, name, args }`,
 * each log read by the contract that emitted it (`Claimed` is the court's and
 * the bond's both). Addresses are lower-case 0x at their own width.
 */
function decode(ctx, receipt) {
  const q = ctx.r.q;
  const at = { court: q.ArkStakeCourt, pool: q.ArkJurorPool, bond: q.ArkCatBond };
  const build = qrlBuild(ctx.r.manifest.profile);
  const out = [];
  for (const [on, address] of Object.entries(at)) {
    const logs = (receipt.logs || []).filter((l) => same(l.address, address));
    if (!logs.length) continue;
    const specs = SPECS[on];
    if (ctx.r.qrlIsV3) {
      for (const ev of decodeQrlLogs(specs, logs)) {
        const spec = specs[ev.name];
        const args = {};
        for (const field of [...spec.topics, ...spec.data]) args[field.name] = value(field.type, ev.args[field.name]);
        out.push({ on, name: ev.name, args });
      }
      continue;
    }
    for (const ev of parseLogs(iface(ABI_OF[on], build), logs)) {
      const spec = specs[ev.name];
      if (!spec) continue;
      const args = {};
      for (const field of [...spec.topics, ...spec.data]) args[field.name] = value(field.type, ev.args[field.name]);
      out.push({ on, name: ev.name, args });
    }
  }
  return out;
}

/** One value, or a struct or a multi-return as an object read by position (OC-OPS-02). */
async function view(client, address, abi, method, args = []) {
  const res = await client.call(address, abi, method, args);
  const outs = abi.getFunction(method).outputs;
  if (outs.length === 1 && !outs[0].components) return res[0];
  if (outs.length === 1 && outs[0].components) {
    const t = res[0];
    return Object.fromEntries(outs[0].components.map((c, i) => [c.name, t[i]]));
  }
  return Object.fromEntries(outs.map((o, i) => [o.name || String(i), res[i]]));
}

/**
 * Run `tasks` (functions returning promises). On a live chain each sender
 * signs with its own key and nonce, so they go out together and land in a
 * block or two — the reveal window of the rapid profile is one minute. The
 * harness is one VM and runs them in order.
 */
async function all(ctx, tasks) {
  if (ctx.qrl.kind === 'qrl') return Promise.all(tasks.map((t) => t()));
  const out = [];
  for (const t of tasks) out.push(await t());
  return out;
}

/** Calldata a multisig forwards: 64-byte words on the QRL transport, 32 on the harness. */
function encode(client, abi, fn, args) {
  return client.kind === 'qrl' ? qrlCodec(abi).encode(fn, args) : abi.encodeFunctionData(fn, args);
}

/** The timelock's `Scheduled(opId, …, eta, …)` from a receipt, on either word width (as scripts/lib/governance.js reads it). */
function scheduled(client, timelockAbi, logs) {
  if (client.kind === 'qrl') {
    const spec = {
      signature: 'Scheduled(bytes32,address,bytes4,uint256,uint64,uint64,bytes)',
      topics: [id('opId'), who('target')],
      data: [u('value'), u('eta'), u('delay')],
    };
    const [ev] = decodeQrlLogs({ Scheduled: spec }, logs);
    return ev ? { opId: ev.args.opId, eta: BigInt(ev.args.eta) } : null;
  }
  const ev = parseLogs(timelockAbi, logs).find((x) => x.name === 'Scheduled');
  return ev ? { opId: ev.args.opId, eta: BigInt(ev.args.eta) } : null;
}

module.exports = { SPECS, decode, view, all, encode, scheduled, norm, same, isZero };
