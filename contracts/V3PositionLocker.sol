// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title V3PositionLocker
/// @notice Permanently locks a Uniswap V3 liquidity position while keeping its
///         trading fees claimable by a chosen beneficiary, forever.
///
///         Send a position NFT here with safeTransferFrom and the liquidity can
///         never be withdrawn by anyone, including the deployer of this
///         contract. There is deliberately no withdraw, no decreaseLiquidity,
///         no rescue, and no owner. The only action this contract can perform
///         on a locked position is collect() to the recorded beneficiary.
///
///         This is the same guarantee the launchpad gives its own pools, made
///         available for positions created outside it.
interface INonfungiblePositionManagerL {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function ownerOf(uint256 tokenId) external view returns (address);
    function positions(uint256 tokenId) external view returns (
        uint96 nonce, address operator, address token0, address token1, uint24 fee,
        int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0, uint128 tokensOwed1
    );
}

contract V3PositionLocker {
    INonfungiblePositionManagerL public immutable positionManager;

    /// @notice Who may collect fees for each locked position.
    mapping(uint256 => address) public beneficiaryOf;
    /// @notice When each position was locked (0 if never locked here).
    mapping(uint256 => uint64) public lockedAt;
    uint256[] public lockedPositions;

    event PositionLocked(uint256 indexed tokenId, address indexed beneficiary, address indexed from);
    event FeesCollected(uint256 indexed tokenId, address indexed beneficiary, uint256 amount0, uint256 amount1);
    event BeneficiaryTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    constructor(address _positionManager) {
        require(_positionManager != address(0), "zero pm");
        positionManager = INonfungiblePositionManagerL(_positionManager);
    }

    /// @notice Receives a position NFT and locks it permanently.
    /// @dev Pass the intended beneficiary ABI-encoded in `data`, or leave data
    ///      empty to use the sender. Only the configured position manager can
    ///      call this, so stray NFTs cannot be registered.
    function onERC721Received(
        address, address from, uint256 tokenId, bytes calldata data
    ) external returns (bytes4) {
        require(msg.sender == address(positionManager), "not the position manager");
        require(lockedAt[tokenId] == 0, "already locked");
        address beneficiary = from;
        if (data.length == 32) {
            address decoded = abi.decode(data, (address));
            if (decoded != address(0)) beneficiary = decoded;
        }
        require(beneficiary != address(0), "zero beneficiary");
        beneficiaryOf[tokenId] = beneficiary;
        lockedAt[tokenId] = uint64(block.timestamp);
        lockedPositions.push(tokenId);
        emit PositionLocked(tokenId, beneficiary, from);
        return this.onERC721Received.selector;
    }

    /// @notice Collect accrued trading fees to the beneficiary. Anyone may
    ///         trigger it; the funds can only ever go to the beneficiary.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        address beneficiary = beneficiaryOf[tokenId];
        require(beneficiary != address(0), "not locked here");
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManagerL.CollectParams({
                tokenId: tokenId,
                recipient: beneficiary,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(tokenId, beneficiary, amount0, amount1);
    }

    /// @notice Hand future fee rights to someone else. Only the current
    ///         beneficiary can do this; it never unlocks the liquidity.
    function transferBeneficiary(uint256 tokenId, address to) external {
        require(msg.sender == beneficiaryOf[tokenId], "not the beneficiary");
        require(to != address(0), "zero address");
        beneficiaryOf[tokenId] = to;
        emit BeneficiaryTransferred(tokenId, msg.sender, to);
    }

    // ------------------------------------------------------------- views
    function lockedCount() external view returns (uint256) { return lockedPositions.length; }

    function isLocked(uint256 tokenId) external view returns (bool) { return lockedAt[tokenId] != 0; }

    /// @notice Fees currently claimable for a locked position.
    function pendingFees(uint256 tokenId) external view returns (uint128 owed0, uint128 owed1) {
        (, , , , , , , , , , owed0, owed1) = positionManager.positions(tokenId);
    }
}
