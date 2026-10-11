/**
 * Return fields whose name is also an Array method cannot be read by name.
 *
 * A decoded call result is an array with the field names attached, and where a
 * name is already on Array.prototype the prototype wins: `claimants().at` is
 * the function Array.prototype.at, not the epoch. The relayer read it by name
 * and every keeper tick under a declaration threw (OC-OPS-02, audit
 * 2026-10-03). Such fields are read by position; this test names every one so
 * a new collision is seen before it ships, and checks the relayer reads the
 * known ones by position.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const RELAYER = path.join(__dirname, '..', 'ecdsa-stakings', 'relayer', 'engine', 'relayer.js');

/** Every known collision, as contract.function.field, and how it is read. */
const KNOWN = {
  'ArkCatBondRecovery.claimants.at': 'by position (index 1) in relayer.provePriorAnchors',
  'ArkBondDelegation.notedRoot.at': 'not read by name anywhere',
};

const ARRAY_NAMES = new Set(Object.getOwnPropertyNames(Array.prototype));

function collisions() {
  const found = [];
  const walk = (params, where) => {
    for (const p of params || []) {
      if (p.name && ARRAY_NAMES.has(p.name)) found.push(`${where}.${p.name}`);
      walk(p.components, where);
    }
  };
  for (const file of fs.readdirSync(BUILD).filter((f) => f.endsWith('.json'))) {
    const art = JSON.parse(fs.readFileSync(path.join(BUILD, file), 'utf8'));
    const contract = file.replace(/\.json$/, '');
    for (const item of art.abi || []) if (item.type === 'function') walk(item.outputs, `${contract}.${item.name}`);
  }
  return [...new Set(found)].sort();
}

test('every return field named like an Array method is known and read by position', () => {
  const unknown = collisions().filter((c) => !(c in KNOWN));
  assert.deepEqual(unknown, [], `new fields shadowed by Array.prototype; read them by position and list them in KNOWN: ${unknown.join(', ')}`);
});

test('the relayer never reads a shadowed field by name', () => {
  // Code only: the comment explaining the positional read names the method itself.
  const source = fs.readFileSync(RELAYER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const fields = [...new Set(Object.keys(KNOWN).map((k) => k.split('.').pop()))];
  for (const field of fields) {
    // A property read such as `c.at` or `root.at)`; `.at(` is a real Array.prototype.at call and is allowed.
    const byName = new RegExp(`\\b\\w+\\.${field}\\b(?!\\s*\\()`, 'g');
    assert.deepEqual(source.match(byName) || [], [], `relayer.js reads .${field} by name`);
  }
});
