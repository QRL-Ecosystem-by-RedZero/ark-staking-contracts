/**
 * OC-V3-02 (2026-10-07): a public mapping's auto-getter misreads its key on
 * QRVM (QIP-55, 512-bit words).
 *
 * hypc's legacy codegen stores each getter key with `storeInMemory(0)`, which
 * cleans it as a uint256 (`and(key, 2^256 - 1)`) before hashing. A 64-byte
 * address loses its high 32 bytes, a bytesN (left-aligned in the word) becomes
 * zero and a negative intN loses its sign extension, so the getter hashes a
 * different slot from the one the contract writes and answers zero (bytes32:
 * the entry of key zero). Internal reads and hand-written views are right. The
 * v2 harness cannot see it: on a 256-bit word that cleanup is the identity.
 * Found live on the devnet (core's ArkMultisig `isOwner` false for every
 * owner); here it made `ArkStakeCourt` read `ArkJurorPool.seatRound` as zero
 * for every drawn juror, so no juror could vote on a v3 chain.
 *
 * The rule: no public mapping takes a key, at any level, other than an
 * unsigned integer, bool, string or bytes; anything else is private behind an
 * explicit view of the same name and signature. This test holds the sources
 * to it and the ABI of every converted getter to its old signature.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');

/** Key types a QRVM getter hashes correctly: all fit the low 256 bits of the word unchanged. */
const SAFE_KEY = /^(uint\d*|bool|string|bytes)$/;

function hypFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...hypFiles(p));
    else if (e.name.endsWith('.hyp')) out.push(p);
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** The key types of `mapping(K => mapping(K2 => V))`, outermost first. */
function keyTypes(type) {
  const keys = [];
  let t = type.trim();
  while (t.startsWith('mapping')) {
    const open = t.indexOf('(');
    const close = t.lastIndexOf(')');
    const inner = t.slice(open + 1, close);
    const arrow = inner.indexOf('=>');
    keys.push(inner.slice(0, arrow).trim().split(/\s+/)[0]);
    t = inner.slice(arrow + 2).trim();
  }
  return keys;
}

/** Every public or external mapping declaration in `src` whose key at some level is not SAFE_KEY. */
function unsafeGetters(src) {
  const code = stripComments(src);
  const found = [];
  const re = /\bmapping\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    const type = code.slice(m.index, i + 1);
    const tail = code.slice(i + 1, code.indexOf(';', i));
    re.lastIndex = i + 1;
    if (!/\b(public|external)\b/.test(tail) || /[({]/.test(tail)) continue;
    const bad = keyTypes(type).filter((k) => !SAFE_KEY.test(k));
    if (bad.length) found.push({ name: tail.replace(/\b(public|external|override|immutable)\b/g, '').trim(), keys: bad });
  }
  return found;
}

describe('OC-V3-02: no public getter keyed by a type QRVM misreads', () => {
  test('the scanner flags the old patterns and passes the safe ones', () => {
    const old = `
      contract X {
        mapping(address => bool) public isOwner;
        mapping(uint256 => mapping(address => bool)) public approved;
        mapping(bytes32 => uint256) public courtProposalOf;
        mapping(int256 => uint256) public signedKey;
        // mapping(address => bool) public commentedOut;
        mapping(address => bool) private _isOwner;
        mapping(uint256 => address) public ownerAt;
        mapping(uint8 => mapping(uint256 => bool)) public done;
        mapping(string => uint256) public byName;
        function f(mapping(address => uint256) storage m) internal {}
      }`;
    assert.deepEqual(
      unsafeGetters(old).map((g) => `${g.name}:${g.keys.join(',')}`),
      ['isOwner:address', 'approved:address', 'courtProposalOf:bytes32', 'signedKey:int256'],
    );
  });

  test('no contract in contracts/ declares one', () => {
    const offenders = [];
    for (const file of hypFiles(CONTRACTS)) {
      for (const g of unsafeGetters(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(ROOT, file)}: ${g.name} (key ${g.keys.join(', ')})`);
      }
    }
    assert.deepEqual(offenders, [], 'make the mapping private and add an explicit view with the same signature');
  });
});

/** The converted getters, as their old auto-getter signature: name(inputs) -> outputs. */
const SWAP = [
  'failedOfferings(bytes32)->uint256',
  'retainedShares(bytes32)->uint256',
  'retainedUnits(bytes32)->uint256',
  'carryShares(bytes32)->uint256',
  'shortfallCarry(bytes32)->uint256',
];
const CONVERTED = {
  ArkBondDelegation: ['exitDeadlineEpoch(bytes32)->uint64', 'fundedEpoch(bytes32)->uint64'],
  ArkJurorPool: ['seatRound(bytes32,address)->uint8'],
  ArkReferenceOracle: ['isReporter(address)->bool'],
  ArkStakeCourt: ['owed(address)->uint256'],
  PremiumSwap: SWAP,
  PremiumSwapJudge: SWAP,
};

describe('OC-V3-02: the explicit views keep the getters ABI', () => {
  for (const dir of ['build', 'build-qrvm']) {
    test(`${dir}/: every converted getter has its old signature, view, and no other overload`, (t) => {
      if (!fs.existsSync(path.join(ROOT, dir, 'ArkJurorPool.json'))) return t.skip(`no ${dir}/ artifacts`);
      for (const [contract, sigs] of Object.entries(CONVERTED)) {
        const file = path.join(ROOT, dir, `${contract}.json`);
        assert.ok(fs.existsSync(file), `${contract} missing from ${dir}/`);
        const { abi } = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const sig of sigs) {
          const name = sig.slice(0, sig.indexOf('('));
          const fns = abi.filter((e) => e.type === 'function' && e.name === name);
          assert.equal(fns.length, 1, `${contract}.${name}: one function`);
          const [fn] = fns;
          const got = `${name}(${fn.inputs.map((i) => i.type).join(',')})->${fn.outputs.map((o) => o.type).join(',')}`;
          assert.equal(got, sig, `${contract}.${name}`);
          assert.equal(fn.stateMutability, 'view', `${contract}.${name} is a view`);
        }
      }
    });
  }
});
