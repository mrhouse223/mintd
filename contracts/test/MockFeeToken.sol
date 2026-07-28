// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ERC-20 that takes a 10% cut on every transfer. Exists so the Furnace
///         test can prove it records what actually reached the dead address
///         rather than what the caller asked to burn.
contract MockFeeToken {
    string public name = "Fee Token";
    string public symbol = "FEE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function _move(address f, address t, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        uint256 fee = v / 10;              // 10% burned into nowhere
        balanceOf[f] -= v;
        balanceOf[t] += v - fee;
        totalSupply -= fee;
        emit Transfer(f, t, v - fee);
    }

    function transfer(address t, uint256 v) external returns (bool) {
        _move(msg.sender, t, v);
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        _move(f, t, v);
        return true;
    }
}

/// @notice ERC-20 that returns false instead of reverting on a failed transfer.
///         The Furnace must treat that as a failure, not silently record a burn
///         that never happened.
contract MockLiarToken {
    string public name = "Liar";
    string public symbol = "LIAR";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1e24;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor() { balanceOf[msg.sender] = totalSupply; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}
