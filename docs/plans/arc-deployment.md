# Arc deployment

Status: draft
Date: 2026-07-27

## What problem this solves

Arc is Circle's stablecoin-native L1: EVM, sub-second finality, **gas paid in
USDC**. That is the same architecture as Stable, where gas is USDT0. The mintd
stack was built against that assumption, so Arc is the one other chain where it
ports without redesign.

Mainnet is targeted for summer 2026 and is not live yet. Testnet has been up
since October 2025 and has processed hundreds of millions of transactions.
The window to be deployed and tested before day one is now.

## What it does not do

- **No bridge.** See "Why not a bridge" below. Use whatever bridge exists.
- No new token. MINTD stays on Stable. An Arc deployment is a second venue for
  the launchpad, not a second treasury.
- No mainnet deploy until Arc mainnet is actually live and Circle's own USDC
  bridge status is known.

## Network facts to verify before writing code

Confirm each of these directly rather than trusting this file, since the chain
is pre-mainnet and details move:

- Arc testnet chain ID `5042002`, RPC `https://rpc.testnet.arc.network`,
  explorer `testnet.arcscan.app`
- USDC on Arc appears at a system address (`0x3600...0000` per Envelope's docs).
  **Check its decimals.** USDC is 6-dec as an ERC-20; if Arc mirrors Stable's
  dual-decimal gas model, the same 1e12 trap from CLAUDE.md gotcha 6 applies
- Does the RPC batch JSON-RPC? Stable's rejects batches entirely. Do not assume
  either way, measure it (CLAUDE.md gotcha 1)
- `eth_getLogs` caps: measure the block-span and result caps before porting
  `stats-indexer.js` (CLAUDE.md gotcha 2)
- Block time, for any "24h" window derived from block counts (gotcha 3c)
- Is Uniswap V3 deployed? The launchpad depends on the NPM, router02 and
  QuoterV2. If they are absent, MintSwap (the V2 fork) is the fallback, which
  is an argument for owning the AMM

## Contracts touched

Port order, cheapest and least risky first:

1. `MintSwap` factory + router. No external dependency, and it is the fallback
   if Uniswap V3 is not on Arc
2. `InstantLaunchpad`. Swap USDT0 for USDC as the quote asset. Verify decimals
3. `TokenLocker`, `V3PositionLocker`, `TokenMetaRegistry`. Self-contained
4. `MINTR`. Reserve token, quote asset changes
5. `MintSynth` / `MGLD`. **Blocked on oracle.** Confirm RedStone or an
   equivalent gold feed exists on Arc before assuming this ports at all

Everything above touches user funds. Every one gets `/security-review` before
deploy.

## How it can lose money

- **Decimal mismatch.** USDC is 6-dec. Every place the code assumes USDT0's
  layout is a 1,000,000x bug waiting to happen. This has already bitten once
- **Missing oracle.** MGLD without a trustworthy gold feed is a CDP that can be
  liquidated on a wrong price, or not liquidated when it should be
- **No liquidity.** A launchpad on a chain with no traders produces pools that
  cannot be exited. Slippage losses land on real users, as already happened
  once on Stable for ~$68
- **Deploying pre-mainnet state to mainnet.** Testnet addresses hardcoded into
  a mainnet frontend point users at contracts that do not exist
- **Key reuse.** The Stable deployer key is compromised. It must never touch
  Arc. New chain, new key, generated fresh

## Why not a bridge

Envelope already runs a Base to Arc bridge: USDC locks in a Base vault, eUSD
mints on Arc one for one, redeem burns first and then releases. Their docs are
explicit that eUSD is not USDC and not issued by Circle, and they publish a
wind-down: when Circle's own bridge opens, eUSD exchanges for native USDC one
for one, and the exchange refuses to open unless reserves fully cover supply.
That is a well-designed piece of work.

Reasons not to copy it:

- A lock-and-mint bridge is the single most attacked primitive in this
  industry. The reserve is a standing bounty equal to everything bridged
- This codebase has never had an external audit, and the original deployer key
  is compromised and still owns live contracts. That is the wrong starting
  position for custody of other people's dollars
- Circle is shipping its own USDC bridge to Arc. Any third-party bridge is
  building toward its own obsolescence, which is exactly why Envelope wrote a
  wind-down plan on day one
- The mintd edge is launch mechanics and reserve design, not custody

If bridged dollars are needed on Arc, integrate an existing bridge. Do not
become one.

## Tests that must pass before deploy

- [ ] full existing suite green against Arc-configured addresses
- [ ] decimal round-trip test: deposit, mint, redeem, assert exact balances
- [ ] launchpad end to end on Arc testnet, including a real swap
- [ ] indexer runs against Arc testnet and produces correct volume
- [ ] `/security-review` on every contract holding funds

## Deploy steps

1. Fresh keypair for Arc. Never the Stable deployer key
2. Deploy to Arc **testnet** first and leave it running long enough to index
3. Confirm Arc mainnet is actually live, and its real chain ID and USDC address
4. Deploy to mainnet, verify sources on the Arc explorer immediately
5. Frontend: chain switcher, not a fork of the site

## Rollback

Contracts are immutable once deployed, so there is no rollback. The mitigation
is the testnet phase and the security review. If a mainnet contract is wrong,
the only remedy is deploying a replacement and migrating liquidity, which is
slow and public. Budget for getting it right the first time.

## Open question for Ty

Arc is institutional: Visa, BlackRock and HSBC are on the testnet, and Circle
is a regulated issuer. A memecoin launchpad may be a poor cultural fit, and
worth deciding deliberately rather than by momentum. The launchpad, the locker
and MGLD are three different propositions on a chain like that.
