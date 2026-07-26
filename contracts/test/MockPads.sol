// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Test doubles matching the two real launchpad `launches()` struct shapes.

contract MockPadOld {
    struct Launch { address token; address creator; address pool; uint256 positionId; uint64 createdAt; uint256 a; uint256 b; }
    mapping(address => Launch) public launches;
    function set(address token, address creator) external {
        launches[token] = Launch(token, creator, address(0), 0, 0, 0, 0);
    }
}

contract MockPadNew {
    struct Launch { address token; address creator; address pool; address quote; uint256 positionId; uint64 createdAt; uint256 a; uint256 b; }
    mapping(address => Launch) public launches;
    function set(address token, address creator) external {
        launches[token] = Launch(token, creator, address(0), address(0), 0, 0, 0, 0);
    }
}
