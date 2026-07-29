# Community agent testing on Arc

Status: **shipped to Arc testnet. Ready for community testing.**
Date: 2026-07-29

## What problem this solves

Nobody outside this repo can try the agent. Creating a vault currently means
running a script with a private key, and the only pool it could point at holds
24 USDC, which is not enough depth for even one honest tester: a 5 USDC vault
rebalancing one-sided would swap roughly 2.5 USDC against 24, about 10% of the
pool, and revert on slippage. Arc MINTD is fixed supply with no mint function
and USDC arrives only through Circle's rate-limited faucet, so the existing pair
cannot be deepened enough to matter. This gives the community a way to create,
fund and tune their own vault, against a pool deep enough that the agent's
behaviour is the thing being tested rather than the pool's thinness.

## What it does not do

- **No mainnet, and no real value.** Arc testnet only. The test tokens are
  worthless by construction and the UI must never imply otherwise.
- **No changes to `AgentVault.sol` or `AgentVaultFactory.sol`.** Both are
  reviewed and deployed. This is a frontend plus a test-only token and pool. If
  something here seems to need a contract change, that is a separate plan and a
  re-review, not a quiet edit.
- No custody change: a vault is owned by whoever created it, and this repo's
  keys can never withdraw from it.
- No vault-to-vault features, no fee capture, no leaderboard. Later, if at all.

## Contracts touched

**New: `contracts/test/TestToken.sol`.** A deliberately boring ERC20 with a
public `faucet()`. Boring is the requirement, not an aesthetic: a token with a
transfer fee, a rebase, or a missing return value would break `AgentVault`'s
`require(token.transfer(...))` and produce failures that look like vault bugs.
It returns `bool` from `transfer`/`transferFrom`, has fixed decimals, and does
nothing on transfer. Two are deployed:

| Token | Decimals | Role |
|---|---|---|
| `tUSD` | 6 | the stable leg, and the vault's numeraire |
| `tETH` | 18 | the volatile leg |

Mismatched decimals on purpose. A 6/18 pair is what the real product looks like
on both chains, and it exercises the conversion path that has already produced
one wrong number in this work.

`faucet()` mints a fixed amount to `msg.sender` behind a per-address cooldown.
Not a security control, since the tokens are worthless; it exists so one person
holding a loop cannot make the pool's price meaningless for everyone else.

**Does this touch user funds?** No. The tokens have no value and the new
contract custodies nothing. `/security-review` is therefore not required for
`TestToken.sol`, and this is stated explicitly rather than skipped silently. The
contracts that *do* hold value, the vault and the factory, are unchanged and
already reviewed.

## The pool

A new Uniswap V3 `tUSD/tETH` pool at the **0.30% tier**, seeded deep and wide.

The fee tier is a decision, not a default. The existing MINTD pool is 1%, and
`AgentVault`'s stock `maxSlippageBps` of 100 is exactly consumed by a 1% fee
before any price impact, so every rebalance reverted with `Too little received`
until it was raised. At 0.30% the shipped defaults work as intended, so a tester
who changes nothing gets a vault that functions.

Seeded from freshly minted supply, so depth is a number we choose rather than
one the faucet allows. Target: enough that a 10,000 tUSD vault rebalancing moves
the price by well under the default slippage, which is the whole point of the
exercise. Observations are then filled with `scripts/seed-twap.js` so the TWAP
is real rather than spot extrapolated. That step is mandatory, not optional:
until cardinality grows the "TWAP" equals spot exactly and every protection in
the vault is reading a price a tester could move by accident.

## What the UI does

On the Agent tab, for a connected wallet:

1. **Get test tokens** calls `faucet()` on both tokens.
2. **Create a vault** calls `factory.createVault(pool, agent, numeraire)` with
   the test pool and `tUSD` prefilled, and the mintd keeper prefilled as the
   agent. The agent field is visible and editable before signing, because a
   prefilled agent a user never looks at is the last trust assumption left in
   the design.
3. **Deposit** approves and deposits. One-sided is allowed by the contract, so a
   tester can fund with `tUSD` alone.
4. **Settings** exposes the whole policy, with the contract's own bounds shown:

   | Field | Bound enforced on chain |
   |---|---|
   | `maxTickDrift` | > 0 and <= 20000 |
   | `maxSlippageBps` | <= 500 |
   | `lossToleranceBps` | <= 2000 |
   | `reviewWindow` | >= 300s |
   | `twapWindow` | >= 300s |
   | `cooldown` | none |

   Plus mode: Paused, Propose only, Timelocked, Autonomous.

   The UI warns when `maxSlippageBps` is at or below the pool's fee tier,
   because that combination cannot fill and presents as a broken agent rather
   than a bad setting.
5. **Approve / veto** a pending proposal, for the modes that need a human.
6. **Withdraw everything**, always visible, in every mode, never behind a menu.

## How it can lose money

The tokens are worthless, so the honest framing is what could waste a tester's
time or teach them something false about the product.

- **A deposit that cannot be withdrawn.** The only outcome that would genuinely
  matter. `withdrawAll` needs no agent and works in every mode including
  PAUSED, so the risk is purely that the UI fails to offer it. It is therefore
  always rendered, never conditional on state.
- **Wrong decimals.** A 6/18 pair displayed with a guessed decimal is a
  1,000,000x error on screen. This already happened once this week, through a
  swallowed `decimals()` call that silently defaulted to 18. Decimals are read,
  never assumed, and a failure to read them fails loudly.
- **Slippage below the fee tier**, covered above: the vault is fine, every
  rebalance simply reverts, and it looks like the agent is broken.
- **A vault created against the wrong pool.** The factory's canonical-pool check
  makes a forged pool impossible, but a tester could still point at a thin real
  pool and conclude the agent is bad when the venue was. The test pool is the
  default and the picker explains the difference.
- **Believing the security result transfers.** Testing on a pool this repo
  seeded, with tokens it minted, proves the mechanics. It does not reproduce an
  adversarial market. The page should not imply it does.

## Tests that must pass before deploy

- [x] `node scripts/test-agent-vault.js` still green (48)
- [x] `node scripts/test-agent-vault-factory.js` still green (64)
- [x] `scripts/test-test-token.js`: decimals, bool returns, faucet cooldown (22)
- [x] a dry run of the deploy-and-seed script
- [x] end to end on Arc via `scripts/test-arc-agent-e2e.js`, 19 checks, run from
      a FRESHLY GENERATED key funded with gas and nothing else, which is the
      "second address" requirement in its strongest form: faucet, create,
      one-sided 5,000 tUSD deposit, policy bounds rejected and accepted on
      chain, autonomous, a real rebalance at 0.1683%, then 99.88% recovered

### What the e2e caught

Two bugs, both mine, both in the test rather than the product:

- **Token ordering.** `deposit(dep, 0)` assumed tUSD was `amount0`. Uniswap
  orders by address and token0 here is tETH, so it tried to pull a token the
  stranger had never approved and reverted with no reason string. The slot is
  now resolved from the vault. The UI was already correct, because it labels
  its inputs from the vault's own `token0`/`token1` rather than assuming.
- **A wrong assertion about the TWAP.** The first version asserted
  `twap !== spot`. That was the right check when the failure mode was
  cardinality 1 and `observe()` extrapolating from the current tick. With a
  real 128-slot buffer and a price sitting in a three-tick band the two
  legitimately coincide, so the assertion would have failed a healthy pool.
  Cardinality is what proves the buffer is real; equality proves nothing either
  way.

## Deploy steps

1. `node scripts/compile.js` (paris, gotcha 4)
2. `scripts/deploy-test-pool.js`: deploy both tokens, create and initialize the
   pool, mint a deep wide position, then run `seed-twap.js` until the TWAP tick
   diverges from spot
3. Read back on chain: pool is canonical for the pair and fee, cardinality has
   grown, `observe()` spans the window
4. Record addresses in `deployments/arc-testnet.json`
5. Add the pool and tokens to the Arc chain config in `frontend/index.html`,
   rebuild `money/index.html` with `build-money.js`, push
6. Run the full end-to-end myself, then invite the community

## Rollback

Everything here is additive and revertible by a push. The tokens and pool can be
abandoned in place; nothing references them except the frontend config. No user
funds are at stake because there are no funds. If the vault or factory turns out
to need a change, that is a new plan, and every existing vault stays withdrawable
by its owner regardless.

## Open questions

None blocking. Two decisions already taken: a dedicated freely mintable test
pair rather than deepening the USDC/MINTD pool, and full policy control for
testers rather than presets.
