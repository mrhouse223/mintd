// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Test double for a RedStone / Chainlink AggregatorV3 push feed.
contract MockAggregator {
    int256 public answer;
    uint8 public immutable decimals;
    uint256 public updatedAt;
    uint80 public roundId;

    constructor(int256 _answer, uint8 _decimals) {
        answer = _answer;
        decimals = _decimals;
        updatedAt = block.timestamp;
        roundId = 1;
    }

    function setAnswer(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
        roundId++;
    }

    /// @dev Move the price without refreshing the timestamp (simulates staleness).
    function setAnswerStale(int256 a, uint256 ts) external {
        answer = a;
        updatedAt = ts;
        roundId++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
