# Buyback vault (user-owned agents)

Status: shipped
Date: 2026-08-03

## What problem this solves

`BuybackBurner` is one reservoir, for one token, funded by protocol fees, and
whatever goes in can never come out. That is right for MINTD and useless as a
product: nobody is going to send money to an address they can never withdraw
from so that somebody else's coin gets burned.

This is the version a user would actually fund. Anyone deploys their own vault,
deposits USDT0, points it at a coin, and an agent buys that coin on a rule.
Every trade is an event on chain, so "see what the agent did" is a log query
rather than a screenshot. The owner can withdraw at any time, in any state, and
nobody else ever can.

## The security model, inherited rather than invented

`AgentVault` already solved the hard half of this and has been reviewed. The
same shape applies here and should not be redesigned:

- **`owner` is immutable, set at construction.** Every withdrawal goes there and
  only there. Not a settable field, so there is no "change owner" call to steal.
- **The keeper passes no price parameter at all.** This is the single most
  important line in `AgentVault` and it carries over unchanged. If the keeper
  supplied `minOut`, a compromised keeper would set it near zero and sandwich its
  own trade. Instead the vault computes the minimum output itself from the
  pool's TWAP, and the keeper supplies only *timing*.
- **The pool is validated against the canonical Uniswap factory at
  construction.** Otherwise a hostile keeper points the vault at a fake pool,
  reads a fake TWAP, and every other protection is reading a number the attacker
  chose.
- **Bounded size and a cooldown.** A slice of the reserve per execution, not the
  balance, and a minimum interval between executions. A keeper that fires in a
  loop wastes gas rather than draining the vault into slippage.
- **Owner can revoke the agent, and withdraw with the agent still set.**
  Withdrawal must never depend on the keeper being alive or cooperative.

If the keeper is fully compromised the worst case is wasted gas and trades
executed at TWAP-bounded prices at bad *times*. It cannot choose a price, a
venue, or a recipient. `test-agent-vault.js` contains the hostile-keeper test
that has to prove it; this vault needs its own copy.

## The open question, which changes the contract

**Where do the bought tokens go?** Two readings of the request, and they are
different products:

**A. DCA vault (recommended, and what this plan assumes).** Bought tokens stay
in the vault. The owner withdraws USDT0, the token, or both, whenever they like.
The agent is a scheduled buyer working for its owner. "Deposit and withdraw"
reads naturally, the owner is never worse off than holding, and the vault is the
user's property throughout.

**B. Burn agent.** Bought tokens go straight to `0x…dEaD`. The owner can only
withdraw USDT0 that has not been spent yet. This is a public good funded by one
person, and the deposit is a donation with a delayed trigger. Defensible for a
project's own treasury, strange for a stranger.

They differ in the contract, the UI, and the tax story, so this is not a flag to
be added later. **A is confirmed and built.** If B is wanted it is a separate mode set
at construction and never changeable, because a vault that can switch from
"yours" to "burned" after you deposit is a rug with extra steps.

## What it does not do

- **No pooled deposits.** One vault, one owner. Pooled deposits mean share
  accounting, a share price, donation attacks on the first depositor, and a
  much larger review. Each user gets their own vault from a factory, exactly as
  `AgentVaultFactory` does it.
- **No selling in v1.** Buy and hold, owner withdraws. Selling doubles the
  surface and the countercyclical rule is buy-biased anyway.
- **No allowlist of tokens.** Any canonical Uniswap V3 pool. A user who points
  their own vault at a bad pool harms only themselves, and an allowlist needs an
  admin, which is the thing this design spends its budget avoiding.
- **No protocol fee in v1.** A fee puts mintd in the path of user funds it
  currently never touches. Separate decision, separate plan.

## Build status

`BuybackVault.sol`, `BuybackVaultFactory.sol` and `scripts/test-buyback-vault.js`
are written and green: **38 tests, 0 failures**. `/security-review` found one
HIGH, one LOW and one that would have bricked the thing in production. All three
are fixed and each has a test:

- **HIGH, stale oracle.** `observe()` does not revert when a pool has no recent
  history: it EXTRAPOLATES from the current tick, so the "TWAP" comes back
  byte-identical to spot and `minOut` is derived from whatever price an attacker
  last pushed it to. Push the price in a pool nobody trades, wait out the
  window, and a 500 USDT0 slice fills at half value against a stated 1% bound.
  `scripts/seed-twap.js` already said this in the repo ("the protection is not
  broken, it is unarmed") and the contract's comment claimed the opposite.
  `_twapTick` now requires cardinality >= 2 and an observation newer than the
  window, because a degenerate TWAP still yields a healthy-looking `minOut`.
- **LOW, `cooldown` was unbounded.** Zero made the slice cap vacuous: a keeper
  could call `execute()` back to back in one block. Floor of 60s.
- **Would not have run at all.** The default tolerance was a flat 1% while every
  launchpad pool is the 1% fee tier. Router output is net of the fee and the
  TWAP is not, so every fill would land under the minimum and revert. The
  default is now derived from the pool's own fee tier, fee + 1%. No mock would
  have caught this, since the mock router charges no fee.

**A sell path was added after the first review**, on request, matching DCR:
`executeSell()` gated on the vault being overweight the token (2x by default).
That invalidated the first review's reasoning that buy-only was self-limiting,
so a cumulative drawdown breaker came with it. A second review then found a HIGH
I had introduced: `deposit()` is permissionless and ASSIGNED the high-water mark,
so a keeper paying in one raw unit (0.000001 USDT0) rebased the mark to wherever
its grinding left the vault and disarmed the breaker entirely, measured at ~9% of
the vault a day to zero for about 2 USDT0 of deposits. `AgentVault`'s header
names this exact attack and ratchets upward only. Fixed with delta accounting
(`valueCheckpoint += got`), which also arms the mark when the oracle is unusable
instead of leaving it at zero with no floor. Regression test included.

**Deployed 2026-08-03. `BuybackVaultFactory` at
`0x3db601869c2C47Bfa9b08c62E077Df4806C1283A`**, verified on stablescan, no owner
and holds nothing. This replaced a first factory at `0xAEfc1555cF…` deployed the
same day, to add `depositToken`. Vaults from the old one still work and are still
fully withdrawable by their owners; they simply are not listed. One existed, at
`0x31f8111740B605e16eCB7eA047b855F1A56b8514`, holding 10 USDT0, and its owner
recovers it by calling `withdrawAll()` on that address directly. Confirmed live at deploy that a real pool builds a vault and
a non-pool address is rejected. 54 tests.

Still to do: the keeper that actually calls `execute` / `executeSell` on a rule.
Until then vaults are owner-driven, which is safe but not yet autonomous.

## Contracts touched

New: `BuybackVault`, and `BuybackVaultFactory` so `isVault(x)` is what proves an
address is a real one rather than a lookalike with a hostile router in it.

**Does this touch user funds? Yes, and unlike everything else here it has a
withdrawal path, which makes it the highest-risk contract in the repo.**
`/security-review` before deploy, no exceptions, and the hostile-keeper test is
the one that matters most.

## How it can lose money

1. **Compromised keeper.** Addressed above by construction: no price parameter,
   TWAP-derived minimum, bounded size, cooldown, owner-only withdrawal. The test
   suite has to demonstrate each, not assert them in a comment.
2. **Manipulated TWAP.** A thin pool's TWAP is movable if the window is short.
   Default 30 minutes as `AgentVault` uses, owner-adjustable upward, and the
   pool's observation cardinality must be checked at construction or the TWAP
   silently degrades to spot.
3. **Front-running.** Stable's hole is documented and unfixed. Randomised
   intervals, small slices, and never publishing the next execution time.
4. **Dust and rounding on withdrawal.** Withdrawal must move the real balance
   read at call time, not a cached figure, or the last withdrawal strands
   whatever arrived in between.
5. **USDT0 is dual-decimal.** 6-dec as an ERC-20, 18-dec native. Every amount in
   this contract is the 6-dec one. A missing 1e12 is a 1,000,000x error and this
   repo has been bitten once already.
6. **A token that reverts on zero-value transfer**, which STABLE's precompile
   appears to do, would brick a withdrawal that sweeps a zero balance. Skip
   zero-value legs rather than sending them.
7. **Reentrancy** through a hostile token on withdraw or on swap output.
   Checks-effects-interactions plus a guard, as everywhere else here.

## Tests that must pass before deploy

- [ ] hostile keeper: cannot withdraw, cannot set a recipient, cannot pass a
      price, cannot exceed the size cap, cannot beat the cooldown
- [ ] owner can withdraw both assets at any point, including with the agent set,
      mid-cooldown, and after the agent is revoked
- [ ] minimum output is derived from the TWAP, and a pool pushed 10% away from
      TWAP makes the execution revert rather than fill
- [ ] a vault constructed against a non-canonical pool is rejected
- [ ] 6-dec USDT0 against an 18-dec token, asserting exact wei
- [ ] withdrawal of a zero balance does not revert the whole call
- [ ] reentrant token cannot drain on withdraw or on execute
- [ ] factory: `isVault` true only for its own deployments, and the vault's
      owner is the caller, not the factory
- [ ] explicit `gasLimit` on every state-changing call (gotcha 8)

## Deploy steps

1. `node scripts/compile.js` with `evmVersion: "paris"` (gotcha 4)
2. `/security-review`, blocking
3. Deploy the factory only. Vaults are user-deployed.
4. Read back: factory's vault implementation, and that a test vault's `owner` is
   the caller
5. Frontend: the Agents page gains create / deposit / withdraw and a trade list
   read from `Executed` events

## Rollback

Vaults are user-owned and immutable once deployed, so there is no rollback for
one that exists. The factory can be dropped from the frontend within 20 seconds,
which stops new vaults and does nothing for existing ones. Every vault must
therefore be able to be withdrawn from without the site: the owner calling
`withdraw()` from a block explorer has to be sufficient, and the review should
confirm it is.
