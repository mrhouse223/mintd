// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title TokenMetaRegistry
/// @notice Lets the CREATOR of a launchpad token publish updated metadata
///         (bio, links, images) for their token page. The original onchain
///         metadataURI is immutable; the site overlays this on top. Only the
///         wallet recorded as `creator` on a recognized launchpad can write.
contract TokenMetaRegistry {
    address[] public pads;
    mapping(address => string) public metaOf;

    event MetaUpdated(address indexed token, address indexed editor, string json);

    constructor(address[] memory _pads) {
        pads = _pads;
    }

    /// @notice Resolve a token's creator by asking each known launchpad.
    /// @dev Both launchpad versions return a struct that STARTS with
    ///      (address token, address creator, ...), so reading the first two
    ///      words works for either ABI shape.
    function creatorOf(address token) public view returns (address) {
        for (uint256 i = 0; i < pads.length; i++) {
            (bool ok, bytes memory d) = pads[i].staticcall(abi.encodeWithSignature("launches(address)", token));
            if (ok && d.length >= 64) {
                address tok;
                address cr;
                assembly {
                    tok := mload(add(d, 32))
                    cr := mload(add(d, 64))
                }
                if (tok == token && cr != address(0)) return cr;
            }
        }
        return address(0);
    }

    /// @notice Set (or clear with "") the metadata override for your token.
    function setMeta(address token, string calldata json) external {
        require(bytes(json).length <= 8192, "too long");
        address cr = creatorOf(token);
        require(cr != address(0), "token not on a known pad");
        require(msg.sender == cr, "not the creator");
        metaOf[token] = json;
        emit MetaUpdated(token, msg.sender, json);
    }
}
