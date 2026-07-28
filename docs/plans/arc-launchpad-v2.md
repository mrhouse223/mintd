# Arc launchpad v2

Status: building
Date: 2026-07-28

## What problem this solves

The launchpad deployed on Arc testnet today is a straight copy of the Stable
one: unlimited dev buy, 90/10 creator/protocol fee split, and a single
undifferentiated platform fee recipient. Three consequences follow. A creator
can buy an unbounded share of their own supply inside the launch transaction,
with no competition, at the cheapest price the curve will ever offer. The
protocol keeps 10% of pool fees, which is too thin to fund a buyback. And
because every protocol dollar lands in one wallet, there is nothing on chain
that distinguishes a dollar earmarked for buybacks from a dollar earmarked for
servers, so any published tokenomics is a promise rather than a fact.

v2 caps the dev buy at 5% of supply, moves the split to 80/20, and routes the
protocol's 20% on chain into two named destinations so the tokenomics is
readable from the contract rather than from a docs page.

## What it does not do

- **It does not cap a creator's total holdings.** The cap binds only the swap
  that `launch()` itself performs. A creator can buy more in the very next
  transaction, from a different wallet, or **in the same transaction** by
  calling `launch()` with a zero dev buy from a contract and then hitting the
  router directly. `lock()` is released before `launch()` returns, so nothing
  prevents that.

  An earlier draft of this plan claimed the cap "stops the atomic uncontested
  snipe". That was wrong and the security review caught it. What the cap
  actually does is bound the contract-performed buy, which stops the casual
  overshoot and makes the default path honest. It is a guardrail, not a
  guarantee. Docs must say this in exactly these terms.

  Closing the same-transaction hole would need `require(msg.sender ==
  tx.origin)`, which breaks Safe and account-abstraction launchers. Not worth
  it, but the choice should be explicit rather than accidental.
- **It does not deploy MINTD on Arc.** The buyback plumbing is built and
  points at a configurable token, but issuing MINTD on Arc is a supply
  decision that is not mine to make. Until that token exists the buyback
  contract accumulates USDC and cannot execute.
- **It does not make the buyback immutable or trustless yet.** See the
  tokenomics section. Claiming otherwise is the exact kind of statement this
  repo has already had to walk back twice.
- **It does not change Stable.** The Stable launchpad is immutable and stays
  on 90/10 with no dev cap.
- No migration of existing Arc launches. Tokens launched on the v1 Arc
  launchpad keep their v1 terms forever.

## The 5% cap, and what it costs in USDC

"5% of supply" is 50,000,000 of the 1,000,000,000 fixed supply. On the launch
curve, at the current `startPriceUsdc1e18` of 0.000003, buying that costs
**159.47 USDC**, which is 5.32% of the $3,000 starting market cap. It is not
5.00% of the start mcap because the curve moves under the buy: the purchase
ends with the price 1.108x above launch, and the average price paid is
therefore above the start price.

Two independent derivations agree to 4e-5 USDC:

| method | result |
|---|---|
| brute simulation stepping the V3 curve | 159.471400 USDC |
| closed form from position liquidity | 159.471439 USDC |

Both pool orientations (meme as token0 and as token1) produce the same number,
which is the cross-check that matters most, since the two branches share no
code.

**Enforcement is on tokens out, not on USDC in.** The swap is executed and then
`require(amountOut <= 50_000_000e18)`. This is exact and cannot drift. The USDC
figure is exposed as an advisory view, `maxDevBuyQuote(token)`, so the frontend
can clamp the input box and users never meet the revert. If that view is ever
wrong the worst case is a confusing frontend number, not a fund loss, because
it is not in the enforcement path.

The view derives the cap from the `liquidity` that `NonfungiblePositionManager.
mint` returns, plus one compile-time constant (`sqrtRatioAtTick(±887200)`).
That avoids importing TickMath. Verified: the derived position edge matches the
true `sqrtRatioAtTick(tickLower)` to under 1 part per billion.

`liquidity` is stored in its own mapping, not appended to the `Launch` struct,
so `launches(address)` keeps a byte-identical return shape. The frontend and
`stats-indexer.js` share one launchpad ABI across both chains and would
misdecode if the tuple grew.

## Fee architecture

Pool fee tier is 1%, unchanged. Of every 100 units of pool fee collected:

| destination | share of pool fee | share of trade volume |
|---|---|---|
| Creator | 80 | 0.80% |
| Protocol, to buyback and burn | 16 | 0.16% |
| Protocol, to operations | 4 | 0.04% |

So `creatorShareBps = 8000`, and the protocol's 2000 is split
`buybackShareBps = 8000` / 2000 between `buybackRecipient` and `opsRecipient`.
Both destinations are set at construction and are separately settable by the
owner.

**Stable is not changing.** It stays at 90/10 with a single fee recipient. The
80/20 split is Arc-only, so the two chains deliberately differ: Stable's
creators keep more, Arc funds a buyback. `FeeSplitter.sol` was built and tested
to give Stable an 80/20 protocol split without redeploying its immutable
launchpad, and is kept undeployed in case that is ever wanted.

`MIN_CREATOR_SHARE_BPS` stays at 5000. That is an admin risk worth stating
plainly: the owner can move creators from 80% down to 50%, though not below.

### MINTD-on-Arc tokenomics

The buyback destination is `ArcBuybackTWAP`, which holds USDC and can only do
one thing with it: buy MINTD and send it to `0x…dEaD`. No owner, no withdraw,
no admin. Same shape as the existing `BuybackBurner`, with a rate limit added
so the spend is a TWAP rather than one block of market impact:

- `interval` seconds must elapse between executions
- each execution may spend at most `maxSliceBps` of the balance
- `execute(minOut)` is permissionless; anyone can call it
- the caller supplies the slippage floor

This is the honest description, and it is the one the docs must use: **the
schedule is enforced on chain, the trigger is not.** A keeper calls `execute`
on a timer. If the keeper stops, the USDC sits in the contract and nothing is
lost, but no buying happens. Calling this "automated and decentralized" today
would be false; it is automated in schedule and permissionless in trigger,
which is a weaker and true claim. Making the trigger itself immutable and
self-firing is a future release.

Until MINTD exists on Arc, `ArcBuybackTWAP` is not deployed and
`buybackRecipient` points at the same operations address, so 100% of protocol
fees fund operations. That must be stated on the docs page rather than
implied, because the fee table above would otherwise be aspirational.

## Contracts touched

- **New: `ArcLaunchpad.sol`.** Holds no user funds at rest. Transiently holds
  the creation fee and dev buy value within a single transaction, and holds
  the position NFTs permanently with no code path to withdraw liquidity.
- **New: `ArcBuybackTWAP.sol`.** Holds protocol USDC. No owner, no withdraw.
- `InstantLaunchpad.sol` unchanged. Stable keeps running its deployed
  bytecode.
- **Touches user funds: yes.** `/security-review` before deploy, no
  exceptions.

## How it can lose money

1. **Dev buy cap bypassed.** If the post-swap check is wrong or omitted, a
   creator sweeps the bottom of the curve. Mitigated by checking `amountOut`
   directly rather than trusting the USDC math. Test: buy at exactly the cap,
   one wei above, and far above.
2. **Refund path drains the contract.** v1 spends `msg.value - creationFee`
   entirely. If v2 clamps and refunds, a bad refund could pay out more than
   was sent. Decision: **do not clamp, revert instead.** No refund path
   exists, so this risk is designed out rather than tested for.
3. **Fee split rounding.** Three-way integer division can leave dust or, if
   written carelessly, try to pay out more than was collected. The protocol
   ops share must be computed as `total - creator - buyback`, never
   independently, so the three always sum to exactly the collected amount.
   Test with amounts that do not divide evenly.
4. **Decimal confusion.** USDC on Arc is dual-decimal exactly like USDT0 on
   Stable: 18 native, 6 as ERC-20, ratio exactly 1e12. A mix-up is a
   1,000,000x error. CLAUDE.md gotcha 6.
5. **`maxDevBuyQuote` overflow.** `L * (sqrtEnd - sqrtStart)` can reach 2^288
   for extreme liquidity. Uses `FullMath.mulDiv`, not a plain multiply. A
   revert here would break the frontend even though no funds are at risk.
6. **Buyback sandwiched.** The TWAP buys on a public mempool with a
   caller-supplied `minOut`. A keeper passing `minOut = 0` donates the slice
   to a sandwicher. The keeper must quote fresh and set a real floor; the
   contract cannot enforce this for it.
7. **Reentrancy.** The launch path makes external calls to the router and the
   position manager. `lock()` modifier retained from v1.
8. **Owner risk.** `setFeeRecipients` and `setConfig` are owner-gated, and the
   owner is currently the Arc deployer key, which was pasted in chat and is
   testnet-only. Fine for testnet, must be a Safe before any mainnet analogue.

## Security review, 2026-07-28

Three independent reviews were run. The arithmetic came back clean: `FullMath`
was fuzzed over 300,000 triples with zero mismatches, both tick constants were
confirmed against Uniswap's TickMath, and `previewDevBuyCap` agrees with an
exact curve simulation to within 1 wei across ten start prices and both pool
orientations. `FeeClaimAll` came back clean with no exploitable path.

One HIGH finding, now fixed.

### Launch-price front-running (HIGH, fixed)

`createAndInitializePoolIfNecessary` leaves an **already-initialized** pool's
price untouched. `_openMarket` then read `slot0().tick` back and anchored the
whole 1B supply to it. Because the token address was a pure function of
`(launchpad, nonce)`, anyone could compute the next token address, create and
initialize its pool at a price of their choosing, and wait.

Reproduced in `scripts/test-launch-frontrun.js`: **$50 bought 100% of supply.**

Two changes fix it:

1. `require(actualSqrt == sqrtPriceX96)` after the pool call. A fresh
   initialize sets `slot0` to exactly the value passed, so equality proves
   this call set the price rather than a stranger.
2. Token deployment moved from `CREATE` to `CREATE2` with a salt. Without
   this, change 1 turns the attack into a permanent brick: a reverted launch
   rolls the nonce back, so every retry targets the same poisoned address
   forever. The default salt mixes in `block.prevrandao`, which is not
   knowable before the block, and `launchWithSalt` lets a caller step over a
   poisoned address explicitly.

### The same hole is live on Stable and cannot be fixed

`InstantLaunchpad` at `0x75FAdB24…` has the identical pattern and is
immutable. The attack reproduces against it in the same test file, which
asserts the vulnerability deliberately so the test starts failing if it is
ever migrated.

Checked on chain 2026-07-28: **all 121 launches to date are clean**, every
position sitting at the expected tick range. It has not been exploited. But
any future launch on Stable can be hijacked by a third party for the price of
one pool creation, and the launching user loses their entire supply.

This is the strongest argument for moving Stable onto a fixed launchpad. It is
out of scope for this plan and needs its own decision.

## Tests that must pass before deploy

- [ ] existing suites still green (`test-instant.js`, `test-arb-multi.js`)
- [ ] dev buy of exactly 50,000,000 tokens succeeds
- [ ] dev buy of 50,000,001 tokens reverts
- [ ] dev buy far above the cap reverts, and reverts for both pool
      orientations (meme as token0 and token1)
- [ ] zero dev buy still launches
- [ ] `maxDevBuyQuote` predicts the actual swap output to within a token
- [ ] fee split pays creator 70%, buyback 24%, ops 6%, and the three sum to
      exactly the collected amount on a non-divisible input
- [ ] no path withdraws the position NFT
- [ ] TWAP refuses a second execution inside the interval
- [ ] TWAP refuses to spend more than one slice
- [ ] TWAP has no function that moves USDC anywhere except the MINTD pool

## Deploy steps

1. `node scripts/compile.js` with `evmVersion: "paris"` and `viaIR: true`
2. `node scripts/test-arc-launchpad.js`, all green
3. `/security-review`
4. Deploy to Arc testnet, update `deployments/arc-testnet.json`
5. Read back on chain: `creatorShareBps == 7000`, `buybackShareBps == 8000`,
   `MAX_DEV_BUY_BPS == 500`, and `maxDevBuyQuote` on a fresh launch is
   ~159.47e6
6. Verify on arcscan via standard-json-input
7. Point the Arc frontend at the new address, update the docs page

## Rollback

The launchpad is immutable once deployed, but it is not the only one: the v1
Arc launchpad stays live at `0xd6fdA9A0…`. Rollback is repointing the frontend
at v1, which takes one commit. Tokens already launched on v2 keep v2 terms
permanently, so a bug in the fee split is not recoverable for those tokens.
This is why step 3 is not optional.
