// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// FeeSplitter — routes the protocol's share of launchpad fees 80/20 between a
/// buyback destination and operations.
///
/// WHY THIS EXISTS
/// The launchpad deployed on Stable is immutable and pays its entire protocol
/// share to a single `feeRecipient`. It has no concept of a buyback split. The
/// only way to get an onchain 80/20 without redeploying the launchpad is to
/// make `feeRecipient` a contract that performs the split itself, which is this.
///
/// Point the launchpad here with `setFeeRecipient(address(this))`.
///
/// TRUST MODEL
/// No owner, no admin, no withdraw, no pause. Both destinations and the split
/// are immutable, set once at construction. The only thing anyone can do is
/// call `distribute`, which moves the full balance to those two fixed addresses
/// in the fixed ratio. Nobody, including whoever deployed it, can redirect a
/// unit of it.
///
/// Repointing later means deploying a new splitter and calling
/// `setFeeRecipient` again on the launchpad. That is deliberate: it keeps this
/// contract free of an admin key, and the launchpad already has an owner who
/// can perform the repoint.
///
/// PUSH, NOT PULL
/// `claimFees` transfers tokens here; nothing calls back. So a permissionless
/// `distribute(token)` has to be triggered, by anyone, to forward the balance.
/// Funds sitting here undistributed are not lost, only idle.
/// ----------------------------------------------------------------------------

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

contract FeeSplitter {
    /// @notice Destination for the buyback share. Until the token it is meant
    /// to buy exists, point this at a treasury and let it accumulate; the
    /// splitter neither knows nor cares what lives at the address.
    address public immutable buyback;
    address public immutable ops;
    /// @notice Buyback share in basis points of everything received. 8000 = 80%.
    uint256 public immutable buybackBps;

    event Distributed(address indexed token, uint256 toBuyback, uint256 toOps);
    event DistributedNative(uint256 toBuyback, uint256 toOps);

    constructor(address _buyback, address _ops, uint256 _buybackBps) {
        require(_buyback != address(0) && _ops != address(0), "zero addr");
        require(_buybackBps <= 10_000, "bad bps");
        buyback = _buyback;
        ops = _ops;
        buybackBps = _buybackBps;
    }

    /// @notice Forward this contract's full balance of `token`, 80/20.
    function distribute(address token) public returns (uint256 toBuyback, uint256 toOps) {
        uint256 bal = IERC20S(token).balanceOf(address(this));
        if (bal == 0) return (0, 0);
        toBuyback = (bal * buybackBps) / 10_000;
        // By subtraction, never a second division: the two payouts then sum to
        // exactly the balance and no dust can accumulate across claims.
        toOps = bal - toBuyback;
        if (toBuyback > 0) require(IERC20S(token).transfer(buyback, toBuyback), "buyback xfer");
        if (toOps > 0) require(IERC20S(token).transfer(ops, toOps), "ops xfer");
        emit Distributed(token, toBuyback, toOps);
    }

    /// @notice `distribute` over several tokens. A token that reverts is
    /// skipped rather than stranding the rest of the batch.
    function distributeMany(address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            try this.distribute(tokens[i]) {} catch {}
        }
    }

    /// @notice Same split for the native balance. On Stable the gas token and
    /// the ERC-20 are one balance, so a native transfer can land here too.
    function distributeNative() external returns (uint256 toBuyback, uint256 toOps) {
        uint256 bal = address(this).balance;
        if (bal == 0) return (0, 0);
        toBuyback = (bal * buybackBps) / 10_000;
        toOps = bal - toBuyback;
        if (toBuyback > 0) _send(buyback, toBuyback);
        if (toOps > 0) _send(ops, toOps);
        emit DistributedNative(toBuyback, toOps);
    }

    function pending(address token) external view returns (uint256) {
        return IERC20S(token).balanceOf(address(this));
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    receive() external payable {}
}
