/**
 * The shared clock, in JavaScript.
 *
 * The one rule this module exists to enforce: **both chains number the same
 * second into the same epoch, with nothing configured.**
 *
 * A transcription of contracts/utils/ArkEpoch.hyp. Epochs are numbered from the
 * Unix epoch rather than from a genesis timestamp, which is what lets an origin
 * chain event and a QRL contract agree about which epoch they are in without
 * either side being told. That property is what the premium delivery of
 * whitepaper §4.7 rests on, so a "convenience" offset added here would break the
 * relay rather than shift a label.
 *
 * Every quantity is a BigInt. Seconds since 1970 exceed no JavaScript limit, but
 * `anchoredNotional` in the same pipeline does, and one module mixing Number and
 * BigInt is how a silently truncated notional gets into a leaf.
 */
const { qrlClaimMarginAt } = require('../../../scripts/lib/profile');

const EPOCH_LENGTH = 604800n; // 7 days, ArkEpoch.EPOCH_LENGTH
const COUPON_CLIFF = 2592000n; // 30 days, ArkEpoch.COUPON_CLIFF

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

const epochOf = (timestamp) => big(timestamp) / EPOCH_LENGTH;
const startOf = (epoch) => big(epoch) * EPOCH_LENGTH;
const endOf = (epoch) => startOf(big(epoch) + 1n);
const isClosed = (epoch, nowTs) => big(nowTs) >= endOf(epoch);

/** Zero once the epoch has closed, never negative. */
function secondsLeftIn(epoch, nowTs) {
  const left = endOf(epoch) - big(nowTs);
  return left > 0n ? left : 0n;
}

/**
 * Whether a delivery for `epoch` may still be submitted.
 *
 * `ProceedsLedger.deliver` compares the epoch against the clock *at inclusion*,
 * in both directions, so a delivery sent near the boundary can be mined into the
 * next epoch and revert `NotCurrentEpoch`. The margin is refused time, not a
 * retry: a delivery that misses is one nothing carries forward, and the ledger
 * strands the residue deliberately.
 */
function withinDeliveryWindow(epoch, chainTs, marginSeconds) {
  const now = big(chainTs);
  if (epochOf(now) !== big(epoch)) return false;
  return secondsLeftIn(epoch, now) > big(marginSeconds);
}

/**
 * The same clock at a build profile's day (`scripts/lib/profile.js`): the
 * spec day is 86,400 seconds, the `testnet` day 600. A relayer serving a
 * time-compressed deployment must number epochs as its bytecode does, and a
 * relayer on the wrong clock seals every leaf into an epoch the relay refuses.
 *
 * Every duration is the spec duration scaled by one factor, as the profile
 * rewrite scales the contracts, so this carries days rather than seconds —
 * except the QRL claim margin, which a profile raises to twice the origin
 * chain's finality plus a relayer interval where the factor would take it
 * below that (whitepaper §4.7, D12; `scripts/lib/profile.js`), and which is
 * read from the same profile table the compiler reads.
 */
function clockFor(secondsPerDay = 86400) {
  const day = big(secondsPerDay);
  const length = 7n * day;
  const margin = BigInt(qrlClaimMarginAt(secondsPerDay));
  const epochOfAt = (timestamp) => big(timestamp) / length;
  const startOfAt = (epoch) => big(epoch) * length;
  const endOfAt = (epoch) => startOfAt(big(epoch) + 1n);
  return {
    day,
    EPOCH_LENGTH: length,
    COUPON_CLIFF: 30n * day,
    UNBONDING_PERIOD: 21n * day,
    // ArkEpoch's four windows of the premium swap (whitepaper §4.7).
    QUOTE_WINDOW: day,
    ADMISSION_WINDOW: day,
    EVM_CLAIM_WINDOW: day,
    QRL_CLAIM_MARGIN: margin,
    CHALLENGE_WINDOW: 7n * day,
    epochOf: epochOfAt,
    startOf: startOfAt,
    endOf: endOfAt,
    isClosed: (epoch, nowTs) => big(nowTs) >= endOfAt(epoch),
    /** When the quote window offering `epoch`'s premium closes: the end of `epoch + 1`. */
    quoteCloses: (epoch) => startOfAt(big(epoch) + 2n),
    quoteOpens: (epoch) => startOfAt(big(epoch) + 2n) - day,
    /** The escrow's last instant, exclusive, to pay a lot of `epoch`'s offering. */
    evmExpiry: (epoch) => startOfAt(big(epoch) + 2n) + 2n * day,
    /** The QRL expiry of the same lots; the coupon of `epoch` is paid from here. */
    settlementCloses: (epoch) => startOfAt(big(epoch) + 2n) + 2n * day + margin,
    /** From when in an epoch the escrow offers: after the last lots it could still pay have expired. */
    offerOpens: (epoch) => startOfAt(epoch) + 2n * day,
  };
}

/** The origin chain's block interval where a manifest names none: Ethereum-like, twelve seconds. */
const DEFAULT_BLOCK_SECONDS = 12;
/** The relayer's tick where none is given: `relay.js --interval`, sixty seconds. */
const DEFAULT_TICK_SECONDS = 60;

/**
 * Seconds a preimage revealed on the origin chain needs before the relayer has
 * carried it to QRL: the origin chain's finality twice — the claim's block
 * reaching the height the relayer reads, and the relayer's own QRL send
 * landing behind it — and one relayer tick (audit 2026-09-27, D12).
 *
 * Finality is the manifest's `confirmations` times its `blockSeconds` (12 where
 * absent). Hoodi at 64 confirmations: 2 x 768 + 60 = 1,596 s. Until 2026-09-28
 * that was longer than the testnet profile's QRL claim margin of two ten-minute
 * "days" (1,200 s); whitepaper §4.7 now raises a compressed margin to this bound
 * and the testnet profile runs at it (1,596 s, `scripts/lib/profile.js`), so
 * `marginShortfall` is zero on every manifest of that profile. The solver still
 * refuses to reveal inside the budget, which is what protects it on a chain
 * slower than the one a profile was built for.
 */
function revealBudgetSeconds(manifest = {}, tickSeconds = DEFAULT_TICK_SECONDS) {
  const confirmations = BigInt(manifest.confirmations || 1);
  const block = BigInt(manifest.blockSeconds || DEFAULT_BLOCK_SECONDS);
  return 2n * confirmations * block + BigInt(tickSeconds);
}

/** How far the clock's QRL claim margin falls short of the reveal budget; 0n where it does not. */
function marginShortfall(clock, manifest, tickSeconds = DEFAULT_TICK_SECONDS) {
  const need = revealBudgetSeconds(manifest, tickSeconds);
  const have = BigInt(clock.QRL_CLAIM_MARGIN);
  return need > have ? need - have : 0n;
}

module.exports = {
  revealBudgetSeconds,
  marginShortfall,
  DEFAULT_TICK_SECONDS,
  clockFor,
  EPOCH_LENGTH,
  COUPON_CLIFF,
  epochOf,
  startOf,
  endOf,
  isClosed,
  secondsLeftIn,
  withinDeliveryWindow,
};
