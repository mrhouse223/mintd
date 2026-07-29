# AgentVault factory

Status: **built, tested and reviewed. Not deployed.**
Date: 2026-07-29

## What problem this solves

`AgentVault` is built, tested and reviewed, but it can only be deployed by hand,
one vault at a time, by someone holding a deploy key. That is not a product. The
factory turns it into one: a user calls one transaction and gets their own vault,
owned by them, wired to the real Uniswap contracts, running exactly the reviewed
bytecode. The factory is the trust anchor. `isVault(x)` returning true is what
lets the frontend, and a user, say that address `x` is a genuine mintd vault and
not a lookalike with a hostile router in it.

## What it does not do

- No fees. Vault creation is free at v1; a performance or creation fee is a
  separate decision with its own plan, and bolting one on here would put the
  factory in the path of user funds it currently never touches.
- No upgradeability, no admin, no owner. See "Contracts touched".
- No CREATE2 or counterfactual addresses. Nothing needs to pre-approve a vault
  that does not exist yet, and a shared salt namespace is a griefing surface.
- No pool allowlist. Any canonical Uniswap V3 pool is allowed. A user who picks
  a bad pool harms only themselves, and an allowlist would need an admin to
  maintain, which is the thing this design is spending its budget to avoid.
- Does not change `AgentVault.sol` at all. If the review finds the factory needs
  a vault change, that is a new revision of the vault and a re-review, not a
  quiet edit.

## Contracts touched

**New: `contracts/AgentVaultFactory.sol`.** Holds no tokens, ever. It has no
`transfer`, no `approve`, and no payable function, so there is nothing in it to
sweep. It stores only the registry.

**Immutable at factory construction:** `npm`, `router`. These are the two
addresses a user must not be allowed to choose. A vault whose router is
attacker-controlled is drained on its first rebalance no matter how correct the
rest of the vault is, because `_swap` approves the router and hands it the
balance. Fixing them on the factory is what makes "deployed by the factory" a
meaningful statement about safety rather than a label.

**No owner and no admin at all**, matching `TokenMetaRegistry`. No setter for
`npm`, `router`, or the default agent. The reason is concrete: if the factory had
an owner who could repoint `router`, then compromising the Safe would silently
poison every vault created afterwards, and the compromise would not be visible in
any vault's own storage. Existing vaults would be safe (their addresses are
`immutable`), which is exactly what makes the vector easy to miss. Removing the
setter removes the vector. The cost is that rotating the keeper for new vaults
means the frontend passes a different `agent` argument, which it can do freely
because `agent` is a per-vault parameter the owner can change or revoke anyway.

**User-supplied at creation:** `pool`, `agent`, `numeraire`. Each is either
validated by the vault's existing constructor or harmless:
- `pool` is checked against `npm.factory().getPool(token0, token1, fee)`. That
  check already exists at `contracts/AgentVault.sol:320`, where the comment
  correctly calls it "load-bearing the moment a factory lets a user pass a pool
  address". This plan is that moment. It is the single line standing between the
  factory and a fake pool serving a forged `observe()`, from which every
  protection in the vault is derived.
- `agent` carries no authority by construction; the vault's whole thesis is that
  a fully compromised agent can waste gas and nothing else.
- `numeraire` is required to be one of the pool's two tokens.

**Owner is `msg.sender`, not a parameter.** Passing an arbitrary owner would let
anyone populate a stranger's vault list with vaults they configured, which is a
phishing setup: the victim opens the app, sees a vault under their address, and
deposits into one the attacker chose the agent for. Costs nothing to close.

**Does this touch user funds?** Yes, transitively and decisively. The factory
holds nothing, but it determines the wiring of contracts that hold everything.
`/security-review` before deploy, no exceptions.

## Architecture note: CREATE, not clones

The factory deploys with `new AgentVault(...)`, which embeds the vault's 16,231
byte creation code into the factory's own runtime. Measured, not assumed. With
factory logic on top that lands near 18–19 KB against the EIP-170 limit of
24,576, so it fits with roughly 6 KB of headroom.

This matters because the obvious size fix is wrong. EIP-1167 minimal proxies
would cut the factory to a few hundred bytes, and would also destroy the vault's
security model: `immutable` values live in the implementation's code, so every
clone would share one implementation's `owner`, `pool` and `router`. Making
clones work means moving `owner` and `pool` from `immutable` into storage, which
turns "not settable, at any price" (`AgentVault.sol:218`) into "settable if a
storage bug exists". The size headroom is what lets this stay unnecessary, so
the test suite asserts the factory's deployed size rather than leaving it to be
discovered on a mainnet deploy that reverts.

## How it can lose money

1. **Hostile router or NPM.** The whole game. Closed by making both immutable on
   the factory and unreachable from the create call. Test: no code path lets a
   caller influence either.
2. **Forged pool.** A contract reporting a real pool's `token0/token1/fee` while
   serving an attacker-controlled `observe()` makes the vault compute its minimum
   swap output from a fake TWAP while trading in the real pool. Every protection
   reads off that TWAP, so this is a total drain. Closed by the canonical-pool
   check. Test: a mock pool that mimics a real one is rejected at creation.
3. **Non-standard ERC-20 in a user-chosen pool.** The vault uses
   `require(token.transfer(...))`, which reverts on tokens that return no value
   at all (original-USDT style). Stable's USDT0 does return a bool, confirmed by
   `MintSynth` holding it in production, so the intended pools are fine. But the
   factory is permissionless over any pool, and with such a token `withdrawAll`
   reverts. Deposit reverts too, so the vault cannot be funded normally, but
   tokens sent directly to the address would be stuck permanently. Not a drain,
   and not silent, but it is a real way to lose funds and it is new with the
   factory. Decision needed, see Open questions.
4. **Pool with no TWAP.** A freshly launched pool has one observation slot, so
   `observe()` reverts and `deposit` reverts with it. Funds cannot enter, so
   nothing is lost, but it reads as a broken app. The vault constructor already
   requests cardinality 64. The frontend should warn before creation rather than
   letting the user find out at deposit.
5. **Registry griefing.** With `owner = msg.sender` an attacker can only spam
   their own list. `allVaults` is still globally appendable, so the frontend must
   index by owner and must never iterate `allVaults` to render a user's page.
6. **Unbounded view growth.** `vaultsOf(owner)` returning a large array is fine
   off-chain but must never be called on-chain by a future contract. Ship a
   paginated accessor alongside it and say so in the comment.
7. **Deposit-to-wrong-address.** Users sending tokens to the factory rather than
   a vault. The factory cannot forward them and has no rescue path, by design.
   Documented, not fixed; adding a rescue function would mean adding an owner.

## Tests that must pass before deploy

All green as of 2026-07-29. `scripts/test-agent-vault-factory.js` is 64 tests on
real ganache against real Uniswap V3, run 3x for stability.

- [x] existing suite still green: `node scripts/test-agent-vault.js`, 48 tests,
      8 consecutive clean runs (see "Flake found and fixed" below)
- [x] creates a working vault; owner is the caller, not the factory
- [x] the created vault's `npm` and `router` equal the factory's, and no
      argument can change them. Asserted against the compiled ABI as well, so
      adding such a parameter later fails the test rather than quietly widening
      the trust surface
- [x] forged-pool contract mimicking a real pool is rejected (risk 2), with the
      revert reason checked, not merely "it reverted"
- [x] a real Uniswap pool built on an unrelated factory is rejected
- [x] numeraire outside the pool is rejected
- [x] `isVault` true only for factory output; a byte-identical hand-deployed
      vault reads false
- [x] registry: multiple vaults per owner, per-owner isolation, pagination
      bounds including empty, zero-length, at-the-end and past-the-end
- [x] end to end: deposit, propose, approve, execute, withdrawAll returns
      principal to the owner, full cycle costs under 2%
- [x] the hostile-keeper suite re-run against a factory-created vault:
      12 attacks, 0 executed, value fell 1.56%, owner recovered 100%
- [x] deployed factory bytecode under 24,576 bytes: measured 18,049
- [x] hostile pool cannot reenter the factory, proven at the EVM level rather
      than inferred from the interface (see below)
- [x] `/security-review` on `AgentVaultFactory.sol`

### Proving the reentrancy claim rather than asserting it

The factory ships without a reentrancy guard because the pool reads that happen
before the canonical check are all `view`, so solc emits STATICCALL. That is a
claim about compiled output, so it is tested. The first attempt was wrong and
worth recording: asserting that the hostile pool's state write "never landed"
proves nothing, because the outer transaction reverts either way. The test now
compares revert reasons instead. An inert forged pool reaches the canonical
check and says `pool not canonical`; a pool whose `token0()` writes storage
never reaches it, so execution died inside `token0()` itself, which is only
possible under STATICCALL.

### Flake found and fixed

`test-agent-vault.js` failed about three runs in five, at whichever call
happened to land on a short gas estimate. Not a contract bug: `AgentVault`
documents these entry points as under-reported by `eth_estimateGas`, because
clearing a proposal refunds storage and the estimate comes back net while the
EVM needs gross. Bare `deposit`, `propose`, `setPolicy` and `resetCheckpoint`
calls now pass explicit gas limits, with a comment at the top of the file so it
does not regress. Confirmed pre-existing, not caused by this work: the
`AgentVault` and `MemeToken20` artifacts are byte-identical before and after.

### Security review result

No HIGH or MEDIUM findings. Confirmed by trace: `npm`/`router` are unreachable
after deployment (no setter, owner, delegatecall, assembly or selfdestruct);
the canonical-pool check resolves the Uniswap factory from the factory's own
`npm` rather than from caller input, and `getPool` is symmetric in token order
so reversing the pair gains nothing; `isVault` is written in exactly one place
immediately after a successful construction, and constructor reverts roll back
the whole transaction, so a partially-wired vault can never be registered.

The reviewer noted one accepted design risk rather than a finding: with no pool
allowlist a caller can point their own vault at a thin pool whose TWAP they can
move. The blast radius is their own capital, since they are the vault's owner
and its only permitted depositor, the factory holds no funds, and no state is
shared between vaults. That is the trade this plan already states under "What it
does not do".

## Deploy steps

1. `node scripts/compile.js` with `evmVersion: "paris"` (CLAUDE.md gotcha 4)
2. `scripts/deploy-agent-vault-factory.js`, dry run against ganache first
3. Deploy to Stable with the real NPM `0x3BdC3437…` and router02
   `0x32eaf9B5…` from CLAUDE.md, read back both from the deployed factory and
   diff against those constants before announcing anything
4. Create one vault from the Safe as a live smoke test, deposit a small amount,
   run one rebalance, withdraw it all, and confirm the balance returns
5. Record the address in `deployments/` and in `docs/STATE.md`
6. Frontend: the mintd.money agent-management tab reads `vaultsOf(user)`.
   No `stats-indexer.js` change; vault TVL is user capital, not protocol TVL,
   and counting it in the headline would inflate a number CLAUDE.md is explicit
   about keeping honest.

## Rollback

There is none in the contract. The factory is immutable with no owner, so a bug
cannot be patched, paused or migrated. Recovery means deploying a new factory and
repointing the frontend; vaults from the old one keep working and stay fully
withdrawable by their owners, because each vault's `withdrawAll` needs neither
the factory nor the agent. That property is the actual rollback plan and the
tests must prove it holds. Treating `/security-review` as mandatory is not
process for its own sake here: it is the only gate that exists.

## Decisions taken at approval (2026-07-29)

1. **Risk 3, non-standard tokens: ship as is and document.** The known target
   pools are USDT0-quoted and USDT0 returns a bool, so the vault's
   `require(token.transfer(...))` is correct for them. A token returning no
   value at all would make `withdrawAll` revert, stranding anything sent
   directly to the vault address. Not fixed, because the alternative reopens
   `AgentVault` for re-review and this plan deliberately does not touch it.
2. **The frontend prefills the keeper as `agent`, and must show it before
   signing.** The factory itself takes `agent` as a required argument with no
   default, so this is a UI obligation, not a contract one. A user blindly
   accepting a prefilled agent is the closest thing to a trust assumption left
   in the design, which is why it has to be visible rather than implicit.
3. **No creation fee in v1.** Confirmed out of scope.

## Still to do before this is a product

- Deploy, following "Deploy steps" above. Nothing is on chain yet.
- The mintd.money agent-management tab, reading `vaultsOf(user)`.
- Decide whether the keeper (`scripts/agent-keeper.js`) discovers vaults from
  `VaultCreated` events, which is the natural indexing path now that one exists.
