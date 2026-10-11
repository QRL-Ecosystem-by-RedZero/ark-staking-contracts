/**
 * The signer set of root admission and its authority chain, off chain
 * (lib/authority.js). Agreement with the relay itself is in
 * shared/test/relay.test.js, which admits roots these signers sign.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const auth = require('../lib/authority');
const ids = require('../lib/identifiers');
const wots = require('../lib/wots');

const seed = (i) => keccak256(toUtf8Bytes(`authority-test-${i}`));
const MESSAGE = keccak256(toUtf8Bytes('a root message'));

describe('the signer set of whitepaper §3.6', () => {
  test('a threshold is admissible exactly where n / 2 < k <= n, and the reference is two of three', () => {
    assert.deepEqual(auth.REFERENCE, { threshold: 2, signers: 3 });
    for (const [k, n, ok] of [[1, 1, true], [2, 3, true], [3, 3, true], [2, 2, true], [1, 2, false], [1, 3, false], [0, 1, false], [4, 3, false], [9, 16, true], [9, 17, false]]) {
      assert.equal(auth.thresholdAdmissible(k, n), ok, `k=${k} n=${n}`);
    }
    assert.throws(() => new auth.SignerSet({ seeds: [seed(0), seed(1)], threshold: 1, treeHeight: 2 }), /not admissible/);
  });

  test('k signatures from k distinct held signers, each verifying on its own tree at the shared index', () => {
    const set = new auth.SignerSet({ seeds: [seed(0), seed(1), seed(2)], threshold: 2, treeHeight: 3 });
    const sigs = set.sign(MESSAGE, 5);
    assert.deepEqual(sigs.map((s) => s.signer), [0, 1]);
    const roots = set.roots();
    for (const s of sigs) assert.ok(wots.verify(MESSAGE, s.ots, 5, s.authPath, roots[s.signer]));
    assert.deepEqual(auth.sigsArg(sigs)[0], [0, sigs[0].ots, sigs[0].authPath]);
  });

  test('a host holding fewer than k seeds signs nothing, and one holding k of n signs with those it holds', () => {
    const short = new auth.SignerSet({ seeds: [seed(0), null, null], threshold: 2, treeHeight: 2 });
    assert.equal(short.canSign(), false);
    assert.throws(() => short.sign(MESSAGE, 0), /holds 1 of the 3/);
    const enough = new auth.SignerSet({ seeds: [null, seed(1), seed(2)], threshold: 2, treeHeight: 2 });
    assert.deepEqual(enough.sign(MESSAGE, 0).map((s) => s.signer), [1, 2]);
    assert.deepEqual(enough.roots()[0], null);
  });

  test('each held signer refuses a second message at a leaf, and priming carries that across a restart', () => {
    const set = new auth.SignerSet({ seeds: [seed(0), seed(1), seed(2)], threshold: 2, treeHeight: 2 });
    set.sign(MESSAGE, 1);
    assert.throws(() => set.sign(keccak256(toUtf8Bytes('another')), 1), /already signed another message/);
    const restarted = new auth.SignerSet({ seeds: [seed(0), seed(1), seed(2)], threshold: 2, treeHeight: 2 });
    restarted.prime(1, MESSAGE);
    assert.throws(() => restarted.sign(keccak256(toUtf8Bytes('another')), 1), /already signed another message/);
    restarted.sign(MESSAGE, 1);
  });

  test('seeds come from <CHAIN>_OTS_SEED_<i>, the single-signer seed standing for signer 0', () => {
    const env = { HOODI_VPS_OTS_SEED: seed(9), HOODI_VPS_OTS_SEED_1: seed(1) };
    assert.deepEqual(auth.seedsFromEnv(env, 'hoodi-vps', 3), [seed(9), seed(1), null]);
    assert.deepEqual(auth.seedsFromEnv({ ...env, HOODI_VPS_OTS_SEED_0: seed(0) }, 'hoodi-vps', 1), [seed(0)]);
  });
});

describe('the authority chain of four generations (I35)', () => {
  test('generation 1 is the seed itself, so a relay of the single-signer build keeps its tree', () => {
    assert.equal(auth.generationSeed(seed(0), 1), seed(0));
    const later = [2, 3, 4].map((g) => auth.generationSeed(seed(0), g));
    assert.equal(new Set(later).size, 3);
    assert.throws(() => auth.generationSeed(seed(0), 5), /generation must be/);
    const g1 = new wots.WotsSigner(seed(0), 2).root;
    assert.equal(new auth.SignerSet({ seeds: [seed(0)], threshold: 1, treeHeight: 2 }).roots()[0], g1);
  });

  test('the chain is committed from every signer\'s seed, each link the next generation\'s roots and commitment', () => {
    const seeds = [seed(0), seed(1), seed(2)];
    const { generations, commits } = auth.authorityChain(seeds, 2);
    assert.equal(generations.length, 4);
    for (let g = 0; g < 4; g += 1) {
      assert.deepEqual(generations[g], new auth.SignerSet({ seeds, threshold: 2, treeHeight: 2, generation: g + 1 }).roots());
    }
    assert.equal(commits[3], ids.TERMINAL_COMMIT);
    for (let g = 0; g < 3; g += 1) assert.equal(commits[g], ids.chainLink(generations[g + 1], commits[g + 1]));
    assert.throws(() => auth.authorityChain([seed(0), null], 2), /every signer seed/);
  });
});
