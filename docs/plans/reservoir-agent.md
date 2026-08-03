# Reservoir agent (a DCR for MINTD)

Status: superseded in part. The user-owned version shipped as docs/plans/buyback-vault.md and its keeper is live; this plan's MINTD-reservoir half still waits on a fee source pointing at the burner.
Date: 2026-08-03

## What problem this solves

`buybackBurn()` is manual and nothing triggers it, so MINTD's buyback exists on
chain and does not run. Fees accumulate in `BuybackBurner` until somebody
remembers. A reservoir agent turns that into a countercyclical rule that fires on
its own: claim the fees, look at what the price just did, buy the drawdowns,
otherwise sit still. The second half is the point people can actually see, which
is a public dashboard that proves every cycle happened, so the buyback stops
being a claim in the docs and becomes a stream of transaction hashes.

Modelled on DCR (dcr-rh.tech), which does this for PONS on Robinhood chain.

## What DCR actually does, mechanically

Read from its site and repo on 2026-08-03, so the design is copied from the real
thing rather than from the marketing:

- Randomised **10 to 15 minute** cycle. Each one claims creator fees first.
- Curvature `r = ±1e6 (s² − s_prev²) / s_prev²` where `s` is the V3
  `sqrtPriceX96`. An oriented percentage move, scaled to integers.
- Adaptive dead zone `d = 1500 + min(q, 25000) / 5`, `q` being flow pressure
  normalised by liquidity. Quiet pools get a tighter band.
- **BUY** when `r < -d`, deploying **0.25% to 12.5%** of the quote reserve.
- **SELL** only when `r > 4d` **and** token inventory is worth more than twice
  the quote reserve. Asymmetric on purpose: four times the band to sell, one to
  buy.
- **HOLD** otherwise.
- Calm (`|r| ≤ d`): burn 6.25% of tokens if token value > 2x quote; or put up to
  10% of each side into a new V3 position and lock the NFT to `0x…dEaD`; or send
  6.25% of the quote to 1 to 10 indexed holders if quote > 2x token value.
- Safety: native gas only, 0.75% minimum-output, simulation before broadcast,
  20% gas buffer, exact approvals, one retry, prepared hashes persisted before
  sending, overlapping cycles rejected.

## What mintd already has

Most of it, which is why this is worth doing.

| DCR piece | mintd equivalent | State |
|---|---|---|
| Buy and burn | `BuybackBurner` `0x7F007fbc…` | **Deployed, immutable, and `buybackBurn` is permissionless** |
| Fee source | MINTR and MintSynth `feeRecipient` both point at the burner | Verified on chain 2026-07-28 |
| Price input | MINTD/USDT0 Uniswap V3 pool | Live |
| Keeper process | `arb-keeper` under pm2, gas-only `KEEPER_KEY` | Running |
| Permanent LP lock | `V3PositionLocker` | Deployed |
| Holder index | `holder-ledger`, already time-weighting MINTD holders | Running |
| Published state file | `stats.json` plus `publish-stats.sh` on a cron | Running |

The permissionless `buybackBurn` is the important one: the agent needs **no
privileged key and holds no funds**. Worst case if the keeper wallet is lost is
that the buyback stops, which is exactly today's situation.

## The blocker, stated first

**The reservoir holds $2.10.**

`BuybackBurner`'s USDT0 balance right now is 2.096738. An agent whose whole job
is deploying a reservoir has nothing to deploy. It would sit in HOLD forever and
the dashboard would be a very honest picture of nothing happening.

96,317,721 MINTD (9.63% of supply) has already been burned, so the mechanism has
worked historically; the flow into it is what dried up. Fixing that is a
prerequisite, not a follow-up, and it is a routing decision rather than code:

- launchpad `feeRecipient` is the **Safe**, not the burner
- `MintrArbMulti.profitTo` is the **Safe**, not the burner
- the new `BondMarket` fee recipient is the **Safe**, not the burner

Any one of those pointed at `0x7F007fbc…` funds the agent. Each is a single Safe
transaction. **This plan is not worth building until at least one is done.**

## What it does not do

- **No selling, and no new contract in v1.** `BuybackBurner` can only buy MINTD
  and send it to `0x…dEaD`. It cannot hold MINTD, sell it, provide liquidity or
  pay holders, so three of DCR's four surplus paths are physically impossible
  with what is deployed. v1 is BUY and HOLD only, which is also the buy-biased
  half DCR says is the point.
- **No SSE.** The site is static on Netlify with no server. The agent writes a
  JSON file and commits it, exactly as `stats-indexer` already does, and the
  dashboard polls it. A live socket would mean running a public server that does
  not exist today.
- **No holder distribution** in v1, even though the index exists, because paying
  it out needs a contract that holds funds.

## How it can lose money

1. **A predictable buyer on a chain with a known front-running hole is a free
   lunch.** This is the big one. The agent buys MINTD in a thin pool on a
   schedule, and CLAUDE.md already records Stable's front-running problem as
   unfixed. A sandwicher who knows a buy is coming profits from every cycle, and
   the loss lands on the burn (fewer MINTD burned per dollar).
   Mitigations, all of which are required rather than optional:
   - randomised interval, never a fixed cron
   - `minMintdOut` from a **fresh** quote in the same tick, with a tight
     tolerance. Passing 0 would let a sandwich take essentially the whole trade
   - small slices, 0.25% to 12.5% of the reservoir, never the whole balance
   - **do not publish the next cycle time.** DCR's dashboard prints
     `NEXT_CYCLE_SCHEDULED` publicly, which on this chain would be an invitation.
     Publish cycles only after they have executed.
2. **`buybackBurn(0, 0)` spends the entire balance with no slippage floor.** It
   is permissionless, so anyone can call it that way at any time and hand the
   pool to a sandwicher. Nothing in this plan can prevent that; it is a property
   of the deployed contract. The agent should keep the reservoir small and
   working rather than let a large balance sit as a standing target.
3. **Curvature read from a manipulated spot.** `sqrtPriceX96` in a thin pool is
   cheap to push, and an attacker who moves the price down triggers a buy at a
   price they set. Sizing caps bound the damage; a TWAP for the decision input
   bounds it better and is the preferred version.
4. **Stale or wrong price history.** Gotcha 3: the RPC prunes and has no archive
   state, so `s_prev` must be persisted locally by the agent, not read back from
   the chain. If that file is lost the first cycle after restart has no previous
   price and must HOLD rather than assume.
5. **RPC shape.** Gotcha 1, no batching, so `batchMaxCount: 1`. Gotcha 2, 500
   block and 500 result caps if any log scanning is added. Gotcha 3c, blocks are
   0.70s, so any "N blocks ago" arithmetic is wrong by 30% if it assumes 1s.
6. **Gas wallet.** Must be the gas-only keeper, never the deployer, which is
   still compromised.

## Tests that must pass before deploy

- [ ] decision function is pure and unit-tested: BUY below `-d`, SELL never,
      HOLD inside the band, at the exact boundaries
- [ ] a lost or absent previous-price file produces HOLD, not a buy
- [ ] sizing never exceeds the cap, and never spends the whole reservoir
- [ ] `minMintdOut` is derived from a quote taken in the same cycle, and a
      simulated 5% adverse move makes the cycle abort rather than execute
- [ ] dry-run mode executes a full cycle against ganache with a real V3 pool and
      sends nothing
- [ ] the published JSON is valid and complete after a crash mid-cycle
- [ ] existing suites still green

## Deploy steps

1. Fund the reservoir: one Safe transaction repointing a fee source. Nothing
   below matters until this is done.
2. `scripts/reservoir-agent.js --dry` for a full cycle with no broadcast
3. Add to `ecosystem.config.js` with the gas-only key, then
   `pm2 delete all && pm2 start ecosystem.config.js && pm2 save` (gotcha 5)
4. Confirm on chain: `totalUsdtSpent` and `totalMintdBurned` move after the first
   live BUY, and the MINTD balance of `0x…dEaD` increases by the same amount
5. Frontend: a Reservoir page reading the published JSON

## Rollback

The agent holds no funds and has no privileges, so stopping it is `pm2 stop` and
nothing is stranded. The buyback returns to manual, which is where it is today.
No contract is deployed in v1, so there is nothing immutable to regret.

## Per-project agents (the multi-tenant half)

The ask is that any launched coin can switch the same reservoir on and off. Two
pieces are missing, and neither is a frontend change.

**A burner per token.** `BuybackBurner` is immutable with MINTD hardcoded, so it
cannot serve another coin. Other projects need a `TokenBurner` (same shape: no
owner, no withdrawal, buy-and-burn only) deployed one per token by a factory, so
`isBurner(x)` is what proves an address is a real one rather than a lookalike
pointing at a hostile router. `AgentVaultFactory` is the existing precedent.

**A creator-gated registry.** The keeper has to learn whose agent is on without
anyone maintaining a list by hand. `TokenMetaRegistry` already does exactly this
shape: no owner at all, `pads` fixed at construction, writes gated on
`creatorOf()`. An `AgentRegistry` copies it: the creator of a launchpad token can
set `enabled`, the burner address, and the sizing caps for their own token and
nobody else's.

**The part that has no clean answer yet.** A creator cannot redirect their fee
stream on chain. `claimFees` pays `launches[token].creator`, and there is no
setter for it, so a creator cannot point their fees at a burner the way MINTR and
MintSynth do. Their options are to fund the burner by hand, or to have launched
with the burner as the creator address in the first place, which nobody did.
Until that is solved, a per-project agent only spends what its creator remembers
to send it, which is the same "runs when somebody remembers" problem this plan
exists to remove. **Worth solving before building the registry, not after.**

## v2, only if v1 earns it

A reservoir contract that can hold both legs, sell on overextension, mint and
lock LP, and pay indexed holders. That is a real contract holding real money and
would need its own plan, `/security-review`, and a deploy. Not started, and
deliberately out of scope until the v1 agent has been running long enough to say
whether the rule is any good.
