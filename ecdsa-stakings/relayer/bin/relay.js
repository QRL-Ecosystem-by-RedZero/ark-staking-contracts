#!/usr/bin/env node
/**
 * The relayer, as a command.
 *
 *   npm run relay -- --chain hoodi                 run, one tick a minute
 *   npm run relay -- --chain hoodi --once          one tick, then exit
 *   npm run relay -- --chain hoodi --redeploy-qrl  also redeploy the QRL leg when its devnet is regenerated
 *   npm run relay -- --chain hoodi --adopt-state   sign from a state that does not cover the relay's history (see below)
 *   npm run relay:status -- --chain hoodi          what both legs hold now
 *   npm run relay -- seal <kind> --chain hoodi ... a stand-in leaf, see below
 *
 * Stand-in leaves (engine/relayer.js `enqueue`), for procedures not written:
 *
 *   seal loss     --stake-asset-id ID --destination D --quantity Q [--determination-id X]
 *   seal recovery --asset A --destination D --quantity Q [--recipient R] [--recovery-id X] [--successor-id S]
 *   seal close    [--asset A]                   one escrow, or every escrow of the chain
 *   seal freeze   --frozen true|false [--asset A]
 *   seal delist   --asset A
 *   seal cancel-extension                       void the scheduled generation of the authority chain
 *
 * Every leaf binds the escrow it acts on (D10): a closure or a freeze without
 * --asset is one leaf per escrow. A recovery share names the admitted successor
 * state it is paid on (I36; zero, the default, is the origin chain itself).
 * `cancel-extension` is not a leaf: the relayer signs a CANCEL_DOMAIN message
 * with k signers at the next index, while the extension's six-epoch delay runs
 *
 * `seal` writes to the running relayer's inbox and returns; it never touches
 * the state file another process owns. Quantities are in base units.
 *
 * Since 2026-09-27 (audit D3) the file is an envelope signed with the
 * operator key `RELAYER_INBOX_KEY` from .env — a secp256k1 key of its own, not
 * the one-time seed — and the relayer ingests it only where the signer is in
 * `RELAYER_INBOX_SIGNERS` (or `<CHAIN>_INBOX_SIGNERS`) on ITS host. Every
 * decision is appended to `.relayer/<chain>/inbox-audit.log` (lib/inbox.js).
 *
 * `--redeploy-qrl` is for a QRL leg on a devnet that regenerates from genesis
 * (R40): when the registry the deployment names has no code on a chain with the
 * deployment's chain id and a different genesis, the relayer
 * deploys the QRL leg again with `deployQrlLeg`, the function deploy:testnet
 * runs, before it sends anything else from the account, and then resets its
 * QRL-side state to the new leg. Without the flag it only says so and waits. The
 * state lock is held throughout, and a failed redeploy exits non-zero
 * (engine/loop.js).
 *
 * Since 2026-09-28 the redeploy is the whole QRL side, in order: contracts/
 * core's governance stack first, where the manifest's `governance.selfDeploy`
 * asks for it and no record live on THIS genesis exists (scripts/lib/
 * governance.js: genesis hash, code, and a probe of the wiring), from the
 * artifacts vendored under vendor/core-governance/; then every role account
 * the fresh genesis did not fund is topped up from the deployer (the sealer,
 * the price double's operator, the multisig owners, the Q-Day attesters: gas,
 * and each attester's bond); then the QRL leg, wired to that stack. Before the
 * loop starts, the same flag also deploys the leg where there is no deployment
 * record or the record is wired to a relay the manifest no longer names (a new
 * origin leg), and moves aside a relayer state kept for another relay — safe,
 * because a state that does not cover the relay's consumed leaves refuses to
 * sign (`assertCovers`). And on a leg that is live on its genesis, it tops
 * up the reference solver's QRL (`SOLVER_ADDRESS`) where it holds less than
 * half of `SOLVER_QRL_FUNDING` (engine/redeploy.js `topUpSolver`, 2026-09-29);
 * the redeploy funds it in full at each fresh genesis.
 *
 * `run` refuses to sign in two cases. On a host other than the one
 * `<CHAIN>_RELAYER_HOST` names in .env: the seed may sit on two hosts, and each
 * would start from its own state. And from a state with no admitted record of
 * the relay's last consumed leaf: a restored backup, or a second host, cannot
 * know what the next leaf already signed. `--adopt-state` overrides the second,
 * once, for an operator who has made sure no other signer exists.
 */
const crypto = require('crypto');
const path = require('path');

const { Relayer } = require('../engine/relayer');
const { runLoop } = require('../engine/loop');
const { RelayerState, replacer } = require('../engine/state');
const manifestLib = require('../lib/manifest');
const { signEnvelope } = require('../lib/inbox');

const ROOT = path.join(__dirname, '..', '..', '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const random32 = () => '0x' + crypto.randomBytes(32).toString('hex');

function required(name) {
  const v = flag(name);
  if (v === null) throw new Error(`--${name} is required`);
  return v;
}

function sealEntry(kind) {
  switch (kind) {
    case 'loss':
      // The asset says which escrow pays; without it the relayer looks the
      // position up among the anchors it has seen, which it may not have.
      return { kind, stakeAssetId: required('stake-asset-id'), asset: flag('asset'), destination: required('destination'), quantity: BigInt(required('quantity')), determinationId: flag('determination-id', random32()) };
    case 'recovery':
      return { kind, asset: required('asset'), destination: required('destination'), quantity: BigInt(required('quantity')), recipient: flag('recipient', random32()), recoveryId: flag('recovery-id', random32()), successorId: flag('successor-id', '0x' + '00'.repeat(32)) };
    case 'close':
      return flag('asset') ? { kind, asset: flag('asset') } : { kind };
    case 'freeze':
      return flag('asset') ? { kind, frozen: required('frozen') === 'true', asset: flag('asset') } : { kind, frozen: required('frozen') === 'true' };
    case 'cancel-extension':
      return { kind };
    case 'delist':
      return { kind, asset: required('asset') };
    default:
      throw new Error(`unknown seal kind "${kind}"; one of loss, recovery, close, freeze, delist, cancel-extension (the premium is sold by PremiumSwap, not sealed by hand)`);
  }
}

async function main() {
  const chain = required('chain');
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';

  if (cmd === 'seal') {
    const entry = sealEntry(argv[1]);
    const { loadEnv } = require('../../../scripts/qrl');
    const env = loadEnv();
    const upper = chain.toUpperCase().replace(/-/g, '_');
    const seeds = Object.entries(env).filter(([k]) => k === `${upper}_OTS_SEED` || k.startsWith(`${upper}_OTS_SEED_`)).map(([, v]) => v);
    const envelope = await signEnvelope({ chain, entry, privateKey: env.RELAYER_INBOX_KEY, otsSeed: seeds });
    const name = RelayerState.post(path.join(ROOT, '.relayer', chain), envelope);
    console.log(`queued ${entry.kind} for the ${chain} relayer (inbox/${name}), signed by ${envelope.signer}; it is sealed into the next root once that signer is allowlisted there`);
    return;
  }

  const make = () => new Relayer({ chain, sealAt: Number(flag('seal-at', '0.5')), adoptState: has('adopt-state') });
  if (cmd === 'status') {
    // Read-only: a status that saved what it read would write it back over a
    // record the running relayer made in between.
    const relayer = await make().init({ lock: false, readOnly: true });
    console.log(JSON.stringify(await relayer.status(), replacer, 2));
    return;
  }
  if (cmd !== 'run') throw new Error(`unknown command "${cmd}"; run, status or seal`);

  if (has('redeploy-qrl')) await preflight(chain);
  await runLoop({
    start: () => make().init({ lock: true }),
    redeploy: has('redeploy-qrl') ? () => redeployQrl(chain) : null,
    interval: Number(flag('interval', '60')) * 1000,
    once: has('once'),
    sealNow: has('seal-now'),
  });
}

/**
 * Before the loop, with --redeploy-qrl: a leg to run against
 * (engine/redeploy.js `preflightReason`). A chain that has produced no block
 * cannot take a deployment, so it is waited for rather than spending one of
 * the bounded attempts on it.
 */
async function preflight(chain) {
  const { preflightReason, topUpSolver } = require('../engine/redeploy');
  const reason = preflightReason({ chain });
  if (!reason) {
    // The reference solver's working capital on a live leg (SOLVER_ADDRESS):
    // a first install mid-genesis. Never fatal, never on a regenerated chain.
    try {
      const { qrlClient } = require('../../../scripts/lib/chains');
      await topUpSolver({ client: qrlClient(), chain });
    } catch (e) {
      console.error(`funding  the reference solver was not topped up: ${e.message}`);
    }
    return;
  }
  const { qrlClient } = require('../../../scripts/lib/chains');
  const client = qrlClient();
  for (;;) {
    try {
      if ((await client.head()).latest >= 1n) break;
      console.error('qrl leg  the QRL chain has produced no block yet; waiting');
    } catch (e) {
      console.error(`qrl leg  unreachable: ${e.message}; waiting`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log(`qrl leg  ${reason}; deploying the QRL side before the relayer starts`);
  await redeployQrl(chain);
}

/**
 * The QRL side again, on a chain that lost it: governance, the role accounts,
 * the leg (engine/redeploy.js). Required here rather than at the top so
 * `status` and `seal` do not load the deployment code.
 */
async function redeployQrl(chain) {
  const { qrlClient } = require('../../../scripts/lib/chains');
  const { redeployQrlSide } = require('../engine/redeploy');
  await redeployQrlSide({ client: qrlClient(), chain });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  },
);
