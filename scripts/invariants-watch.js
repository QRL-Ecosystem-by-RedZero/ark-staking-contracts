/**
 * Runs the read-only invariant checks of scripts/e2e/invariants.js against a
 * live deployment, once or on a period, beside a running relayer.
 *
 *   npm run invariants -- --chain hoodi-vps                 one pass
 *   npm run invariants -- --chain hoodi-vps --watch 600     every 10 minutes
 *
 * It opens the relayer read-only, as `relay:status` does: no lock is taken,
 * nothing is sent and the relayer's state is never written. Each pass is
 * appended as one JSON line to reports/invariants/<chain>.jsonl. A violation no
 * open finding predicts is printed as VIOLATED, and `--strict` then exits 1
 * (a one-shot pass only).
 */
const fs = require('fs');
const path = require('path');

const { Ctx, Relayer } = require('./e2e/lib');
const { checkInvariants } = require('./e2e/invariants');
const { replacer } = require('../ecdsa-stakings/relayer/engine/state');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

async function pass(relayer, chain, out) {
  const ctx = new Ctx(relayer, 'invariants-watch', {});
  ctx.log = (line) => console.log(`${new Date().toISOString()} ${line.trim()}`);
  const summary = await checkInvariants(ctx, { tag: chain });
  const head = await relayer.qrl.head();
  const line = {
    at: new Date().toISOString(),
    chain,
    qrlBlock: head.latest,
    epoch: relayer.clock.epochOf(head.timestamp),
    held: summary.held,
    violated: summary.violated,
    known: summary.known.map((k) => ({ id: k.id, known: k.known })),
    skipped: summary.skipped,
  };
  fs.appendFileSync(out, JSON.stringify(line, replacer) + '\n');
  return summary;
}

async function main() {
  const chain = flag('chain');
  if (!chain) {
    console.error('usage: npm run invariants -- --chain <name> [--watch <seconds>] [--strict]');
    process.exit(1);
  }
  const period = flag('watch') === null ? null : Number(flag('watch'));
  const relayer = await new Relayer({ chain }).init({ lock: false, readOnly: true });
  const dir = path.join(__dirname, '..', 'reports', 'invariants');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${chain}.jsonl`);

  if (period === null) {
    const s = await pass(relayer, chain, out);
    process.exit(has('strict') && s.violated.length ? 1 : 0);
  }
  if (!(period >= 30)) throw new Error('--watch takes a period of at least 30 seconds');
  console.log(`watching ${chain} every ${period} s; passes -> ${path.relative(process.cwd(), out)}`);
  for (;;) {
    try {
      await pass(relayer, chain, out);
    } catch (e) {
      // An RPC that drops for a pass is a gap in the record, not a violation.
      console.error(`${new Date().toISOString()} pass failed: ${e.shortMessage || e.message}`);
      fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), chain, error: String(e.shortMessage || e.message).slice(0, 300) }) + '\n');
    }
    await new Promise((r) => setTimeout(r, period * 1000));
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
