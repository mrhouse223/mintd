# arcswap terminal, fee-taking swap, and the ARX relaunch

**Status:** DRAFT, not approved, no code written.
**Date:** 2026-07-30
**Chain:** Arc mainnet (5042). Nothing here touches mintd.fun or Stable.

Two requests, tracked together because the second changes what the first has to
display.

---

## A. Terminal / screener and a swap page for whitelisted Arc coins

### What it is

A screener listing top Arc coins chosen by hand (contract addresses supplied by
the operator), and a swap page that trades them, taking a 1% platform fee.

Today's screener only lists tokens launched through our own pad, because it
enumerates `allTokens(i)`. A whitelist is a second source: an array of contract
addresses in the chain config, each resolved to its Uniswap V3 pool.

### What already works, and what does not

| Piece | State |
|---|---|
| Reading token metadata and pool reserves | Works. `eth_call` through the Arc RPC. |
| Uniswap V3 router on Arc | Confirmed live at `0x53BF6B06…`, `exactInputSingle` selector present. |
| Price and market cap from `slot0` | Works. |
| **Quoting a swap** | **No QuoterV2 address is known on Arc.** Blocking. |
| **Charts and trade history** | **Blocked.** `eth_getLogs` is disabled on the RPC and unavailable on the explorer. |

Two things are genuinely unsolved and must be settled before this is buildable:

**Quoting.** Three options, in my order of preference:

1. Deploy our own `QuoterV2`. Standard Uniswap periphery, needs the factory
   address (we have it) and a WETH9 (Arc's gas token is USDC, so this needs
   checking). Cleanest and reusable.
2. `staticCall` the swap itself as the connected user. Accurate and needs no new
   contract, but only works once the user holds the input token and has approved,
   so the page cannot quote before that.
3. Compute from `slot0` and `liquidity` in the browser. No deploy, but wrong the
   moment a swap crosses a tick, which is exactly when the number matters.

**Charts.** Without logs there is no price history and no trade feed. A "terminal"
implying candles cannot be built on the current data. Options: find an Arc RPC
that serves `eth_getLogs`, run our own indexer against one, or ship the screener
without charts and say so.

### The 1% fee needs a contract

Uniswap's router pays the whole output to the recipient; there is no fee hook. So
a small `SwapFeeRouter`:

- user approves `SwapFeeRouter` for the input token
- it pulls `amountIn`, sends 1% to an immutable `feeRecipient`
- it approves the Uniswap router for the remaining 99% and calls
  `exactInputSingle` with `recipient = msg.sender`
- it holds nothing between calls and has no admin withdrawal path

Immutable `feeRecipient` and `feeBps`, with a hard `MAX_FEE_BPS`, same shape as
`BridgeFeeRouter`, which is already deployed and reviewed.

### How it can lose money

This section is the point of the exercise, so it is not left thin.

- **Fee-on-transfer or rebasing whitelisted tokens.** Exact-input maths assumes
  the amount sent equals the amount received. A token that takes a cut leaves the
  router short and the swap reverts, or worse, leaves dust that the next caller
  can sweep. Mitigation: measure balances before and after rather than trusting
  `amountIn`, and refuse tokens where the two disagree.
- **A malicious whitelisted token.** The whitelist is a trust statement. A
  honeypot that permits buys and blocks sells will be read by users as vetted by
  us. Mitigation: state plainly on the page that listing is not endorsement, and
  simulate a sell before listing.
- **Approvals to our contract.** Every user who swaps grants an allowance. If the
  contract has any path that can move tokens other than the swap it was asked
  for, that allowance is drainable. Mitigation: no admin functions at all, no
  `transferFrom` except from `msg.sender` inside the swap, and a security review
  before deploy.
- **Slippage with the fee applied.** The user sees a quote on the full amount but
  only 99% reaches the pool. If `amountOutMinimum` is computed from the pre-fee
  amount, every swap reverts. Mitigation: quote the post-fee amount, and test it.
- **Fee recipient set wrong.** `BridgeFeeRouter` shipped with a `feeRecipient`
  that was not the address asked for, and it is immutable. Verify by reading it
  back on chain after deploy, before announcing.

### Tests required before deploy

`scripts/test-swap-fee-router.js`, against real ganache and a real Uniswap V2/V3
fork: fee is exactly 1%, output goes to the caller and not the router, the router
holds a zero balance after every path, a fee-on-transfer token is rejected rather
than mis-swapped, `MAX_FEE_BPS` cannot be exceeded, and there is no path that
moves a user's tokens other than the requested swap. Explicit `gasLimit` on every
state-changing call, per the `eth_estimateGas` trap in CLAUDE.md.

---

## B. Relaunch ARCS as ARX, with the V3 LP held in the dev wallet

### Two independent changes

1. **A rename**, ARCS to ARX. Cheap: a token's name and symbol are set at launch,
   so it means launching a new token. The stated reason is that "ARCS" sits too
   close to the chain's own name and might be taken down. I cannot verify that
   risk either way; it is a judgement call for the operator, not a technical one.
2. **LP in the dev wallet instead of locked.** This is not cheap, and it is not
   just a new deploy.

### Why the LP change needs a new contract

`MintdLaunchpad` mints the position to itself and has no code path that can
withdraw liquidity. That is the product. Keeping the LP means a different
launcher that transfers the position NFT to the deployer.

That is a contract touching user funds, so per CLAUDE.md it needs this plan
approved, tests, and `/security-review` before deploy.

### The part that must not be glossed over

**The site currently promises the opposite.** Verbatim, on the homepage today:

> permanently locked USDC pool on Uniswap V3, so there is no migration and no LP
> withdrawal, ever

and token pages show an **LP locked forever** badge, and the docs say the
launchpad has *"no code path to withdraw liquidity: it is locked forever,
verifiable onchain"*.

If ARX's liquidity sits in a wallet, all of that is false for the platform's own
flagship token, which is the one every buyer checks hardest. Either the copy
changes wherever it could be read as covering ARX, or the site misrepresents it.
CLAUDE.md already records two public claims that had to be walked back; this
would be a third and a worse one, because it concerns custody rather than a
launch date.

Not an argument against doing it. Plenty of legitimate projects hold their own
LP. It is an argument that the copy change ships in the same commit as the token.

### The part that affects other people

Measured on chain today, ARCS `0xeB4943B3…`:

| Holder | Tokens | Share |
|---|---|---|
| Pool | 434,505,570 | 43.45% |
| Signer `0xD1E363…` | 51,470,671 | 5.15% |
| Dev `0x64838C…` | 589,638 | 0.06% |
| **Everyone else** | **513,434,120** | **51.34%** |

Pool holds **2,897 USDC** of real money.

Note the 51% dev position was never actually taken: the launch dev buy landed
about 5%, and the follow-up market buy to 51% appears not to have run. A majority
of supply is in public hands.

So relaunching and repointing the site delists a token where **the majority of
supply belongs to other people**. That is materially different from the two
earlier delistings: the 3,000 start was a test nobody held, and the first 2,000
start had 46 holders. This one is the majority of the float.

Options, in the order I would rank them:

1. **Keep ARCS as the platform token, do not relaunch.** Rename the *site* copy
   if the concern is association with the chain's name. Costs nothing, strands
   nobody.
2. **Launch ARX and keep ARCS listed** as an ordinary coin. Its holders keep a
   tradable, visible token; ARX becomes the platform token. Two tickers to
   explain, but nobody is hidden.
3. **Launch ARX and delist ARCS.** Cleanest presentation, and 513 million tokens
   held by other people become invisible on the site that sold them.

### How it can lose money

- **LP in a wallet is a single key holding all the liquidity.** If that key is
  lost the liquidity is unrecoverable; if it is compromised the liquidity is
  gone. The current deployer key history in this repo is not reassuring: one key
  is already burned and still holds funds. A new wallet must be created by the
  operator, never generated or handled here.
- **Buyers pricing ARX as if it were locked.** If the copy is not fixed, the
  token trades on a false premise, and the correction is a rug in everyone's eyes
  whether or not anything is withdrawn.
- **Fee share snapshotting.** The existing pad snapshots `creatorShareBps` per
  launch, which the new one must keep, or a later config change silently rewrites
  what past creators were promised.

---

## Open questions

1. Quoting: deploy our own `QuoterV2`, or `staticCall` and accept quoting only
   after approval?
2. Charts: ship the screener without price history, or find an RPC serving
   `eth_getLogs` first?
3. ARX: which of the three options above for the existing ARCS holders?
4. Does the "permanently locked" copy change site-wide, or only on ARX's page?
5. Whitelist: the contract addresses, and confirmation that listing is presented
   as "listed, not endorsed".

## Not started

Nothing. No contract written, nothing deployed.
