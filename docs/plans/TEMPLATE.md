# <feature name>

Status: draft | approved | building | shipped
Date:

## What problem this solves

One paragraph. If this cannot be written without hedging, the feature is not
understood well enough to build yet.

## What it does not do

Scope limits stated up front. This is the section that prevents a two-day
feature becoming a two-week one.

## Contracts touched

- New contracts, and what each holds
- Existing contracts modified, and whether the change is upgrade-safe
- **Does this touch user funds?** If yes, this plan needs `/security-review`
  before deploy, no exceptions

## How it can lose money

Every path where a user or the protocol can end up with less than they started.
Slippage, rounding, oracle staleness, reentrancy, front-running, decimal
mismatches. If this section is empty the plan is not finished.

## Tests that must pass before deploy

- [ ] existing suite still green
- [ ] new tests covering each failure mode above
- [ ] tested against a fork or ganache, not just unit-level

## Deploy steps

1. Compile with `evmVersion: "paris"` (see CLAUDE.md gotcha 4)
2. Deploy script and its dry run
3. Verification: what to read on chain to confirm it worked
4. Frontend and indexer changes needed, if any

## Rollback

What to do if it is wrong after deploy. If the answer is "nothing, it is
immutable", say so explicitly and treat the review step as mandatory.
