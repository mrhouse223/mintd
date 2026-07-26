// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test-only emulation of USDT0 on Stable: a 6-decimal ERC-20 whose
/// balance mirrors the holder's NATIVE balance (native has 18 decimals, the
/// ERC-20 view divides by 1e12), exactly like the dual-interface USDT0
/// described in docs.stable.xyz. ERC-20 transfers adjust a signed ledger on
/// top of the native mirror, so a contract that received native value can
/// spend it via the ERC-20 interface — the property InstantLaunchpad relies
/// on for dev buys.
contract MockUSDT0 {
    string public constant name = "USDT0";
    string public constant symbol = "USDT0";
    uint8 public constant decimals = 6;

    mapping(address => int256) private ledger;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function totalSupply() external pure returns (uint256) {
        return type(uint128).max; // not meaningful for the mock
    }

    function balanceOf(address account) public view returns (uint256) {
        int256 bal = int256(account.balance / 1e12) + ledger[account];
        return bal > 0 ? uint256(bal) : 0;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= value, "USDT0: allowance");
            allowance[from][msg.sender] -= value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(to != address(0), "USDT0: zero to"); // matches Stable behavior
        require(balanceOf(from) >= value, "USDT0: balance");
        ledger[from] -= int256(value);
        ledger[to] += int256(value);
        emit Transfer(from, to, value);
        return true;
    }
}
