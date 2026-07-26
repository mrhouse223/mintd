// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice Test-only mock of Uniswap V2 Router02's addLiquidityETH.
contract MockRouter {
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public lastEthAmount;
    address public lastTo;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function WETH() external pure returns (address) {
        return address(0xEEEE);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external payable returns (uint256, uint256, uint256) {
        require(!shouldRevert, "MockRouter: forced revert");
        IERC20Min(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        lastToken = token;
        lastTokenAmount = amountTokenDesired;
        lastEthAmount = msg.value;
        lastTo = to;
        return (amountTokenDesired, msg.value, 1e18);
    }
}
