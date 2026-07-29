// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Stands in for Circle's TokenMessengerV2 so BridgeFeeRouter can be tested
/// without a mainnet fork. It records what it was asked to burn, and can be told
/// to revert, which is the case that matters: the fee must not be taken when the
/// burn fails.
interface IMockErc20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract MockTokenMessenger {
    struct Call {
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }

    Call public last;
    uint256 public calls;
    bool public shouldRevert;
    address public immutable token;
    /// Mirrors the real layout: the local domain is reachable only through the
    /// message transmitter, so the router's constructor check is exercised for
    /// real rather than against a convenience shortcut.
    address public immutable localMessageTransmitter;

    constructor(address _token, address _transmitter) {
        token = _token;
        localMessageTransmitter = _transmitter;
    }

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(!shouldRevert, "messenger: forced revert");
        // Real CCTP pulls the tokens via the allowance it was granted. Doing the
        // same here proves the router actually approved the right amount rather
        // than merely calling the right function.
        require(IMockErc20(token).transferFrom(msg.sender, address(this), amount), "pull");
        last = Call(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold);
        calls++;
    }
}

/// Minimal stand-in for Circle's MessageTransmitter, which is the only place
/// localDomain() actually lives.
contract MockMessageTransmitter {
    uint32 public immutable localDomain;
    constructor(uint32 d) { localDomain = d; }
}
