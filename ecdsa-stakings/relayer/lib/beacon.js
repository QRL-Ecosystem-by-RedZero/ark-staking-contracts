/**
 * The QRL beacon chain, read for the report sealer of the testnet attestation
 * double (OC-LEGB-06).
 *
 * The one rule this module exists to enforce: **a report line states only
 * what the beacon chain itself shows.** A validator the beacon state does not
 * hold yet (its deposit is still inside the follow distance) yields no line,
 * and a status this table does not know yields none either: the reconciliation
 * report moves principal and forfeits operator bonds, so a guess in it is a
 * transfer nobody decided.
 *
 * The node is the enclave's beacon API (`QRL_BEACON_URL`, written to .env by
 * kurtosis-up.sh; the same endpoint scripts/delegation-status.js reads). Its
 * balances are in Gplanck and are returned here in planck, as the delegation
 * counts them. Withdrawals are not here: the beacon state keeps no cumulative
 * figure, so the sealer sums them from the execution blocks that credited
 * them (`qrlClient.blockFacts`).
 */
const { keccak256 } = require('ethers');

/** Beacon API validator statuses, numbered as `IArkBondDelegation.Report.status` numbers them. */
const BEACON_STATUS = Object.freeze({
  pending_initialized: 0,
  pending_queued: 1,
  active_ongoing: 2,
  active_exiting: 3,
  active_slashed: 4,
  exited_unslashed: 5,
  exited_slashed: 6,
  withdrawal_possible: 7,
  withdrawal_done: 8,
});

const GPLANCK = 10n ** 9n;
const hex = (v) => String(v).toLowerCase();

/** One validator of the API's `data` array, as the sealer reads it, or null where its status is unknown. */
function parseValidator(v) {
  const status = BEACON_STATUS[v.status];
  if (status === undefined) return null;
  const pubkey = hex(v.validator.pubkey);
  return {
    index: BigInt(v.index),
    pubkey,
    pubkeyHash: hex(keccak256(pubkey)),
    status,
    slashed: Boolean(v.validator.slashed),
    // keccak256 of the raw credential bytes, as the Report carries them (QIP-55: the 64-byte address, no prefix).
    credentialsHash: hex(keccak256(hex(v.validator.withdrawal_credentials))),
    balance: BigInt(v.balance) * GPLANCK,
  };
}

/** A client of the beacon API at `url`; `fetchImpl` is injectable for the tests. */
function beaconClient(url, fetchImpl = globalThis.fetch) {
  const base = String(url).replace(/\/+$/, '');
  return {
    url: base,
    /** Every validator of the head state, keyed by the keccak256 of its public key. */
    async validators() {
      const res = await fetchImpl(`${base}/qrl/v1/beacon/states/head/validators`);
      if (!res.ok) throw new Error(`beacon ${base}: validators HTTP ${res.status}`);
      const body = await res.json();
      const out = new Map();
      for (const v of body.data || []) {
        const p = parseValidator(v);
        if (p) out.set(p.pubkeyHash, p);
      }
      return out;
    },
  };
}

/** The beacon client the environment names, or null where it names none. */
function beaconFromEnv(env = {}, fetchImpl = globalThis.fetch) {
  const url = env && env.QRL_BEACON_URL;
  if (!url || typeof fetchImpl !== 'function') return null;
  return beaconClient(url, fetchImpl);
}

module.exports = { BEACON_STATUS, beaconClient, beaconFromEnv, parseValidator };
