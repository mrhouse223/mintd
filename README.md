# mintd.fun — Launch. Lock. Trade.

A currency launchpad for **Stablechain** (Stable Mainnet, chain ID 988), where the native gas token is USDT0. Every launch puts a fixed 1B supply straight into a **locked Uniswap V3 pool** in a single transaction — no bonding curve, no migration, trading is live from block one. The platform's own token is **$MINTD**, launched through the same mechanism as token #0 at deploy time and pinned in the UI with a PLATFORM badge.

## How it works

`InstantLaunchpad.launch()` deploys an immutable ERC-20 (fixed 1B supply, no owner, no taxes, no blacklist, no limits) and immediately mints the entire supply into a single-sided token/USDT0 Uniswap V3 position at the 1% fee tier. With the default start price of 0.000003 USDT0, markets open at a 3,000 USDT0 valuation and show "graduated" once the pool holds 9,000 USDT0 (a cosmetic milestone — liquidity never migrates anywhere).

The position NFT is held by the launchpad contract, which has **no code path to withdraw liquidity** — locked forever, verifiable onchain. Trading fees accrue to the position: `claimFees(token)` is callable by anyone and pays 90% to the creator and 10% to the platform in one call (split configurable at deploy; creator share can never be set below 50%). An optional dev buy executes in the launch transaction via SwapRouter02.

All trading after launch happens directly on Uniswap V3 (SwapRouter02 / QuoterV2) — the launchpad is not in the trade path.

## Layout

- `contracts/InstantLaunchpad.sol` — the launchpad: `MemeToken20` + `InstantLaunchpad`
- `contracts/StableLaunchpad.sol` — previous bonding-curve version, kept for reference
- `contracts/test/` — test-only WETH9 + mock router
- `scripts/compile.js` — compiles with solc-js into `build/`
- `scripts/test-instant.js` — 20 integration tests against **real Uniswap V3 contracts** (v3-core factory, NonfungiblePositionManager, SwapRouter02) in an in-process EVM
- `scripts/test.js` — legacy bonding-curve tests (26)
- `scripts/deploy.js` — mainnet deploy script
- `frontend/index.html` — single-file web app styled after pegd.fun

## Setup

```bash
npm install
npm install @uniswap/v3-core@1.0.1 @uniswap/v3-periphery@1.4.4 @uniswap/swap-router-contracts@1.3.1  # test deps
node scripts/compile.js
node scripts/test-instant.js   # 20 tests should pass
```

## Deploy to Stable Mainnet

You need a wallet funded with USDT0 on chain 988 for gas.

```bash
PRIVATE_KEY=0xyourkey node scripts/deploy.js
```

The script deploys the launchpad, then launches **$MINTD** as token #0 (skip with `SKIP_MINTD=1`; seed it with a dev buy via `MINTD_DEV_BUY=<usdt0>`). Optional env overrides: `FEE_RECIPIENT`, `CREATION_FEE` (default 1 USDT0), `CREATOR_SHARE_BPS` (default 9000 = 90%), `START_PRICE` (default 0.000003 USDT0/token = 3,000 USDT0 opening valuation), `RPC_URL`, `POSITION_MANAGER`, `SWAP_ROUTER`. Defaults target the canonical Uniswap v3 deployment on Stable per [docs.stable.xyz](https://docs.stable.xyz/en/reference/dexes).

Verification settings for stablescan.xyz: solc 0.8.26, optimizer on (200 runs), `viaIR: true`, EVM version `paris`.

## Frontend

Open `frontend/index.html` (one static file — host it anywhere). Click the gear icon and paste the deployed launchpad address. It has the full pegd.fun-style experience: live trade ticker, market cards with graduation progress, token pages with price sparkline (from onchain Swap events), a trading-fees card showing real unclaimed amounts (simulated via `collect` staticcall) with a one-click claim, buy/sell panel with 25/50/75/MAX chips quoting through QuoterV2, and a launch form with image/description/socials (stored onchain as JSON in the token's `metadataURI`) plus optional dev buy. Light and dark themes.

## Key behaviors

Buys are native USDT0 through SwapRouter02 — no approvals. Sells approve the router once, then swap-and-unwrap in one multicall so sellers receive native USDT0. The launchpad owner can only change the creation fee, fee split (within bounds), start price for future launches, and fee recipient — there is no admin power over tokens, pools, or locked positions.

## Disclaimers

This code is unaudited. Get a professional audit before deploying with real value at stake. Operating a token launchpad may have legal/regulatory implications depending on your jurisdiction — this is not legal advice; consult a lawyer.
