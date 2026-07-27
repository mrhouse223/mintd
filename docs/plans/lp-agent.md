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

- No custody of principal. See the security model below, which is the whole
  design constraint
- No cross-chain routing in v1. One chain, one venue
- No discretionary trading. It manages a position, it does not take views
- No new token

## Security model

**This is the section that matters.** An agent with permission to move user
funds is a target, and the keeper key lives on a server.

The rule: the agent can rebalance a position but must never be able to send
principal to an arbitrary address. Concretely:

- User funds sit in a per-user vault contract, not in the agent's wallet
- The agent holds a role that can only call rebalance, compound and exit
- Exit always returns funds to the **owner address recorded at deposit**, and
  that address is immutable after creation
- The owner can revoke the agent's role at any time, in one transaction,
  without the agent's cooperation
- Per-transaction and per-day caps on value moved, enforced in the contract
- The keeper key is gas-only, exactly like the arb keeper

If the keeper key is fully compromised, the worst case must be wasted gas and
badly timed rebalances, never stolen principal. Write the test that proves it.

## Contracts touched

- New: `LpVault` (per-user custody, owner-immutable, role-gated agent actions)
- New: `LpAgentRegistry` (which vaults the agent is authorised over, and the
  strategy parameters for each)
- Reads existing: Uniswap V3 NPM, QuoterV2, MintSwap pairs
- Off-chain: `scripts/lp-agent.js`, modelled on `arb-keeper-multi.js`, using
  `batchMaxCount: 1` per CLAUDE.md gotcha 1

Touches user funds. `/security-review` before deploy, no exceptions.

## How it can lose money

- **Rebalance into a worse range.** Every rebalance realises impermanent loss.
  An agent that rebalances too eagerly loses more to IL than it earns in fees.
  Needs a minimum-improvement threshold, not just an out-of-range trigger
- **Sandwich on rebalance.** Rebalances are predictable and public. Slippage
  limits are mandatory, and a community member already lost ~$68 to zap
  slippage on this stack
- **Gas bleed.** Frequent rebalances on a small position can cost more than the
  position earns. Enforce a minimum position size and a cooldown
- **Dead pool exit.** Exiting an illiquid pool can be worse than holding. Needs
  a depth check before the exit path fires
- **Oracle or price manipulation.** Any price the agent reads to decide a
  rebalance can be moved. Use TWAP, never a spot read
- **Compromised keeper.** Covered above. The contract, not the operator, is
  what makes this survivable

## Tests that must pass before deploy

- [ ] agent role cannot move funds to any address other than the recorded owner
- [ ] owner revocation works without agent cooperation, in one transaction
- [ ] per-tx and per-day caps hold under a hostile keeper
- [ ] rebalance respects slippage limits under a sandwich simulation
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
