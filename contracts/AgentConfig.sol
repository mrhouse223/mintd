// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AgentConfig
/// @notice Per-vault overrides for the keeper's DECISION parameters: the ones
///         that live off chain in the keeper (the buy/sell band, the sell
///         multiple, the LP range width, the rebalance edge) rather than in the
///         vault's own on-chain guards.
///
/// WHY A SEPARATE CONTRACT
/// The vaults are immutable and hold funds, so adding fields to them means a
/// redeploy that orphans every existing vault. This holds no funds and never
/// touches one: it is a pure key-value overlay the keeper reads and the owner
/// writes. Same shape as TokenMetaRegistry, and for the same reason.
///
/// WHY OWNERLESS, AND GATED ON THE VAULT
/// There is no admin. A config can only be written by the address the vault
/// itself calls `owner`, checked live, so nobody can set parameters for a vault
/// they do not own, and there is no privileged key that can override everyone.
///
/// WHAT IT CANNOT DO
/// It cannot move funds, cannot change a vault's on-chain guards, and cannot make
/// a keeper act: the keeper reads it as a hint and still simulates every action
/// against the vault, whose own bounds are the real safety. A hostile config is
/// at worst a vault that trades on a silly schedule, which is the owner's own
/// vault and the owner's own problem.
interface IOwned {
    function owner() external view returns (address);
}

contract AgentConfig {
    struct Config {
        // Buyback: the r band, in the keeper's ppm-ish units. 300 is ~0.03%.
        uint16 band;
        // Buyback: sell trigger as a multiple of the band. 3 means sell at 3x.
        uint8 sellMult;
        // LP: half-width of the range, in tick spacings either side of centre.
        uint8 lpWidth;
        // LP: how far to an edge, in percent, before a rebalance. 75 means act
        // once price has eaten three quarters of the way out.
        uint8 lpEdgePct;
        // Distinguishes "owner set this" from a zero struct the keeper must
        // ignore in favour of its own defaults.
        bool set;
    }

    // Bounds. Wide enough to be useful, tight enough that no value is a foot-gun
    // the keeper would act on. Enforced here so the keeper can trust what it
    // reads without re-validating.
    uint16 public constant MIN_BAND = 1;
    uint16 public constant MAX_BAND = 50000;   // ~5% move to trigger, the loosest
    uint8  public constant MIN_SELL_MULT = 1;
    uint8  public constant MAX_SELL_MULT = 20;
    uint8  public constant MIN_LP_WIDTH = 1;
    uint8  public constant MAX_LP_WIDTH = 100;
    uint8  public constant MIN_LP_EDGE = 1;
    uint8  public constant MAX_LP_EDGE = 99;

    mapping(address => Config) public configOf;

    event ConfigSet(address indexed vault, address indexed owner,
                    uint16 band, uint8 sellMult, uint8 lpWidth, uint8 lpEdgePct);
    event ConfigCleared(address indexed vault);

    /// @notice Write overrides for `vault`. Only the vault's own owner may call,
    ///         checked against the vault live, so this cannot be set for a vault
    ///         the caller does not control.
    function setConfig(address vault, uint16 band, uint8 sellMult, uint8 lpWidth, uint8 lpEdgePct) external {
        require(IOwned(vault).owner() == msg.sender, "not vault owner");
        require(band >= MIN_BAND && band <= MAX_BAND, "band");
        require(sellMult >= MIN_SELL_MULT && sellMult <= MAX_SELL_MULT, "sellMult");
        require(lpWidth >= MIN_LP_WIDTH && lpWidth <= MAX_LP_WIDTH, "lpWidth");
        require(lpEdgePct >= MIN_LP_EDGE && lpEdgePct <= MAX_LP_EDGE, "lpEdge");
        configOf[vault] = Config(band, sellMult, lpWidth, lpEdgePct, true);
        emit ConfigSet(vault, msg.sender, band, sellMult, lpWidth, lpEdgePct);
    }

    /// @notice Drop overrides, so the keeper falls back to its own defaults.
    function clearConfig(address vault) external {
        require(IOwned(vault).owner() == msg.sender, "not vault owner");
        delete configOf[vault];
        emit ConfigCleared(vault);
    }

    /// @notice The keeper's read. Returns the override and whether one is set.
    function get(address vault) external view returns (Config memory c) {
        return configOf[vault];
    }
}
