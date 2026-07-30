// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// ARX, the arcswap platform token.
///
/// WHY THIS IS NOT A LAUNCHPAD LAUNCH
/// The launchpad mints a fixed 1,000,000,000 supply and puts every token of it
/// into a position it then cannot withdraw from. ARX needs a 100,000,000 supply
/// with 20% held back, which that path cannot express: there is no partial
/// allocation and no way to keep any of the supply. So the token is deployed on
/// its own and its liquidity is added by hand.
///
/// The consequence is stated rather than buried: ARX's liquidity is NOT locked
/// by any contract. The position is an ordinary Uniswap V3 NFT owned by whoever
/// mints it, and it can be withdrawn at any time. The site reads that off chain
/// per token, so ARX's page reports its real custody instead of inheriting the
/// launchpad's guarantee.
///
/// WHAT THIS CONTRACT CANNOT DO
/// There is no owner, no mint, no burn-from, no pause, no blacklist, no fee on
/// transfer and no upgrade path. The entire supply is created once, in the
/// constructor, to the deployer. After that the contract only moves balances.
/// That is deliberate: everything a holder has to trust about ARX should be
/// checkable by reading 60 lines, not by trusting an operator.
///
/// A fee on transfer would also silently break the liquidity maths, because a
/// V3 position assumes the amount sent is the amount received. Its absence is a
/// correctness property, not only a fairness one.
/// ----------------------------------------------------------------------------
contract ArxToken {
    string public constant name = "ArcSwap";
    string public constant symbol = "ARX";
    uint8 public constant decimals = 18;

    /// 100,000,000 tokens. Fixed at deployment and unchangeable: there is no
    /// function anywhere in this contract that writes to it.
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply_) {
        require(supply_ > 0, "zero supply");
        totalSupply = supply_;
        balanceOf[msg.sender] = supply_;
        // Minting is a Transfer from the zero address by convention, and
        // indexers rely on it to see the initial allocation at all.
        emit Transfer(address(0), msg.sender, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An infinite allowance is left untouched rather than decremented. This
        // is what routers and position managers expect, and decrementing it
        // would cost every caller an extra storage write forever.
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        // Sending to the token itself strands the balance with no recovery path,
        // since this contract has no code that can move its own holdings. The
        // zero address is rejected for the same reason, and because a transfer
        // to it reads as a burn to every indexer while supply stays unchanged.
        require(to != address(0) && to != address(this), "bad recipient");
        uint256 bal = balanceOf[from];
        require(bal >= value, "balance");
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}
