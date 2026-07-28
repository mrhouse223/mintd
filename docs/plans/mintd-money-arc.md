# mintd.money on Arc, and the allocation to Stable holders

Status: draft, for approval
Date: 2026-07-28

Two things specced together because the second only makes sense given the
first: an agentic trading and LP platform on Arc with its own token, and a 10%
allocation of that token to people holding $MINTD on Stable between now and Arc
mainnet.

---

## 0. The naming collision, which needs deciding before anything else

The plan as stated has **Stable called mintd.money and Arc called mintd.money**,
with **both tokens called $MINTD**. That cannot ship as written, and the
problem is not cosmetic:

- Two live tokens with one ticker means nobody can say "buy MINTD" without
  being wrong half the time. Every price screenshot, every chart link and every
  TG message becomes ambiguous.
- It is a gift to scammers. "Bridge your Stable MINTD to Arc MINTD" is a
  ready-made drain, and it will be run against your own community using your
  own brand, because you will have taught them the two are related.
- The allocation itself becomes hard to explain: holding one token earns a
  different token with the same name.

Three ways out, in my order of preference:

1. **Same name, different tickers.** Both products are mintd; the Arc token is
   `$MNTD` or `$MINT`. Brand carries, tickers never collide. Cheapest fix.
2. **Different product names.** Stable stays mintd.fun with $MINTD. Arc is a
   distinct name, and mintd.money is the umbrella both sit under. Cleanest
   long term, most work.
3. **Retire the Stable ticker.** Rejected: the token is immutable with locked
   liquidity, it will trade forever whether you like it or not, and pretending
   otherwise is how you end up with the ambiguity anyway.

Nothing below depends on which is chosen, but everything below reads better
once one is. **This is the decision to make first.**

---

## 1. Stable: unchanged, deliberately

No contract changes, no fee changes, no migration. 90/10 creator split. Fees
keep doing what they already do. Same Telegram, same community, same site.

The one thing to be honest about internally, because it does not change and
should not be forgotten: **the launchpad there is front-runnable** and the fix
is built but shelved by decision. See
`docs/plans/stable-launchpad-migration.md`. Keeping Stable "as is" means
keeping that too.

$MINTD on Stable is structurally immortal: its liquidity sits in a position the
launchpad owns with no withdraw path. It cannot be killed, so it does not need
to be defended. It simply continues.

## 2. Arc: the agentic platform

The product is the one already specced in `docs/plans/lp-agent.md`, which has
the security model worked out and should be read as part of this. In short: a
per-user vault where an agent may propose *timing* but never chooses an
execution price, a venue, or a range. If the keeper is fully compromised, the
worst case is wasted gas, never stolen principal.

What Arc adds beyond that plan:

- It is the **flagship**, not a side experiment. The launchpad already deployed
  there (`ArcLaunchpad`, 80/16/4 fee split, 5% dev cap) becomes a feature of the
  platform rather than the whole product.
- The token funds it. See below.
- USDC gas makes agent economics legible: a rebalance costs a knowable number
  of cents, not a variable amount of a volatile asset.

**Hard dependency: Arc mainnet is not publicly live.** No RPC responds, no date
is published. Everything here is buildable on testnet now and shippable only
when Circle ships. The allocation window closing "at Arc mainnet" is therefore
a date neither of us controls, which the design has to tolerate rather than
assume away.

## 3. The 10% allocation

10% of Arc token supply to addresses holding $MINTD on Stable, measured from
now until shortly before Arc mainnet.

### What is already running

`scripts/holder-ledger.js` has been recording since 2026-07-28 and covers the
token's entire life, banked with about a day of margin before Stable's RPC
pruned it. It accumulates balance-blocks per address, so it measures duration
rather than a snapshot. It cannot be reconstructed if it stops.

Live at `/holders` on the site, showing shares and explicitly not promising
anything.

### Scoring

**`score = min(time-weighted average balance, balance at close)`**

Already implemented and already the published number. Both halves are load
bearing:

- A snapshot alone is farmed by buying the day before.
- Duration alone **pays people who already left**. In the first run, two of the
  top ten by duration held nothing at all, and 926 of 1,254 addresses had a
  positive duration score with a zero balance.

### Distribution shape, with real numbers

Pro-rata on today's data, against a 100,000,000 token pool:

| | share of drop | tokens | % of total supply |
|---|---|---|---|
| Top 1 | 5.4% | 5,427,050 | 0.54% |
| Top 5 | 21.8% | 21,831,455 | 2.18% |
| Top 10 | 39.8% | 39,801,877 | 3.98% |
| Top 25 | 70.4% | 70,355,916 | 7.04% |
| Median holder | 0.03% | 31,487 | – |

**Top 25 addresses take 70% of the drop.** That is the number to have an
opinion about. It is not obviously wrong — they are genuinely the largest,
longest holders — but it is concentrated enough that the remaining 300 people
receive tokens they will not notice.

### On square-root weighting: do not

It looks like the obvious fix. Top 25 would fall from 70.4% to 37.3%. **It is
farmable and would make things worse.**

Splitting a position across N wallets multiplies a square-root score by √N.
Ten wallets is 3.16x. Under linear weighting splitting gains nothing, which is
why linear is the honest default. Square-root only works with identity
verification, which you do not have and should not build.

The right tool is a **per-wallet cap** with the excess redistributed, which
cannot be gamed by splitting because splitting into capped wallets is exactly
what the cap already permits. A cap of 2–3% of the drop is worth modelling.

### Mechanics

- **Merkle drop, self-claim.** Publish the root and the full leaf list. Anyone
  can verify their own entry and recompute the whole tree from public logs.
- **No claim deadline shorter than a year.** Expiring drops quickly is how
  projects quietly keep most of an allocation.
- **Unclaimed tokens** go to a stated destination decided in advance, not to
  the team by default.
- **Window close is unannounced.** Publish that the window closes "shortly
  before Arc mainnet", never the block. An announced close is a farming
  schedule.
- **Contracts, pools, the dead address and project wallets are excluded**, as
  they already are in the published board.

### What must not be said

- No token amount, no valuation, no "worth $X", before the token exists.
- Not "your claim" or "your allocation" until a root is published. The site
  currently says *standing* and *share*, which is accurate.
- Nothing that ties the allocation to a date, since the date depends on Circle.

## 4. Open decisions

1. **The naming collision.** Section 0. Blocks announcement, not building.
2. **Per-wallet cap**: yes or no, and at what percentage.
3. **Vesting**: immediate, or linear over some months? Immediate is friendlier
   and simpler; vesting reduces day-one sell pressure but needs a contract and
   a schedule nobody can quietly change.
4. **Total Arc supply and the other 90%.** 10% to Stable holders is specified;
   the rest is not. Liquidity, treasury, team, and whether any of it is locked,
   all need numbers before this is announceable.
5. **Whether the Stable launchpad hole is disclosed** to the community as part
   of the story, or left as an internal fact.

## 5. What happens next, in order

1. Decide the naming (section 0)
2. Keep `holder-ledger` running. It is the only irreplaceable piece
3. Build the LP agent on Arc testnet per `docs/plans/lp-agent.md`, starting
   with the hostile-keeper test, since that test decides whether it ships
4. Model the cap against live data and pick one
5. Specify the full supply table
6. Write the merkle claim contract and its tests
7. Wait for Arc mainnet

Nothing in 2 through 6 requires Arc to exist, which is the point: the work is
not blocked, only the launch is.
