# MINTR on Solana (a tab on mintd.fun)

Status: approved (building)
Date: 2026-08-06

## What problem this solves

MINTR on Stable is a self-contained reserve token whose backing-per-token only
rises: buy mints against a USDT0 reserve, sell burns against it, and a fee on
each side stays in the reserve, so `reserve / supply` is monotonically
non-decreasing. This plan ports that exact mechanism to **Solana** and surfaces
it as a new **tab on mintd.fun** where users connect a Solana wallet (Phantom /
Backpack / Solflare) instead of an EVM wallet. Quote asset is **USDC** (native
Solana, 6-dec). Backing fee is **1% in and 1% out, both staying in the reserve**.

Alongside the contract we run a live **AMM market** (Raydium or Orca) so MINTR
has a chart, aggregator routing (Jupiter), and a place to trade without touching
the program directly, plus an **arbitrage bot** that keeps the AMM pinned to the
contract's backing price. The point of the AMM/arb pair is the headline: a
tradable market whose *floor only goes up*.

## What it does not do

- **Not a bridge.** This is a native Solana MINTR, economically parallel to the
  Stable MINTR, not the same token moved across. There is no messaging layer and
  no shared supply. (Same constraint noted for cross-chain MINTD.)
- **No oracle, no leverage, no gold, no launchpad, no agents.** Just the reserve
  token, its AMM, and the arb bot.
- **The AMM is not the source of truth.** The contract prices off its *own*
  `reserve / supply` and never reads the pool, so the pool cannot manipulate the
  contract. The pool is a shop window and a router hook; the contract is the real
  liquidity.
- **The frontend tab does not unify wallets.** EVM chains keep the ethers path;
  the Solana tab is a separate `@solana/web3.js` path. They coexist, they do not
  merge.

## The contract (Anchor program)

An Anchor program, `mintr`, deployed to Solana mainnet. State lives in accounts,
not in the program:

- **`Config` PDA** — `owner`, `fee_recipient`, `buy_fee_bps` (100), `sell_fee_bps`
  (100), `platform_fee_bps` (default 0, optional), `reserve: u64` (USDC, 6-dec,
  tracked internally — never read the vault balance), `seeded: bool`, and the
  bumps. Mirrors the EVM storage layout.
- **MINTR mint** — a standard SPL mint, **6 decimals to match USDC** (avoids the
  1e3 scaling bugs a 9-dec token would invite). Mint + freeze authority is a
  program PDA, so only program logic can mint or burn.
- **Reserve vault** — a PDA-owned USDC token account. The only way USDC leaves is
  `sell()` paying a redeemer or the optional platform fee. **There is no
  withdraw instruction.**

Instructions:

| Instruction | Mirrors EVM | Notes |
|---|---|---|
| `initialize` | constructor | Creates Config PDA, MINTR mint, reserve vault. |
| `seed(usdc, mintr)` | `seed()` | One-time. Sets starting price = usdc/mintr, mints initial supply to owner. |
| `buy(usdc_in, min_out)` | `buy()` | CPI USDC user→vault, mint MINTR to user. 1% buy fee stays in reserve. |
| `sell(mintr_in, min_usdc)` | `sell()` | Burn user's MINTR, CPI USDC vault→user. 1% sell fee stays in reserve. |
| `set_fees` | `setFees` | Bounded; backing fees must stay > 0 to keep the curve monotonic. |
| `set_fee_recipient` | `setFeeRecipient` | |

The math is identical to the EVM version:

```
price      = reserve / supply
quoteBuy   = usdc_in * (1 - buyFee - platformFee) * supply / reserve
quoteSell  = mintr_in * reserve / supply * (1 - sellFee - platformFee)
on buy:  reserve += usdc_in - platformCut   (buy fee stays in reserve)
on sell: reserve -= userGets + platformCut  (sell fee stays in reserve)
```

**Every intermediate multiply is done in `u128` with `checked_mul` / `checked_div`,
then cast back to `u64`.** `usdc_in * supply` overflows `u64` at trivial sizes;
this is the single most likely way to ship a broken port. See "How it can lose
money".

## How the AMM stays a live market while the floor only goes up

Two prices exist:

1. **Contract price** `P_c = reserve / supply`. Monotonically non-decreasing by
   construction — every buy and every sell leaves 1% behind for remaining
   holders. This is a **hard redemption floor**: anyone can always `sell()` into
   the contract at `P_c × (1 - 1% - platform)`.
2. **AMM price** `P_a` — a normal constant-product Raydium/Orca pool. It moves up
   *and* down with order flow, like any pool.

They are joined by arbitrage, in both directions:

- **AMM trades below the floor** (`P_a < P_c` by more than fees+gas): buy cheap
  MINTR on the pool, `sell()` it to the contract at the higher backing. This
  buying pushes `P_a` back up to the floor. The dip gets bought.
- **AMM trades above the floor** (`P_a > P_c` by more than fees+gas): `buy()`
  MINTR cheap from the contract, sell into the pool at the premium. This selling
  pushes `P_a` back down toward the floor.

So the honest framing, which we must not overstate:

> **The floor only goes up. The market trades at the floor. Dips below the floor
> are an arb opportunity that closes in seconds.** The AMM *can* print a lower
> candle for a moment — that moment is the arb's lunch — but it cannot stay
> below the floor, and the floor never falls.

There is a self-reinforcing property worth stating plainly: **every arb action
raises the floor.** Whichever direction the arb fires, it calls `buy()` or
`sell()` on the contract, which pays a 1% backing fee into the reserve, which
lifts `reserve / supply`. Arbitrage that defends the peg also ratchets it up.

The cost of the 1% fees is a **deadband**: arb only fires when the spread beats
~1% + pool fee + gas, so `P_a` floats freely within roughly ±1-2% of the floor
and is clamped outside it. That band is the price of the monotonic guarantee, and
it is fine.

## The arbitrage bot

Off-chain Node service (same shape as the existing `vault-keeper`, runs on the
VPS under pm2, `batchMaxCount`-equivalent care for the Solana RPC). Loop:

1. Read `P_c` from the Config PDA (`reserve`, mint supply) and `P_a` from the
   pool account.
2. Compute the spread net of both the pool fee and the contract's 1% + gas.
3. If it clears a configured `MIN_PROFIT_BPS`, build **one atomic transaction**
   that does both legs — pool swap **and** the contract `buy`/`sell` — so there
   is no leg risk and no held inventory beyond gas. Solana's native
   multi-instruction transactions make this clean; no flash-loan primitive
   needed.
4. Every leg carries `min_out` / `min_usdc` slippage guards to survive sandwiching.

Because the legs are atomic, the bot's working capital is essentially **just SOL
for gas plus a small buffer**; each arb funds the next. If atomic routing against
a given pool is awkward, fall back to a thin held inventory (below).

## Optimal way to start with 1,000 USDC

The key realization that makes the allocation obvious: **seeding the reserve does
not spend your money.** When you `seed(R, S)` you put `R` USDC into the vault and
mint yourself `S` MINTR fully backed by it. You can always redeem that MINTR back
for (nearly) `R`. The reserve is collateral you still own, not a cost. So seed it
generously — a deep reserve is a deep redemption floor and makes the backing
credible.

The only capital genuinely *at risk / working* is the AMM float (exposed to being
the counterparty and to IL) and the arb gas. A thin AMM is therefore **optimal,
not reckless**, precisely because the deep contract reserve + arb bot defend it: a
dump that craters a thin pool is instantly bought and redeemed against the deep
reserve. The pool is the shop window; don't over-fund the window.

Concrete split of the 1,000 USDC, at an example $0.01 starting price:

| Bucket | USDC | Why |
|---|---|---|
| **Contract reserve seed** | ~800 | Deep floor + credible backing. Still yours (redeemable). Mint yourself the full initial supply against it, e.g. 80,000 MINTR at $0.01. |
| **AMM float (USDC side)** | ~120 | Paired with ~12,000 of your minted MINTR at the same $0.01, so the pool *opens exactly on the floor*. This is the only IL-exposed capital. Thin on purpose. |
| **Arb gas + buffer** | ~80 (in SOL + a little USDC) | Atomic arb needs little more than gas; buffer covers non-atomic fallback and pool-fee drag. |

You keep the rest of the minted MINTR (~68,000 here) as your own position /
inventory to sell into genuine demand. Notes:

- **Open the pool on the floor.** Pairing the pool at the same price the contract
  seeds at means there is no day-one arb gap to be picked off by a stranger.
- **List on Jupiter/Raydium** so the thin pool still gets aggregator routing and a
  chart — visibility is most of what the pool is for.
- **Let arbs compound the reserve.** Since every arb pays 1% into the reserve, an
  active bot slowly lifts the floor even absent organic volume; organic volume
  lifts it faster.
- Do **not** chase a deep pool with the 1k. Depth belongs in the reserve, where it
  both backs the token and only-ever-grows; depth in the pool is just IL waiting to
  happen.

## Contracts touched

- **New:** the `mintr` Anchor program (Config PDA, MINTR SPL mint, reserve vault).
  It **holds user funds** (the USDC reserve). → **`/security-review` (or a Solana
  equivalent audit pass) before mainnet, no exceptions.**
- **New off-chain:** the arb bot service (no custody beyond its own gas wallet).
- **Existing frontend modified:** `frontend/index.html` gains a `data-chain="solana"`
  tab and a Solana connect path. Upgrade-safe: it is additive and gated, EVM paths
  are untouched.

## How it can lose money

- **Program upgrade authority left live** *(highest severity, Solana-specific).*
  On Solana a program is upgradeable by default. "The owner can never touch the
  backing" only holds once the **upgrade authority is removed**
  (`solana program set-upgrade-authority --final`). Until then a malicious or
  compromised upgrade could add a drain instruction. Renouncing the program is the
  equivalent of the EVM contract being immutable and is **mandatory before the
  reserve holds meaningful funds.**
- **`u64` overflow in the price math.** `usdc_in * supply` and `mintr_in * reserve`
  exceed `u64` at ordinary sizes. All intermediates must be `u128` + checked math,
  then cast down. A silent wrap here mints or pays out a wildly wrong amount.
- **Reserve read from the vault balance instead of the internal counter.** Anyone
  can transfer USDC into the vault token account. Pricing must use the internal
  `reserve` field, exactly as the EVM version avoids `balanceOf`. Reading the ATA
  balance lets a donor distort the price.
- **Rounding direction.** Buy must floor MINTR out and sell must floor USDC out, so
  rounding always favors the reserve (price up), never the trader. Mirror the EVM
  `floor` choices exactly.
- **Arb leg risk / sandwiching.** A non-atomic arb can be front-run between legs.
  Prefer the atomic single-tx arb; always set `min_out` on every leg.
- **Thin-pool grief is by design, but bound it.** A large dump routed pool→arb→
  contract is just a redemption and shrinks the reserve — expected, and the
  monotonic curve keeps remaining holders whole. But confirm in tests that a full
  exit cannot underflow the reserve or the supply.
- **Decimal mismatch.** MINTR at 6-dec = USDC 6-dec keeps the ratio clean. If MINTR
  is ever set to 9-dec, every price line needs an explicit 1e3 scale and this
  becomes a prime bug site. Recommend 6.
- **Rent.** Every account needs rent-exemption lamports; unfunded account creation
  fails. Minor, but the deploy script must fund them.
- **No oracle risk, by construction.** The contract never reads the pool, so pool
  manipulation cannot move the contract price. Keep it that way.

## Tests that must pass before deploy

- [ ] `anchor test` (bankrun / local validator) green, mirroring `test-mintr.js`
- [ ] monotonicity: `reserve/supply` never decreases across a fuzzed sequence of
      buys and sells of random sizes
- [ ] `u128` math verified against the EVM reference outputs on identical inputs
- [ ] rounding always favors the reserve (buy floors out, sell floors out)
- [ ] owner cannot withdraw the reserve (no instruction exists; prove by absence
      and by attempting every instruction as a drain)
- [ ] full-exit does not underflow reserve or supply
- [ ] arb bot unit test: fires only when spread beats fees+gas; atomic tx both legs
- [ ] frontend: Solana connect, buy, sell, and read-only price all work against a
      local validator or devnet before mainnet

## Deploy steps

1. Build the Anchor program (`anchor build`), pin the toolchain versions.
2. Deploy to **devnet** first; run the arb bot and the frontend tab against devnet
   USDC and a devnet pool end-to-end.
3. Security review of the program.
4. Deploy to mainnet, `initialize`, then `seed` with the chosen split above.
5. Create the Raydium/Orca pool **at the seed price** and add the thin float.
6. **Remove the program's upgrade authority** once the deploy is confirmed correct
   and the reserve is about to hold real funds. This is the immutability step and
   is irreversible.
7. Frontend: add the `data-chain="solana"` tab, load `@solana/web3.js` +
   `@solana/spl-token` UMD from a CDN, wire the connect path to
   `window.solana` / `window.backpack` / `window.solflare`. Add a `solana` block
   to the chain config with the program id, MINTR mint, USDC mint, and pool
   address. Push (Netlify, no build step).
8. Start the arb bot on the VPS under pm2.

## Rollback

- **Frontend:** revert the tab commit; Netlify republish. Trivial, EVM paths are
  untouched.
- **Arb bot:** `pm2 stop` it. The market simply stops being defended; the contract
  floor is unaffected.
- **Contract:** once the upgrade authority is removed, the program is **immutable —
  there is no rollback.** This is why the review step and the devnet dry run are
  mandatory, and why the upgrade authority is removed *last*, only after the deploy
  is proven correct. Before that point, a bad program can be redeployed; after it,
  it cannot.

## Where the code lives

The Anchor program is a different toolchain (Rust/cargo/anchor) from the Node repo.
Put it in a `solana/` subdirectory of this repo to keep it together, with Anchor's
`target/` gitignored, or a sibling repo under the same pseudonymous identity if it
grows. The frontend tab and chain config live in `frontend/index.html` as usual;
the arb bot goes in `scripts/` alongside the keeper.
