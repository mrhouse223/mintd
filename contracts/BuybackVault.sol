// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath, TickMath} from "./AgentVault.sol";

/// @title BuybackVault
/// @notice A user-owned vault that buys one token with USDT0 on a schedule an
///         agent proposes. The owner deposits, the agent buys, the owner
///         withdraws. Bought tokens stay here and belong to the owner.
///
/// THE KEEPER PASSES NO PRICE, EVER
/// This is the whole design and it is copied from AgentVault rather than
/// reinvented. If `execute` took a `minOut`, a compromised keeper would set it
/// near zero and sandwich its own trade, and every other protection here would
/// be decoration. Instead the vault reads the pool's own TWAP and derives the
/// minimum itself. The agent supplies TIMING and nothing else.
///
/// WHAT A FULLY COMPROMISED KEEPER CAN DO
/// Waste gas, and buy at bad moments within a TWAP-bounded price and a capped
/// size. It cannot withdraw, cannot name a recipient, cannot pick a price,
/// cannot exceed the slice, and cannot beat the cooldown. Withdrawal never
/// depends on it being alive or cooperative.
interface IERC20V {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface IPoolV {
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
    function increaseObservationCardinalityNext(uint16) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160, int24, uint16 observationIndex,
        uint16 observationCardinality, uint16, uint8, bool);
    function observations(uint256) external view returns (uint32 blockTimestamp, int56, uint160, bool initialized);
}
interface IFactoryV {
    function getPool(address, address, uint24) external view returns (address);
}
interface IRouterV {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract BuybackVault {
    /// @notice Set once at construction. Every withdrawal goes here and only
    /// here, so there is no "change owner" call for an attacker to reach.
    address public immutable owner;
    address public immutable quote;   // USDT0, 6-dec
    address public immutable token;   // the coin being bought, 18-dec
    address public immutable pool;
    address public immutable router;
    uint24  public immutable feeTier;
    bool    public immutable quoteIs0;

    address public agent;             // revocable, and never needed to withdraw
    uint16  public sliceBps;          // per-execution slice of the quote balance
    uint16  public maxSlippageBps;    // worst execution accepted versus TWAP
    uint32  public twapWindow;
    uint32  public cooldown;
    uint64  public lastExec;

    uint16 public constant MAX_SLICE_BPS = 2500;     // 25% of the reserve at once
    uint16 public constant MAX_SLIPPAGE_BPS = 1000;  // 10% versus TWAP
    uint32 public constant MIN_TWAP_WINDOW = 300;    // 5 minutes
    uint32 public constant MIN_COOLDOWN = 60;

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount);
    event Executed(uint256 quoteIn, uint256 tokenOut, uint256 minOut, uint64 at);
    event AgentSet(address indexed agent);
    event ParamsSet(uint16 sliceBps, uint16 maxSlippageBps, uint32 twapWindow, uint32 cooldown);

    constructor(address _owner, address _quote, address _token, address _pool, address _router, address _factory) {
        require(_owner != address(0) && _pool != address(0) && _router != address(0), "zero");
        require(_quote != _token, "same token");
        owner = _owner; quote = _quote; token = _token; pool = _pool; router = _router;

        address t0 = IPoolV(_pool).token0();
        address t1 = IPoolV(_pool).token1();
        require((t0 == _quote && t1 == _token) || (t0 == _token && t1 == _quote), "pool mismatch");
        uint24 f = IPoolV(_pool).fee();
        // A pool that reports the right tokens but serves an attacker-controlled
        // observe() makes the vault derive its minimum from a fake TWAP while
        // trading in the real pool. Every protection here reads that TWAP, so
        // without this check the whole thing is drainable. Load-bearing the
        // moment a factory lets a user pass a pool address, which is exactly
        // how this contract is meant to be deployed.
        require(IFactoryV(_factory).getPool(t0, t1, f) == _pool, "not canonical");
        feeTier = f;
        quoteIs0 = (t0 == _quote);

        sliceBps = 500;        // 5%
        // The router's output is NET of the pool fee, while the TWAP is not, so
        // a tolerance below the fee makes every fill land under the minimum and
        // execute() revert on any real pool. Every launchpad pool is the 1%
        // tier, where a flat 1% default would have bricked this in production
        // and no mock would have shown it. Fee plus 1%.
        uint16 feeBps = uint16(f / 100);
        maxSlippageBps = feeBps + 100;
        require(maxSlippageBps <= MAX_SLIPPAGE_BPS, "fee tier too high");
        twapWindow = 1800;     // 30 minutes
        cooldown = 600;        // 10 minutes

        // Launchpad pools ship with a single observation slot. Ask for more now;
        // it fills as the pool trades. Note this call succeeding is NOT what
        // makes the oracle safe: see _twapTick, where the freshness check is.
        try IPoolV(_pool).increaseObservationCardinalityNext(64) {} catch {}
    }

    // ------------------------------------------------------------------ funds

    /// @notice Top the vault up. Anyone may pay in, only the owner takes out.
    function deposit(uint256 amount) external lock {
        require(amount > 0, "zero");
        uint256 before = IERC20V(quote).balanceOf(address(this));
        require(IERC20V(quote).transferFrom(msg.sender, address(this), amount), "pull failed");
        uint256 got = IERC20V(quote).balanceOf(address(this)) - before;
        require(got > 0, "received nothing");
        emit Deposited(msg.sender, got);
    }

    /// @notice Withdraw one asset. Available in every state, needs no agent.
    function withdraw(address asset, uint256 amount) public onlyOwner lock {
        require(asset == quote || asset == token, "unknown asset");
        uint256 bal = IERC20V(asset).balanceOf(address(this));
        uint256 amt = (amount == 0 || amount > bal) ? bal : amount;
        require(amt > 0, "nothing to withdraw");
        require(IERC20V(asset).transfer(owner, amt), "transfer failed");
        emit Withdrawn(asset, amt);
    }

    /// @notice Pull everything back. Zero balances are SKIPPED rather than sent:
    /// a token that reverts on a zero-value transfer would otherwise brick the
    /// exit whenever one leg happened to be empty.
    function withdrawAll() external onlyOwner lock {
        uint256 q = IERC20V(quote).balanceOf(address(this));
        uint256 t = IERC20V(token).balanceOf(address(this));
        require(q > 0 || t > 0, "empty");
        if (q > 0) { require(IERC20V(quote).transfer(owner, q), "wq"); emit Withdrawn(quote, q); }
        if (t > 0) { require(IERC20V(token).transfer(owner, t), "wt"); emit Withdrawn(token, t); }
    }

    // -------------------------------------------------------------- the agent

    /// @notice Buy a slice of the reserve. The caller chooses WHEN and nothing
    ///         else: size comes from `sliceBps`, and the price floor from the
    ///         pool's TWAP.
    function execute() external lock returns (uint256 spent, uint256 received) {
        require(msg.sender == agent || msg.sender == owner, "not agent");
        require(block.timestamp >= lastExec + cooldown, "cooldown");

        uint256 bal = IERC20V(quote).balanceOf(address(this));
        require(bal > 0, "empty");
        spent = (bal * sliceBps) / 10000;
        if (spent == 0) spent = bal;         // dust tail, spend the remainder
        if (spent > bal) spent = bal;

        uint256 minOut = _minOutFor(spent);
        require(minOut > 0, "no twap");

        lastExec = uint64(block.timestamp);  // before the external call
        IERC20V(quote).approve(router, spent);
        received = IRouterV(router).exactInputSingle(IRouterV.ExactInputSingleParams({
            tokenIn: quote, tokenOut: token, fee: feeTier,
            recipient: address(this),        // never a caller-supplied address
            amountIn: spent, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        emit Executed(spent, received, minOut, uint64(block.timestamp));
    }

    /// @notice What `execute` would demand as a minimum right now. Reverts if
    ///         the pool has no TWAP yet.
    function previewMinOut(uint256 amountIn) external view returns (uint256) {
        return _minOutFor(amountIn);
    }

    /// Expected output at the TWAP, less the owner's tolerance. `quote` is
    /// 6-dec and `token` 18-dec, and the sqrt price already carries that
    /// difference because it is a ratio of raw amounts, so no 1e12 appears
    /// here. Introducing one would be the 1,000,000x error in gotcha 6.
    function _minOutFor(uint256 amountIn) internal view returns (uint256) {
        uint256 sp = uint256(TickMath.getSqrtRatioAtTick(_twapTick()));
        uint256 Q96 = 1 << 96;
        uint256 out;
        // Squared in TWO mulDiv steps, never as sp*sp. A uint160 squared reaches
        // 2^320 and silently overflows uint256, which would make the minimum
        // output a small wrong number and wave through a sandwiched fill.
        if (quoteIs0) {
            out = FullMath.mulDiv(FullMath.mulDiv(amountIn, sp, Q96), sp, Q96);
        } else {
            out = FullMath.mulDiv(FullMath.mulDiv(amountIn, Q96, sp), Q96, sp);
        }
        return (out * (10000 - maxSlippageBps)) / 10000;
    }

    /// A TWAP is only a TWAP if the pool actually recorded history over the
    /// window. Uniswap's observe() does NOT revert when it has none: if the
    /// newest observation is older than the window it EXTRAPOLATES from the
    /// current tick, and the average it returns is byte-identical to spot.
    /// scripts/seed-twap.js says the same thing in this repo already: "the
    /// protection is not broken, it is unarmed."
    ///
    /// That is the whole attack. Push the price in a pool nobody trades, wait
    /// out the window, and the vault derives its minimum output from the price
    /// you set. A non-zero minOut is not evidence of a real average, so the
    /// check has to be on the observation itself.
    function _twapTick() internal view returns (int24) {
        (, , uint16 idx, uint16 card, , , ) = IPoolV(pool).slot0();
        require(card >= 2, "oracle unarmed");
        (uint32 newest, , , bool init) = IPoolV(pool).observations(idx);
        require(init && block.timestamp - newest <= twapWindow, "stale oracle");

        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow; ago[1] = 0;
        (int56[] memory cum, ) = IPoolV(pool).observe(ago);
        int56 delta = cum[1] - cum[0];
        int24 t = int24(delta / int56(uint56(twapWindow)));
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) t--;
        return t;
    }

    // ------------------------------------------------------------ owner knobs

    function setAgent(address a) external onlyOwner { agent = a; emit AgentSet(a); }

    /// Bounded, so an owner cannot accidentally configure a vault that hands
    /// its whole balance to slippage on one call.
    function setParams(uint16 _slice, uint16 _slip, uint32 _twap, uint32 _cool) external onlyOwner {
        require(_slice > 0 && _slice <= MAX_SLICE_BPS, "slice");
        require(_slip <= MAX_SLIPPAGE_BPS, "slippage");
        require(_twap >= MIN_TWAP_WINDOW, "twap window");
        // Unbounded before. cooldown == 0 makes the slice cap vacuous, because a
        // keeper can then call execute() back to back in one block and convert
        // the whole balance at the slippage floor.
        require(_cool >= MIN_COOLDOWN, "cooldown");
        sliceBps = _slice; maxSlippageBps = _slip; twapWindow = _twap; cooldown = _cool;
        emit ParamsSet(_slice, _slip, _twap, _cool);
    }

    function balances() external view returns (uint256 quoteBal, uint256 tokenBal) {
        return (IERC20V(quote).balanceOf(address(this)), IERC20V(token).balanceOf(address(this)));
    }
}
