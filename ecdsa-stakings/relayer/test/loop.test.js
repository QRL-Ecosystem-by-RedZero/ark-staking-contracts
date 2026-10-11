/**
 * The run loop (engine/loop.js). The rule under test: the state lock is held
 * for the life of the process — through a QRL redeploy, and past a failed one,
 * which ends the process instead of leaving a relayer running with no lock.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runLoop } = require('../engine/loop');
const { RelayerState } = require('../engine/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ark-relayer-loop-'));

/** A relayer whose QRL leg reads `legs` in turn, holding a real lock on `dir`. */
function fakeRelayer(dir, legs, calls) {
  const state = new RelayerState(dir);
  const unlock = state.lock();
  return {
    state,
    async qrlLegState() {
      return legs.length ? legs.shift() : { state: 'present' };
    },
    async tick() {
      calls.push('tick');
    },
    close() {
      calls.push('close');
      unlock();
    },
  };
}

const quiet = { log: () => {}, error: () => {}, sleep: async () => {} };

describe('the run loop', () => {
  test('a failed redeploy ends the loop with the lock still held, and nothing ticks after it', async () => {
    const dir = tmp();
    const calls = [];
    let lockDuringRedeploy = null;
    await assert.rejects(
      runLoop({
        ...quiet,
        start: async () => fakeRelayer(dir, [{ state: 'regenerated', reason: 'new genesis' }], calls),
        redeploy: async () => {
          lockDuringRedeploy = RelayerState.lockHolder(dir);
          throw new Error('deployer not funded on the fresh chain');
        },
        once: true,
      }),
      /not funded/,
    );
    assert.equal(lockDuringRedeploy, process.pid, 'the lock is held while the leg is redeployed');
    assert.ok(!calls.includes('close'), 'the relayer was not closed, so the lock was never let go in-process');
    assert.ok(!calls.includes('tick'), 'no tick ran with a leg that failed to deploy');
    assert.equal(RelayerState.lockHolder(dir), process.pid, 'released only when the process exits');
  });

  test('a successful redeploy rebuilds the relayer over the lock it already holds', async () => {
    const dir = tmp();
    const calls = [];
    let starts = 0;
    await runLoop({
      ...quiet,
      start: async () => {
        starts += 1;
        return fakeRelayer(dir, starts === 1 ? [{ state: 'regenerated', reason: 'new genesis' }] : [], calls);
      },
      redeploy: async () => calls.push('redeploy'),
      once: false,
      sleep: async () => {
        if (calls.includes('tick')) throw new Error('stop');
      },
    }).catch((e) => assert.equal(e.message, 'stop'));
    assert.equal(starts, 2);
    assert.deepEqual(calls, ['redeploy', 'tick']);
  });

  test('a node behind, or an RPC on another chain, is waited out: no redeploy, no tick', async () => {
    for (const state of ['lagging', 'foreign', 'waiting']) {
      const calls = [];
      await runLoop({
        ...quiet,
        start: async () => fakeRelayer(tmp(), [{ state, reason: state }], calls),
        redeploy: async () => calls.push('redeploy'),
        once: true,
      });
      assert.deepEqual(calls, ['close'], state);
    }
  });

  test('two writers on one state stop the loop rather than tick again', async () => {
    const calls = [];
    const conflict = Object.assign(new Error('two writers'), { name: 'StateConflictError' });
    await assert.rejects(
      runLoop({
        ...quiet,
        start: async () => ({ ...fakeRelayer(tmp(), [], calls), tick: async () => { throw conflict; } }),
        once: true,
      }),
      /two writers/,
    );
  });
});
