/**
 * Writes to .env. Kept apart from scripts/qrl.js, which only reads it.
 *
 * THE ONE RULE (audit 2026-09-29, OL-04 / R3-04)
 * ----------------------------------------------
 * **A secret already in .env is archived before anything overwrites it.** A
 * redeploy used to write a new relay's one-time seeds over the old ones, and
 * the seed of a relay whose escrow still held positions was lost with them.
 * `replaceSecrets` first copies every line it is about to replace into
 * `.env.archive-<tag>-<timestamp>` beside .env — the tag is the retiring
 * relay's address — mode 0600, written to a temporary file, fsynced and
 * renamed into place, and only then rewrites .env the same way. `.env.*` is
 * gitignored (`.env.example` excepted), so the archive never reaches a commit.
 *
 * Nothing here prints a value: the functions return paths and key names.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');

const lineRe = (key) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');

/** Write `text` to `file` atomically: a temporary file beside it, fsynced, renamed over it. */
function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** The .env text with `key="value"` set, replacing an existing line or appending one. */
function withEntry(text, key, value) {
  const line = `${key}="${value}"`;
  const re = lineRe(key);
  return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
}

/** Sets `key="value"` in .env, replacing an existing line or appending one. Not for a secret that may already be set: see `replaceSecrets`. */
function upsertEnv(key, value, { file = ENV_FILE } = {}) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  writeAtomic(file, withEntry(text, key, value));
}

/** A filesystem-safe UTC stamp: 20260930T101500Z. */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * Copy the current lines of `keys` from .env into `.env.archive-<tag>-<stamp>`
 * beside it, atomically and mode 0600. Returns the archive's path, or null
 * where none of the keys is set. Never overwrites an archive.
 */
function archiveEnv(keys, tag, { file = ENV_FILE, now = Date.now() } = {}) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const lines = [];
  for (const key of keys) {
    const m = text.match(lineRe(key));
    if (m) lines.push(m[0].trim());
  }
  if (!lines.length) return null;
  const safeTag = String(tag || 'unknown').replace(/[^0-9A-Za-z_-]/g, '');
  const archive = path.join(path.dirname(file), `.env.archive-${safeTag}-${stamp(now)}`);
  if (fs.existsSync(archive)) throw new Error(`${archive} exists; not overwritten`);
  const header = `# Archived ${new Date(now).toISOString()} before a redeploy replaced these secrets (relay ${tag}).\n` +
    '# Keep it offline and encrypted; it opens the retired relay for as long as its escrows hold anything.\n';
  writeAtomic(archive, `${header}${lines.join('\n')}\n`, 0o600);
  return archive;
}

/**
 * Replace secrets in .env, archiving the old values first (OL-04). `entries`
 * is `{ KEY: value }`; `tag` names what they belonged to (the retiring
 * relay's address). Returns `{ archive, keys }`: the archive written (or null
 * where none of the keys was set) and the keys written — never a value.
 */
function replaceSecrets(entries, tag, { file = ENV_FILE, now = Date.now() } = {}) {
  const keys = Object.keys(entries);
  const archive = archiveEnv(keys, tag, { file, now });
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const key of keys) text = withEntry(text, key, entries[key]);
  writeAtomic(file, text);
  return { archive, keys };
}

module.exports = { upsertEnv, archiveEnv, replaceSecrets, ENV_FILE };
