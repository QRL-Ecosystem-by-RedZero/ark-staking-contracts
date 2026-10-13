/**
 * The relayer for one testnet-profile origin chain and its QRL leg.
 *
 * The one rule this module exists to enforce: **the relayer carries facts, it
 * never originates authority.** Every write it makes is permissionless on the
 * contract it reaches — a proof or a one-time signature is the authority, and
 * the relayer is only the account that paid gas. The one secret it holds, the
 * one-time key seed, is spent leaf by leaf under the rule of `state.js`, and
 * it refuses to spend one from a state that does not account for every leaf
 * the relay has already admitted.
 *
 * Forward (origin -> QRL), standing in for the attester quorum: once an origin
 * epoch has closed and every block of it is final, the escrows' `Anchored`,
 * `Released` and `PremiumOffered` events of that epoch become one Merkle root
 * sealed into `MockAttestation`; each anchor and release is recorded on the
 * registry with its proof, and each offer on `PremiumSwap`.
 *
 * Return (QRL -> origin), whitepaper §3.5 and §3.6: once per epoch the pending
 * leaves — each escrow's allocation, every release instructed on QRL, every
 * premium lock `PremiumSwap` selected, every de-listing the registry emitted,
 * and what `enqueue` was handed — become the epoch root, signed by k signers
 * of the relay's active generation at the one index the set shares
 * (`lib/authority.js`, D1) and admitted by the relay; its ordered leaves are
 * then published on the origin chain (`publishLeaves`, D15), so a claimant
 * needs no copy of this state to build a proof. Each leaf is consumed on the
 * origin chain as soon as the escrow will take it (a release leaf from its
 * root's epoch + 4, the unbonding the escrow checks for itself). A control leaf
 * — closure, the freeze, a de-listing — is sealed at the first moment the relay
 * will take a root, not at the half-way mark, because each of them exists to
 * stop something that is still happening. Every leaf binds the escrow it acts
 * on (D10): an allocation, a closure and a freeze are one leaf per escrow. A
 * premium lock is urgent too, since it must be admitted before its evmExpiry;
 * because the epoch has one root, an urgent seal waits (for half an admission
 * window at most) for every offering whose quote window has just closed to be
 * selected and scanned, and a lock past its evmExpiry is pruned, never sealed
 * (OC-SWAP-01).
 *
 * The authority chain (whitepaper §3.6, I35): inside [5,000, 9,500) bps of the
 * active generation's leaves the relayer signs an extension to the next link
 * the manifest records (`authority.generations`), in an epoch with no control
 * leaf waiting, and activates it once its six epochs have run. A cancellation
 * is an operator's signed inbox entry (`cancel-extension`).
 *
 * The premium swap of whitepaper §4.7, all permissionless: each offering's
 * lots are selected when its quote window closes, a solver's preimage revealed
 * by `claimPremium` on the origin chain is carried to `PremiumSwap.claim`,
 * where the lot's QRL is credited to the ledger, and lapsed lots are refunded
 * to their solvers. The relayer holds no QRL of its own for the coupon — the
 * stand-in auction that delivered from its account is gone. It never presents
 * a premium lock: only the solver holds the preimage.
 *
 * Housekeeping, all permissionless: a sweep per escrow per epoch and a premium
 * offer once earlier lots have expired, the exit queue drained under its
 * bound, the bond's book closed in batches after an outage (OC-ECON-05) and
 * its coupon distributed for every epoch whose settlement window has closed,
 * and, on the testnet attestation double, the delegation's reconciliation
 * and fees reports sealed from the beacon chain (OC-LEGB-06). And, as a keeper of trigger 2 (whitepaper §5.2, §4.6,
 * §5.4), once a declaration is ratified or the censorship ground is found:
 * the claimant record in batches, the opening draw, the severity balance at
 * the close of the assessment window, and each escrow's waiting recoveries —
 * the bond's own calls, each idempotent, none a stand-in.
 *
 * Stand-ins. `enqueue` is the one place a leaf enters that no built procedure
 * produced — the dispute court, the Q-Day declaration and governance's
 * de-listing are not written (CLAUDE.md §8.1). Every such leaf is labelled with
 * what it stands in for, and `status` shows the label.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ids = require('../lib/identifiers');
const { buildTree, proofFor } = require('../lib/merkle');

/** No root rides with an authority message: the zero word, with a count of zero (V2, PV-18). */
const ZERO_WORD = '0x' + '00'.repeat(32);
const { SignerSet, seedsFromEnv, sigsArg, MAX_GENERATIONS } = require('../lib/authority');
const { clockFor } = require('../lib/epoch');
const { allowedSigners, openEnvelope, audit } = require('../lib/inbox');
const { toHex } = require('../lib/addresses');
const { RelayerState } = require('./state');
const { errorInterface, revertName } = require('./errors');
const { originClient, qrlClient, iface, parseLogs, decodeQrlLogs, evmToQrl, QRL_EVENTS, qrlAbiBuild, qrlBuild, qrvmBuild, ROOT } = require('../../../scripts/lib/chains');
const { beaconFromEnv } = require('../lib/beacon');
const { profile: buildProfile } = require('../../../scripts/lib/profile');
const { fundPoolValidator } = require('../../../scripts/lib/pool-validator');
const { vendoredLine } = require('../../../scripts/lib/governance');

/** The escrow's own constant: a release leaf sealed into epoch e is usable from e + 4. */
const RELEASE_EPOCH_DELAY = 4n;
/** The relay's RATCHET_EPOCHS: an extension activates this many epochs after it is admitted. */
const RATCHET_EPOCHS = 6;
const DEFAULT_SCAN_CHUNK = 2000n;
const DRAIN_ENTRIES = 16;
/**
 * Epochs of coupon one tick may distribute. `ArkBondCoupon.distribute` advances
 * one epoch per call, so a relayer that was down for a day has a backlog; a
 * cap keeps one tick from spending minutes of rate-limited sends on it.
 */
const DISTRIBUTE_EPOCHS = 8;
/** Positions per `recordClaimants` call: the record is one storage write per position. */
const CLAIMANT_BATCH = 16;
/** Trigger-2 stages, as `ArkCatBondStore` numbers them. */
const T2_WINDOW = 1;
const T2_HELD = 2;
const T2_SETTLED = 3;
/** Refusals of `settleSeverity` meaning "not yet": the window runs, or the series is silent (HELD). */
const SEVERITY_WAIT = new Set(['AssessmentWindowOpen', 'SeverityUnmeasurable', 'NothingHeld']);
/** The bond's successor slots per escrow (`ArkCatBondRecovery.SLOTS`). */
const RECOVERY_SLOTS = 4;

/**
 * Refusals on the origin chain meaning "not yet": the leaf stays and is tried
 * again next tick. `FreezeUnchanged` is here rather than final: a freeze leaf
 * restating the flag is refused today and later superseded by a newer freeze
 * root (`FreezeNotForward`, final), and a relay that advances on an equal state
 * instead of reverting takes it on the next try.
 */
const WAIT = new Set(['UnbondingNotServed', 'ReleaseFrozen', 'PremiumExceedsPot', 'ShareExceedsHolding', 'FutureEpochAllocation', 'NoRootForEpoch', 'FreezeUnchanged']);
/** Refusals on the origin chain meaning the leaf's work is done or can never be done; recorded, not retried. */
const FINAL = new Set(['ProofSpent', 'AnchorExists', 'AlreadyClosed', 'FreezeNotForward', 'AllocationNotForward', 'AnchoringIsClosed', 'ReleaseClosed', 'SettlementClosed', 'WrongClaimNonce', 'UnknownPosition', 'BadProof', 'PremiumExpired']);
/**
 * Refusals on the forward path that no later tick can change. `BadProof` is
 * deliberately absent: on the forward path it means the attestation's root for
 * the epoch is no longer the one this relayer sealed, which a reseal repairs,
 * and an anchor never recorded is a deposit that can never be released.
 */
const FORWARD_FINAL = new Set(['ProofSpent', 'AnchorExists', 'NoBeneficiary', 'ZeroValue', 'OfferNotForward']);
/** Leaves that stop something in progress, sealed without waiting for the half-way mark. */
const CONTROL = new Set(['close', 'freeze', 'delist', 'premium']);
/**
 * The bond's close batch (`ArkCatBondStore.MAX_CLOSE`): every strict close
 * path — `distribute` among them — refuses a gap of more than this many
 * epochs with `EpochGapTooLong` (OC-ECON-05), and `closeEpochs` closes it in
 * batches of at most this many.
 */
const BOND_MAX_CLOSE = 32n;
/** `closeEpochs` calls one tick may make: a relayer down for a long time catches up over several. */
const CLOSE_BATCHES = 8;
/** The bond's claimant grounds and kinds (`ArkCatBondStore`). */
const GROUND_CENSORSHIP = 2;
const CLAIMANT = 1;
const LATE = 2;
/**
 * Epochs after T a censorship-ground claimant's sealed release is withheld
 * for when its escrow's recovery is never applied (OC-LEGA-01): the hold
 * lapses then, with an ALARM, so a court that never finds is not a lock on
 * the claimant for ever. Three of the widest assessment windows (6) and the
 * court's own windows beside them; a manifest may name `recoveryHoldEpochs`.
 */
const RECOVERY_HOLD_EPOCHS = 24n;
/**
 * Epochs the authority chain's extension may stay unscheduled once it is due
 * before the relayer raises an ALARM (OC-LEGA-06).
 */
const EXTENSION_ALARM_EPOCHS = 12n;
/** QRL blocks one tick scans for the delegation's withdrawals and fees (OC-LEGB-06). */
const REPORT_SCAN_BLOCKS = 256n;
/** Report epochs one tick seals (OC-LEGB-06): a backlog is caught up over several. */
const REPORT_EPOCHS = 4;
/** `IArkBondDelegation.Report.status` from which a line carries an exit epoch (lib/beacon.js numbers the rest). */
const ACTIVE_EXITING = 3;
/** `reconcile` refusals no later tick changes for a report line: recorded, not retried. */
const REPORT_FINAL = new Set(['ReportNotForward', 'ValidatorClosed', 'NotFunded', 'WithdrawalsWentBackwards', 'BadStatus', 'BadProof']);

const STAND_IN = { loss: 'court', recovery: 'court', close: 'qday', freeze: 'qday', delist: 'governance' };
const ZERO32 = '0x' + '00'.repeat(32);

/**
 * The key a signed message is recorded under: the leaf index within its
 * generation. Generation 1 keeps the bare index, so a state written before
 * the authority chain reads unchanged; a later generation's leaf 0 is a
 * different key from generation 1's.
 */
const leafKey = (generation, leaf) => (Number(generation) <= 1 ? String(leaf) : `${generation}:${leaf}`);
const DELIST_REASON = ['governance', 'yield below the floor'];

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
const lower = (v) => String(v).toLowerCase();
const random32 = () => '0x' + crypto.randomBytes(32).toString('hex');
const envKey = (chain) => chain.toUpperCase().replace(/-/g, '_');

/**
 * The bound owner's account form, from the two words the escrow's `Anchored`
 * event emits (`ArkStakeIds.qrlOwnerWords` — identifiers.js holds the rule).
 * An all-zero high word is the legacy 20-byte form, right-aligned in the low
 * word; anything else is a QIP-55 (testnet v3) 64-byte account, `Q` + the two
 * words. The result is the ONE canonical string the state keeps: `0x`+40 or
 * `Q`+128, self-describing at either width.
 */
function ownerFromWords(qrlOwnerHi, qrlOwnerLo) {
  const hi = String(qrlOwnerHi).replace(/^0x/i, '').toLowerCase();
  const lo = String(qrlOwnerLo).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hi) || !/^[0-9a-f]{64}$/.test(lo)) {
    throw new Error(`Anchored owner words are two bytes32: got ${qrlOwnerHi}, ${qrlOwnerLo}`);
  }
  if (/^0+$/.test(hi) && /^0{24}/.test(lo)) return `0x${lo.slice(24)}`;
  return `Q${hi}${lo}`;
}

/**
 * Whether a declaration or a freeze read from `MockQDayOracle` may become a
 * leaf (audit 2026-09-27, D2).
 *
 * The double is a test double even where `deployQrlLeg` puts it on a shared
 * devnet, and a `close` leaf is terminal for the escrow: read automatically,
 * whoever held the double's key — before 2026-09-27, anyone reaching the QRL
 * RPC — could close the Hoodi escrow for good. So it acts by default only
 * where the origin chain is itself a stand-in (the harness, the private
 * enclave: manifest `client` `harness` or `qrl`), and on a real origin chain
 * only where the operator says so, per chain, with `<CHAIN>_QDAY_MOCK_ACTS=1`.
 * `=0` turns it off anywhere. Otherwise the reading is logged and nothing is
 * queued; `relay seal close` remains, signed by an operator (lib/inbox.js).
 */
function mockQdayActs(manifest = {}, env = {}, chain = '') {
  const flag = env[`${envKey(chain)}_QDAY_MOCK_ACTS`];
  if (flag === '1') return true;
  if (flag === '0') return false;
  return manifest.client === 'harness' || manifest.client === 'qrl';
}

/**
 * Which Q-Day oracle the QRL leg of a deployment record reads, and where:
 * `{ kind: 'real', address }` for contracts/core's `ArkQDayOracle`,
 * `{ kind: 'mock', address }` for `MockQDayOracle`, or null for neither. The
 * record's `qday` block says so since phase C3b; an older record is read by
 * the name its `qrl` addresses carry.
 */
function qdayOracleOf(deployment = {}) {
  const q = deployment.qrl || {};
  const block = deployment.qday;
  if (block && block.address && (block.kind === 'real' || block.kind === 'mock')) return { kind: block.kind, address: block.address };
  if (q.ArkQDayOracle) return { kind: 'real', address: q.ArkQDayOracle };
  if (q.MockQDayOracle) return { kind: 'mock', address: q.MockQDayOracle };
  return null;
}

/**
 * Why this host may not run the signing relayer for `chain`, or null. The
 * one-time seed can sit on two hosts — the operator's .env and the VPS — and
 * each relayer starts from its own state, so a second host signing is a leaf
 * signing two messages. `<CHAIN>_RELAYER_HOST` names the one host that signs.
 */
function hostRefusal(env, chain, hostname) {
  const expected = env && env[`${envKey(chain)}_RELAYER_HOST`];
  if (!expected || String(expected).trim() === hostname) return null;
  return `${envKey(chain)}_RELAYER_HOST names ${String(expected).trim()} and this host is ${hostname}: the ${chain} relayer signs from that host only. ` +
    'status and seal still work here';
}

class Relayer {
  constructor({ chain, log = console.log, sealAt = 0.5, seed = null, seeds = null, treeHeight = null, adoptState = false, hostname = os.hostname() }) {
    this.chain = chain;
    this.log = log;
    this.sealAt = sealAt;
    this.adoptState = adoptState;
    this.hostname = hostname;
    // A local run hands the signer seeds over directly; a deployment an
    // operator keeps puts them in .env, where a relayer in another process
    // finds them (`<CHAIN>_OTS_SEED_<i>`, or `<CHAIN>_OTS_SEED` for signer 0).
    const held = seeds || (seed ? [seed] : null);
    this.injected = held ? { seeds: held, height: treeHeight } : null;
    this.state = new RelayerState(path.join(ROOT, '.relayer', chain));
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * `lock` is the signing relayer; `readOnly` is `status`, which reads the
   * state and never writes it — a save from a process not holding the lock
   * would write back whatever it read, over a record the running relayer made
   * in between.
   */
  async init({ lock = true, readOnly = false } = {}) {
    const signing = lock && !readOnly;
    if (signing) this.unlock = this.state.lock();
    try {
      await this.connect({ signing });
      await this.openState({ signing, readOnly });
    } catch (e) {
      this.close();
      throw e;
    }
    return this;
  }

  async connect({ signing }) {
    const { client, manifest, build } = await originClient(this.chain);
    this.origin = client;
    this.manifest = manifest;
    this.originBuild = build;
    this.clock = clockFor(buildProfile(manifest.profile).day);
    this.qdayActs = mockQdayActs(manifest, client.env, this.chain);
    this.scanChunk = BigInt(manifest.logChunkBlocks || DEFAULT_SCAN_CHUNK);
    this.chainId = big(manifest.chainId);

    if (signing) {
      const refusal = hostRefusal(client.env, this.chain, this.hostname);
      if (refusal) throw new Error(refusal);
    }

    const depFile = path.join(ROOT, 'deployments', `testnet-${this.chain}.json`);
    if (!fs.existsSync(depFile)) throw new Error(`no ${path.relative(ROOT, depFile)} — run: npm run deploy:testnet -- --chain ${this.chain}`);
    this.deployment = JSON.parse(fs.readFileSync(depFile, 'utf8'));
    // A stand-in origin chain — the enclave, or the local harness — is the same
    // chain as the QRL leg, so both legs are spoken to through one client.
    this.qrl = manifest.client === 'evm' ? qrlClient() : client;
    // The attestation sealer as an account of its own (D2): where the relayer
    // host holds QRL_SEALER_MNEMONIC, roots are sealed from it and every other
    // QRL call stays on the relayer's account. `deployQrlLeg` hands the
    // double's sealer to SEALER_ADDRESS on a shared network only, so the same
    // rule picks the key here: a private rehearsal (`"shared": false`) seals
    // from the deployer it was deployed with (NotSealer otherwise, 2026-10-03).
    this.sealer = require('../lib/manifest').isShared(manifest) && this.qrl.env && this.qrl.env.QRL_SEALER_MNEMONIC
      ? qrlClient({ name: 'qrl-sealer', mnemonicKey: 'QRL_SEALER_MNEMONIC' })
      : this.qrl;

    this.relay = toHex(manifest.addresses.relay);
    if (this.deployment.relay !== this.relay) {
      throw new Error(`the QRL leg of ${depFile} was wired to relay ${this.deployment.relay}, the manifest names ${this.relay}; redeploy the QRL leg`);
    }
    this.assets = manifest.assets.map((a) => ({ ...a, asset: toHex(a.address), escrow: toHex(a.escrow), form: a.rebasing ? 'ArkStakeEscrowShares' : 'ArkStakeEscrowUnits' }));

    // The QRL leg's ABIs: the harness line `build<suffix>/` where it holds
    // the artifact, else the QRVM line `build-qrvm<suffix>/` — a profile built
    // for v3 only has no harness line, and the ABIs are the same JSON
    // (OC-OPS-09). Per artifact, so a half-built line still serves the rest.
    const qi = (name) => iface(name, qrlAbiBuild(manifest.profile, name));
    this.abi = {
      relay: iface('ArkEpochRootRelay', build),
      units: iface('ArkStakeEscrowUnits', build),
      shares: iface('ArkStakeEscrowShares', build),
      registry: qi('ArkStakeRegistry'),
      ledger: qi('ProceedsLedger'),
      params: qi('ArkStakeParams'),
      attestation: qi('MockAttestation'),
      qday: qi('MockQDayOracle'),
      coupon: qi('ArkBondCoupon'),
      pool: qi('ArkStakingPool'),
      delegation: qi('ArkBondDelegation'),
      staking: qi('ArkBondStaking'),
      swap: qi('PremiumSwap'),
      // Build 2's surface, at the bond's address (phase C3).
      bond: qi('ArkCatBondSettlement'),
      // The fourth body, also at the bond's address (phase C3b): the claimant
      // record and the subrogation recovery.
      recovery: qi('ArkCatBondRecovery'),
      // The bond's own surface, for `seedReturnSealable` (PV-17) and `closeEpochs` (OC-ECON-05).
      catBond: qi('ArkCatBond'),
    };
    // The beacon chain as the report sealer reads it (OC-LEGB-06), where the
    // host names one (`QRL_BEACON_URL`, written by kurtosis-up.sh).
    this.beacon = beaconFromEnv(this.qrl.env || client.env || {});
    // A real asset is reached through the double's ABI: `balanceOf`,
    // `approve` and the share accessors are the standard ones, and the only
    // function a double adds — `mint` — is never called on a real asset.
    this.tokenAbi = (a) => iface(a.mock || (a.rebasing ? 'MockRebasingAsset' : 'MockAsset'), build);
    // contracts/core's governance errors too, from the vendored artifacts: the
    // keeper and the scenarios read refusals of the oracle, the timelock and
    // the governor by name.
    this.errors = errorInterface([qrlBuild(manifest.profile), qrvmBuild(manifest.profile), build, vendoredLine({ qrvm: false, profileName: manifest.profile }), vendoredLine({ qrvm: true, profileName: manifest.profile })]);
    this.q = this.deployment.qrl;

    const upper = envKey(this.chain);
    this.authority = [...(await this.relayView('signerRoots'))];
    this.threshold = Number(await this.relayView('THRESHOLD'));
    const generation = Number(await this.relayView('generation'));
    const n = this.authority.length;
    const seeds = this.injected
      ? Array.from({ length: n }, (_, i) => this.injected.seeds[i] || null)
      : seedsFromEnv(this.origin.env, this.chain, n);
    const height = Number(this.injected && this.injected.height ? this.injected.height : this.origin.env[`${upper}_OTS_HEIGHT`] || (manifest.authority && manifest.authority.treeHeight));
    if (!seeds.some(Boolean) || !height) {
      // `status` needs no key; only a relayer that signs does.
      if (signing) throw new Error(`${upper}_OTS_SEED_<i> / ${upper}_OTS_HEIGHT missing from .env — they are written by deploy:evm`);
      return;
    }
    this.treeHeight = height;
    this.seeds = seeds;
    this.signers = this.signerSetFor(generation);
    if (signing) this.assertSeedsOpen(generation);
  }

  /** This host's trees of `generation`, from the seeds it holds. */
  signerSetFor(generation) {
    return new SignerSet({ seeds: this.seeds, threshold: this.threshold, treeHeight: this.treeHeight, generation });
  }

  /**
   * Every seed this host holds opens its own tree of the relay's active
   * generation, and it holds at least k of them. A seed that opens another
   * tree belongs to another relay, or to another signer of this one.
   */
  assertSeedsOpen(generation) {
    const upper = envKey(this.chain);
    this.signers.roots().forEach((root, i) => {
      if (root !== null && lower(root) !== lower(this.authority[i])) {
        throw new Error(`${upper}_OTS_SEED_${i} does not open tree ${i} of the relay's generation ${generation} (${this.authority[i]}); this seed belongs to another relay or signer`);
      }
    });
    if (!this.signers.canSign()) {
      throw new Error(`this host holds ${this.signers.held().length} of the relay's ${this.authority.length} signer seeds; ${this.threshold} must sign a root`);
    }
  }

  escrowOf(asset) {
    const a = this.assets.find((x) => x.asset === toHex(asset));
    if (!a) throw new Error(`no escrow for asset ${asset} on ${this.chain}`);
    return a;
  }

  /** Whether the QRL leg is a real QIP-55 (testnet v3) node, with 64-byte words and QIP-55 logs. */
  get qrlIsV3() {
    return this.qrl.kind === 'qrl';
  }

  /**
   * The QRL leg's logs, decoded. On the v3 node ethers cannot read a QIP-55
   * log (64-byte slots), so `decodeQrlLogs` reads them against the
   * hand-written table; the harness, the enclave stand-in and the test fakes
   * emit ethers-shaped logs and keep `parseLogs`. Unlike parseLogs, the v3
   * decoder swallows nothing: an unmatched topic0 is another contract's event
   * and is skipped, but a matched signature that fails to decode throws — a
   * table out of step with a contract must surface, not drop facts.
   */
  parseQrl(table, abi, logs) {
    return this.qrlIsV3 ? decodeQrlLogs(table, logs) : parseLogs(abi, logs);
  }

  /** An origin-chain 20-byte address into a Hyperion `address` parameter: zero-extended on v3 only. */
  evmArg(addr20) {
    return this.qrlIsV3 ? evmToQrl(addr20) : addr20;
  }

  /**
   * The bound owner as `recordAnchor`'s AnchorInput takes it, from the state's
   * canonical string: at its own width — a Q+128 account crosses the client
   * interface as 0x+128 — with a legacy 20-byte owner zero-extended on the v3
   * leg (the same bytes as its two-word preimage, so the registry recomputes
   * the same identifier) and passed as 20 bytes on the harness path.
   */
  ownerArg(boundQrlOwner) {
    const hex = toHex(boundQrlOwner);
    return hex.length === 130 ? hex : this.evmArg(hex);
  }

  escrowAbi(a) {
    return a.rebasing ? this.abi.shares : this.abi.units;
  }

  /** Bring the state read from disk up to the chains, and check it may sign. */
  async openState({ signing, readOnly }) {
    const s = this.state.data;
    if (s.relay && s.relay !== this.relay) throw new Error(`relayer state is for relay ${s.relay}, not ${this.relay}`);
    if (readOnly) return;
    s.chain = this.chain;
    s.relay = this.relay;
    s.authority = this.authority;
    this.primeSigner();
    // A QRL leg deployed since this state was last written (R40): the devnet
    // regenerates from genesis while the origin leg persists, so what this state
    // recorded on QRL describes contracts that no longer exist.
    const leg = { registry: toHex(this.q.ArkStakeRegistry), deployedAt: this.deployment.deployedAt };
    if (s.qrlLeg && s.qrlLeg.deployedAt !== leg.deployedAt) this.resetQrlSide(s.qrlLeg, leg);
    s.qrlLeg = leg;
    this.migrateForwardCounts();
    if (s.origin.scannedTo === null) s.origin.scannedTo = big(this.manifest.deployedFromBlock) - 1n;
    if (s.qrl.scannedTo === null) s.qrl.scannedTo = big(this.deployment.deployedFromBlock) - 1n;
    if (signing) {
      const nextLeaf = await this.relayNextLeaf();
      await this.reconcileAdmissions(nextLeaf);
      this.assertCovers(nextLeaf);
    }
    this.state.save();
  }

  /**
   * Signing records made before this process: the in-memory reuse guard of
   * every held signer of the active generation is primed with them, so it
   * refuses exactly what disk forbids.
   */
  primeSigner() {
    if (!this.signers) return;
    const g = this.signers.generation;
    for (const [key, rec] of Object.entries(this.state.data.signed)) {
      const [gen, leaf] = key.includes(':') ? key.split(':').map(Number) : [1, Number(key)];
      if (gen === g) this.signers.prime(leaf, rec.message);
    }
  }

  /** The active generation, and this host's trees rebuilt for it when an activation moved it. */
  async activeGeneration() {
    const g = Number(await this.relayView('generation'));
    if (this.signers && this.signers.generation !== g) {
      this.authority = [...(await this.relayView('signerRoots'))];
      this.signers = this.signerSetFor(g);
      this.assertSeedsOpen(g);
      this.primeSigner();
      this.state.data.authority = this.authority;
      this.log(`return   generation ${g} of the authority chain is active; signing from its leaf 0`);
    }
    return g;
  }

  close() {
    if (this.unlock) this.unlock();
    this.unlock = null;
  }

  async relayView(method, args = []) {
    return (await this.origin.call(this.relay, this.abi.relay, method, args))[0];
  }

  async relayNextLeaf() {
    return Number(await this.relayView('nextLeaf'));
  }

  /**
   * Whether this state accounts for every leaf the relay has consumed: the
   * last one is a record of this state's own, admitted. A state that does not
   * — restored from a backup, started on a second host holding the same seed,
   * or left behind by a deployment that failed half way — cannot know whether
   * the next leaf already signed a message somewhere else, and signing from it
   * could sign a second one. `adoptedAt` is the operator's `--adopt-state`,
   * valid for the one leaf it was given at.
   */
  covers(nextLeaf, generation = this.signers ? this.signers.generation : 1) {
    const s = this.state.data;
    if (nextLeaf === 0) return true;
    const last = s.signed[leafKey(generation, nextLeaf - 1)];
    if (last && last.admitted && !last.supersededBy) return true;
    return s.adoptedAt === leafKey(generation, nextLeaf) || (generation <= 1 && s.adoptedAt === nextLeaf);
  }

  assertCovers(nextLeaf) {
    if (this.covers(nextLeaf)) return;
    if (this.adoptState) {
      this.state.data.adoptedAt = this.signers && this.signers.generation > 1 ? leafKey(this.signers.generation, nextLeaf) : nextLeaf;
      this.log(`state    adopted at leaf ${nextLeaf} on the operator's --adopt-state: no record of leaf ${nextLeaf - 1} here`);
      return;
    }
    throw new Error(
      `the relay has consumed ${nextLeaf} leaves and this state (${this.state.file}) has no admitted record of leaf ${nextLeaf - 1}: ` +
        'it does not cover the chain\'s history. Another host, or the state this one replaced, may hold a message already signed ' +
        `for leaf ${nextLeaf}, and signing from here could sign a second. Find that state; start with --adopt-state only once ` +
        'you are sure no other signer for this relay exists',
    );
  }

  /**
   * Record every root this relayer signed that the relay admitted without this
   * relayer seeing its own transaction succeed: somebody else carried it (the
   * admission is permissionless), or the send timed out after it was
   * broadcast. Without this the root's leaves — the allocation among them —
   * would never be consumed. A consumed leaf whose root is not the one signed
   * here is a second signer, and it stops signing (`covers`).
   */
  async reconcileAdmissions(nextLeaf) {
    const s = this.state.data;
    const g = this.signers ? this.signers.generation : 1;
    for (const [k, rec] of Object.entries(s.signed)) {
      const [gen, i] = k.includes(':') ? k.split(':').map(Number) : [1, Number(k)];
      if (gen !== g || rec.admitted || rec.supersededBy || i >= nextLeaf) continue;
      if (rec.kind === 'extension' || rec.kind === 'cancel') {
        // A control message stores no per-index record on the relay; its
        // index consumed is the evidence it was carried.
        rec.admitted = true;
        this.log(`return   ${rec.kind} at leaf ${i} found admitted on the relay`);
        this.state.save();
        // The root that rode with it (V2), where the relay holds it.
        if (rec.leafCount && lower(await this.relayView('rootOf', [rec.epoch])) === lower(rec.root)) {
          this.recordAdmission(i, rec, null, `found admitted with the ${rec.kind}`);
        }
        continue;
      }
      const onChain = lower(await this.relayView('rootOf', [rec.epoch]));
      if (onChain === lower(rec.root)) {
        this.recordAdmission(i, rec, null, 'found admitted on the relay');
      } else {
        rec.supersededBy = onChain;
        this.log(`return   ALARM: leaf ${i} is consumed on the relay and epoch ${rec.epoch} carries ${onChain}, not the root this state signed; another signer holds this seed. Signing stops`);
        this.state.save();
      }
    }
  }

  recordAdmission(leafIndex, rec, gasUsed, how) {
    const s = this.state.data;
    rec.admitted = true;
    if (!s.roots[String(rec.epoch)]) {
      s.roots[String(rec.epoch)] = { root: rec.root, leafIndex, items: rec.items.map((x) => ({ ...x })), gasUsed };
    }
    const carried = new Set(rec.items.map((x) => x.leaf));
    s.pending = s.pending.filter((p) => !carried.has(p.leaf));
    this.log(`return   epoch ${rec.epoch} root ${how} with leaf ${leafIndex}: ${rec.items.length} leaves${gasUsed ? `, gas ${gasUsed}` : ''}`);
    this.state.save();
  }

  /**
   * Publish an admitted root's ordered leaves on the origin chain (whitepaper
   * §3.6, D15), in the epoch it was admitted and again at every tick until
   * the relay holds them: a claimant then rebuilds any proof from the chain
   * (`LeavesPublished`) and needs no copy of this state. Anyone may publish,
   * and a list the relay accepts is the root's own content, so this is a
   * convenience of the relayer's and never an authority.
   */
  async publish(epoch) {
    const s = this.state.data;
    const root = s.roots[String(epoch)];
    if (!root || root.published) return;
    const tree = buildTree(root.items.map((x) => x.leaf));
    const r = await this.tryTx(this.origin, this.relay, this.abi.relay, 'publishLeaves', [big(epoch), tree.leaves]);
    if (r.ok) {
      root.published = true;
      this.log(`return   epoch ${epoch}: ${tree.leaves.length} leaves published on the origin chain${r.receipt.gasUsed ? `, gas ${r.receipt.gasUsed}` : ''}`);
      this.state.save();
    } else if (r.error === 'LeavesAlreadyPublished') {
      // Somebody else published first. The relay takes only a list of the
      // signed leaf count (audit 2026-09-29, OL-01), so it is this list; a
      // relay without that rule (older bytecode) could hold the root's
      // interior nodes instead, which is an ALARM, never a success.
      const theirs = await this.publishedLeaves(epoch);
      const same = theirs && theirs.length === tree.leaves.length && theirs.every((l, i) => lower(l) === lower(tree.leaves[i]));
      root.published = true;
      if (same) this.log(`return   epoch ${epoch}: leaves already published by another account, the same ${tree.leaves.length}`);
      else {
        root.publishedOther = theirs ? theirs.length : null;
        this.log(`return   ALARM: epoch ${epoch}: the relay holds a published list of ${theirs ? theirs.length : 'unknown'} leaves that is not this root's ${tree.leaves.length}; a claimant must rebuild proofs from this relayer's state`);
      }
      this.state.save();
    } else {
      this.log(`return   epoch ${epoch}: leaves not published: ${r.error}; retried next tick`);
    }
  }

  /** The leaf list the relay's `LeavesPublished` holds for `epoch`, or null where none is found. */
  async publishedLeaves(epoch) {
    const head = await this.origin.head();
    const latest = big(head.latest);
    for (let from = big(this.manifest.deployedFromBlock || 0); from <= latest; from += this.scanChunk) {
      const to = from + this.scanChunk - 1n < latest ? from + this.scanChunk - 1n : latest;
      for (const ev of parseLogs(this.abi.relay, await this.origin.logs(this.relay, from, to))) {
        if (ev.name === 'LeavesPublished' && big(ev.args.epoch) === big(epoch)) return [...ev.args.leaves];
      }
    }
    return null;
  }

  /**
   * Forget what this state recorded on a QRL leg that has been replaced, and
   * nothing else — the reset R40 used to do by hand.
   *
   * The QRL scan restarts from the new deployment's first block; otherwise it
   * would begin past the new chain's head and skip every event below it for
   * good. Every forward epoch is resealed into the new attestation and every
   * anchor recorded again on the new registry — except a position already
   * released on the origin chain or on its way out: recorded again it would be
   * live notional on the new book, priced and covered, for a deposit that has
   * left or is leaving, and its `released` fact would then fail `WrongStatus`
   * for ever. Those are retired with the reason.
   *
   * `signed`, `roots`, `consumed`, `anchors` and the origin scan are left alone:
   * they are facts of the origin chain, and `signed` is the one-time leaves
   * already used there — losing it is how a leaf gets signed twice. A copy of
   * the state is kept beside it.
   */
  resetQrlSide(from, to) {
    const s = this.state.data;
    fs.copyFileSync(this.state.file, `${this.state.file}.before-qrl-reset-${Date.now()}`);
    s.qrl.scannedTo = null;
    s.qday = { frozen: null };
    // Lots and offerings live on the replaced leg; its QRL went with it.
    s.lots = {};
    s.offerings = {};
    // So do the pool's withdrawal requests and its validator.
    s.staking = { provisionalEpoch: null, requests: [] };
    // And the delegation's reports, and the claimant hold the replaced bond decided.
    s.reports = null;
    s.claimantHold = {};
    s.claimantHoldLapsed = {};
    s.retired ||= {};
    for (const f of Object.values(s.forward)) {
      for (const item of f.items) if (item.kind === 'released') s.retired[item.id] ||= 'released on the origin chain before the QRL leg was replaced';
    }
    const instructed = [...Object.values(s.roots).flatMap((r) => r.items), ...s.pending].filter((x) => x.kind === 'release');
    for (const x of instructed) s.retired[x.id] ||= 'its release was instructed on the replaced QRL leg; it leaves the origin chain without a record on the new one';
    // An asset dropped from the manifest is not admitted on the new registry,
    // so its anchors would revert there for ever. They stay in the escrow on
    // the origin chain; they are simply no part of the new book.
    const listed = this.assets ? new Set(this.assets.map((a) => a.asset)) : null;
    for (const f of Object.values(s.forward)) {
      for (const item of f.items) {
        const anchor = item.kind === 'anchor' ? s.anchors[item.id] : null;
        if (listed && anchor && anchor.asset && !listed.has(toHex(anchor.asset))) s.retired[item.id] ||= `asset ${anchor.asset} is not listed in the ${this.chain} manifest`;
      }
    }

    let items = 0;
    let retired = 0;
    for (const f of Object.values(s.forward)) {
      f.sealed = false;
      f.root = null;
      for (const item of f.items) {
        const reason = s.retired[item.id];
        if (reason) {
          item.applied = `not recorded: ${reason}`;
          retired += 1;
        } else {
          item.applied = null;
          items += 1;
        }
      }
    }
    this.log(`qrl leg  replaced (registry ${from.registry} of ${from.deployedAt} -> ${to.registry} of ${to.deployedAt}); ` +
      `QRL scan restarted, ${Object.keys(s.forward).length} forward epoch(s) and ${items} fact(s) to reseal, ${retired} retired`);
  }

  /**
   * What became of the QRL leg this relayer was started against.
   *
   * `regenerated` — the only answer that redeploys — needs the same chain id
   * AND a different genesis: that is a devnet rebuilt from genesis (R40). The
   * registry missing on the deployment's own genesis is a node that has not
   * caught up (`lagging`), and a different chain id is an RPC pointed at the
   * wrong chain (`foreign`); redeploying on either would abandon a live leg. A
   * deployment recorded before the genesis hash was: a genesis born after the
   * deployment is a new chain, anything else is left to the operator. An
   * unreachable node throws, so an outage is never mistaken for any of them.
   */
  async qrlLegState() {
    const d = this.deployment;
    const head = await this.qrl.head();
    if (head.latest < 1n) return { state: 'waiting', reason: 'the QRL chain has produced no block yet' };
    const id = await this.qrl.chainId();
    if (d.qrlChainId != null && big(d.qrlChainId) !== id) {
      return { state: 'foreign', reason: `the QRL RPC answers chain ${id}; the deployment was made on chain ${d.qrlChainId}` };
    }
    // The genesis is asked before the code. A regenerated devnet replays the
    // deployer from nonce zero, so the registry's old address can come back
    // holding some other contract — the faucet, or another piece of a leg
    // deployed in a different order — and code there proves nothing about
    // which chain this is.
    const g = await this.qrl.genesis();
    if (d.qrlGenesisHash) {
      if (lower(g.hash) !== lower(d.qrlGenesisHash)) {
        return { state: 'regenerated', reason: `genesis ${g.hash} is not the deployment's ${d.qrlGenesisHash}` };
      }
      const code = await this.qrl.code(this.q.ArkStakeRegistry);
      if (code && code !== '0x') return { state: 'present' };
      return { state: 'lagging', reason: `the registry has no code on the deployment's own genesis (head ${head.latest}, deployed from block ${d.deployedFromBlock}): a node behind` };
    }
    const code = await this.qrl.code(this.q.ArkStakeRegistry);
    if (code && code !== '0x') return { state: 'present' };
    if (d.deployedAt && big(g.timestamp) * 1000n > BigInt(Date.parse(d.deployedAt))) {
      return { state: 'regenerated', reason: `genesis at ${g.timestamp} is later than the deployment (${d.deployedAt})` };
    }
    return { state: 'lagging', reason: 'the registry has no code, and the deployment records no genesis to tell a new chain from a node behind; redeploy by hand' };
  }

  /* ------------------------------------------------------------------ */
  /* Calls                                                               */
  /* ------------------------------------------------------------------ */

  /** eth_call first, then send; returns `{ ok, receipt }` or `{ ok: false, error }` with the decoded name. */
  async tryTx(client, to, abi, method, args, opts = {}) {
    try {
      await client.call(to, abi, method, args, opts);
    } catch (e) {
      return { ok: false, error: revertName(this.errors, e) };
    }
    try {
      return { ok: true, receipt: await client.send(to, abi, method, args, opts) };
    } catch (e) {
      return { ok: false, error: revertName(this.errors, e) };
    }
  }

  originEpochAt(ts) {
    return this.clock.epochOf(ts);
  }

  /* ------------------------------------------------------------------ */
  /* The tick                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * One pass. `sealNow` admits this epoch's root whatever part of the epoch
   * has elapsed; a scenario uses it so a leaf does not wait for the half-way
   * mark, at the cost of later leaves waiting for the next epoch.
   */
  async tick({ sealNow = false, seal = true } = {}) {
    this.state.drainInbox((envelope, file) => this.acceptInbox(envelope, file), this.log, (file, e) => this.refuseInbox(file, e));
    const originHead = await this.origin.head();
    await this.scanOrigin(originHead);
    await this.scanPremiumClaims(originHead);
    await this.forward();
    // Selection before the scan and the seal (OC-SWAP-01): an offering whose
    // quote window has closed is selected first, so its locks can reach the
    // scan and the root of this epoch rather than wait out a root another
    // asset's urgent lock sealed ahead of them.
    if (this.q.PremiumSwap) await this.selectOfferings((await this.qrl.head()).timestamp);
    await this.scanQrl();
    await this.watchQday();
    // `seal: false` is censorship, as the scenario of whitepaper §3.6 needs
    // it: roots stop being carried, and nothing in either leg may close on it.
    if (seal) await this.seal(originHead, sealNow);
    await this.consume(originHead);
    await this.housekeeping(originHead);
    this.state.save();
  }

  /* ------------------------------------------------------------------ */
  /* Forward                                                             */
  /* ------------------------------------------------------------------ */

  async scanOrigin(head) {
    const s = this.state.data;
    const tsCache = new Map();
    const tsOf = async (b) => {
      if (!tsCache.has(b)) tsCache.set(b, await this.origin.timestampOf(b));
      return tsCache.get(b);
    };
    while (s.origin.scannedTo < head.safe) {
      const from = s.origin.scannedTo + 1n;
      const to = from + this.scanChunk - 1n < head.safe ? from + this.scanChunk - 1n : head.safe;
      for (const a of this.assets) {
        for (const ev of parseLogs(this.escrowAbi(a), await this.origin.logs(a.escrow, from, to))) {
          if (ev.name === 'Anchored') {
            const id = ev.args.stakeAssetId;
            const e = big(ev.args.epoch);
            s.anchors[id] = {
              asset: toHex(ev.args.asset),
              // The escrow that emitted it, which its forward leaf binds (D10).
              escrow: a.escrow,
              depositor: toHex(ev.args.depositor),
              // The escrow emits the owner as its two canonical words; the
              // state keeps the one account string they rebuild to (0x+40 or Q+128).
              boundQrlOwner: ownerFromWords(ev.args.qrlOwnerHi, ev.args.qrlOwnerLo),
              depositNonce: big(ev.args.depositNonce),
              anchoredNotional: big(ev.args.anchoredNotional),
              epoch: e,
            };
            this.forwardLeaf(e, { kind: 'anchor', id, leaf: ids.stakeLeafKey(a.escrow, id, big(ev.args.anchoredNotional)) });
          } else if (ev.name === 'Released') {
            const e = this.originEpochAt(await tsOf(ev.blockNumber));
            this.forwardLeaf(e, { kind: 'released', id: ev.args.stakeAssetId, leaf: ev.args.releasedLeaf });
          } else if (ev.name === 'PremiumOffered') {
            const e = big(ev.args.epoch);
            this.forwardLeaf(e, { kind: 'offer', id: ev.args.offerLeaf, leaf: ev.args.offerLeaf, asset: a.asset, escrow: a.escrow, epoch: e, shares: big(ev.args.shares), units: big(ev.args.units) });
          } else if (ev.name === 'BufferReported') {
            // buffer_orig of whitepaper §4.3, beside bond principal in the
            // denominator of utilisation on QRL (ArkStakeRegistry.recordBuffer).
            const e = big(ev.args.epoch);
            this.forwardLeaf(e, { kind: 'buffer', id: ev.args.bufferLeaf, leaf: ev.args.bufferLeaf, asset: a.asset, escrow: a.escrow, epoch: e, units: big(ev.args.units) });
          } else if (ev.name === 'PremiumClaimed') {
            // The solver's claim published the preimage; the lot's QRL now
            // goes to the ledger to whoever carries it to QRL.
            const w = this.lotRecord(ev.args.lotId);
            w.secret = ev.args.secret;
            this.log(`premium  lot ${ev.args.lotId.slice(0, 14)}… claimed on the origin chain; preimage published`);
          }
        }
      }
      s.origin.scannedTo = to;
      s.origin.scannedTs = await tsOf(to);
    }
  }

  /**
   * The preimage carry reads PremiumClaimed up to the origin chain's LATEST
   * block, not the finalized head the forward scan waits for (OC-SWAP-05):
   * Hoodi's finality lags 768–1,140 s against a 1,596 s QRL claim margin, so
   * waiting for it left about 5 minutes between a solver keeping both legs
   * and the lot reaching the ledger. A published preimage can only deliver
   * the lot it opens; a reorg that drops the claim leaves the secret public
   * and the carry as valid as before, so nothing here waits for finality.
   */
  async scanPremiumClaims(head) {
    const s = this.state.data;
    const latest = big(head.latest);
    if (s.origin.claimsScannedTo === undefined || s.origin.claimsScannedTo === null || big(s.origin.claimsScannedTo) < big(s.origin.scannedTo)) s.origin.claimsScannedTo = big(s.origin.scannedTo);
    while (big(s.origin.claimsScannedTo) < latest) {
      const from = big(s.origin.claimsScannedTo) + 1n;
      const to = from + this.scanChunk - 1n < latest ? from + this.scanChunk - 1n : latest;
      for (const a of this.assets) {
        for (const ev of parseLogs(this.escrowAbi(a), await this.origin.logs(a.escrow, from, to))) {
          if (ev.name !== 'PremiumClaimed') continue;
          const w = this.lotRecord(ev.args.lotId);
          if (!w.secret) {
            w.secret = ev.args.secret;
            this.log(`premium  lot ${ev.args.lotId.slice(0, 14)}… claimed on the origin chain (latest, before finality); preimage carried`);
          }
        }
      }
      s.origin.claimsScannedTo = to;
    }
  }

  lotRecord(lotId) {
    const s = this.state.data;
    s.lots ||= {};
    return (s.lots[lotId] ||= {});
  }

  forwardLeaf(epoch, item) {
    const f = (this.state.data.forward[String(epoch)] ||= { items: [], root: null, sealed: false });
    if (!f.items.some((x) => x.leaf === item.leaf)) f.items.push({ ...item, applied: null });
  }

  /**
   * Seal every origin epoch that has closed and been scanned to its last
   * block — a quiet one included (audit 2026-09-29, QL-05): the bond's
   * trigger-2 settlement waits for the root of the epoch before a
   * declaration, and a quiet epoch (the devnet host off, a fresh leg, no
   * event) used to get none, so that wait never ended. Every root carries its
   * count of anchor leaves (QL-06), the whole root of a quiet epoch.
   */
  async forward() {
    const s = this.state.data;
    const scannedTs = s.origin.scannedTs ?? 0n;
    this.fillQuietEpochs(scannedTs);
    for (const [key, f] of Object.entries(s.forward)) await this.forwardEpoch(big(key), f, scannedTs);
  }

  /**
   * An empty forward entry for every closed, scanned epoch from the first
   * this state knows to the last closed, so each is sealed with its count. A
   * state with no entry yet starts at the epoch the scan has closed; one
   * starting from nothing would reseal history.
   */
  fillQuietEpochs(scannedTs) {
    const s = this.state.data;
    if (!scannedTs) return;
    const closed = this.clock.epochOf(big(scannedTs));
    if (closed === 0n) return;
    const last = closed - 1n;
    const keys = Object.keys(s.forward).map(BigInt);
    let first = s.forwardFrom !== undefined && s.forwardFrom !== null ? big(s.forwardFrom) : keys.length ? keys.reduce((m, k) => (k < m ? k : m)) : last;
    if (s.forwardFrom === undefined || s.forwardFrom === null) s.forwardFrom = String(first);
    // Bounded per tick: a long outage is caught up over several.
    let added = 0;
    for (let e = first; e <= last && added < 64; e++) {
      if (!s.forward[String(e)]) {
        s.forward[String(e)] = { items: [], root: null, sealed: false };
        added++;
      }
    }
  }

  /**
   * The epoch's leaves as sealed: its facts and the anchor count leaf (QL-06),
   * the count CUMULATIVE through the epoch since the re-audit of 2026-09-30
   * (BOND-02, `ARK_STAKE_ANCHOR_COUNT_V2`). A root already sealed is rebuilt
   * exactly as it was sealed (`f.countLeaf`: none before QL-06, the V1 leaf of
   * that root's own count after it, the V2 leaf now), so its facts still
   * prove after an upgrade (ORIGIN-06).
   */
  forwardLeaves(epoch, f) {
    const leaves = f.items.map((x) => x.leaf);
    if (f.sealed && f.countLeaf !== undefined) return f.countLeaf ? [...leaves, f.countLeaf] : leaves;
    return [...leaves, ids.anchorCountLeaf({ epoch, count: this.anchorsThrough(epoch) })];
  }

  /**
   * The stake leaves of every forward root through `epoch`: the cumulative
   * count the V2 count leaf carries (BOND-02). An epoch is sealed only once
   * the scan has passed its end, and the scan runs in order, so every earlier
   * epoch's anchors are known by then; `anchorBase` counts those before the
   * first epoch this state knows (zero for a leg this relayer saw from its
   * deployment).
   */
  anchorsThrough(epoch) {
    const s = this.state.data;
    let n = big(s.anchorBase ?? 0n);
    for (const [key, f] of Object.entries(s.forward)) {
      if (big(key) <= big(epoch)) n += BigInt(f.items.filter((x) => x.kind === 'anchor').length);
    }
    return n;
  }

  /**
   * Bring the forward roots of a state written before the count leaf changed
   * up to this build (re-audit 2026-09-30, ORIGIN-06): for each sealed root
   * whose layout is not recorded, find the one it was sealed with — its facts
   * alone (before QL-06), or with the V1 leaf of its own count (QL-06, V1) —
   * and record it, so every fact still waiting proves against the root the
   * attestation holds. A root matching neither is left to the reseal path,
   * with a clear log line. Idempotent.
   */
  migrateForwardCounts() {
    const s = this.state.data;
    const { keccak256, toUtf8Bytes, AbiCoder } = require('ethers');
    const V1 = keccak256(toUtf8Bytes('ARK_STAKE_ANCHOR_COUNT_V1'));
    const coder = AbiCoder.defaultAbiCoder();
    let migrated = 0;
    for (const [key, f] of Object.entries(s.forward)) {
      if (!f.sealed || f.countLeaf !== undefined || !f.root) continue;
      const epoch = big(key);
      const leaves = f.items.map((x) => x.leaf);
      const own = f.items.filter((x) => x.kind === 'anchor').length;
      const v1 = keccak256(coder.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [ids.STAKE_DOMAIN, V1, epoch, BigInt(own)]));
      const v2 = ids.anchorCountLeaf({ epoch, count: this.anchorsThrough(epoch) });
      let found;
      if (leaves.length && buildTree(leaves).root === f.root) found = null;
      else if (buildTree([...leaves, v1]).root === f.root) found = v1;
      else if (buildTree([...leaves, v2]).root === f.root) found = v2;
      if (found === undefined) {
        this.log(`forward  epoch ${epoch}: its sealed root ${String(f.root).slice(0, 14)}… matches no count-leaf layout this relayer knows; left to the reseal path`);
        continue;
      }
      f.countLeaf = found;
      migrated += 1;
    }
    if (migrated) this.log(`forward  ${migrated} root(s) sealed before the V2 anchor count kept as sealed (ORIGIN-06); their counts cannot prove a declaration's prior anchors, which then waits for the W_a lapse`);
  }

  async forwardEpoch(epoch, f, scannedTs, resealed = false) {
    const s = this.state.data;
    if (!f.sealed) {
      if (scannedTs < this.clock.endOf(epoch)) return;
      const tree = buildTree(this.forwardLeaves(epoch, f));
      const r = await this.tryTx(this.sealer || this.qrl, this.q.MockAttestation, this.abi.attestation, 'seal', [epoch, tree.root]);
      if (!r.ok) {
        this.log(`forward  epoch ${epoch}: sealing failed: ${r.error}`);
        return;
      }
      f.root = tree.root;
      f.sealed = true;
      f.anchors = f.items.filter((x) => x.kind === 'anchor').length;
      f.count = this.anchorsThrough(epoch);
      f.countLeaf = ids.anchorCountLeaf({ epoch, count: f.count });
      this.log(`forward  epoch ${epoch}: ${f.items.length} fact(s) and the cumulative count of ${f.count} anchor(s) (${f.anchors} its own) sealed, root ${tree.root.slice(0, 14)}…`);
      this.state.save();
    }
    const tree = buildTree(this.forwardLeaves(epoch, f));
    for (const item of f.items) {
      if (item.applied) continue;
      if (s.retired && s.retired[item.id]) {
        item.applied = `not recorded: ${s.retired[item.id]}`;
        this.log(`forward  ${item.kind.padEnd(8)} ${item.id.slice(0, 14)}… ${item.applied}`);
        continue;
      }
      const proof = proofFor(tree, item.leaf);
      let r;
      if (item.kind === 'anchor') {
        const a = s.anchors[item.id];
        // AnchorInput.asset and .depositor are Hyperion `address` parameters
        // holding ORIGIN-chain 20-byte values: zero-extended on the v3 leg
        // (`evmArg`), 20 bytes on the harness path. The bound owner passes at
        // its own width (`ownerArg`).
        // The escrow closes the tuple (D10): it is not part of the identifier,
        // and the forward leaf binds it. A state from before it names none, and
        // the asset's escrow in the manifest is the one it was anchored in.
        const escrow = a.escrow || this.escrowOf(a.asset).escrow;
        const input = [this.chainId, this.evmArg(a.asset), this.evmArg(a.depositor), this.ownerArg(a.boundQrlOwner), a.depositNonce, a.anchoredNotional, this.evmArg(escrow)];
        r = await this.tryTx(this.qrl, this.q.ArkStakeRegistry, this.abi.registry, 'recordAnchor', [input, epoch, proof]);
      } else if (item.kind === 'offer') {
        if (!this.q.PremiumSwap) {
          item.applied = 'not recorded: this QRL leg has no PremiumSwap';
          continue;
        }
        r = await this.tryTx(this.qrl, this.q.PremiumSwap, this.abi.swap, 'recordOffer', [this.chainId, this.evmArg(item.escrow || this.escrowOf(item.asset).escrow), this.evmArg(item.asset), item.epoch, item.shares, item.units, proof]);
        // Recorded by another account first (the proof is the authority, and
        // the call is anyone's): the offering is on record all the same, and
        // this relayer still selects it (audit 2026-09-29, QL-16). A copied
        // transaction used to leave it out of the offerings kept here, so no
        // selection ever ran and every such offering counted as a failure.
        if (r.ok || r.error === 'OfferExists') {
          this.noteOffering(item.asset, item.epoch);
          if (!r.ok) {
            item.applied = 'recorded by another account';
            this.log(`forward  offer    ${item.id.slice(0, 14)}… already on record; kept for selection`);
            continue;
          }
        }
      } else if (item.kind === 'buffer') {
        r = await this.tryTx(this.qrl, this.q.ArkStakeRegistry, this.abi.registry, 'recordBuffer', [this.chainId, this.evmArg(item.escrow || this.escrowOf(item.asset).escrow), this.evmArg(item.asset), item.epoch, item.units, proof]);
        // A newer report reached QRL first: this one would roll the buffer back, and never applies.
        if (!r.ok && r.error === 'BufferReportNotNewer') {
          item.applied = 'not recorded: a newer report is already recorded';
          continue;
        }
      } else {
        r = await this.tryTx(this.qrl, this.q.ArkStakeRegistry, this.abi.registry, 'recordReleaseSettled', [item.id, epoch, proof]);
      }
      if (r.ok) {
        item.applied = 'recorded';
        this.log(`forward  ${item.kind.padEnd(8)} ${item.id.slice(0, 14)}… recorded`);
        continue;
      }
      if (r.error === 'BadProof') {
        // The attestation's root for the epoch is not the one sealed here: the
        // double lets anyone write it. Seal again and retry, once a tick.
        if (!resealed && (await this.attestationRootChanged(epoch, f))) {
          this.log(`forward  epoch ${epoch}: the attestation no longer holds root ${String(f.root).slice(0, 14)}…; resealing`);
          f.sealed = false;
          f.root = null;
          return this.forwardEpoch(epoch, f, scannedTs, true);
        }
        this.log(`forward  ${item.kind.padEnd(8)} ${item.id.slice(0, 14)}… waiting: BadProof`);
        continue;
      }
      const final = this.forwardFinal(item, r.error);
      if (final) {
        item.applied = final;
        this.log(`forward  ${item.kind.padEnd(8)} ${item.id.slice(0, 14)}… ${final} (final)`);
      } else {
        this.log(`forward  ${item.kind.padEnd(8)} ${item.id.slice(0, 14)}… waiting: ${r.error}`);
      }
    }
  }

  async attestationRootChanged(epoch, f) {
    const onChain = (await this.qrl.call(this.q.MockAttestation, this.abi.attestation, 'rootOf', [epoch]))[0];
    return lower(onChain) !== lower(f.root);
  }

  /** The recorded outcome of a forward refusal no later tick can change, or null to retry. */
  forwardFinal(item, error) {
    if (FORWARD_FINAL.has(error)) return error;
    if (item.kind !== 'released') return null;
    // Not in transit on this leg: already settled here, or an anchor this leg
    // recorded as live. Neither changes by waiting.
    if (error === 'WrongStatus') return 'WrongStatus: the position is not in transit on this QRL leg';
    if (error === 'UnknownAnchor') {
      const anchorItem = Object.values(this.state.data.forward).flatMap((f) => f.items).find((x) => x.kind === 'anchor' && x.id === item.id);
      if (!anchorItem || anchorItem.applied) return 'UnknownAnchor: its anchor was never recorded on this QRL leg';
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Return                                                              */
  /* ------------------------------------------------------------------ */

  async scanQrl() {
    const s = this.state.data;
    const head = await this.qrl.head();
    while (s.qrl.scannedTo < head.safe) {
      const from = s.qrl.scannedTo + 1n;
      const to = from + this.scanChunk - 1n < head.safe ? from + this.scanChunk - 1n : head.safe;
      if (this.q.PremiumSwap) await this.scanSwap(from, to);
      if (this.q.ArkCatBond) await this.scanBond(from, to);
      if (this.q.ArkBondDelegation) await this.scanDelegation(from, to);
      for (const ev of this.parseQrl(QRL_EVENTS.ArkStakeRegistry, this.abi.registry, await this.qrl.logs(this.q.ArkStakeRegistry, from, to))) {
        if (ev.name === 'ReleaseInstructed') {
          this.addPending({
            kind: 'release',
            leaf: ev.args.releaseLeaf,
            id: ev.args.stakeAssetId,
            recipient: toHex(ev.args.recipient),
            claimNonce: big(ev.args.claimNonce),
          });
          this.log(`return   release instructed ${ev.args.stakeAssetId.slice(0, 14)}… -> ${toHex(ev.args.recipient)}`);
        } else if (ev.name === 'AssetDelisted') {
          this.onDelisted(ev.args.assetKey, Number(ev.args.reason));
        }
      }
      s.qrl.scannedTo = to;
    }
  }

  /**
   * The bond's settlement (phase C3): the buffer's part of a trigger-1
   * determination and each share of a recovery, as the leaves the bond sealed
   * once a beneficiary named where it is paid. Not stand-ins: the bond computed
   * the quantity (whitepaper §5.2, §5.4); only the court's finding behind it
   * is still a double (phase C4). A leaf naming another chain or an escrow
   * this relayer does not serve is someone else's.
   */
  async scanBond(from, to) {
    for (const ev of this.parseQrl(QRL_EVENTS.ArkCatBond, this.abi.bond, await this.qrl.logs(this.q.ArkCatBond, from, to))) {
      // The harness decodes every event of the ABI; only the two leaves matter here.
      if (ev.name !== 'LossLeafSealed' && ev.name !== 'RecoveryLeafSealed') continue;
      if (big(ev.args.chainId) !== this.chainId) continue;
      const escrow = toHex(ev.args.escrow);
      const a = this.assets.find((x) => x.escrow === escrow);
      if (!a) continue;
      const common = { leaf: ev.args.leaf, asset: a.asset, escrow, destination: toHex(ev.args.destination), quantity: big(ev.args.quantity), standIn: null };
      if (ev.name === 'LossLeafSealed') {
        this.addPending({ kind: 'loss', determinationId: ev.args.determinationId, stakeAssetId: ev.args.stakeAssetId, ...common, source: 'ArkCatBond LossLeafSealed' });
        this.log(`return   loss ${ev.args.determinationId.slice(0, 14)}… for ${ev.args.stakeAssetId.slice(0, 14)}…: ${ev.args.quantity} units -> ${common.destination}`);
      } else if (ev.name === 'RecoveryLeafSealed') {
        this.addPending({ kind: 'recovery', recoveryId: ev.args.recoveryId, recipient: ev.args.recipient, successorId: ev.args.successorId, ...common, source: 'ArkCatBond RecoveryLeafSealed' });
        this.log(`return   recovery share ${ev.args.recoveryId.slice(0, 14)}… to ${ev.args.recipient.slice(0, 14)}…: ${ev.args.quantity} units -> ${common.destination}`);
      }
    }
  }

  /**
   * The validators the delegation funded (`Delegated`), by key hash: the
   * report sealer reports exactly these (OC-LEGB-06), whatever credentials
   * the beacon chain holds for them — a key deposited first by someone else
   * is reported with theirs, and the delegation forfeits on it.
   */
  async scanDelegation(from, to) {
    const logs = await this.qrl.logs(this.q.ArkBondDelegation, from, to);
    for (const ev of this.parseQrl(QRL_EVENTS.ArkBondDelegation, this.abi.delegation, logs)) {
      if (ev.name !== 'Delegated') continue;
      const r = this.reportState();
      const pkh = lower(ev.args.pubkeyHash);
      if (!r.funded[pkh]) {
        r.funded[pkh] = { at: String(ev.blockNumber) };
        this.log(`reports  validator ${pkh.slice(0, 14)}… funded by the delegation; reported from the next closed epoch`);
      }
    }
  }

  /** The report sealer's record (OC-LEGB-06): a QRL-side record, reset with the leg. */
  reportState() {
    const s = this.state.data;
    s.reports ||= {};
    const r = s.reports;
    r.funded ||= {};
    r.withdrawn ||= {};
    r.snap ||= {};
    r.exitSeen ||= {};
    r.epochs ||= {};
    r.fees ??= 0n;
    return r;
  }

  /** An offering this relayer selects when its quote window closes; once per asset and epoch. */
  noteOffering(asset, epoch) {
    const offerings = (this.state.data.offerings ||= {});
    const key = `${asset}@${epoch}`;
    if (!offerings[key]) offerings[key] = { asset, epoch: big(epoch), selected: false };
  }

  /**
   * The premium swap's side of QRL. A selected lot becomes a premium lock leaf
   * the escrow pays against; it is not a stand-in — a solver's QRL is behind it.
   */
  async scanSwap(from, to) {
    for (const ev of this.parseQrl(QRL_EVENTS.PremiumSwap, this.abi.swap, await this.qrl.logs(this.q.PremiumSwap, from, to))) {
      if (ev.name === 'OfferRecorded') {
        // Every offering on record for an asset of this relayer, whoever
        // carried it, is selected here (QL-16): rebuilt from the chain.
        if (big(ev.args.chainId) !== this.chainId) continue;
        const asset = toHex(ev.args.asset);
        if (this.assets.some((a) => a.asset === asset)) this.noteOffering(asset, ev.args.epoch);
      } else if (ev.name === 'LotQuoted') {
        const w = this.lotRecord(ev.args.lotId);
        w.epoch = big(ev.args.epoch);
        w.status = 'quoted';
      } else if (ev.name === 'LotSelected') {
        if (big(ev.args.chainId) !== this.chainId) continue;
        const asset = toHex(ev.args.asset);
        if (!this.assets.some((a) => a.asset === asset)) continue;
        this.addPending({
          kind: 'premium',
          leaf: ev.args.premiumLockLeaf,
          lotId: ev.args.lotId,
          hashlock: ev.args.hashlock,
          asset,
          recipient: toHex(ev.args.recipient),
          shares: big(ev.args.shares),
          evmExpiry: big(ev.args.evmExpiry),
          // Bound by the V3 lock leaf (yellow paper §3.5); the solver presents both.
          offeredEpoch: big(ev.args.epoch),
          bond: big(ev.args.bond),
          standIn: null,
          source: 'PremiumSwap LotSelected',
        });
        Object.assign(this.lotRecord(ev.args.lotId), { asset, status: 'selected' });
        this.log(`premium  lot ${ev.args.lotId.slice(0, 14)}… selected: ${ev.args.shares} shares of ${asset} -> ${toHex(ev.args.recipient)}`);
      } else if (ev.name === 'OfferingSelected') {
        // Emitted in the transaction that emitted the offering's LotSelected,
        // so once it is scanned every lock of the offering is pending here:
        // the hold on an urgent seal ends for it (OC-SWAP-01, `selectionHold`).
        for (const o of Object.values(this.state.data.offerings || {})) {
          if (big(o.epoch) === big(ev.args.epoch) && lower(ids.assetKey(this.chainId, o.asset)) === lower(ev.args.key)) {
            o.selected = true;
            o.scanned = true;
          }
        }
      } else if (ev.name === 'LotClaimed') {
        this.lotRecord(ev.args.lotId).status = 'claimed';
      } else if (ev.name === 'LotRefunded') {
        // A claimed lot's bond comes back as LotRefunded(0, bond) (I33.3):
        // the lot stays claimed. Only an unclaimed lot's refund is a refund;
        // reading the bond return as one raised false double-pay alarms
        // (live swap-live, 2026-10-12, OC-SWAP-12).
        const rec = this.lotRecord(ev.args.lotId);
        if (rec.status === 'claimed') rec.bondReturned = true;
        else rec.status = 'refunded';
      }
    }
  }

  /**
   * The registry closed an asset to new anchoring — on governance's vote or on
   * the fourth failing yield review. The escrow learns of it only from a
   * de-listing leaf, and keeps taking deposits until one is consumed, so the
   * leaf is produced here from the event rather than waiting for an operator.
   */
  onDelisted(assetKey, reason) {
    const a = (this.deployment.assets || []).find((x) => lower(x.assetKey) === lower(assetKey));
    if (!a) {
      this.log(`return   de-listing of ${String(assetKey).slice(0, 14)}… is not an asset of ${this.chain}`);
      return;
    }
    this.enqueue({ kind: 'delist', asset: a.asset, standIn: null, source: `registry AssetDelisted (${DELIST_REASON[reason] || reason})` });
  }

  /**
   * The Q-Day oracle's declaration and freeze, read and turned into leaves;
   * nothing is written on QRL.
   *
   * On contracts/core's `ArkQDayOracle` (phase C3b, the C4 follow-up) the
   * declaration is the protocol's own — ratified by governance on five
   * attesters' certifications, access-controlled — so it becomes the escrow's
   * close leaf and the protective freeze its freeze leaves on every network,
   * shared ones included, and the leaves are not stand-ins. On
   * `MockQDayOracle` the leaves are labelled stand-ins for the declaration
   * procedure and are sealed only where `mockQdayActs` allows (D2: never on a
   * shared manifest unless the operator says so). The ABI is the double's:
   * the three views are core's, signature for signature.
   *
   * The freeze follows the oracle's *changes*, not its level: the first reading
   * seals a freeze only if the oracle is frozen and the relay is not, and after
   * that only a change is sealed. Following the level would undo a freeze or
   * lift an operator sealed by hand on every tick.
   */
  async watchQday() {
    const oracle = qdayOracleOf(this.deployment);
    if (!oracle) return;
    const real = oracle.kind === 'real';
    const name = real ? 'ArkQDayOracle' : 'MockQDayOracle';
    const s = this.state.data;
    const read = async (m) => (await this.qrl.call(oracle.address, this.abi.qday, m))[0];
    const declared = await read('declared');
    const frozen = Boolean(await read('frozen'));
    // Closure and the freeze are per escrow since every leaf binds its escrow
    // (D10); the declaration reaches every escrow of the chain, one leaf each.
    const controls = [];
    for (const a of this.assets) controls.push({ a, c: await this.relayView('controlOf', [a.escrow]) });
    const closed = controls.every((x) => x.c.closed);
    s.qday ||= { frozen: null };
    const last = s.qday.frozen;
    const edge = last === null ? frozen && controls.some((x) => !x.c.frozen) : frozen !== last;
    s.qday.frozen = frozen;
    if (!real && !this.qdayActs) {
      // Read and reported, never sealed: see `mockQdayActs`.
      if (declared && !closed && !s.qday.declaredLogged) {
        this.log(`return   MockQDayOracle reads declared on a shared network; NOT queueing a close leaf (set ${envKey(this.chain)}_QDAY_MOCK_ACTS=1, or relay seal close, signed)`);
        s.qday.declaredLogged = true;
      }
      if (edge && !closed) this.log(`return   MockQDayOracle freeze moved to ${frozen} on a shared network; NOT queueing a freeze leaf`);
      return;
    }
    for (const { a, c } of controls) {
      if (declared && !c.closed && !this.leafKnown(ids.closeLeaf(this.chainId, a.escrow))) {
        this.enqueue({ kind: 'close', asset: a.asset, standIn: real ? null : 'qday (read from MockQDayOracle.declared)', source: `${name}.declared` });
      }
      if (edge && !c.closed) this.enqueue({ kind: 'freeze', asset: a.asset, frozen, standIn: real ? null : 'qday (read from MockQDayOracle.frozen)', source: `${name}.frozen` });
    }
  }

  /**
   * One inbox file: accepted only as an envelope an allowlisted operator
   * signed for this chain, and never twice (lib/inbox.js, audit D3). Throwing
   * sends the file to `inbox/bad/`; either way the decision is appended to
   * `inbox-audit.log`.
   */
  acceptInbox(envelope, file) {
    const s = this.state.data;
    s.inboxSeen ||= {};
    const signers = allowedSigners(this.origin.env, this.chain);
    const { entry, signer, digest } = openEnvelope(envelope, { chain: this.chain, signers, seen: s.inboxSeen });
    // Recorded before the entry is handled, so a crash in between cannot let
    // the same envelope be handled twice; the enqueue's own save persists it.
    s.inboxSeen[digest] = new Date().toISOString();
    if (entry.kind === 'cancel-extension') {
      // Signed by k signers at the next index in place of a root, while the
      // scheduled extension's delay runs (whitepaper §3.6); see `seal`.
      s.cancelExtension = { operator: signer, at: new Date().toISOString() };
      this.state.save();
      this.log(`return   cancellation of the scheduled extension requested by ${signer}`);
      audit(this.state.dir, { file, outcome: 'accepted', signer, digest, kind: entry.kind, leaf: null, entry });
      return;
    }
    const leaf = this.enqueue({ ...entry, operator: signer });
    audit(this.state.dir, { file, outcome: 'accepted', signer, digest, kind: entry.kind, leaf, entry });
  }

  refuseInbox(file, error) {
    audit(this.state.dir, { file, outcome: 'refused', reason: error && error.message ? error.message : String(error) });
  }

  leafKnown(leaf) {
    const s = this.state.data;
    return s.pending.some((x) => x.leaf === leaf) || Object.values(s.roots).some((r) => r.items.some((x) => x.leaf === leaf));
  }

  /**
   * `reseal` puts a leaf a root already carried into the next one, which is how
   * a scenario shows that a leaf sealed twice pays once: the escrow consumes
   * the leaf itself, so the second presentation is refused `ProofSpent`.
   *
   * A freeze leaf is always taken, and replaces any freeze still pending: the
   * latest request is the one that stands. Two freeze leaves of opposite value
   * in one root would leave the outcome to whichever a carrier presented first,
   * and a freeze leaf is a function of its value alone, so a re-freeze after a
   * lift carries the same leaf an older root already did.
   */
  addPending(item, reseal = false) {
    const s = this.state.data;
    if (item.kind === 'freeze') {
      s.pending = s.pending.filter((x) => !(x.kind === 'freeze' && x.escrow === item.escrow));
      s.pending.push(item);
      return;
    }
    const known = s.pending.some((x) => x.leaf === item.leaf)
      || (!reseal && Object.values(s.roots).some((r) => r.items.some((x) => x.leaf === item.leaf)));
    if (!known) s.pending.push(item);
  }

  /**
   * A stand-in leaf. `hold: true` seals it without consuming it, so a scenario
   * can present it itself — to assert a refusal, or to time it.
   */
  enqueue(entry, { reseal = false } = {}) {
    const c = this.chainId;
    // A closure or a freeze naming no asset reaches every escrow of the chain,
    // one leaf each: every leaf binds the escrow it acts on (D10).
    if ((entry.kind === 'close' || entry.kind === 'freeze') && !entry.asset && !entry.escrow) {
      return this.assets.map((a) => this.enqueue({ ...entry, asset: a.asset }, { reseal })).join(',');
    }
    const e = { ...entry, standIn: 'standIn' in entry ? entry.standIn : STAND_IN[entry.kind] };
    const escrowFor = (asset) => this.escrowOf(asset).escrow;
    switch (entry.kind) {
      case 'loss':
        // A determination this tree cannot produce still needs an identifier;
        // where the caller names none, one is minted here and recorded, so the
        // leaf is reproducible from the state file afterwards.
        e.determinationId = entry.determinationId || random32();
        e.destination = toHex(entry.destination);
        e.quantity = big(entry.quantity);
        // Which escrow pays: the asset given, or the one the anchor this
        // relayer saw was made in. The leaf binds it (D10).
        {
          const asset = entry.asset || this.state.data.anchors[entry.stakeAssetId]?.asset;
          if (!asset) throw new Error(`no asset for ${entry.stakeAssetId}; pass --asset, naming the escrow that pays`);
          e.asset = toHex(asset);
          e.escrow = escrowFor(e.asset);
        }
        e.leaf = ids.lossLeaf({ chainId: c, escrow: e.escrow, determinationId: e.determinationId, stakeAssetId: entry.stakeAssetId, destination: e.destination, quantity: e.quantity });
        break;
      case 'recovery':
        e.asset = toHex(entry.asset);
        e.escrow = escrowFor(e.asset);
        e.destination = toHex(entry.destination);
        e.quantity = big(entry.quantity);
        e.recoveryId = entry.recoveryId || random32();
        // The admitted successor state the share is paid on (whitepaper §5.4,
        // I36); zero is the origin chain itself.
        e.successorId = entry.successorId || ZERO32;
        // The recipient is a bytes32 in the leaf, not an address: the party a
        // recovery is credited to is a record on QRL (whitepaper §5.4).
        e.recipient = entry.recipient || random32();
        e.leaf = ids.shareLeaf({ chainId: c, escrow: e.escrow, successorId: e.successorId, recoveryId: e.recoveryId, recipient: e.recipient, destination: e.destination, quantity: e.quantity });
        break;
      case 'close':
        e.asset = toHex(entry.asset || this.assets.find((a) => a.escrow === toHex(entry.escrow)).asset);
        e.escrow = escrowFor(e.asset);
        e.leaf = ids.closeLeaf(c, e.escrow);
        break;
      case 'freeze':
        e.asset = toHex(entry.asset || this.assets.find((a) => a.escrow === toHex(entry.escrow)).asset);
        e.escrow = escrowFor(e.asset);
        e.frozen = Boolean(entry.frozen);
        e.leaf = ids.freezeLeaf(c, e.escrow, e.frozen);
        break;
      case 'delist':
        e.asset = toHex(entry.asset);
        e.escrow = escrowFor(e.asset);
        e.leaf = ids.delistLeaf(c, e.escrow, e.asset);
        break;
      default:
        throw new Error(`unknown leaf kind ${entry.kind}`);
    }
    this.addPending(e, reseal);
    this.log(`return   ${e.kind} leaf queued (${e.standIn ? `stand-in: ${e.standIn}` : `from ${e.source || 'the registry'}`}) ${e.leaf.slice(0, 14)}…`);
    this.state.save();
    return e.leaf;
  }

  /**
   * The seed-return leaves of `epoch` (whitepaper §4.2, yellow paper §2.2
   * `seedReturnLeafKey`; PV-17 of 2026-09-30): since the re-audit of
   * 2026-09-30 (ORIGIN-01, BOND-03, BOND-06) ONE per request of governance
   * recorded on QRL (`ArkStakeRegistry.requestSeedReturn`), for an escrow
   * whose stake has all left, only while the bond reads no determination
   * open, no censorship ground found, no declaration and no trigger-1 buffer
   * part unsealed (`seedReturnSealable`), and only once every loss leaf this
   * relayer sealed for that escrow has been presented there. A leaf used to be
   * sealed in every root for every empty escrow, and anyone could return a
   * seed the treasury had just made. A bond, a registry or an escrow that
   * cannot be read seals nothing: the seed stays. Presented by nobody here;
   * the treasury calls `withdrawSeed` with it, and the escrow, de-listed,
   * accepts it once.
   */
  async seedReturnItems(epoch) {
    if (!this.q.ArkCatBond || !this.q.ArkStakeRegistry) return [];
    let sealable = false;
    try {
      sealable = Boolean((await this.qrl.call(this.q.ArkCatBond, this.abi.catBond, 'seedReturnSealable'))[0]);
    } catch {
      sealable = false;
    }
    if (!sealable) return [];
    const s = this.state.data;
    s.seedReturns ||= {};
    const items = [];
    for (const a of this.assets) {
      let requested = 0n;
      try {
        requested = big((await this.qrl.call(this.q.ArkStakeRegistry, this.abi.registry, 'seedReturnRequests', [this.chainId, this.evmArg(a.escrow)]))[0]);
      } catch {
        continue;
      }
      const done = big(s.seedReturns[a.escrow]?.sealed ?? 0n);
      if (requested <= done) continue;
      if (this.lossOutstanding(a.escrow)) {
        this.log(`return   seed return of ${a.escrow.slice(0, 10)}… requested; waiting for its loss leaves to be presented (BOND-03)`);
        continue;
      }
      let empty = false;
      try {
        empty = big((await this.origin.call(a.escrow, this.escrowAbi(a), 'totalStake'))[0]) === 0n;
      } catch {
        empty = false;
      }
      if (empty) items.push({ kind: 'seedReturn', escrow: a.escrow, epoch, request: requested, leaf: ids.seedReturnLeaf(this.chainId, a.escrow, epoch) });
    }
    return items;
  }

  /**
   * Whether a loss leaf this relayer holds for `escrow` is not yet presented
   * there: pending, or in a root and not consumed (BOND-03). The seed would
   * otherwise leave ahead of a determined buffer claim the escrow cannot see.
   */
  lossOutstanding(escrow) {
    return this.leafOutstanding('loss', escrow);
  }

  /**
   * Whether a leaf of `kind` this relayer holds for `escrow` is pending, or in
   * a root and not yet consumed there; `skipHeld` leaves out a stand-in a
   * scenario seals to present itself (`hold`), which this relayer never will.
   */
  leafOutstanding(kind, escrow, { skipHeld = false } = {}) {
    const s = this.state.data;
    const mine = (item) => item.kind === kind && !(skipHeld && item.hold) && lower(item.escrow || this.escrowOf(item.asset).escrow) === lower(escrow);
    if (s.pending.some(mine)) return true;
    for (const root of Object.values(s.roots)) {
      for (const item of root.items || []) {
        if (mine(item) && !s.consumed[`${item.leaf}@${item.escrow || this.escrowOf(item.asset).escrow}`]) return true;
      }
    }
    return false;
  }

  /**
   * Drop every pending premium lock whose evmExpiry has passed on the origin
   * chain (OC-SWAP-01): the escrow pays a lock only before it, so one sealed
   * later is a leaf nobody can use, and a pending lock is urgent — an expired
   * one used to seal the next epoch's root at its first tick, ahead of that
   * epoch's own selections, and so on for ever. Recorded with an ALARM: a lock
   * that missed every root is a solver's bond lost through no fault of its own.
   */
  pruneExpiredLocks(originNow) {
    const s = this.state.data;
    const now = big(originNow);
    const expired = s.pending.filter((p) => p.kind === 'premium' && p.evmExpiry !== undefined && p.evmExpiry !== null && big(p.evmExpiry) <= now);
    if (!expired.length) return;
    s.expiredLocks ||= {};
    for (const p of expired) {
      s.expiredLocks[p.lotId || p.leaf] = { leaf: p.leaf, evmExpiry: big(p.evmExpiry), prunedAt: now };
      this.log(`premium  ALARM: lock ${String(p.lotId || p.leaf).slice(0, 14)}… reached no admitted root before its evmExpiry ${p.evmExpiry}; pruned, never sealed (OC-SWAP-01)`);
    }
    const gone = new Set(expired.map((p) => p.leaf));
    s.pending = s.pending.filter((p) => !gone.has(p.leaf));
    this.state.save();
  }

  /**
   * The offering an urgent seal waits for, or null (OC-SWAP-01): one whose
   * quote window has closed less than half an admission window ago and whose
   * selection this relayer has not yet scanned (`OfferingSelected`, emitted
   * with its LotSelected). Selected by this relayer or by anyone: until the
   * scan has it, its locks are not pending here and a root sealed now would
   * carry none of them. One carried below the threshold or missed has none.
   */
  async selectionHold() {
    if (!this.q.PremiumSwap) return null;
    const offerings = Object.entries(this.state.data.offerings || {});
    if (!offerings.length) return null;
    const now = big((await this.qrl.head()).timestamp);
    const half = big(this.clock.ADMISSION_WINDOW) / 2n;
    for (const [key, o] of offerings) {
      if (o.scanned || o.selected === 'carried' || o.selected === 'missed') continue;
      const qc = this.clock.quoteCloses(o.epoch);
      if (now >= qc && now < qc + half) return key;
    }
    return null;
  }

  async seal(originHead, sealNow) {
    const s = this.state.data;
    const generation = await this.activeGeneration();
    const nextLeaf = await this.relayNextLeaf();
    await this.reconcileAdmissions(nextLeaf);

    // A leaf with a message on disk and no admission: resubmit that message.
    const outstanding = s.signed[leafKey(generation, nextLeaf)];
    if (outstanding && !outstanding.supersededBy) {
      await this.submit(nextLeaf, outstanding);
      return;
    }
    if (!this.covers(nextLeaf, generation)) {
      this.log(`return   REFUSING to sign leaf ${nextLeaf}: this state holds no admitted record of leaf ${nextLeaf - 1} (see assertCovers)`);
      return;
    }

    const epoch = this.clock.epochOf(originHead.timestamp);
    const lastEpoch = big(await this.relayView('lastEpoch'));
    // A premium lock past its evmExpiry can never be paid: the escrow refuses
    // it `PremiumExpired` whatever root carries it. It is pruned here, before
    // urgency is read, so it neither rides a root nor makes one urgent
    // (OC-SWAP-01, the cascade).
    this.pruneExpiredLocks(originHead.timestamp);
    if (epoch <= lastEpoch) return;
    const urgent = s.pending.some((p) => CONTROL.has(p.kind));
    const elapsed = Number(originHead.timestamp - this.clock.startOf(epoch)) / Number(this.clock.EPOCH_LENGTH);
    if (!sealNow && !urgent && elapsed < this.sealAt) return;
    // An urgent seal waits, inside the first half of an offering's admission
    // window, for the LotSelected of every offering whose quote window has
    // closed (OC-SWAP-01): the epoch has one root, and a root sealed on the
    // first asset's lock would leave every other asset's for the next one,
    // after their evmExpiry. The half-way mark still seals whatever is in.
    if (!sealNow && urgent && elapsed < this.sealAt) {
      const waiting = await this.selectionHold();
      if (waiting) {
        const key = `${epoch}:${waiting}`;
        if (s.heldFor !== key) {
          s.heldFor = key;
          this.log(`return   urgent root of epoch ${epoch} held: offering ${waiting} is in its admission window and its selection is not scanned yet`);
        }
        return;
      }
    }

    const items = [];
    // Each escrow's allocation leaf is the registry's for the epoch its own
    // clock is in, and the escrow requires it in the root of that same epoch.
    // The leaf and its values are two reads; a book change between them would
    // seal a leaf whose values the escrow cannot reproduce, so the leaf is
    // recomputed from the values and the root waits a tick if the two disagree.
    for (const a of this.assets) {
      const [allocEpoch, allocLeaf] = await this.qrl.call(this.q.ArkStakeRegistry, this.abi.registry, 'currentAllocationLeaf', [this.evmArg(a.escrow)]);
      if (big(allocEpoch) !== epoch) continue;
      const al = (await this.qrl.call(this.q.ArkStakeRegistry, this.abi.registry, 'allocation'))[0];
      // The V3 leaf (gap item 19): the premium travels as `sigmaBps`, every
      // other field under its own name, the levy and the commitment terms included.
      const values = { escrow: a.escrow, epoch, ...Object.fromEntries(ids.ALLOCATION_FIELDS.map((f) => [f, Number(f === 'sigmaBps' ? al.premiumBps : al[f])])) };
      const leaf = ids.allocationLeaf(values);
      if (lower(leaf) !== lower(allocLeaf)) {
        this.log(`return   the allocation moved between two reads (leaf ${String(allocLeaf).slice(0, 14)}…, values give ${leaf.slice(0, 14)}…); sealing next tick`);
        return;
      }
      items.push({ kind: 'allocation', leaf, ...values });
    }
    for (const item of await this.seedReturnItems(epoch)) {
      items.push(item);
      // One leaf per request (ORIGIN-01): what is signed now, in either path below, is admitted in the end.
      s.seedReturns[item.escrow] = { sealed: item.request, epoch };
    }
    for (const p of s.pending) if (!items.some((x) => x.leaf === p.leaf)) items.push(p);

    // The authority chain before a root: each of its messages consumes this
    // index and this epoch as a root would, and since V2 (2026-09-30, PV-18)
    // the epoch's root rides with it, so an epoch with a return fact is not
    // left without a root. Urgent facts no longer hold it back (re-audit
    // 2026-09-30, ORIGIN-02): a lock selected every epoch counted as urgent
    // and starved the extension until the generation ran past its horizon.
    const carried = items.length ? buildTree(items.map((x) => x.leaf)) : null;
    const carry = carried
      ? { root: carried.root, leafCount: carried.leaves.length, items }
      : { root: ZERO_WORD, leafCount: 0, items: [] };
    if (await this.authorityMessage(generation, nextLeaf, epoch, carry)) return;
    if (!items.length) return;

    const tree = buildTree(items.map((x) => x.leaf));
    // The message binds the leaf count (audit 2026-09-29, OL-01).
    const leafCount = tree.leaves.length;
    const message = ids.rootMessage({ chainId: this.chainId, relay: this.relay, epoch, epochRoot: tree.root, leafCount });
    // Recorded and saved before the signature exists (state.js).
    const key = leafKey(generation, nextLeaf);
    s.signed[key] = { kind: 'root', message, epoch, root: tree.root, leafCount, items, admitted: false, generation };
    this.state.save();
    await this.submit(nextLeaf, s.signed[key]);
  }

  /**
   * An extension to the next link of the chain, or the cancellation an
   * operator asked for, signed at `nextLeaf` with this epoch's root riding
   * (V2, PV-18; `carry` the root, its leaf count and its items, zero and
   * none where the epoch has no return fact). Returns whether one was signed.
   *
   * An extension is signed once the active generation has consumed
   * EXTENSION_OPENS of its leaves, no extension is scheduled, and the
   * manifest records the link the relay commits to next; a cancellation only
   * while the scheduled extension's delay runs.
   */
  async authorityMessage(generation, nextLeaf, epoch, carry = { root: ZERO_WORD, leafCount: 0, items: [] }) {
    const s = this.state.data;
    const pendingAt = big(await this.relayView('extensionActivatesAt'));
    const link = await this.relayView('chainCommit');
    if (s.cancelExtension) {
      if (pendingAt === 0n || epoch >= pendingAt) {
        this.log('return   no scheduled extension can be cancelled now; the request is dropped');
        s.cancelExtension = null;
        this.state.save();
        return false;
      }
      const message = ids.cancelMessage({ chainId: this.chainId, relay: this.relay, epoch, nextGeneration: generation + 1, link, epochRoot: carry.root, leafCount: carry.leafCount });
      const key = leafKey(generation, nextLeaf);
      s.signed[key] = { kind: 'cancel', message, epoch, generation, root: carry.root, leafCount: carry.leafCount, items: carry.items, admitted: false };
      s.cancelExtension = null;
      this.state.save();
      await this.submit(nextLeaf, s.signed[key]);
      return true;
    }
    const chain = this.manifest.authority;
    if (!chain || !Array.isArray(chain.generations) || generation >= MAX_GENERATIONS || !chain.generations[generation]) return false;
    if (pendingAt !== 0n) return false;
    // Late in the window rather than at its opening: an extension scheduled
    // at 5,000 bps would retire half of the generation's leaves unused. Two
    // ratchet delays before the migration horizon, so the successor activates
    // before anchoring closes there even if one schedule is cancelled and
    // signed again; never before the window opens, never after it closes.
    const opens = Number(await this.relayView('EXTENSION_OPENS'));
    const closes = Number(await this.relayView('EXTENSION_CLOSES'));
    const horizon = Number(await this.relayView('MIGRATION_HORIZON'));
    const from = Math.max(opens, horizon - 2 * RATCHET_EPOCHS);
    if (nextLeaf < from || nextLeaf >= closes) return false;
    const nextRoots = chain.generations[generation];
    const nextCommit = chain.commits[generation];
    if (lower(ids.chainLink(nextRoots, nextCommit)) !== lower(link)) {
      this.log(`return   the manifest's generation ${generation + 1} is not the link the relay commits to; no extension is signed`);
      return false;
    }
    const message = ids.extensionMessage({ chainId: this.chainId, relay: this.relay, epoch, nextGeneration: generation + 1, link, epochRoot: carry.root, leafCount: carry.leafCount });
    const key = leafKey(generation, nextLeaf);
    s.signed[key] = { kind: 'extension', message, epoch, generation, nextRoots, nextCommit, root: carry.root, leafCount: carry.leafCount, items: carry.items, admitted: false };
    this.state.save();
    await this.submit(nextLeaf, s.signed[key]);
    return true;
  }

  /** Sign a recorded message with k held signers and carry it: a root, an extension or a cancellation. */
  async submit(leafIndex, rec) {
    const sigs = sigsArg(this.signers.sign(rec.message, leafIndex));
    const kind = rec.kind || 'root';
    // A record signed before V2 carries no root: zero and zero, as the message it signed.
    const ridingRoot = rec.root || ZERO_WORD;
    const ridingCount = rec.leafCount || 0;
    const call = kind === 'extension'
      ? ['scheduleExtension', [rec.nextRoots, rec.nextCommit, rec.epoch, ridingRoot, ridingCount, leafIndex, sigs]]
      : kind === 'cancel'
        ? ['cancelExtension', [rec.epoch, ridingRoot, ridingCount, leafIndex, sigs]]
        : ['admitEpochRoot', [rec.epoch, rec.root, rec.leafCount ?? buildTree(rec.items.map((x) => x.leaf)).leaves.length, leafIndex, sigs]];
    const r = await this.tryTx(this.origin, this.relay, this.abi.relay, call[0], call[1], { gas: 1_000_000 + 400_000 * sigs.length });
    if (!r.ok) {
      this.log(`return   ${kind} for epoch ${rec.epoch} (leaf ${leafIndex}) not admitted: ${r.error}; the same message will be resubmitted`);
      // Refused because it is already in — carried by someone else, or a send
      // that timed out after it was broadcast.
      await this.reconcileAdmissions(await this.relayNextLeaf());
      return;
    }
    if (kind !== 'root') {
      rec.admitted = true;
      this.log(`return   ${kind} of generation ${rec.generation + 1} admitted with leaf ${leafIndex} in epoch ${rec.epoch}, gas ${r.receipt.gasUsed}`);
      this.state.save();
      // The epoch's root rode with it (V2): recorded and published as a root's.
      if (rec.leafCount) {
        this.recordAdmission(leafIndex, rec, r.receipt.gasUsed, `admitted with the ${kind}`);
        await this.publish(rec.epoch);
      }
      return;
    }
    this.recordAdmission(leafIndex, rec, r.receipt.gasUsed, 'admitted');
    await this.publish(rec.epoch);
  }

  /** Kept for callers of the single-signer name. */
  async admit(leafIndex, rec) {
    return this.submit(leafIndex, rec);
  }

  /* ------------------------------------------------------------------ */
  /* Consumption on the origin chain                                     */
  /* ------------------------------------------------------------------ */

  async consume(originHead) {
    const s = this.state.data;
    const nowEpoch = this.clock.epochOf(originHead.timestamp);
    // Read once a tick, and only where a sealed release waits: the claimant
    // hold of the censorship ground (OC-LEGA-01).
    let holds;
    const swept = new Set();
    for (const [key, root] of Object.entries(s.roots)) {
      const epoch = big(key);
      const tree = buildTree(root.items.map((x) => x.leaf));
      for (const item of root.items) {
        if (item.hold) continue;
        const proof = proofFor(tree, item.leaf);
        for (const [target, abi, method, args] of this.presentations(item, epoch, proof, nowEpoch)) {
          // A freeze leaf is a function of its value alone and takes effect by
          // the epoch of its root, so a re-freeze after a lift is the same leaf
          // in a later root and must be presented again. Every other leaf is
          // presented once, whichever root carried it.
          const ck = item.kind === 'freeze' ? `${item.leaf}@${target}@${epoch}` : `${item.leaf}@${target}`;
          if (s.consumed[ck]) continue;
          if (method === 'release') {
            if (holds === undefined) holds = await this.censorshipHolds(nowEpoch);
            const why = holds ? await holds(item, target) : null;
            if (why) {
              const said = (s.claimantHold ||= {});
              if (said[item.leaf] !== why) {
                said[item.leaf] = why;
                this.log(`consume  release    ${String(item.id).slice(0, 14)}… withheld: ${why} (OC-LEGA-01)`);
              }
              continue;
            }
            if (s.claimantHold && s.claimantHold[item.leaf]) {
              delete s.claimantHold[item.leaf];
              this.log(`consume  release    ${String(item.id).slice(0, 14)}… no longer withheld: presented`);
            }
          }
          // The escrow's yield is settled at the allocation in force before a
          // new one replaces it (OC-LEGA-04): a sweep first, in this tick,
          // whatever else the tick did before. The pre-flight costs no gas
          // where there is nothing to sweep.
          if (method === 'recordEpochAllocation' && !swept.has(target)) {
            swept.add(target);
            await this.sweepEscrow(this.assets.find((a) => a.escrow === target), nowEpoch);
          }
          const r = await this.tryTx(this.origin, target, abi, method, args);
          if (r.ok && method === 'release' && this.onlyInTransit(abi, r.receipt)) {
            // Presented before its unbonding has run, or under the freeze: the
            // escrow moved the position out of the priced book and did NOT
            // consume the receipt (whitepaper §3.3, I18; audit 2026-09-22, X7).
            // Recorded apart, so the same receipt is presented again once due.
            s.consumed[`${ck}#transit`] = { outcome: 'transit', epoch, gasUsed: r.receipt.gasUsed };
            this.log(`consume  ${item.kind.padEnd(10)} into transit on ${target.slice(0, 10)}…, the receipt waits for its unbonding; gas ${r.receipt.gasUsed}`);
          } else if (r.ok) {
            s.consumed[ck] = { outcome: method, epoch, gasUsed: r.receipt.gasUsed };
            this.log(`consume  ${item.kind.padEnd(10)} ${method} on ${target.slice(0, 10)}… gas ${r.receipt.gasUsed}`);
          } else if (FINAL.has(r.error)) {
            s.consumed[ck] = { outcome: r.error, epoch };
            this.log(`consume  ${item.kind.padEnd(10)} ${method}: ${r.error} (final)`);
          } else if (!WAIT.has(r.error)) {
            this.log(`consume  ${item.kind.padEnd(10)} ${method}: ${r.error} (will retry)`);
          }
        }
      }
    }
  }

  /**
   * Whether a `release` the escrow accepted only moved the position into
   * transit — `TransitMarked` without `ReleaseQueued` — and left the receipt
   * to be consumed later. A client that returns no logs reads as consumed.
   */
  onlyInTransit(abi, receipt) {
    const names = parseLogs(abi, (receipt && receipt.logs) || []).map((e) => e.name);
    return names.includes('TransitMarked') && !names.includes('ReleaseQueued');
  }

  /** What a sealed leaf is presented as, and to which contract. Empty until it may be. */
  presentations(item, epoch, proof, nowEpoch) {
    const esc = (asset) => {
      const a = this.escrowOf(asset);
      return [a.escrow, this.escrowAbi(a)];
    };
    switch (item.kind) {
      case 'allocation': {
        // One leaf per escrow (D10). A root sealed before the binding carried
        // one allocation for every escrow, which no escrow of this build reads.
        const a = this.assets.find((x) => x.escrow === toHex(item.escrow || ''));
        if (!a) return [];
        return [[a.escrow, this.escrowAbi(a), 'recordEpochAllocation', [epoch, ids.ALLOCATION_FIELDS.map((f) => (f === 'stepQueued' ? Boolean(Number(item[f] ?? 0)) : item[f] ?? 0)), proof]]];
      }
      case 'release': {
        const anchor = this.state.data.anchors[item.id];
        if (!anchor) return [];
        const [target, abi] = esc(anchor.asset);
        // Presented at once, so the escrow takes the position out of the book
        // the premium is charged on from the admission of its root (X7); and
        // again once the unbonding has run, which consumes it. The escrow
        // counts the unbonding from the later of the label and the admission
        // (D11), so a presentation this estimate takes to be due may still be
        // refused `UnbondingNotServed`, which waits.
        if (nowEpoch < epoch + RELEASE_EPOCH_DELAY && this.state.data.consumed[`${item.leaf}@${target}#transit`]) return [];
        return [[target, abi, 'release', [item.id, item.recipient, item.claimNonce, epoch, proof]]];
      }
      case 'premium':
        // Presented by the solver, who alone holds the preimage.
        return [];
      case 'loss':
        return [[...esc(item.asset), 'settleLoss', [item.determinationId, item.stakeAssetId, item.destination, item.quantity, epoch, proof]]];
      case 'recovery':
        return [[...esc(item.asset), 'releaseShare', [item.successorId || ZERO32, item.recoveryId, item.recipient, item.destination, item.quantity, epoch, proof]]];
      case 'close':
        return [[this.relay, this.abi.relay, 'close', [item.escrow, epoch, proof]]];
      case 'freeze':
        return [[this.relay, this.abi.relay, 'setFrozen', [item.escrow, item.frozen, epoch, proof]]];
      case 'delist':
        return [[...esc(item.asset), 'closeAnchoring', [epoch, proof]]];
      default:
        return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Housekeeping                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * At most one sweep per escrow per epoch, and only a sweep that found
   * something counts: yield arrives through the epoch, and marking the epoch
   * swept on `NothingToSweep` would leave everything that arrived afterwards
   * waiting for the next one. The pre-flight call costs no gas. Called from
   * housekeeping, and from `consume` ahead of an allocation (OC-LEGA-04).
   */
  async sweepEscrow(a, epoch) {
    if (!a) return;
    const s = this.state.data;
    if (s.swept[a.escrow] === epoch) return;
    const r = await this.tryTx(this.origin, a.escrow, this.escrowAbi(a), 'sweep', []);
    if (r.ok) {
      s.swept[a.escrow] = epoch;
      this.log(`sweep    ${a.symbol} epoch ${epoch}`);
    }
  }

  /**
   * The claimant hold of the censorship ground (OC-LEGA-01, user decision:
   * HOLD claimants): on that ground nothing on the origin chain holds a
   * claimant between the D_0 draw and the recovery, so a claimant whose
   * release was already sealed could leave undiluted and put the whole
   * recovery on the positions still in the book. The registry refuses a new
   * release to a claimant; this withholds the presentation of one already
   * sealed — the transit presentation too — until its escrow's recovery is
   * applied (the origin chain's slot 0 of `escrowLedger`, the slot the
   * censorship ground applies first) and every share of it this relayer
   * holds for the escrow has been drawn there, or until the hold lapses
   * `recoveryHoldEpochs` after T, with an ALARM. A share a holder claims on
   * QRL only after the hold has ended is not waited for.
   *
   * Returns null where no hold applies this tick (no censorship ground, or no
   * bond to read), else `(item, escrow) => reason | null`. A position not yet
   * recorded is held while the record is open (it may be a claimant); one the
   * bond refused (`NotClaimant`), recorded LATE, or unrecorded once the
   * settlement opened is not a claimant and is never held.
   */
  async censorshipHolds(nowEpoch) {
    const q = this.q;
    if (!q.ArkCatBond || !q.ArkCatBondRecovery) return null;
    let c;
    try {
      c = (await this.qrl.call(q.ArkCatBond, this.abi.recovery, 'claimants'))[0];
    } catch {
      return null;
    }
    if (Number(c.ground) !== GROUND_CENSORSHIP) return null;
    const s = this.state.data;
    // `at` by position: on a decoded Result the name is Array.prototype.at (OC-OPS-02).
    const T = this.clock.epochOf(big(c[1]));
    const lapse = T + big(this.manifest.recoveryHoldEpochs ?? RECOVERY_HOLD_EPOCHS);
    let stage = null;
    const applied = new Map();
    return async (item, escrow) => {
      const id = item.id;
      const [kind] = await this.qrl.call(q.ArkCatBond, this.abi.bond, 'claimantOf', [id]);
      if (Number(kind) === LATE) return null;
      if (Number(kind) !== CLAIMANT) {
        if (s.declaration && s.declaration.skipped && s.declaration.skipped[id]) return null;
        if (stage === null) stage = Number((await this.qrl.call(q.ArkCatBond, this.abi.bond, 'declaration'))[0].stage);
        // The record closes when the settlement opens: unrecorded then is no claimant.
        return stage === 0 ? 'the censorship ground is found and the claimant record is open; this position may be a claimant' : null;
      }
      if (!applied.has(escrow)) {
        const l = (await this.qrl.call(q.ArkCatBond, this.abi.recovery, 'escrowLedger', [this.chainId, this.evmArg(escrow)]))[0];
        applied.set(escrow, Number(l.cursor) > 0);
      }
      // Applied on QRL is not yet drawn on the origin chain: a share this
      // relayer holds for the escrow, pending or sealed and not presented, is
      // drawn first, so the claimant leaves after it and bears its part.
      if (applied.get(escrow)) return this.leafOutstanding('recovery', escrow, { skipHeld: true }) ? `escrow ${escrow.slice(0, 10)}…'s recovery is applied and a share of it is not yet drawn there` : null;
      if (nowEpoch >= lapse) {
        s.claimantHoldLapsed ||= {};
        if (!s.claimantHoldLapsed[escrow]) {
          s.claimantHoldLapsed[escrow] = String(nowEpoch);
          this.log(`consume  ALARM: the recovery of escrow ${escrow.slice(0, 10)}… is not applied ${nowEpoch - T} epochs after the censorship ground's T; the claimants' sealed releases are presented (OC-LEGA-01 hold lapsed)`);
        }
        return null;
      }
      return `a claimant of the censorship ground, held until escrow ${escrow.slice(0, 10)}…'s recovery is applied or epoch ${lapse}`;
    };
  }

  async housekeeping(originHead) {
    const s = this.state.data;
    const epoch = this.clock.epochOf(originHead.timestamp);
    for (const a of this.assets) {
      const abi = this.escrowAbi(a);
      await this.sweepEscrow(a, epoch);
      // The premium, offered once per epoch once the lots of the offering
      // before could no longer be paid, so the offer the forward path carries
      // counts nothing they may still take.
      s.offered ||= {};
      if (s.offered[a.escrow] !== epoch && big(originHead.timestamp) >= this.clock.offerOpens(epoch)) {
        const r = await this.tryTx(this.origin, a.escrow, abi, 'offerPremium', []);
        if (r.ok || r.error === 'AlreadyOffered') {
          s.offered[a.escrow] = epoch;
          if (r.ok) this.log(`offer    ${a.symbol} epoch ${epoch}`);
        }
      }
      // The buffer, once per epoch, for the forward path to carry to QRL,
      // where it stands beside bond principal in utilisation (whitepaper §4.3).
      s.reported ||= {};
      if (s.reported[a.escrow] !== epoch) {
        const r = await this.tryTx(this.origin, a.escrow, abi, 'reportBuffer', []);
        if (r.ok || r.error === 'AlreadyReported') {
          s.reported[a.escrow] = epoch;
          if (r.ok) this.log(`buffer   ${a.symbol} epoch ${epoch}`);
        }
      }
      const head = (await this.origin.call(a.escrow, abi, 'queueHead'))[0];
      const tail = (await this.origin.call(a.escrow, abi, 'queueTail'))[0];
      if (head < tail) {
        const budget = (await this.origin.call(a.escrow, abi, 'releaseBudgetRemaining'))[0];
        if (budget > 0n) {
          const r = await this.tryTx(this.origin, a.escrow, abi, 'drainQueue', [DRAIN_ENTRIES]);
          if (r.ok) this.log(`drain    ${a.symbol} queue ${head}..${tail}, budget ${budget}`);
        }
      }
    }
    // The leaves of every admitted root on the origin chain (D15), and the
    // next generation of the authority chain once its delay has run.
    for (const e of Object.keys(s.roots)) if (!s.roots[e].published) await this.publish(e);
    await this.activateGeneration(epoch);
    await this.watchExtension(epoch);
    const qrlNow = (await this.qrl.head()).timestamp;
    await this.settleSwaps(originHead, qrlNow);
    await this.fundPoolValidator();
    await this.sealReports(qrlNow);
    await this.closeBondGap(qrlNow);
    await this.keepStaking(qrlNow);
    await this.distributeCoupons(qrlNow);
    await this.keepDeclaration();
  }

  /**
   * Trigger 2, kept moving (whitepaper §5.2, §4.6, §5.4). Every call is the
   * bond's own and permissionless, fixes nothing the contract does not fix
   * itself, and is tried with `eth_call` first, so a tick where nothing is due
   * sends nothing:
   *
   *   1. once the declaration is ratified (the Q-Day oracle reads `declared`)
   *      or the court has found the censorship ground, the claimant record —
   *      every position this relayer saw anchored that the record does not
   *      hold yet, in batches of CLAIMANT_BATCH; a position the bond refuses
   *      (`NotClaimant`) is set aside with the reason, once;
   *   2. under a declaration, the count of anchors the forward root of the
   *      epoch before T carries (`provePriorAnchors`, audit 2026-09-29,
   *      QL-06), proven from this relayer's own sealed root once it is sealed;
   *      then `settleDeclaration`, which opens only on a complete record and
   *      every anchor of that root recorded (`ClaimantsIncomplete`,
   *      `AnchorsUnrecorded` are reported and waited out);
   *   3. `settleSeverity` from the close of the assessment window, and again
   *      while a balance is HELD (the series may resume);
   *   4. `applyRecoveries` for an escrow whose next slot holds a finding —
   *      never needed to unblock (the court's `openRecovery` applies), only
   *      to catch up.
   *
   * What it reads and decides is logged once per change, not every tick.
   */
  async keepDeclaration() {
    const q = this.q;
    if (!q.ArkCatBond || !q.ArkCatBondRecovery) return;
    const s = this.state.data;
    s.declaration ||= { skipped: {}, said: null };
    const d = s.declaration;
    const say = (key, line) => {
      if (d.said === key) return;
      d.said = key;
      this.log(line);
    };
    const t2 = (await this.qrl.call(q.ArkCatBond, this.abi.bond, 'declaration'))[0];
    const stage = Number(t2.stage);
    if (stage === 0) {
      const c = (await this.qrl.call(q.ArkCatBond, this.abi.recovery, 'claimants'))[0];
      let grounded = Number(c.ground) !== 0;
      if (!grounded) {
        const oracle = qdayOracleOf(this.deployment);
        grounded = Boolean(oracle) && Boolean((await this.qrl.call(oracle.address, this.abi.qday, 'declared'))[0]);
      }
      if (!grounded) return;
      await this.recordClaimants();
      await this.provePriorAnchors();
      const r = await this.tryTx(this.qrl, q.ArkCatBond, this.abi.bond, 'settleDeclaration', []);
      if (r.ok) {
        const opened = (await this.qrl.call(q.ArkCatBond, this.abi.bond, 'declaration'))[0];
        this.log(`trigger2 settlement opened: D_0 ${opened.d0} bps of S_full ${opened.fullSettlement}, drawn ${opened.drawn}, stage ${opened.stage} (bond settleDeclaration)`);
        d.said = null;
      } else {
        say(`open:${r.error}`, `trigger2 settlement not opened yet: ${r.error}`);
      }
      return;
    }
    // A declaration ratified after a settled censorship ground opens on the
    // remainder the ground did not reach (re-audit 2026-09-30, COURT-04):
    // `settleDeclaration` again, once, where the oracle reads it declared.
    if (stage === T2_SETTLED && t2.censorship) {
      const oracle = qdayOracleOf(this.deployment);
      const declared = Boolean(oracle) && Boolean((await this.qrl.call(oracle.address, this.abi.qday, 'declared'))[0]);
      if (declared && !d.remainder) {
        const r = await this.tryTx(this.qrl, q.ArkCatBond, this.abi.bond, 'settleDeclaration', []);
        if (r.ok || r.error === 'DeclarationAlreadySettled') {
          d.remainder = true;
          if (r.ok) this.log('trigger2 the declaration opened on the censorship ground\'s remainder (bond settleDeclaration)');
        } else {
          say(`remainder:${r.error}`, `trigger2 the declaration's remainder not opened yet: ${r.error}`);
        }
      }
    }
    if (stage === T2_WINDOW || stage === T2_HELD) {
      const r = await this.tryTx(this.qrl, q.ArkCatBond, this.abi.bond, 'settleSeverity', []);
      if (r.ok) {
        const after = (await this.qrl.call(q.ArkCatBond, this.abi.bond, 'declaration'))[0];
        this.log(`trigger2 severity judged: stage ${after.stage}, drawn ${after.drawn}, held ${after.held} (bond settleSeverity)`);
        d.said = null;
      } else if (SEVERITY_WAIT.has(r.error)) {
        say(`severity:${stage}:${r.error}`, `trigger2 severity waits: ${r.error}`);
      } else {
        say(`severity:${r.error}`, `trigger2 settleSeverity refused: ${r.error}; tried again next tick`);
      }
    }
    if (stage >= T2_HELD) await this.applyRecoveries(Boolean(t2.censorship));
  }

  /**
   * Step 2 of `keepDeclaration` under a declaration: prove the count of anchors
   * the forward root of the epoch before T carries, from the root this
   * relayer sealed for that epoch (audit 2026-09-29, QL-05, QL-06). Waits
   * while that root is not sealed; nothing where it is proven already.
   */
  async provePriorAnchors() {
    const q = this.q;
    const s = this.state.data;
    const c = (await this.qrl.call(q.ArkCatBond, this.abi.recovery, 'claimants'))[0];
    if (Number(c.ground) !== 1) return;
    const [, , proven] = await this.qrl.call(q.ArkCatBond, this.abi.recovery, 'priorAnchors');
    if (proven) return;
    // `at` is read by position: on a decoded Result the name resolves to
    // Array.prototype.at, not the field (OC-OPS-02). Claimants is
    // (ground, at, window, ...).
    const prior = this.clock.epochOf(big(c[1])) - 1n;
    const f = s.forward[String(prior)];
    if (!f || !f.sealed) {
      this.log(`trigger2 waiting for the forward root of epoch ${prior}, the epoch before the ratification, to be sealed`);
      return;
    }
    // The cumulative count sealed into that root (BOND-02); a root sealed
    // before the V2 count carries none the bond reads, and the opening then
    // waits for the W_a lapse (ORIGIN-06).
    if (f.count === undefined || f.countLeaf !== ids.anchorCountLeaf({ epoch: prior, count: f.count })) {
      this.log(`trigger2 the forward root of epoch ${prior} carries no V2 anchor count; the opening waits for the W_a lapse`);
      return;
    }
    const count = f.count;
    const leaf = f.countLeaf;
    const proof = proofFor(buildTree(this.forwardLeaves(prior, f)), leaf);
    const r = await this.tryTx(this.qrl, q.ArkCatBond, this.abi.recovery, 'provePriorAnchors', [count, proof]);
    if (r.ok) this.log(`trigger2 epoch ${prior} carries ${count} anchor(s); proven on the bond (provePriorAnchors)`);
    else this.log(`trigger2 provePriorAnchors refused: ${r.error}; tried again next tick`);
  }

  /** Step 1 of `keepDeclaration`: the claimant record, from the positions this relayer saw anchored. */
  async recordClaimants() {
    const q = this.q;
    const s = this.state.data;
    const d = s.declaration;
    const todo = [];
    for (const id of Object.keys(s.anchors || {})) {
      if (d.skipped[id]) continue;
      const [kind] = await this.qrl.call(q.ArkCatBond, this.abi.bond, 'claimantOf', [id]);
      if (Number(kind) !== 0) continue;
      const a = (await this.qrl.call(q.ArkStakeRegistry, this.abi.registry, 'anchorOf', [id]))[0];
      if (Number(a.status) === 0) {
        d.skipped[id] = 'not a position of this registry';
        continue;
      }
      todo.push(id);
    }
    for (let i = 0; i < todo.length; i += CLAIMANT_BATCH) {
      const batch = todo.slice(i, i + CLAIMANT_BATCH);
      const r = await this.tryTx(this.qrl, q.ArkCatBond, this.abi.recovery, 'recordClaimants', [batch]);
      if (r.ok) {
        this.log(`trigger2 ${batch.length} position(s) recorded as of the ratification (bond recordClaimants)`);
        continue;
      }
      // One refusal fails the batch; find it, set it aside, record the rest.
      for (const id of batch) {
        const one = await this.tryTx(this.qrl, q.ArkCatBond, this.abi.recovery, 'recordClaimants', [[id]]);
        if (one.ok) this.log(`trigger2 position ${id.slice(0, 14)}… recorded`);
        else if (one.error === 'NotClaimant' || one.error === 'AlreadyRecorded') {
          d.skipped[id] = one.error;
          this.log(`trigger2 position ${id.slice(0, 14)}… not recorded: ${one.error}`);
        } else {
          this.log(`trigger2 recordClaimants refused: ${one.error}; tried again next tick`);
          return;
        }
      }
    }
  }

  /** Step 4 of `keepDeclaration`: apply findings waiting at an escrow's next slot. */
  async applyRecoveries(censorship) {
    const ZERO = /^0x0*$/;
    for (const a of this.assets) {
      const l = (await this.qrl.call(this.q.ArkCatBond, this.abi.recovery, 'escrowLedger', [this.chainId, this.evmArg(a.escrow)]))[0];
      let k = Number(l.cursor);
      if (k === 0 && !censorship) k = 1;
      if (k >= RECOVERY_SLOTS || ZERO.test(String(l.found[k]))) continue;
      const r = await this.tryTx(this.qrl, this.q.ArkCatBond, this.abi.recovery, 'applyRecoveries', [this.chainId, this.evmArg(a.escrow)]);
      this.log(`recovery ${a.symbol}: findings from slot ${k} ${r.ok ? 'applied' : `not applied: ${r.error}`} (bond applyRecoveries)`);
    }
  }

  /** Activate the scheduled generation once its ratchet delay has run. Permissionless; the schedule is the authority. */
  async activateGeneration(epoch) {
    const at = big(await this.relayView('extensionActivatesAt'));
    if (at === 0n || epoch < at) return;
    const r = await this.tryTx(this.origin, this.relay, this.abi.relay, 'activateNextGeneration', []);
    if (r.ok) {
      this.log(`return   generation ${await this.relayView('generation')} of the authority chain activated`);
      await this.activeGeneration();
    }
  }

  /**
   * Select every offering whose quote window has closed, within its admission
   * window. Run at the top of the tick, before the QRL scan and the seal
   * (OC-SWAP-01), and again from `settleSwaps`; an offering selected once is
   * never sent again.
   */
  async selectOfferings(qrlNow) {
    if (!this.q.PremiumSwap) return;
    const s = this.state.data;
    const now = big(qrlNow);
    for (const o of Object.values(s.offerings || {})) {
      if (o.selected) continue;
      const opens = this.clock.quoteCloses(o.epoch);
      if (now < opens) continue;
      if (now >= opens + this.clock.ADMISSION_WINDOW) {
        o.selected = 'missed';
        continue;
      }
      const r = await this.tryTx(this.qrl, this.q.PremiumSwap, this.abi.swap, 'select', [this.chainId, this.evmArg(o.asset), o.epoch]);
      if (r.ok || r.error === 'AlreadySelected') o.selected = true;
      // An offer below the batching threshold records no offering: its
      // quantity is carried into a later epoch's (whitepaper §4.7, 2026-09-30).
      else if (r.error === 'NoOffer') o.selected = 'carried';
      this.log(`premium  offering ${o.epoch} of ${o.asset} selected: ${r.ok ? 'ok' : r.error}`);
    }
  }

  /**
   * The premium swap's keeping, every call permissionless and moving value
   * only where the contract fixes it: select each offering when its quote
   * window closes, carry every revealed preimage to QRL, and refund lots that
   * were not selected or lapsed.
   */
  async settleSwaps(originHead, qrlNow) {
    if (!this.q.PremiumSwap) return;
    const s = this.state.data;
    const now = big(qrlNow);
    await this.selectOfferings(now);
    for (const [lotId, w] of Object.entries(s.lots || {})) {
      if (w.status === 'refunded') {
        // A preimage seen on the origin chain for a lot whose QRL already went
        // back: the lot was paid twice. Before 2026-10-11 only a LotExpired
        // refusal raised the alarm, so a lot refunded before its late preimage
        // arrived passed in silence (live S3b, OC-SWAP-12).
        if (w.secret && !w.paidTwiceAlarm) {
          w.paidTwiceAlarm = true;
          this.log(`premium  ALARM: lot ${lotId.slice(0, 14)}… was paid on the origin chain and its QRL went back (refunded before the preimage reached QRL)`);
        }
        continue;
      }
      if (w.status === 'claimed') {
        // The commitment bond of a lot claimed here before its QRL expiry goes
        // back to its solver (I33), by a call anyone may make, once.
        if (!w.bondReturned) {
          const r = await this.tryTx(this.qrl, this.q.PremiumSwap, this.abi.swap, 'refund', [lotId]);
          if (r.ok || r.error === 'NotRefundable') w.bondReturned = true;
        }
        continue;
      }
      if (w.secret) {
        const r = await this.tryTx(this.qrl, this.q.PremiumSwap, this.abi.swap, 'claim', [lotId, w.secret]);
        if (r.ok) w.status = 'claimed';
        else if (r.error === 'LotExpired' && !w.paidTwiceAlarm) {
          w.paidTwiceAlarm = true;
          this.log(`premium  ALARM: lot ${lotId.slice(0, 14)}… was paid on the origin chain and its QRL lock expired first`);
        }
        else if (r.error && !w.paidTwiceAlarm) {
          // Any other refusal of a preimage the origin chain already paid on
          // (the lot refunded or no longer Selected on QRL) is the same loss.
          w.paidTwiceAlarm = true;
          this.log(`premium  ALARM: lot ${lotId.slice(0, 14)}… was paid on the origin chain and QRL refuses its claim (${r.error})`);
        }
        if (r.ok) this.log(`premium  lot ${lotId.slice(0, 14)}… QRL credited to the ledger`);
        continue;
      }
      const e = w.epoch;
      if (e === undefined) continue;
      const due = w.status === 'selected' ? this.clock.settlementCloses(e) : this.clock.quoteCloses(e) + this.clock.ADMISSION_WINDOW;
      if (now < due) continue;
      const r = await this.tryTx(this.qrl, this.q.PremiumSwap, this.abi.swap, 'refund', [lotId]);
      if (r.ok) {
        w.status = 'refunded';
        this.log(`premium  lot ${lotId.slice(0, 14)}… refunded to its solver`);
      }
    }
  }

  /**
   * The pool's first validator, on a devnet that regenerates from genesis
   * (R40): only where the manifest names `poolValidator`, only from deposit
   * data written for this leg's delegation on this genesis, and only once —
   * `fundPoolValidator` sends nothing for a validator already funded.
   *
   * The deposit data comes from the devnet host, which holds the validator's
   * key and never this relayer's (`scripts/warmup.js` carries it across). The
   * relayer does the sending because the steps sign as the leg's deployer, and
   * one account has one sender. The outcome is written beside the deployment
   * record, where the warm-up reports it.
   */
  async fundPoolValidator() {
    const want = this.manifest.poolValidator;
    const q = this.q;
    if (!want || !q.ArkStakingPool || !q.ArkBondDelegation) return;
    const file = path.join(ROOT, 'deployments', `pool-deposit-${this.chain}.json`);
    if (!fs.existsSync(file)) return;
    let deposit;
    try {
      deposit = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (lower(deposit.delegation) !== lower(q.ArkBondDelegation)) return;
    if (lower(deposit.genesis) !== lower(this.deployment.qrlGenesisHash ?? '')) return;
    const s = this.state.data;
    s.staking ||= { provisionalEpoch: null, requests: [] };
    const tag = `${lower(q.ArkBondDelegation)}:${lower(deposit.pubkey)}`;
    if (s.staking.poolValidator === tag) return;
    const out = path.join(ROOT, 'deployments', `pool-validator-${this.chain}.json`);
    const record = { delegation: q.ArkBondDelegation, genesis: deposit.genesis, pubkey: deposit.pubkey };
    try {
      const r = await fundPoolValidator({
        client: this.qrl,
        build: qrlAbiBuild(this.manifest.profile, 'ArkStakingPool'),
        q,
        depositData: deposit.depositData,
        teamDeposit: BigInt(want.teamDeposit ?? '40000') * 10n ** 18n,
        log: this.log,
      });
      s.staking.poolValidator = tag;
      fs.writeFileSync(out, JSON.stringify({ ...record, status: 'funded', pubkeyHash: r.pubkeyHash, steps: r.steps, at: new Date().toISOString() }, null, 2));
    } catch (e) {
      const error = revertName(this.errors, e);
      this.log(`pool     funding the pool's validator failed: ${error}`);
      fs.writeFileSync(out, JSON.stringify({ ...record, status: 'failed', error, at: new Date().toISOString() }, null, 2));
    }
  }

  /**
   * The authority chain's extension, watched (OC-LEGA-06): on the testnet
   * profile one root per epoch consumes a generation in about a hundred days,
   * so the extension is a near-term live item, not a far one. Logged once
   * when the active generation's window opens (`nextLeaf` reaches
   * `EXTENSION_OPENS`); an ALARM, once an epoch, when no extension is
   * scheduled twelve epochs after that AND past the leaf this relayer signs
   * it at (`max(OPENS, HORIZON - 2 * RATCHET)`, see `authorityMessage`):
   * the extension is deliberately signed late in the window, and an alarm
   * before it is due would be noise for most of the window.
   */
  async watchExtension(epoch) {
    const s = this.state.data;
    const generation = Number(await this.relayView('generation'));
    if (!s.extensionWatch || s.extensionWatch.generation !== generation) s.extensionWatch = { generation };
    const w = s.extensionWatch;
    const pendingAt = big(await this.relayView('extensionActivatesAt'));
    if (pendingAt !== 0n) {
      if (!w.scheduled) {
        w.scheduled = String(epoch);
        this.log(`return   the extension to generation ${generation + 1} is scheduled; it activates from epoch ${pendingAt}`);
      }
      return;
    }
    if (w.scheduled) {
      w.scheduled = null;
      this.log(`return   no extension of generation ${generation} is scheduled any more (cancelled)`);
    }
    const nextLeaf = await this.relayNextLeaf();
    const opens = Number(await this.relayView('EXTENSION_OPENS'));
    if (nextLeaf < opens) return;
    const horizon = Number(await this.relayView('MIGRATION_HORIZON'));
    const due = Math.max(opens, horizon - 2 * RATCHET_EPOCHS);
    if (w.openedAt === undefined || w.openedAt === null) {
      w.openedAt = String(epoch);
      this.log(`return   generation ${generation}'s extension window is open: leaf ${nextLeaf}, EXTENSION_OPENS ${opens}; the extension is due from leaf ${due} (horizon ${horizon})`);
    }
    if (nextLeaf >= due && (w.dueAt === undefined || w.dueAt === null)) w.dueAt = String(epoch);
    const since = big(epoch) - big(w.openedAt);
    if (since < EXTENSION_ALARM_EPOCHS || w.dueAt === undefined || w.dueAt === null || big(epoch) <= big(w.dueAt)) return;
    if (w.alarmed === String(epoch)) return;
    w.alarmed = String(epoch);
    const chain = this.manifest.authority;
    const why = generation >= MAX_GENERATIONS
      ? `generation ${generation} is the last the relay takes`
      : !chain || !Array.isArray(chain.generations) || !chain.generations[generation]
        ? `the manifest records no generation ${generation + 1} to extend to`
        : 'see the relayer log for the refusal';
    this.log(`return   ALARM: no extension of generation ${generation} is scheduled ${since} epochs after its window opened (leaf ${nextLeaf} of EXTENSION_OPENS ${opens}, due from ${due}, horizon ${horizon}): ${why} (OC-LEGA-06)`);
  }

  /**
   * The quorum's reconciliation and fees reports for the delegation, sealed
   * on the testnet attestation double (OC-LEGB-06). Without them the
   * delegation's `distribute` never pays, a loss is never booked, and exit
   * principal leaves only through the I32 cap. A stand-in for the attester
   * quorum, as the forward roots on `MockAttestation` are, and run only where
   * the delegation verifies against that double and the host names a beacon
   * node and the QRL client reads blocks: elsewhere nothing is sealed, and
   * that is said once.
   *
   * Each closed epoch from the first funding this relayer saw gets one root at
   * `reportKey(e)`: a line per validator the delegation funded (`Delegated`)
   * that the beacon state holds — status, `slashed`, the epoch its exit was
   * first seen, the credentials it holds, its balance, and its withdrawals
   * summed from the execution blocks through the end of `e` — and a fees line
   * of the priority fees paid to the delegation as fee recipient through the
   * same block. Never the key of a deposit check: those are sealed at the
   * epoch in progress (`pool-validator.js`), or since OC-LEGB-02 in their own
   * keyspace (`DEPOSIT_KEYSPACE | depositCount`); a closed epoch whose key is
   * already taken is skipped with a log, never overwritten (the double is
   * write-once). Each root is noted, and once its challenge window has run
   * each line is reconciled and the fees line applied.
   */
  async sealReports(qrlNow) {
    const q = this.q;
    if (!q.ArkBondDelegation || !q.MockAttestation) return;
    const r = this.reportState();
    const say = (key, line) => {
      if (r.said === key) return;
      r.said = key;
      this.log(line);
    };
    if (!this.beacon || typeof this.qrl.blockFacts !== 'function') {
      say('no-source', 'reports  no beacon node (QRL_BEACON_URL) or no block reader on this QRL leg: the delegation\'s reports are not sealed');
      return;
    }
    if (r.double === undefined) {
      try {
        const att = (await this.qrl.call(q.ArkBondDelegation, this.abi.delegation, 'ATTESTATION'))[0];
        r.double = lower(toHex(att)) === lower(toHex(q.MockAttestation));
      } catch {
        return;
      }
    }
    if (!r.double) {
      say('not-double', 'reports  the delegation verifies against an attestation that is not the testnet double: its reports are the quorum\'s, not this relayer\'s');
      return;
    }
    await this.scanReportBlocks();
    await this.sealReportEpochs(big(qrlNow));
    await this.applyReports(big(qrlNow));
  }

  /** Withdrawals to the delegation and its fees, summed block by block, with a snapshot at each epoch's end. */
  async scanReportBlocks() {
    const r = this.reportState();
    const head = await this.qrl.head();
    if (r.blocksTo === undefined || r.blocksTo === null) r.blocksTo = big(this.deployment.deployedFromBlock || 0) - 1n;
    // Before the first funding nothing a report counts can have happened: no
    // block is read, and the count starts at the first block read after it.
    if (!Object.keys(r.funded).length) {
      r.blocksTo = big(head.safe);
      r.cursorEpoch = null;
      return;
    }
    const from = big(r.blocksTo) + 1n;
    if (from > big(head.safe)) return;
    const to = from + REPORT_SCAN_BLOCKS - 1n < big(head.safe) ? from + REPORT_SCAN_BLOCKS - 1n : big(head.safe);
    const D = lower(toHex(this.q.ArkBondDelegation));
    for (const b of await this.qrl.blockFacts(from, to, this.q.ArkBondDelegation)) {
      const e = this.clock.epochOf(b.timestamp);
      if (r.cursorEpoch === undefined || r.cursorEpoch === null) r.cursorEpoch = String(e);
      // The first block of a later epoch closes every epoch before it at the figures so far.
      while (big(r.cursorEpoch) < e) {
        r.snap[r.cursorEpoch] = { withdrawn: { ...r.withdrawn }, fees: big(r.fees) };
        r.cursorEpoch = String(big(r.cursorEpoch) + 1n);
      }
      for (const w of b.withdrawals || []) {
        if (lower(toHex(w.address)) !== D) continue;
        const k = String(w.validatorIndex);
        r.withdrawn[k] = big(r.withdrawn[k] ?? 0n) + big(w.amount);
      }
      r.fees = big(r.fees) + big(b.fees || 0n);
      r.blocksTo = big(b.number);
    }
    this.state.save();
  }

  async delegationView(method, args = []) {
    return (await this.qrl.call(this.q.ArkBondDelegation, this.abi.delegation, method, args))[0];
  }

  /** Seal the report root of each closed, scanned epoch not yet reported, up to REPORT_EPOCHS a tick. */
  async sealReportEpochs(qrlNow) {
    const q = this.q;
    const r = this.reportState();
    const funded = Object.keys(r.funded);
    if (!funded.length) return;
    const current = this.clock.epochOf(qrlNow);
    // From the epoch this relayer first saw a validator funded: earlier epochs had none to report.
    if (r.next === undefined || r.next === null) r.next = String(current);
    let beacon = null;
    for (let i = 0; i < REPORT_EPOCHS; i++) {
      const e = big(r.next);
      if (e >= current) return;
      const snap = r.snap[String(e)];
      if (!snap) return; // the block scan has not passed the end of e yet
      const key = big(await this.delegationView('reportKey', [e]));
      const taken = await this.qrl.call(q.MockAttestation, this.abi.attestation, 'rootOf', [key]);
      const existing = lower(taken[0]);
      if (!beacon) {
        try {
          beacon = await this.beacon.validators();
        } catch (err) {
          this.log(`reports  the beacon node did not answer: ${err.message}; retried next tick`);
          return;
        }
      }
      const lines = [];
      for (const pkh of funded) {
        const v = await this.delegationView('validatorOf', [pkh]);
        if (big(v.stake) === 0n || v.closed) continue;
        const b = beacon.get(lower(pkh));
        if (!b) continue; // not in the beacon state yet: nothing it shows to report
        let exitAt = 0n;
        if (b.status >= ACTIVE_EXITING) {
          r.exitSeen[pkh] ??= String(e);
          exitAt = big(r.exitSeen[pkh]);
        }
        lines.push([e, pkh, b.status, b.slashed, exitAt, b.credentialsHash, b.balance, big(snap.withdrawn[String(b.index)] ?? 0n)]);
      }
      const fees = big(snap.fees);
      const leaves = [];
      for (const line of lines) leaves.push(await this.delegationView('validatorReportLeaf', [line]));
      leaves.push(await this.delegationView('feesReportLeaf', [e, fees]));
      const tree = buildTree(leaves);
      if (!/^0x0*$/.test(existing) && existing !== lower(tree.root)) {
        r.epochs[String(e)] = { key, skipped: `reportKey(${e}) already holds ${existing}` };
        this.log(`reports  epoch ${e}: its report key already holds another root (${existing.slice(0, 14)}…, a deposit check under the shared keyspace); skipped, never overwritten`);
      } else {
        if (/^0x0*$/.test(existing)) {
          const sealed = await this.tryTx(this.sealer || this.qrl, q.MockAttestation, this.abi.attestation, 'seal', [key, tree.root]);
          if (!sealed.ok) {
            this.log(`reports  epoch ${e}: sealing failed: ${sealed.error}; retried next tick`);
            return;
          }
        }
        const noted = await this.tryTx(this.qrl, q.ArkBondDelegation, this.abi.delegation, 'noteRoot', [e]);
        r.epochs[String(e)] = { key, root: tree.root, lines, fees, leaves, noted: noted.ok || noted.error === 'RootAlreadyNoted', applied: {} };
        this.log(`reports  epoch ${e}: ${lines.length} validator line(s) and the fees line sealed at reportKey, root ${tree.root.slice(0, 14)}…${noted.ok ? ', noted' : ''}`);
      }
      delete r.snap[String(e)];
      r.next = String(e + 1n);
      this.state.save();
    }
  }

  /** Apply every sealed report whose challenge window has run: its lines in order, then its fees. */
  async applyReports(qrlNow) {
    const q = this.q;
    const r = this.reportState();
    const keys = Object.keys(r.epochs).map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const e of keys) {
      const rec = r.epochs[String(e)];
      if (rec.skipped || rec.done) continue;
      if (!rec.noted) {
        const n = await this.tryTx(this.qrl, q.ArkBondDelegation, this.abi.delegation, 'noteRoot', [e]);
        rec.noted = n.ok || n.error === 'RootAlreadyNoted';
        if (!rec.noted) return;
      }
      if (qrlNow < big(await this.delegationView('reportClearsAt', [e]))) return;
      const tree = buildTree(rec.leaves);
      for (let i = 0; i < rec.lines.length; i++) {
        if (rec.applied[i]) continue;
        const res = await this.tryTx(this.qrl, q.ArkBondDelegation, this.abi.delegation, 'reconcile', [rec.lines[i], proofFor(tree, rec.leaves[i])]);
        if (res.ok || REPORT_FINAL.has(res.error)) {
          rec.applied[i] = res.ok ? 'reconciled' : res.error;
          this.log(`reports  epoch ${e}: ${String(rec.lines[i][1]).slice(0, 14)}… ${res.ok ? 'reconciled' : `not reconciled: ${res.error} (final)`}`);
        } else {
          this.log(`reports  epoch ${e}: reconcile refused: ${res.error}; retried next tick`);
          return;
        }
      }
      const feesLeaf = rec.leaves[rec.leaves.length - 1];
      const f = await this.tryTx(this.qrl, q.ArkBondDelegation, this.abi.delegation, 'reconcileFees', [e, rec.fees, proofFor(tree, feesLeaf)]);
      if (!f.ok && !REPORT_FINAL.has(f.error)) {
        this.log(`reports  epoch ${e}: reconcileFees refused: ${f.error}; retried next tick`);
        return;
      }
      rec.done = true;
      this.state.save();
    }
  }

  /**
   * Close the bond's book in batches while it is further behind than one
   * strict close may go (OC-ECON-05): after an outage of more than
   * BOND_MAX_CLOSE epochs every strict close path refuses `EpochGapTooLong`
   * — `distribute` among them, and through `_requireCouponCurrent` every
   * redemption, queue claim and transfer — until somebody calls
   * `closeEpochs`. Permissionless; it closes only epochs that have ended.
   */
  async closeBondGap(qrlNow) {
    if (!this.q.ArkCatBond) return;
    const now = this.clock.epochOf(qrlNow);
    for (let i = 0; i < CLOSE_BATCHES; i++) {
      let last;
      try {
        last = big((await this.qrl.call(this.q.ArkCatBond, this.abi.catBond, 'state'))[0].lastClosedEpoch);
      } catch {
        return;
      }
      // `_closeBatch` refuses `now - (last + 1) > MAX_CLOSE`; one short of it
      // already closes, as the block that lands may be in the next epoch.
      const gap = now - (last + 1n);
      if (gap < BOND_MAX_CLOSE) return;
      const r = await this.tryTx(this.qrl, this.q.ArkCatBond, this.abi.catBond, 'closeEpochs', [BOND_MAX_CLOSE]);
      if (!r.ok) {
        this.log(`bond     ${gap} epochs unclosed; closeEpochs refused: ${r.error}`);
        return;
      }
      this.log(`bond     ${gap} epochs unclosed (more than one close batch of ${BOND_MAX_CLOSE}): closed ${BOND_MAX_CLOSE} with closeEpochs`);
    }
  }

  /**
   * Bond principal's staking, kept moving, every call permissionless: the
   * delegation forwards what its validators paid in up to the epoch's reward
   * cap (I32), the pool stakes what is not owed to its queue and settles the
   * queue, and the bond's staking contract asks for the gain above principal
   * and claims every request the pool has settled. What the relayer chooses is
   * only when; the destinations are all fixed in the contracts.
   */
  async keepStaking(qrlNow) {
    const q = this.q;
    if (!q.ArkStakingPool || !q.ArkBondDelegation || !q.ArkBondStaking) return;
    const s = this.state.data;
    s.staking ||= { provisionalEpoch: null, requests: [] };
    const epoch = this.clock.epochOf(qrlNow);
    if (s.staking.provisionalEpoch !== String(epoch)) {
      const r = await this.tryTx(this.qrl, q.ArkBondDelegation, this.abi.delegation, 'distributeProvisional', []);
      if (r.ok || r.error === 'NothingToDistribute') s.staking.provisionalEpoch = String(epoch);
      if (r.ok) this.log(`staking  validator receipts forwarded to the pool, epoch ${epoch}`);
    }
    await this.tryTx(this.qrl, q.ArkBondDelegation, this.abi.delegation, 'distribute', []);
    await this.tryTx(this.qrl, q.ArkStakingPool, this.abi.pool, 'settle', [16]);
    await this.tryTx(this.qrl, q.ArkStakingPool, this.abi.pool, 'stake', []);
    const h = await this.tryTx(this.qrl, q.ArkBondStaking, this.abi.staking, 'harvest', []);
    if (h.ok) {
      const ev = this.parseQrl(QRL_EVENTS.ArkBondStaking, this.abi.staking, h.receipt.logs).find((x) => x.name === 'Requested');
      if (ev) {
        s.staking.requests.push(String(ev.args.requestId));
        this.log(`staking  gain of ${ev.args.amount} planck asked of the pool for the holders`);
      }
    }
    for (const id of [...s.staking.requests]) {
      const r = await this.tryTx(this.qrl, q.ArkBondStaking, this.abi.staking, 'claim', [BigInt(id)]);
      if (r.ok || r.error === 'UnknownRequest') {
        s.staking.requests = s.staking.requests.filter((x) => x !== id);
        if (r.ok) this.log(`staking  request ${id} claimed and passed to the bond`);
      }
    }
  }

  /**
   * The coupon of every epoch whose reveal window has closed (R38). Until an
   * epoch is distributed its coupon is unfixed, and a transfer, a redemption
   * and a queue draw all wait on it with `CouponPending`, so a bond nobody
   * distributes for freezes every holding in it. Runs after the deliveries of
   * this tick: an epoch is distributed only once its credit window has shut,
   * so nothing delivered can arrive after the coupon that should have paid it.
   */
  async distributeCoupons(qrlNow) {
    // The bond's book first: a gap past one close batch refuses every distribution (OC-ECON-05).
    await this.closeBondGap(qrlNow);
    // A deployment made before the bond existed has no coupon account.
    if (!this.q.ArkBondCoupon) return;
    for (let i = 0; i < DISTRIBUTE_EPOCHS; i++) {
      const next = big((await this.qrl.call(this.q.ArkBondCoupon, this.abi.coupon, 'lastDistributed'))[0]) + 1n;
      if (qrlNow < this.clock.settlementCloses(next)) return;
      let r = await this.tryTx(this.qrl, this.q.ArkBondCoupon, this.abi.coupon, 'distribute', [next]);
      if (!r.ok && r.error === 'EpochGapTooLong') {
        // The chain's clock ran past the gap the head read allowed for: close and try once more.
        await this.closeBondGap(qrlNow + this.clock.EPOCH_LENGTH);
        r = await this.tryTx(this.qrl, this.q.ArkBondCoupon, this.abi.coupon, 'distribute', [next]);
      }
      if (!r.ok) {
        this.log(`coupon   epoch ${next}: not distributed: ${r.error}`);
        return;
      }
      this.log(`coupon   epoch ${next} distributed, gas ${r.receipt.gasUsed}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  async status() {
    const s = this.state.data;
    const head = await this.origin.head();
    const qHead = await this.qrl.head();
    const rv = (m) => this.relayView(m);
    const nextLeaf = Number(await rv('nextLeaf'));
    const generation = Number(await rv('generation'));
    const out = {
      chain: this.chain,
      originEpoch: this.clock.epochOf(head.timestamp),
      qrlEpoch: this.clock.epochOf(qHead.timestamp),
      epochLengthSeconds: this.clock.EPOCH_LENGTH,
      relay: {
        address: this.relay,
        threshold: Number(await rv('THRESHOLD')),
        signers: (await rv('signerRoots')).length,
        generation,
        nextLeaf,
        horizon: await rv('MIGRATION_HORIZON'),
        extensionWindow: [await rv('EXTENSION_OPENS'), await rv('EXTENSION_CLOSES')],
        extensionActivatesAt: await rv('extensionActivatesAt'),
        lastEpoch: await rv('lastEpoch'),
      },
      signersHeld: this.signers ? this.signers.held() : [],
      // Whether this state may sign: false is a state that does not account for
      // every leaf the relay has consumed (assertCovers).
      stateCoversRelay: this.covers(nextLeaf),
      escrows: [],
      pending: s.pending.map((p) => ({ kind: p.kind, standIn: p.standIn || null, leaf: p.leaf })),
      roots: Object.keys(s.roots).length,
      forwardUnapplied: Object.values(s.forward).flatMap((f) => f.items.filter((x) => !x.applied)).length,
      lotsOpen: Object.values(s.lots || {}).filter((w) => w.status === 'quoted' || w.status === 'selected').length,
      // Premium locks that reached no root before their evmExpiry (OC-SWAP-01).
      locksExpiredUnsealed: Object.keys(s.expiredLocks || {}).length,
      // Sealed releases withheld from censorship-ground claimants (OC-LEGA-01).
      releasesWithheld: Object.keys(s.claimantHold || {}).length,
      // The authority chain's extension as watched (OC-LEGA-06).
      extensionWatch: s.extensionWatch || null,
      // The delegation's reports on the attestation double (OC-LEGB-06).
      reports: s.reports
        ? { validators: Object.keys(s.reports.funded || {}).length, next: s.reports.next ?? null, sealed: Object.values(s.reports.epochs || {}).filter((x) => x.root).length, applied: Object.values(s.reports.epochs || {}).filter((x) => x.done).length }
        : null,
      couponLastDistributed: this.q.ArkBondCoupon
        ? big((await this.qrl.call(this.q.ArkBondCoupon, this.abi.coupon, 'lastDistributed'))[0])
        : null,
      // Which Q-Day oracle the leg reads, its governance, and trigger 2 as the bond holds it.
      qday: qdayOracleOf(this.deployment),
      governance: this.deployment.governance ? { record: this.deployment.governance.record, genesisHash: this.deployment.governance.genesisHash } : null,
      trigger2: null,
    };
    if (this.q.ArkCatBondRecovery) {
      const t2 = (await this.qrl.call(this.q.ArkCatBond, this.abi.bond, 'declaration'))[0];
      const c = (await this.qrl.call(this.q.ArkCatBond, this.abi.recovery, 'claimants'))[0];
      out.trigger2 = { stage: Number(t2.stage), ground: Number(c.ground), claimantsLive: c.live, claimantWeight: c.weight, drawn: t2.drawn, held: t2.held };
    }
    for (const a of this.assets) {
      const abi = this.escrowAbi(a);
      const v = async (m) => (await this.origin.call(a.escrow, abi, m))[0];
      const control = await this.relayView('controlOf', [a.escrow]);
      out.escrows.push({
        symbol: a.symbol,
        escrow: a.escrow,
        closed: control.closed,
        frozen: control.frozen,
        positionShares: await v('positionShares'),
        queuedShares: await v('queuedShares'),
        bufferShares: await v('bufferShares'),
        auctionShares: await v('auctionShares'),
        queueBase: await v('queueBase'),
        queue: `${await v('queueHead')}..${await v('queueTail')}`,
        releaseBudgetRemaining: await v('releaseBudgetRemaining'),
        anchoringClosed: await v('anchoringClosed'),
      });
    }
    return out;
  }
}

module.exports = { Relayer, hostRefusal, mockQdayActs, qdayOracleOf, ownerFromWords, leafKey, STAND_IN, WAIT, FINAL, FORWARD_FINAL, CONTROL, RELEASE_EPOCH_DELAY };
