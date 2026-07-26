# mintd.fun — Arc chain port + agentic economy

Notes captured 26 Jul 2026. Nothing here is started yet.

---

## 1. Porting mintd to Arc (Circle's L1)

### Status of Arc (verified 26 Jul 2026)
- Public **testnet live since Oct 2025**, open to anyone: deploy contracts, request
  testnet assets, use the explorer.
- **Mainnet beta expected later in 2026**; the whitepaper targets summer 2026.
- EVM-compatible L1, **native USDC** (not USDT0).
- 100+ institutional partners on testnet (BlackRock, Visa, AWS).

### Two things that shape the port

**a) USDC, not USDT0.** Every hardcoded USDT0 address, the 6-decimal handling and
the gas-token assumptions need to become per-chain config instead of constants.
Mechanical work, but it touches every contract and the whole frontend.

**b) DEX dependency is the real blocker.** The launchpad needs a canonical
Uniswap V3 deployment (NonfungiblePositionManager + SwapRouter). If Arc has no
Uniswap V3 at launch, the launchpad cannot run as built.

> Advantage: we already own **MintSwap**, a working Uniswap V2 fork. We are not
> blocked waiting on anyone. Tradeoff: V2 has no concentrated liquidity, so the
> one-sided-range bonding curve has to be reworked for a V2 launchpad.
> **Decide this early, it changes the contract work substantially.**

### Prep order
1. **Chain-config module.** Extract addresses, decimals, quote token and gas token
   into per-network config. Makes any future chain a config file, not a fork.
   Costs nothing if Arc slips.
2. **Deploy the full stack to Arc testnet** and leave it running.
3. **Apply to Circle ecosystem / grant programs** while pointing at a live
   testnet deployment. "First launchpad on a Circle chain, already deployed" is a
   strong pitch; institutional chains reward early credible builders with support
   and placement.

---

## 2. Agentic economy features

### The standards that matter (verified 26 Jul 2026)
- **x402** — Coinbase's protocol using HTTP 402 for instant stablecoin payments.
  Live on Base and Solana, settles mostly in USDC. Backed by the x402 Foundation.
- **ERC-8004** — agent identity + reputation registry. Published Aug 2025, live on
  Ethereum mainnet **Jan 2026**. Lets an agent prove identity onchain and carry a
  track record without a central intermediary.
- Agentic commerce ~$8B transaction value in 2026; projections to $3.5T by 2031
  (treat projections with suspicion, but the direction is real).

### Strategic insight
**An agent economy needs an issuance layer, and mintd already is one.**
`launch()` is permissionless today, so any agent with a wallet can already use it.

### Features, cheapest first
1. **Machine-readable interface.** `llms.txt`, documented ABIs, ideally an MCP
   server so agents can discover mintd, read markets and execute. Cheap. Makes
   mintd the default when an agent needs to launch or trade. Nothing on Stable
   has this yet. **Start here.**
2. **x402-gated endpoints.** Agents pay per call in USDC for market data, launch
   access or priority. Turns agent traffic into revenue instead of load.
3. **Agent-launched tokens as first-class.** SDK + token pages showing the
   launching agent's ERC-8004 identity and reputation. "Launched by a verified
   agent with 340 successful transactions" is a trust signal no other launchpad
   shows.
4. **Agent-run keeper jobs.** MGLD liquidations and the buyback-burn trigger are
   already permissionless and profitable. Publish a spec, let agents run them.
   Free infra reliability plus an agent community around the protocol.

### Honest caveat
The agentic narrative is hot and a lot of current volume is speculative. Build the
machine-readable layer because it is genuinely useful and cheap; let the market
justify x402 billing infrastructure before investing in it.

---

## Sources
- Circle Arc public testnet: https://www.circle.com/pressroom/circle-launches-arc-public-testnet
- Arc mainnet timing: https://phemex.com/news/article/circle-unveils-arc-blockchain-whitepaper-mainnet-launch-set-for-summer-2026-82817
- x402 + ERC-8004: https://thegraph.com/blog/understanding-x402-erc8004/
