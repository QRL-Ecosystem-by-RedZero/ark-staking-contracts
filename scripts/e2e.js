/**
 * Runs one cross-leg scenario against a live testnet deployment.
 *
 *   npm run e2e -- --chain rehearsal --scenario release-wave
 *   npm run e2e -- --chain hoodi --scenario happy-path --asset mUNIT --epochs 3
 *
 * Every scenario drives both legs through real epochs — 70 minutes each at the
 * testnet profile — and ticks the relayer itself (scripts/e2e/lib.js says why).
 * A report lands in reports/e2e/, naming every rule that held, every refusal
 * asserted, and what the scenario could not cover because the contract does not
 * exist yet.
 */
const fs = require('fs');
const path = require('path');

const { Ctx, Relayer } = require('./e2e/lib');

const SCENARIOS = path.join(__dirname, 'e2e', 'scenarios');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

function usage(message) {
  const names = fs.readdirSync(SCENARIOS).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
  console.error(`${message}\n\nusage: npm run e2e -- --chain <name> --scenario <${names.join('|')}>`);
  process.exit(1);
}

async function main() {
  const chain = flag('chain');
  const name = flag('scenario');
  if (!chain || !name) usage('both --chain and --scenario are required');
  const file = path.join(SCENARIOS, `${name}.js`);
  if (!fs.existsSync(file)) usage(`no scenario "${name}"`);
  const scenario = require(file);

  const relayer = await new Relayer({ chain, sealAt: Number(flag('seal-at', '0.5')) }).init();
  // A tick is a full scan and a few dozen calls. The enclave answers locally
  // and can be asked often; a public RPC rate-limits, so it is asked less.
  const ctx = new Ctx(relayer, name, { poll: flag('poll', relayer.origin.kind === 'evm' ? '30' : '15') });
  const opts = { asset: flag('asset'), epochs: flag('epochs'), notional: flag('notional'), positions: flag('positions'), quantity: flag('quantity') };

  console.log(`scenario ${name}: ${scenario.description}`);
  console.log(`chain    ${chain} (${relayer.manifest.client}), epoch ${await ctx.originEpoch()}, ${ctx.clock.EPOCH_LENGTH} s per epoch`);
  if (scenario.terminal) console.log('TERMINAL: this scenario closes the escrow permanently; redeploy both legs afterwards\n');
  else console.log('');

  let failure = null;
  try {
    await scenario.run(ctx, opts);
  } catch (e) {
    failure = e.stack || e.message;
    console.error(`\nFAILED: ${e.message}`);
  }
  // Every scenario ends with the read-only invariant checks, pass or fail: a
  // violation the scenario's own rules missed is still a finding.
  let invariants = null;
  try {
    const s = await ctx.invariants('end');
    invariants = { held: s.held, violated: s.violated.map((v) => v.id), known: s.known.map((v) => `${v.id}:${v.known}`), skipped: s.skipped };
    if (!failure && s.violated.length) failure = `invariants violated: ${invariants.violated.join(', ')}`;
  } catch (e) {
    invariants = { error: e.message };
  }
  // The relayer the scenario ended with: a restart replaces the one started
  // here, and the old one's state and lock are stale.
  const report = ctx.save({ outOfScope: scenario.outOfScope || [], failure, invariants, status: await ctx.r.status() });
  ctx.r.close();
  console.log(`\n${ctx.checks} rules asserted; report -> ${path.relative(path.join(__dirname, '..'), report)}`);
  if ((scenario.outOfScope || []).length) {
    console.log('out of scope here, and why:');
    for (const line of scenario.outOfScope) console.log(`   - ${line}`);
  }
  if (failure) process.exit(1);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
