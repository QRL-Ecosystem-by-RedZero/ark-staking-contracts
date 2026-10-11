/**
 * The relayer's inbox, authenticated.
 *
 * The one rule this module exists to enforce: **a file in the inbox is a
 * request from an operator named in advance, or it is nothing.** The inbox is
 * how `relay seal` hands a stand-in leaf — loss, recovery, close, freeze,
 * de-listing — to the process that holds the one-time seed, and the relayer
 * signs whatever it ingests into the next root. Unauthenticated, anyone able to
 * write to `.relayer/<chain>/inbox/` held the seed's power by proxy: a `close`
 * leaf is terminal for the escrow, a `loss` leaf pays the buffer to a
 * destination of the writer's choosing (audit 2026-09-27, D3; W6 of 2026-09-22
 * fixed half of it).
 *
 * So every file is an envelope: the entry, and a secp256k1 `personal_sign`
 * signature over a message that names the domain, the chain and a nonce. The
 * relayer recovers the signer and accepts the entry only where that address is
 * in `RELAYER_INBOX_SIGNERS` (or `<CHAIN>_INBOX_SIGNERS`); an empty allowlist
 * accepts nothing. A recovered envelope is recorded by its digest, so a copy
 * of a file already ingested — a stale `freeze false` dropped back after a
 * `freeze true` — is refused as a replay. Every decision is appended to
 * `inbox-audit.log` beside the state, one JSON line each, never rewritten.
 *
 * The operator key is NOT the one-time seed and must not be derivable from it:
 * a key that could sign roots and also approve its own inbox requests would
 * be one key again. `signEnvelope` refuses a key equal to the seed.
 *
 * ethers is already a dependency of this tree (root package.json); nothing is
 * added for this.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Wallet, verifyMessage, keccak256, toUtf8Bytes, getAddress } = require('ethers');

const { replacer } = require('../engine/state');

const DOMAIN = 'ARK_RELAYER_INBOX_V1';

const envKey = (chain) => chain.toUpperCase().replace(/-/g, '_');

/** JSON with sorted keys and BigInt as the state writes it, so both sides sign the same bytes. */
function canonical(value) {
  const sort = (v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), replacer);
}

/** The exact text an operator signs for `entry` on `chain`. */
function inboxMessage({ chain, nonce, entry }) {
  return `${DOMAIN}\nchain:${chain}\nnonce:${nonce}\nentry:${canonical(entry)}`;
}

/** The allowlist for `chain`, lower-cased; the per-chain key wins where set. */
function allowedSigners(env = {}, chain) {
  const raw = env[`${envKey(chain)}_INBOX_SIGNERS`] || env.RELAYER_INBOX_SIGNERS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => getAddress(a).toLowerCase());
}

/**
 * The envelope `relay seal` writes. `privateKey` is the operator's secp256k1
 * key; `otsSeed` — one seed or every signer seed this host holds — is
 * refused as that key.
 */
async function signEnvelope({ chain, entry, privateKey, otsSeed = null, nonce = '0x' + crypto.randomBytes(16).toString('hex') }) {
  if (!privateKey) throw new Error('no operator key: set RELAYER_INBOX_KEY (a secp256k1 key, NOT the one-time seed)');
  // Every signer seed this host holds is refused as the operator key (D1: n seeds, not one).
  const seeds = (Array.isArray(otsSeed) ? otsSeed : [otsSeed]).filter(Boolean).map((x) => String(x).toLowerCase().replace(/^0x/, ''));
  if (seeds.includes(String(privateKey).toLowerCase().replace(/^0x/, ''))) {
    throw new Error('RELAYER_INBOX_KEY equals the one-time seed; the inbox key must be a separate operator key');
  }
  const wallet = new Wallet(privateKey);
  const message = inboxMessage({ chain, nonce, entry });
  const signature = await wallet.signMessage(message);
  return { version: 1, domain: DOMAIN, chain, nonce, entry, signer: wallet.address, signature };
}

class InboxRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxRefusal';
  }
}

/**
 * The entry an envelope carries, once its signature is by an allowlisted
 * operator for this chain and it was not accepted before. Throws
 * `InboxRefusal` naming the reason otherwise.
 */
function openEnvelope(envelope, { chain, signers, seen = {} }) {
  if (!envelope || typeof envelope !== 'object' || envelope.domain !== DOMAIN) {
    throw new InboxRefusal('unsigned: not an inbox envelope (relay seal signs one with RELAYER_INBOX_KEY)');
  }
  if (envelope.chain !== chain) throw new InboxRefusal(`signed for chain ${envelope.chain}, this relayer serves ${chain}`);
  if (typeof envelope.nonce !== 'string' || !envelope.nonce) throw new InboxRefusal('no nonce');
  if (!envelope.entry || typeof envelope.entry !== 'object') throw new InboxRefusal('no entry');
  if (!signers.length) throw new InboxRefusal('no inbox signer is allowlisted (RELAYER_INBOX_SIGNERS); every file is refused');
  const message = inboxMessage({ chain, nonce: envelope.nonce, entry: envelope.entry });
  let recovered;
  try {
    recovered = verifyMessage(message, envelope.signature).toLowerCase();
  } catch (e) {
    throw new InboxRefusal(`bad signature: ${e.shortMessage || e.message}`);
  }
  if (!signers.includes(recovered)) throw new InboxRefusal(`signer ${recovered} is not allowlisted`);
  const digest = keccak256(toUtf8Bytes(message));
  if (seen[digest]) throw new InboxRefusal(`replay: envelope ${digest.slice(0, 14)}… was accepted at ${seen[digest]}`);
  return { entry: envelope.entry, signer: recovered, digest };
}

/** Append one decision to the audit log. Append only: nothing here reads, truncates or rewrites it. */
function audit(dir, record) {
  fs.appendFileSync(path.join(dir, 'inbox-audit.log'), JSON.stringify({ at: new Date().toISOString(), ...record }, replacer) + '\n', { flag: 'a' });
}

module.exports = { DOMAIN, inboxMessage, allowedSigners, signEnvelope, openEnvelope, audit, InboxRefusal, canonical };
