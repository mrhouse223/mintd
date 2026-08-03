// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BuybackVault} from "./BuybackVault.sol";

/// @title BuybackVaultFactory
/// @notice Deploys a BuybackVault owned by its caller.
///
/// The factory is the trust anchor and nothing else. `isVault(x)` returning true
/// is what lets the site, and a user, say that address `x` runs the reviewed
/// bytecode against the canonical router rather than being a lookalike with a
/// hostile router in it. It holds no funds, takes no fee, and has no owner: a
/// factory with an admin would be a way to change what future vaults are, which
/// is the thing this design is spending its budget to avoid.
contract BuybackVaultFactory {
    address public immutable quote;    // USDT0
    address public immutable router;
    address public immutable v3factory;

    address[] public vaults;
    mapping(address => bool) public isVault;
    mapping(address => address[]) private _byOwner;

    event VaultCreated(address indexed vault, address indexed owner, address indexed token, address pool);

    constructor(address _quote, address _router, address _v3factory) {
        require(_quote != address(0) && _router != address(0) && _v3factory != address(0), "zero");
        quote = _quote; router = _router; v3factory = _v3factory;
    }

    /// @notice Deploy a vault owned by the caller. The pool is checked inside
    ///         the vault against the canonical factory, so a bad address is
    ///         rejected at construction rather than becoming a live vault.
    function create(address token, address pool) external returns (address vault) {
        vault = address(new BuybackVault(msg.sender, quote, token, pool, router, v3factory));
        vaults.push(vault);
        isVault[vault] = true;
        _byOwner[msg.sender].push(vault);
        emit VaultCreated(vault, msg.sender, token, pool);
    }

    function vaultCount() external view returns (uint256) { return vaults.length; }
    function byOwner(address a) external view returns (address[] memory) { return _byOwner[a]; }
}
