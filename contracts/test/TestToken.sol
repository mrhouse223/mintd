// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// TestToken — a worthless ERC20 for Arc testnet, so the community can try the
/// agent without a faucet standing in the way.
///
/// BORING IS THE REQUIREMENT
/// This is not an aesthetic preference. `AgentVault` uses
/// `require(token.transfer(...))` and values itself from `balanceOf`, so a token
/// with a transfer fee, a rebase, or a missing return value would produce
/// failures that look exactly like vault bugs and would send a tester chasing
/// the wrong contract. So: fixed decimals, a real `bool` return on every
/// transfer, no hooks, no fees, no owner, nothing clever.
///
/// NO VALUE, EVER
/// Anyone can mint from `faucet()`. That is the point, and it is also why this
/// must never be presented as a token worth holding. It exists so that pool
/// depth is a number we choose rather than one Circle's faucet allows.
///
/// The cooldown is not a security control, because there is nothing to secure.
/// It stops one person in a loop from minting so much that they can move the
/// test pool's price at will and make it useless for everyone else.
/// ----------------------------------------------------------------------------
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice How much `faucet()` hands out, in the token's own decimals.
    uint256 public immutable faucetAmount;
    uint256 public immutable faucetCooldown;
    mapping(address => uint256) public lastFaucet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        uint256 _initialSupply,
        address _initialHolder,
        uint256 _faucetAmount,
        uint256 _faucetCooldown
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        faucetAmount = _faucetAmount;
        faucetCooldown = _faucetCooldown;
        if (_initialSupply > 0) {
            // Seed supply for the pool. Held by whoever deploys, spent once into
            // liquidity; it buys no ongoing authority because there is none.
            totalSupply = _initialSupply;
            balanceOf[_initialHolder] = _initialSupply;
            emit Transfer(address(0), _initialHolder, _initialSupply);
        }
    }

    /// @notice Mint the faucet amount to the caller.
    /// @dev Reverts rather than silently no-opping when the cooldown has not
    /// elapsed. A faucet that appears to succeed and sends nothing is the kind
    /// of thing a tester reports as "the site is broken".
    function faucet() external {
        require(
            lastFaucet[msg.sender] == 0 || block.timestamp >= lastFaucet[msg.sender] + faucetCooldown,
            "faucet: too soon"
        );
        lastFaucet[msg.sender] = block.timestamp;
        totalSupply += faucetAmount;
        balanceOf[msg.sender] += faucetAmount;
        emit Transfer(address(0), msg.sender, faucetAmount);
    }

    /// @notice Seconds until this address may use the faucet again, 0 if now.
    function faucetReadyIn(address who) external view returns (uint256) {
        uint256 last = lastFaucet[who];
        if (last == 0) return 0;
        uint256 ready = last + faucetCooldown;
        return block.timestamp >= ready ? 0 : ready - block.timestamp;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[from][msg.sender] = a - value;
        }
        return _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        // Rejected rather than allowed to burn silently: a position manager or
        // router handed the zero address is a bug worth surfacing.
        require(to != address(0), "to zero");
        uint256 b = balanceOf[from];
        require(b >= value, "balance");
        unchecked { balanceOf[from] = b - value; }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
