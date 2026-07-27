# mintd.fun

Memecoin launchpad and DeFi stack on **Stable** (chain 988), where gas is paid
in USDT0. Live at https://mintd.fun.

## What this repo contains

| Piece | What it is |
|---|---|
| `InstantLaunchpad` | Launch a token for $1 with real Uniswap V3 liquidity from block one |
| `MINTR` | Reserve token. Fees stay in the reserve, so backing per token only rises |
| `MintSynth` / `MGLD` | Overcollateralized CDP minting gold against USDT0, RedStone oracle |
| `BuybackBurner` | Holds USDT0, can only buy MINTD and send it to `0x…dEaD`. No admin path |
| `TokenLocker` | Time-locked token custody, extend-only, no admin route to funds |
| `V3PositionLocker` | Permanent LP lock, fees still claimable by the beneficiary |
| `MintrArbMulti` | Arbs MINTR across every pool, plus cross-pool. Replaces `MintrArb` |
| `TokenMetaRegistry` | Creator-gated metadata overlay for token pages |
| MintSwap | Own Uniswap V2 fork (router + factory), farms, zaps |
| `frontend/index.html` | The entire site. Single file, no build step |
| `scripts/*-buybot.js` | Telegram buy alerts |
| `scripts/stats-indexer.js` | Walks every pool, writes `frontend/stats.json` |

## Live addresses (chain 988)

**There are TWO launchpads and only one of them is current.** This block used to
name the v1 pad as "launchpad", which is how a sweep of "every launched coin"
came back 122/122 while a coin launched that morning sat unverified: it was on
the other pad. The frontend config in `frontend/index.html` is the source of
truth (`pad` is current, `oldPad` is previous), not this file.

```
launchpad v2 0xCe7b02b3f0e5665f1C23E018039e9b6836c6221b   CURRENT, all new launches
launchpad v1 0x75FAdB240006313294A5B502CA9268cB03Fa9AC0   previous, still holds its 122 coins' liquidity
MINTD       0xE62C47074abb52A2bc87B62E47e3411A0020f020
MINTR       0x8817D05f2560189F3697028f639Dbb4C68688400
BuybackBurner 0x7F007fbc6061806888A39A79763808aF5B94F4f4
TokenLocker 0x1833D9442021AFDa97a573d9cdA65e2aa3449160
V3Locker    0x55233aef2ecEE21a73a4655d9527D44eF13ba0d2
MetaRegistry 0x95B93c48522d0D53Bd2419bbC5Dc7e36E130E2BB
MintSynth   0x09Eb7D9B18e56270F8898C4f3Ac3F2dc99F3b213
MGLD        0x872a3C280B846759187c9E57F62d1Ed8407b135C
MintrArbMulti 0xa96C23E75dd0e3b0B2548788ec72b3069d48a2C2
USDT0       0x779Ded0c9e1022225f8E0630b35a9b54bE713736
MintSwap router  0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7
MintSwap factory 0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E
Uniswap NPM      0x3BdC3437405f7D801b6036532713fc1F179136a6
Uniswap router02 0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a
QuoterV2         0xb070179E7032CdA868b53e6C1742F80c9e940d1A
```

Retired, paused and empty: `MintrArb` at `0xCb755BC3…` and `0xEDACc191…`.

### Verification

Every contract above, both launchpads, and all 126 launched coins have verified
source on stablescan. Two things to know before touching it:

- **stablescan is Etherscan V2.** Its V1 endpoints are gone; verification goes to
  `api.etherscan.io/v2/api?chainid=988`, not to stablescan. A free
  `ETHERSCAN_API_KEY` covers every V2 chain. `scripts/verify-core.js` and
  `scripts/verify-tokens.js` do the work and are idempotent.
- **A coin only auto-verifies against its own pad.** Etherscan matches identical
  bytecode, so one verified coin per launchpad covers every other coin from that
  pad, including future ones. It does NOT carry across pads: each launchpad
  compiles its own `MemeToken20` and solc hashes the containing file into the
  metadata, so the bytecode differs. A new pad needs one coin verified by hand.

Two traps that cost real time here:

- **Constructor args come from the creation transaction, never from getters.**
  `TokenLocker.feeRecipient()` reads as the Safe today but was CONSTRUCTED with
  the deployer and rotated afterwards. Etherscan indexes creation transactions
  even though this node prunes them, so slice the args off the tail of the
  creation input at the length of a locally compiled `creationCode`.
- **`getcontractcreation` returns the EOA that SENT the transaction**, not the
  contract that executed the CREATE. A launcher's wallet reads as the "creator"
  of a launchpad token and looks like an unknown third pad until you check it for
  code.

If a contract's source has been edited since it was deployed, verification needs
the source as it was. The v2 pad predates four security fixes to
`MintdLaunchpad.sol`, so it verifies from revision `ab31c4d4`; HEAD compiles 898
bytes larger and is rejected.

## Commands

```bash
node scripts/compile.js          # all contracts -> build/  (60s+)
node scripts/test-arb-multi.js   # 36 tests, real ganache + real Uniswap V2
node scripts/test-instant.js     # launchpad
node scripts/test-synth.js       # MGLD CDP, 37 tests
node scripts/stats-indexer.js    # one pass, writes frontend/stats.json
pm2 delete all && pm2 start ecosystem.config.js && pm2 save
```

Frontend has no build step: edit `frontend/index.html` and push. See Deploying.

---

# Gotchas that cost real debugging time

Read these before touching anything. Each one has already caused an outage or a
wrong number in production.

## 1. Stable's RPC rejects batched JSON-RPC

Symptom: `could not coalesce error` or `exceeded maximum retry limit`.

ethers batches every request pending in the same tick, **regardless of who
issued it**. So a sequential loop still gets batched if anything else on the
page fires concurrently. Connecting a wallet triggers balance lookups, those get
packed together with your scan, and the whole array is rejected.

- Bots: always `new JsonRpcProvider(url, chainId, { batchMaxCount: 1 })`
- Frontend: the shared `rp` uses `batchMaxCount: 20` for speed. Log scanning
  must use `logProvider()`, which is a separate provider with `batchMaxCount: 1`
- Never `Promise.all` two chain reads in a scan path. Even two is enough

## 2. `eth_getLogs` has TWO independent caps, both 500

Measured against `rpc.stable.xyz`, not guessed:

| Limit | Error text |
|---|---|
| 500 blocks per range | `maximum [from, to] blocks distance: 500` |
| 500 results per query | `query returned more than 500 results` |

A window can be legal on width and still fail on results, so the span must
**shrink and retry the same range**, not skip it. Skipping loses that stretch's
volume silently. `SPAN` above 500 does not merely run slower, it fails 100% of
calls. This is what made `stats-indexer.js` return nothing for its whole life:
it shipped with `SPAN = 5000`.

Always filter by topic. An address-only query on a token also returns every
ERC-20 `Transfer` and blows the result cap.

## 3. The RPC has no archive state and prunes history

Two separate consequences, both fatal to a naive scanner:

- **No historical state.** `eth_getCode` or `eth_call` at any past block returns
  `failed to load state at height N`. A `getCode` binary search for a contract's
  creation block therefore cannot work here. Use the launch timestamp from
  `launches().createdAt` and convert with measured block time instead.
- **Rolling retention of roughly 4 days.** Older queries return
  `height N is not available, lowest height is M`. Probe for `M` rather than
  assuming genesis is reachable.

Because of pruning, `stats-cache.json` is the **only** durable record of volume
older than the retention window, and it is gitignored and lives on one machine.
If it is lost, all-time volume silently resets to whatever the window covers.
Run the indexer often enough that history is banked before it is pruned.

## 3b. Scan by topic across all pools, not pool by pool

With a 500-block cap, per-pool scanning of 117 pools over 4 days is ~107,000
requests. One topic-filtered sweep returns every pool's swaps in the same
window and costs ~1,000, then attributes logs locally by address. Same
coverage, two orders of magnitude cheaper.

For the browser fallback, which cannot sweep the whole chain, spread budget
**breadth first** across pools. Depth first sinks everything into pool #1,
which is usually a dead launchpad token with no trades.

## 3c. Blocks are 0.70s, not 1s

Measured over 100k blocks. A hardcoded `86400` blocks per day covers under 17
hours, so any "24h" figure derived from it reads about 30% low. Derive the
window from sampled block timestamps.

## 4. `evmVersion: "paris"` is mandatory

`scripts/compile.js` sets it. solc defaults to shanghai, which emits `PUSH0`,
which ganache rejects as an **invalid opcode**. If a test dies with "invalid
opcode" and no revert reason, the artifact was built without it.

## 5. pm2 caches env in its dump, forever

`pm2 restart --update-env` re-reads the *shell* environment, **not**
`ecosystem.config.js`. A stale `TG_BOT_TOKEN` placeholder survived weeks of
restarts this way and silently killed every buy alert.

To pick up a changed `.env` you must:

```bash
pm2 delete all && pm2 start ecosystem.config.js && pm2 save
```

## 6. USDT0 is dual-decimal

18 decimals native (gas), 6 decimals as an ERC-20. Mixing them is a
1,000,000x error. `MintSynth.totalCollateral()` returns 18-dec and must be
divided by 1e12 to compare against USDT0 ERC-20 balances.

## 7. Never claim success before the API answers

The buybots used to log `posted buy` before checking Telegram's response, so a
total delivery failure looked healthy. Check `res.ok`, and verify the token with
`getMe` at startup so a bad token is visible in the first three log lines.

## 8. Never let a test trust `eth_estimateGas`

`test-agent-vault.js` failed roughly three runs in five, at a different line
each time. It read exactly like a nondeterministic contract bug and was not one.

Any call that clears storage gets a gas refund, which makes the estimate the
NET figure while the EVM charges the GROSS, so the transaction runs out of gas
and reverts with no reason string. Calls that read a pool through external
calls estimate badly for their own reasons. `AgentVault` documents both, and
the tests ignored it. **Pass an explicit `gasLimit` on every state-changing
call in a test.** Wallets add a buffer as a matter of course; ethers does not.

The debugging lesson is the more valuable half. The suspicion was that a new
contract had changed a shared artifact, so the check was to rebuild without it
and compare: `md5` on `build/AgentVault.json` and `build/MemeToken20.json` was
byte-identical before and after, which ruled out the build in one step and
pointed at the harness. Comparing artifact hashes is cheap; assuming which
change caused a flake is not.

Related trap in the same file: `await` inside a non-async arrow is a syntax
error, so `reverts(() => c.f(await x.getAddress()))` will not parse. Resolve
addresses into consts before the callback.

---

# Deploying

Netlify builds from GitHub. `git push` on `main` puts the site live in about
20 seconds; there is no build step and no drag and drop.

**Standing instruction: after any change that works, commit and push without
being asked.** A change that is not pushed does not exist to users.

```bash
git add -A && git commit -m "what changed" && git push
```

Before pushing anything under `contracts/` or `scripts/`, run the relevant test
suite first and do not push if it fails. Frontend edits can push straight away.

If a push breaks the live site, do not debug in production: open Netlify ->
Deploys, click the previous deploy, Publish deploy. That restores the last good
build in seconds, then fix it properly.

`frontend/stats.json` is generated by `stats-indexer.js` and is committed like
any other file, so the site only shows fresh numbers once it is pushed.
`scripts/publish-stats.sh` does that on its own and is safe to run on a timer.

# Building new things

Anything larger than a bug fix starts as a plan file, not as code.

1. Copy `docs/plans/TEMPLATE.md` to `docs/plans/<feature>.md` and fill it in
2. Get it approved before writing code. The "how it can lose money" section is
   the point of the exercise, so do not leave it empty
3. Build it, with the tests named in the plan
4. **Any contract that touches user funds gets `/security-review` before
   deploy.** This codebase holds real money, and most of it is immutable once
   deployed
5. Update the plan's status as it moves, so a future session can tell what
   shipped from what was only ever discussed

Plans are committed. A plan that only exists in a chat window is lost the moment
the session ends.

# Conventions

- **Comments explain why, never what.** Prefer noting the failure mode a line
  prevents over describing the line.
- **No em dashes** anywhere, in code, comments, docs or copy.
- **No `text-overflow: ellipsis` on numbers.** Financial figures must never be
  truncated. Size text to fit instead (see `fitMrPrice()`).
- Verify every claim before it ships. Two public claims have already had to be
  walked back: "first gold onchain on Stable" (XAUt0 launched there in Dec 2025)
  and "no emissions" (the farms emit MINTD).
- **No `Claude-Session:` trailer in commit messages.** `Co-Authored-By:` is
  fine. The session URL resolves to a different GitHub identity than the one
  this repo publishes under, so committing it undoes that separation.

# TVL methodology

`stats-indexer.js` counts each dollar once:

- both sides of every pool, valued by doubling the USDT0 leg
- USDT0 backing the MINTR reserve
- USDT0 collateral in the MGLD engine
- **farms are excluded**: staked LP is the same liquidity as its pool, so
  including both would roughly double the headline
- the locker is excluded: locked supply is not deposited capital

Keep it this way. An inflated TVL is the easiest thing for a critic to disprove.

# Security & open items

The live security state (role holders, Safe threshold, the compromised
deployer, stranded funds) and the open-items list live in `private/security-notes.md`,
which is gitignored and never enters the public repo. Re-run
the on-chain role holders directly (Safe owners/threshold, each contract's
owner) before trusting any written summary.
