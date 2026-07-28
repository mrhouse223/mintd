// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// AgentVault — an agent-managed Uniswap V3 liquidity position, where the agent
/// can never choose a price.
///
/// THE DESIGN CONSTRAINT
/// A vault holding user funds is custody. Saying otherwise is a line that has to
/// be walked back later. The keeper key lives on a server, so the question is
/// not whether it can be compromised but what a compromised key can take.
///
/// The obvious controls are insufficient, and building to them ships a
/// drainable vault. Rebalancing means burning liquidity, swapping to correct
/// the ratio, and minting again. If the agent supplies that swap's minimum
/// output, a compromised keeper sets it near zero and sandwiches its own
/// rebalance from an unrelated address. Against the naive rules:
///
///   funds never sent to an arbitrary address   still true, they left via a swap
///   agent only called rebalance                still true
///   exit points at the immutable owner         still true
///   per-transaction cap                        still true, each one is modest
///
/// Every box ticks and the money is gone. Those rules guard the exit; the theft
/// happens during normal operation.
///
/// THE RULE THIS IS BUILT TO
/// The agent may never choose an execution price, a venue, or a range. It
/// proposes timing. The contract decides everything that carries value:
///
///   - The pool and fee tier are immutable from construction. Not a registry
///     entry an ops key can edit, or the agent rebalances into a pool it made
///     and the owner exits, correctly, to the right address, holding nothing.
///   - Minimum swap output is computed here from the pool's own TWAP. The
///     keeper passes no slippage parameter at all. This is the single change
///     that closes the main vector.
///   - Tick ranges are clamped to a band around the TWAP. The agent proposes a
///     range; the contract bounds it.
///   - A cumulative-loss breaker checkpoints value in TWAP terms and reverts
///     any action that would drop it more than the tolerance. Without this a
///     per-action cap merely sets the drain schedule: a patient attacker takes
///     the cap every time.
///   - Withdrawals go to the owner recorded at construction, and only the owner
///     can trigger them.
///
/// If the keeper is fully compromised, the worst case is wasted gas and badly
/// timed rebalances, never stolen principal. `scripts/test-agent-vault.js`
/// contains the hostile-keeper test that has to prove it.
///
/// HUMAN IN THE LOOP
/// The owner picks how much rope the agent gets, and can change it or revoke
/// entirely at any time, in one transaction, without the agent's cooperation:
///
///   PAUSED       the agent can do nothing
///   PROPOSE_ONLY the agent proposes, the owner must approve each action
///   TIMELOCKED   the agent proposes, it becomes executable after reviewWindow
///                unless the owner vetoes it
///   AUTONOMOUS   the agent acts immediately, inside the bounds above
///
/// Revocation is reactive and cannot be the primary defence, because the people
/// who delegate are exactly the people not watching. The contract-enforced
/// bounds are the defence; the modes are for owners who want more control, not
/// less risk.
/// ----------------------------------------------------------------------------

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IUniswapV3Pool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory);
    function increaseObservationCardinalityNext(uint16) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0; address token1; uint24 fee;
        int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired;
        uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline;
    }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }

    function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external payable returns (uint256, uint256);
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function burn(uint256) external payable;
    function positions(uint256) external view returns (
        uint96, address, address, address, uint24, int24 tickLower, int24 tickUpper,
        uint128 liquidity, uint256, uint256, uint128, uint128);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

library FullMath {
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0; uint256 prod1;
            // Yul separates statements by whitespace, not semicolons. Compressing
            // these onto one line with semicolons is a parse error, not a style
            // choice.
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) { require(d > 0, "mulDiv:0"); return prod0 / d; }
            require(d > prod1, "mulDiv:of");
            uint256 rem;
            assembly {
                rem := mulmod(a, b, d)
                prod1 := sub(prod1, gt(rem, prod0))
                prod0 := sub(prod0, rem)
            }
            uint256 twos = (0 - d) & d;
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }
}

/// @dev Uniswap's TickMath.getSqrtRatioAtTick, transcribed. Needed because the
/// vault values itself at a TWAP tick rather than at whatever the spot price
/// happens to be when a keeper calls.
library TickMath {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)), "T");
            uint256 r = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) r = (r * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) r = (r * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) r = (r * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) r = (r * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) r = (r * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) r = (r * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) r = (r * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) r = (r * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) r = (r * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) r = (r * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) r = (r * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) r = (r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) r = (r * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) r = (r * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) r = (r * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) r = (r * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) r = (r * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) r = (r * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) r = (r * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) r = type(uint256).max / r;
            return uint160((r >> 32) + (r % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

library LiquidityAmounts {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    function amount0For(uint160 a, uint160 b, uint128 L) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        return FullMath.mulDiv(uint256(L) << 96, uint256(b) - a, b) / a;
    }

    function amount1For(uint160 a, uint160 b, uint128 L) internal pure returns (uint256) {
        if (a > b) (a, b) = (b, a);
        return FullMath.mulDiv(L, uint256(b) - a, Q96);
    }

    function amountsFor(uint160 p, uint160 a, uint160 b, uint128 L)
        internal pure returns (uint256 amt0, uint256 amt1)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) amt0 = amount0For(a, b, L);
        else if (p < b) { amt0 = amount0For(p, b, L); amt1 = amount1For(a, p, L); }
        else amt1 = amount1For(a, b, L);
    }
}

contract AgentVault {
    enum Mode { PAUSED, PROPOSE_ONLY, TIMELOCKED, AUTONOMOUS }

    // ------------------------------------------------------------- immutable
    /// @notice Set once at construction. Every withdrawal goes here and only
    /// this address can trigger one. Not settable, at any price.
    address public immutable owner;
    IUniswapV3Pool public immutable pool;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    INonfungiblePositionManager public immutable npm;
    ISwapRouter02 public immutable router;

    // ---------------------------------------------------------------- policy
    address public agent;
    Mode public mode;
    /// @notice How far a proposed range may sit from the TWAP tick.
    int24 public maxTickDrift;
    /// @notice Worst execution the contract will accept versus TWAP, in bps.
    uint256 public maxSlippageBps;
    /// @notice Cumulative drop from the checkpoint that halts the agent, in bps.
    uint256 public lossToleranceBps;
    /// @notice Seconds an owner has to veto in TIMELOCKED mode.
    uint256 public reviewWindow;
    /// @notice TWAP averaging window. Longer is harder to manipulate.
    uint32 public twapWindow;
    /// @notice Minimum gap between agent actions, to stop gas bleed.
    uint256 public cooldown;
    uint256 public lastAction;

    // ----------------------------------------------------------------- state
    uint256 public positionId;
    /// @notice Vault value in token1 terms at TWAP, as of the last checkpoint.
    uint256 public valueCheckpoint;

    struct Proposal { int24 lower; int24 upper; uint64 readyAt; bool approved; bool open; }
    Proposal public proposal;

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyAgent() { require(msg.sender == agent && agent != address(0), "not agent"); _; }

    event Deposited(uint256 amount0, uint256 amount1);
    event Withdrawn(uint256 amount0, uint256 amount1);
    event Proposed(int24 lower, int24 upper, uint64 readyAt);
    event Vetoed();
    event Rebalanced(int24 lower, int24 upper, uint256 valueBefore, uint256 valueAfter);
    event Compounded(uint256 amount0, uint256 amount1);
    event AgentChanged(address indexed from, address indexed to);
    event ModeChanged(Mode from, Mode to);
    event Halted(uint256 valueNow, uint256 checkpoint);

    constructor(
        address _owner,
        address _pool,
        address _npm,
        address _router,
        address _agent
    ) {
        require(_owner != address(0) && _pool != address(0) && _npm != address(0) && _router != address(0), "zero");
        owner = _owner;
        pool = IUniswapV3Pool(_pool);
        token0 = IERC20(IUniswapV3Pool(_pool).token0());
        token1 = IERC20(IUniswapV3Pool(_pool).token1());
        fee = IUniswapV3Pool(_pool).fee();
        tickSpacing = IUniswapV3Pool(_pool).tickSpacing();
        npm = INonfungiblePositionManager(_npm);
        router = ISwapRouter02(_router);
        agent = _agent;

        // Conservative defaults. An owner who never touches these is still safe:
        // PROPOSE_ONLY means the agent cannot move anything without a human.
        mode = Mode.PROPOSE_ONLY;
        maxTickDrift = 2000;      // ~22% around the TWAP
        maxSlippageBps = 100;     // 1% versus TWAP
        lossToleranceBps = 500;   // 5% cumulative before the agent is halted
        reviewWindow = 1 hours;
        twapWindow = 1800;        // 30 minutes
        cooldown = 1 hours;

        // A pool created by a launchpad has one observation slot, so observe()
        // reverts and no TWAP exists. Ask for more now; it fills as the pool
        // trades. Actions requiring a TWAP revert until it is available.
        try IUniswapV3Pool(_pool).increaseObservationCardinalityNext(64) {} catch {}
    }

    // ------------------------------------------------------------ owner only

    function deposit(uint256 amount0, uint256 amount1) external onlyOwner lock {
        if (amount0 > 0) require(token0.transferFrom(msg.sender, address(this), amount0), "t0");
        if (amount1 > 0) require(token1.transferFrom(msg.sender, address(this), amount1), "t1");
        emit Deposited(amount0, amount1);
        _checkpoint();
    }

    /// @notice Pull everything back to the owner. Always available, needs no
    /// agent cooperation, and works in every mode including PAUSED.
    function withdrawAll() external onlyOwner lock {
        if (positionId != 0) _closePosition();
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        if (b0 > 0) require(token0.transfer(owner, b0), "w0");
        if (b1 > 0) require(token1.transfer(owner, b1), "w1");
        valueCheckpoint = 0;
        emit Withdrawn(b0, b1);
    }

    function setAgent(address a) external onlyOwner { emit AgentChanged(agent, a); agent = a; }
    function revokeAgent() external onlyOwner { emit AgentChanged(agent, address(0)); agent = address(0); }

    function setMode(Mode m) external onlyOwner { emit ModeChanged(mode, m); mode = m; }

    function setPolicy(
        int24 _maxTickDrift,
        uint256 _maxSlippageBps,
        uint256 _lossToleranceBps,
        uint256 _reviewWindow,
        uint32 _twapWindow,
        uint256 _cooldown
    ) external onlyOwner {
        // Bounded so an owner cannot be socially engineered into a policy that
        // is equivalent to handing over the keys, and so a compromised owner
        // key gains nothing the owner could not already do by withdrawing.
        require(_maxTickDrift > 0 && _maxTickDrift <= 20000, "drift");
        require(_maxSlippageBps <= 500, "slippage");       // never worse than 5%
        require(_lossToleranceBps <= 2000, "tolerance");   // never worse than 20%
        require(_twapWindow >= 300, "twap window");        // at least 5 minutes
        maxTickDrift = _maxTickDrift;
        maxSlippageBps = _maxSlippageBps;
        lossToleranceBps = _lossToleranceBps;
        reviewWindow = _reviewWindow;
        twapWindow = _twapWindow;
        cooldown = _cooldown;
    }

    /// @notice Accept a pending proposal in PROPOSE_ONLY mode.
    function approve() external onlyOwner { require(proposal.open, "none"); proposal.approved = true; }

    function veto() external onlyOwner { delete proposal; emit Vetoed(); }

    /// @notice Re-arm the agent after the loss breaker halted it. Deliberately
    /// manual: an automatic reset would let a slow drain continue forever.
    function resetCheckpoint() external onlyOwner { _checkpoint(); }

    // ------------------------------------------------------------ agent path

    /// @notice Propose a new range. Carries no authority on its own.
    function propose(int24 lower, int24 upper) external onlyAgent {
        require(mode != Mode.PAUSED, "paused");
        _validRange(lower, upper);
        proposal = Proposal({
            lower: lower, upper: upper,
            readyAt: uint64(block.timestamp + reviewWindow),
            approved: false, open: true
        });
        emit Proposed(lower, upper, proposal.readyAt);
    }

    /// @notice Move the position into the proposed range.
    ///
    /// The caller supplies no price, no minimum output and no venue. Every one
    /// of those is derived here from the pool's TWAP, which is the whole point:
    /// a compromised keeper controls only *when* this runs.
    function execute() external lock {
        Proposal memory p = proposal;
        require(p.open, "no proposal");

        if (mode == Mode.PAUSED) revert("paused");
        else if (mode == Mode.PROPOSE_ONLY) require(p.approved, "needs approval");
        else if (mode == Mode.TIMELOCKED) require(block.timestamp >= p.readyAt || p.approved, "in review");
        // AUTONOMOUS falls through

        require(msg.sender == agent || msg.sender == owner, "not permitted");
        require(block.timestamp >= lastAction + cooldown, "cooldown");

        // Re-check the range against the TWAP at execution, not only at
        // proposal. Otherwise an agent proposes a range that is legal now and
        // executes it after moving the market.
        _validRange(p.lower, p.upper);

        uint160 twap = _twapSqrtPrice();
        uint256 before = _valueAt(twap);

        if (positionId != 0) _closePosition();
        _rebalanceToRatio(p.lower, p.upper, twap);
        _openPosition(p.lower, p.upper);

        uint256 nowValue = _valueAt(twap);
        _enforceLoss(nowValue);

        lastAction = block.timestamp;
        delete proposal;
        valueCheckpoint = nowValue > valueCheckpoint ? nowValue : valueCheckpoint;
        emit Rebalanced(p.lower, p.upper, before, nowValue);
    }

    /// @notice Collect fees back into the position's tokens. No swap, so there
    /// is no price for anyone to choose, which is why this needs no proposal.
    function compound() external lock {
        require(msg.sender == agent || msg.sender == owner, "not permitted");
        require(mode != Mode.PAUSED, "paused");
        require(positionId != 0, "no position");
        (uint256 a0, uint256 a1) = npm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: positionId, recipient: address(this),
            amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        emit Compounded(a0, a1);
    }

    // -------------------------------------------------------------- internal

    function _validRange(int24 lower, int24 upper) internal view {
        require(lower < upper, "range");
        require(lower % tickSpacing == 0 && upper % tickSpacing == 0, "spacing");
        require(lower >= TickMath.MIN_TICK && upper <= TickMath.MAX_TICK, "bounds");
        int24 t = _twapTick();
        // The range must straddle, or sit close to, the TWAP. An agent cannot
        // park the position somewhere it will never earn, nor use an extreme
        // range as a roundabout way of dumping into a swap.
        require(lower >= t - maxTickDrift && upper <= t + maxTickDrift, "outside TWAP band");
    }

    function _twapTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow; ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        int56 delta = cum[1] - cum[0];
        int24 t = int24(delta / int56(uint56(twapWindow)));
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) t--;
        return t;
    }

    function _twapSqrtPrice() internal view returns (uint160) {
        return TickMath.getSqrtRatioAtTick(_twapTick());
    }

    /// @dev Vault value denominated in token1, priced at the TWAP rather than
    /// spot. Spot is what an attacker can move inside one transaction; the
    /// point of the breaker is to be measured in something they cannot.
    function _valueAt(uint160 sqrtP) internal view returns (uint256) {
        uint256 amt0 = token0.balanceOf(address(this));
        uint256 amt1 = token1.balanceOf(address(this));
        if (positionId != 0) {
            (,,,,, int24 lo, int24 hi, uint128 L,,,,) = npm.positions(positionId);
            (uint256 p0, uint256 p1) = LiquidityAmounts.amountsFor(
                sqrtP, TickMath.getSqrtRatioAtTick(lo), TickMath.getSqrtRatioAtTick(hi), L);
            amt0 += p0; amt1 += p1;
        }
        return amt1 + _quote0In1(amt0, sqrtP);
    }

    function _quote0In1(uint256 amount0, uint160 sqrtP) internal pure returns (uint256) {
        uint256 Q = LiquidityAmounts.Q96;
        return FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtP, Q), sqrtP, Q);
    }

    function _enforceLoss(uint256 nowValue) internal {
        if (valueCheckpoint == 0) return;
        uint256 floorValue = valueCheckpoint - (valueCheckpoint * lossToleranceBps) / 10_000;
        if (nowValue < floorValue) {
            emit Halted(nowValue, valueCheckpoint);
            revert("loss breaker");
        }
    }

    function _checkpoint() internal {
        // Only meaningful once the pool can produce a TWAP. Before that the
        // vault simply has no checkpoint and the breaker cannot arm, which is
        // why agent actions requiring a TWAP revert until it exists.
        try this.valueNow() returns (uint256 v) { valueCheckpoint = v; } catch {}
    }

    /// @notice Current vault value in token1 terms at TWAP. External so that
    /// _checkpoint can call it inside a try, and useful for a frontend.
    function valueNow() external view returns (uint256) { return _valueAt(_twapSqrtPrice()); }

    function _closePosition() internal {
        (,,,,,,, uint128 L,,,,) = npm.positions(positionId);
        if (L > 0) {
            npm.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: positionId, liquidity: L,
                // Zero here is safe ONLY because value is checked against TWAP
                // after the whole operation. A minimum priced off spot would be
                // a number the attacker controls.
                amount0Min: 0, amount1Min: 0, deadline: block.timestamp
            }));
        }
        npm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: positionId, recipient: address(this),
            amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        npm.burn(positionId);
        positionId = 0;
    }

    /// @dev Swap toward the ratio the new range needs. The minimum output is
    /// computed here from the TWAP, so the keeper cannot widen it.
    function _rebalanceToRatio(int24 lower, int24 upper, uint160 twap) internal {
        uint160 sa = TickMath.getSqrtRatioAtTick(lower);
        uint160 sb = TickMath.getSqrtRatioAtTick(upper);
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));

        // Target ratio implied by the range at TWAP, expressed as the share of
        // total value that should sit in token1.
        (uint256 u0, uint256 u1) = LiquidityAmounts.amountsFor(twap, sa, sb, 1e18);
        uint256 total = _quote0In1(b0, twap) + b1;
        if (total == 0) return;
        uint256 unitTotal = _quote0In1(u0, twap) + u1;
        uint256 want1 = unitTotal == 0 ? 0 : FullMath.mulDiv(total, u1, unitTotal);

        if (b1 < want1) {
            uint256 need = want1 - b1;
            uint256 in0 = _quote1In0(need, twap);
            if (in0 > b0) in0 = b0;
            if (in0 > 0) _swap(address(token0), address(token1), in0, _quote0In1(in0, twap));
        } else if (b1 > want1) {
            uint256 excess = b1 - want1;
            if (excess > b1) excess = b1;
            if (excess > 0) _swap(address(token1), address(token0), excess, _quote1In0(excess, twap));
        }
    }

    function _quote1In0(uint256 amount1, uint160 sqrtP) internal pure returns (uint256) {
        uint256 Q = LiquidityAmounts.Q96;
        return FullMath.mulDiv(FullMath.mulDiv(amount1, Q, sqrtP), Q, sqrtP);
    }

    function _swap(address tin, address tout, uint256 amountIn, uint256 fairOut) internal {
        // The one line that matters: minimum output comes from the TWAP and the
        // owner's tolerance, never from the caller.
        uint256 minOut = fairOut - (fairOut * maxSlippageBps) / 10_000;
        IERC20(tin).approve(address(router), amountIn);
        router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: tin, tokenOut: tout, fee: fee, recipient: address(this),
            amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
    }

    function _openPosition(int24 lower, int24 upper) internal {
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        token0.approve(address(npm), b0);
        token1.approve(address(npm), b1);
        (uint256 id,,,) = npm.mint(INonfungiblePositionManager.MintParams({
            token0: address(token0), token1: address(token1), fee: fee,
            tickLower: lower, tickUpper: upper,
            amount0Desired: b0, amount1Desired: b1,
            amount0Min: 0, amount1Min: 0,
            recipient: address(this), deadline: block.timestamp
        }));
        positionId = id;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
