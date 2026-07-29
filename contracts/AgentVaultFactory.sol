// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./AgentVault.sol";

/// ----------------------------------------------------------------------------
/// AgentVaultFactory — one transaction gives a user their own AgentVault, wired
/// to the real Uniswap contracts and running exactly the reviewed bytecode.
///
/// WHAT THIS IS FOR
/// The vault's security argument is about what a compromised keeper can take.
/// That argument only holds for a vault whose `npm` and `router` are the real
/// ones. A vault pointed at an attacker's router is drained on its first
/// rebalance no matter how correct the rest of it is, because `_swap` approves
/// the router and hands it the balance. So the dangerous parameters are not
/// arguments here at all: they are immutable on the factory, and the create
/// call has no way to influence them.
///
/// That is what makes `isVault(x)` worth reading. It says address x was built
/// from this factory's copy of AgentVault, against the canonical pool for its
/// token pair, with the real position manager and router. A lookalike vault
/// deployed by hand reads false, which is the point.
///
/// NO OWNER, NO ADMIN, NO SETTERS
/// Deliberate, and the same choice `TokenMetaRegistry` makes. If this contract
/// had an owner who could repoint `router`, compromising that owner would
/// silently poison every vault created afterwards while leaving every existing
/// vault provably fine. That asymmetry is what makes the vector easy to miss in
/// a review: nothing in any deployed vault's storage would look wrong. There is
/// no setter, so there is no vector. The cost is nil, because `agent` is a
/// per-vault parameter its owner can change or revoke at any time.
///
/// The consequence is that a bug here cannot be patched, paused or migrated.
/// Recovery means deploying a new factory and repointing the frontend. Vaults
/// from the old factory keep working and stay fully withdrawable, because
/// `AgentVault.withdrawAll` needs neither this contract nor the agent.
///
/// WHY `new`, AND NOT A MINIMAL PROXY
/// EIP-1167 clones would shrink this contract to a few hundred bytes and would
/// also destroy the vault. `immutable` values live in the implementation's
/// code, so every clone would share one implementation's `owner`, `pool` and
/// `router`. Supporting clones means moving `owner` out of `immutable` and into
/// storage, which turns "not settable, at any price" into "settable if a
/// storage bug exists". Embedding the vault's creation code costs about 16 KB
/// against the 24,576 byte limit, which leaves enough headroom that the trade
/// is not worth considering. `test-agent-vault-factory.js` asserts the deployed
/// size so this is caught in ganache and never on a reverting mainnet deploy.
/// ----------------------------------------------------------------------------
contract AgentVaultFactory {
    /// @notice The two addresses a caller must never choose. Set once, here.
    address public immutable npm;
    address public immutable router;

    mapping(address => bool) public isVault;
    address[] private _allVaults;
    mapping(address => address[]) private _ownerVaults;

    event VaultCreated(
        address indexed owner,
        address indexed vault,
        address indexed pool,
        address agent,
        address numeraire
    );

    constructor(address _npm, address _router) {
        require(_npm != address(0) && _router != address(0), "zero");
        // An EOA passed here would deploy a factory that produces vaults which
        // fail only later, at the first rebalance, with real money already in
        // them. Both must at least be contracts.
        require(_npm.code.length > 0 && _router.code.length > 0, "not contract");
        // Reverts unless the position manager exposes a factory, which is what
        // every vault's canonical-pool check is resolved against. A wrong
        // address that happens to be a contract is caught here rather than
        // becoming an unexplained revert inside each createVault.
        require(INonfungiblePositionManager(_npm).factory() != address(0), "npm factory");
        npm = _npm;
        router = _router;
    }

    /// @notice Deploy a vault owned by the caller.
    ///
    /// `owner` is `msg.sender` rather than a parameter. With an arbitrary owner,
    /// anyone could populate a stranger's vault list with vaults whose agent
    /// they picked; the victim opens the app, sees a vault under their own
    /// address, and deposits into it. Costs nothing to close, so it is closed.
    ///
    /// `pool` is unvalidated here on purpose. `AgentVault`'s constructor
    /// resolves it against `npm.factory().getPool(token0, token1, fee)` and
    /// reverts unless it is the canonical pool for that pair and fee. That check
    /// is the one standing between this factory and a contract that mimics a
    /// real pool while serving a forged `observe()`, from which the vault
    /// derives every minimum output it enforces. Duplicating it here would only
    /// give a future editor two places to get it wrong.
    ///
    /// No reentrancy guard, and that is a conclusion rather than an oversight.
    /// A hostile `pool` argument does receive control during construction, via
    /// `token0()`, `token1()`, `fee()` and `tickSpacing()`, which all run before
    /// the canonical check. It cannot do anything with it. `AgentVault` declares
    /// those four `view`, so solc emits STATICCALL and any reentrant call that
    /// writes storage, `createVault` included, reverts on its first SSTORE. The
    /// only non-view call into the pool, `increaseObservationCardinalityNext`,
    /// runs after the canonical check has already established that the pool is
    /// the real one. Even setting that aside, a reentrant creation would be
    /// undone: the outer constructor reaches the canonical check, fails it, and
    /// reverts the whole transaction including any registry append. No funds
    /// live here and no invariant spans two calls, so a guard would add a
    /// storage write per creation while closing nothing.
    /// `test-agent-vault-factory.js` proves the STATICCALL claim against a mock
    /// pool that tries exactly this, rather than leaving it as an inference from
    /// the interface.
    function createVault(address pool, address agent, address numeraire)
        external
        returns (address vault)
    {
        vault = address(new AgentVault(msg.sender, pool, npm, router, agent, numeraire));
        isVault[vault] = true;
        _allVaults.push(vault);
        _ownerVaults[msg.sender].push(vault);
        emit VaultCreated(msg.sender, vault, pool, agent, numeraire);
    }

    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    function vaultCountOf(address owner) external view returns (uint256) {
        return _ownerVaults[owner].length;
    }

    /// @notice Every vault for an owner, in creation order.
    /// @dev Unbounded. Safe from `eth_call`, never safe to call from another
    /// contract: anyone can append to their own list indefinitely and make this
    /// exceed any gas limit. On-chain callers must page through `vaultsOfSlice`.
    function vaultsOf(address owner) external view returns (address[] memory) {
        return _ownerVaults[owner];
    }

    /// @notice Page through an owner's vaults. Returns fewer than `count` at the
    /// end of the list, and an empty array past it, rather than reverting: a
    /// caller walking to the end should not have to know the length first.
    function vaultsOfSlice(address owner, uint256 start, uint256 count)
        external
        view
        returns (address[] memory page)
    {
        return _slice(_ownerVaults[owner], start, count);
    }

    /// @notice Page through every vault ever created.
    /// @dev Creation is permissionless, so this list is spammable by design.
    /// A frontend rendering a user's page must index by owner and must never
    /// scan this for a match.
    function allVaultsSlice(uint256 start, uint256 count)
        external
        view
        returns (address[] memory page)
    {
        return _slice(_allVaults, start, count);
    }

    function _slice(address[] storage list, uint256 start, uint256 count)
        internal
        view
        returns (address[] memory page)
    {
        uint256 len = list.length;
        if (start >= len) return new address[](0);
        uint256 end = start + count;
        if (end > len) end = len;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) page[i - start] = list[i];
    }
}
