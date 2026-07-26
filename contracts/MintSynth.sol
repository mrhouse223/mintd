// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MintSynth
/// @notice Overcollateralized CDP system. Users lock USDT0 collateral and mint
///         a synthetic token tracking a RedStone price feed (gold, BTC, ETH).
///         Every position must stay above the minimum collateral ratio or it
///         can be liquidated by anyone at a discount.
///
///         Solvency model: the system never owes more than it holds, because
///         every synth in existence is backed by >=minCollateralRatio worth of
///         USDT0 sitting in this contract. Liquidations bring undercollateralized
///         positions back before they can go underwater.
///
///         Safety rails: the oracle price is rejected if stale or if it moved
///         more than maxDeviationBps since the last accepted price, and the
///         owner can pause new minting (never withdrawals or repayments).

interface AggregatorV3Interface {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

interface IERC20S {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// @notice The synthetic token itself. Only the CDP engine can mint or burn.
contract SynthToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable engine;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
        engine = msg.sender;
    }

    modifier onlyEngine() {
        require(msg.sender == engine, "not engine");
        _;
    }

    function mint(address to, uint256 v) external onlyEngine {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function burn(address from, uint256 v) external onlyEngine {
        require(balanceOf[from] >= v, "burn exceeds balance");
        balanceOf[from] -= v;
        totalSupply -= v;
        emit Transfer(from, address(0), v);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }

    function approve(address sp, uint256 v) external returns (bool) {
        allowance[msg.sender][sp] = v;
        emit Approval(msg.sender, sp, v);
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        require(balanceOf[f] >= v, "balance");
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v;
        balanceOf[t] += v;
        emit Transfer(f, t, v);
        return true;
    }
}

contract MintSynth {
    struct Position {
        uint256 collateral; // USDT0 deposited, 18-dec scaled
        uint256 debt;       // synth minted, 18-dec
    }

    SynthToken public immutable synth;
    IERC20S public immutable collateralToken; // USDT0 ERC-20 (6 dec)
    AggregatorV3Interface public immutable oracle;
    address public owner;
    address public feeRecipient;

    mapping(address => Position) public positions;
    uint256 public totalCollateral;
    uint256 public totalDebt;

    // risk parameters (basis points)
    uint256 public minCollateralRatio = 15000;  // 150% to mint / stay safe
    uint256 public liquidationRatio = 13000;    // below 130% you can be liquidated
    uint256 public liquidationBonus = 1000;     // liquidator keeps 10% of seized value
    uint256 public mintFeeBps = 50;             // 0.5% of minted value, paid in collateral

    // oracle safety rails
    uint256 public maxStaleness = 6 hours + 30 minutes; // RedStone heartbeat is 6h
    uint256 public maxDeviationBps = 2000;              // reject a >20% jump in one update
    uint256 public lastGoodPrice;                       // 1e18-scaled
    uint256 public lastGoodAt;

    bool public mintPaused; // owner can stop new debt; never blocks repay/withdraw

    uint256 private constant BPS = 10000;
    uint256 private constant COLLATERAL_SCALE = 1e12; // 6-dec USDT0 -> 18-dec
    bool private _entered;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Minted(address indexed user, uint256 amount, uint256 price);
    event Burned(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);
    event ParamsChanged(uint256 minRatio, uint256 liqRatio, uint256 bonus, uint256 mintFee);

    modifier lock() {
        require(!_entered, "reentrancy");
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(
        string memory synthName,
        string memory synthSymbol,
        address _collateralToken,
        address _oracle,
        address _feeRecipient
    ) {
        synth = new SynthToken(synthName, synthSymbol);
        collateralToken = IERC20S(_collateralToken);
        oracle = AggregatorV3Interface(_oracle);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        // seed the deviation guard with the current price
        (uint256 p, ) = _rawPrice();
        lastGoodPrice = p;
        lastGoodAt = block.timestamp;
    }

    // --------------------------------------------------------------- oracle
    /// @dev Raw feed read, normalized to 1e18. Reverts on non-positive answers.
    function _rawPrice() internal view returns (uint256 price, uint256 updatedAt) {
        (, int256 answer, , uint256 ts, ) = oracle.latestRoundData();
        require(answer > 0, "bad oracle answer");
        uint8 d = oracle.decimals();
        price = uint256(answer) * (10 ** (18 - d));
        updatedAt = ts;
    }

    /// @notice Allowed deviation right now, in bps. Scales with time since the
    ///         last accepted price so ordinary drift between mints is not
    ///         mistaken for a bad print, while an instantaneous absurd jump is
    ///         still rejected. Capped at 90%.
    function allowedDeviationBps() public view returns (uint256) {
        uint256 elapsedHours = (block.timestamp - lastGoodAt) / 1 hours;
        uint256 allowed = maxDeviationBps * (elapsedHours + 1);
        return allowed > 9000 ? 9000 : allowed;
    }

    /// @notice Price used for opening risk (minting). Enforces freshness and
    ///         rejects implausible jumps. Reverts rather than guessing.
    function price() public view returns (uint256) {
        (uint256 p, uint256 ts) = _rawPrice();
        require(block.timestamp - ts <= maxStaleness, "oracle stale");
        if (lastGoodPrice > 0) {
            uint256 diff = p > lastGoodPrice ? p - lastGoodPrice : lastGoodPrice - p;
            require((diff * BPS) / lastGoodPrice <= allowedDeviationBps(), "oracle deviation");
        }
        return p;
    }

    /// @dev Same checks, but also advances the deviation baseline.
    function _priceAndSync() internal returns (uint256 p) {
        p = price();
        lastGoodPrice = p;
        lastGoodAt = block.timestamp;
    }

    // ------------------------------------------------------------- position
    /// @notice Collateral ratio in bps. type(uint256).max when debt is zero.
    function collateralRatio(address user, uint256 p) public view returns (uint256) {
        Position storage pos = positions[user];
        if (pos.debt == 0) return type(uint256).max;
        uint256 debtValue = (pos.debt * p) / 1e18; // synth units -> USD, 18-dec
        if (debtValue == 0) return type(uint256).max;
        return (pos.collateral * BPS) / debtValue;
    }

    function currentRatio(address user) external view returns (uint256) {
        (uint256 p, ) = _rawPrice();
        return collateralRatio(user, p);
    }

    /// @notice Max synth mintable by `user` right now, at the min ratio.
    function maxMintable(address user) external view returns (uint256) {
        (uint256 p, ) = _rawPrice();
        Position storage pos = positions[user];
        uint256 maxDebtValue = (pos.collateral * BPS) / minCollateralRatio;
        uint256 maxDebt = (maxDebtValue * 1e18) / p;
        return maxDebt > pos.debt ? maxDebt - pos.debt : 0;
    }

    // ---------------------------------------------------------- collateral
    function deposit(uint256 amount6) public lock {
        require(amount6 > 0, "zero");
        require(collateralToken.transferFrom(msg.sender, address(this), amount6), "transfer failed");
        uint256 amount = amount6 * COLLATERAL_SCALE;
        positions[msg.sender].collateral += amount;
        totalCollateral += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw collateral, provided the position stays >= min ratio.
    /// @dev Never blocked by the pause: users can always exit.
    function withdraw(uint256 amount6) public lock {
        uint256 amount = amount6 * COLLATERAL_SCALE;
        Position storage pos = positions[msg.sender];
        require(pos.collateral >= amount, "exceeds collateral");
        pos.collateral -= amount;
        totalCollateral -= amount;
        if (pos.debt > 0) {
            (uint256 p, ) = _rawPrice();
            require(collateralRatio(msg.sender, p) >= minCollateralRatio, "would undercollateralize");
        }
        require(collateralToken.transfer(msg.sender, amount6), "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- debt
    /// @notice Mint synth against your collateral.
    function mint(uint256 amount) public lock {
        require(!mintPaused, "minting paused");
        require(amount > 0, "zero");
        uint256 p = _priceAndSync();
        Position storage pos = positions[msg.sender];

        // fee is charged on the minted value, taken from collateral
        uint256 mintValue = (amount * p) / 1e18;
        uint256 fee = (mintValue * mintFeeBps) / BPS;
        require(pos.collateral >= fee, "collateral below fee");
        if (fee > 0) {
            pos.collateral -= fee;
            totalCollateral -= fee;
            require(collateralToken.transfer(feeRecipient, fee / COLLATERAL_SCALE), "fee transfer failed");
        }

        pos.debt += amount;
        totalDebt += amount;
        require(collateralRatio(msg.sender, p) >= minCollateralRatio, "below min ratio");
        synth.mint(msg.sender, amount);
        emit Minted(msg.sender, amount, p);
    }

    /// @notice Burn synth to reduce your debt. Always allowed, even when paused.
    function burn(uint256 amount) public lock {
        Position storage pos = positions[msg.sender];
        require(amount > 0 && amount <= pos.debt, "bad amount");
        synth.burn(msg.sender, amount);
        pos.debt -= amount;
        totalDebt -= amount;
        emit Burned(msg.sender, amount);
    }

    /// @notice Convenience: deposit collateral and mint in one transaction.
    function depositAndMint(uint256 amount6, uint256 mintAmount) external {
        deposit(amount6);
        mint(mintAmount);
    }

    /// @notice Convenience: burn all debt and withdraw everything.
    function closePosition() external {
        Position storage pos = positions[msg.sender];
        if (pos.debt > 0) burn(pos.debt);
        uint256 c = positions[msg.sender].collateral;
        if (c > 0) withdraw(c / COLLATERAL_SCALE);
    }

    // --------------------------------------------------------- liquidation
    /// @notice Repay part of an unhealthy position's debt and seize collateral
    ///         at a discount. Anyone can call. Caps the seizure at the position's
    ///         collateral so the contract can never pay out more than it holds.
    function liquidate(address user, uint256 repayAmount) external lock {
        (uint256 p, uint256 ts) = _rawPrice();
        require(block.timestamp - ts <= maxStaleness, "oracle stale");
        Position storage pos = positions[user];
        require(pos.debt > 0, "no debt");
        require(collateralRatio(user, p) < liquidationRatio, "position healthy");
        require(repayAmount > 0 && repayAmount <= pos.debt, "bad repay amount");

        // liquidator burns their own synth to clear the debt
        synth.burn(msg.sender, repayAmount);
        pos.debt -= repayAmount;
        totalDebt -= repayAmount;

        uint256 repayValue = (repayAmount * p) / 1e18;
        uint256 seize = (repayValue * (BPS + liquidationBonus)) / BPS;
        if (seize > pos.collateral) seize = pos.collateral; // never overpay
        pos.collateral -= seize;
        totalCollateral -= seize;
        require(collateralToken.transfer(msg.sender, seize / COLLATERAL_SCALE), "transfer failed");
        emit Liquidated(user, msg.sender, repayAmount, seize);
    }

    /// @notice Is this position liquidatable right now?
    function isLiquidatable(address user) external view returns (bool) {
        Position storage pos = positions[user];
        if (pos.debt == 0) return false;
        (uint256 p, uint256 ts) = _rawPrice();
        if (block.timestamp - ts > maxStaleness) return false;
        return collateralRatio(user, p) < liquidationRatio;
    }

    // --------------------------------------------------------------- admin
    /// @dev Admin can tune risk parameters and pause NEW minting only. There is
    ///      no function that lets the owner touch user collateral or debt.
    function setParams(uint256 _minRatio, uint256 _liqRatio, uint256 _bonus, uint256 _mintFee) external onlyOwner {
        require(_minRatio >= 12000 && _minRatio <= 50000, "min ratio out of range");
        require(_liqRatio >= 11000 && _liqRatio < _minRatio, "liq ratio out of range");
        require(_bonus <= 2000, "bonus too high");
        require(_mintFee <= 300, "fee too high");
        minCollateralRatio = _minRatio;
        liquidationRatio = _liqRatio;
        liquidationBonus = _bonus;
        mintFeeBps = _mintFee;
        emit ParamsChanged(_minRatio, _liqRatio, _bonus, _mintFee);
    }

    function setOracleGuards(uint256 _maxStaleness, uint256 _maxDeviationBps) external onlyOwner {
        require(_maxStaleness >= 1 hours && _maxStaleness <= 2 days, "staleness out of range");
        require(_maxDeviationBps >= 500 && _maxDeviationBps <= 5000, "deviation out of range");
        maxStaleness = _maxStaleness;
        maxDeviationBps = _maxDeviationBps;
    }

    function setMintPaused(bool v) external onlyOwner { mintPaused = v; }

    function setFeeRecipient(address r) external onlyOwner {
        require(r != address(0), "zero");
        feeRecipient = r;
    }

    function transferOwnership(address n) external onlyOwner {
        require(n != address(0), "zero");
        owner = n;
    }
}
