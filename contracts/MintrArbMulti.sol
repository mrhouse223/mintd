// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MintrArbMulti
/// @notice Keeps MINTR's market price honest across every USDT0 pool at once.
///
///         Two kinds of arb:
///           1. CONTRACT: mint at the reserve and sell into whichever pool pays
///              most, or buy from whichever pool is cheapest and redeem at the
///              reserve. This is the one with a guaranteed counterparty.
///           2. CROSS: buy MINTR on the cheapest pool and sell it on the dearest.
///              Pure market making between venues, no reserve involved.
///
///         Every path is atomic and reverts unless it clears `minProfit`, so a
///         losing trade can never be broadcast. The contract never custodies
///         anything for anyone: its float can only ever be arbed or swept.
///
///         Swaps go straight to the pair with a low level swap() rather than
///         through a router. Each pool then needs no router address, no
///         allowance, and no trust beyond the pair itself, which also means a
///         new venue can be added without knowing who its router is.
interface IERC20A {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IMintrC {
    function price1e18() external view returns (uint256);
    function quoteBuy(uint256 usdtIn) external view returns (uint256);
    function quoteSell(uint256 mintrIn) external view returns (uint256);
    function buy(uint256 usdtIn, uint256 minOut) external returns (uint256);
    function sell(uint256 mintrIn, uint256 minOut) external returns (uint256);
}

interface IUniV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract MintrArbMulti {
    IERC20A public immutable usdt0;
    IERC20A public immutable mintr;
    IMintrC public immutable mintrC;

    address public owner;
    address public profitTo;          // where profit lands: burner, treasury, anywhere
    uint256 public callerBps = 0;     // share of profit paid to whoever triggers it
    uint256 public minProfit = 10_000; // 0.01 USDT0, in 6-dec units
    bool public paused;

    uint256 public totalProfit;
    uint256 public totalRuns;

    uint256 private constant BPS = 10_000;
    uint256 private constant USDT_SCALE = 1e12; // 6 decimals -> 18

    struct Pool {
        address pair;
        bool usdtIs0;   // is USDT0 token0 in this pair
        uint16 feeBps;  // pool swap fee, 30 = 0.3%
        bool active;
    }
    Pool[] public pools;

    event Arbed(address indexed caller, uint8 indexed poolId, bool premium, uint256 spent, uint256 profit, uint256 bounty);
    event CrossArbed(address indexed caller, uint8 buyPool, uint8 sellPool, uint256 spent, uint256 profit, uint256 bounty);
    event PoolAdded(uint8 indexed poolId, address pair, uint16 feeBps);
    event PoolSet(uint8 indexed poolId, bool active, uint16 feeBps);
    event ParamsSet(uint256 callerBps, uint256 minProfit, bool paused);
    event ProfitToSet(address profitTo);

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrant"); unlocked = 0; _; unlocked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _usdt0, address _mintr, address _profitTo) {
        require(_usdt0 != address(0) && _mintr != address(0) && _profitTo != address(0), "zero addr");
        usdt0 = IERC20A(_usdt0);
        mintr = IERC20A(_mintr);
        mintrC = IMintrC(_mintr);
        profitTo = _profitTo;
        owner = msg.sender;
    }

    // ------------------------------------------------------------ pools
    /// @notice Register a USDT0/MINTR pair. Reverts unless the pair really is
    ///         that market, so a typo cannot wire the arb to a wrong contract.
    function addPool(address pair, uint16 feeBps) external onlyOwner returns (uint8 id) {
        require(pair != address(0), "zero pair");
        require(feeBps <= 1000, "fee too high");
        address t0 = IUniV2Pair(pair).token0();
        address t1 = IUniV2Pair(pair).token1();
        bool usdtIs0 = t0 == address(usdt0);
        require(
            (usdtIs0 && t1 == address(mintr)) || (t1 == address(usdt0) && t0 == address(mintr)),
            "not a USDT0/MINTR pair"
        );
        for (uint256 i = 0; i < pools.length; i++) require(pools[i].pair != pair, "duplicate");
        require(pools.length < 32, "too many pools");
        pools.push(Pool({ pair: pair, usdtIs0: usdtIs0, feeBps: feeBps, active: true }));
        id = uint8(pools.length - 1);
        emit PoolAdded(id, pair, feeBps);
    }

    function setPool(uint8 id, bool active, uint16 feeBps) external onlyOwner {
        require(id < pools.length, "bad id");
        require(feeBps <= 1000, "fee too high");
        pools[id].active = active;
        pools[id].feeBps = feeBps;
        emit PoolSet(id, active, feeBps);
    }

    function poolCount() external view returns (uint256) { return pools.length; }

    // ------------------------------------------------------------ views
    function _reserves(Pool memory p) internal view returns (uint256 rU, uint256 rM) {
        (uint112 r0, uint112 r1,) = IUniV2Pair(p.pair).getReserves();
        (rU, rM) = p.usdtIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev Constant product with the pool's own fee.
    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut, uint16 feeBps) internal pure returns (uint256) {
        if (rIn == 0 || rOut == 0 || amountIn == 0) return 0;
        uint256 inWithFee = amountIn * (BPS - feeBps);
        return (inWithFee * rOut) / (rIn * BPS + inWithFee);
    }

    function _out(Pool memory p, uint256 amountIn, bool buyingMintr) internal view returns (uint256) {
        (uint256 rU, uint256 rM) = _reserves(p);
        (uint256 rIn, uint256 rOut) = buyingMintr ? (rU, rM) : (rM, rU);
        return _amountOut(amountIn, rIn, rOut, p.feeBps);
    }

    /// @notice Market price on one pool, and the reserve's backing price.
    function prices(uint8 id) public view returns (uint256 market1e18, uint256 contract1e18) {
        require(id < pools.length, "bad id");
        (uint256 rU, uint256 rM) = _reserves(pools[id]);
        market1e18 = rM == 0 ? 0 : (rU * USDT_SCALE * 1e18) / rM;
        contract1e18 = mintrC.price1e18();
    }

    /// @notice Simulate a contract arb on one pool. Zero profit means skip it.
    function quote(uint8 id, uint256 usdtIn) public view returns (bool premium, uint256 profit) {
        if (usdtIn == 0 || id >= pools.length) return (false, 0);
        Pool memory p = pools[id];
        if (!p.active) return (false, 0);
        (uint256 rU, uint256 rM) = _reserves(p);
        if (rU == 0 || rM == 0) return (false, 0);
        uint256 m = (rU * USDT_SCALE * 1e18) / rM;
        uint256 c = mintrC.price1e18();
        if (c == 0) return (false, 0);

        if (m > c) {
            uint256 got = mintrC.quoteBuy(usdtIn);
            if (got == 0) return (true, 0);
            uint256 out = _out(p, got, false);
            return (true, out > usdtIn ? out - usdtIn : 0);
        } else {
            uint256 got = _out(p, usdtIn, true);
            if (got == 0) return (false, 0);
            uint256 out = mintrC.quoteSell(got);
            return (false, out > usdtIn ? out - usdtIn : 0);
        }
    }

    /// @notice Best contract arb across every active pool, for a given size.
    function quoteBest(uint256 usdtIn) external view returns (uint8 id, bool premium, uint256 profit) {
        for (uint8 i = 0; i < uint8(pools.length); i++) {
            (bool prem, uint256 p) = quote(i, usdtIn);
            if (p > profit) { id = i; premium = prem; profit = p; }
        }
    }

    /// @notice Simulate buying MINTR on `buyId` and selling it on `sellId`.
    function quoteCross(uint8 buyId, uint8 sellId, uint256 usdtIn) public view returns (uint256 profit) {
        if (buyId == sellId || buyId >= pools.length || sellId >= pools.length || usdtIn == 0) return 0;
        Pool memory a = pools[buyId];
        Pool memory b = pools[sellId];
        if (!a.active || !b.active) return 0;
        uint256 got = _out(a, usdtIn, true);
        if (got == 0) return 0;
        uint256 out = _out(b, got, false);
        return out > usdtIn ? out - usdtIn : 0;
    }

    /// @notice Best cross-pool pair for a given size.
    function quoteBestCross(uint256 usdtIn) external view returns (uint8 buyId, uint8 sellId, uint256 profit) {
        uint8 n = uint8(pools.length);
        for (uint8 i = 0; i < n; i++) {
            for (uint8 j = 0; j < n; j++) {
                if (i == j) continue;
                uint256 p = quoteCross(i, j, usdtIn);
                if (p > profit) { buyId = i; sellId = j; profit = p; }
            }
        }
    }

    function available() external view returns (uint256) {
        return usdt0.balanceOf(address(this));
    }

    // ------------------------------------------------------------ swapping
    /// @dev Send the input straight to the pair and take the output. No router,
    ///      so no allowance is ever left standing anywhere.
    function _swap(Pool memory p, uint256 amountIn, bool buyingMintr) internal returns (uint256 out) {
        out = _out(p, amountIn, buyingMintr);
        require(out > 0, "no output");
        IERC20A tokenIn = buyingMintr ? usdt0 : mintr;
        require(tokenIn.transfer(p.pair, amountIn), "pair transfer failed");
        // work out which side the pair should pay out
        bool outIsToken0 = buyingMintr ? !p.usdtIs0 : p.usdtIs0;
        IUniV2Pair(p.pair).swap(
            outIsToken0 ? out : 0,
            outIsToken0 ? 0 : out,
            address(this),
            new bytes(0)
        );
    }

    function _settle(uint256 before, bool crossed, uint8 a, uint8 b, bool premium, uint256 spent)
        internal returns (uint256 profit)
    {
        uint256 after_ = usdt0.balanceOf(address(this));
        require(after_ > before, "unprofitable");
        profit = after_ - before;
        require(profit >= minProfit, "below min profit");

        uint256 bounty = (profit * callerBps) / BPS;
        if (bounty > 0) require(usdt0.transfer(msg.sender, bounty), "bounty failed");
        uint256 rest = profit - bounty;
        if (rest > 0) require(usdt0.transfer(profitTo, rest), "profit transfer failed");

        totalProfit += profit;
        totalRuns += 1;
        if (crossed) emit CrossArbed(msg.sender, a, b, spent, profit, bounty);
        else emit Arbed(msg.sender, a, premium, spent, profit, bounty);
    }

    // ------------------------------------------------------------ arb
    /// @notice Arb one pool against the reserve's backing price.
    function arb(uint8 id, uint256 usdtIn) public lock returns (uint256 profit) {
        require(!paused, "paused");
        require(id < pools.length, "bad id");
        Pool memory p = pools[id];
        require(p.active, "pool inactive");

        uint256 before = usdt0.balanceOf(address(this));
        require(usdtIn > 0 && usdtIn <= before, "bad amount");

        (uint256 rU, uint256 rM) = _reserves(p);
        require(rU > 0 && rM > 0, "empty pool");
        uint256 m = (rU * USDT_SCALE * 1e18) / rM;
        uint256 c = mintrC.price1e18();
        require(c > 0, "no price");

        bool premium = m > c;
        if (premium) {
            // mint at the reserve, sell into the pool
            usdt0.approve(address(mintrC), usdtIn);
            uint256 got = mintrC.buy(usdtIn, 0);
            require(got > 0, "mint failed");
            _swap(p, got, false);
        } else {
            // buy from the pool, redeem at the reserve
            uint256 got = _swap(p, usdtIn, true);
            mintr.approve(address(mintrC), got);
            mintrC.sell(got, 0);
        }
        return _settle(before, false, id, 0, premium, usdtIn);
    }

    /// @notice Buy MINTR on one pool and sell it on another. The reserve is not
    ///         touched, so this works even when backing and market agree.
    function arbCross(uint8 buyId, uint8 sellId, uint256 usdtIn) public lock returns (uint256 profit) {
        require(!paused, "paused");
        require(buyId != sellId, "same pool");
        require(buyId < pools.length && sellId < pools.length, "bad id");
        Pool memory a = pools[buyId];
        Pool memory b = pools[sellId];
        require(a.active && b.active, "pool inactive");

        uint256 before = usdt0.balanceOf(address(this));
        require(usdtIn > 0 && usdtIn <= before, "bad amount");

        uint256 got = _swap(a, usdtIn, true);
        _swap(b, got, false);
        return _settle(before, true, buyId, sellId, false, usdtIn);
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

    /// @notice Where profit goes. Settable here, unlike the first version.
    function setProfitTo(address to) external onlyOwner {
        require(to != address(0), "zero");
        profitTo = to;
        emit ProfitToSet(to);
    }

    /// @dev Recover or resize the float. Only ever touches idle balance.
    function sweep(address token, uint256 amount) external onlyOwner {
        IERC20A(token).transfer(owner, amount);
    }

    function transferOwnership(address n) external onlyOwner {
        require(n != address(0), "zero");
        owner = n;
    }
}
