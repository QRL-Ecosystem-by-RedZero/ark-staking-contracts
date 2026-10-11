/**
 * Names a revert, from any client, against every custom error both builds
 * declare. The same decoder scripts/deploy.js carries, generalised over build
 * directories so the testnet artifacts are the ones read.
 *
 * Keyed by signature, not by name: `StillUnbonding` is declared in two
 * contracts with different arguments, and deduplicating by name decodes one of
 * them as a bare revert (CLAUDE.md §9, 2026-09-03).
 */
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

function errorInterface(buildDirs) {
  const frags = new Map();
  for (const dir of buildDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const abi = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).abi || [];
      for (const item of abi) {
        if (item.type === 'error') frags.set(`${item.name}(${item.inputs.map((i) => i.type).join(',')})`, item);
      }
    }
  }
  return new Interface([...frags.values()]);
}

function revertName(errors, e) {
  const candidates = [e?.data, e?.info?.error?.data, e?.cause?.data, e?.innerError?.data, e?.error?.data, e?.cause?.cause?.data];
  for (const c of candidates) {
    const data = typeof c === 'string' ? c : c?.data;
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        const parsed = errors.parseError(data);
        return parsed.name === 'Error' ? String(parsed.args[0]) : parsed.name;
      } catch {
        /* not one of ours */
      }
    }
  }
  const m = /0x[0-9a-fA-F]{8,}/.exec(String(e?.message || ''));
  if (m) {
    try {
      return errors.parseError(m[0]).name;
    } catch {
      /* fall through */
    }
  }
  return String(e?.shortMessage || e?.message || e);
}

module.exports = { errorInterface, revertName };
