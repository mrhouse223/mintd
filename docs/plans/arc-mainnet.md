# arcswap.vip: Arc mainnet launchpad, agent vaults, and a USDC bridge

Status: draft. Bridge contract built, reviewed and tested; nothing deployed.
Date: 2026-07-29

## What problem this solves

Arc mainnet is live and trading. mintd has a launchpad proven on Stable across
121 tokens, and an agentic LP vault that nothing else on Arc has. Neither is
reachable by anyone on Arc mainnet, and nobody can bring USDC from Base without
leaving the site. This puts both on Arc and gives people a way in.

## Facts, every one read from the chain rather than a docs page

Verified 2026-07-29 against `https://5042.rpc.thirdweb.com`.

| Thing | Value | How it was established |
|---|---|---|
| Chain id | `5042` (`0x13b2`) | `eth_chainId` |
| Gas token | USDC at `0x3600…0000`, **6-dec** ERC-20, 7,016,606 supply | `symbol`/`decimals`/`totalSupply` |
| Gas price | ~25 gwei | `eth_feeHistory` |
| UniswapV3Factory | `0xf0db7b58379503491d857dB50AC9ece64c653918` | read `factory()` off four live pools |
| NonfungiblePositionManager | `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377` | emits `IncreaseLiquidity`, `UNI-V3-POS`, factory matches |
| SwapRouter02 | `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` **UNCONFIRMED** | a swap entrypoint whose `factory()` matches; busier entrypoints look like aggregators |
| CCTP v2 TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` on Base AND Arc | `eth_getCode` on both |
| CCTP MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` on both | as above |
| CCTP domain | Base **6**, Arc **26** | `localDomain()` on each chain |
| Our balances on Arc mainnet | **0.0** on all three keys | `eth_getBalance` |

Uniswap V3 is **not** at its canonical addresses on Arc, so nothing here may be
copied from another chain's deployment. Every address above was discovered from
live chain state, and the one still marked UNCONFIRMED must be confirmed before
it is wired to anything, because a wrong router is the single worst thing to get
wrong: `AgentVault._swap` approves the router and hands it the balance.

## The two sites, confirmed

| Site | Chain | Contents |
|---|---|---|
| mintd.fun | Stable (988) | launchpad + DeFi stack, unchanged |
| **arcswap.vip** (was mintd.money) | **Arc mainnet (5042)** | $ARCS as token #0, agent vaults, Base to Arc bridge |

`arcswap.vip` is registered at Porkbun and currently parked on
`207.207.210.x`, the same parking IPs that broke the mintd.money certificate.
DNS has to point at Netlify, and the apex plus `www` both need to resolve there
before a certificate will issue. See the mintd.money entry in STATE.md; that
failure took weeks to diagnose and the cause was never Netlify.

## Token terms on arcswap

- **80/20 creator/protocol** on pool fees.
- **Nothing hardcoded about burning or buyback.** Confirmed against the
  contract: `MintdLaunchpad` needs no change for this. `creatorShareBps` is
  settable within a floor of 5,000, so 8,000 is legal; the protocol remainder is
  split between two plain addresses by `buybackShareBps`, and the field named
  "buyback" is only a label on a transfer. Setting `buybackShareBps` to 0, or
  pointing both recipients at the same treasury, gives a clean two-way split
  with no burn and no buyback anywhere in the path. The contract's own comment
  at line 537 documents this as the intended way to run a simple split.
- $3,000 starting market cap, quoted in **USDC** rather than USDT0.
- Graduation and dev-buy cap as per the existing Arc terms.

**This makes ownership load-bearing.** `setFeeRecipients` and the share setter
are `onlyOwner`, so whoever owns the launchpad can redirect the protocol 20% at
any time. The creator share is floored at 50% by `MIN_CREATOR_SHARE_BPS`, so a
compromised owner cannot rug creators below that, but it can take the whole
protocol cut. A hot key in `.env` is a poor holder of that power.

## What it does not do

**It does not build a bridge.** This is the most important line in the document.
Arc is Circle's chain and USDC is native on both ends, so Circle's CCTP already
does exactly this, and it is deployed on Base and Arc at the addresses above. A
custom bridge would mean writing the one category of contract that has lost more
money than any other in this industry, to duplicate infrastructure that already
exists and that we would never out-audit. The bridge here is a **frontend flow
over CCTP**: approve USDC, `depositForBurn` on Base to domain 26, poll Circle's
attestation, `receiveMessage` on Arc. **No new contract, so nothing new to
audit and nothing new that can be drained.** If the ask is a bridge we operate
and custody, that is a different plan and my answer to it is no.

**It does not claim to be first.** dyorarc.fun is already live on Arc mainnet
with real volume: the token you linked, Architects, is at roughly $589K with
1,078 transactions. "First launchpad on Arc" is not available and saying it
would be the third public claim this project had to walk back. What IS available,
and is the real differentiator, is **the first agentic LP platform on Arc** -
`AgentVault` plus its factory are built, reviewed and proven, and nothing else
there has them.

**No agent vaults holding mainnet funds on day one.** See the staging below.

## Contracts touched

Nothing new is written. Three things already reviewed get deployed to a new
chain, with their wiring re-verified for that chain:

- `MintdLaunchpad` + `MintdMetaRegistry`, as on Arc testnet.
- `AgentVaultFactory`, which fixes `npm` and `router` immutably at construction.
  **This is where the UNCONFIRMED router becomes load-bearing**: the factory can
  never be repointed, so a wrong address there means every vault it ever creates
  is drained on its first rebalance. Confirm the router, then read `npm()` and
  `router()` back off the deployed factory and diff them before announcing it.
- No changes to `AgentVault.sol`. If mainnet appears to need one, that is a new
  plan and a re-review.

**Does this touch user funds?** Yes, directly and with real money. Every
contract here gets `/security-review` before deploy, and the launchpad gets its
Stable test suite re-run against Arc's addresses first.

## How it can lose money

- **A wrong router or position manager in the factory.** Total loss of every
  vault. Immutable, so unfixable after the fact. Mitigation: confirm on chain,
  read back after deploy, and do not skip it because the testnet worked.
- **Ownership on a hot key.** On Stable every role sits on a Safe. `.env` holds
  `ARC_DEPLOYER_KEY` on this laptop, and using it as the mainnet launchpad's
  owner and `feeRecipient` puts real fee flow behind a key that has only ever
  guarded testnet play money. Needs a decision before deploy, not after.
- **The 6-dec gas token.** USDC on Arc is 18-dec native and 6-dec as an ERC-20,
  the same trap as USDT0 on Stable. It has already produced one wrong number in
  this codebase, through a `decimals()` call that silently defaulted to 18.
- **CCTP misuse.** `depositForBurn` takes `mintRecipient` as bytes32. Getting the
  encoding wrong sends USDC to an address nobody controls, irreversibly. The
  destination domain must be 26, read from the chain, never hardcoded from
  memory. A wrong domain burns on Base and mints somewhere else entirely.
- **Bridging into a chain we cannot yet transact on.** We hold 0 on Arc, and gas
  is USDC, so the first bridge is also what funds the deploy. If it lands in the
  wrong place there is no second attempt without bridging again.
- **Thin launch liquidity.** Arc pools are 1% tier. `AgentVault`'s stock
  `maxSlippageBps` of 100 is exactly consumed by a 1% fee, so an agent vault on
  a 1% Arc pool cannot rebalance at defaults. Either the UI forces a higher
  slippage for such pools or agent vaults are offered only on 0.3% pools.

## Staging, because "first" is a bad reason to hurry

1. **Bridge only.** Ship the CCTP flow. It touches no contract of ours and is
   useful on its own. It is also what funds everything after it.
2. **Launchpad.** Deploy, verify wiring, launch one token with our own money,
   trade it, claim fees. Then open it.
3. **Agent vaults.** Only once a mainnet pool exists with real depth and a real
   TWAP. On testnet that took seeded volume; on mainnet it needs organic trading,
   and until `observe()` spans the window the vault's protections read spot.

## Tests that must pass before deploy

- [ ] existing suites green: launchpad, `test-agent-vault.js` (48),
      `test-agent-vault-factory.js` (64)
- [ ] a fork or ganache dry run of each deploy script against Arc's addresses
- [ ] CCTP flow proven with a **small** transfer end to end, Base to Arc, before
      any UI is offered to anyone
- [ ] launchpad smoke test on mainnet: launch, buy, sell, claim fees, all with
      our own funds
- [ ] `/security-review` on anything deployed
- [ ] read back and diff every immutable address on every deployed contract

## Rollback

The launchpad and factory are immutable with no admin, so there is no patch:
recovery is a new deployment and a frontend repoint, with old vaults staying
withdrawable by their owners. The CCTP flow is frontend only and reverts with a
push. Nothing here can be undone on chain, which is the reason for the staging.

## Open questions, all blocking

1. **Who owns the mainnet launchpad?** A new Safe on Arc, the existing Stable
   Safe address (if it is deployable there), or a hot key with fees swept often?
   This decides real money and cannot be changed after deploy.
2. **Where does the first USDC come from, and how much?** Deploys plus a seeded
   pool plus a smoke test. Needs a real number, bridged from Base.
3. **Confirm the router.** I have a candidate, not a certainty. Is there an Arc
   deployment reference you trust, or shall I confirm it by decoding a live swap
   calldata against the SwapRouter02 ABI?
