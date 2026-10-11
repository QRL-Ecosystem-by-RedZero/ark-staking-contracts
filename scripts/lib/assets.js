/**
 * Putting an origin asset in the operator's hands, for a seeding deposit or an
 * anchor on a testnet-profile deployment.
 *
 * The one rule this module exists to enforce: **a real asset is acquired the
 * way anyone acquires it, never minted.** A test double is minted; stETH is
 * bought by staking ETH through Lido's own `submit`, so a deployment on Hoodi
 * holds exactly what a depositor there could hold. An asset the manifest names
 * no source for is refused rather than guessed at.
 */
const { Interface } = require('ethers');

const LIDO = new Interface([
  'function submit(address referral) payable returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

/**
 * Wei of stETH lost to share rounding on a submit or a transfer. stETH moves
 * shares and renders them in units, truncating each way, so a submit of X ETH
 * credits X − 1 or X − 2 and a transfer of X delivers a wei or two less.
 */
const REBASE_MARGIN = 10n;

/**
 * Make `client` hold at least `amount` units of the asset.
 *
 * `a` is a manifest asset with `address` set; `tokenAbi` the double's ABI,
 * which a double needs for `mint`. Returns what was acquired, zero when the
 * holding already sufficed.
 */
async function supply(client, a, amount, tokenAbi) {
  if (a.mock) {
    await client.send(a.address, tokenAbi, 'mint', [client.address, amount]);
    return amount;
  }
  const held = (await client.call(a.address, LIDO, 'balanceOf', [client.address]))[0];
  if (held >= amount) return 0n;
  if (a.source !== 'lido') {
    throw new Error(`${a.symbol} is not a test double and names no source; hold ${amount}, have ${held}`);
  }
  const value = amount - held + REBASE_MARGIN;
  const eth = await client.balance(client.address);
  // Gas is paid from the same balance; a submit that leaves nothing for the
  // approve and the seed after it has only moved the failure one step on.
  if (eth < value + 10n ** 16n) throw new Error(`${client.address} holds ${eth} wei; staking ${value} through Lido needs that plus gas`);
  await client.send(a.address, LIDO, 'submit', ['0x' + '00'.repeat(20)], { value });
  const after = (await client.call(a.address, LIDO, 'balanceOf', [client.address]))[0];
  if (after < amount) throw new Error(`Lido credited ${after - held} of ${value} submitted; still short of ${amount}`);
  return after - held;
}

module.exports = { supply, REBASE_MARGIN };
