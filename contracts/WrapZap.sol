// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// WrapZap: one-transaction, ZERO-slippage entry into the USDT0/WgUSDT LP.
/// Because WgUSDT is a 1:1 wrapper of native USDT0, no swap (and therefore no
/// price impact) is ever needed. The user sends native USDT0; the contract
/// wraps the portion that matches the pool ratio and adds both sides as
/// liquidity on MintSwap. LP goes to the user, dust is refunded, the contract
/// holds nothing between transactions.
///
/// USDT0 on Stable is both native (18 dec) and ERC-20 (6 dec) on one balance,
/// so `msg.value` (18 dec) and the router's ERC-20 pull (6 dec) act on the
/// same funds. NATIVE_TO_ERC20 = 1e12 bridges the two views.
/// ----------------------------------------------------------------------------

interface IWETH9W {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20W {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IV2RouterW {
    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256, uint256);
}

contract WrapZap {
    uint256 public constant NATIVE_TO_ERC20 = 1e12;

    IV2RouterW public immutable router; // MintSwap router
    IERC20W public immutable usdt0;     // USDT0 ERC-20 (6 dec)
    IWETH9W public immutable wgusdt;    // Wrapped gUSDT (18 dec, 1:1 wrapper)

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }

    event Zapped(address indexed user, uint256 usdtIn, uint256 liquidity);

    constructor(address _router, address _usdt0, address _wgusdt) {
        require(_router != address(0) && _usdt0 != address(0) && _wgusdt != address(0), "zero addr");
        router = IV2RouterW(_router);
        usdt0 = IERC20W(_usdt0);
        wgusdt = IWETH9W(_wgusdt);
    }

    /// @param usdtForLp   ERC-20 USDT0 amount (6 dec) to keep as the USDT0 side
    /// @param minLiquidity min LP out (safety; wrapping never slips so this is
    ///                     just a sanity floor)
    /// Send native USDT0 = (usdtForLp + wrapAmount) * 1e12. Everything past
    /// usdtForLp is wrapped 1:1 into WgUSDT and paired.
    function zapIn(uint256 usdtForLp, uint256 minLiquidity) external payable lock returns (uint256 liquidity) {
        uint256 totalErc = msg.value / NATIVE_TO_ERC20;
        require(usdtForLp > 0 && usdtForLp < totalErc, "bad split");
        uint256 wrapErc = totalErc - usdtForLp;

        // wrap the WgUSDT side (1:1, no slippage possible)
        wgusdt.deposit{value: wrapErc * NATIVE_TO_ERC20}();
        uint256 wgBal = wgusdt.balanceOf(address(this));

        usdt0.approve(address(router), usdtForLp);
        wgusdt.approve(address(router), wgBal);
        (,, liquidity) = router.addLiquidity(
            address(usdt0), address(wgusdt), usdtForLp, wgBal, 0, 0, msg.sender, block.timestamp
        );
        require(liquidity >= minLiquidity, "insufficient LP");

        // refund dust
        uint256 du = usdt0.balanceOf(address(this));
        if (du > 0) usdt0.transfer(msg.sender, du);
        uint256 dw = wgusdt.balanceOf(address(this));
        if (dw > 0) wgusdt.transfer(msg.sender, dw);

        emit Zapped(msg.sender, totalErc, liquidity);
    }

    receive() external payable {}
}
