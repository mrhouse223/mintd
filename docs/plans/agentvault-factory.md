# AgentVault factory

Status: draft
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

- [ ] existing suite still green: `node scripts/test-agent-vault.js` (48 tests)
- [ ] `scripts/test-agent-vault-factory.js`, new, on real ganache with real
      Uniswap V3, not mocks-only:
  - [ ] creates a working vault; owner is the caller, not the factory
  - [ ] the created vault's `npm` and `router` equal the factory's, and no
        argument can change them
  - [ ] forged-pool contract mimicking a real pool is rejected (risk 2)
  - [ ] non-canonical but real pool (wrong fee tier for the pair) is rejected
  - [ ] numeraire outside the pool is rejected
  - [ ] `isVault` true only for factory output; a hand-deployed identical vault
        reads false
  - [ ] registry: multiple vaults per owner, correct per-owner indexing,
        pagination bounds including empty and out-of-range
  - [ ] end to end through the factory-made vault: deposit, propose, execute,
        withdrawAll returns principal to the owner
  - [ ] the hostile-keeper suite re-run against a factory-created vault, since
        the point is that factory provenance changes nothing about vault safety
  - [ ] deployed factory bytecode is under 24,576 bytes
- [ ] `/security-review` on `AgentVaultFactory.sol` with findings fixed

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

## Open questions for approval

1. **Risk 3, non-standard tokens.** Options: (a) ship as is and document, (b) add
   a factory-side probe rejecting tokens that do not return a bool, (c) switch
   the vault to a safe-transfer helper, which reopens the vault for re-review.
   Recommendation: (a) for v1. The known target pools are USDT0-quoted and fine,
   and (c) buys robustness at the cost of re-reviewing the contract this plan
   deliberately does not touch.
2. **Default agent in the UI.** The factory takes `agent` as an argument with no
   default. Confirm the frontend fills in the current keeper address and that
   the user can see and change it before signing, since a user blindly accepting
   a prefilled agent is the closest thing left to a trust assumption.
3. **Creation fee.** Confirmed out of scope for v1?
