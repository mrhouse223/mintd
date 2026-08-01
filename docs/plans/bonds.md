# Bonds

Status: shipped
Date: 2026-07-31

## What problem this solves

A memecoin dev who holds supply but no cash has exactly one way to fund
marketing today: sell into their own pool, which prints a red candle and tells
every holder the dev is dumping. A bond replaces that with a contract: the dev
escrows tokens up front, buyers pay USDT0 for them at a fixed discount, and the
tokens release over a vesting period instead of hitting the pool at once. The
dev gets cash without a visible dump, the buyer gets a discount in exchange for
locking up capital and taking price risk, and neither has to trust the other,
because the tokens are in the contract before a single dollar moves.

## Worked example (the one this plan is measured against)

$MENTOS, 1B supply, $100k mcap, so $0.0001 a token. The dev escrows 20,000,000
tokens (2% of supply, $2,000 at spot) and offers them for 1,000 USDT0, vesting
linearly over 30 days.

| | |
|---|---|
| Buyer pays | 1,000 USDT0 |
| Protocol fee (1%) | 10 USDT0 to the Safe |
| Dev nets | 990 USDT0 |
| Buyer receives | 20,000,000 MENTOS, released over 30 days |
| Face value at t0 | $2,000 |
| Discount | 50% |
| Breakeven price | $0.00005, exactly 50% of spot |
| Dev's cost of capital | 100% for 30 days |
| Supply released | 0.067% a day |

## Why APY is a display problem, not a calculation

The single biggest thing to get right on this page. The example bond's "APY" is
any of these, all arithmetically correct:

| Convention | Figure |
|---|---|
| Simple APR over the 30d term | 1,217% |
| Simple APR, duration-weighted (avg receipt lands day 15.5) | 2,355% |
| Compounded on the full term | 460,000% |
| True IRR of the daily cash flows | ~1,000,000,000% |

A page that prints the biggest of these is not being generous, it is lying, and
it is the kind of claim CLAUDE.md already forced a walk-back on twice. Three
decisions follow:

1. **The headline number is the discount and the term, not a yield.** "50% off,
   released over 30 days" is complete, checkable and needs no convention.
2. **The page shows simple APR over the term, and only that one.** Decided, not
   open: 1,217% for the worked example. It carries its assumption inline,
   "1,217% APR if the token price is unchanged", because the conditional is not
   fine print, it is the whole meaning. The other three conventions are never
   displayed.
3. **Breakeven price is shown next to it, always.** $0.00005 for this bond. It
   is the number that actually tells a buyer what they are risking, because the
   buyer does not receive $2,000, they receive 20,000,000 tokens.

Vesting makes the last point sharper: each tranche is received at whatever the
price is that day, so the buyer is whole if the *average* price across the 30
days holds above breakeven, not the price at the end.

## What it does not do

- **No oracle, no live discount.** The contract stores an absolute rate, tokens
  per USDT0, fixed at creation. "50% off" is a label the UI computes against the
  TWAP at creation time and never re-reads. This deletes an entire class of bugs
  (stale price, manipulated spot, pump-then-create) for zero lost functionality.
- **Allowlist only, no arbitrary ERC-20s.** Every mintd-launched coin, plus
  USDT0, FEFER, and STABLE once its fork test passes. See the allowlist section: the launchpad tokens are
  safe by construction, the three additions are not and had to be checked
  individually.
- **No push payouts.** Vesting is pull-based and computed. See the payout note.
- **No secondary market** in bond positions. A position is non-transferable in
  v1.
- **No refunds and no minimum raise** in v1. An underfilled bond simply sells
  fewer tokens and returns the rest.

## Token allowlist

v1 accepts a token only if it is on this list. Anything else is rejected at
creation, which closes most of the hostile-token surface below without needing
to detect anything at runtime.

**Every coin launched on mintd.** Measured, not assumed: MINTD, MENTOS and USDT1
all deploy to byte-identical 1,883-byte runtime, with no proxy, no `owner()`, and
no mint, pause or blacklist selector present. `MemeToken20` cannot rug an escrow,
so a bond on a launchpad coin only carries price risk.

**The three additions, audited on chain 2026-07-31:**

| Token | Finding | Escrowable |
|---|---|---|
| USDT0 `0x779Ded0c…` | **Upgradeable proxy.** Implementation `0xd797a3cb…` (18,094 bytes) carries `owner()`, `mint(address,uint256)` and `transferOwnership(address)`; proxy owner is `0x4DFF9b5b…`. No pause or blacklist selector today, but the implementation can be swapped and one added. | yes, with the caveat |
| STABLE `0x…1003` | **A native precompile, not a contract.** `eth_getCode` returns an 88-byte stub that decodes to `PUSH0 PUSH0 REVERT`, which is not what executes: calls are intercepted by the client and failures come back as `"fail to send in precompiled contract"`. Reads answer correctly (18 dec, 100bn supply) and `approve`/`allowance` work, but `transferFrom` reverted `"invalid coins"` on a zero-value probe, which a standard ERC-20 accepts. | **not yet, see below** |
| FEFER `0xeaf7aC0F…` | `DyorPumpToken`, verified, 11,687 bytes. Deployed ABI has **no mint, no owner, no pause, no blacklist** and no admin setter; the only state-changing entrypoints are the ERC-20 four plus `initialize` and `swap`. `_transfer` is plain OpenZeppelin, **no fee**. LP owner is `0x…dEaD`. | yes |

USDT0 being mutable is not a reason to drop it, since it is the chain's quote
asset and the entire site already depends on it. It is a reason not to extend
the "safe by construction" claim past the launchpad coins, and to say on the
page which of the two a given bond is.

### STABLE needs a live test before it is listed

It is the one token here whose behaviour is defined by the chain client rather
than by bytecode anyone can read. There is no source to review, no upgrade event
to watch, and its semantics can change with a node release leaving no on-chain
trace. That is a strictly stronger trust assumption than USDT0's proxy.

Concretely unresolved: `transferFrom` reverted on a zero-value probe. Escrow is
built on `transferFrom`, and a token that rejects zero-value transfers also
breaks the common "transfer the remainder, which may be zero" path at the end of
vesting. Whether it works for a real allowance cannot be settled read-only.

**So STABLE ships only after a ganache or fork test that actually performs
approve then `transferFrom` of a non-zero amount into a contract, and a zero-value
transfer out.** If either fails it does not go on the list. Everything else here
can be built without waiting on that.

### FEFER had a gate worth catching

Its `_transfer` is overridden with
`require(complete || isLiquidityPool(from) || isLiquidityPool(to))`, so before
the bonding curve completes, wallet-to-wallet transfers revert and a bond
contract (not a pool) could neither receive escrow nor pay out. Read on chain:
`complete == true`, and nothing in the ABI can set it false, so the gate is
permanently open and FEFER is safe to escrow today.

It is still the reason the allowlist is manual. A DyorPump token that has *not*
completed would take escrow and then fail every payout, which is failure mode 1
arriving through a side door rather than through a malicious owner. Any future
addition gets the same read.

## Contracts touched

New: `BondMarket`, one contract holding all bonds, or `BondFactory` plus per-bond
clones. Leaning single-contract with a `bonds[id]` mapping, since per-bond clones
buy isolation this design does not need and cost gas on every create.

It holds, at once:
- the dev's escrowed tokens, from creation until fully claimed or reclaimed
- buyers' USDT0, from purchase until the dev withdraws it

**Does this touch user funds? Yes, both sides of the trade.** `/security-review`
before deploy, no exceptions.

Existing contracts modified: none. The frontend gains a Bonds view and the
stats indexer optionally learns to count bond escrow, which it must NOT add to
TVL (escrowed tokens are not deposited capital, same reasoning that excludes the
locker).

## Parameters the dev sets

| Field | Notes |
|---|---|
| Token | v1: must be on the allowlist |
| Amount | tokens escrowed, measured by balance delta on receipt |
| Price | absolute, tokens per USDT0. UI shows the implied discount |
| Sale window | open and close timestamps |
| Vesting period | e.g. 30 days |
| Vesting mode | per-second linear, or stepped every 10 minutes |
| Per-wallet cap | see sniping below |

The 1% protocol fee is not a per-bond field. It is contract-level and the dev
cannot set or waive it.

Note that **discount, period and APY are not three independent inputs.** Fixing
any two determines the third. The dev sets discount and period; APY is derived
and displayed. Offering all three as fields lets them disagree and there is no
correct way to resolve that.

## Protocol fee

**1% of every bond purchase, to the Safe `0xE5F40204C8E921834C70B0E2631bE79F076B0e28`.**
That matches the launchpad, whose `feeRecipient` is already the Safe, rather
than MINTR and MintSynth, which route to `BuybackBurner`. Worth being deliberate
about: bond fees will not buy and burn MINTD unless the recipient is later
pointed at the burner, which is a one-call change if that is wanted.

Three implementation points that are not cosmetic:

- **Charged on the USDT0 leg only, never the token leg.** Taking a cut of the
  escrowed tokens would change the amount being vested after buyers have already
  priced the bond, and it would put protocol revenue in a memecoin rather than a
  stablecoin.
- **Taken at purchase, not at claim.** A fee skimmed off each vesting tranche
  would have to divide 4,320 times and every division loses dust, which is
  failure mode 6 below reintroduced deliberately. At purchase it is one
  subtraction on one transfer.
- **Deducted from the raise, not added on top.** A buyer paying for a bond
  advertised at 1,000 USDT0 pays exactly 1,000; the dev nets 990. The alternative
  (buyer pays 1,010) means the headline number is not what leaves the wallet,
  and the discount the page advertises quietly stops being the discount received.

Settable by the owner within a hard cap in the contract, the way
`MintSynth.setFees` is bounded, so a compromised owner cannot raise it to 100%.
Cap suggestion: 300 bps.

## How it can lose money

1. **Hostile token, the largest surface by far.** An ERC-20 can take a fee on
   transfer (escrow receives less than the bond advertises), rebase (balance
   moves after deposit and the vesting maths pays out the wrong amount),
   blacklist the bond contract (every payout reverts forever and buyers lose the
   whole purchase), mint fresh supply (dilutes the vesting tranches to nothing
   mid-term), or pause transfers. The allowlist is what closes this, and it is
   why the list is not open. Note it does NOT close it for the three additions:
   USDT0 is upgradeable and mintable today, so a bond escrowing USDT0 is trusting
   its proxy owner for the length of the term. Deposits are measured by balance
   delta rather than the stated amount regardless, because that is correct even
   for a token that behaves.
2. **Dev dumps the other 8% while the bond vests.** Not preventable by any
   contract. It is also the single most likely way a buyer loses. The page must
   show the creator's remaining balance and whether any of it is locked in
   `TokenLocker`, and a bond whose dev has locked supply should say so loudly.
3. **Price falls below breakeven.** Inherent and intended: it is what the buyer
   is paid the discount to accept. Mitigated by disclosure, not by code.
4. **A 50% discount at a fixed price is free money, so a bot takes all of it in
   the first block.** Stable's front-running hole is documented and unfixed. A
   per-wallet cap raises the cost without solving it, because bots split across
   wallets. **Decision taken: no Dutch auction, no batch auction.** v1 ships the
   fixed price plus the cap, which means a bond at a steep discount should be
   expected to fill to bots rather than to the community, and the page must not
   imply otherwise. Devs who care about who gets the allocation should set a
   smaller discount, which is the lever they actually have.
5. **Reentrancy on claim**, if a token calls back on transfer. Checks-effects-
   interactions plus a guard.
6. **Rounding and stranded dust.** Vesting must be `owed = total * elapsed /
   duration - claimed`, never an incremental per-call division, and the final
   claim must sweep the remainder or dust strands forever.
7. **USDT0 is dual-decimal** (gotcha 6). Quote amounts are 6-dec, token amounts
   18-dec. A missing 1e12 here is a 1,000,000x mispricing and this repo has
   already been bitten by it once.
8. **Dev withdrawing escrow after buyers have paid.** Must be impossible.
   Reclaim is limited to the unsold remainder and only after the window closes.
9. **A dev who never closes the sale.** Close must be time-based and
   permissionless, never an admin call, or a dev can strand buyer funds.
10. **Griefing by spam bonds.** A creation fee, as the launchpad does.

## Open decisions

- Payout mode: pull-based accrual is assumed throughout. Genuine push payouts
  every 10 minutes are 4,320 transfers per holder per bond, which nobody wants
  to pay for. "Every 10 minutes" is therefore implemented as a stepped accrual
  curve the buyer claims against, which is economically identical and costs one
  transaction.
- Whether v1 requires the dev to lock remaining supply to list.

## Build status

`BondMarket.sol` and `scripts/test-bonds.js` are written and green: **47 tests,
0 failures**, on ganache. `/security-review` has been run and returned **no HIGH
or MEDIUM findings**; it verified conservation across the rebuy branch and the
reentrancy ordering empirically rather than by reading. Four of its lower-severity
items were applied:

- the fee is now snapshotted per bond, so `setParams` cannot move the rate on a
  raise a creator has already priced and advertised
- `isAllowed(address(0))` returns false, instead of matching a pad's zero struct
- `view_` reports zero remaining once a bond has been reclaimed
- `addPad` emits `PadAdded` and rejects the zero address

It also found a real gap in the suite: buying twice on the same bond, the only
place `p.claimed` is reset, was untested. Covered now, to the wei.

**Deployed 2026-07-31 to `0xD98780804449cC3b01Cd9A37fbaD808d01e24383`**, verified on
stablescan. Read back on chain at deploy: feeRecipient is the Safe, feeBps 100,
createFee 1.0 native, two pads registered, FEFER listed, zero address rejected,
not paused, and a launchpad coin allowed with no listing. Ownership was moved to
the Safe `0xE5F40204…` in the same run, so the deploying key holds nothing.

Deployed from `OWNER_KEY`, never the compromised deployer; the script refuses
that address outright.

Allowlist as shipped: every launchpad coin (via the pads) plus FEFER. **STABLE is
not listed** and stays off until its fork test passes. USDT0 is the quote asset
and is not listed as bondable; one Safe call adds it if that was the intent.

Still to do: the STABLE fork test, and docs copy for the Bonds page.

## Tests that must pass before deploy

- [ ] existing suite still green (`test-instant.js`, `test-synth.js`,
      `test-arb-multi.js`)
- [ ] full lifecycle: create, partial fill, close, vest, claim, reclaim unsold
- [ ] vesting maths: claim every block vs claim once at the end pay the same
      total to the wei, both modes
- [ ] final claim leaves zero dust in the contract
- [ ] dev cannot withdraw escrow that has been sold, at any point in the window
- [ ] buyer cannot claim ahead of schedule, including at exactly t=start
- [ ] 6-dec USDT0 against 18-dec token, asserting an exact expected wei figure
- [ ] reentrant token cannot drain via claim
- [ ] fee-on-transfer token escrows its true delta, not the stated amount
- [ ] per-wallet cap holds across multiple purchases from one address
- [ ] 1% fee lands at the Safe, dev nets exactly 99%, and the two sum to the
      buyer's payment to the wei across a range of odd amounts
- [ ] fee cap cannot be exceeded by the owner
- [ ] STABLE: approve then non-zero `transferFrom` into the contract, and a
      zero-value transfer out, both against a fork. Blocking for STABLE only
- [ ] FEFER: escrow and full vest end to end, asserting `complete` is read at
      creation and a non-complete DyorPump token is rejected
- [ ] a token that reverts on zero-value transfer cannot strand a final claim
- [ ] explicit `gasLimit` on every state-changing call (gotcha 8)
- [ ] ganache with real Uniswap V2, matching the other suites

## Deploy steps

1. `node scripts/compile.js`, confirming `evmVersion: "paris"` (gotcha 4)
2. `/security-review` on `BondMarket`, blocking
3. Deploy script plus dry run on ganache
4. Verify on stablescan via `scripts/verify-core.js` (add to `CORE`)
5. Read back on chain: creation fee, bond fee bps (100), fee recipient (the
   Safe), owner
6. Frontend: Bonds view, plus `features.bonds` gated to Stable

## Rollback

`BondMarket` holds live escrow and buyer funds, so it cannot be meaningfully
rolled back once a bond exists. The frontend can stop listing it within 20
seconds via a push, which stops new bonds but does nothing for open ones. Any
in-flight bond must be able to complete without the site. That makes the review
step mandatory rather than advisory, and argues for a pause that blocks *new*
bonds while never blocking claims on existing ones.
