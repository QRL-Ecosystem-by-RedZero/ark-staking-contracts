/**
 * The test doubles `deployQrlLeg` puts on the time-compressed devnets.
 *
 * The one rule this file exists to defend: **a double on a shared devnet moves
 * only at its one account's word, and an attested root is written once**
 * (audit 2026-09-27, D2 and D7). Before that, anyone reaching the VPS devnet's
 * RPC could `declare()` — which the relayer turned into a terminal `close` leaf
 * on the Hoodi escrow — or set a price of zero and take the premium pot, and a
 * root overwritten for a past epoch admitted new leaves into it.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');

const { Chain, ACCOUNTS } = require('./harness');

const ROOT_A = keccak256(toUtf8Bytes('root a'));
const ROOT_B = keccak256(toUtf8Bytes('root b'));
const ZERO = '0x' + '00'.repeat(20);

async function doubles() {
  const chain = await Chain.create();
  return {
    chain,
    attest: await chain.deploy('MockAttestation'),
    qday: await chain.deploy('MockQDayOracle'),
    oracle: await chain.deploy('MockPriceOracle'),
  };
}

describe('the Q-Day oracle and the price oracle move at their operator\'s word only (D2)', () => {
  test('declare and the freeze are the operator\'s: a stranger cannot close the escrow through the relayer', async () => {
    const { qday } = await doubles();
    await assert.rejects(() => qday.send('declare', [1n], { from: ACCOUNTS.mallory }), /NotOperator/);
    await assert.rejects(() => qday.send('setFrozen', [true], { from: ACCOUNTS.mallory }), /NotOperator/);
    assert.equal(await qday.call('declared'), false);
    await qday.send('setFrozen', [true], { from: ACCOUNTS.admin });
    await qday.send('declare', [7n], { from: ACCOUNTS.admin });
    assert.equal(await qday.call('declared'), true);
  });

  test('every price, yield, drawdown and outage setter is the operator\'s', async () => {
    const { oracle } = await doubles();
    const m = { from: ACCOUNTS.mallory };
    await assert.rejects(() => oracle.send('set', [1n, 1n, 1n], m), /NotOperator/);
    await assert.rejects(() => oracle.send('setYield', [0n, ZERO, 0n], m), /NotOperator/);
    await assert.rejects(() => oracle.send('setDrawdown', [86400n, 5000n], m), /NotOperator/);
    await assert.rejects(() => oracle.send('setReverting', [true], m), /NotOperator/);
    await oracle.send('set', [5n, 5n, 5n], { from: ACCOUNTS.admin });
    await oracle.send('setReverting', [true], { from: ACCOUNTS.admin });
    await assert.rejects(() => oracle.call('observe', [0n, ZERO]), /OracleUnavailable/);
  });

  test('the operator is handed on by the operator alone, and never to zero', async () => {
    const { oracle } = await doubles();
    await assert.rejects(() => oracle.send('transferOperator', [ACCOUNTS.mallory], { from: ACCOUNTS.mallory }), /NotOperator/);
    await assert.rejects(() => oracle.send('transferOperator', [ZERO], { from: ACCOUNTS.admin }), /NotOperator/);
    await oracle.send('transferOperator', [ACCOUNTS.oracle], { from: ACCOUNTS.admin });
    await assert.rejects(() => oracle.send('set', [1n, 1n, 1n], { from: ACCOUNTS.admin }), /NotOperator/);
    await oracle.send('set', [1n, 1n, 1n], { from: ACCOUNTS.oracle });
  });
});

describe('an attested root is written once, by the sealer (D2, D7)', () => {
  test('only the sealer seals, and the sealer can be an account other than the deployer', async () => {
    const { attest } = await doubles();
    await assert.rejects(() => attest.send('seal', [1n, ROOT_A], { from: ACCOUNTS.mallory }), /NotSealer/);
    await attest.send('transferSealer', [ACCOUNTS.attester], { from: ACCOUNTS.admin });
    await assert.rejects(() => attest.send('seal', [1n, ROOT_A], { from: ACCOUNTS.admin }), /NotSealer/);
    await attest.send('seal', [1n, ROOT_A], { from: ACCOUNTS.attester });
    assert.equal(await attest.call('rootOf', [1n]), ROOT_A);
  });

  test('a sealed epoch refuses another root, so no new leaf enters a past epoch', async () => {
    const { attest } = await doubles();
    await attest.send('seal', [4n, ROOT_A]);
    await assert.rejects(() => attest.send('seal', [4n, ROOT_B]), /EpochAlreadySealed/);
    assert.equal(await attest.call('rootOf', [4n]), ROOT_A);
    // The same root again is a no-op, so a sealer that lost its receipt can retry.
    await attest.send('seal', [4n, ROOT_A]);
    await attest.send('seal', [5n, ROOT_B]);
  });

  test('the overwriting double is a separate, test-only contract the deployment never names', async () => {
    const chain = await Chain.create();
    const resealable = await chain.deploy('MockAttestationResealable');
    await resealable.send('seal', [4n, ROOT_A]);
    await resealable.send('seal', [4n, ROOT_B]);
    assert.equal(await resealable.call('rootOf', [4n]), ROOT_B);
    await assert.rejects(() => resealable.send('seal', [4n, ROOT_A], { from: ACCOUNTS.mallory }), /NotSealer/);
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'scripts', 'lib', 'deploy.js'), 'utf8');
    assert.ok(!src.includes('MockAttestationResealable'), 'scripts/lib/deploy.js deploys only the write-once double');
  });
});
