// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// BuybackBurner: collects USDT0 platform fees and converts them into $MINTD
/// buy-and-burn. Point any fee source (MINTR's platform fee, the launchpad fee
/// recipient, MintSwap protocol fees) at this contract; the accumulated USDT0
/// is market-bought into MINTD through canonical Uniswap and sent straight to
/// the dead address.
///
/// Fully trustless: no owner, no admin, no withdraw. The ONLY thing this
/// contract can do with its USDT0 is swap it for MINTD and burn it. Anyone can
/// trigger a burn (permissionless), protected by a caller-supplied minimum-out.
/// ----------------------------------------------------------------------------

interface IERC20B {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IV3RouterB {
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

contract BuybackBurner {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20B public immutable usdt0;
    IV3RouterB public immutable router; // canonical Uniswap SwapRouter02
    address public immutable mintd;
    uint24 public immutable feeTier;

    uint256 public totalUsdtSpent;
    uint256 public totalMintdBurned;

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }

    event BuybackBurned(address indexed caller, uint256 usdtIn, uint256 mintdBurned);

    constructor(address _usdt0, address _router, address _mintd, uint24 _feeTier) {
        require(_usdt0 != address(0) && _router != address(0) && _mintd != address(0), "zero addr");
        usdt0 = IERC20B(_usdt0);
        router = IV3RouterB(_router);
        mintd = _mintd;
        feeTier = _feeTier;
    }

    /// @notice USDT0 waiting to be burned into MINTD.
    function pending() external view returns (uint256) {
        return usdt0.balanceOf(address(this));
    }

    /// @notice Buy MINTD with collected USDT0 and send it to the dead address.
    /// @param usdtAmount amount to spend (0 = spend the full balance)
    /// @param minMintdOut slippage floor (compute from a fresh quote)
    function buybackBurn(uint256 usdtAmount, uint256 minMintdOut) external lock returns (uint256 burned) {
        uint256 bal = usdt0.balanceOf(address(this));
        uint256 amt = (usdtAmount == 0 || usdtAmount > bal) ? bal : usdtAmount;
        require(amt > 0, "nothing to burn");
        usdt0.approve(address(router), amt);
        burned = router.exactInputSingle(
            IV3RouterB.ExactInputSingleParams({
                tokenIn: address(usdt0),
                tokenOut: mintd,
                fee: feeTier,
                recipient: DEAD, // MINTD goes straight to the burn address
                amountIn: amt,
                amountOutMinimum: minMintdOut,
                sqrtPriceLimitX96: 0
            })
        );
        totalUsdtSpent += amt;
        totalMintdBurned += burned;
        emit BuybackBurned(msg.sender, amt, burned);
    }

    receive() external payable {}
}
