// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// Stable Launchpad — pump.fun-style memecoin launchpad for Stablechain (988)
///
/// Native gas token on Stable is USDT0 (18 decimals as native value), so the
/// bonding curve is denominated directly in native USDT0 — no ERC-20 approvals
/// needed to buy. Tokens trade on a constant-product curve with virtual
/// reserves until the curve sells out, then liquidity auto-migrates to the
/// canonical Uniswap V2 deployment and LP tokens are burned.
/// ----------------------------------------------------------------------------

interface IUniswapV2Router02 {
    function WETH() external pure returns (address);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

/// @notice Minimal fixed-supply ERC-20. Entire supply is minted to the
/// launchpad at creation; there is no owner, no mint, no blacklist — nothing
/// a creator could use to rug post-graduation.
contract MemeToken {
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

contract StableLaunchpad {
    // ---------------------------------------------------------------- config
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B per token
    uint256 public constant CURVE_SUPPLY = 800_000_000 ether;   // sold on curve
    uint256 public constant LP_SUPPLY = 200_000_000 ether;      // paired at graduation
    uint256 public constant MAX_FEE_BPS = 500;                  // 5% cap
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IUniswapV2Router02 public immutable router;

    address public owner;
    address public feeRecipient;
    uint256 public creationFee;       // flat, in native USDT0 (18 dec)
    uint256 public tradeFeeBps;       // bps on trade value
    uint256 public graduationFee;     // flat, taken from raised USDT0 at graduation
    uint256 public virtualUsdtSeed;   // initial virtual USDT0 reserve
    uint256 public virtualTokenSeed;  // initial virtual token reserve

    // ----------------------------------------------------------------- state
    struct Curve {
        address token;
        address creator;
        uint256 virtualUsdt;   // current virtual USDT0 reserve
        uint256 virtualToken;  // current virtual token reserve
        uint256 realUsdt;      // net USDT0 held for this curve (excl. fees)
        uint256 tokensSold;
        bool soldOut;          // curve exhausted, trading frozen
        bool graduated;        // LP created on Uniswap V2
    }

    mapping(address => Curve) public curves;
    address[] public allTokens;

    uint256 private unlocked = 1;

    // ---------------------------------------------------------------- events
    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdtAmount, uint256 tokenAmount, uint256 newPriceUsdtPerToken1e18);
    event CurveSoldOut(address indexed token, uint256 raisedUsdt);
    event Graduated(address indexed token, uint256 usdtToLp, uint256 tokensToLp, uint256 liquidity);
    event GraduationFailed(address indexed token, bytes reason);

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
        address _router,
        address _feeRecipient,
        uint256 _creationFee,
        uint256 _tradeFeeBps,
        uint256 _graduationFee,
        uint256 _virtualUsdtSeed,
        uint256 _virtualTokenSeed
    ) {
        require(_router != address(0) && _feeRecipient != address(0), "zero addr");
        require(_tradeFeeBps <= MAX_FEE_BPS, "fee too high");
        require(_virtualUsdtSeed > 0 && _virtualTokenSeed > CURVE_SUPPLY, "bad seeds");
        router = IUniswapV2Router02(_router);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        creationFee = _creationFee;
        tradeFeeBps = _tradeFeeBps;
        graduationFee = _graduationFee;
        virtualUsdtSeed = _virtualUsdtSeed;
        virtualTokenSeed = _virtualTokenSeed;
    }

    // ---------------------------------------------------------------- create

    /// @notice Launch a new token. Any value beyond the creation fee is used
    /// as an immediate first buy for the creator (dev buy).
    function createToken(
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 minTokensOut
    ) external payable lock returns (address token) {
        require(msg.value >= creationFee, "creation fee");

        token = address(new MemeToken(name_, symbol_, metadataURI_, TOTAL_SUPPLY, address(this)));

        Curve storage c = curves[token];
        c.token = token;
        c.creator = msg.sender;
        c.virtualUsdt = virtualUsdtSeed;
        c.virtualToken = virtualTokenSeed;
        allTokens.push(token);

        emit TokenCreated(token, msg.sender, name_, symbol_, metadataURI_);

        if (creationFee > 0) _sendValue(feeRecipient, creationFee);

        uint256 buyValue = msg.value - creationFee;
        if (buyValue > 0) {
            _buy(c, buyValue, minTokensOut);
        } else {
            require(minTokensOut == 0, "no buy value");
        }
    }

    // ----------------------------------------------------------------- trade

    /// @notice Buy tokens with native USDT0. Excess value beyond what the
    /// curve can absorb is refunded.
    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable lock {
        require(block.timestamp <= deadline, "expired");
        Curve storage c = curves[token];
        require(c.token != address(0), "unknown token");
        require(msg.value > 0, "zero value");
        _buy(c, msg.value, minTokensOut);
    }

    function _buy(Curve storage c, uint256 value, uint256 minTokensOut) internal {
        require(!c.soldOut, "curve closed");

        uint256 remaining = CURVE_SUPPLY - c.tokensSold;

        // Split value into fee + input, then compute output on the curve.
        uint256 fee = (value * tradeFeeBps) / 10_000;
        uint256 usdtIn = value - fee;
        uint256 tokensOut = (c.virtualToken * usdtIn) / (c.virtualUsdt + usdtIn);

        if (tokensOut >= remaining) {
            // Final buy: cap at remaining, charge only what it costs.
            tokensOut = remaining;
            usdtIn = _ceilDiv(c.virtualUsdt * tokensOut, c.virtualToken - tokensOut);
            fee = (usdtIn * tradeFeeBps) / 10_000;
            require(usdtIn + fee <= value, "insufficient value");
        }
        require(tokensOut >= minTokensOut, "slippage");
        require(tokensOut > 0, "dust");

        c.virtualUsdt += usdtIn;
        c.virtualToken -= tokensOut;
        c.realUsdt += usdtIn;
        c.tokensSold += tokensOut;

        MemeToken(c.token).transfer(msg.sender, tokensOut);
        if (fee > 0) _sendValue(feeRecipient, fee);

        uint256 refund = value - usdtIn - fee;
        if (refund > 0) _sendValue(msg.sender, refund);

        emit Trade(c.token, msg.sender, true, usdtIn, tokensOut, _price(c));

        if (c.tokensSold == CURVE_SUPPLY) {
            c.soldOut = true;
            emit CurveSoldOut(c.token, c.realUsdt);
            _tryGraduate(c);
        }
    }

    /// @notice Sell tokens back to the curve for native USDT0.
    function sell(address token, uint256 tokenAmount, uint256 minUsdtOut, uint256 deadline) external lock {
        require(block.timestamp <= deadline, "expired");
        Curve storage c = curves[token];
        require(c.token != address(0), "unknown token");
        require(!c.soldOut, "curve closed");
        require(tokenAmount > 0, "zero amount");

        uint256 usdtOut = (c.virtualUsdt * tokenAmount) / (c.virtualToken + tokenAmount);
        uint256 fee = (usdtOut * tradeFeeBps) / 10_000;
        uint256 usdtToSeller = usdtOut - fee;
        require(usdtToSeller >= minUsdtOut, "slippage");
        require(usdtOut <= c.realUsdt, "curve reserve");

        c.virtualUsdt -= usdtOut;
        c.virtualToken += tokenAmount;
        c.realUsdt -= usdtOut;
        c.tokensSold -= tokenAmount;

        MemeToken(c.token).transferFrom(msg.sender, address(this), tokenAmount);
        _sendValue(msg.sender, usdtToSeller);
        if (fee > 0) _sendValue(feeRecipient, fee);

        emit Trade(c.token, msg.sender, false, usdtOut, tokenAmount, _price(c));
    }

    // ------------------------------------------------------------ graduation

    /// @notice Retry graduation if the automatic attempt failed.
    function graduate(address token) external lock {
        Curve storage c = curves[token];
        require(c.token != address(0), "unknown token");
        require(c.soldOut && !c.graduated, "not ready");
        _tryGraduate(c);
        require(c.graduated, "graduation failed");
    }

    function _tryGraduate(Curve storage c) internal {
        uint256 usdtForLp = c.realUsdt > graduationFee ? c.realUsdt - graduationFee : c.realUsdt;
        uint256 feeTaken = c.realUsdt - usdtForLp;

        MemeToken(c.token).approve(address(router), LP_SUPPLY);

        try router.addLiquidityETH{value: usdtForLp}(
            c.token, LP_SUPPLY, LP_SUPPLY, usdtForLp, DEAD, block.timestamp
        ) returns (uint256, uint256, uint256 liquidity) {
            c.graduated = true;
            c.realUsdt = 0;
            if (feeTaken > 0) _sendValue(feeRecipient, feeTaken);
            emit Graduated(c.token, usdtForLp, LP_SUPPLY, liquidity);
        } catch (bytes memory reason) {
            MemeToken(c.token).approve(address(router), 0);
            emit GraduationFailed(c.token, reason);
        }
    }

    // ----------------------------------------------------------------- views

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Current spot price in USDT0 per token, scaled by 1e18.
    function getPrice(address token) external view returns (uint256) {
        return _price(curves[token]);
    }

    /// @notice Quote a buy: given msg.value `value`, returns tokens received.
    function quoteBuy(address token, uint256 value) external view returns (uint256 tokensOut) {
        Curve storage c = curves[token];
        if (c.token == address(0) || c.soldOut) return 0;
        uint256 fee = (value * tradeFeeBps) / 10_000;
        uint256 usdtIn = value - fee;
        tokensOut = (c.virtualToken * usdtIn) / (c.virtualUsdt + usdtIn);
        uint256 remaining = CURVE_SUPPLY - c.tokensSold;
        if (tokensOut > remaining) tokensOut = remaining;
    }

    /// @notice Quote a sell: given `tokenAmount`, returns net USDT0 received.
    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 usdtToSeller) {
        Curve storage c = curves[token];
        if (c.token == address(0) || c.soldOut) return 0;
        uint256 usdtOut = (c.virtualUsdt * tokenAmount) / (c.virtualToken + tokenAmount);
        usdtToSeller = usdtOut - (usdtOut * tradeFeeBps) / 10_000;
    }

    /// @notice Graduation progress in bps (10000 = sold out).
    function progressBps(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.token == address(0)) return 0;
        return (c.tokensSold * 10_000) / CURVE_SUPPLY;
    }

    function _price(Curve storage c) internal view returns (uint256) {
        if (c.virtualToken == 0) return 0;
        return (c.virtualUsdt * 1e18) / c.virtualToken;
    }

    // ----------------------------------------------------------------- admin

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "zero addr");
        feeRecipient = _feeRecipient;
    }

    function setFees(uint256 _creationFee, uint256 _tradeFeeBps, uint256 _graduationFee) external onlyOwner {
        require(_tradeFeeBps <= MAX_FEE_BPS, "fee too high");
        creationFee = _creationFee;
        tradeFeeBps = _tradeFeeBps;
        graduationFee = _graduationFee;
    }

    /// @notice Only affects curves created after the change.
    function setVirtualSeeds(uint256 _virtualUsdtSeed, uint256 _virtualTokenSeed) external onlyOwner {
        require(_virtualUsdtSeed > 0 && _virtualTokenSeed > CURVE_SUPPLY, "bad seeds");
        virtualUsdtSeed = _virtualUsdtSeed;
        virtualTokenSeed = _virtualTokenSeed;
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "zero addr");
        owner = _owner;
    }

    // ------------------------------------------------------------------ util

    function _sendValue(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    receive() external payable {}
}
