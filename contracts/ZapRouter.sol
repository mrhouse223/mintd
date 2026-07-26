// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// MintSwap ZapRouter: enter a MintSwap LP position with USDT0 only, while
/// routing the internal swap through ANY external V2-style pool (the one with
/// the deepest liquidity) so shallow target pools don't cause price-impact
/// losses. The swap leg and the deposit leg can be different DEXes.
///
/// Safety model: the caller (frontend) computes the swap size and passes both
/// a minSwapOut (protects the swap) and a minLiquidity (protects the whole
/// operation). If the resulting LP is below minLiquidity, the tx reverts and
/// nothing is lost. Contract holds no funds between transactions; all dust is
/// refunded to the user.
/// ----------------------------------------------------------------------------

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IV2Router {
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external
        returns (uint256[] memory);
    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256, uint256);
}

contract ZapRouter {
    IV2Router public immutable depositRouter; // MintSwap router (where LP is made)
    IERC20R public immutable usdt0;

    uint256 private unlocked = 1;

    event Zapped(address indexed user, address indexed other, uint256 usdtIn, uint256 liquidity);

    modifier lock() {
        require(unlocked == 1, "reentrancy");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address _depositRouter, address _usdt0) {
        require(_depositRouter != address(0) && _usdt0 != address(0), "zero addr");
        depositRouter = IV2Router(_depositRouter);
        usdt0 = IERC20R(_usdt0);
    }

    /// @param other        the non-USDT0 token of the target MintSwap pair
    /// @param amountIn      total USDT0 the user is zapping
    /// @param swapRouter    external router to route the swap through (deep pool)
    /// @param swapAmount    how much USDT0 to swap into `other`
    /// @param minSwapOut    min `other` out of the swap (slippage on the swap)
    /// @param minLiquidity  min LP tokens out (protects the whole zap)
    function zapIn(
        address other,
        uint256 amountIn,
        address swapRouter,
        uint256 swapAmount,
        uint256 minSwapOut,
        uint256 minLiquidity
    ) external lock returns (uint256 liquidity) {
        require(amountIn > 0 && swapAmount < amountIn, "bad amounts");
        require(other != address(usdt0) && other != address(0), "bad token");

        require(usdt0.transferFrom(msg.sender, address(this), amountIn), "transferFrom");

        // ---- swap leg: route through the chosen external pool ----
        usdt0.approve(swapRouter, swapAmount);
        address[] memory path = new address[](2);
        path[0] = address(usdt0);
        path[1] = other;
        uint256[] memory outs =
            IV2Router(swapRouter).swapExactTokensForTokens(swapAmount, minSwapOut, path, address(this), block.timestamp);
        uint256 gotOther = outs[outs.length - 1];

        // ---- deposit leg: add liquidity to the MintSwap pair ----
        uint256 usdtLeft = amountIn - swapAmount;
        usdt0.approve(address(depositRouter), usdtLeft);
        IERC20R(other).approve(address(depositRouter), gotOther);
        (,, liquidity) = depositRouter.addLiquidity(
            address(usdt0), other, usdtLeft, gotOther, 0, 0, msg.sender, block.timestamp
        );
        require(liquidity >= minLiquidity, "insufficient LP");

        // refund any dust so the contract never retains funds
        uint256 du = usdt0.balanceOf(address(this));
        if (du > 0) usdt0.transfer(msg.sender, du);
        uint256 doo = IERC20R(other).balanceOf(address(this));
        if (doo > 0) IERC20R(other).transfer(msg.sender, doo);

        emit Zapped(msg.sender, other, amountIn, liquidity);
    }
}
