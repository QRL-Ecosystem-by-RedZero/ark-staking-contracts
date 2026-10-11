/**
 * ChunkedDeployer: creation code too large for one QRL transaction, deployed from
 * pieces that each fit.
 *
 * The one rule this file exists to defend: **what is created is exactly the code
 * the owner named, and nobody but the account that created the deployer can add
 * to an upload, deploy it or clear it** — so spreading a deployment across
 * several transactions opens no window in which somebody else's bytes become a
 * contract (CLAUDE.md §3.1), and nobody else can advance the deployer's CREATE
 * nonce and move the address of the owner's next contract (audit D19).
 *
 * And the constraint it places on what it deploys: the created contract sees the
 * deployer as `msg.sender`, so `ArkCatBond` takes its wiring authority as an
 * argument. The last test holds it to that.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { keccak256, getCreateAddress, Interface } = require('ethers');
const { createAddressFromString, bytesToHex } = require('@ethereumjs/util');
const { Chain, ACCOUNTS, artifact, coder } = require('./harness');

/** Well under the ~18,000-byte request ceiling, and small enough to force several pieces. */
const PIECE = 6000;
const UPLOAD = keccak256('0x' + Buffer.from('ArkCatBond').toString('hex'));

const ZERO = '0x' + '00'.repeat(20);

function pieces(hex, size = PIECE) {
  const body = hex.replace(/^0x/, '');
  const out = [];
  for (let i = 0; i < body.length; i += size * 2) out.push('0x' + body.slice(i, i + size * 2));
  return out;
}

async function codeAt(chain, address) {
  return bytesToHex(await chain.vm.stateManager.getCode(createAddressFromString(address)));
}

/**
 * Constructor arguments for a bond that only needs to construct: five non-zero
 * placeholder dependencies, the deployer, and a settlement module built on the
 * same five (phase C3) — the one argument the bond's constructor does check,
 * against the module's own immutables; the rest it checks for zero only.
 */
const dep = (n) => '0x' + String(n).repeat(40).slice(0, 40);
const DEPS = [dep(1), dep(2), dep(3), dep(4), dep(5)];
const BOND_TYPES = ['address', 'address', 'address', 'address', 'address', 'address', 'address'];
let SETTLEMENT = ZERO;

function bondArgs(deployer) {
  return coder.encode(BOND_TYPES, [...DEPS, deployer, SETTLEMENT]);
}

async function fixture() {
  const chain = await Chain.create();
  // Phase C3b: the settlement module names a recovery module built on the same five.
  const recovery = (await chain.deploy('ArkCatBondRecovery', BOND_TYPES.slice(0, 5), DEPS)).address;
  SETTLEMENT = (await chain.deploy('ArkCatBondSettlement', BOND_TYPES.slice(0, 6), [...DEPS, recovery])).address;
  const deployer = await chain.deploy('ChunkedDeployer');
  const bytecode = artifact('ArkCatBond').bytecode;
  return { chain, deployer, bytecode, codeHash: keccak256(bytecode) };
}

async function upload(ctx, from = ACCOUNTS.admin, id = UPLOAD) {
  for (const p of pieces(ctx.bytecode)) {
    await ctx.deployer.send('append', [id, p], { from });
  }
}

describe('what is created is exactly the code the uploader named', () => {
  test('the bond exceeds one transaction, so it has to arrive in pieces', async () => {
    const ctx = await fixture();
    const bytes = (ctx.bytecode.length - 2) / 2;
    assert.ok(bytes > 18000, `the bond is ${bytes} bytes; this suite exists because it is above the ceiling`);
    assert.ok(pieces(ctx.bytecode).length > 1);
  });

  test('a contract assembled from pieces has the runtime code of the same contract deployed whole', async () => {
    const ctx = await fixture();
    await upload(ctx);
    const res = await ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]);
    const [ev] = ctx.deployer.events(res, 'Deployed');

    // The harness has no request ceiling, so the same bond can be created whole
    // and the two compared byte for byte — up to the ONE value that cannot
    // match: the bond's constructor creates its exit module (its first
    // creation, so contract nonce 1) and fixes that address in an immutable,
    // and the module's address is a function of the bond's own. Each bond's
    // runtime is required to embed exactly ITS module's address, and the two
    // modules — which embed nothing self-referential — must match byte for byte.
    const whole = await ctx.chain.deploy('ArkCatBond', BOND_TYPES, coder.decode(BOND_TYPES, bondArgs(ACCOUNTS.admin)));
    const moduleOf = (bond) => getCreateAddress({ from: bond, nonce: 1 }).slice(2).toLowerCase();
    const normalized = async (bond) => {
      const code = await codeAt(ctx.chain, bond);
      const module = moduleOf(bond);
      assert.ok(code.includes(module), `the bond's runtime embeds its own exit module ${module}`);
      return code.split(module).join('EXIT_MODULE');
    };
    assert.equal(await normalized(ev.args.deployed), await normalized(whole.address));
    // The module embeds its own address (`SELF`, phase C3: it refuses to act
    // outside the bond), and nothing else that differs between the two.
    const moduleCode = async (bond) => {
      const m = moduleOf(bond);
      return (await codeAt(ctx.chain, '0x' + m)).split(m).join('SELF');
    };
    assert.equal(await moduleCode(ev.args.deployed), await moduleCode(whole.address));
  });

  test('code whose hash is not the one named is refused, and nothing is created', async () => {
    const ctx = await fixture();
    await upload(ctx);
    const wrong = keccak256('0x00');
    await assert.rejects(
      () => ctx.deployer.send('deploy', [UPLOAD, wrong, bondArgs(ACCOUNTS.admin)]),
      /CodeHashMismatch/,
    );
    // The upload survives a refusal, so a corrected call does not re-send the pieces.
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.admin, UPLOAD]), BigInt(pieces(ctx.bytecode).length));
  });

  test('a piece out of order produces a different hash and is refused', async () => {
    const ctx = await fixture();
    const ps = pieces(ctx.bytecode);
    [ps[0], ps[1]] = [ps[1], ps[0]];
    for (const p of ps) await ctx.deployer.send('append', [UPLOAD, p]);
    await assert.rejects(
      () => ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]),
      /CodeHashMismatch/,
    );
  });

  test('an upload is cleared once it has been created, so it cannot be created twice', async () => {
    const ctx = await fixture();
    await upload(ctx);
    await ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]);
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.admin, UPLOAD]), 0n);
    await assert.rejects(
      () => ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]),
      /EmptyUpload/,
    );
  });

  test('a constructor that reverts creates nothing and keeps the upload for a retry', async () => {
    const ctx = await fixture();
    await upload(ctx);
    // A zero address among the arguments makes the bond's constructor revert.
    const bad = coder.encode(BOND_TYPES, [ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO]);
    await assert.rejects(() => ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bad]), /CreateFailed/);
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.admin, UPLOAD]), BigInt(pieces(ctx.bytecode).length));
  });
});

describe('nobody but the account that created it can use it (D19)', () => {
  test('the owner is the account that created the deployer, and nothing can change it', async () => {
    const ctx = await fixture();
    assert.equal((await ctx.deployer.call('owner')).toLowerCase(), ACCOUNTS.admin.toLowerCase());
    // The whole writable surface: the three owner-only calls. No setter, no hand-over.
    const writes = new Interface(artifact('ChunkedDeployer').abi).fragments
      .filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))
      .map((f) => f.name)
      .sort();
    assert.deepEqual(writes, ['append', 'clear', 'deploy']);
    // Another account's deployer is its own.
    const other = await ctx.chain.deploy('ChunkedDeployer', [], [], ACCOUNTS.mallory);
    assert.equal((await other.call('owner')).toLowerCase(), ACCOUNTS.mallory.toLowerCase());
    await assert.rejects(() => other.send('append', [UPLOAD, '0x00']), /NotOwner/);
  });

  test('another account can neither append, deploy nor clear, and the owner\'s upload is untouched', async () => {
    const ctx = await fixture();
    await upload(ctx);
    const n = BigInt(pieces(ctx.bytecode).length);
    await assert.rejects(() => ctx.deployer.send('append', [UPLOAD, '0xdeadbeef'], { from: ACCOUNTS.mallory }), /NotOwner/);
    await assert.rejects(
      () => ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.mallory)], { from: ACCOUNTS.mallory }),
      /NotOwner/,
    );
    await assert.rejects(() => ctx.deployer.send('clear', [UPLOAD], { from: ACCOUNTS.mallory }), /NotOwner/);
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.mallory, UPLOAD]), 0n);
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.admin, UPLOAD]), n);
    const res = await ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]);
    assert.equal(ctx.deployer.events(res, 'Deployed').length, 1);
  });

  test('a third party cannot shift the address of the owner\'s next contract', async () => {
    // The attack of D19: the deployer creates with CREATE, so each creation
    // advances its nonce and the next address moves. A stranger deploying any
    // code of its own through a shared deployer, between two of the owner's
    // creations, would move every address the owner's plan expected after it.
    const ctx = await fixture();
    const expected = getCreateAddress({ from: ctx.deployer.address, nonce: 1 });

    // Mallory tries with a small contract of its own, whole.
    const small = artifact('ChunkedDeployer').bytecode;
    const smallId = keccak256('0x' + Buffer.from('mallory').toString('hex'));
    await assert.rejects(() => ctx.deployer.send('append', [smallId, small], { from: ACCOUNTS.mallory }), /NotOwner/);
    await assert.rejects(() => ctx.deployer.send('deploy', [smallId, keccak256(small), '0x'], { from: ACCOUNTS.mallory }), /NotOwner/);

    await upload(ctx);
    const res = await ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]);
    const [ev] = ctx.deployer.events(res, 'Deployed');
    assert.equal(ev.args.deployed.toLowerCase(), expected.toLowerCase(), 'the first creation lands at nonce 1, as planned');

    // The owner's second creation lands at nonce 2, whatever anyone else tried in between.
    await assert.rejects(() => ctx.deployer.send('deploy', [smallId, keccak256(small), '0x'], { from: ACCOUNTS.mallory }), /NotOwner/);
    await ctx.deployer.send('append', [smallId, small]);
    const res2 = await ctx.deployer.send('deploy', [smallId, keccak256(small), '0x']);
    assert.equal(
      ctx.deployer.events(res2, 'Deployed')[0].args.deployed.toLowerCase(),
      getCreateAddress({ from: ctx.deployer.address, nonce: 2 }).toLowerCase(),
    );
  });

  test('the copy in contracts/core is byte-identical, source and interface', (t) => {
    const core = process.env.ARK_CORE_DIR || path.join(__dirname, '..', '..', '..', 'ecosystem', 'contracts');
    const pairs = [['contracts', 'ChunkedDeployer.hyp'], ['contracts', 'interfaces', 'IChunkedDeployer.hyp']];
    if (!fs.existsSync(path.join(core, ...pairs[0]))) return t.skip(`the ecosystem contracts are not checked out (${core}); set ARK_CORE_DIR`);
    for (const rel of pairs) {
      const ours = fs.readFileSync(path.join(__dirname, '..', ...rel));
      const theirs = fs.readFileSync(path.join(core, ...rel));
      assert.ok(ours.equals(theirs), `${rel.join('/')} differs between contracts/staking and contracts/core`);
    }
  });
});

describe('a contract deployed through it does not trust it', () => {
  test('the bond\'s wiring authority is the account named in its arguments, not the deployer contract', async () => {
    const ctx = await fixture();
    await upload(ctx);
    const res = await ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]);
    const [ev] = ctx.deployer.events(res, 'Deployed');
    const bond = ctx.chain.at('ArkCatBond', ev.args.deployed);

    // Had the bond taken `msg.sender`, the ChunkedDeployer would hold this right,
    // and it can make no call: the right would be lost to the deployer's owner.
    await assert.rejects(
      () => bond.send('setCourt', [ACCOUNTS.bob], { from: ACCOUNTS.mallory }),
      /OnlyDeployer/,
    );
    await bond.send('setCourt', [ACCOUNTS.bob], { from: ACCOUNTS.admin });
    assert.equal((await bond.call('court')).toLowerCase(), ACCOUNTS.bob.toLowerCase());
  });
});

describe('a poisoned upload can be discarded and sent again (D11)', () => {
  test('a piece landing twice poisons an upload; its owner clears it, and nobody else can', async () => {
    const ctx = await fixture();
    const ps = pieces(ctx.bytecode);
    // A retried append whose first attempt had mined after all.
    await ctx.deployer.send('append', [UPLOAD, ps[0]]);
    await ctx.deployer.send('append', [UPLOAD, ps[0]]);
    for (const p of ps.slice(1)) await ctx.deployer.send('append', [UPLOAD, p]);
    await assert.rejects(() => ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]), /CodeHashMismatch/);

    await assert.rejects(() => ctx.deployer.send('clear', [UPLOAD], { from: ACCOUNTS.mallory }), /NotOwner/);
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.admin, UPLOAD]), BigInt(ps.length + 1), 'another account clears nothing');

    const res = await ctx.deployer.send('clear', [UPLOAD]);
    assert.equal(ctx.deployer.events(res, 'Cleared')[0].args.pieces, BigInt(ps.length + 1));
    assert.equal(await ctx.deployer.call('piecesOf', [ACCOUNTS.admin, UPLOAD]), 0n);
    await upload(ctx);
    await ctx.deployer.send('deploy', [UPLOAD, ctx.codeHash, bondArgs(ACCOUNTS.admin)]);
  });

  test('each piece on chain can be checked by hash', async () => {
    const ctx = await fixture();
    await upload(ctx);
    const ps = pieces(ctx.bytecode);
    for (let i = 0; i < ps.length; i++) {
      assert.equal(await ctx.deployer.call('pieceHash', [ACCOUNTS.admin, UPLOAD, i]), keccak256(ps[i]));
    }
  });

  test('deployLarge verifies the pieces it would resume over, and clears a poisoned upload rather than failing', async () => {
    const { deployLarge, pieces: scriptPieces } = require('../scripts/lib/chunked');
    const { DEFAULT_BUILD } = require('./harness');
    const ctx = await fixture();
    const me = ACCOUNTS.admin;
    const client = {
      address: me,
      async call(to, abi, method, args = []) {
        const r = await ctx.chain.execute(to, me, abi.encodeFunctionData(method, args), 0n, true);
        return abi.decodeFunctionResult(method, r.returnValue);
      },
      async send(to, abi, method, args = []) {
        return ctx.chain.execute(to, me, abi.encodeFunctionData(method, args), 0n);
      },
      async deploy() {
        throw new Error('the bond does not fit one request');
      },
    };
    // The upload id deployLarge uses is the code hash; one wrong piece already sits under it.
    await ctx.deployer.send('append', [ctx.codeHash, scriptPieces(ctx.bytecode)[1]], { from: me });

    const a = (n) => '0x' + String(n).repeat(40);
    const lines = [];
    const deployed = await deployLarge(client, 'ArkCatBond', [a(1), a(2), a(3), a(4), a(5), me, SETTLEMENT], DEFAULT_BUILD, {
      chunked: ctx.deployer.address,
      log: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => /clearing the upload/.test(l)));
    const bond = ctx.chain.at('ArkCatBond', deployed);
    await bond.send('setCourt', [ACCOUNTS.bob], { from: me });
  });

  test('deployLarge refuses a deployer another account created, before sending a piece (D19)', async () => {
    const { deployLarge } = require('../scripts/lib/chunked');
    const { DEFAULT_BUILD } = require('./harness');
    const ctx = await fixture();
    const theirs = await ctx.chain.deploy('ChunkedDeployer', [], [], ACCOUNTS.mallory);
    const me = ACCOUNTS.admin;
    let sent = 0;
    const client = {
      address: me,
      async call(to, abi, method, args = []) {
        const r = await ctx.chain.execute(to, me, abi.encodeFunctionData(method, args), 0n, true);
        return abi.decodeFunctionResult(method, r.returnValue);
      },
      async send() {
        sent += 1;
        throw new Error('nothing should be sent');
      },
      async deploy() {
        throw new Error('the bond does not fit one request');
      },
    };
    const a = (n) => '0x' + String(n).repeat(40);
    await assert.rejects(
      () => deployLarge(client, 'ArkCatBond', [a(1), a(2), a(3), a(4), a(5), me, SETTLEMENT], DEFAULT_BUILD, { chunked: theirs.address }),
      /belongs to/,
    );
    assert.equal(sent, 0);
  });
});
