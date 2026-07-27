# LP agent

Status: draft
Date: 2026-07-27

The first consumer-facing agentic liquidity product. See `docs/STRATEGY.md`
for why this is the first build rather than the institutional version.

## What problem this solves

People who provide liquidity on mintd.fun manage it by hand, badly. V3 ranges
drift out of band and stop earning. Fees sit unclaimed. Dead pools keep capital
parked in tokens that no longer trade. Most LPs check in far less often than
the position needs.

The LP agent watches a position and acts on the owner's behalf: rebalances the
range, compounds fees, and exits when a pool is dead. The owner delegates once
and stops thinking about it.

This is the same core technology as the cross-chain institutional version in
the thesis, pointed at retail. Nothing built here is thrown away later.

## What it does not do

- No discretionary transfer authority. Deliberately not phrased as "no custody
  of principal": a vault holding user funds **is** custody, and claiming
  otherwise is the kind of line that has to be walked back later. See the
  security model below, which is the whole design constraint
- No cross-chain routing in v1. One chain, one venue
- No discretionary trading. It manages a position, it does not take views
- No new token

## Security model

**This is the section that matters.** An agent with permission to move user
funds is a target, and the keeper key lives on a server.

### The rule that was wrong

The first draft of this section said: the agent can rebalance but must never
send principal to an arbitrary address. That rule is **not sufficient**, and
building to it would have shipped a drainable vault.

**Rebalancing is a swap, and a swap is an authority, not just a risk.**

Moving a V3 range means burning liquidity, swapping to correct the ratio, and
minting the new position. If the agent supplies that swap's minimum output, a
compromised keeper sets it near zero and sandwiches its own rebalance from an
unrelated address. The difference is the theft. Against the original controls:

| Control | Still satisfied while the vault drains |
|---|---|
| Funds never sent to an arbitrary address | yes, they left through a swap |
| Agent only called rebalance | yes |
| Exit points at the immutable owner address | yes |
| Owner can revoke | yes, if they are watching, which they are not |
| Per-transaction cap | yes, each rebalance is individually modest |

Every box ticks and the money is gone. The old controls guard the **exit**;
the theft happens during **normal operation**.

The same hole exists in `compound`, which has to swap to balance fees.

### The rule that replaces it

**The agent may never choose an execution price, a venue, or a range.** It
proposes timing, the contract decides everything that carries value.

- User funds sit in a per-user vault contract, not in the agent's wallet
- The agent holds a role that can only call rebalance, compound and exit
- **The vault computes minimum output itself from a TWAP. The keeper passes no
  slippage parameter at all.** This single change closes the main vector
- **Pool address and fee tier are immutable at deposit.** Not a registry entry
  that an agent or an ops key can edit later. Otherwise the agent rebalances
  into a pool it created and the owner exits, correctly, to the right address,
  holding a worthless position
- **Tick ranges are clamped in-contract** to a band around a contract-read
  TWAP. The keeper proposes a range, the contract bounds it
- **Cumulative-loss circuit breaker.** The vault checkpoints position value in
  TWAP terms and reverts any action that would drop it more than a set
  tolerance since the last checkpoint. This is what makes a cap mean anything:
  a per-day cap alone sets the drain schedule, it does not bound the total,
  because a patient attacker simply takes the cap every day
- Exit always returns funds to the **owner address recorded at deposit**, and
  that address is immutable after creation
- The owner can revoke the agent's role at any time, in one transaction,
  without the agent's cooperation. Revocation is reactive and cannot be the
  primary defence: the users who delegate are the ones not watching
- Strategy parameters in the registry are **owner-set or immutable**. An
  ops-editable parameter is a second authority that bypasses everything above
- The keeper key is gas-only, exactly like the arb keeper. Note this buys
  nothing on its own: the keeper's own balance is irrelevant, the authority it
  holds is the asset

If the keeper key is fully compromised, the worst case must be wasted gas and
badly timed rebalances, never stolen principal. Write the test that proves it,
and note that the obvious test does not prove it. See below.

## Contracts touched

- New: `LpVault` (per-user custody, owner-immutable, role-gated agent actions,
  pool and fee tier immutable at deposit, TWAP-derived slippage bounds and
  tick clamping, cumulative-loss breaker)
- New: `LpAgentRegistry` (which vaults the agent is authorised over, and the
  strategy parameters for each). Parameters here are owner-set or immutable:
  an ops-writable parameter is an authority equivalent to the agent's
- Reads existing: Uniswap V3 NPM, QuoterV2, MintSwap pairs
- Off-chain: `scripts/lp-agent.js`, modelled on `arb-keeper-multi.js`, using
  `batchMaxCount: 1` per CLAUDE.md gotcha 1

Touches user funds. `/security-review` before deploy, no exceptions.

## How it can lose money

- **Rebalance into a worse range.** Every rebalance realises impermanent loss.
  An agent that rebalances too eagerly loses more to IL than it earns in fees.
  Needs a minimum-improvement threshold, not just an out-of-range trigger
- **Sandwich on rebalance.** Rebalances are predictable and public. A community
  member already lost ~$68 to zap slippage on this stack. Under a hostile
  keeper this stops being bad luck and becomes a repeatable withdrawal
  mechanism the attacker controls both sides of, which is why the slippage
  bound is computed by the contract and never passed in
- **Gas bleed.** Frequent rebalances on a small position can cost more than the
  position earns. Enforce a minimum position size and a cooldown
- **Dead pool exit.** Exiting an illiquid pool can be worse than holding. Needs
  a depth check before the exit path fires
- **Oracle or price manipulation.** Any price the agent reads to decide a
  rebalance can be moved. Use TWAP, never a spot read
- **Compromised keeper.** Covered above. The contract, not the operator, is
  what makes this survivable

## Tests that must pass before deploy

The first one is the only one that decides whether this ships:

- [ ] **hostile keeper cannot drain.** Give a test keeper full agent authority,
      a funded sandwich position on the other side, and unlimited rebalance and
      compound calls. Assert vault value in TWAP terms cannot fall further than
      the configured tolerance. If this test cannot be written, the model is not
      specified tightly enough to build
- [ ] agent cannot rebalance into any pool other than the one recorded at
      deposit
- [ ] agent-proposed tick ranges outside the TWAP band are clamped or rejected
- [ ] cumulative-loss breaker halts a slow drain that respects the per-day cap
- [ ] registry strategy parameters cannot be changed by the agent or an ops key
- [ ] owner revocation works without agent cooperation, in one transaction
- [ ] owner can always exit with no agent involvement at all
- [ ] agent role cannot move funds to any address other than the recorded owner.
      Necessary but **not** sufficient, and it passes even against a drained
      vault: theft goes through the swap path, not the transfer path
- [ ] minimum-improvement threshold prevents IL-negative rebalances
- [ ] full run on ganache against real Uniswap V3, not mocks
- [ ] `/security-review` clean

## Deploy steps

1. Compile with `evmVersion: "paris"` (CLAUDE.md gotcha 4)
2. Deploy `LpVault` and registry, verify sources immediately
3. Dogfood with own capital for at least a week before opening it up
4. Open to community with an explicit, honest cap on total value managed
5. Frontend: a delegate flow that shows exactly what the agent may and may not
   do, in plain language

## Rollback

Contracts are immutable. The owner-revocation path is the user-side rollback
and must work perfectly. Operator side, the keeper can be stopped instantly,
and stopping it must leave every position safe and withdrawable by its owner
with no agent involvement at all.

## Why this matters beyond the product

A working agent with real users, running on a stablecoin-gas chain, is the
proof point for everything in `docs/STRATEGY.md`. It is the difference between
describing a thesis and demonstrating one.
