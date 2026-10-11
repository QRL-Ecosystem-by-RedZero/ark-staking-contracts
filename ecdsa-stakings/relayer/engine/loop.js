/**
 * The relayer's run loop, apart from the command so it can be tested.
 *
 * The one rule this module exists to enforce: **the state lock is never let
 * go while this process is alive.** A redeploy of the QRL leg (R40) happens
 * with the lock held, and the relayer is rebuilt over the lock it already
 * holds (the lock is re-entrant within a process). If the redeploy fails the
 * loop does not carry on: it throws, the process exits non-zero, the exit
 * handler releases the lock, and systemd starts a clean process. The earlier
 * loop released the lock before the redeploy and kept ticking after a failed
 * one with a relayer that held no lock — which is the window in which a second
 * process could take the state and sign beside it.
 *
 * Only a leg `regenerated` — same chain id, different genesis — is redeployed.
 * A node behind the deployment, an RPC on another chain, or a chain with no
 * block yet is reported and waited out, and no tick runs until the leg is back.
 */
async function runLoop({ start, redeploy = null, interval = 60_000, once = false, sealNow = false, log = console.log, error = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let relayer = await start();
  for (;;) {
    let leg = null;
    try {
      leg = await relayer.qrlLegState();
    } catch (e) {
      error(`qrl leg  unreachable: ${e.message}`);
    }
    if (leg && leg.state === 'regenerated') {
      if (!redeploy) {
        error(`qrl leg  ${leg.reason}; run deploy:testnet, or start the relayer with --redeploy-qrl`);
      } else {
        log(`qrl leg  ${leg.reason}; redeploying with the state lock held`);
        // Throws on failure, and nothing here catches it.
        await redeploy();
        // The new deployment file carries a new `deployedAt`, which is what
        // makes `init` reset the QRL side of the state.
        relayer = await start();
      }
    } else if (leg && leg.state !== 'present') {
      error(`qrl leg  ${leg.state}: ${leg.reason}; waiting`);
    } else if (leg) {
      try {
        await relayer.tick({ sealNow });
      } catch (e) {
        // Two writers on one state is not a bad tick; it is the one failure
        // the next tick would make worse.
        if (e.name === 'StateConflictError') throw e;
        error(`tick failed: ${e.stack || e.message}`);
      }
    }
    if (once) break;
    await sleep(interval);
  }
  relayer.close();
  return relayer;
}

module.exports = { runLoop };
