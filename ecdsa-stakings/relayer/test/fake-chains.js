/**
 * Both legs as a few maps, for testing the relayer engine without a compiler,
 * a VM or a node.
 *
 * The one rule this module exists to enforce: **the fake keeps the ledger the
 * real failure would be judged by.** Every message any relayer signs is
 * recorded per leaf across every relayer instance built on one world, so a test
 * of crashes, a second process or a second host asserts the property itself —
 * no leaf signs two messages — rather than a proxy for it.
 *
 * The relay, attestation and registry reproduce the refusals the engine
 * decides on (`WrongLeafIndex`, `EpochNotForward`, `BadProof`, `WrongStatus`,
 * `FreezeUnchanged`, ...) and nothing else. Anything a test does not model
 * answers the way an idle chain would.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Interface, AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const ids = require('../lib/identifiers');
const { verify } = require('../lib/merkle');
const { clockFor } = require('../lib/epoch');
const { RelayerState } = require('../engine/state');
const { Relayer } = require('../engine/relayer');

const CHAIN_ID = 31337n;
const ZERO32 = '0x' + '00'.repeat(32);
const addr = (b) => '0x' + b.repeat(20);
const RELAY = addr('ee');
const ESCROW = addr('e1');
const ASSET = addr('a0');
const REGISTRY = addr('a1');
const ATTESTATION = addr('a2');
const QDAY = addr('a3');
/** The premium swap, where a test names it in the deployment. */
const SWAP = addr('a5');
/** The bond, for `seedReturnSealable` only (PV-17); a test names it in the deployment itself. */
const BOND = addr('a6');
/** The bond's coupon account, where a test names it (OC-ECON-05). */
const COUPON = addr('a7');
/** The bond's delegation, where a test names it (OC-LEGB-06). */
const DELEGATION = addr('a8');
/** `ArkBondDelegation.REPORT_KEYSPACE`: the tag in the upper 128 bits of every report key. */
const REPORT_KEYSPACE = BigInt(keccak256(toUtf8Bytes('ARK_DELEGATION_REPORTS_V1'))) << 128n;
const coder = AbiCoder.defaultAbiCoder();
const ASSET_KEY = '0x' + 'cd'.repeat(32);

const registryAbi = new Interface([
  'event ReleaseInstructed(bytes32 indexed stakeAssetId, address indexed recipient, uint64 claimNonce, bytes32 releaseLeaf, uint64 releasableAt, uint256 notional)',
  'event AssetDelisted(bytes32 indexed assetKey, uint8 reason)',
]);

/**
 * The escrow's `Anchored` in its QIP-55 shape (IArkStakeEscrow.sol): the bound
 * owner as the two canonical words of `qrlOwnerWords`, no longer indexed.
 */
/** The delegation's `Delegated`, as the relayer's report sealer scans it (OC-LEGB-06). */
const delegationAbi = new Interface(['event Delegated(bytes32 indexed pubkeyHash, uint256 amount, bytes32 depositRoot, uint256 delegated)']);

const escrowAbi = new Interface([
  'event Anchored(bytes32 indexed stakeAssetId, address indexed depositor, bytes32 qrlOwnerHi, bytes32 qrlOwnerLo, uint256 chainId, address asset, uint64 depositNonce, uint256 anchoredNotional, uint256 shares, uint256 epoch)',
  'event BufferReported(uint256 indexed epoch, uint256 shares, uint256 units, bytes32 bufferLeaf)',
  'event TransitMarked(bytes32 indexed stakeAssetId, uint256 indexed sealedEpoch, uint256 shares)',
  'event ReleaseQueued(bytes32 indexed stakeAssetId, address indexed recipient, uint256 indexed sealedEpoch, uint64 claimNonce, uint256 shares, uint256 queueIndex)',
  'event PremiumClaimed(bytes32 indexed lotId, bytes32 secret)',
]);

class Revert extends Error {
  constructor(name) {
    super(name);
    this.shortMessage = name;
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-engine-'));

class World {
  constructor() {
    this.clock = clockFor(600);
    this.now = this.clock.startOf(4_000_000n);
    this.block = 10n;
    this.authority = '0x' + '5a'.repeat(32);
    // One escrow, so its control (closure, freeze) stands for the relay's per-escrow record.
    this.relay = { nextLeaf: 0, lastEpoch: 0n, roots: new Map(), closed: false, frozen: false, freezeEpoch: 0n, published: new Map(), generation: 1, extensionAt: 0n };
    /** The authority chain's window and link; out of reach unless a test brings them near. */
    this.window = { opens: 1_000_000, closes: 1_000_001, horizon: 1_000_000 };
    this.chainCommit = ids.TERMINAL_COMMIT;
    /** leaf index -> every distinct message signed for it, by any relayer. */
    this.signatures = new Map();
    this.escrowCalls = [];
    /** Positions an early presentation of their receipt moved into transit (X7), and the logs of the last escrow send. */
    this.transit = new Set();
    this.sendLogs = [];
    this.anchoringClosed = false;
    this.attestation = new Map();
    this.anchors = new Map();
    /** Every AnchorInput the fake registry was handed, for arg-building asserts. */
    this.recordAnchorInputs = [];
    this.qrlLogs = [];
    this.originLogs = [];
    /** asset -> { epoch, units }: the buffers ArkStakeRegistry.recordBuffer took, and the epochs it refuses below. */
    this.buffers = new Map();
    /** Epochs the escrow's reportBuffer ran in. */
    this.bufferReports = [];
    this.qday = { declared: false, frozen: false };
    /** The bond's seal condition for a seed return (PV-17), and the escrow's stake. */
    this.bond = {
      sealable: true,
      /** The bond's book (OC-ECON-05): null where a test does not model it. */
      lastClosed: null,
      closeCalls: [],
      /** The claimant record (OC-LEGA-01): its ground, T, the settlement's stage, kinds by position, the recovery cursor. */
      ground: 0,
      at: 0n,
      stage: 0,
      claimant: new Map(),
      cursor: 0,
    };
    /** The coupon account (OC-ECON-05): its last distributed epoch, and every distribution. */
    this.coupon = { last: 0n, distributed: [] };
    /** Whether the escrow has yield to sweep (OC-LEGA-04). */
    this.sweepable = false;
    /** The delegation (OC-LEGB-06): funded validators by key hash, noted roots, applied lines. */
    this.delegation = { attestation: ATTESTATION, validators: new Map(), noted: new Map(), reconciled: [], fees: [], lastFeesEpoch: 0n };
    /** QRL blocks as the report sealer reads them: { number, timestamp, withdrawals, fees }. */
    this.qrlBlocks = [];
    this.escrowTotalStake = 0n;
    /** Seed returns governance has requested on the registry, per escrow (ORIGIN-01). */
    this.seedReturnRequests = 0n;
    this.alloc = { premiumBps: 3700, bufferBps: 250, operationsBps: 250, jurorFeeShareBps: 2000, levyBps: 0, sigmaTargetBps: 3700, coveredBps: 10000, psrCapBps: 11100, commitTermEpochs: 13 };
    /** A book change between the relayer's two allocation reads. */
    this.allocationDrift = null;
    this.qrlGenesis = { hash: '0x' + '9e'.repeat(32), timestamp: 1_000n };
    this.qrlChainId = 3151908n;
    this.registryCode = '0x6080';
    this.qrlHead = 100n;
    /** Hooks a test sets to interfere with one send: (method, args) => void, may throw. */
    this.beforeOriginSend = null;
    this.deployment = {
      qrlChainId: Number(this.qrlChainId),
      qrlGenesisHash: this.qrlGenesis.hash,
      deployedAt: '2026-09-22T00:00:00.000Z',
      deployedFromBlock: 1,
      relay: RELAY,
      qrl: { ArkStakeRegistry: REGISTRY, MockAttestation: ATTESTATION, MockQDayOracle: QDAY, ProceedsLedger: addr('a4') },
      assets: [{ symbol: 'mU', asset: ASSET, escrow: ESCROW, assetKey: ASSET_KEY }],
    };
  }

  epoch() {
    return this.clock.epochOf(this.now);
  }

  /** Move to `fraction` of the way through `epoch`, and past a block. */
  at(epoch, fraction = 0.6) {
    const t = this.clock.startOf(epoch) + BigInt(Math.floor(Number(this.clock.EPOCH_LENGTH) * fraction));
    if (t < this.now) throw new Error('the fake clock only moves forward');
    this.now = t;
    this.block += 1n;
  }

  maxMessagesPerLeaf() {
    return Math.max(0, ...[...this.signatures.values()].map((s) => s.size));
  }

  /** A one-of-one signer set, as `lib/authority.js` SignerSet presents one, recording every message per leaf. */
  signer() {
    const world = this;
    return {
      generation: 1,
      threshold: 1,
      _signed: new Map(),
      held() {
        return [0];
      },
      canSign() {
        return true;
      },
      roots() {
        return [world.authority];
      },
      prime(leaf, message) {
        this._signed.set(leaf, String(message).toLowerCase());
      },
      sign(message, leaf) {
        const prev = this._signed.get(leaf);
        if (prev && prev !== message.toLowerCase()) throw new Error(`leaf ${leaf} already signed another message in this process`);
        this._signed.set(leaf, message.toLowerCase());
        if (!world.signatures.has(leaf)) world.signatures.set(leaf, new Set());
        world.signatures.get(leaf).add(message.toLowerCase());
        return [{ signer: 0, ots: { leaf, message }, authPath: [] }];
      },
    };
  }

  /** Admission as the relay performs it, for the relayer or for anyone carrying its signature. */
  admit(epoch, root, leafCount, leafIndex, sigs, apply) {
    const r = this.relay;
    if (epoch <= r.lastEpoch) throw new Revert('EpochNotForward');
    if (epoch > this.epoch()) throw new Revert('FutureEpochRoot');
    if (leafIndex !== r.nextLeaf) throw new Revert('WrongLeafIndex');
    if (!leafCount) throw new Revert('ZeroRoot');
    // The message binds the leaf count (audit 2026-09-29, OL-01).
    const message = ids.rootMessage({ chainId: CHAIN_ID, relay: RELAY, epoch, epochRoot: root, leafCount });
    const sig = sigs && sigs[0] && sigs[0][1];
    if (!sig || sig.leaf !== leafIndex || sig.message.toLowerCase() !== message.toLowerCase()) throw new Revert('ThresholdNotMet');
    if (!apply) return;
    r.roots.set(BigInt(epoch), root);
    (r.leafCounts ||= new Map()).set(BigInt(epoch), Number(leafCount));
    r.lastEpoch = BigInt(epoch);
    r.nextLeaf += 1;
    this.block += 1n;
  }

  member(epoch, leaf, proof) {
    const root = this.relay.roots.get(BigInt(epoch));
    if (!root) throw new Revert('NoRootForEpoch');
    if (!verify(proof, root, leaf)) throw new Revert('BadProof');
  }

  originDispatch(to, method, args, apply) {
    if (to === RELAY) {
      const r = this.relay;
      switch (method) {
        case 'nextLeaf':
          return [BigInt(r.nextLeaf)];
        case 'lastEpoch':
          return [r.lastEpoch];
        case 'rootOf':
        case 'acceptedRoot':
          return [r.roots.get(BigInt(args[0])) || ZERO32];
        case 'controlOf':
          return [{ closed: r.closed, frozen: r.frozen, closedEpoch: 0n, freezeEpoch: r.freezeEpoch }];
        case 'isClosed':
          return [r.closed];
        case 'signerRoots':
          return [[this.authority]];
        case 'THRESHOLD':
          return [1n];
        case 'generation':
          return [BigInt(r.generation)];
        case 'extensionActivatesAt':
          return [r.extensionAt];
        case 'chainCommit':
          return [this.chainCommit];
        case 'EXTENSION_OPENS':
          return [BigInt(this.window.opens)];
        case 'EXTENSION_CLOSES':
          return [BigInt(this.window.closes)];
        case 'MIGRATION_HORIZON':
          return [BigInt(this.window.horizon)];
        case 'scheduleExtension': {
          const [nextRoots, nextCommit, epoch, epochRoot, leafCount, leafIndex, sigs] = args;
          if (r.extensionAt !== 0n) throw new Revert('ExtensionPending');
          if (r.nextLeaf < this.window.opens || r.nextLeaf >= this.window.closes) throw new Revert('OutsideExtensionWindow');
          if (ids.chainLink(nextRoots, nextCommit) !== this.chainCommit) throw new Revert('NotNextLink');
          if (BigInt(epoch) <= r.lastEpoch) throw new Revert('EpochNotForward');
          if (leafIndex !== r.nextLeaf) throw new Revert('WrongLeafIndex');
          const message = ids.extensionMessage({ chainId: CHAIN_ID, relay: RELAY, epoch, nextGeneration: r.generation + 1, link: this.chainCommit, epochRoot, leafCount });
          const sig = sigs && sigs[0] && sigs[0][1];
          if (!sig || sig.leaf !== leafIndex || sig.message.toLowerCase() !== message.toLowerCase()) throw new Revert('ThresholdNotMet');
          if (apply) {
            r.lastEpoch = BigInt(epoch);
            r.nextLeaf += 1;
            r.extensionAt = this.epoch() + 6n;
            r.pending = { nextRoots, nextCommit };
            // V2 (PV-18): the epoch's root rides with the extension.
            if (Number(leafCount)) {
              r.roots.set(BigInt(epoch), epochRoot);
              (r.leafCounts ||= new Map()).set(BigInt(epoch), Number(leafCount));
            }
          }
          return [];
        }
        case 'activateNextGeneration':
          if (r.extensionAt === 0n) throw new Revert('NoExtensionPending');
          if (this.epoch() < r.extensionAt) throw new Revert('RatchetRunning');
          if (apply) {
            r.generation += 1;
            r.nextLeaf = 0;
            r.extensionAt = 0n;
            this.chainCommit = r.pending.nextCommit;
          }
          return [];
        case 'leavesPublished':
          return [r.published.has(BigInt(args[0]))];
        case 'publishLeaves': {
          const root = r.roots.get(BigInt(args[0]));
          if (!root) throw new Revert('NoRootForEpoch');
          if (r.published.has(BigInt(args[0]))) throw new Revert('LeavesAlreadyPublished');
          if (r.leafCounts && r.leafCounts.get(BigInt(args[0])) !== args[1].length) throw new Revert('LeafCountMismatch');
          if (apply) r.published.set(BigInt(args[0]), [...args[1]]);
          return [];
        }
        case 'admitEpochRoot':
          if (apply && this.beforeOriginSend) this.beforeOriginSend(method, args);
          this.admit(BigInt(args[0]), args[1], args[2], args[3], args[4], apply);
          return [];
        case 'close':
          if (r.closed) throw new Revert('AlreadyClosed');
          this.member(args[1], ids.closeLeaf(CHAIN_ID, args[0]), args[2]);
          if (apply) r.closed = true;
          return [];
        case 'setFrozen': {
          const [escrow, frozen, epoch, proof] = args;
          if (r.closed) throw new Revert('AlreadyClosed');
          if (BigInt(epoch) <= r.freezeEpoch) throw new Revert('FreezeNotForward');
          if (r.frozen === frozen) throw new Revert('FreezeUnchanged');
          this.member(epoch, ids.freezeLeaf(CHAIN_ID, escrow, frozen), proof);
          if (apply) {
            r.frozen = frozen;
            r.freezeEpoch = BigInt(epoch);
          }
          return [];
        }
        default:
          throw new Error(`fake relay has no ${method}`);
      }
    }
    if (to === ESCROW) {
      switch (method) {
        case 'recordEpochAllocation': {
          const [epoch, rates, proof] = args;
          const values = Object.fromEntries(ids.ALLOCATION_FIELDS.map((f, i) => [f, rates[i]]));
          this.member(epoch, ids.allocationLeaf({ escrow: ESCROW, epoch, ...values }), proof);
          if (apply) this.escrowCalls.push({ method, epoch: BigInt(epoch) });
          return [];
        }
        case 'closeAnchoring': {
          const [epoch, proof] = args;
          if (this.anchoringClosed) throw new Revert('AnchoringIsClosed');
          this.member(epoch, ids.delistLeaf(CHAIN_ID, ESCROW, ASSET), proof);
          if (apply) {
            this.anchoringClosed = true;
            this.escrowCalls.push({ method, epoch: BigInt(epoch) });
          }
          return [];
        }
        case 'release': {
          // The escrow of 2026-09-29 (X7): a receipt presented before its
          // unbonding moves the position into transit and is not consumed;
          // presented again once due, it is.
          const [id, recipient, claimNonce, epoch, proof] = args;
          const leaf = ids.releaseLeaf(ESCROW, ids.releasePayload({ id, recipient, claimNonce, chainId: CHAIN_ID }));
          this.member(epoch, leaf, proof);
          const due = this.epoch() >= BigInt(epoch) + 4n;
          const log = (name, values) => {
            const { data, topics } = escrowAbi.encodeEventLog(escrowAbi.getEvent(name), values);
            return { address: ESCROW, topics, data, blockNumber: this.block, transactionHash: '0x', logIndex: 0 };
          };
          if (!due) {
            if (this.transit.has(id)) throw new Revert('UnbondingNotServed');
            if (apply) {
              this.transit.add(id);
              this.escrowCalls.push({ method: 'transit', epoch: BigInt(epoch) });
              this.sendLogs = [log('TransitMarked', [id, epoch, 1n])];
            }
            return [];
          }
          if (apply) {
            this.transit.delete(id);
            this.escrowCalls.push({ method, epoch: BigInt(epoch) });
            this.sendLogs = [log('ReleaseQueued', [id, recipient, epoch, claimNonce, 1n, 0n])];
          }
          return [];
        }
        case 'sweep':
          if (!this.sweepable) throw new Revert('NothingToSweep');
          if (apply) {
            this.sweepable = false;
            this.escrowCalls.push({ method, epoch: this.epoch() });
          }
          return [];
        case 'reportBuffer': {
          const e = this.epoch();
          if (this.bufferReports.includes(e)) throw new Revert('AlreadyReported');
          if (apply) this.bufferReports.push(e);
          return [e, 0n];
        }
        case 'queueHead':
        case 'queueTail':
          return [0n];
        case 'totalStake':
          return [this.escrowTotalStake];
        default:
          throw new Error(`fake escrow has no ${method}`);
      }
    }
    throw new Error(`fake origin chain has nothing at ${to}`);
  }

  qrlDispatch(to, method, args, apply) {
    if (to === SWAP) {
      this.offers ||= new Map();
      this.selections ||= [];
      if (method === 'recordOffer') {
        const key = `${String(args[2]).toLowerCase()}@${BigInt(args[3])}`;
        if (this.offers.has(key)) throw new Revert('OfferExists');
        if (apply) this.offers.set(key, { shares: args[4], units: args[5] });
        return [];
      }
      if (method === 'select') {
        if (apply) this.selections.push([String(args[1]).toLowerCase(), BigInt(args[2])]);
        return [];
      }
    }
    if (to === ATTESTATION) {
      if (method === 'seal') {
        // Write-once, as MockAttestation is, in the delegation's keyspace; a
        // forward epoch keeps the overwrite the reseal tests build on.
        const k = BigInt(args[0]);
        const cur = this.attestation.get(k);
        if (k >= 1n << 128n && cur && cur !== args[1]) throw new Revert('EpochAlreadySealed');
        if (apply) this.attestation.set(k, args[1]);
        return [];
      }
      if (method === 'rootOf') return [this.attestation.get(BigInt(args[0])) || ZERO32];
    }
    if (to === QDAY) {
      if (method === 'declared') return [this.qday.declared];
      if (method === 'frozen') return [this.qday.frozen];
    }
    if (to === BOND) {
      const b = this.bond;
      switch (method) {
        case 'seedReturnSealable':
          return [b.sealable];
        case 'state':
          if (b.lastClosed === null) break;
          return [{ lastClosedEpoch: b.lastClosed }];
        case 'closeEpochs': {
          const now = this.epoch();
          const from = b.lastClosed + 1n;
          if (from >= now) return [];
          const to = now - from > BigInt(args[0]) ? from + BigInt(args[0]) : now;
          if (apply) {
            b.lastClosed = to - 1n;
            b.closeCalls.push(BigInt(args[0]));
          }
          return [];
        }
        case 'claimants': {
          const c = [b.ground, b.at];
          c.ground = b.ground;
          return [c];
        }
        case 'claimantOf':
          return [b.claimant.get(args[0]) ?? 0, 0n];
        case 'declaration':
          return [{ stage: b.stage }];
        case 'escrowLedger':
          return [{ cursor: b.cursor, found: [ZERO32, ZERO32, ZERO32, ZERO32] }];
        default:
          break;
      }
    }
    if (to === COUPON) {
      if (method === 'lastDistributed') return [this.coupon.last];
      if (method === 'distribute') {
        const b = this.bond;
        if (b.lastClosed !== null && this.epoch() - (b.lastClosed + 1n) > 32n) throw new Revert('EpochGapTooLong');
        if (BigInt(args[0]) !== this.coupon.last + 1n) throw new Revert('EpochNotNext');
        if (apply) {
          this.coupon.last = BigInt(args[0]);
          this.coupon.distributed.push(BigInt(args[0]));
        }
        return [];
      }
    }
    if (to === DELEGATION) {
      const d = this.delegation;
      const cleared = (e, leaf, proof) => {
        const n = d.noted.get(BigInt(e));
        const key = REPORT_KEYSPACE | BigInt(e);
        if (!n || n.root !== this.attestation.get(key)) throw new Revert('RootNotNoted');
        if (this.now < this.clearsAt(e)) throw new Revert('ReportNotCleared');
        if (!verify(proof, n.root, leaf)) throw new Revert('BadProof');
      };
      switch (method) {
        case 'ATTESTATION':
          return [d.attestation];
        case 'reportKey':
          return [REPORT_KEYSPACE | BigInt(args[0])];
        case 'validatorOf':
          return [d.validators.get(String(args[0]).toLowerCase()) || { stake: 0n, closed: false, withdrawn: 0n, lastReportEpoch: 0n }];
        case 'validatorReportLeaf':
          return [reportLeaf(args[0])];
        case 'feesReportLeaf':
          return [feesLeaf(args[0], args[1])];
        case 'noteRoot': {
          const e = BigInt(args[0]);
          const root = this.attestation.get(REPORT_KEYSPACE | e);
          if (!root) throw new Revert('RootMissing');
          if (d.noted.get(e) && d.noted.get(e).root === root) throw new Revert('RootAlreadyNoted');
          if (apply) d.noted.set(e, { root, at: this.now });
          return [];
        }
        case 'reportClearsAt':
          return [this.clearsAt(args[0])];
        case 'reconcile': {
          const [line, proof] = args;
          const v = d.validators.get(String(line[1]).toLowerCase());
          if (!v || v.stake === 0n) throw new Revert('NotFunded');
          if (BigInt(line[0]) <= v.lastReportEpoch) throw new Revert('ReportNotForward');
          cleared(line[0], reportLeaf(line), proof);
          if (apply) {
            v.withdrawn = BigInt(line[7]);
            v.lastReportEpoch = BigInt(line[0]);
            d.reconciled.push(line);
          }
          return [];
        }
        case 'reconcileFees': {
          const [e, fees, proof] = args;
          if (BigInt(e) <= d.lastFeesEpoch) throw new Revert('ReportNotForward');
          cleared(e, feesLeaf(e, fees), proof);
          if (apply) {
            d.lastFeesEpoch = BigInt(e);
            d.fees.push([BigInt(e), BigInt(fees)]);
          }
          return [];
        }
        default:
          break;
      }
    }
    if (to === REGISTRY) {
      switch (method) {
        case 'seedReturnRequests':
          return [this.seedReturnRequests];
        case 'anchorOf':
          return [{ status: this.anchors.has(args[0]) ? this.anchors.get(args[0]).status : 1 }];
        case 'recordAnchor': {
          const [input, epoch, proof] = args;
          if (apply) this.recordAnchorInputs.push([...input]);
          const id = ids.stakeAssetId({ chainId: input[0], asset: input[1], depositor: input[2], boundQrlOwner: input[3], depositNonce: input[4] });
          if (this.anchors.has(id)) throw new Revert('AnchorExists');
          const root = this.attestation.get(BigInt(epoch));
          if (!root || !verify(proof, root, ids.stakeLeafKey(input[6], id, input[5]))) throw new Revert('BadProof');
          if (apply) this.anchors.set(id, { status: 1 });
          return [id];
        }
        case 'recordBuffer': {
          const [chainId, escrow, asset, epoch, units, proof] = args;
          const last = this.buffers.get(String(asset).toLowerCase());
          if (last && BigInt(epoch) <= last.epoch) throw new Revert('BufferReportNotNewer');
          const root = this.attestation.get(BigInt(epoch));
          if (!root || !verify(proof, root, ids.bufferLeaf({ chainId, escrow, asset, epoch, units }))) throw new Revert('BadProof');
          if (apply) this.buffers.set(String(asset).toLowerCase(), { epoch: BigInt(epoch), units: BigInt(units) });
          return [];
        }
        case 'recordReleaseSettled': {
          const a = this.anchors.get(args[0]);
          if (!a) throw new Revert('UnknownAnchor');
          if (a.status !== 2) throw new Revert('WrongStatus');
          if (apply) a.status = 3;
          return [];
        }
        case 'currentAllocationLeaf': {
          const epoch = this.epoch();
          const leaf = ids.allocationLeaf({ escrow: args[0], epoch, ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, f === 'sigmaBps' ? this.alloc.premiumBps : (this.alloc[f] ?? 0)])) });
          // The book moves between this read and the next one.
          if (this.allocationDrift) {
            this.alloc = { ...this.alloc, ...this.allocationDrift };
            this.allocationDrift = null;
          }
          return [epoch, leaf];
        }
        case 'allocation':
          return [{ ...this.alloc }];
        default:
          break;
      }
    }
    throw new Error(`fake QRL chain has no ${method} at ${to}`);
  }

  /** When the delegation's noted report root of `epoch` clears: the window after the later of the epoch's end and its noting. */
  clearsAt(epoch) {
    const n = this.delegation.noted.get(BigInt(epoch));
    if (!n) return 2n ** 256n - 1n;
    const end = this.clock.startOf(BigInt(epoch) + 1n);
    return (end > n.at ? end : n.at) + this.clock.CHALLENGE_WINDOW;
  }

  originClient() {
    const w = this;
    return {
      name: 'fake-origin',
      kind: 'fake',
      env: {},
      async head() {
        return { latest: w.block, safe: w.block - (w.safeLag || 0n), timestamp: w.now };
      },
      async timestampOf() {
        return w.now;
      },
      async logs(address, from, to) {
        return w.originLogs.filter((l) => l.address === address && l.blockNumber >= from && l.blockNumber <= to);
      },
      async call(to, _abi, method, args = []) {
        return w.originDispatch(to, method, args, false);
      },
      async send(to, _abi, method, args = []) {
        w.sendLogs = [];
        w.originDispatch(to, method, args, true);
        return { blockNumber: w.block, gasUsed: 1n, logs: w.sendLogs };
      },
    };
  }

  qrlClient() {
    const w = this;
    return {
      name: 'fake-qrl',
      kind: 'fake',
      env: {},
      async head() {
        return { latest: w.qrlHead, safe: w.qrlHead, timestamp: w.now };
      },
      async chainId() {
        return w.qrlChainId;
      },
      async code() {
        return w.registryCode;
      },
      async genesis() {
        return { ...w.qrlGenesis };
      },
      async logs(address, from, to) {
        return w.qrlLogs.filter((l) => l.address === address && l.blockNumber >= from && l.blockNumber <= to);
      },
      async call(to, _abi, method, args = []) {
        return w.qrlDispatch(to, method, args, false);
      },
      async send(to, _abi, method, args = []) {
        w.qrlDispatch(to, method, args, true);
        return { blockNumber: w.qrlHead, gasUsed: 1n, logs: [] };
      },
      /** The blocks a test laid down, as `qrlClient.blockFacts` reads them (OC-LEGB-06). */
      async blockFacts(from, to) {
        return w.qrlBlocks.filter((b) => b.number >= BigInt(from) && b.number <= BigInt(to));
      },
    };
  }

  /** A registry event, as the QRL node would return it from a log scan. */
  emitQrl(name, values) {
    const frag = registryAbi.getEvent(name);
    const { data, topics } = registryAbi.encodeEventLog(frag, values);
    this.qrlHead += 1n;
    this.qrlLogs.push({ address: REGISTRY, topics, data, blockNumber: this.qrlHead, transactionHash: '0x', logIndex: 0 });
  }

  /**
   * The escrow's `Anchored`, in its QIP-55 shape, as the origin scan would
   * find it: the owner emitted as the two words of `qrlOwnerWords`, at
   * whichever width the account has (0x+40 legacy or Q+128). Returns the
   * stakeAssetId, which commits to the owner.
   */
  emitAnchored({ boundQrlOwner, depositor = '0x' + '0d'.repeat(20), depositNonce = 1n, notional = 10n ** 18n, epoch = this.epoch() }) {
    const id = ids.stakeAssetId({ chainId: CHAIN_ID, asset: ASSET, depositor, boundQrlOwner, depositNonce });
    const words = ids.qrlOwnerWords(boundQrlOwner);
    const frag = escrowAbi.getEvent('Anchored');
    const { data, topics } = escrowAbi.encodeEventLog(frag, [id, depositor, words.hi, words.lo, CHAIN_ID, ASSET, depositNonce, notional, notional, epoch]);
    this.block += 1n;
    this.originLogs.push({ address: ESCROW, topics, data, blockNumber: this.block, transactionHash: '0x', logIndex: 0 });
    return id;
  }

  /** The delegation's `Delegated` for a key hash, as the QRL scan would find it. */
  emitDelegated(pubkeyHash) {
    const { data, topics } = delegationAbi.encodeEventLog(delegationAbi.getEvent('Delegated'), [pubkeyHash, 40_000n * 10n ** 18n, ZERO32, 40_000n * 10n ** 18n]);
    this.qrlHead += 1n;
    this.qrlLogs.push({ address: DELEGATION, topics, data, blockNumber: this.qrlHead, transactionHash: '0x', logIndex: 0 });
  }

  /** The escrow's `PremiumClaimed`, as the origin scan would find it. */
  emitPremiumClaimed(lotId, secret) {
    const { data, topics } = escrowAbi.encodeEventLog(escrowAbi.getEvent('PremiumClaimed'), [lotId, secret]);
    this.block += 1n;
    this.originLogs.push({ address: ESCROW, topics, data, blockNumber: this.block, transactionHash: '0x', logIndex: 0 });
  }

  /** The escrow's `BufferReported`, as the origin scan would find it. */
  emitBufferReported({ epoch = this.epoch(), units = 10n ** 18n }) {
    const leaf = ids.bufferLeaf({ chainId: CHAIN_ID, escrow: ESCROW, asset: ASSET, epoch, units });
    const frag = escrowAbi.getEvent('BufferReported');
    const { data, topics } = escrowAbi.encodeEventLog(frag, [epoch, units, units, leaf]);
    this.block += 1n;
    this.originLogs.push({ address: ESCROW, topics, data, blockNumber: this.block, transactionHash: '0x', logIndex: 0 });
    return leaf;
  }

  /**
   * A relayer over `dir`, built as `init` builds one but on this world's
   * clients: one call per process, so two calls over one directory are two
   * processes sharing a state file.
   */
  async relayer(dir, { signing = true, readOnly = false, adoptState = false, log = () => {}, qdayActs = true, env = {} } = {}) {
    const r = Object.create(Relayer.prototype);
    Object.assign(r, {
      chain: 'fake',
      log,
      sealAt: 0.5,
      adoptState,
      hostname: 'fake-host',
      injected: null,
      state: new RelayerState(dir),
      origin: { ...this.originClient(), env },
      // The world stands in for a private network, where the Q-Day double acts (mockQdayActs).
      qdayActs,
      qrl: this.qrlClient(),
      manifest: { deliveryMarginSeconds: 30, deployedFromBlock: 1, profile: 'testnet', authority: null },
      clock: this.clock,
      scanChunk: 2000n,
      chainId: CHAIN_ID,
      deployment: this.deployment,
      relay: RELAY,
      assets: [{ symbol: 'mU', asset: ASSET, escrow: ESCROW, rebasing: false }],
      abi: { relay: {}, units: escrowAbi, shares: escrowAbi, registry: registryAbi, ledger: {}, params: {}, attestation: {}, qday: {}, coupon: {}, delegation: delegationAbi, bond: {}, recovery: {}, catBond: {} },
      errors: new Interface([]),
      q: this.deployment.qrl,
      authority: [this.authority],
      threshold: 1,
      signers: this.signer(),
    });
    if (signing && !readOnly) r.unlock = r.state.lock();
    await r.openState({ signing: signing && !readOnly, readOnly });
    return r;
  }
}

/** The delegation's report leaves as the fake hashes them: any injective encoding serves, the relayer reads them back by eth_call. */
const reportLeaf = (line) => keccak256(coder.encode(['uint256', 'bytes32', 'uint8', 'bool', 'uint64', 'bytes32', 'uint256', 'uint256'], line));
const feesLeaf = (epoch, fees) => keccak256(coder.encode(['string', 'uint256', 'uint256'], ['FEES', epoch, fees]));

module.exports = { World, Revert, tmpDir, CHAIN_ID, RELAY, ESCROW, ASSET, REGISTRY, ATTESTATION, QDAY, SWAP, BOND, COUPON, DELEGATION, REPORT_KEYSPACE, ASSET_KEY, ZERO32, registryAbi, escrowAbi, delegationAbi, reportLeaf, feesLeaf };
