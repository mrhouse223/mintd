// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MintrArb
/// @notice Keeps MINTR's market price aligned with its contract (backing) price
///         by arbitraging between them atomically. Permissionless: anyone can
///         trigger it and earn a bounty; the rest of the profit is sent to the
///         BuybackBurner, which can only market-buy MINTD and burn it.
///
///         Both directions are supported:
///           PREMIUM  market > contract: mint MINTR from the contract, sell into
///                    the pool. The mint tax raises MINTR's backing.
///           DISCOUNT market < contract: buy MINTR cheap from the pool, redeem it
///                    at the contract. The redeem tax also raises backing.
///
///         Every call is atomic and reverts unless it clears `minProfit`, so the
///         contract can never be left holding a half-finished position.
///
///         The float is USDT0 held by this contract. There is no admin path to
///         the float other than `sweep`, which is owner-only and exists so the
///         float can be recovered or resized; profits always route to the burner.

interface IERC20A {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IMintrA {
    function price1e18() external view returns (uint256);
    function quoteBuy(uint256 usdtIn) external view returns (uint256);
    function quoteSell(uint256 mintrIn) external view returns (uint256);
    function buy(uint256 usdtIn, uint256 minOut) external returns (uint256);
    function sell(uint256 mintrIn, uint256 minUsdt) external returns (uint256);
}

interface IV2PairA {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}

interface IV2RouterA {
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external returns (uint256[] memory);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory);
}

contract MintrArb {
    IERC20A public immutable usdt0;   // 6-dec ERC-20
    IERC20A public immutable mintr;   // 18-dec
    IMintrA public immutable mintrC;  // the MINTR reserve contract
    IV2RouterA public immutable router;
    IV2PairA public immutable pair;
    address public immutable burner;  // BuybackBurner: profits go here

    address public owner;
    uint256 public callerBps = 1000;  // 10% of profit to whoever triggers it
    uint256 public minProfit = 10_000; // 0.01 USDT0, in 6-dec units
    bool public paused;

    uint256 public totalProfit;
    uint256 public totalRuns;

    uint256 private constant BPS = 10000;
    bool private _entered;

    event Arbed(address indexed caller, bool premium, uint256 spent, uint256 profit, uint256 bounty);
    event ParamsSet(uint256 callerBps, uint256 minProfit, bool paused);

    modifier lock() { require(!_entered, "reentrancy"); _entered = true; _; _entered = false; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _usdt0, address _mintr, address _router, address _pair, address _burner) {
        require(_usdt0 != address(0) && _mintr != address(0) && _router != address(0)
            && _pair != address(0) && _burner != address(0), "zero addr");
        usdt0 = IERC20A(_usdt0);
        mintr = IERC20A(_mintr);
        mintrC = IMintrA(_mintr);
        router = IV2RouterA(_router);
        pair = IV2PairA(_pair);
        burner = _burner;
        owner = msg.sender;
    }

    // ------------------------------------------------------------- views
    /// @notice Pool reserves oriented as (USDT0, MINTR).
    function reserves() public view returns (uint256 rUsdt, uint256 rMintr) {
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        bool usdtIs0 = pair.token0() == address(usdt0);
        rUsdt = usdtIs0 ? r0 : r1;
        rMintr = usdtIs0 ? r1 : r0;
    }

    /// @notice Market price (USDT0 per MINTR, 1e18) implied by the pool, and the
    ///         contract's backing price. Market is scaled up from 6-dec USDT0.
    function prices() public view returns (uint256 market1e18, uint256 contract1e18) {
        (uint256 rU, uint256 rM) = reserves();
        market1e18 = rM == 0 ? 0 : (rU * 1e12 * 1e18) / rM;
        contract1e18 = mintrC.price1e18();
    }

    /// @dev Simulate a run without sending a transaction. Returns 0 profit when
    ///      the trade is not worth doing, so a keeper can poll this cheaply.
    function quote(uint256 usdtIn) public view returns (bool premium, uint256 profit) {
        if (usdtIn == 0) return (false, 0);
        (uint256 m, uint256 c) = prices();
        if (m == 0 || c == 0) return (false, 0);

        if (m > c) {
            // mint at the contract, sell into the pool
            uint256 got = mintrC.quoteBuy(usdtIn);
            if (got == 0) return (true, 0);
            uint256 out = _amountOut(got, false);
            return (true, out > usdtIn ? out - usdtIn : 0);
        } else {
            // buy from the pool, redeem at the contract
            uint256 got = _amountOut(usdtIn, true);
            if (got == 0) return (false, 0);
            uint256 out = mintrC.quoteSell(got);
            return (false, out > usdtIn ? out - usdtIn : 0);
        }
    }

    /// @dev Constant-product output with the 0.3% pool fee.
    ///      buyingMintr=true  -> USDT0 in, MINTR out
    ///      buyingMintr=false -> MINTR in, USDT0 out
    function _amountOut(uint256 amountIn, bool buyingMintr) internal view returns (uint256) {
        (uint256 rU, uint256 rM) = reserves();
        (uint256 rIn, uint256 rOut) = buyingMintr ? (rU, rM) : (rM, rU);
        if (rIn == 0 || rOut == 0 || amountIn == 0) return 0;
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    /// @notice Largest input this contract could currently deploy.
    function available() external view returns (uint256) {
        return usdt0.balanceOf(address(this));
    }

    // -------------------------------------------------------------- arb
    /// @notice Run the arb with `usdtIn` of the contract's float.
    /// @dev Reverts unless the round trip nets at least `minProfit`. The caller
    ///      keeps `callerBps` of the profit; the rest goes to the BuybackBurner.
    function arb(uint256 usdtIn) external lock returns (uint256 profit) {
        require(!paused, "paused");
        uint256 float_ = usdt0.balanceOf(address(this));
        require(usdtIn > 0 && usdtIn <= float_, "bad amount");

        (uint256 m, uint256 c) = prices();
        require(m > 0 && c > 0, "no price");

        address[] memory path = new address[](2);
        uint256 before = float_;

        if (m > c) {
            // PREMIUM: contract -> pool
            usdt0.approve(address(mintrC), usdtIn);
            uint256 got = mintrC.buy(usdtIn, 0);
            require(got > 0, "mint failed");
            path[0] = address(mintr);
            path[1] = address(usdt0);
            mintr.approve(address(router), got);
            router.swapExactTokensForTokens(got, 0, path, address(this), block.timestamp);
        } else {
            // DISCOUNT: pool -> contract
            path[0] = address(usdt0);
            path[1] = address(mintr);
            usdt0.approve(address(router), usdtIn);
            uint256[] memory outs = router.swapExactTokensForTokens(usdtIn, 0, path, address(this), block.timestamp);
            uint256 got = outs[outs.length - 1];
            require(got > 0, "swap failed");
            mintr.approve(address(mintrC), got);
            mintrC.sell(got, 0);
        }

        uint256 after_ = usdt0.balanceOf(address(this));
        require(after_ > before, "unprofitable");
        profit = after_ - before;
        require(profit >= minProfit, "below min profit");

        uint256 bounty = (profit * callerBps) / BPS;
        if (bounty > 0) require(usdt0.transfer(msg.sender, bounty), "bounty failed");
        uint256 toBurner = profit - bounty;
        if (toBurner > 0) require(usdt0.transfer(burner, toBurner), "burner failed");

        totalProfit += profit;
        totalRuns += 1;
        emit Arbed(msg.sender, m > c, usdtIn, profit, bounty);
    }

    /// @notice Convenience: run the largest sensible size, capped by the float.
    ///         A keeper can just call this.
    function arbMax(uint256 cap) external returns (uint256) {
        uint256 float_ = usdt0.balanceOf(address(this));
        uint256 size = cap == 0 || cap > float_ ? float_ : cap;
        return this.arb(size);
    }

    // ------------------------------------------------------------ admin
    /// @notice Anyone can top the float up; it can only ever be arbed or swept.
    function fund(uint256 amount) external {
        require(usdt0.transferFrom(msg.sender, address(this), amount), "transfer failed");
    }

    function setParams(uint256 _callerBps, uint256 _minProfit, bool _paused) external onlyOwner {
        require(_callerBps <= 5000, "bounty too high");
        callerBps = _callerBps;
        minProfit = _minProfit;
        paused = _paused;
        emit ParamsSet(_callerBps, _minProfit, _paused);
    }

    /// @dev Recover or resize the float. Only touches idle balance, never a
    ///      user's funds: this contract never custodies anything for anyone.
    function sweep(address token, uint256 amount) external onlyOwner {
        IERC20A(token).transfer(owner, amount);
    }

    function transferOwnership(address n) external onlyOwner {
        require(n != address(0), "zero");
        owner = n;
    }
}
