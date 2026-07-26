// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// MINTR: a fully-backed reserve token on Stablechain (988).
///
/// The contract holds a USDT0 reserve and prices MINTR at reserve / supply
/// (backing per token). Buy with USDT0 (mints MINTR), sell MINTR back (burns
/// it, pays USDT0). Buy and sell each take a small tax that STAYS in the
/// reserve while tokens are burned on sale, so backing-per-token is
/// mathematically non-decreasing. A small platform fee is taken on each trade.
///
/// Honest framing: the *contract price* (backing ratio) only rises, and MINTR
/// is always fully backed 1:1 by USDT0 in the reserve. It is NOT a promise of
/// profit: your gains come from other people's trading volume, it is a bonding
/// curve (you redeem at the current backing minus fee, and mass exit shrinks
/// the reserve), and the owner can never withdraw the backing.
///
/// Reserve is tracked as an internal variable (never `balanceOf`), per Stable's
/// USDT0 dual-decimal guidance.
/// ----------------------------------------------------------------------------

interface IUSDT0M {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract MINTR {
    string public constant name = "Mintr";
    string public constant symbol = "MINTR";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    IUSDT0M public immutable usdt0; // 6-dec USDT0 ERC-20
    uint256 public reserve;         // USDT0 backing (6-dec), tracked internally
    address public owner;
    address public feeRecipient;
    uint256 public buyFeeBps = 75;     // 0.75% -> stays in reserve
    uint256 public sellFeeBps = 25;    // 0.25% -> stays in reserve
    uint256 public platformFeeBps = 10; // 0.10% -> feeRecipient
    bool public seeded;
    uint256 public constant MAX_FEE_BPS = 300;

    uint256 private unlocked = 1;
    modifier lock() { require(unlocked == 1, "reentrancy"); unlocked = 0; _; unlocked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Bought(address indexed buyer, uint256 usdtIn, uint256 mintrOut, uint256 price1e18);
    event Sold(address indexed seller, uint256 mintrIn, uint256 usdtOut, uint256 price1e18);

    constructor(address _usdt0, address _feeRecipient) {
        require(_usdt0 != address(0) && _feeRecipient != address(0), "zero addr");
        usdt0 = IUSDT0M(_usdt0);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
    }

    // ------------------------------------------------- ERC-20 (no transfer tax)
    function transfer(address to, uint256 v) external returns (bool) { return _t(msg.sender, to, v); }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        return _t(f, to, v);
    }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function _t(address f, address to, uint256 v) internal returns (bool) {
        require(to != address(0), "zero to");
        uint256 b = balanceOf[f]; require(b >= v, "balance");
        unchecked { balanceOf[f] = b - v; balanceOf[to] += v; }
        emit Transfer(f, to, v); return true;
    }
    function _mint(address to, uint256 v) internal { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function _burn(address f, uint256 v) internal { uint256 b = balanceOf[f]; require(b >= v, "balance"); unchecked { balanceOf[f] = b - v; totalSupply -= v; } emit Transfer(f, address(0), v); }

    // ------------------------------------------------------------------- seed
    /// @notice One-time seed: sets the initial reserve and mints the initial
    /// supply to the owner, fixing the starting price = usdtAmount/mintrAmount.
    function seed(uint256 usdtAmount, uint256 mintrAmount) external onlyOwner lock {
        require(!seeded, "seeded");
        require(usdtAmount > 0 && mintrAmount > 0, "amt");
        require(usdt0.transferFrom(msg.sender, address(this), usdtAmount), "xfer");
        reserve = usdtAmount;
        _mint(msg.sender, mintrAmount);
        seeded = true;
    }

    // ----------------------------------------------------------- price / quotes
    /// @notice USDT0 per MINTR, 1e18-scaled.
    function price1e18() public view returns (uint256) {
        return totalSupply == 0 ? 0 : (reserve * 1e30) / totalSupply;
    }
    function quoteBuy(uint256 usdtIn) public view returns (uint256) {
        if (totalSupply == 0 || reserve == 0) return 0;
        uint256 net = (usdtIn * (10000 - buyFeeBps - platformFeeBps)) / 10000;
        return (net * totalSupply) / reserve;
    }
    function quoteSell(uint256 mintrIn) public view returns (uint256 userGets) {
        if (totalSupply == 0) return 0;
        uint256 gross = (mintrIn * reserve) / totalSupply;
        userGets = (gross * (10000 - sellFeeBps - platformFeeBps)) / 10000;
    }

    // -------------------------------------------------------------- buy / sell
    function buy(uint256 usdtIn, uint256 minOut) external lock returns (uint256 mintrOut) {
        require(seeded, "not seeded");
        require(usdtIn > 0, "zero");
        require(usdt0.transferFrom(msg.sender, address(this), usdtIn), "xfer");
        uint256 platformCut = (usdtIn * platformFeeBps) / 10000;
        uint256 net = (usdtIn * (10000 - buyFeeBps - platformFeeBps)) / 10000;
        mintrOut = (net * totalSupply) / reserve; // floor -> conservative (price up)
        require(mintrOut >= minOut, "slippage");
        require(mintrOut > 0, "dust");
        reserve += usdtIn - platformCut; // everything except platform stays in reserve
        _mint(msg.sender, mintrOut);
        if (platformCut > 0) require(usdt0.transfer(feeRecipient, platformCut), "fee");
        emit Bought(msg.sender, usdtIn, mintrOut, price1e18());
    }

    function sell(uint256 mintrIn, uint256 minUsdt) external lock returns (uint256 userGets) {
        require(mintrIn > 0, "zero");
        require(balanceOf[msg.sender] >= mintrIn, "balance");
        uint256 gross = (mintrIn * reserve) / totalSupply; // floor
        uint256 platformCut = (gross * platformFeeBps) / 10000;
        userGets = (gross * (10000 - sellFeeBps - platformFeeBps)) / 10000;
        require(userGets >= minUsdt, "slippage");
        uint256 leavingReserve = userGets + platformCut; // sell fee stays in reserve
        require(leavingReserve <= reserve, "reserve");
        _burn(msg.sender, mintrIn);
        reserve -= leavingReserve;
        require(usdt0.transfer(msg.sender, userGets), "pay");
        if (platformCut > 0) require(usdt0.transfer(feeRecipient, platformCut), "fee");
        emit Sold(msg.sender, mintrIn, userGets, price1e18());
    }

    // ----------------------------------------------------------------- admin
    // NOTE: there is deliberately no function that withdraws the reserve. The
    // backing can only leave via sell() (paying a redeemer) or trade platform
    // fees. The owner can never touch the backing.
    function setFees(uint256 b, uint256 s, uint256 p) external onlyOwner {
        require(b > 0 && s > 0, "need backing fees"); // keep the price monotonic
        require(b <= MAX_FEE_BPS && s <= MAX_FEE_BPS && p <= MAX_FEE_BPS, "cap");
        require(b + p < 10000 && s + p < 10000, "too high");
        buyFeeBps = b; sellFeeBps = s; platformFeeBps = p;
    }
    function setFeeRecipient(address r) external onlyOwner { require(r != address(0), "zero"); feeRecipient = r; }
    function transferOwnership(address o) external onlyOwner { require(o != address(0), "zero"); owner = o; }
}
