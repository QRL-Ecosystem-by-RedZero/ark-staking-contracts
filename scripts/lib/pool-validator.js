/**
 * Fund one validator of the staking pool from deposit data the chain's own
 * deposit tool wrote. Shared by `scripts/pool-validator.js` (by hand) and the
 * relayer (every devnet bring-up), because both must sign from the leg's
 * deployer: it is the delegation's governance and the attestation's sealer.
 *
 * The one rule: **the pool stakes real QRL at a real validator, and says whose
 * QRL it is.** On the private network no bondholder has subscribed yet, so the
 * pool's first 40,000 QRL is a team deposit into the pool — a depositor like
 * any other, holding shares, earning what the validator earns — never bond
 * principal and never a subscription. Bond principal joins the same pool when
 * bondholders subscribe and the bond places it.
 *
 * Idempotent, step by step, so a run cut short resumes where it stopped:
 *   1. the team deposit, only as far as the delegation is short of a stake;
 *   2. `admitValidator` behind the operator bond, naming the deployer as operator;
 *   3. the quorum's statement that the key has no deposit at the deposit
 *      contract's root now, sealed into MockAttestation at the delegation's
 *      `depositCheckKey()` — the deposit contract's count, never an epoch's
 *      report key (OC-LEGB-02) — the stand-in for the attester quorum;
 *   4. `delegate`, which deposits 40,000 QRL to the genesis deposit contract.
 */
const { keccak256, Interface } = require('ethers');
const { iface } = require('./chains');
const { toHex } = require('../../ecdsa-stakings/relayer/lib/addresses');

const ONE = 10n ** 18n;
const STAKE = 40_000n * ONE;
/** The v2 default; QRL_DEPOSIT_CONTRACT in .env overrides it on the v3 client (the v3 genesis address is Q + '42' x 64). */
const DEPOSIT_CONTRACT = '0x4242424242424242424242424242424242424242';

const hex = (v) => (String(v).startsWith('0x') ? String(v) : `0x${v}`);

/** The one entry of a deposit-data file, checked against the pool's delegation. */
function depositEntry(data) {
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== 1) throw new Error(`the deposit data holds ${list.length} entries; one validator at a time`);
  const d = list[0];
  if (BigInt(d.amount) * 10n ** 9n !== STAKE && BigInt(d.amount) !== STAKE) {
    throw new Error(`the deposit data deposits ${d.amount}, not a validator's 40,000 QRL`);
  }
  return { pubkey: hex(d.pubkey), credentials: hex(d.withdrawal_credentials).toLowerCase(), signature: hex(d.signature), root: hex(d.deposit_data_root) };
}

/**
 * Returns `{ pubkeyHash, funded, steps }`, `steps` naming what this call sent.
 * Throws with the chain's reason when a step is refused.
 */
async function fundPoolValidator({ client, build, q, depositData, teamDeposit = STAKE, log = console.log }) {
  if (!q.ArkStakingPool || !q.ArkBondDelegation || !q.MockAttestation || !q.ProceedsLedger) throw new Error('this QRL leg has no staking pool');
  const pool = iface('ArkStakingPool', build);
  const del = iface('ArkBondDelegation', build);
  const att = iface('MockAttestation', build);
  const ledger = iface('ProceedsLedger', build);
  const call = async (to, abi, m, a = []) => (await client.call(to, abi, m, a))[0];

  const d = depositEntry(depositData);
  // `withdrawalCredentials()` returns bytes: on v3 the raw 64-byte address
  // (0x+128), on the v2 build 12 zero bytes + the 20-byte address (0x+64).
  // The v3 deposit tool writes withdrawal_credentials as that same raw hex,
  // so the two compare directly, lowercased, at either width.
  const expected = String(await call(q.ArkBondDelegation, del, 'withdrawalCredentials')).toLowerCase();
  if (d.credentials !== expected) throw new Error(`the deposit data names credentials ${d.credentials}; the pool's delegation is ${expected}`);
  const key = keccak256(d.pubkey);
  const steps = [];

  const validator = async () => call(q.ArkBondDelegation, del, 'validatorOf', [key]);
  if (BigInt((await validator()).stake) !== 0n) return { pubkeyHash: key, funded: true, steps };

  // 1. The team deposit, only as far as the delegation is short of a stake.
  const idle = BigInt(await call(q.ArkBondDelegation, del, 'idle'));
  if (idle < STAKE) {
    const want = BigInt(teamDeposit);
    const amount = want > STAKE - idle ? want : STAKE - idle;
    await client.send(q.ArkStakingPool, pool, 'deposit', [], { value: amount });
    steps.push(`team deposit ${amount / ONE} QRL into the pool`);
    log(`pool     team deposit ${amount / ONE} QRL into the pool ${q.ArkStakingPool}`);
  }

  // 2. Admission behind the operator bond. The exit is pre-signed once the
  //    validator has an index; until then the commitment names what it will
  //    be, and `commitExit` replaces it.
  if (!(await validator()).admitted) {
    const bond = BigInt(await call(q.ArkBondDelegation, del, 'requiredBond'));
    const exit = keccak256(Buffer.from(`exit pending for ${key}`));
    await client.send(q.ArkBondDelegation, del, 'admitValidator', [d.pubkey, d.root, exit, client.address], { value: bond });
    steps.push(`admitted behind an operator bond of ${bond / ONE} QRL`);
    log(`pool     validator ${key.slice(0, 14)}… admitted behind an operator bond of ${bond / ONE} QRL`);
  }

  // 3. The quorum's deposit check, for the epoch in progress, then 4. the
  //    deposit. Back to back: the check names the deposit root, and any other
  //    deposit in between makes `delegate` refuse with DepositRootChanged.
  const dc = new Interface(['function get_deposit_root() view returns (bytes32)']);
  // The v3 chain's deposit contract sits at a 64-byte genesis address; the
  // env override applies on the real QRL client only — the harness installs
  // the contract's code at the 20-byte default whatever .env says.
  const depositContract = client.kind === 'qrl' && client.env && client.env.QRL_DEPOSIT_CONTRACT
    ? toHex(client.env.QRL_DEPOSIT_CONTRACT)
    : DEPOSIT_CONTRACT;
  const root = (await client.call(depositContract, dc, 'get_deposit_root'))[0];
  const epoch = BigInt(await call(q.ProceedsLedger, ledger, 'currentEpoch'));
  const leaf = await call(q.ArkBondDelegation, del, 'depositCheckLeaf', [key, root]);
  // Sealed in the delegation's deposit-check keyspace, by deposit count: never
  // at the plain epoch the forward path reads (D10, whitepaper §3.5), nor at
  // the report key of the epoch (OC-LEGB-02).
  const key_ = await call(q.ArkBondDelegation, del, 'depositCheckKey');
  await client.send(q.MockAttestation, att, 'seal', [key_, leaf]);
  await client.send(q.ArkBondDelegation, del, 'delegate', [d.pubkey, d.signature, root, []]);
  steps.push(`delegated 40,000 QRL to the deposit contract (check sealed at deposit count ${BigInt(key_) & ((1n << 128n) - 1n)})`);
  log(`pool     validator ${key.slice(0, 14)}… delegated: 40,000 QRL deposited to ${depositContract}`);
  return { pubkeyHash: key, funded: true, steps, epoch: String(epoch) };
}

module.exports = { fundPoolValidator, depositEntry, STAKE };
