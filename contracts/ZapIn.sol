// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// MintSwap ZapIn: enter a MintSwap V2 LP position with USDT0 only.
/// Swaps the optimal portion of the deposit for the pair's other token inside
/// the same pool, adds both sides as liquidity, sends the LP tokens to the
/// user, and refunds any dust. No owner, no funds held between transactions.
/// ----------------------------------------------------------------------------

interface IERC20Z {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IUniswapV2PairZ {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IUniswapV2Router02Z {
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external
        returns (uint256[] memory);
    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256, uint256);
}

contract ZapIn {
    IUniswapV2Router02Z public immutable router;
    IERC20Z public immutable usdt0;

    uint256 private unlocked = 1;

    event Zapped(address indexed user, address indexed pair, uint256 usdtIn, uint256 liquidity);

    modifier lock() {
        require(unlocked == 1, "reentrancy");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(address _router, address _usdt0) {
        require(_router != address(0) && _usdt0 != address(0), "zero addr");
        router = IUniswapV2Router02Z(_router);
        usdt0 = IERC20Z(_usdt0);
    }

    /// @notice Zap `amountIn` USDT0 into the given MintSwap pair (which must
    /// contain USDT0). `minOtherOut` bounds the internal swap (slippage).
    /// LP tokens and any dust go to the caller.
    function zapIn(address pair, uint256 amountIn, uint256 minOtherOut)
        external
        lock
        returns (uint256 liquidity)
    {
        require(amountIn > 0, "zero amount");
        address t0 = IUniswapV2PairZ(pair).token0();
        address t1 = IUniswapV2PairZ(pair).token1();
        require(t0 == address(usdt0) || t1 == address(usdt0), "pair lacks USDT0");
        address other = t0 == address(usdt0) ? t1 : t0;

        (uint112 r0, uint112 r1,) = IUniswapV2PairZ(pair).getReserves();
        uint256 rUsdt = t0 == address(usdt0) ? r0 : r1;
        require(rUsdt > 0, "empty pool");

        require(usdt0.transferFrom(msg.sender, address(this), amountIn), "transferFrom");

        // optimal one-sided amount to swap (0.3% fee constant-product):
        // s = (sqrt(r*(r*3988009 + a*3988000)) - r*1997) / 1994
        uint256 s = (_sqrt(rUsdt * (rUsdt * 3988009 + amountIn * 3988000)) - rUsdt * 1997) / 1994;
        require(s > 0 && s < amountIn, "amount too small");

        usdt0.approve(address(router), amountIn);
        address[] memory path = new address[](2);
        path[0] = address(usdt0);
        path[1] = other;
        uint256[] memory outs = router.swapExactTokensForTokens(s, minOtherOut, path, address(this), block.timestamp);
        uint256 gotOther = outs[outs.length - 1];

        IERC20Z(other).approve(address(router), gotOther);
        (,, liquidity) = router.addLiquidity(
            address(usdt0), other, amountIn - s, gotOther, 0, 0, msg.sender, block.timestamp
        );

        // refund dust (rounding leftovers) so the contract never holds funds
        uint256 dustU = usdt0.balanceOf(address(this));
        if (dustU > 0) usdt0.transfer(msg.sender, dustU);
        uint256 dustO = IERC20Z(other).balanceOf(address(this));
        if (dustO > 0) IERC20Z(other).transfer(msg.sender, dustO);

        emit Zapped(msg.sender, pair, amountIn, liquidity);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
