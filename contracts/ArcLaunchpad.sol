// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// ArcLaunchpad — mintd launchpad for Arc (chain 5042002), quoted in USDC
///
/// Differences from InstantLaunchpad (the Stable deployment), all deliberate:
///   1. Dev buy is capped at 5% of supply. Enforced on tokens received, so it
///      cannot drift with the price math.
///   2. Pool fees split 70/30 creator/protocol, not 90/10.
///   3. The protocol's 30% is split again on chain, 80% to a buyback address
///      and 20% to operations, so the published tokenomics is readable from
///      the contract instead of taken on trust.
///
/// Unchanged from v1:
///   - Fixed 1B supply, immutable ERC-20: no owner, taxes, blacklist, limits.
///   - The entire supply goes into a single-sided token/USDC Uniswap V3
///     position (1% fee tier) in the launch transaction. Trading is live
///     immediately; no bonding curve, no migration.
///   - The position NFT is owned by this contract, which has NO code path to
///     withdraw liquidity. Locked forever, verifiable onchain.
///
/// Arc-specific: USDC is BOTH the native gas token (18 decimals) and an ERC-20
/// (6 decimals) over one balance, the same dual-decimal arrangement USDT0 has
/// on Stable. Launch funds arrive as native value (no approval needed) and are
/// spent through the ERC-20 interface. The ratio is exactly 1e12; mixing the
/// two is a 1,000,000x error.
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

/// @dev Uniswap's 512-bit multiply-then-divide. Needed because the dev-buy
/// quote multiplies liquidity by a sqrt price, which reaches 2^288 for extreme
/// positions and would silently revert a view the frontend depends on.
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

contract ArcLaunchpad {
    // ---------------------------------------------------------------- config
    uint256 public constant SUPPLY = 1_000_000_000 ether; // fixed 1B per token
    uint24 public constant POOL_FEE = 10_000;             // 1% fee tier
    int24 public constant TICK_SPACING = 200;             // spacing for 1% tier
    int24 public constant MAX_TICK = 887_200;             // max tick, spacing-aligned
    uint256 public constant MIN_CREATOR_SHARE_BPS = 5_000;
    uint256 public constant NATIVE_TO_ERC20 = 1e12;       // 18-dec native -> 6-dec ERC-20

    /// @notice Largest share of supply a creator may buy in the launch
    /// transaction. This bounds the launch tx only: nothing on chain stops a
    /// creator buying more in the next block or from another wallet.
    uint256 public constant MAX_DEV_BUY_BPS = 500;        // 5%
    uint256 public constant MAX_DEV_BUY_TOKENS = (SUPPLY * MAX_DEV_BUY_BPS) / 10_000;

    uint256 private constant Q96 = 0x1000000000000000000000000;
    // sqrtRatioAtTick(+/- 887200), the fixed outer edge of every launch
    // position. Lets maxDevBuyQuote reconstruct the curve from liquidity alone
    // instead of importing TickMath.
    uint256 private constant SQRT_RATIO_MAX_TICK = 1456195216270955103206513029158776779468408838535;
    uint256 private constant SQRT_RATIO_MIN_TICK = 4310618292;

    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter02 public immutable swapRouter;
    IERC20 public immutable usdc;  // USDC ERC-20 interface (6 decimals)
    IERC20 public immutable mintr; // optional MINTR pair asset (18 dec); zero disables MINTR launches

    address public owner;
    address public buybackRecipient;  // protocol fees earmarked for MINTD buybacks
    address public opsRecipient;      // protocol fees earmarked for infrastructure and team
    uint256 public creationFee;       // flat, native USDC (18 dec)
    uint256 public creatorShareBps;   // creator share of pool fees (default 7000)
    uint256 public buybackShareBps;   // buyback share of the PROTOCOL remainder (default 8000)
    uint256 public startPriceUsdc1e18;  // USDC-backed launch price, USDC per token, 1e18-scaled
    uint256 public startPriceMintr1e18; // MINTR-backed launch price, MINTR per token, 1e18-scaled

    // ----------------------------------------------------------------- state
    struct Launch {
        address token;
        address creator;
        address pool;
        address quote;                   // pair asset: usdc or mintr
        uint256 positionId;
        uint64 createdAt;
        uint256 creatorFeesClaimedQuote; // cumulative, quote-asset units
        uint256 creatorFeesClaimedToken; // cumulative, token units (18 dec)
    }

    mapping(address => Launch) public launches;
    // Kept out of the Launch struct on purpose: the frontend and
    // stats-indexer.js share one launchpad ABI across Stable and Arc, and
    // would misdecode launches() if its return tuple grew.
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
        address _positionManager,
        address _swapRouter,
        address _usdc,
        address _buybackRecipient,
        address _opsRecipient,
        uint256 _creationFee,
        uint256 _creatorShareBps,
        uint256 _buybackShareBps,
        uint256 _startPriceUsdc1e18,
        address _mintr,
        uint256 _startPriceMintr1e18
    ) {
        require(
            _positionManager != address(0) && _swapRouter != address(0) && _usdc != address(0)
                && _buybackRecipient != address(0) && _opsRecipient != address(0),
            "zero addr"
        );
        require(_creatorShareBps >= MIN_CREATOR_SHARE_BPS && _creatorShareBps <= 10_000, "bad share");
        require(_buybackShareBps <= 10_000, "bad buyback share");
        require(_startPriceUsdc1e18 > 0, "bad price");
        require(IERC20(_usdc).decimals() == 6, "usdc not 6 dec");
        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);
        usdc = IERC20(_usdc);
        owner = msg.sender;
        buybackRecipient = _buybackRecipient;
        opsRecipient = _opsRecipient;
        creationFee = _creationFee;
        creatorShareBps = _creatorShareBps;
        buybackShareBps = _buybackShareBps;
        startPriceUsdc1e18 = _startPriceUsdc1e18;

        // Optional MINTR-backed launches. Zero address leaves them disabled.
        if (_mintr != address(0)) {
            require(IERC20(_mintr).decimals() == 18, "mintr not 18 dec");
            require(_startPriceMintr1e18 > 0, "bad mintr price");
            mintr = IERC20(_mintr);
            startPriceMintr1e18 = _startPriceMintr1e18;
        }
    }

    // ---------------------------------------------------------------- launch

    /// @notice Launch a token: deploys a fixed 1B-supply ERC-20 and puts the
    /// entire supply into a locked single-sided Uniswap V3 position against
    /// USDC, live for trading immediately. Any value beyond the creation fee is
    /// spent on an immediate first buy for the caller (dev buy), which may not
    /// exceed MAX_DEV_BUY_BPS of supply.
    ///
    /// Overshooting the cap reverts rather than being clamped. Clamping would
    /// need a refund path, and a refund path is somewhere the contract can pay
    /// out more than it took in. Call maxDevBuyQuote off a simulated launch, or
    /// previewDevBuyCap, to size the value correctly.
    function launch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokensOut
    ) external payable returns (address) {
        return launchWithSalt(name_, symbol_, metadataURI_, minTokensOut, _autoSalt());
    }

    /// @notice As `launch`, with an explicit salt controlling the token address.
    /// Only needed if a launch reverted with "pool pre-initialized", which means
    /// somebody created the pool for that address first. Retry with any other
    /// salt.
    function launchWithSalt(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokensOut,
        bytes32 salt
    ) public payable lock returns (address token) {
        require(msg.value >= creationFee, "creation fee");

        token = _deployToken(name_, symbol_, metadataURI_, salt);

        // USDC has 6 decimals vs the token's 18, a 1e12 gap, so the price
        // denominator is 1e18 (price scale) * 1e12 (decimal gap) = 1e30.
        (address pool, uint256 positionId) = _openMarket(token, address(usdc), startPriceUsdc1e18, 1e30);

        emit TokenLaunched(token, msg.sender, pool, positionId, name_, symbol_, metadataURI_);

        if (creationFee > 0) _sendValue(opsRecipient, creationFee);

        // Optional dev buy with leftover value. The native value received above
        // is the same balance as this contract's USDC ERC-20 balance, so it is
        // spent through the ERC-20 swap path (6 decimals).
        uint256 buyValue = msg.value - creationFee;
        if (buyValue > 0) {
            uint256 amountIn = buyValue / NATIVE_TO_ERC20;
            uint256 erc20Bal = usdc.balanceOf(address(this));
            if (amountIn > erc20Bal) amountIn = erc20Bal; // fractional reconciliation guard
            require(amountIn > 0, "dev buy too small");
            usdc.approve(address(swapRouter), amountIn);
            uint256 out = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(usdc),
                    tokenOut: token,
                    fee: POOL_FEE,
                    recipient: msg.sender,
                    amountIn: amountIn,
                    amountOutMinimum: minTokensOut,
                    sqrtPriceLimitX96: 0
                })
            );
            // Checked on tokens received, not on USDC spent. The USDC figure is
            // derived from the curve and could drift; this cannot.
            require(out <= MAX_DEV_BUY_TOKENS, "dev buy exceeds 5%");
            emit DevBuy(token, msg.sender, amountIn, out);
        } else {
            require(minTokensOut == 0, "no buy value");
        }
    }

    /// @notice Launch a token paired against MINTR instead of USDC. The entire
    /// supply goes into a locked single-sided token/MINTR position, so buyers
    /// trade the token with MINTR. This never mints MINTR — it only creates a
    /// pool — so MINTR's 1:1 backing is completely untouched. An optional dev
    /// buy is funded by MINTR the creator has already bought (and therefore
    /// already backed); the creator must approve `mintrDevBuy` to this contract
    /// first, and the same 5% cap applies. The flat creation fee is still paid
    /// in native USDC.
    function launchBackedByMintr(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 mintrDevBuy,
        uint256 minTokensOut
    ) external payable lock returns (address token) {
        require(address(mintr) != address(0), "mintr disabled");
        require(msg.value == creationFee, "send exact fee"); // no native buy path here

        token = _deployToken(name_, symbol_, metadataURI_, _autoSalt());

        // MINTR is 18 decimals like the token, so no decimal gap: denominator
        // is just the 1e18 price scale.
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
            require(out <= MAX_DEV_BUY_TOKENS, "dev buy exceeds 5%");
            emit DevBuy(token, msg.sender, mintrDevBuy, out);
        } else {
            require(minTokensOut == 0, "no buy value");
        }
    }

    /// @dev Creates the pool, puts the whole token supply into a locked
    /// single-sided position against `quote`, records the launch, and returns
    /// the pool and position id. `startPrice1e18` is quote-per-token (1e18);
    /// `scale` is the price denominator (1e30 for a 6-dec quote, 1e18 for 18).
    function _openMarket(address token, address quote, uint256 startPrice1e18, uint256 scale)
        internal
        returns (address pool, uint256 positionId)
    {
        (address token0, address token1) = token < quote ? (token, quote) : (quote, token);
        bool tokenIs0 = token0 == token;

        uint160 sqrtPriceX96 =
            tokenIs0 ? _sqrtRatioX96(startPrice1e18, scale) : _sqrtRatioX96(scale, startPrice1e18);

        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, sqrtPriceX96);

        // createAndInitializePoolIfNecessary leaves an ALREADY-initialized pool's
        // price untouched, and the entire 1B supply is then anchored to whatever
        // tick it finds there. Since the token address is a pure function of the
        // launchpad and the salt, a stranger could create the pool first at a
        // price of their choosing and take the whole supply for pennies.
        // Measured in scripts/test-launch-frontrun.js before this check existed:
        // $50 bought 100% of supply.
        //
        // A fresh initialize sets slot0 to exactly sqrtPriceX96, so equality
        // proves this call set the price rather than someone else.
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

    /// @notice Collect accrued pool fees for a token and pay them out: creator
    /// share to the creator, then the protocol remainder split between the
    /// buyback address and operations. Callable by anyone — payouts always go
    /// to the same three places.
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
        uint256 quoteAmt = tokenIs0 ? amount1 : amount0; // quote-asset units

        // Each remainder is computed by subtraction, never independently, so
        // the three payouts sum to exactly what was collected no matter how the
        // division rounds.
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

    /// @notice The address `launchWithSalt` would deploy for these arguments.
    ///
    /// Exposed because CREATE2 addresses cannot be predicted off chain without
    /// the exact creation-code hash, and that hash is NOT reproducible from a
    /// build artifact: solc appends a metadata hash derived from the source
    /// file, so a MemeToken20 compiled inside this file differs byte-for-byte
    /// from one compiled inside InstantLaunchpad.sol despite identical source.
    /// Deriving it here is the only way to get it right.
    ///
    /// Use it to check whether a salt is already poisoned: if the token/quote
    /// pool for this address exists and is initialized, the launch will revert
    /// with "pool pre-initialized" and a different salt is needed.
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

    /// @notice Quote-asset cost of buying exactly MAX_DEV_BUY_BPS of supply on
    /// this token's curve, in the quote asset's own units (6-dec for USDC,
    /// 18-dec for MINTR).
    ///
    /// ADVISORY ONLY. The cap is enforced on tokens received in launch(), not
    /// on this number. A wrong value here is a wrong frontend hint, never a
    /// fund loss.
    function maxDevBuyQuote(address token) external view returns (uint256) {
        Launch storage l = launches[token];
        require(l.token != address(0), "unknown token");
        return previewDevBuyCap(launchLiquidity[token], token < l.quote);
    }

    /// @notice Same calculation for a position that has not been created yet,
    /// so a frontend can size the input box before the launch exists.
    ///
    /// A single-sided position always runs from its live edge to the outer
    /// tick, and that outer tick is fixed, so liquidity alone determines the
    /// whole curve. Buying `MAX_DEV_BUY_TOKENS` moves the price from the edge
    /// to a point derived below; the quote paid is the area between them.
    function previewDevBuyCap(uint128 liquidity, bool tokenIs0) public pure returns (uint256) {
        uint256 L = uint256(liquidity);
        if (L == 0) return 0;
        uint256 target = MAX_DEV_BUY_TOKENS;

        if (tokenIs0) {
            // Position is [edge, MAX_TICK]; buying the token raises the price.
            // Work in 1/sqrt(P), where token amounts are linear.
            uint256 invEdge = SUPPLY + FullMath.mulDiv(L, Q96, SQRT_RATIO_MAX_TICK);
            require(invEdge > target, "cap exceeds position");
            uint256 sqrtEdge = FullMath.mulDiv(L, Q96, invEdge);
            uint256 sqrtEnd = FullMath.mulDiv(L, Q96, invEdge - target);
            return FullMath.mulDivRoundingUp(L, sqrtEnd - sqrtEdge, Q96);
        } else {
            // Position is [MIN_TICK, edge]; buying the token lowers the price.
            // Here token amounts are linear in sqrt(P) directly.
            uint256 sqrtEdge = SQRT_RATIO_MIN_TICK + FullMath.mulDiv(SUPPLY, Q96, L);
            uint256 drop = FullMath.mulDiv(target, Q96, L);
            require(sqrtEdge > drop, "cap exceeds position");
            uint256 sqrtEnd = sqrtEdge - drop;
            return FullMath.mulDivRoundingUp(L, Q96, sqrtEnd) - FullMath.mulDiv(L, Q96, sqrtEdge);
        }
    }

    // ----------------------------------------------------------------- admin
    // NOTE: there is deliberately no function that touches the position NFTs
    // or removes liquidity. Admin scope is fees/config for future launches.

    function setFeeRecipients(address _buybackRecipient, address _opsRecipient) external onlyOwner {
        require(_buybackRecipient != address(0) && _opsRecipient != address(0), "zero addr");
        buybackRecipient = _buybackRecipient;
        opsRecipient = _opsRecipient;
    }

    function setConfig(
        uint256 _creationFee,
        uint256 _creatorShareBps,
        uint256 _buybackShareBps,
        uint256 _startPriceUsdc1e18
    ) external onlyOwner {
        require(_creatorShareBps >= MIN_CREATOR_SHARE_BPS && _creatorShareBps <= 10_000, "bad share");
        require(_buybackShareBps <= 10_000, "bad buyback share");
        require(_startPriceUsdc1e18 > 0, "bad price");
        creationFee = _creationFee;
        creatorShareBps = _creatorShareBps;
        buybackShareBps = _buybackShareBps;
        startPriceUsdc1e18 = _startPriceUsdc1e18;
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
    /// contract, and it is public knowledge, so one pre-created pool would make
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
    /// front-run is still possible; the answer to that is to retry, which
    /// lands on a different salt.
    function _autoSalt() private view returns (bytes32) {
        return keccak256(abi.encode(msg.sender, allTokens.length, block.prevrandao));
    }

    /// @dev sqrt(num/den) in Q96: sqrt((num << 96) / den) << 48.
    /// Avoids the overflow of (num << 192) for large numerators.
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

    /// @dev Babylonian square root.
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
