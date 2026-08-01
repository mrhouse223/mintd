// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A token that re-enters BondMarket.claim() from inside its own
///         transfer, which is the exact shape of the attack the guard exists
///         to stop: the payout call hands control back to the token while the
///         claim is still mid-flight.
///
/// It is its own bond asset, so the malicious transfer hook fires on the very
/// call that pays a buyer out.
interface IBondM {
    function create(address token, uint256 amount, uint128 price, uint32 startDelay, uint32 saleDuration,
                    uint32 vestDuration, uint32 vestStep, uint128 walletCap) external payable returns (uint256);
    function buy(uint256 id, uint256 quoteIn, uint256 minTokens) external returns (uint256);
    function claim(uint256 id) external returns (uint256);
}
interface IERC20R {
    function approve(address s, uint256 v) external returns (bool);
}

contract ReentrantBuyer {
    string public name = "Reentrant";
    string public symbol = "RE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000e18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed f, address indexed t, uint256 v);
    event Approval(address indexed o, address indexed s, uint256 v);

    address public immutable bm;
    uint256 public bondId;
    bool public armed;

    constructor(address _bm) {
        bm = _bm;
        balanceOf[address(this)] = totalSupply;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }
    function transfer(address to, uint256 v) external returns (bool) { return _t(msg.sender, to, v); }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= v;
        return _t(f, t, v);
    }
    function _t(address f, address t, uint256 v) internal returns (bool) {
        balanceOf[f] -= v;
        balanceOf[t] += v;
        emit Transfer(f, t, v);
        // Only when the market is paying US, which is the reentrant window.
        if (armed && f == bm) IBondM(bm).claim(bondId);
        return true;
    }

    function approveAll(address usdt) external {
        IERC20R(usdt).approve(bm, type(uint256).max);
        allowance[address(this)][bm] = type(uint256).max;
    }
    function openBond(uint32 saleDuration) external {
        bondId = IBondM(bm).create(address(this), 1_000_000e18, 50, 0, saleDuration, 1 days, 0, 0);
    }
    function buyIn(uint256 quoteIn) external { IBondM(bm).buy(bondId, quoteIn, 0); }
    function arm() external { armed = true; }
    function claimNow() external returns (uint256) { return IBondM(bm).claim(bondId); }
}
