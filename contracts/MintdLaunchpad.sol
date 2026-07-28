// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// MintdLaunchpad — the launchpad, generalised for any chain whose gas token is
/// also its quote asset.
///
/// This exists to replace `InstantLaunchpad` on Stable, which is immutable and
/// lets a stranger choose someone else's launch price. See
/// docs/plans/stable-launchpad-migration.md. It carries the same two fixes that
/// `ArcLaunchpad` shipped with:
///
///   1. The pool's price is asserted to be the one this call set, so an
///      already-initialized pool cannot silently anchor the whole supply at an
///      attacker's price. Measured before the fix: $50 bought 100% of supply.
///   2. Tokens deploy via CREATE2, so a poisoned address can be stepped over.
///      Without this, fix 1 turns the attack into a permanent brick: a reverted
///      launch rolls the nonce back and every retry targets the same address.
///
/// Differences from ArcLaunchpad, which is frozen as deployed source on Arc:
///   - The quote asset is named neutrally rather than USDC.
///   - The decimal gap is derived from the quote token instead of assuming 6.
///   - The dev-buy cap is an immutable constructor parameter, not a hardcoded
///     5%. Pass 10000 to disable it: the check becomes "no more than the whole
///     supply", which is unreachable.
///
/// Unchanged: fixed 1B supply, immutable ERC-20 with no owner or taxes, whole
/// supply into a single-sided Uniswap V3 position at launch, and a position NFT
/// this contract owns with NO code path to withdraw liquidity.
///
/// Dual-decimal quote assets: USDT0 on Stable and USDC on Arc are both the
/// native gas token (18 decimals) and an ERC-20 (6 decimals) over one balance.
/// Launch funds arrive as native value and are spent through the ERC-20
/// interface. Mixing the two is a 1,000,000x error.
/// ----------------------------------------------------------------------------

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function decimals() external view returns (uint8);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3PoolMinimal {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
}

/// @dev Uniswap's 512-bit multiply-then-divide. The dev-buy quote multiplies
/// liquidity by a sqrt price, which reaches 2^288 for extreme positions and
/// would otherwise revert a view the frontend depends on.
library FullMath {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0, "mulDiv: den 0");
                return prod0 / denominator;
            }
            require(denominator > prod1, "mulDiv: overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = (0 - denominator) & denominator;
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
        }
    }

    function mulDivRoundingUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        result = mulDiv(a, b, denominator);
        if (mulmod(a, b, denominator) > 0) {
            require(result < type(uint256).max, "mulDiv: round overflow");
            result++;
        }
    }
}

/// @notice Minimal fixed-supply ERC-20. Entire supply is minted to the
/// launchpad at creation; no owner, no mint, no blacklist, no taxes.
contract MemeToken20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;
    string public metadataURI;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, string memory _metadataURI, uint256 _supply, address _to) {
        name = _name;
        symbol = _symbol;
        metadataURI = _metadataURI;
        totalSupply = _supply;
        balanceOf[_to] = _supply;
        emit Transfer(address(0), _to, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ERC20: allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(to != address(0), "ERC20: zero to");
        uint256 bal = balanceOf[from];
        require(bal >= value, "ERC20: balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}

contract MintdLaunchpad {
    // ---------------------------------------------------------------- config
    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint24 public constant POOL_FEE = 10_000;             // 1% fee tier
    int24 public constant TICK_SPACING = 200;
    int24 public constant MAX_TICK = 887_200;             // spacing-aligned
    uint256 public constant MIN_CREATOR_SHARE_BPS = 5_000;

    uint256 private constant Q96 = 0x1000000000000000000000000;
    // sqrtRatioAtTick(+/- 887200), the fixed outer edge of every launch
    // position. Lets the dev-buy quote reconstruct the curve from liquidity
    // alone instead of importing TickMath.
    uint256 private constant SQRT_RATIO_MAX_TICK = 1456195216270955103206513029158776779468408838535;
    uint256 private constant SQRT_RATIO_MIN_TICK = 4310618292;

    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter02 public immutable swapRouter;
    /// @notice The pair asset, which is also this chain's gas token.
    IERC20 public immutable quoteToken;
    IERC20 public immutable mintr; // optional; zero disables MINTR launches

    /// @notice 18-dec native value divided by this gives quote ERC-20 units.
    uint256 public immutable nativeToErc20;
    /// @dev Price denominator: 1e18 price scale times the 18/quote decimal gap.
    uint256 private immutable quoteScale;

    /// @notice Largest share of supply a creator may buy in the launch
    /// transaction, in basis points. 10000 disables the cap.
    ///
    /// This bounds only the swap `launch` itself performs. A creator can buy
    /// more in the next transaction, from another wallet, or from a contract in
    /// the SAME transaction, because the reentrancy lock is released before
    /// launch returns. It is a guardrail, not a guarantee, and must never be
    /// described as one.
    uint256 public immutable devBuyCapBps;
    uint256 public immutable maxDevBuyTokens;

    address public owner;
    address public buybackRecipient;
    address public opsRecipient;
    uint256 public creationFee;         // flat, native units (18 dec)
    uint256 public creatorShareBps;
    uint256 public buybackShareBps;     // share of the PROTOCOL remainder
    uint256 public startPriceQuote1e18; // quote per token, 1e18-scaled
    uint256 public startPriceMintr1e18;

    // ----------------------------------------------------------------- state
    struct Launch {
        address token;
        address creator;
        address pool;
        address quote;
        uint256 positionId;
        uint64 createdAt;
        uint256 creatorFeesClaimedQuote;
        uint256 creatorFeesClaimedToken;
    }

    mapping(address => Launch) public launches;
    // Deliberately outside the struct: the frontend and stats-indexer share one
    // launchpad ABI across chains and would misdecode launches() if its return
    // tuple grew.
    mapping(address => uint128) public launchLiquidity;
    address[] public allTokens;

    uint256 private unlocked = 1;

    // ---------------------------------------------------------------- events
    event TokenLaunched(
        address indexed token,
        address indexed creator,
        address pool,
        uint256 positionId,
        string name,
        string symbol,
        string metadataURI
    );
    event DevBuy(address indexed token, address indexed creator, uint256 quoteIn, uint256 tokensOut);
    event FeesClaimed(
        address indexed token,
        address indexed caller,
        uint256 creatorQuote,
        uint256 creatorToken,
        uint256 buybackQuote,
        uint256 buybackToken,
        uint256 opsQuote,
        uint256 opsToken
    );

    modifier lock() {
        require(unlocked == 1, "reentrancy");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(
        address _owner,
        address _positionManager,
        address _swapRouter,
        address _quoteToken,
        address _buybackRecipient,
        address _opsRecipient,
        uint256 _creationFee,
        uint256 _creatorShareBps,
        uint256 _buybackShareBps,
        uint256 _devBuyCapBps,
        uint256 _startPriceQuote1e18,
        address _mintr,
        uint256 _startPriceMintr1e18
    ) {
        require(
            _owner != address(0) && _positionManager != address(0) && _swapRouter != address(0)
                && _quoteToken != address(0) && _buybackRecipient != address(0) && _opsRecipient != address(0),
            "zero addr"
        );
        require(_creatorShareBps >= MIN_CREATOR_SHARE_BPS && _creatorShareBps <= 10_000, "bad share");
        require(_buybackShareBps <= 10_000, "bad buyback share");
        require(_devBuyCapBps > 0 && _devBuyCapBps <= 10_000, "bad dev cap");
        require(_startPriceQuote1e18 > 0, "bad price");

        uint8 qd = IERC20(_quoteToken).decimals();
        require(qd <= 18, "quote decimals");
        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);
        quoteToken = IERC20(_quoteToken);
        nativeToErc20 = 10 ** (18 - qd);
        quoteScale = 1e18 * (10 ** (18 - qd));

        // Owner is a constructor argument, not msg.sender. Handing ownership
        // over in a second transaction leaves a window between deploy and
        // transfer where anyone else holding the deploying key can capture an
        // immutable contract's admin permanently. The Safe cannot deploy, so
        // that key is a hot key by necessity; passing the Safe here removes the
        // window entirely and makes the deploying key irrelevant.
        owner = _owner;
        buybackRecipient = _buybackRecipient;
        opsRecipient = _opsRecipient;
        creationFee = _creationFee;
        creatorShareBps = _creatorShareBps;
        buybackShareBps = _buybackShareBps;
        devBuyCapBps = _devBuyCapBps;
        maxDevBuyTokens = (SUPPLY * _devBuyCapBps) / 10_000;
        startPriceQuote1e18 = _startPriceQuote1e18;

        if (_mintr != address(0)) {
            require(IERC20(_mintr).decimals() == 18, "mintr not 18 dec");
            require(_startPriceMintr1e18 > 0, "bad mintr price");
            mintr = IERC20(_mintr);
            startPriceMintr1e18 = _startPriceMintr1e18;
        }
    }

    // ---------------------------------------------------------------- launch

    /// @notice Launch a token. The whole supply goes into a locked single-sided
    /// Uniswap V3 position against the quote asset, live immediately. Value
    /// beyond the creation fee buys tokens for the caller, capped at
    /// `devBuyCapBps` of supply.
    ///
    /// Overshooting reverts rather than being clamped: clamping needs a refund
    /// path, and a refund path is somewhere the contract can pay out more than
    /// it took in. Size it with `maxDevBuyQuote`, remembering that view returns
    /// 6-decimal quote units while msg.value is 18-decimal native — multiply by
    /// `nativeToErc20`.
    function launch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokensOut
    ) external payable returns (address) {
        return launchWithSalt(name_, symbol_, metadataURI_, minTokensOut, _autoSalt());
    }

    /// @notice As `launch`, with an explicit salt controlling the token address.
    /// Only needed if a launch reverted with "pool pre-initialized", meaning
    /// somebody created that pool first. Retry with any other salt.
    function launchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokensOut,
        bytes32 salt
    ) public payable lock returns (address token) {
        require(msg.value >= creationFee, "creation fee");

        token = _deployToken(name_, symbol_, metadataURI_, salt);
        (address pool, uint256 positionId) =
            _openMarket(token, address(quoteToken), startPriceQuote1e18, quoteScale);

        emit TokenLaunched(token, msg.sender, pool, positionId, name_, symbol_, metadataURI_);

        if (creationFee > 0) _sendValue(opsRecipient, creationFee);

        uint256 buyValue = msg.value - creationFee;
        if (buyValue > 0) {
            uint256 amountIn = buyValue / nativeToErc20;
            uint256 erc20Bal = quoteToken.balanceOf(address(this));
            if (amountIn > erc20Bal) amountIn = erc20Bal; // fractional reconciliation guard
            require(amountIn > 0, "dev buy too small");
            quoteToken.approve(address(swapRouter), amountIn);
            uint256 out = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(quoteToken),
                    tokenOut: token,
                    fee: POOL_FEE,
                    recipient: msg.sender,
                    amountIn: amountIn,
                    amountOutMinimum: minTokensOut,
                    sqrtPriceLimitX96: 0
                })
            );
            // Checked on tokens received, not on quote spent. The quote figure
            // is derived from the curve and could drift; this cannot.
            require(out <= maxDevBuyTokens, "dev buy over cap");
            emit DevBuy(token, msg.sender, amountIn, out);
        } else {
            require(minTokensOut == 0, "no buy value");
        }
    }

    /// @notice Launch paired against MINTR instead of the quote asset. This
    /// never mints MINTR, only creates a pool, so MINTR's backing is untouched.
    /// The dev buy is funded by MINTR the creator already holds and must
    /// approve first; the same cap applies. The creation fee is still native.
    function launchBackedByMintr(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 mintrDevBuy,
        uint256 minTokensOut
    ) external payable lock returns (address token) {
        require(address(mintr) != address(0), "mintr disabled");
        require(msg.value == creationFee, "send exact fee");

        token = _deployToken(name_, symbol_, metadataURI_, _autoSalt());
        // MINTR is 18 decimals like the token, so no decimal gap.
        (address pool, uint256 positionId) = _openMarket(token, address(mintr), startPriceMintr1e18, 1e18);

        emit TokenLaunched(token, msg.sender, pool, positionId, name_, symbol_, metadataURI_);

        if (creationFee > 0) _sendValue(opsRecipient, creationFee);

        if (mintrDevBuy > 0) {
            require(mintr.transferFrom(msg.sender, address(this), mintrDevBuy), "mintr in");
            mintr.approve(address(swapRouter), mintrDevBuy);
            uint256 out = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(mintr),
                    tokenOut: token,
                    fee: POOL_FEE,
                    recipient: msg.sender,
                    amountIn: mintrDevBuy,
                    amountOutMinimum: minTokensOut,
                    sqrtPriceLimitX96: 0
                })
            );
            require(out <= maxDevBuyTokens, "dev buy over cap");
            emit DevBuy(token, msg.sender, mintrDevBuy, out);
        } else {
            require(minTokensOut == 0, "no buy value");
        }
    }

    function _openMarket(address token, address quote, uint256 startPrice1e18, uint256 scale)
        internal
        returns (address pool, uint256 positionId)
    {
        (address token0, address token1) = token < quote ? (token, quote) : (quote, token);
        bool tokenIs0 = token0 == token;

        uint160 sqrtPriceX96 =
            tokenIs0 ? _sqrtRatioX96(startPrice1e18, scale) : _sqrtRatioX96(scale, startPrice1e18);

        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, sqrtPriceX96);

        // THE FIX. createAndInitializePoolIfNecessary leaves an ALREADY
        // initialized pool's price untouched, and the entire supply would then
        // be anchored to whatever tick a stranger chose. A fresh initialize
        // sets slot0 to exactly sqrtPriceX96, so equality proves this call set
        // the price rather than somebody else.
        (uint160 actualSqrt, int24 tick,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
        require(actualSqrt == sqrtPriceX96, "pool pre-initialized");

        int24 floorTick = _floorToSpacing(tick);
        (int24 tickLower, int24 tickUpper) =
            tokenIs0 ? (floorTick + TICK_SPACING, MAX_TICK) : (-MAX_TICK, floorTick);

        MemeToken20(token).approve(address(positionManager), SUPPLY);
        uint128 liquidity;
        (positionId, liquidity,,) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: tokenIs0 ? SUPPLY : 0,
                amount1Desired: tokenIs0 ? 0 : SUPPLY,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        launches[token] = Launch({
            token: token,
            creator: msg.sender,
            pool: pool,
            quote: quote,
            positionId: positionId,
            createdAt: uint64(block.timestamp),
            creatorFeesClaimedQuote: 0,
            creatorFeesClaimedToken: 0
        });
        launchLiquidity[token] = liquidity;
        allTokens.push(token);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Collect pool fees and pay them out: creator share to the
    /// creator, then the protocol remainder split between buyback and ops.
    /// Callable by anyone; the destinations are fixed.
    ///
    /// For a simple two-way split, set both protocol recipients to the same
    /// address. That is how Stable runs 90/10 to a single treasury.
    function claimFees(address token) external lock {
        Launch storage l = launches[token];
        require(l.token != address(0), "unknown token");

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: l.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        IERC20 quote = IERC20(l.quote);
        bool tokenIs0 = token < l.quote;
        uint256 tokenAmt = tokenIs0 ? amount0 : amount1;
        uint256 quoteAmt = tokenIs0 ? amount1 : amount0;

        // Each remainder by subtraction, never independently, so the three
        // payouts sum to exactly what was collected however the division falls.
        uint256 creatorQuote = (quoteAmt * creatorShareBps) / 10_000;
        uint256 protocolQuote = quoteAmt - creatorQuote;
        uint256 buybackQuote = (protocolQuote * buybackShareBps) / 10_000;
        uint256 opsQuote = protocolQuote - buybackQuote;

        uint256 creatorToken = (tokenAmt * creatorShareBps) / 10_000;
        uint256 protocolToken = tokenAmt - creatorToken;
        uint256 buybackToken = (protocolToken * buybackShareBps) / 10_000;
        uint256 opsToken = protocolToken - buybackToken;

        if (creatorQuote > 0) require(quote.transfer(l.creator, creatorQuote), "quote xfer");
        if (buybackQuote > 0) require(quote.transfer(buybackRecipient, buybackQuote), "quote xfer");
        if (opsQuote > 0) require(quote.transfer(opsRecipient, opsQuote), "quote xfer");
        if (creatorToken > 0) MemeToken20(token).transfer(l.creator, creatorToken);
        if (buybackToken > 0) MemeToken20(token).transfer(buybackRecipient, buybackToken);
        if (opsToken > 0) MemeToken20(token).transfer(opsRecipient, opsToken);

        l.creatorFeesClaimedQuote += creatorQuote;
        l.creatorFeesClaimedToken += creatorToken;

        emit FeesClaimed(
            token, msg.sender, creatorQuote, creatorToken, buybackQuote, buybackToken, opsQuote, opsToken
        );
    }

    // ----------------------------------------------------------------- views

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Compatibility alias. The frontend shares one ABI across chains
    /// and probes for a USDT0-named getter on Stable.
    function usdt0() external view returns (address) {
        return address(quoteToken);
    }

    function startPriceUsdt1e18() external view returns (uint256) {
        return startPriceQuote1e18;
    }

    /// @notice Basis-point cap on the launch-transaction dev buy. Named to
    /// match ArcLaunchpad so one frontend reads both.
    function MAX_DEV_BUY_BPS() external view returns (uint256) {
        return devBuyCapBps;
    }

    function MAX_DEV_BUY_TOKENS() external view returns (uint256) {
        return maxDevBuyTokens;
    }

    /// @notice Quote-asset cost of buying exactly the cap on this token's
    /// curve, in the quote asset's own units.
    ///
    /// ADVISORY ONLY. The cap is enforced on tokens received in `launch`, not
    /// on this number, so a wrong value here is a wrong frontend hint and never
    /// a fund loss. Excludes the 1% pool fee, so spending exactly this buys
    /// slightly under the cap, which is the safe direction.
    function maxDevBuyQuote(address token) external view returns (uint256) {
        Launch storage l = launches[token];
        require(l.token != address(0), "unknown token");
        return previewDevBuyCap(launchLiquidity[token], token < l.quote);
    }

    /// @notice Same calculation for a position that does not exist yet.
    ///
    /// A single-sided position runs from its live edge to a fixed outer tick,
    /// so liquidity alone determines the whole curve.
    function previewDevBuyCap(uint128 liquidity, bool tokenIs0) public view returns (uint256) {
        uint256 L = uint256(liquidity);
        if (L == 0 || devBuyCapBps >= 10_000) return 0;
        uint256 target = maxDevBuyTokens;

        if (tokenIs0) {
            // [edge, MAX_TICK]; buying raises the price. Token amounts are
            // linear in 1/sqrt(P).
            uint256 invEdge = SUPPLY + FullMath.mulDiv(L, Q96, SQRT_RATIO_MAX_TICK);
            require(invEdge > target, "cap exceeds position");
            uint256 sqrtEdge = FullMath.mulDiv(L, Q96, invEdge);
            uint256 sqrtEnd = FullMath.mulDiv(L, Q96, invEdge - target);
            return FullMath.mulDivRoundingUp(L, sqrtEnd - sqrtEdge, Q96);
        } else {
            // [MIN_TICK, edge]; buying lowers the price, linear in sqrt(P).
            uint256 sqrtEdge = SQRT_RATIO_MIN_TICK + FullMath.mulDiv(SUPPLY, Q96, L);
            uint256 drop = FullMath.mulDiv(target, Q96, L);
            require(sqrtEdge > drop, "cap exceeds position");
            uint256 sqrtEnd = sqrtEdge - drop;
            return FullMath.mulDivRoundingUp(L, Q96, sqrtEnd) - FullMath.mulDiv(L, Q96, sqrtEdge);
        }
    }

    /// @notice The address `launchWithSalt` would deploy for these arguments.
    ///
    /// CREATE2 addresses cannot be predicted off chain without the exact
    /// creation-code hash, and that hash is NOT reproducible from a build
    /// artifact: solc appends a metadata hash derived from the source file, so
    /// a MemeToken20 compiled inside this file differs byte-for-byte from one
    /// compiled inside ArcLaunchpad.sol despite identical source. Deriving it
    /// here is the only way to get it right.
    function predictToken(
        address creator,
        bytes32 salt,
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_
    ) public view returns (address) {
        bytes32 initHash = keccak256(
            abi.encodePacked(
                type(MemeToken20).creationCode,
                abi.encode(name_, symbol_, metadataURI_, SUPPLY, address(this))
            )
        );
        bytes32 inner = keccak256(abi.encode(creator, salt));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), inner, initHash))))
        );
    }

    // ----------------------------------------------------------------- admin
    // There is deliberately no function that touches the position NFTs or
    // removes liquidity. Admin scope is fees and config for future launches.

    function setFeeRecipients(address _buybackRecipient, address _opsRecipient) external onlyOwner {
        require(_buybackRecipient != address(0) && _opsRecipient != address(0), "zero addr");
        buybackRecipient = _buybackRecipient;
        opsRecipient = _opsRecipient;
    }

    function setConfig(
        uint256 _creationFee,
        uint256 _creatorShareBps,
        uint256 _buybackShareBps,
        uint256 _startPriceQuote1e18
    ) external onlyOwner {
        require(_creatorShareBps >= MIN_CREATOR_SHARE_BPS && _creatorShareBps <= 10_000, "bad share");
        require(_buybackShareBps <= 10_000, "bad buyback share");
        require(_startPriceQuote1e18 > 0, "bad price");
        creationFee = _creationFee;
        creatorShareBps = _creatorShareBps;
        buybackShareBps = _buybackShareBps;
        startPriceQuote1e18 = _startPriceQuote1e18;
    }

    function setMintrStartPrice(uint256 _startPriceMintr1e18) external onlyOwner {
        require(address(mintr) != address(0), "mintr disabled");
        require(_startPriceMintr1e18 > 0, "bad price");
        startPriceMintr1e18 = _startPriceMintr1e18;
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "zero addr");
        owner = _owner;
    }

    // ------------------------------------------------------------------ util

    /// @dev CREATE2, not CREATE, so a poisoned token address can be stepped
    /// over. With plain CREATE there is exactly one next address for the whole
    /// contract and it is public knowledge, so one pre-created pool would make
    /// every future launch revert forever: the failed transaction rolls the
    /// nonce back and the next attempt targets the same poisoned address again.
    function _deployToken(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        bytes32 salt
    ) private returns (address) {
        return address(
            new MemeToken20{salt: keccak256(abi.encode(msg.sender, salt))}(
                name_, symbol_, metadataURI_, SUPPLY, address(this)
            )
        );
    }

    /// @dev prevrandao is not knowable before the block is proposed, so the
    /// default token address cannot be poisoned in advance. A same-block
    /// front-run remains possible; the answer is to retry, landing on a
    /// different salt.
    function _autoSalt() private view returns (bytes32) {
        // blockhash(block.number - 1), NOT block.prevrandao. Measured on Stable
        // and Arc: prevrandao is permanently zero on both, so it added no
        // entropy at all. That turned the default launch path back into the
        // permanent brick the CREATE2 change exists to prevent: a griefer
        // pre-poisons the predictable address, the launch reverts, and every
        // retry lands on the SAME salt and reverts again until an unrelated
        // launch bumps allTokens.length. The parent hash varies every 0.70s
        // block, so it cannot be precomputed before the block and a retry in
        // any later block lands on a different address.
        return keccak256(abi.encode(msg.sender, allTokens.length, blockhash(block.number - 1)));
    }

    /// @dev sqrt(num/den) in Q96, avoiding the overflow of (num << 192).
    function _sqrtRatioX96(uint256 num, uint256 den) internal pure returns (uint160) {
        uint256 r = _sqrt((num << 96) / den) << 48;
        require(r > 4295128739 && r < 1461446703485210103287273052203988822378723970342, "price out of range");
        return uint160(r);
    }

    function _floorToSpacing(int24 tick) internal pure returns (int24) {
        int24 spaced = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) spaced--;
        return spaced * TICK_SPACING;
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

    function _sendValue(address to, uint256 amount) internal {
        require(to != address(0), "zero addr");
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    receive() external payable {}
}
