/**
 * contracts/core's governance stack as a scenario drives it: reads, sends,
 * payload encoding, receipt decoding and k-of-n multisig execution, on the
 * harness and on a QIP-55 node alike.
 *
 * Nothing here decides a rule; the scenarios do. What it settles once is the
 * two transports: on the harness an ethers Interface encodes and decodes with
 * 32-byte words and a sender is named by `from`; on a QRL node calldata and
 * logs are 64-byte words (`qrlCodec`, `decodeQrlLogs`) and a sender is a
 * client holding its own key (`ctx.actor`). An eth_call may still name any
 * `from` on both, which is how a refusal is asserted as the multisig, the
 * guardian or the timelock itself without holding their keys.
 */
const { keccak256, toUtf8Bytes } = require('ethers');
const { iface, qrlCodec, parseLogs, decodeQrlLogs, qrlClient } = require('../../lib/chains');
const { governanceBuild } = require('../../lib/governance');
const { toHex } = require('../../../ecdsa-stakings/relayer/lib/addresses');

const ONE = 10n ** 18n;
const same = (a, b) => Boolean(a) && Boolean(b) && toHex(a).toLowerCase() === toHex(b).toLowerCase();
const isZero = (a) => !a || BigInt(toHex(a)) === 0n;
const K = (name) => keccak256(toUtf8Bytes(name));
const selectorOf = (sig) => keccak256(toUtf8Bytes(sig)).slice(0, 10);

/** core `IArkTimelock.OpState`, `IArkGovernor.ProposalState`, `IArkQDayOracle.State`. */
const OP = { None: 0, Queued: 1, Executed: 2, Cancelled: 3, Expired: 4 };
const PROPOSAL = { None: 0, Pending: 1, Active: 2, Defeated: 3, Succeeded: 4, Queued: 5, Executed: 6, Cancelled: 7, Expired: 8, Contested: 9 };
const QDAY = { Normal: 0, Advisory: 1, Certified: 2, Declared: 3 };
/** core `IArkGovernor.ProposalKind` ordinals used here. */
const KIND = { StakingParameter: 8, StakingThreatStage: 9, StakingQDayRatification: 13 };

/**
 * The QIP-55 decode table of every event read here: indexed members as
 * topics, in order, then the scalar data members up to the first dynamic one.
 * A `bytes4` topic (Scheduled's selector) is left out: the payload is read
 * back from `opOf` where it matters.
 */
const QRL_EVENTS = {
  Scheduled: { signature: 'Scheduled(bytes32,address,bytes4,uint256,uint64,uint64,bytes)', topics: [{ name: 'opId', type: 'bytes32' }, { name: 'target', type: 'address' }], data: [{ name: 'value', type: 'uint256' }, { name: 'eta', type: 'uint64' }, { name: 'delay', type: 'uint64' }] },
  Cancelled: { signature: 'Cancelled(bytes32,address)', topics: [{ name: 'opId', type: 'bytes32' }, { name: 'by', type: 'address' }] },
  OpContested: { signature: 'OpContested(bytes32,uint64)', topics: [{ name: 'opId', type: 'bytes32' }], data: [{ name: 'eta', type: 'uint64' }] },
  ProposerHandedOver: { signature: 'ProposerHandedOver(address,address)', topics: [{ name: 'previous', type: 'address' }, { name: 'next', type: 'address' }] },
  GovernanceAccepted: { signature: 'GovernanceAccepted(address,address)', topics: [{ name: 'target', type: 'address' }, { name: 'by', type: 'address' }] },
  Submitted: { signature: 'Submitted(uint256,address,address,uint256,bytes)', topics: [{ name: 'id', type: 'uint256' }, { name: 'owner', type: 'address' }, { name: 'target', type: 'address' }], data: [{ name: 'value', type: 'uint256' }] },
  ProposalCreated: { signature: 'ProposalCreated(uint256,uint8,address,uint256,string)', topics: [{ name: 'id', type: 'uint256' }, { name: 'kind', type: 'uint8' }, { name: 'proposer', type: 'address' }], data: [{ name: 'round', type: 'uint256' }] },
  RoundOpened: { signature: 'RoundOpened(uint256,uint256)', topics: [{ name: 'round', type: 'uint256' }], data: [{ name: 'snapshot', type: 'uint256' }] },
  VoteCast: { signature: 'VoteCast(uint256,address,uint8,uint256,address)', topics: [{ name: 'id', type: 'uint256' }, { name: 'voter', type: 'address' }], data: [{ name: 'support', type: 'uint8' }, { name: 'weight', type: 'uint256' }, { name: 'overrode', type: 'address' }] },
  ProposalContested: { signature: 'ProposalContested(uint256,uint256)', topics: [{ name: 'id', type: 'uint256' }], data: [{ name: 'revoteRound', type: 'uint256' }] },
  ProposalResolved: { signature: 'ProposalResolved(uint256,bool)', topics: [{ name: 'id', type: 'uint256' }], data: [{ name: 'passed', type: 'bool' }] },
  PinRaised: { signature: 'PinRaised(address,uint64)', topics: [{ name: 'account', type: 'address' }], data: [{ name: 'until', type: 'uint64' }] },
  DelegatedHold: { signature: 'DelegatedHold(uint64,uint64)', data: [{ name: 'voteEnd', type: 'uint64' }, { name: 'until', type: 'uint64' }] },
  ParamChangeStaged: { signature: 'ParamChangeStaged(bytes32,uint256,uint256,uint256)', topics: [{ name: 'key', type: 'bytes32' }], data: [{ name: 'previous', type: 'uint256' }, { name: 'value', type: 'uint256' }, { name: 'effectiveEpoch', type: 'uint256' }] },
  AdvisoryLapsed: { signature: 'AdvisoryLapsed(uint256)', topics: [{ name: 'round', type: 'uint256' }] },
  Resolved: { signature: 'Resolved(uint256,bool)', topics: [{ name: 'round', type: 'uint256' }], data: [{ name: 'ratified', type: 'bool' }] },
};

/** A decoded event's members as plain values: addresses in the internal 0x form, numbers BigInt. */
function plain(args, spec) {
  const out = {};
  for (const f of [...(spec.topics || []), ...(spec.data || [])]) {
    const v = args[f.name];
    out[f.name] = f.type === 'address' ? toHex(v) : typeof v === 'number' ? BigInt(v) : v;
  }
  return out;
}

/**
 * The stack of a deployment's governance record, bound to a scenario.
 * `G` holds the record's addresses (0x form); `abi(name)` the vendored
 * Interface; `call`/`send` read and write as the relayer's account unless
 * `from`/`as` say otherwise.
 */
function stack(ctx) {
  const dep = ctx.r.deployment;
  if (!dep.governance || !dep.governance.addresses) return null;
  const G = Object.fromEntries(Object.entries(dep.governance.addresses).map(([n, a]) => [n, toHex(a)]));
  const build = governanceBuild({ client: ctx.qrl, profileName: ctx.r.manifest.profile });
  const abi = (n) => (n === 'ArkStakeParams' ? ctx.r.abi.params : iface(n, build));
  const onQrl = ctx.qrl.kind === 'qrl';
  const h = {
    ctx,
    G,
    build,
    abi,
    record: dep.governance,
    /** One value (or the whole result where there are several outputs). */
    async call(to, n, m, args = [], opts = {}) {
      const res = await ctx.qrl.call(to, abi(n), m, args, opts);
      return res.length === 1 ? res[0] : res;
    },
    /** A send from `as` (a client: the relayer's, or an actor's). */
    send(to, n, m, args = [], { as = ctx.qrl, ...opts } = {}) {
      return as.send(to, abi(n), m, args, opts);
    },
    /** Calldata for `n.m(args)` at this chain's word width. */
    encode(n, m, args) {
      return onQrl ? qrlCodec(abi(n)).encode(m, args) : abi(n).encodeFunctionData(m, args);
    },
    /** Events `name` that `address` emitted in `logs`. */
    decode(logs, address, n, name) {
      const mine = (logs || []).filter((l) => same(l.address, address));
      if (onQrl) return decodeQrlLogs({ [name]: QRL_EVENTS[name] }, mine).map((x) => ({ ...x, args: plain(x.args, QRL_EVENTS[name]) }));
      return parseLogs(abi(n), mine).filter((x) => x.name === name).map((x) => ({ ...x, args: plain(x.args, QRL_EVENTS[name]) }));
    },
    /** Events `name` that `address` emitted since `fromBlock`. */
    async since(address, n, name, fromBlock) {
      const head = await ctx.qrl.head();
      return h.decode(await ctx.qrl.logs(address, fromBlock, head.latest), address, n, name);
    },
    async now() {
      return (await ctx.qrl.head()).timestamp;
    },
    async epoch() {
      return ctx.clock.epochOf(await h.now());
    },
    /** Ticks until the chain's clock reaches `t`, with a timeout derived from the distance. */
    async until(label, t) {
      const left = BigInt(t) - (await h.now());
      const E = BigInt(ctx.clock.EPOCH_LENGTH);
      await ctx.waitFor(label, async () => (await h.now()) >= BigInt(t), { timeoutEpochs: left > 0n ? Number(left / E) + 2 : 1 });
    },
    /** Ticks until epoch `e` has begun. */
    async untilEpoch(label, e) {
      await h.until(label, BigInt(e) * BigInt(ctx.clock.EPOCH_LENGTH));
    },
  };
  return h;
}

/**
 * The clients this run holds a key for among `owners`: the relayer's own
 * account, or an e2e actor whose label is in `labels`. On the harness the
 * scenario's overrides name the actors' static addresses as owners; on a live
 * chain an owner matches only where the deployment was configured with the
 * actor's derived address. Each matched actor is topped up to `fund`.
 */
/**
 * On a live chain, the role keys this machine's .env holds by the names the
 * deployment was configured with (`GOV_OWNER<n>_MNEMONIC`,
 * `GOV_GUARDIAN<n>_MNEMONIC`, `QDAY_ATTESTER<n>_MNEMONIC`): the operator's own
 * keys for the multisigs and the panel, which never go to the VPS. Only their
 * addresses are read here; the mnemonic stays in the client.
 */
function envRoleClients(ctx) {
  if (ctx._envRoles) return ctx._envRoles;
  ctx._envRoles = [];
  if (ctx.qrl.kind !== 'qrl' || !ctx.qrl.env) return ctx._envRoles;
  for (const name of Object.keys(ctx.qrl.env)) {
    const m = name.match(/^((?:GOV_OWNER|GOV_GUARDIAN|QDAY_ATTESTER)\d+)_MNEMONIC$/);
    if (!m || !ctx.qrl.env[name]) continue;
    try {
      ctx._envRoles.push({ label: m[1].toLowerCase(), client: qrlClient({ name: m[1].toLowerCase(), mnemonicKey: name }) });
    } catch {
      // A malformed entry is not a key this run holds.
    }
  }
  return ctx._envRoles;
}

async function signersFor(ctx, owners, labels, fund = 0n) {
  const out = [];
  for (const o of owners) {
    if (same(o, ctx.qrl.address)) {
      out.push({ owner: toHex(o), client: ctx.qrl, label: 'deployer' });
      continue;
    }
    const role = envRoleClients(ctx).find((r) => same(r.client.address, o));
    if (role) {
      if (fund > 0n) {
        const have = BigInt(await ctx.qrl.balance(role.client.address));
        if (have < fund) await ctx.qrl.transfer(role.client.address, fund - have);
      }
      out.push({ owner: toHex(o), client: role.client, label: role.label });
      continue;
    }
    for (const label of labels) {
      const a = await ctx.actor(label);
      if (same(a.address, o)) {
        out.push({ owner: toHex(o), client: await ctx.actor(label, { fund }), label });
        break;
      }
    }
  }
  return out;
}

/**
 * An ArkMultisig driven through the keys this run holds. `run` submits a
 * transaction, gathers approvals up to the threshold from distinct owners and
 * executes it, returning the multisig tx id and the executing receipt.
 */
function multisig(h, address, signers, threshold) {
  const m = {
    address,
    signers,
    threshold: BigInt(threshold),
    get able() {
      return BigInt(signers.length) >= m.threshold;
    },
    async submit(target, payload) {
      const r = await h.send(address, 'ArkMultisig', 'submit', [target, 0n, payload], { as: signers[0].client });
      const [ev] = h.decode(r.logs, address, 'ArkMultisig', 'Submitted');
      if (!ev) throw new Error('ArkMultisig.submit emitted no Submitted event');
      return BigInt(ev.args.id);
    },
    /** Approvals from held owners that have not approved yet, up to the threshold; then execute. */
    async complete(id, executor = signers[0]) {
      // Not the `approved(id, owner)` getter: on the v3 build a public
      // mapping's getter with an address key reads false for every owner
      // (OC-V3-02, 2026-10-07), so the submitter was asked to approve twice.
      // An owner whose approval leaves the count where it was had approved.
      for (const s of signers) {
        const before = BigInt(await h.call(address, 'ArkMultisig', 'approvalCount', [id]));
        if (before >= m.threshold) break;
        try {
          await h.call(address, 'ArkMultisig', 'approve', [id], { from: s.client.address });
        } catch {
          continue; // AlreadyApproved (or not live): nothing this owner can add
        }
        await h.send(address, 'ArkMultisig', 'approve', [id], { as: s.client });
      }
      try {
        return await h.send(address, 'ArkMultisig', 'execute', [id], { as: executor.client });
      } catch (e) {
        // The inner call's revert reaches here only as a failed gas estimate;
        // name it, so a live failure says what the timelock refused.
        let name = '';
        try {
          name = require('../../../ecdsa-stakings/relayer/engine/errors').revertName(h.ctx.r.errors, e) || '';
        } catch {
          /* unnamed */
        }
        throw new Error(`ArkMultisig.execute(${id}) reverted${name ? `: ${name}` : ''}: ${e.shortMessage || e.message}`);
      }
    },
    async run(target, payload) {
      const id = await m.submit(target, payload);
      const receipt = await m.complete(id);
      return { id, receipt };
    },
    /** `timelock.schedule(target, inner)` through this multisig; the Scheduled event of the receipt. */
    async schedule(target, inner) {
      const { id, receipt } = await m.run(h.G.ArkTimelock, h.encode('ArkTimelock', 'schedule', [target, inner]));
      const [ev] = h.decode(receipt.logs, h.G.ArkTimelock, 'ArkTimelock', 'Scheduled');
      if (!ev) throw new Error('the multisig executed, and the timelock emitted no Scheduled event');
      return { multisigTx: id, opId: ev.args.opId, eta: BigInt(ev.args.eta), delay: BigInt(ev.args.delay), blockNumber: BigInt(receipt.blockNumber), receipt };
    },
    /** `timelock.cancel(opId)` through this multisig; the Cancelled event. */
    async cancel(opId) {
      const { receipt } = await m.run(h.G.ArkTimelock, h.encode('ArkTimelock', 'cancel', [opId]));
      const [ev] = h.decode(receipt.logs, h.G.ArkTimelock, 'ArkTimelock', 'Cancelled');
      return ev ? ev.args : null;
    },
  };
  return m;
}

module.exports = { stack, signersFor, multisig, same, isZero, K, selectorOf, OP, PROPOSAL, QDAY, KIND, ONE, QRL_EVENTS };
