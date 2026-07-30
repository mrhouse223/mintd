# Stable: a chain-wide pools page, and agent-managed LP vaults

**Status:** DRAFT, not approved, no code written.
**Date:** 2026-07-30
**Chain:** Stable (988), mintd.fun. Nothing here touches arcswap or Arc.

The request is two products in one sentence. They share a page but almost no
code, and one is far riskier than the other, so they are planned separately and
can ship separately.

- **A.** A page listing the largest pools on Stable, chain-wide, where a
  connected wallet can add and remove liquidity, watch fees accrue, and see an
  estimated APY.
- **B.** Agent vaults that provision and rebalance LP automatically.

---

## What already exists

Measured on chain today, not assumed:

| Thing | State |
|---|---|
| `AgentVault.sol` | Written, 35KB, hostile-keeper threat model, **64 tests passing** |
| `AgentVaultFactory.sol`, `AgentLens.sol` | Written and tested |
| Agent vaults deployed | **Arc testnet only.** Nothing on Stable |
| `features.agent` on Stable | `false` |
| MintSwap V2 pairs | **7**, fully enumerable on chain via `allPairs(i)` |
| Launchpad tokens | **122**, complete registry |
| Uniswap V3 on Stable | factory, NPM, router and **QuoterV2 all known and live** |
| Existing farms | 3 hardcoded, plus a hardcoded fee-pool list |
| `view-pools` | exists in markup, route **retired**, redirects to Earn |

So the agent-vault contracts are largely done. The pools page is the larger piece
of new work, and it is mostly a data problem rather than a UI one.

---

## A. The pools page

### The data problem, with numbers

"All the largest pools on all of Stable" is not something the browser can
discover. CLAUDE.md records why: `eth_getLogs` on Stable caps at 500 blocks AND
500 results, and the node prunes to roughly four days. Enumerating pool-creation
events back to genesis is therefore impossible from a page, and impossible from a
server too, for anything older than the retention window.

Three complete sources exist that do not need logs:

1. **V2-style factories enumerate themselves.** `allPairsLength()` and
   `allPairs(i)` give every pair ever created, with no history required. MintSwap
   has 7. Any other V2 fork on Stable can be walked the same way, once its
   factory address is known.
2. **The launchpad registry** is complete: 122 tokens, each with its pool.
3. **Uniswap V3 has no such array.** Pools are found from `getPool(a, b, fee)`
   for token pairs we already know, or from retained logs. This is the gap.

For scale: MentoScan reports **303 pools mapped and 705 tokens indexed** on
Stable, against the 7 + 122 we can see from our own contracts. So most of the
chain is in pools we do not currently know about, on DEXes we do not run.
Dexscreener confirms at least one other venue, `dyorswap`, is live there.

### So: build an indexer, or consume MentoScan?

This is the decision that shapes everything else.

**Consume MentoScan.** It has already solved this exact problem, it is inside
the ecosystem, and it is now linked from our own header. Fastest by far.
Against it: an external dependency for a page that offers to move user money.
The block explorer dependency added for Arc broke within an hour of shipping,
and this one would be worse, because a stale or wrong pool address is not a
blank page, it is a deposit into the wrong contract.

**Build our own.** `stats-indexer.js` already walks pools and writes a committed
JSON, and `stats-cache.json` is already the only durable record of pre-pruning
history. Extending it to enumerate every known factory and probe V3 pairs is a
day or two, and it keeps the data path under our control and reviewable.

**Recommendation:** build our own for anything the page will let a user
transact against, and treat MentoScan as a discovery hint at most. The rule
should be that the site never offers an action against an address it did not
derive itself.

### Add and remove liquidity

V2 and V3 are different products and the page must not pretend otherwise:

- **V2 (MintSwap and any fork):** `addLiquidity` / `removeLiquidity` through
  that fork's router, LP tokens are fungible, "rewards" are simply the LP's
  growing share. Nothing accrues separately.
- **V3 (Uniswap):** `mint` / `increaseLiquidity` / `decreaseLiquidity` /
  `collect` through the NPM. The position is an NFT with a range, so the UI has
  to ask for a range or choose one, and fees accrue as a separately collectable
  balance.

"Add and remove from those LP pairs" therefore means two flows, two sets of
approvals, and two meanings of "rewards" on one page.

### APY, and how not to lie with it

Fee APY has no honest single number. What can be computed:

```
feeAPR = (volume24h * feeRate / tvl) * 365
```

Every input is a problem worth stating on the page rather than hiding:

- `volume24h` from Dexscreener where it covers the pool, otherwise from our own
  indexer. For a thin pool one large trade makes this meaningless.
- V3 fees do not accrue to the whole TVL, only to liquidity in range. A
  full-range position earns a fraction of what the headline implies, and a
  concentrated one out of range earns nothing. A single APY figure across V2 and
  V3 pools is not comparable between them.
- Farm rewards are a separate emission stream in MINTD, whose value moves.

**Rule for this page:** label it `est. fee APR`, never `APY`, show the inputs
next to it, and never compound a 24h figure into an annual one without saying
that is what it is. CLAUDE.md's TVL methodology section exists because an
inflated number is the easiest thing for a critic to disprove; the same applies
here, harder, because this one implies a return.

### How it can lose money

- **Depositing into an unvetted pool.** Listing every pool on the chain means
  listing pools whose token is a honeypot, whose "pool" is a lookalike contract,
  or which is a 0.01% fake of a real pair created to catch exactly this. A user
  who clicks Add on our page will hold us responsible. Mitigation: only enable
  Add/Remove for venues we derive and can name, mark everything else read-only,
  and never present listing as vetting.
- **Wrong pool address for the right pair.** Multiple fee tiers and multiple
  DEXes give several real pools per pair. Depositing into the thin one is a
  silent loss to slippage on exit.
- **V3 range chosen for the user.** A default range is a trading decision. Too
  wide earns nothing, too narrow goes out of range and stops earning while
  fully exposed to one side.
- **Add liquidity front-running.** Same class as the launch front-run already
  documented for Stable. A deposit into a thin pool at a manipulated price mints
  a position worth less than it cost, immediately.
- **Fee-on-transfer or rebasing tokens** break `amountMin` accounting and leave
  dust or revert.

---

## B. Agent vaults on Stable

### What exists

`AgentVault` is already built to the right threat model, and the header of the
file states it: the agent may never choose an execution price, a venue, or a
range. The pool and fee tier are immutable from construction, minimum swap output
is computed from the pool's own TWAP rather than passed in by the keeper, ranges
are clamped to a band around that TWAP, and a cumulative-loss breaker reverts any
action that drops checkpointed value past a tolerance. Withdrawals go only to the
owner recorded at construction.

That is the hard part, and it is done and tested.

### What is missing

1. **Deployment to Stable.** The factory and lens are on Arc testnet only.
2. **A security review before that deploy.** CLAUDE.md requires it for anything
   touching user funds, and this is real money on mainnet rather than a testnet,
   which is a higher bar than the Arc deployment cleared.
3. **A keeper.** `agent-keeper.js` exists but has never run against Stable. It
   needs a gas-only wallet that is not the deployer key.
4. **Turning `features.agent` on for Stable**, which should be last.

### How it can lose money

- **It is custody.** The contract's own header says so. A vault holding user
  funds is custody however it is described, and the page must not imply
  otherwise.
- **A compromised keeper** cannot steal principal by design, but can still waste
  gas and rebalance at bad times. That is the accepted residual risk and should
  be stated where a depositor can read it.
- **Impermanent loss is not a bug and will happen.** An automated vault that
  rebalances realises it. If the page shows "rewards accruing in real time"
  without showing position value against a hold baseline, it will show people
  earning while they lose.
- **The loss breaker can wedge the vault.** If tolerance is set tight, ordinary
  volatility trips it and the vault stops acting. That is the safe failure, but
  it needs to be visible rather than looking like a broken agent.

---

## Sequencing

The pools page is useful on its own and carries less risk. The vaults are
higher risk and need a review before they can ship at all.

1. Indexer work: enumerate every known factory, derive pools, write a committed
   JSON the page reads. No UI yet.
2. Pools page, **read only**: list, TVL, volume, est. fee APR with inputs shown.
3. Add/remove for venues we derive, V2 first (simpler, no range decision).
4. V3 add/remove, with an explicit range choice.
5. Security review of the agent vault contracts against a mainnet bar.
6. Deploy factory and lens to Stable, run the keeper on a gas-only wallet.
7. Enable the agent page.

## Open questions

1. **Data source:** build the indexer, or consume MentoScan? My recommendation
   is to build it for anything transactable.
2. **Scope of Add/Remove:** only pools on venues we can name, or any pool on the
   chain? I would strongly prefer the former.
3. Which venues count as ours: MintSwap and canonical Uniswap V3 only, or does
   dyorswap get included?
4. Do agent vaults accept any pool, or a whitelist? The pool is immutable per
   vault, so this decides whether a user can point a vault at anything.
5. Does the pools page replace the retired `view-pools`, or live beside Earn?

## Not started

Nothing. No code written, nothing deployed.
