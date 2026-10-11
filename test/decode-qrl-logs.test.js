/**
 * The QIP-55 manual log decode, against hand-built fixture logs.
 *
 * Every fixture here is assembled from the ONE ALIGNMENT RULE documented at
 * decodeQrlLogs (scripts/lib/chains.js), which is itself verified against
 * infra/devnet's counter.js — the reference that decodes a live testnet-v3
 * log: a 64-byte QRVM slot is a 32-byte ABI slot scaled up, so fixed-size
 * bytesN is LEFT-aligned (topic0's 32-byte signature hash is the first 66
 * chars, `slice(0, 66)`), numerics are RIGHT-aligned (counter.js's
 * `BigInt(l.data)` reads the count straight out of a 128-hex word), and an
 * address is the full 64-byte slot.
 *
 * The fixtures' hashes come from ethers' keccak, not from the web3 sha3 the
 * decoder matches with, so agreement between the two implementations is part
 * of what passes.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('ethers');

const { decodeQrlLogs } = require('../scripts/lib/chains');

/** A 32-byte hash left-aligned in a 64-byte topic slot: hash first, zeros behind. */
const topic0 = (signature) => id(signature) + '0'.repeat(64);
/** A numeric value right-aligned in a 64-byte slot. */
const word = (v) => BigInt(v).toString(16).padStart(128, '0');

const QRL_ADDR = 'ab'.repeat(20) + 'cd'.repeat(44); // 64 bytes, first 20 distinct
const EVM_ADDR = '11'.repeat(20);
const HASH32 = 'fe'.repeat(32);

const EVENTS = {
  Changed: {
    signature: 'Changed(address,uint256)',
    topics: [{ name: 'by', type: 'address' }],
    data: [{ name: 'newCount', type: 'uint256' }],
  },
  Sealed: {
    signature: 'Sealed(bytes32,uint256,bool,address)',
    topics: [{ name: 'root', type: 'bytes32' }],
    data: [
      { name: 'epoch', type: 'uint256' },
      { name: 'final', type: 'bool' },
      { name: 'origin', type: 'evmAddress' },
    ],
  },
};

const log = (topics, data, extra = {}) => ({
  address: `0x${QRL_ADDR}`,
  topics,
  data: `0x${data}`,
  blockNumber: 7n,
  transactionHash: '0x' + '00'.repeat(32),
  logIndex: 0,
  ...extra,
});

describe('decodeQrlLogs (QIP-55, 64-byte slots)', () => {
  test('the counter.js shape: indexed address is the full slot, uint data is the whole word', () => {
    const [ev] = decodeQrlLogs(EVENTS, [log([topic0('Changed(address,uint256)'), `0x${QRL_ADDR}`], word(6))]);
    assert.equal(ev.name, 'Changed');
    assert.equal(ev.args.by, `Q${QRL_ADDR}`); // Q + all 128 hex, never truncated to 40
    assert.equal(ev.args.newCount, 6n);
  });

  test('topic0 matches on the high half only, exactly as counter.js slices it', () => {
    const t = topic0('Changed(address,uint256)');
    assert.equal(t.length, 2 + 128); // a topic slot is 64 bytes since QIP-55
    assert.equal(t.slice(66), '0'.repeat(64)); // hash left-aligned, zeros behind
    // Garbage in the low half must not defeat the match: only the first 66
    // chars carry the hash.
    const dirty = id('Changed(address,uint256)') + 'f'.repeat(64);
    const out = decodeQrlLogs(EVENTS, [log([dirty, `0x${QRL_ADDR}`], word(1))]);
    assert.equal(out.length, 1);
  });

  test('an indexed bytes32 is the topic slot`s HIGH half — the same alignment as topic0', () => {
    const [ev] = decodeQrlLogs(EVENTS, [
      log([topic0('Sealed(bytes32,uint256,bool,address)'), `0x${HASH32}${'00'.repeat(32)}`], word(3) + word(1) + '00'.repeat(44) + EVM_ADDR),
    ]);
    assert.equal(ev.args.root, `0x${HASH32}`);
  });

  test('data is consumed as consecutive 64-byte words: uint low, bool low, EVM address the low 20 bytes', () => {
    const [ev] = decodeQrlLogs(EVENTS, [
      log([topic0('Sealed(bytes32,uint256,bool,address)'), `0x${HASH32}${'00'.repeat(32)}`], word(42) + word(1) + '00'.repeat(44) + EVM_ADDR),
    ]);
    assert.equal(ev.args.epoch, 42n);
    assert.equal(ev.args.final, true);
    assert.equal(ev.args.origin, `0x${EVM_ADDR}`); // uint160 semantics: right-aligned
  });

  test('a log of an event the table does not name is dropped, like parseLogs', () => {
    const out = decodeQrlLogs(EVENTS, [log([topic0('Other(uint256)')], word(1))]);
    assert.deepEqual(out, []);
  });

  test('a 32-byte (pre-QIP-55) slot is refused, not misread', () => {
    // A 64-hex topic decoding "fine" would mean a v2 log silently produced a
    // half-width address; the width assumption is enforced instead.
    assert.throws(
      () => decodeQrlLogs(EVENTS, [log([topic0('Changed(address,uint256)'), `0x${'ab'.repeat(32)}`], word(1))]),
      /64 bytes/,
    );
  });

  test('the decoded log keeps its transport fields beside name and args', () => {
    const [ev] = decodeQrlLogs(EVENTS, [log([topic0('Changed(address,uint256)'), `0x${QRL_ADDR}`], word(2), { logIndex: 3 })]);
    assert.equal(ev.blockNumber, 7n);
    assert.equal(ev.logIndex, 3);
    assert.equal(ev.address, `0x${QRL_ADDR}`);
  });
});

describe('the hand-written event tables name the events the contracts emit', () => {
  // A table entry whose signature drifts from the contract's declaration stops
  // matching topic0 and the relayer silently drops the log — for the bond's
  // settlement (phase C3) that is a loss or recovery leaf never sealed. So
  // every signature, and every field's name, order and indexing, is held to
  // the ABI of the contract that emits it.
  const { QRL_EVENTS } = require('../scripts/lib/chains');
  const { artifact } = require('./harness');
  const { Interface } = require('ethers');
  const EMITTER = { ArkCatBond: 'ArkCatBondSettlement' };

  for (const [contract, table] of Object.entries(QRL_EVENTS)) {
    test(`${contract}: every entry is an event of the contract, field for field`, () => {
      const abi = new Interface(artifact(EMITTER[contract] || contract).abi);
      for (const [name, spec] of Object.entries(table)) {
        const ev = abi.getEvent(name);
        assert.ok(ev, `${contract} emits no ${name}`);
        assert.equal(ev.format('sighash'), spec.signature, `${contract}.${name}`);
        const indexed = ev.inputs.filter((i) => i.indexed).map((i) => i.name);
        const data = ev.inputs.filter((i) => !i.indexed).map((i) => i.name);
        assert.deepEqual((spec.topics || []).map((f) => f.name), indexed, `${contract}.${name} topics`);
        assert.deepEqual((spec.data || []).map((f) => f.name), data, `${contract}.${name} data`);
      }
    });
  }
});
