# mintd — launch a token for $1, then build a currency around it

mintd started as a memecoin launchpad on **Stable** (chain 988, where gas is paid in USDT0): launch a fixed-supply ERC-20 for about a dollar, with real Uniswap V3 liquidity locked from block one. It has grown into a full onchain stack for **creating and running currencies** — a reserve token whose backing only rises, overcollateralized gold, discounted vesting bonds, and self-driving treasury agents — all in immutable, verified contracts. The whole thing ships as a single-file frontend at [mintd.fun](https://mintd.fun).

Every contract is verified on stablescan, most are immutable once deployed, and there is no admin path to user funds anywhere in the stack.

## The stack

### Create

- **InstantLaunchpad / MintdLaunchpad** — launch a fixed 1B-supply ERC-20 (no owner, no tax, no blacklist, no limits) for ~$1. The entire supply mints into a single-sided token/USDT0 Uniswap V3 position in the launch transaction. Trading is live from block one; there is no bonding curve and no migration. The position NFT is held by the launchpad, which has **no code path to withdraw it** — locked forever, verifiable onchain. Fees accrue to the position and `claimFees(token)` pays 90% to the creator and 10% to the platform in one call, callable by anyone.

### Back & stabilize

- **MINTR** — a reserve token. Trading fees stay inside the reserve, so **backing per token only rises**. It is priced as reserve ÷ supply, mintable and redeemable on demand within a tight fee band, with no function that can withdraw the backing.
- **MintSynth / MGLD** — **overcollateralized gold**. Mint MGLD against USDT0 collateral, priced by a RedStone oracle, liquidatable at a discount once a vault falls below its health ratio.
- **BuybackBurner** — holds USDT0 and can only buy $MINTD and send it to the dead address. No owner, no withdrawal path.

### Automate — the agents

- **BuybackVault** — a vault you own that buys a coin on a countercyclical rule and takes profit on real pumps. The keeper proposes only **timing**; every price, size and minimum is derived inside the vault from the pool's TWAP, so a stolen keeper key can waste gas but can never choose a fill, a venue, or a recipient. A cumulative-drawdown breaker bounds a misbehaving agent to a few percent. **Only the owner withdraws**, at any time.
- **AgentVault** — the same trust model for a Uniswap V3 LP position: the agent proposes a tick range and a time, clamped to the pool TWAP, and rebalances only once price drifts most of the way to an edge. Modes run from propose-only (you approve each move) to fully autonomous.
- Both are deployed from factories, where `isVault(x)` is the trust anchor, and driven by **one keeper**. Every trade is an onchain event, surfaced live on the site.

### Raise

- **BondMarket** — discounted, vesting token sales. A creator escrows tokens up front, buyers pay USDT0 at a fixed price, and the tokens release over a vesting period instead of hitting the pool at once. Escrow-first, so the raise needs no trust; the only route back to the creator is the unsold remainder after the window closes. 1% fee to the treasury.

### Lock & custody

- **TokenLocker** — time-locked ERC-20 custody, extend-only, no admin route to locked funds.
- **V3PositionLocker** — permanent LP lock; fees stay claimable by the beneficiary.

### Infrastructure

- **MintSwap** — an in-house Uniswap V2 fork (router + factory), farms and zaps.
- **MintrArbMulti** — arbs MINTR across every pool, plus cross-pool.
- **TokenMetaRegistry** — creator-gated metadata overlay for token pages. No owner at all.
- **frontend/index.html** — the entire site: launch, swap, bonds, agents, earn, gold, MINTR, lockers, a screener and holder pages. One file, no build step.
- **scripts/** — the stats indexer, the agent keeper, and Telegram buy alerts.

## Live on Stable (chain 988)

```
Launchpad (current)  0xCe7b02b3f0e5665f1C23E018039e9b6836c6221b
MINTD                0xE62C47074abb52A2bc87B62E47e3411A0020f020
MINTR (reserve)      0x8817D05f2560189F3697028f639Dbb4C68688400
MintSynth            0x09Eb7D9B18e56270F8898C4f3Ac3F2dc99F3b213
MGLD (gold)          0x872a3C280B846759187c9E57F62d1Ed8407b135C
BuybackBurner        0x7F007fbc6061806888A39A79763808aF5B94F4f4
BondMarket           0xD98780804449cC3b01Cd9A37fbaD808d01e24383
BuybackVaultFactory  0x3db601869c2C47Bfa9b08c62E077Df4806C1283A
AgentVaultFactory    0x28A9C05d0e31E2fEBf983F479d3c0278794BEE35
TokenLocker          0x1833D9442021AFDa97a573d9cdA65e2aa3449160
V3PositionLocker     0x55233aef2ecEE21a73a4655d9527D44eF13ba0d2
TokenMetaRegistry    0x95B93c48522d0D53Bd2419bbC5Dc7e36E130E2BB
MintrArbMulti        0xa96C23E75dd0e3b0B2548788ec72b3069d48a2C2
MintSwap router      0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7
MintSwap factory     0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E
USDT0 (gas + quote)  0x779Ded0c9e1022225f8E0630b35a9b54bE713736
```

Every one has verified source on stablescan (Etherscan V2, `chainid=988`).

## Build & test

```bash
npm install
node scripts/compile.js          # all contracts -> build/ (evmVersion: paris)
```

The suites run against a real in-process EVM (ganache) with real Uniswap contracts, not mocks of the parts that matter:

```bash
node scripts/test-instant.js         # launchpad
node scripts/test-synth.js           # MGLD CDP — 37 tests
node scripts/test-arb-multi.js       # MINTR arb — 36 tests
node scripts/test-bonds.js           # BondMarket — 52 tests
node scripts/test-buyback-vault.js   # buyback agent — 61 tests, incl. a hostile-keeper suite
node scripts/test-vault-keeper.js    # the keeper decision rules (pure, no chain)
```

Contracts that hold user funds go through `/security-review` before deploy.

## The frontend

`frontend/index.html` is the whole app in one static file — host it anywhere. It carries the launch form, a Uniswap V3 swap with best-route quoting, the bonds and agents pages, the MGLD gold engine, the MINTR reserve, farms and zaps, lockers, a chain-wide pools page, a screener, and holder pages, in light and dark themes. Netlify serves it with no build step; `scripts/stats-indexer.js` and the keeper publish live data as committed JSON.

## Deploy

Deploys target the canonical Uniswap V3 on Stable (per [docs.stable.xyz](https://docs.stable.xyz/en/reference/dexes)). Verification: solc 0.8.26, optimizer on (200 runs), `viaIR: true`, EVM version `paris`. Each contract's deploy script reads its key from a local `.env` (never committed) and prints only the variable name.

## Disclaimers

This code is provided as-is. Contracts hold real value and most are immutable once deployed — get an independent audit before deploying anything with funds at stake. Nothing here is financial or legal advice; operating a launchpad or issuing tokens may carry regulatory obligations in your jurisdiction. Do your own research.
