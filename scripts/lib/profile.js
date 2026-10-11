/**
 * Build profiles, and the one rewrite a non-spec profile is allowed to make.
 *
 * The one rule this module exists to enforce: **a time-compressed build scales
 * every duration by the same factor, or it does not build.**
 *
 * Every relation of whitepaper §6.3 that involves time is a ratio — the epoch
 * against the coupon cliff, the unbonding against the dispute cycle, the escrow's
 * `RELEASE_EPOCH_DELAY` epochs against the unbonding — so one factor applied to
 * every literal preserves all of them exactly. Hand-picking shorter values per
 * constant would not: 30 days / 168 is not an integer, and the first relation
 * that silently stopped holding would be found on a live chain.
 *
 * The rewrite runs in memory at compile time. No second source tree exists on
 * disk, so the cross-leg constant comparison that reads sources as text keeps
 * reading the specification's values.
 *
 * `testnet` is one day to ten minutes: a 70-minute epoch, a 210-minute
 * unbonding, a five-hour coupon cliff. `rapid` is one day to a minute, for the
 * private enclave, where a seven-minute epoch is still far longer than
 * finality. Neither bytecode is the product, and `manifest.js` refuses both on
 * a mainnet chain id.
 *
 * ONE DURATION THE FACTOR MUST NOT SCALE: THE QRL CLAIM MARGIN
 * -----------------------------------------------------------
 * Whitepaper §4.7 (as revised 2026-09-28, audit D12): a profile that
 * compresses time divides every window by its compression and cannot divide
 * the finality of the origin chain, so on every profile the QRL claim margin
 * is not below twice that finality plus one relayer interval, and a
 * compressed margin below it is raised to it (`profileQrlClaimMarginHours` of
 * the model). The testnet profile serves Hoodi, whose finality at the
 * manifests' 64 confirmations of twelve seconds is 768 s: two of them and a
 * sixty-second tick are 1,596 s, above the compressed 1,200 s, so the profile
 * runs at the bound. It is the one override a profile carries, applied to the
 * one declaration that names it, after the factor; the specification's
 * `2 days` stays in the source. The settlement of an epoch still closes
 * before the next quote window opens (I31): 1,200 + 1,596 + 600 < 4,200.
 * The rapid profile serves an enclave whose finality is seconds and keeps the
 * factor's 120 s.
 */
const DAY = 86400;

/** Seconds of the origin chain's finality a profile is built for, and of one relayer interval. */
const HOODI_FINALITY_SECONDS = 64 * 12;
const RELAYER_INTERVAL_SECONDS = 60;

/**
 * The QRL claim margin a profile runs at, in seconds: the specification's two
 * days compressed, raised to twice the origin finality plus one relayer
 * interval where the compressed value falls below it. `profileQrlClaimMarginHours`
 * of the model, in seconds.
 */
function qrlClaimMarginSeconds(day, finalitySeconds, intervalSeconds) {
  const compressed = 2 * day;
  const floor = 2 * finalitySeconds + intervalSeconds;
  return Math.max(compressed, floor);
}

const PROFILES = {
  spec: { name: 'spec', day: DAY, suffix: '' },
  testnet: {
    name: 'testnet',
    day: 600,
    suffix: '-testnet',
    overrides: { QRL_CLAIM_MARGIN: qrlClaimMarginSeconds(600, HOODI_FINALITY_SECONDS, RELAYER_INTERVAL_SECONDS) },
  },
  // For the private enclave only. An epoch of seven minutes is shorter than a
  // public chain's finality lag, so a forward path waiting for finality there
  // would never see an epoch close; on a two-node enclave finality is seconds.
  rapid: { name: 'rapid', day: 60, suffix: '-rapid' },
};

/** Units the rewrite scales, in seconds per unit at the spec profile. */
const SCALED = { days: DAY, hours: 3600 };

/**
 * Units a source may not use under a non-spec profile. `seconds` and `minutes`
 * would need a factor that is not an integer at every profile, and `weeks` and
 * `years` are simply not used; any of them appearing means a duration the
 * rewrite does not know how to scale, which must stop the build.
 */
const REFUSED = ['seconds', 'minutes', 'weeks', 'years'];

class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
  }
}

function profile(name) {
  const p = PROFILES[name || 'spec'];
  if (!p) throw new ProfileError(`unknown build profile "${name}"; known: ${Object.keys(PROFILES).join(', ')}`);
  return p;
}

/** `--profile <name>` from argv, or the spec profile. */
function fromArgv(argv = process.argv) {
  const i = argv.indexOf('--profile');
  return profile(i >= 0 ? argv[i + 1] : 'spec');
}

/**
 * Splits a Solidity/Hyperion source into code and non-code (comments, string
 * literals) so the rewrite touches code only. A duration named in a comment is
 * documentation of the specification and stays as written.
 */
function segments(text) {
  const out = [];
  let i = 0;
  let code = '';
  const flush = () => {
    if (code) out.push({ code: true, text: code });
    code = '';
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    let end = -1;
    if (two === '//') {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
    } else if (two === '/*') {
      end = text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : end + 2;
    } else if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      end = i + 1;
      while (end < text.length && text[end] !== q) end += text[end] === '\\' ? 2 : 1;
      end += 1;
    }
    if (end < 0) {
      code += text[i++];
      continue;
    }
    flush();
    out.push({ code: false, text: text.slice(i, end) });
    i = end;
  }
  flush();
  return out;
}

const LITERAL = /\b(\d[\d_]*)\s+(seconds|minutes|hours|days|weeks|years)\b/g;

/**
 * Returns `{ text, rewrites }`. Under the spec profile the text is returned
 * unchanged. Otherwise each `N days` / `N hours` in code becomes
 * `(N * seconds)` at the profile's day, parenthesised so a multiplication
 * around it (`x * 1 days`) keeps its precedence; any refused unit throws.
 * Then each of the profile's `overrides` replaces the value of the constant it
 * names, in code, and is reported with `override: true` (see the header).
 */
function rewriteSource(text, p, file = '<source>') {
  if (p.day === DAY) return { text, rewrites: [] };
  const rewrites = [];
  const body = segments(text)
    .map((s) => {
      if (!s.code) return s.text;
      return s.text.replace(LITERAL, (match, n, unit) => {
        if (REFUSED.includes(unit)) {
          throw new ProfileError(
            `${file}: "${match}" uses a unit the ${p.name} profile does not scale; ` +
              'write it in days or hours so every duration moves by one factor',
          );
        }
        const seconds = (SCALED[unit] * p.day) / DAY;
        if (!Number.isInteger(seconds)) {
          throw new ProfileError(`${file}: one ${unit} is not a whole number of seconds at the ${p.name} profile`);
        }
        const replacement = `(${n} * ${seconds})`;
        rewrites.push({ file, from: match, to: replacement });
        return replacement;
      });
    })
    .join('');
  let out = body;
  for (const [name, seconds] of Object.entries(p.overrides || {})) {
    out = segments(out)
      .map((s) => {
        if (!s.code) return s.text;
        return s.text.replace(new RegExp(`\\b(${name}\\s*=\\s*)([^;]+);`), (match, lead, from) => {
          rewrites.push({ file, from: from.trim(), to: String(seconds), override: name });
          return `${lead}${seconds};`;
        });
      })
      .join('');
  }
  return { text: out, rewrites };
}

/**
 * Rewrites a `{ path: { content } }` source map. `skip(path)` exempts a file:
 * vendored OpenZeppelin and the §8.2 inherited contracts are not this product
 * and keep their durations.
 */
function rewriteSources(sources, p, skip = () => false) {
  const out = {};
  const rewrites = [];
  for (const [file, { content }] of Object.entries(sources)) {
    if (skip(file)) {
      out[file] = { content };
      continue;
    }
    const r = rewriteSource(content, p, file);
    out[file] = { content: r.text };
    rewrites.push(...r.rewrites);
  }
  return { sources: out, rewrites };
}

/** Seconds a spec duration lasts at a profile. */
const scaled = (p, specSeconds) => (BigInt(specSeconds) * BigInt(p.day)) / BigInt(DAY);

/**
 * The QRL claim margin, in seconds, of the profile whose day is `day`: its
 * override where it has one, the factor's two days otherwise. What the
 * relayer's clock must agree with (`relayer/lib/epoch.js clockFor`).
 */
function qrlClaimMarginAt(day) {
  const p = Object.values(PROFILES).find((x) => x.day === Number(day));
  const o = p && p.overrides && p.overrides.QRL_CLAIM_MARGIN;
  return o !== undefined ? o : 2 * Number(day);
}

module.exports = {
  PROFILES,
  profile,
  fromArgv,
  rewriteSource,
  rewriteSources,
  scaled,
  qrlClaimMarginSeconds,
  qrlClaimMarginAt,
  HOODI_FINALITY_SECONDS,
  RELAYER_INTERVAL_SECONDS,
  ProfileError,
  DAY,
};
