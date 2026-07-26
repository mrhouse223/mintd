// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// ZapV3: enter a MintSwap V2 LP position with USDT0 only, routing the swap
/// leg through canonical Uniswap V3 (deep liquidity) so shallow MintSwap pools
/// never cause price-impact losses. For pairs whose other token trades on
/// canonical Uniswap (e.g. MINTD), this is the safe zap.
///
/// Safety: caller passes minSwapOut (protects the V3 swap) and minLiquidity
/// (protects the whole operation). If LP out < minLiquidity, the tx reverts
/// and nothing is lost. No funds held between transactions; dust refunded.
/// ----------------------------------------------------------------------------

interface IERC20V {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IV3RouterZ {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface IV2RouterZ {
    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256, uint256);
}

contract ZapV3 {
    IV2RouterZ public immutable depositRouter; // MintSwap V2 router
    IV3RouterZ public immutable v3Router;      // canonical Uniswap SwapRouter02
    IERC20V public immutable usdt0;

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }

    event Zapped(address indexed user, address indexed other, uint256 usdtIn, uint256 liquidity);

    constructor(address _depositRouter, address _v3Router, address _usdt0) {
        require(_depositRouter != address(0) && _v3Router != address(0) && _usdt0 != address(0), "zero addr");
        depositRouter = IV2RouterZ(_depositRouter);
        v3Router = IV3RouterZ(_v3Router);
        usdt0 = IERC20V(_usdt0);
    }

    /// @param other        non-USDT0 token of the target MintSwap pair
    /// @param amountIn      total USDT0 to zap
    /// @param swapAmount    USDT0 to swap into `other` on canonical V3
    /// @param swapFee       V3 fee tier of the other/USDT0 pool (e.g. 10000)
    /// @param minSwapOut    min `other` out of the V3 swap
    /// @param minLiquidity  min LP out (whole-op protection)
    function zapIn(
        address other,
        uint256 amountIn,
        uint256 swapAmount,
        uint24 swapFee,
        uint256 minSwapOut,
        uint256 minLiquidity
    ) external lock returns (uint256 liquidity) {
        require(amountIn > 0 && swapAmount < amountIn, "bad amounts");
        require(other != address(usdt0) && other != address(0), "bad token");

        require(usdt0.transferFrom(msg.sender, address(this), amountIn), "transferFrom");

        // swap leg through canonical Uniswap V3
        usdt0.approve(address(v3Router), swapAmount);
        uint256 gotOther = v3Router.exactInputSingle(
            IV3RouterZ.ExactInputSingleParams({
                tokenIn: address(usdt0),
                tokenOut: other,
                fee: swapFee,
                recipient: address(this),
                amountIn: swapAmount,
                amountOutMinimum: minSwapOut,
                sqrtPriceLimitX96: 0
            })
        );

        // deposit leg on MintSwap V2
        uint256 usdtLeft = amountIn - swapAmount;
        usdt0.approve(address(depositRouter), usdtLeft);
        IERC20V(other).approve(address(depositRouter), gotOther);
        (,, liquidity) = depositRouter.addLiquidity(
            address(usdt0), other, usdtLeft, gotOther, 0, 0, msg.sender, block.timestamp
        );
        require(liquidity >= minLiquidity, "insufficient LP");

        uint256 du = usdt0.balanceOf(address(this));
        if (du > 0) usdt0.transfer(msg.sender, du);
        uint256 doo = IERC20V(other).balanceOf(address(this));
        if (doo > 0) IERC20V(other).transfer(msg.sender, doo);

        emit Zapped(msg.sender, other, amountIn, liquidity);
    }
}
