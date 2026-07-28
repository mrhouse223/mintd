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
    function factory() external view returns (address);
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
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
    /// @notice Which leg the vault denominates itself in. Uniswap orders tokens
    /// by address, so whether token1 is the stable leg or the volatile one is a
    /// coin flip. Valuing in the volatile leg makes the loss breaker track price
    /// instead of loss: an ordinary 2x would read as a ~29% drop and halt the
    /// agent, and a round trip would ratchet the high-water mark somewhere the
    /// vault can never reach again.
    bool public immutable valueInToken0;
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
    /// @notice Vault value in numeraire terms at TWAP, as of the last checkpoint.
    uint256 public valueCheckpoint;
    /// @notice The TWAP tick the checkpoint was taken at. A value measured at a
    /// very different price is not comparable, and the breaker compares the two
    /// sides of an action at the SAME twap, so a moved TWAP is invisible to it
    /// by construction. Halting instead is the correct failure mode.
    int24 public checkpointTick;

    struct Proposal { int24 lower; int24 upper; uint64 readyAt; bool approved; bool open; uint256 nonce; }
    Proposal public proposal;
    /// @notice Increments on every propose. An approval names the nonce it is
    /// approving, so an agent cannot swap a different proposal underneath a
    /// pending owner transaction.
    uint256 public proposalNonce;

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
        address _agent,
        address _numeraire
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

        require(
            _numeraire == address(token0) || _numeraire == address(token1),
            "numeraire not in pool"
        );
        valueInToken0 = _numeraire == address(token0);

        // The pool must be the canonical one the router and NPM will actually
        // trade through, resolved from the factory rather than taken on trust.
        //
        // Without this, a contract that reports a real pool's tokens and fee
        // but serves an attacker-controlled observe() makes the vault derive
        // its minimum output from a fake TWAP while trading in the real pool.
        // Every other protection reads off that TWAP, so the whole thing
        // becomes drainable. Unreachable today because vaults are deployed by
        // hand, and load-bearing the moment a factory lets a user pass a pool
        // address, which is the next thing this needs.
        address fac = INonfungiblePositionManager(_npm).factory();
        require(
            IUniswapV3Factory(fac).getPool(address(token0), address(token1), fee) == _pool,
            "pool not canonical"
        );

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
        require(amount0 > 0 || amount1 > 0, "nothing");
        if (amount0 > 0) require(token0.transferFrom(msg.sender, address(this), amount0), "t0");
        if (amount1 > 0) require(token1.transferFrom(msg.sender, address(this), amount1), "t1");
        emit Deposited(amount0, amount1);

        // Deliberately NOT _checkpoint(), which sets the checkpoint in both
        // directions. Routing a downward reset through deposit would undo the
        // loss breaker: an agent grinds the vault to just above its floor, the
        // owner tops up, the checkpoint re-baselines lower, and the grind
        // resumes against the new total. Ratchet upward only, so the only way
        // to lower a checkpoint stays the explicit, documented resetCheckpoint.
        //
        // Unguarded on purpose: if the pool cannot yet produce a TWAP this
        // reverts, which is the right outcome. A deposit that silently leaves
        // the breaker unarmed is how the first agent action gets to run with no
        // loss protection at all.
        //
        // Computed internally rather than via this.valueNow(). An external
        // self-call would be identical in effect, but it makes gas estimation
        // unreliable for anything calling deposit, which showed up immediately
        // as spurious estimateGas failures in the tests.
        int24 tw = _twapTick();
        uint256 v = _valueAt(TickMath.getSqrtRatioAtTick(tw));
        if (v > valueCheckpoint) { valueCheckpoint = v; checkpointTick = tw; }
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
        // A proposal left standing here would execute against the next deposit,
        // staged before the owner ever made it.
        _clearProposal();
        emit Withdrawn(b0, b1);
    }

    // Each of these clears any pending proposal. Without that, an agent can
    // stage a proposal under a permissive mode, let it mature, and execute it
    // the instant the owner tightens the rules: propose under AUTONOMOUS, wait
    // past readyAt, and the moment the owner switches to TIMELOCKED the staged
    // action is immediately executable with zero review. The owner's first act
    // of taking control would otherwise be the one thing that releases it.
    function setAgent(address a) external onlyOwner {
        emit AgentChanged(agent, a); agent = a; _clearProposal();
    }
    function revokeAgent() external onlyOwner {
        emit AgentChanged(agent, address(0)); agent = address(0); _clearProposal();
    }
    function setMode(Mode m) external onlyOwner {
        emit ModeChanged(mode, m); mode = m; _clearProposal();
    }

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
        // Without a floor, TIMELOCKED with a zero window is just AUTONOMOUS
        // wearing its name, and the mode stops meaning what it says.
        require(_reviewWindow >= 300, "review window");
        maxTickDrift = _maxTickDrift;
        maxSlippageBps = _maxSlippageBps;
        lossToleranceBps = _lossToleranceBps;
        reviewWindow = _reviewWindow;
        twapWindow = _twapWindow;
        cooldown = _cooldown;
    }

    /// @notice Accept a specific pending proposal, named by its nonce.
    ///
    /// The nonce is not ceremony. With an unbound `approve()` the agent watches
    /// for the owner's transaction in the mempool, front-runs it with a
    /// different `propose`, and the owner's approval lands on a proposal they
    /// never saw. In TIMELOCKED that is worse still, because `approved` is the
    /// owner's fast-track past the review window, so the substituted proposal
    /// executes immediately with no review at all.
    function approve(uint256 nonce) external onlyOwner {
        require(proposal.open, "none");
        require(proposal.nonce == nonce, "stale approval");
        proposal.approved = true;
    }

    /// @dev Unconditional on purpose. Cancelling is always the conservative
    /// direction, so binding a nonce here would only create a way for a veto to
    /// fail when the owner wanted something gone.
    function veto() external onlyOwner { _clearProposal(); emit Vetoed(); }

    /// @notice Re-arm the agent after the loss breaker halted it, or after the
    /// TWAP has moved far enough that the old checkpoint is not comparable.
    /// Deliberately manual: an automatic reset would let a slow drain continue
    /// forever.
    ///
    /// Reverts if no TWAP is available. Swallowing that would leave the breaker
    /// disarmed while reporting success, which is the one outcome an owner
    /// calling this must never get.
    function resetCheckpoint() external onlyOwner {
        int24 tw = _twapTick();
        valueCheckpoint = _valueAt(TickMath.getSqrtRatioAtTick(tw));
        checkpointTick = tw;
    }

    // ------------------------------------------------------------ agent path

    /// @notice Propose a new range. Carries no authority on its own.
    function propose(int24 lower, int24 upper) external onlyAgent {
        require(mode != Mode.PAUSED, "paused");
        _validRange(lower, upper);
        proposalNonce++;
        proposal = Proposal({
            lower: lower, upper: upper,
            readyAt: uint64(block.timestamp + reviewWindow),
            approved: false, open: true, nonce: proposalNonce
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

        require(valueCheckpoint > 0, "unarmed");

        int24 tw = _twapTick();
        (, int24 spotTick,,,,,) = pool.slot0();
        // Single-block manipulation barely moves a 30-minute TWAP, so a large
        // spot/TWAP gap means the price is being pushed right now. Minting at
        // spot with no minimums, which is what the position manager does, then
        // skims the convexity gap: on a +1800 tick push that is ~2.25% of the
        // vault in one transaction, and it is invisible to the loss breaker
        // because the breaker measures both sides at the unmoved TWAP.
        int24 gap = spotTick > tw ? spotTick - tw : tw - spotTick;
        require(gap <= maxTickDrift, "spot far from TWAP");

        // And if the TWAP itself has walked away from where the checkpoint was
        // taken, the checkpoint is not a comparable number. The breaker cannot
        // see a manipulated TWAP on its own: `before` and `after` are both
        // measured at it, so the theft nets to zero and the checkpoint then
        // ratchets UP to the inflated figure. Halt and make the owner re-arm.
        int24 cpGap = tw > checkpointTick ? tw - checkpointTick : checkpointTick - tw;
        require(cpGap <= maxTickDrift, "TWAP moved since checkpoint");

        uint160 twap = TickMath.getSqrtRatioAtTick(tw);
        uint256 before = _valueAt(twap);

        if (positionId != 0) _closePosition();
        _rebalanceToRatio(p.lower, p.upper, twap);
        _openPosition(p.lower, p.upper);

        uint256 nowValue = _valueAt(twap);
        _enforceLoss(nowValue);

        lastAction = block.timestamp;
        _clearProposal();
        if (nowValue > valueCheckpoint) { valueCheckpoint = nowValue; checkpointTick = tw; }
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

    /// @dev Cancels the pending proposal without `delete`, which would clear six
    /// storage slots at once.
    ///
    /// NOTE FOR CALLERS, and it applies beyond this function: several entry
    /// points here are under-reported by `eth_estimateGas`. Cancelling a live
    /// proposal clears storage, and a refund makes the estimate the NET figure
    /// while the EVM needs the GROSS; `deposit` and `execute` read the pool
    /// through external calls, which estimators also handle poorly. Measured on
    /// setMode: 32,450 estimated against 30,249 actual with nothing pending,
    /// and short with a proposal live.
    ///
    /// Wallets add a buffer as a matter of course. A frontend or script calling
    /// deposit, execute, setMode, setAgent, revokeAgent, veto or withdrawAll
    /// directly must set an explicit gas limit rather than trusting a bare
    /// estimate. This is a tooling limitation, not a fault in these functions:
    /// every one of them succeeds when given the gas it actually needs.
    ///
    /// Every consumer gates on `open`, so clearing the two flags is equivalent
    /// to a full delete.
    function _clearProposal() internal {
        proposal.open = false;
        proposal.approved = false;
    }


    function _validRange(int24 lower, int24 upper) internal view {
        require(lower < upper, "range");
        require(lower % tickSpacing == 0 && upper % tickSpacing == 0, "spacing");
        require(lower >= TickMath.MIN_TICK && upper <= TickMath.MAX_TICK, "bounds");
        int24 t = _twapTick();
        require(lower >= t - maxTickDrift && upper <= t + maxTickDrift, "outside TWAP band");
        // The range must CONTAIN the TWAP, not merely sit near it. Bounding the
        // band alone let a one-sided range through, and _rebalanceToRatio then
        // correctly computes a target of zero for one leg and swaps the ENTIRE
        // balance of it. Proposing the mirror range next time swaps it all back.
        // The agent still cannot pick the price, but it picks the notional that
        // crosses the spread, which is the multiplier on every per-swap loss.
        //
        // An earlier comment here claimed this was already enforced. It was not,
        // and the grind test never caught it because that test only ever
        // proposed straddling ranges, exactly like the honest keeper does.
        require(lower <= t && upper >= t, "must straddle TWAP");
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
        return valueInToken0 ? amt0 + _quote1In0(amt1, sqrtP) : amt1 + _quote0In1(amt0, sqrtP);
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
