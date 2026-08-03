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

    /// @notice Only sell when the token leg is at least this multiple of the
    /// quote leg, in bps. DCR's rule: overweight before you take profit.
    uint16  public sellRatioBps;
    /// @notice How far below the high-water mark the vault may drift before
    /// every action stops. This is what makes a sell path safe to have.
    uint16  public maxDrawdownBps;
    /// @notice Vault value in quote terms at TWAP, high-water. Rebased by
    /// deposits and withdrawals, which move value legitimately.
    uint256 public valueCheckpoint;

    uint16 public constant MAX_SLICE_BPS = 2500;     // 25% of the reserve at once
    uint16 public constant MAX_SLIPPAGE_BPS = 1000;  // 10% versus TWAP
    uint32 public constant MIN_TWAP_WINDOW = 300;    // 5 minutes
    uint32 public constant MIN_COOLDOWN = 60;
    uint16 public constant MAX_DRAWDOWN_BPS = 3000;  // 30%, the loosest allowed

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount);
    event Executed(bool indexed isBuy, uint256 amountIn, uint256 amountOut, uint256 minOut, uint64 at);
    event Checkpointed(uint256 value);
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
        sellRatioBps = 20000;   // sell only when the token leg is 2x the quote leg
        maxDrawdownBps = 500;   // 5% off the high-water mark stops everything
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
        // += the delta, NEVER an assignment to the current value.
        //
        // deposit() is permissionless, so an assignment here hands the keeper
        // its own scoreboard: pay in one raw unit, the mark rebases to whatever
        // the grinding left, the floor moves down with it, and the breaker can
        // never trip. Measured at ~9% of the vault per day, to zero, for about
        // 2 USDT0 of deposits. AgentVault's header names this exact attack and
        // ratchets upward only; this reintroduced it until a review caught it.
        //
        // A deposit is quote-denominated 1:1, so no oracle is involved: the mark
        // is armed even when the TWAP is unusable, rather than sitting at 0 with
        // no floor at all.
        valueCheckpoint += got;
        emit Checkpointed(valueCheckpoint);
        emit Deposited(msg.sender, got);
    }

    /// @notice Fund the vault with the COIN instead of USDT0, so an agent can
    ///         start overweight and take profit on a pump without having to buy
    ///         its way in first.
    ///
    /// Unlike a USDT0 deposit this one needs a price: the high-water mark is
    /// denominated in quote, and crediting a token deposit at anything other
    /// than its real value would either hand the agent free rope or trip the
    /// breaker on arrival. So it reverts when the pool has no usable average,
    /// rather than guessing. USDT0 deposits and every withdrawal stay
    /// oracle-free, so this can never block the exit.
    function depositToken(uint256 amount) external lock {
        require(amount > 0, "zero");
        uint256 before = IERC20V(token).balanceOf(address(this));
        require(IERC20V(token).transferFrom(msg.sender, address(this), amount), "pull failed");
        uint256 got = IERC20V(token).balanceOf(address(this)) - before;
        require(got > 0, "received nothing");
        uint256 credited = _tokenToQuote(got, TickMath.getSqrtRatioAtTick(_twapTick()));
        require(credited > 0, "no twap");
        valueCheckpoint += credited;
        emit Checkpointed(valueCheckpoint);
        emit Deposited(msg.sender, got);
    }

    /// @notice Withdraw one asset. Available in every state, needs no agent.
    function withdraw(address asset, uint256 amount) public onlyOwner lock {
        require(asset == quote || asset == token, "unknown asset");
        uint256 bal = IERC20V(asset).balanceOf(address(this));
        uint256 amt = (amount == 0 || amount > bal) ? bal : amount;
        require(amt > 0, "nothing to withdraw");
        require(IERC20V(asset).transfer(owner, amt), "transfer failed");
        // Scaled down by the value that left, not reset: a legitimate exit must
        // not read as a loss and trip the breaker afterwards, and must not leave
        // an unreachable mark either. Wrapped so a dead oracle cannot block a
        // withdrawal; the exit never depends on the oracle being healthy.
        uint256 gone = amt;
        if (asset == token) {
            try this.tokenToQuote(amt) returns (uint256 q) { gone = q; } catch { gone = 0; }
        }
        valueCheckpoint = gone >= valueCheckpoint ? 0 : valueCheckpoint - gone;
        emit Checkpointed(valueCheckpoint);
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
        valueCheckpoint = 0;
        emit Checkpointed(0);
    }

    // -------------------------------------------------------------- the agent

    /// @notice Buy a slice of the reserve. The caller chooses WHEN and nothing
    ///         else: size comes from `sliceBps`, and the price floor from the
    ///         pool's TWAP.
    function execute() external lock returns (uint256 spent, uint256 received) {
        _auth();
        uint256 bal = IERC20V(quote).balanceOf(address(this));
        require(bal > 0, "empty");
        spent = _slice(bal);
        received = _swap(quote, token, spent);
        emit Executed(true, spent, received, 0, uint64(block.timestamp));
    }

    /// @notice Sell a slice of the token back into USDT0. The keeper decides
    ///         WHEN a pump is worth taking; the contract decides whether it is
    ///         allowed to at all.
    ///
    /// Two conditions the caller cannot talk its way out of. The vault must be
    /// overweight the token (`sellRatioBps`), which is DCR's rule and stops a
    /// keeper churning a balanced vault. And the drawdown breaker below applies
    /// to both directions, which is what makes having a sell path safe: without
    /// it a compromised keeper round-trips buy, sell, buy, sell and bleeds the
    /// fee plus the tolerance on every leg until the vault is empty. Buy-only
    /// was self-limiting because each unit could only be converted once.
    function executeSell() external lock returns (uint256 spent, uint256 received) {
        _auth();
        uint256 tBal = IERC20V(token).balanceOf(address(this));
        require(tBal > 0, "empty");
        uint160 sp = TickMath.getSqrtRatioAtTick(_twapTick());
        uint256 qBal = IERC20V(quote).balanceOf(address(this));
        uint256 tokenValue = _tokenToQuote(tBal, sp);
        require(tokenValue >= (qBal * sellRatioBps) / 10000, "not overweight");
        spent = _slice(tBal);
        received = _swap(token, quote, spent);
        emit Executed(false, spent, received, 0, uint64(block.timestamp));
    }

    function _auth() internal {
        require(msg.sender == agent || msg.sender == owner, "not agent");
        require(block.timestamp >= lastExec + cooldown, "cooldown");
        lastExec = uint64(block.timestamp); // before any external call
    }

    function _slice(uint256 bal) internal view returns (uint256 amt) {
        amt = (bal * sliceBps) / 10000;
        if (amt == 0) amt = bal;   // dust tail
        if (amt > bal) amt = bal;
    }

    /// One swap path for both directions, so the minimum output and the breaker
    /// cannot be right in one and wrong in the other.
    function _swap(address tin, address tout, uint256 amountIn) internal returns (uint256 out) {
        uint256 minOut = _minOutFor(tin, amountIn);
        require(minOut > 0, "no twap");
        IERC20V(tin).approve(router, amountIn);
        out = IRouterV(router).exactInputSingle(IRouterV.ExactInputSingleParams({
            tokenIn: tin, tokenOut: tout, fee: feeTier,
            recipient: address(this),      // never a caller-supplied address
            amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        _enforceDrawdown();
    }

    /// Value is measured in quote terms at the TWAP, on both sides of the
    /// action, so a moved TWAP is invisible to the comparison rather than being
    /// a way to trip or dodge the breaker.
    function _enforceDrawdown() internal {
        uint256 v = _valueAtTwap();
        uint256 floor = (valueCheckpoint * (10000 - maxDrawdownBps)) / 10000;
        require(v >= floor, "drawdown");
        if (v > valueCheckpoint) { valueCheckpoint = v; emit Checkpointed(v); }
    }

    function _valueAtTwap() internal view returns (uint256) {
        uint160 sp = TickMath.getSqrtRatioAtTick(_twapTick());
        return IERC20V(quote).balanceOf(address(this))
             + _tokenToQuote(IERC20V(token).balanceOf(address(this)), sp);
    }

    /// Token amount priced in quote, at `sp`. The inverse of the buy direction.
    function _tokenToQuote(uint256 amt, uint160 sp) internal view returns (uint256) {
        uint256 p = uint256(sp);
        uint256 Q96 = 1 << 96;
        return quoteIs0
            ? FullMath.mulDiv(FullMath.mulDiv(amt, Q96, p), Q96, p)
            : FullMath.mulDiv(FullMath.mulDiv(amt, p, Q96), p, Q96);
    }

    /// @notice Re-base the high-water mark to the vault's value now. Owner only,
    /// and the only way to clear a tripped breaker: a keeper cannot reset its
    /// own scoreboard.
    function recheckpoint() public onlyOwner {
        valueCheckpoint = _valueAtTwap();
        emit Checkpointed(valueCheckpoint);
    }

    /// @notice What a swap of `amountIn` of `tokenIn` would demand as a minimum
    ///         right now. Reverts if the pool has no usable TWAP.
    function previewMinOut(address tokenIn, uint256 amountIn) external view returns (uint256) {
        return _minOutFor(tokenIn, amountIn);
    }

    /// Expected output at the TWAP, less the owner's tolerance. `quote` is
    /// 6-dec and `token` 18-dec, and the sqrt price already carries that
    /// difference because it is a ratio of raw amounts, so no 1e12 appears
    /// here. Introducing one would be the 1,000,000x error in gotcha 6.
    function _minOutFor(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        require(tokenIn == quote || tokenIn == token, "unknown asset");
        uint256 sp = uint256(TickMath.getSqrtRatioAtTick(_twapTick()));
        uint256 Q96 = 1 << 96;
        // Squared in TWO mulDiv steps, never as sp*sp. A uint160 squared reaches
        // 2^320 and silently overflows uint256, which would make the minimum
        // output a small wrong number and wave through a sandwiched fill.
        bool inIs0 = (tokenIn == quote) == quoteIs0;
        uint256 out = inIs0
            ? FullMath.mulDiv(FullMath.mulDiv(amountIn, sp, Q96), sp, Q96)
            : FullMath.mulDiv(FullMath.mulDiv(amountIn, Q96, sp), Q96, sp);
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

    function valueAtTwap() external view returns (uint256) { return _valueAtTwap(); }
    function tokenToQuote(uint256 amt) external view returns (uint256) {
        return _tokenToQuote(amt, TickMath.getSqrtRatioAtTick(_twapTick()));
    }

    function setAgent(address a) external onlyOwner { agent = a; emit AgentSet(a); }

    function setSellParams(uint16 _ratio, uint16 _drawdown) external onlyOwner {
        require(_ratio >= 10000, "ratio");                 // never sell an underweight vault
        require(_drawdown > 0 && _drawdown <= MAX_DRAWDOWN_BPS, "drawdown");
        sellRatioBps = _ratio; maxDrawdownBps = _drawdown;
    }

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
