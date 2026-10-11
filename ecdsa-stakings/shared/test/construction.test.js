/**
 * whitepaper §3.2's properties of the bytecode, as assertions over the compiled
 * artifacts and the sources they come from.
 *
 * Every other test in this tree checks what the escrow and the relay *do*.
 * These check what they cannot do, and that distinction is the whole product:
 * §3.2 says each property is "the absence of a capability rather than a
 * restriction on one". So they are checked by inspecting what gets deployed —
 * a revert proves a guard exists, and what has to be proved is that no path
 * exists at all.
 *
 * This is the only direct check of invariants I1, I2 and I3. A future refactor
 * that reached for `Ownable`, a proxy, `Address.functionDelegateCall` or a
 * `msg.sender ==` guard would pass every behavioural test in this directory and
 * fail here.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

const { ACCOUNTS } = require('../../../test/harness');
const { buildDirFor, originChain, relayFixture } = require('./helpers');

const ESCROWS = ['ArkStakeEscrowUnits', 'ArkStakeEscrowShares', 'ArkStakeEscrowLido'];
const CONTRACTS_DIR = path.join(__dirname, '..', 'contracts');

const artifact = (name) =>
  JSON.parse(fs.readFileSync(path.join(buildDirFor('ethereum'), `${name}.json`), 'utf8'));

/** Every deployable source: the contracts and their libraries, not the test doubles. */
function productionSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'mocks') walk(path.join(dir, e.name));
      } else if (e.name.endsWith('.sol')) {
        out.push({ name: e.name, text: fs.readFileSync(path.join(dir, e.name), 'utf8') });
      }
    }
  };
  walk(CONTRACTS_DIR);
  return out;
}

/** Source with comments removed, so a comment that names a forbidden thing is not a hit. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The opcodes that can execute in runtime bytecode.
 *
 * A byte scan would be wrong: `0xf4` inside a PUSH immediate is data, not a
 * DELEGATECALL. So the stream is walked, skipping each PUSH's immediate.
 *
 * And a byte after a halting or jumping instruction executes only if a
 * JUMPDEST precedes it there: nothing falls through a STOP, JUMP, RETURN,
 * REVERT, INVALID or SELFDESTRUCT, and a jump lands only on a JUMPDEST. So
 * such bytes are not collected until the next JUMPDEST. This is what keeps
 * the data solc appends after the code — the 32-byte constants, then the
 * metadata — out of the stream: STAKE_DOMAIN holds a 0xff, and the viaIR
 * build of the Lido form (2026-09-29) happened to align it outside a PUSH
 * immediate, where a plain walk read it as a SELFDESTRUCT no path can reach.
 */
const HALTS = new Set([0x00, 0x56, 0xf3, 0xfd, 0xfe, 0xff]);
function opcodesIn(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const seen = new Set();
  let live = true;
  for (let i = 0; i < bytes.length; ) {
    const op = bytes[i];
    if (op === 0x5b) live = true;
    if (live) seen.add(op);
    if (HALTS.has(op)) live = false;
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f + 1;
    else i += 1;
  }
  return seen;
}

const FORBIDDEN = { 0xff: 'SELFDESTRUCT', 0xf4: 'DELEGATECALL', 0xf2: 'CALLCODE' };

const functionNames = (name) =>
  artifact(name)
    .abi.filter((i) => i.type === 'function')
    .map((i) => i.name);

describe('the escrow cannot do what section 3.2 says it cannot', () => {
  for (const name of ESCROWS) {
    test(`${name} contains no SELFDESTRUCT, DELEGATECALL or CALLCODE`, () => {
      // Invariant I2, over the instruction stream rather than the source,
      // because the source is not what gets deployed.
      const ops = opcodesIn(artifact(name).deployedBytecode);
      for (const [op, label] of Object.entries(FORBIDDEN)) {
        assert.ok(!ops.has(Number(op)), `${name} contains ${label}`);
      }
    });

    test(`${name} exposes no function that is not part of the design`, () => {
      // An allowlist rather than a denylist: a function added by a future
      // refactor fails this by default. The state-changing entries are yellow
      // paper §1.4's origin-chain table — including the loss settlement and the
      // recovery share, the third and fourth return messages of whitepaper §3.5
      // — plus the two this tree adds: the de-listing latch and the queue
      // drain, each of which moves nothing it was not already bound to move.
      // The premium lock replaces the premium settlement: an offer that only
      // emits, and a claim against a leaf and its preimage. The Lido form adds
      // ETH as a way in, into the same anchoring and seeding paths.
      const allowed = new Set([
        // Anyone may call these; none reads the sender as authority.
        'seed',
        'anchor',
        // Anchoring term-committed (whitepaper §4.4): the same path, at the rung in force.
        'anchorCommitted',
        'anchorNativeCommitted',
        'sweep',
        'release',
        'drainQueue',
        'offerPremium',
        // States the buffer for the forward path (whitepaper §4.3); moves nothing.
        'reportBuffer',
        'claimPremium',
        'anchorNative',
        'seedNative',
        'settleLoss',
        'releaseShare',
        'recordEpochAllocation',
        'closeAnchoring',
        // Pays a refused payment to the payee it was credited to, and to no one else.
        'withdrawOwed',
        // Returns the seed to the operations destination fixed at construction,
        // once no position is anchored and no claim outstanding, against a
        // seed-return leaf QRL seals only while nothing is open there (PV-17); anyone.
        'withdrawSeed',
        // The treasury's prime of the reserve (PV-04): a gift into the reserve; anyone.
        'primePsr',
        // Immutables and views. None writes anything.
        'ASSET',
        'RELAY',
        'OPERATIONS_DESTINATION',
        'SEED_MINIMUM',
        // The QRL line the escrow serves, fixed at construction (D14).
        'QRL_OWNER_LENGTH',
        // The admission audit's reference yield the reserve gate reads before a close-out (EC-08).
        'AUDIT_YIELD_RATE',
        // The part of the prime the levy has not replaced (PV-04); a view.
        'primeUnreplaced',
        'SHARES',
        'positionShares',
        'totalStake',
        'bufferShares',
        'auctionShares',
        'queuedShares',
        'queuedReleaseShares',
        'unclaimedShares',
        'owedShares',
        'releasesReclaimed',
        'queueBase',
        'seededUnits',
        'lastRate',
        'anchoringClosed',
        'queueHead',
        'queueTail',
        'queueEntry',
        'positionOf',
        'claimOf',
        'recordedAllocation',
        // The premium stabilization reserve and the committed cohorts (I39).
        'psrShares',
        'cohortOf',
        'isSpent',
        'nonceOf',
        'releaseBudgetRemaining',
        // Units the queued loss settlements are still owed (D13, D17); a view.
        'lossOwedUnits',
        // A position moved out of the priced book by an early presentation of
        // its receipt, until the receipt is consumed (I18; X7); a view.
        'transitShares',
        'sharesHeld',
        'toUnits',
      ]);
      const unexpected = functionNames(name).filter((n) => !allowed.has(n));
      assert.deepEqual(unexpected, [], `${name} exposes ${unexpected.join(', ')}`);
    });

    test(`${name} has no owner, admin, guardian or pauser`, () => {
      const fns = functionNames(name).map((n) => n.toLowerCase());
      for (const forbidden of [
        'owner',
        'transferownership',
        'renounceownership',
        'pause',
        'unpause',
        'grantrole',
        'hasrole',
        'upgradeto',
        'initialize',
      ]) {
        assert.ok(!fns.includes(forbidden), `${name} exposes ${forbidden}`);
      }
    });

    test(`${name} takes no signature as an argument anywhere`, () => {
      // Invariant I1, stated over signatures rather than over `ecrecover`,
      // because a scheme verified in contract code would fail the same way. The
      // one signature the design admits is the relay's, and it is not here.
      for (const item of artifact(name).abi) {
        for (const input of item.inputs || []) {
          const n = (input.name || '').toLowerCase();
          assert.ok(
            !['signature', 'sig', 'otssig', 'v', 'r', 's'].includes(n),
            `${name}.${item.name} takes ${input.name}`,
          );
        }
      }
    });
  }

  test('the escrow grants no approval to any address', () => {
    // An allowance would let a third party move the escrowed balance through
    // the asset's own transfer path.
    const source = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkStakeEscrow.sol'), 'utf8'));
    for (const forbidden of ['approve(', 'safeApprove', 'forceApprove', 'safeIncreaseAllowance']) {
      assert.ok(!source.includes(forbidden), `ArkStakeEscrow.sol calls ${forbidden}`);
    }
  });

  test('the premium destination is gone, so the premium has no path out but a premium lock and its preimage', () => {
    // An immutable destination alongside the pot would be a second path out
    // of it; so would the premium settlement the swap replaced.
    for (const name of ESCROWS) {
      assert.ok(!functionNames(name).includes('PREMIUM_DESTINATION'));
      assert.ok(!functionNames(name).includes('settlePremium'));
    }
  });

  test('only the Lido form is payable, and only where ETH names a beneficiary or seeds the buffer', () => {
    for (const name of ESCROWS) {
      const payable = artifact(name).abi.filter((i) => i.stateMutability === 'payable').map((i) => i.type === 'function' ? i.name : i.type);
      const expected = name === 'ArkStakeEscrowLido' ? ['anchorNative', 'anchorNativeCommitted', 'seedNative'] : [];
      assert.deepEqual(payable.sort(), expected, `${name} is payable at ${payable.join(', ')}`);
    }
  });
});

describe('no function in the origin leg reads the sender as authority', () => {
  test('no deployable source compares msg.sender or tx.origin with anything', () => {
    // whitepaper §3.2: "no function gated on an address". The escrow reads
    // msg.sender only as the account whose tokens a deposit pulls, and the relay
    // not at all.
    for (const { name, text } of productionSources()) {
      const body = code(text);
      assert.ok(!/msg\.sender\s*[!=]=|[!=]=\s*msg\.sender/.test(body), `${name} compares msg.sender`);
      assert.ok(!/tx\.origin/.test(body), `${name} reads tx.origin`);
      assert.ok(!/onlyOwner|Ownable|AccessControl/.test(body), `${name} carries an access modifier`);
    }
  });

  test('no deployable source recovers an address from a signature', () => {
    // Invariant I1 and whitepaper §3.2: the only signature the origin leg
    // verifies is the hash-based one of §3.6.
    for (const { name, text } of productionSources()) {
      const body = code(text);
      assert.ok(!/ecrecover|ECDSA|SignatureChecker/.test(body), `${name} recovers a signer`);
    }
  });

  /**
   * Behaviourally, too: every state-changing function, called with the same
   * arguments on two identical deployments by two different accounts, fails or
   * succeeds the same way. A guard on the caller would make the outcome depend
   * on who called, and this is where it would show.
   */
  async function outcomesFor(caller) {
    const chain = await originChain();
    const { relay } = await relayFixture(chain);
    const asset = await chain.deploy('MockAsset');
    const escrow = await chain.deploy(
      'ArkStakeEscrowUnits',
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [asset.address, relay.address, '0x' + 'ef'.repeat(20), 1n, 20, 421917808219179n],
    );
    for (const who of [ACCOUNTS.alice, ACCOUNTS.mallory]) {
      await asset.send('mint', [who, 10n ** 20n]);
      await asset.send('approve', [escrow.address, 10n ** 20n], { from: who });
    }

    const out = {};
    for (const [contract, name] of [
      [relay, 'ArkEpochRootRelay'],
      [escrow, 'ArkStakeEscrowUnits'],
    ]) {
      const iface = new Interface(artifact(name).abi);
      for (const fn of iface.fragments.filter(
        (f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability),
      )) {
        // Plausible non-zero arguments, the same for both callers.
        const args = fn.inputs.map((p) => sample(p));
        let result;
        try {
          await contract.send(fn.name, args, { from: caller });
          result = 'ok';
        } catch (e) {
          result = e.message;
        }
        out[`${name}.${fn.name}`] = result;
      }
    }
    return out;
  }

  function sample(p) {
    if (p.baseType === 'tuple') return p.components.map((c) => sample(c));
    if (p.baseType === 'array') {
      const n = p.arrayLength === -1 ? 1 : p.arrayLength;
      return Array.from({ length: n }, () => sample(p.arrayChildren));
    }
    if (p.type === 'address') return ACCOUNTS.bob;
    if (p.type === 'bool') return true;
    if (p.type.startsWith('bytes')) return '0x' + '11'.repeat(32);
    if (p.type === 'uint8') return 4;
    if (p.type === 'uint16') return 250;
    if (p.type === 'uint32') return 0;
    return 1n;
  }

  test('every state-changing function behaves the same whoever calls it', async () => {
    const a = await outcomesFor(ACCOUNTS.alice);
    const b = await outcomesFor(ACCOUNTS.mallory);
    assert.ok(Object.keys(a).length >= 11, 'the sweep covered too few functions to mean anything');
    assert.deepEqual(b, a);
  });
});

describe('the relay admits roots on a signature and moves nothing', () => {
  test('the relay exposes nothing that moves value', () => {
    // No asset, no transfer path: roots, a one-way latch, and the reversible
    // freeze — none of which names a recipient or moves a token.
    const allowed = new Set([
      // Admitted on k one-time signatures of the active generation, or on the clock.
      'admitEpochRoot',
      'scheduleExtension',
      'cancelExtension',
      'activateNextGeneration',
      // Admitted on membership in an admitted root.
      'publishLeaves',
      'close',
      'setFrozen',
      // What an escrow reads: each reverts or answers, and writes nothing.
      'requireMember',
      // A release receipt of the caller's own, checked against its root: its
      // spend key and the epoch it may be consumed from (X7, D11).
      'releaseReceipt',
      // An allocation of the caller's own, its ranges checked and its leaf
      // against its root (R3-07, 2026-09-30); a view.
      'allocationReceipt',
      // The loss, share, premium-lock, de-listing and seed-return leaves of
      // the caller's own, each against its root (EC phase 2, 2026-09-30); views.
      'lossReceipt',
      'shareReceipt',
      'premiumReceipt',
      'delistReceipt',
      'seedReturnReceipt',
      // The seed-return leaves already presented (ORIGIN-01); a view.
      'seedReturnSpent',
      'requireAnchorable',
      'controlOf',
      'isClosed',
      // Views.
      'acceptedRoot',
      'rootOf',
      'admittedIn',
      'leavesPublished',
      // The leaf count each admitted root was signed with (OL-01).
      'leafCounts',
      'rootMessage',
      'extensionMessage',
      'cancelMessage',
      'currentEpoch',
      'signerRoots',
      'pendingGeneration',
      'chainCommit',
      'generation',
      'extensionActivatesAt',
      'nextLeaf',
      'lastEpoch',
      'THRESHOLD',
      'SIGNER_COUNT',
      'TREE_HEIGHT',
      'LEAF_COUNT',
      'MIGRATION_HORIZON',
      'EXTENSION_OPENS',
      'EXTENSION_CLOSES',
      'MAX_GENERATIONS',
      'RATCHET_EPOCHS',
    ]);
    assert.deepEqual(functionNames('ArkEpochRootRelay').filter((n) => !allowed.has(n)), []);
  });

  test('the relay contains no SELFDESTRUCT, DELEGATECALL or CALLCODE', () => {
    const ops = opcodesIn(artifact('ArkEpochRootRelay').deployedBytecode);
    for (const [op, label] of Object.entries(FORBIDDEN)) {
      assert.ok(!ops.has(Number(op)), `the relay contains ${label}`);
    }
  });

  test('the relay has no staleness closure, no submitter and no closer', () => {
    // A censored relay is a court ground (whitepaper §3.6); a latch that closed
    // it on silence would turn the censorship into permanent immobility.
    const fns = functionNames('ArkEpochRootRelay').map((n) => n.toLowerCase());
    for (const gone of ['closeonstaleness', 'isstale', 'requirefresh', 'submitepochroot', 'root_submitter', 'closer']) {
      assert.ok(!fns.includes(gone), `the relay exposes ${gone}`);
    }
  });

  test('the migration horizon is a constant ratio of the leaf set, not a parameter', () => {
    // whitepaper §6.4: a horizon a vote could move is one it could move to the
    // leaf before exhaustion.
    const relaySource = fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkEpochRootRelay.sol'), 'utf8');
    assert.match(relaySource, /uint256 internal constant HORIZON_BPS = 8_000;/);
    assert.match(relaySource, /uint32 public immutable MIGRATION_HORIZON;/);
  });

  test('I35: the authority is written at construction and by the activation of the next link, and nowhere else', () => {
    // whitepaper §3.6: the chain adds no admin, no vote and no new class of
    // key. The signer roots and the chain commitment have exactly two writers,
    // the constructor and `activateNextGeneration`, which copies what
    // `scheduleExtension` verified against the commitment; the threshold and
    // the height are immutables and have none.
    const body = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkEpochRootRelay.sol'), 'utf8'));
    const writers = (lhs) => {
      const fns = [];
      const re = new RegExp(`${lhs}\\s*=[^=]`, 'g');
      for (let m; (m = re.exec(body)); ) {
        const before = body.slice(0, m.index);
        const fn = [...before.matchAll(/(function\s+(\w+)|constructor)\s*\(/g)].pop();
        fns.push(fn[2] || 'constructor');
      }
      return [...new Set(fns)].sort();
    };
    assert.deepEqual(writers('_signerRoots'), ['activateNextGeneration', 'constructor']);
    assert.deepEqual(writers('chainCommit'), ['activateNextGeneration', 'constructor']);
    assert.deepEqual(writers('_pendingRoots'), ['scheduleExtension']);
    assert.match(body, /uint8 public immutable THRESHOLD;/);
    assert.match(body, /uint8 public constant MAX_GENERATIONS = 4;/);
    assert.match(body, /uint64 public constant RATCHET_EPOCHS = 6;/);
  });
});

describe('every leaf the escrow acts on binds the escrow (D10)', () => {
  test('each leaf the escrow builds is built over address(this)', () => {
    // yellow paper §2.2 and I6: a leaf admitted for one escrow of a relay
    // verifies at no other. A leaf builder called without the escrow's own
    // address would make that leaf payable at every escrow the relay serves.
    const body = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkStakeEscrow.sol'), 'utf8'));
    // The allocation leaf is built by the relay's `allocationReceipt` over
    // the caller since 2026-09-30 (R3-07), as the release leaf is (below),
    // and the loss, share, premium-lock and de-listing leaves since EC phase 2.
    const builders = ['releasedLeaf', 'premiumOfferLeaf', 'bufferLeaf'];
    for (const b of builders) {
      // Each call's arguments, up to the end of its statement.
      const sites = [...body.matchAll(new RegExp(`ArkStakeIds\\.${b}\\(([^;]*)`, 'g'))];
      assert.ok(sites.length > 0, `the escrow never builds ${b}`);
      for (const site of sites) assert.match(site[1], /address\(this\)/, `ArkStakeIds.${b} built without address(this)`);
    }
  });

  test('the loss, share, premium-lock, de-listing and seed-return leaves are built by the relay over the caller (EC phase 2)', () => {
    // Moved out of the escrow on 2026-09-30 to pay for the reserve gate and
    // the seed return in the Lido form's bytes, as R3-07 moved the
    // allocation's: each is built over `msg.sender`, so a caller can only
    // ever check a leaf of its own, and the escrow builds none of them.
    const escrow = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkStakeEscrow.sol'), 'utf8'));
    const relay = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkEpochRootRelay.sol'), 'utf8'));
    for (const [builder, receipt] of [
      ['lossLeaf', 'lossReceipt'],
      ['shareLeaf', 'shareReceipt'],
      ['premiumLockLeaf', 'premiumReceipt'],
      ['delistLeaf', 'delistReceipt'],
      ['seedReturnLeaf', 'seedReturnReceipt'],
    ]) {
      assert.ok(!new RegExp(`ArkStakeIds\\.${builder}\\(`).test(escrow), `the escrow no longer builds ${builder}`);
      assert.match(escrow, new RegExp(`RELAY\\.${receipt}\\(`));
      const sites = [...relay.matchAll(new RegExp(`ArkStakeIds\\.${builder}\\(([^;]*)`, 'g'))];
      assert.equal(sites.length, 1, builder);
      assert.match(sites[0][1], /^block\.chainid, msg\.sender,/, `${builder} over the calling escrow`);
    }
  });

  test('the release leaf is built by the relay over the calling escrow, and by nothing else', () => {
    // Since 2026-09-29 (X7) the escrow reads a receipt twice and the relay
    // builds its leaf, over `msg.sender`: a caller can check a receipt of its
    // own and of no other escrow on the relay.
    const escrow = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkStakeEscrow.sol'), 'utf8'));
    assert.ok(!/ArkStakeIds\.releaseLeaf\(/.test(escrow), 'the escrow no longer builds the release leaf');
    assert.match(escrow, /RELAY\.releaseReceipt\(/);
    const relay = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkEpochRootRelay.sol'), 'utf8'));
    const sites = [...relay.matchAll(/ArkStakeIds\.releaseLeaf\(([^;]*)/g)];
    assert.equal(sites.length, 1);
    assert.match(sites[0][1], /^msg\.sender,/);
  });

  test('the allocation leaf is built by the relay over the calling escrow, and by nothing else (R3-07)', () => {
    const escrow = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkStakeEscrow.sol'), 'utf8'));
    assert.ok(!/ArkStakeIds\.allocationLeaf\(/.test(escrow), 'the escrow no longer builds the allocation leaf');
    assert.match(escrow, /RELAY\.allocationReceipt\(/);
    const relay = code(fs.readFileSync(path.join(CONTRACTS_DIR, 'ArkEpochRootRelay.sol'), 'utf8'));
    const sites = [...relay.matchAll(/ArkStakeIds\.allocationLeaf\(([^;]*)/g)];
    assert.equal(sites.length, 1);
    assert.match(sites[0][1], /^msg\.sender,/);
  });
});
