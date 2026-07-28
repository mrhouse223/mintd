// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20F {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Furnace
/// @notice Burns any ERC-20 by sending it to the dead address and records that
///         the burn happened here.
///
///         There is no custody. `transferFrom` moves tokens from the caller
///         straight to 0x…dEaD inside a single call, so this contract never
///         holds a balance and there is nothing here to rescue, sweep or steal.
///         There is no owner, no pause and no upgrade path, deliberately.
///
///         Totals are kept in STORAGE rather than left to be reconstructed
///         from events. Stable's RPC prunes logs after roughly four days, so an
///         event-only design would quietly lose its own history: a burn from
///         last week would simply stop existing. Storage costs more gas once
///         and is readable forever.
contract Furnace {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Amount of `token` burned through THIS contract. Deliberately not
    ///         the same as balanceOf(DEAD), which counts burns by anyone.
    mapping(address => uint256) public burnedOf;

    /// @notice How many times `token` has been burned here.
    mapping(address => uint256) public burnCountOf;

    /// @notice Every token ever burned here, in first-seen order.
    address[] public tokens;
    mapping(address => bool) private seen;

    event Burned(
        address indexed token,
        address indexed burner,
        uint256 amount,
        uint256 totalForToken
    );

    /// @notice Burn `amount` of `token`. Caller must approve this contract first.
    /// @return burnedAmount tokens that actually reached the dead address.
    function burn(address token, uint256 amount) external returns (uint256 burnedAmount) {
        require(amount > 0, "zero amount");

        // Measured at the destination, not taken from the argument. A
        // fee-on-transfer token delivers less than `amount`, and recording the
        // requested figure would overstate every total this contract publishes
        // and make burnedOf disagree with the chain.
        uint256 before = IERC20F(token).balanceOf(DEAD);

        // Return value is checked. Some tokens report failure this way instead
        // of reverting, and an unchecked call would record a burn that never
        // happened.
        require(IERC20F(token).transferFrom(msg.sender, DEAD, amount), "transferFrom failed");

        burnedAmount = IERC20F(token).balanceOf(DEAD) - before;
        require(burnedAmount > 0, "nothing burned");

        if (!seen[token]) {
            seen[token] = true;
            tokens.push(token);
        }
        burnedOf[token] += burnedAmount;
        burnCountOf[token] += 1;

        emit Burned(token, msg.sender, burnedAmount, burnedOf[token]);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// @notice Page through the token list. The frontend renders a leaderboard
    ///         and should not need one call per token to build it.
    function page(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory addrs, uint256[] memory amounts, uint256[] memory counts)
    {
        uint256 n = tokens.length;
        if (offset >= n) return (new address[](0), new uint256[](0), new uint256[](0));
        uint256 end = offset + limit;
        if (end > n) end = n;
        uint256 len = end - offset;
        addrs = new address[](len);
        amounts = new uint256[](len);
        counts = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            address t = tokens[offset + i];
            addrs[i] = t;
            amounts[i] = burnedOf[t];
            counts[i] = burnCountOf[t];
        }
    }
}
