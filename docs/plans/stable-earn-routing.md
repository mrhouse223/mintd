# Route mintd.fun into StableEarn

**Status:** DRAFT, not approved, no code written.
**Date:** 2026-07-30
**Chain:** Stable (988), mintd.fun only.

Chosen over the chain-wide pools page after measuring both: active DEX liquidity
on Stable is about $190k, while a single lending vault holds $30.5m. See
`stable-pools-and-agent-vaults.md` for those numbers.

---

## The target, read on chain

```
vault    0xb7df8db22a5dbbfa9ebeb94b3910aec6a4f05c08
name     StableEarn (gtusdtb), ERC-4626, 18-dec shares
asset    0x779Ded0c9e1022225f8E0630b35a9b54bE713736   <- USDT0, 6-dec
```

| | |
|---|---|
| Total assets | 30,565,597 USDT0 |
| Withdrawable liquidity | $13.34m |
| Net APY | 7.00%, of which **3.92% is "rewards"** |
| Performance / management fee | 0.00% |
| Curator | Gauntlet, $886m curator TVL |
| Deployed | 2 Dec 2025 |
| Share price | 1 share = 2.0122 USDT0 |
| Gates (`receiveSharesGate` etc.) | all zero address, **permissionless** |
| `maxDeposit(anyone)` | **0** |

Two findings that shape the build:

**It is a plain ERC-4626 whose asset is the USDT0 our whole stack already
handles.** No adapter, no bespoke integration: `approve` then `deposit`, and
`redeem` to exit. The dual-decimal trap in CLAUDE.md applies as usual, shares are
18-dec while the asset is 6-dec, and mixing them is the 1,000,000x error.

**It is currently at its supply cap.** All four gates are open, so this is not an
allowlist; `maxDeposit` returning 0 means no new deposits are accepted right now.
Its TVL went from $19.59m to $30.53m over the past month, so caps are clearly
raised periodically. A deposit page must therefore treat "cap full" as a normal,
first-class state that it reads before offering the button, not as an error.

---

## What to build

### Option 1, recommended first: route directly, no contract of ours

A page on mintd.fun that lets a connected wallet deposit USDT0 into the vault and
redeem out of it, showing position value, share price and the live APY.

- No new contract, so nothing to audit and no custody we introduce.
- ERC-4626 is standard, so this is approve, deposit, redeem, plus reads.
- We earn nothing from it. It is a utility that keeps users on mintd.fun and
  gives the site a reason to exist for people who are not launching memecoins.

### Option 2, later if usage justifies it: our own wrapper

An ERC-4626 of ours that deposits into StableEarn and takes a cut of the yield.

- Monetisable: 10% of a 7% yield is 0.7% on deposits.
- Adds a contract holding user funds, so plan, tests and `/security-review`
  before deploy, and it is immutable once out.
- The honest question it has to answer is what it adds for the user, since they
  can deposit into StableEarn directly for free. UX and being inside mintd.fun
  is a real answer, but a thin one, and a fee on someone else's yield invites
  the comparison.
- It also inherits the cap problem: if the underlying will not accept deposits,
  our wrapper's deposits revert too, and now it is our contract that looks
  broken.

**Recommendation:** build Option 1. It is days rather than weeks, carries no
smart-contract risk we created, and tells us whether anyone actually wants this
before we write a vault to tax it.

---

## How it can lose money

- **It is someone else's risk on our page.** A depositor who loses money in
  StableEarn will hold mintd.fun responsible, because that is where they clicked
  the button. Morpho and Gauntlet are credible and the fees are zero, but the
  page must name the vault, the curator and the fact that mintd.fun neither
  operates nor insures it, in the interface rather than in a docs page.
- **The 7% is not ours to promise and is not one number.** 3.92 of those 7
  points are "rewards", which are typically incentives that can be reduced or
  stopped. Displaying "7.00% APY" as a headline without splitting base yield from
  rewards is the same class of claim as the 2714% fee APR rejected in the pools
  plan.
- **Withdrawal liquidity is less than half of deposits.** $13.34m liquid against
  $30.53m deposited. That is normal for lending, and it means a rush cannot all
  exit at once. `maxWithdraw` must be read and shown, and the page must never
  imply funds are instantly available for any size.
- **Deposits currently revert.** `maxDeposit` is 0. Shipping a deposit button
  without reading it first produces a failed transaction and a user who thinks
  the site is broken.
- **Decimal mixing.** Shares 18-dec, asset 6-dec. Every conversion goes through
  `convertToAssets` / `convertToShares` rather than arithmetic on our side.
- **Approval scope.** Approve exactly the deposit amount, not infinite, since
  the spender is a third-party contract.

## Open questions

1. Option 1 now, or straight to the fee-taking wrapper?
2. Where does it live: a new Earn tab section, or its own page?
3. Do we show it while `maxDeposit` is 0, as a read-only "at capacity" panel, or
   hide the whole thing until it reopens?

## Not started

Nothing. No code written, nothing deployed.
