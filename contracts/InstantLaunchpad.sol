// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// InstantLaunchpad — mintd.fun launchpad for Stablechain (chain 988)
///
/// Mechanics:
///   - Fixed 1B supply, immutable ERC-20: no owner, taxes, blacklist, limits.
///   - The entire supply goes into a single-sided token/USDT0 Uniswap V3
///     position (1% fee tier) in the launch transaction. Trading is live
///     immediately — no bonding curve, no migration.
///   - The position NFT is owned by this contract, which has NO code path to
///     withdraw liquidity. Locked forever, verifiable onchain.
///   - Pool fees are claimable any time by anyone: creator share (default
///     90%) to the creator, remainder to the platform. Creator share can
///     never be configured below 50%.
///
/// Stable-specific design (see docs.stable.xyz "USDT0 behavior on Stable"):
///   USDT0 is BOTH the native gas token (18 decimals) and an ERC-20
///   (6 decimals) on the same underlying balance. The canonical Uniswap v3
///   deployment on Stable disables wrapped-native flows (its WETH9 slot is a
///   revert-stub), so pools pair against the USDT0 ERC-20 interface.
///   This contract receives launch funds as native value (nice UX: no
///   approval needed to launch) and spends them via the ERC-20 interface —
///   valid because both interfaces share one balance.
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

contract InstantLaunchpad {
    // ---------------------------------------------------------------- config
    uint256 public constant SUPPLY = 1_000_000_000 ether; // fixed 1B per token
    uint24 public constant POOL_FEE = 10_000;             // 1% fee tier
    int24 public constant TICK_SPACING = 200;             // spacing for 1% tier
    int24 public constant MAX_TICK = 887_200;             // max tick, spacing-aligned
    uint256 public constant MIN_CREATOR_SHARE_BPS = 5_000;
    uint256 public constant NATIVE_TO_ERC20 = 1e12;       // 18-dec native -> 6-dec ERC-20

    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter02 public immutable swapRouter;
    IERC20 public immutable usdt0; // USDT0 ERC-20 interface (6 decimals)
    IERC20 public immutable mintr; // optional MINTR pair asset (18 dec); zero disables MINTR launches

    address public owner;
    address public feeRecipient;      // platform fee destination
    uint256 public creationFee;       // flat, native USDT0 (18 dec)
    uint256 public creatorShareBps;   // creator share of pool fees (default 9000)
    uint256 public startPriceUsdt1e18; // USDT0-backed launch price, USDT0 per token, 1e18-scaled
    uint256 public startPriceMintr1e18; // MINTR-backed launch price, MINTR per token, 1e18-scaled

    // ----------------------------------------------------------------- state
    struct Launch {
        address token;
        address creator;
        address pool;
        address quote;                   // pair asset: usdt0 or mintr
        uint256 positionId;
        uint64 createdAt;
        uint256 creatorFeesClaimedQuote; // cumulative, quote-asset units
        uint256 creatorFeesClaimedToken; // cumulative, token units (18 dec)
    }

    mapping(address => Launch) public launches;
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
    event FeesClaimed(
        address indexed token,
        address indexed caller,
        uint256 creatorUsdt,
        uint256 creatorToken,
        uint256 platformUsdt,
        uint256 platformToken
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
        address _usdt0,
        address _feeRecipient,
        uint256 _creationFee,
        uint256 _creatorShareBps,
        uint256 _startPriceUsdt1e18,
        address _mintr,
        uint256 _startPriceMintr1e18
    ) {
        require(
            _positionManager != address(0) && _swapRouter != address(0) && _usdt0 != address(0)
                && _feeRecipient != address(0),
            "zero addr"
        );
        require(_creatorShareBps >= MIN_CREATOR_SHARE_BPS && _creatorShareBps <= 10_000, "bad share");
        require(_startPriceUsdt1e18 > 0, "bad price");
        require(IERC20(_usdt0).decimals() == 6, "usdt0 not 6 dec");
        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);
        usdt0 = IERC20(_usdt0);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        creationFee = _creationFee;
        creatorShareBps = _creatorShareBps;
        startPriceUsdt1e18 = _startPriceUsdt1e18;

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
    /// USDT0, live for trading immediately. Any value beyond the creation fee
    /// is spent on an immediate first buy for the caller (dev buy).
    function launch(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokensOut
    ) external payable lock returns (address token) {
        require(msg.value >= creationFee, "creation fee");

        token = address(new MemeToken20(name_, symbol_, metadataURI_, SUPPLY, address(this)));

        // USDT0 has 6 decimals vs the token's 18, a 1e12 gap, so the price
        // denominator is 1e18 (price scale) * 1e12 (decimal gap) = 1e30.
        (address pool, uint256 positionId) = _openMarket(token, address(usdt0), startPriceUsdt1e18, 1e30);

        emit TokenLaunched(token, msg.sender, pool, positionId, name_, symbol_, metadataURI_);

        if (creationFee > 0) _sendValue(feeRecipient, creationFee);

        // Optional dev buy with leftover value. The native value received
        // above is the same balance as this contract's USDT0 ERC-20 balance,
        // so it is spent through the ERC-20 swap path (6 decimals).
        uint256 buyValue = msg.value - creationFee;
        if (buyValue > 0) {
            uint256 amountIn = buyValue / NATIVE_TO_ERC20;
            uint256 erc20Bal = usdt0.balanceOf(address(this));
            if (amountIn > erc20Bal) amountIn = erc20Bal; // fractional reconciliation guard
            require(amountIn > 0, "dev buy too small");
            usdt0.approve(address(swapRouter), amountIn);
            swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(usdt0),
                    tokenOut: token,
                    fee: POOL_FEE,
                    recipient: msg.sender,
                    amountIn: amountIn,
                    amountOutMinimum: minTokensOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            require(minTokensOut == 0, "no buy value");
        }
    }

    /// @notice Launch a token paired against MINTR instead of USDT0. The entire
    /// supply goes into a locked single-sided token/MINTR position, so buyers
    /// trade the token with MINTR. This never mints MINTR — it only creates a
    /// pool — so MINTR's 1:1 backing is completely untouched. An optional dev
    /// buy is funded by MINTR the creator has already bought (and therefore
    /// already backed); the creator must approve `mintrDevBuy` to this contract
    /// first. The flat creation fee is still paid in native USDT0.
    function launchBackedByMintr(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 mintrDevBuy,
        uint256 minTokensOut
    ) external payable lock returns (address token) {
        require(address(mintr) != address(0), "mintr disabled");
        require(msg.value == creationFee, "send exact fee"); // no native buy path here

        token = address(new MemeToken20(name_, symbol_, metadataURI_, SUPPLY, address(this)));

        // MINTR is 18 decimals like the token, so no decimal gap: denominator
        // is just the 1e18 price scale.
        (address pool, uint256 positionId) = _openMarket(token, address(mintr), startPriceMintr1e18, 1e18);

        emit TokenLaunched(token, msg.sender, pool, positionId, name_, symbol_, metadataURI_);

        if (creationFee > 0) _sendValue(feeRecipient, creationFee);

        if (mintrDevBuy > 0) {
            require(mintr.transferFrom(msg.sender, address(this), mintrDevBuy), "mintr in");
            mintr.approve(address(swapRouter), mintrDevBuy);
            swapRouter.exactInputSingle(
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
        (, int24 tick,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
        int24 floorTick = _floorToSpacing(tick);

        (int24 tickLower, int24 tickUpper) =
            tokenIs0 ? (floorTick + TICK_SPACING, MAX_TICK) : (-MAX_TICK, floorTick);

        MemeToken20(token).approve(address(positionManager), SUPPLY);
        (positionId,,,) = positionManager.mint(
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
        allTokens.push(token);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Collect accrued pool fees for a token and pay them out:
    /// creator share to the creator, remainder to the platform. Callable by
    /// anyone — payouts always go to the same places. USDT0 fees are paid via
    /// the USDT0 ERC-20 interface (which moves the same underlying balance as
    /// native USDT0); token fees as the token itself.
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

        uint256 creatorQuote = (quoteAmt * creatorShareBps) / 10_000;
        uint256 creatorToken = (tokenAmt * creatorShareBps) / 10_000;

        if (creatorQuote > 0) require(quote.transfer(l.creator, creatorQuote), "quote xfer");
        if (quoteAmt - creatorQuote > 0) require(quote.transfer(feeRecipient, quoteAmt - creatorQuote), "quote xfer");
        if (creatorToken > 0) MemeToken20(token).transfer(l.creator, creatorToken);
        if (tokenAmt - creatorToken > 0) MemeToken20(token).transfer(feeRecipient, tokenAmt - creatorToken);

        l.creatorFeesClaimedQuote += creatorQuote;
        l.creatorFeesClaimedToken += creatorToken;

        emit FeesClaimed(token, msg.sender, creatorQuote, creatorToken, quoteAmt - creatorQuote, tokenAmt - creatorToken);
    }

    // ----------------------------------------------------------------- views

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    // ----------------------------------------------------------------- admin
    // NOTE: there is deliberately no function that touches the position NFTs
    // or removes liquidity. Admin scope is fees/config for future launches.

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "zero addr");
        feeRecipient = _feeRecipient;
    }

    function setConfig(uint256 _creationFee, uint256 _creatorShareBps, uint256 _startPriceUsdt1e18)
        external
        onlyOwner
    {
        require(_creatorShareBps >= MIN_CREATOR_SHARE_BPS && _creatorShareBps <= 10_000, "bad share");
        require(_startPriceUsdt1e18 > 0, "bad price");
        creationFee = _creationFee;
        creatorShareBps = _creatorShareBps;
        startPriceUsdt1e18 = _startPriceUsdt1e18;
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
        require(to != address(0), "zero addr"); // zero-address sends revert on Stable
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    receive() external payable {}
}
