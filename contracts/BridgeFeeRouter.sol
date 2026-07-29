// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// BridgeFeeRouter — takes the mintd fee and burns USDC through Circle's CCTP in
/// ONE transaction, on the source chain.
///
/// WHY A CONTRACT AT ALL
/// The fee could be a plain transfer in the frontend followed by a separate
/// depositForBurn. That is worse for the user, not better: they can pay the fee
/// and then have the burn fail, or simply not sign it, and they are down the fee
/// with nothing bridged. Here the fee is only ever taken if the burn in the same
/// call succeeds. Atomicity is the entire justification for this file existing.
///
/// WHY IT CANNOT BE ABUSED
/// Every value-carrying parameter is immutable and there is no owner, no setter
/// and no sweep to an arbitrary address:
///
///   - `feeBps` is fixed at construction and capped by MAX_FEE_BPS, so nobody,
///     including us, can raise the fee on a user later. The cap is enforced in
///     the constructor, so the deployed bytecode is the promise.
///   - `feeRecipient` is fixed, so no admin can redirect fees.
///   - `destinationDomain` is fixed, so this router can never be pointed at a
///     different chain than the one it was deployed to serve.
///   - USDC is never held at rest. It is pulled, split and burned inside one
///     call; the contract's balance is zero before and after.
///
/// WHAT IT DOES NOT DO
/// It does not bridge anything by itself and it holds no custody. Circle's
/// TokenMessenger burns the USDC and Circle's attestation service authorises the
/// mint on the destination. This contract only decides the split. We are not in
/// the business of writing a bridge, and this is deliberately the smallest thing
/// that can charge a fee honestly.
///
/// DELIVERY IS NOT AUTOMATIC
/// CCTP mints only when someone calls `receiveMessage` on the destination chain,
/// which costs gas there. On Arc that gas is USDC, which a first-time bridger
/// does not yet have, so a relayer has to complete the transfer for them.
/// `destinationCaller` is left as zero here precisely so that ANYONE can relay,
/// including the user themselves; nothing about delivery depends on us staying
/// online, which is the property that matters if we ever stop.
/// ----------------------------------------------------------------------------

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface ITokenMessengerV2 {
    /// @dev The v2 signature, verified against the deployed implementation on
    /// both Base and Arc. The v1 four-argument form is NOT present on these
    /// contracts, so calling it would revert.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

contract BridgeFeeRouter {
    /// @notice Hard ceiling on the fee, checked at construction. A deployed
    /// router can never charge more than this, whatever anyone later wants.
    uint256 public constant MAX_FEE_BPS = 100; // 1.00%

    /// @notice Standard CCTP finality. 2000 is the slow, free transfer; 1000 is
    /// Circle's fast path, which charges its own fee out of the burned amount.
    /// Standard is used so the only fee a user pays is the one displayed.
    uint32 public constant STANDARD_FINALITY = 2000;

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable messenger;
    address public immutable feeRecipient;
    uint256 public immutable feeBps;
    uint32 public immutable destinationDomain;

    event Bridged(
        address indexed from,
        bytes32 indexed mintRecipient,
        uint256 amountIn,
        uint256 fee,
        uint256 bridged
    );
    event Flushed(uint256 amount);

    constructor(
        address _usdc,
        address _messenger,
        address _feeRecipient,
        uint256 _feeBps,
        uint32 _destinationDomain
    ) {
        require(_usdc != address(0) && _messenger != address(0), "zero addr");
        require(_feeRecipient != address(0), "zero fee recipient");
        // Contracts, not EOAs. A mistyped messenger that happens to be an EOA
        // would let every bridge silently take the fee and burn nothing.
        require(_usdc.code.length > 0 && _messenger.code.length > 0, "not contract");
        require(_feeBps <= MAX_FEE_BPS, "fee too high");
        usdc = IERC20(_usdc);
        messenger = ITokenMessengerV2(_messenger);
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        destinationDomain = _destinationDomain;
    }

    /// @notice Take the fee and burn the rest for minting on the destination.
    /// @param amount Total USDC to take from the caller, fee inclusive.
    /// @param mintRecipient Destination address, left-padded into bytes32.
    ///
    /// @dev `mintRecipient` is checked non-zero. CCTP would happily burn to a
    /// zero recipient and the USDC would be unrecoverable on both chains, which
    /// is the one mistake here that cannot be undone by anybody.
    function bridge(uint256 amount, bytes32 mintRecipient) external returns (uint256) {
        return _bridge(msg.sender, amount, mintRecipient);
    }

    /// @dev The payer is threaded through explicitly rather than read from
    /// `msg.sender` deeper in. `bridgeTo` originally called `this.bridge(...)`,
    /// an external self-call, which reset `msg.sender` to this contract and made
    /// the pull come from a balance the router does not have. It reverted every
    /// time. An internal function is the fix; the external wrappers are the only
    /// places `msg.sender` is read.
    function _bridge(address payer, uint256 amount, bytes32 mintRecipient) internal returns (uint256 bridgedAmount) {
        require(amount > 0, "amount");
        require(mintRecipient != bytes32(0), "recipient");

        uint256 fee = (amount * feeBps) / 10_000;
        bridgedAmount = amount - fee;
        // A dust amount that rounds entirely into the fee would charge someone
        // for bridging nothing.
        require(bridgedAmount > 0, "amount too small");

        require(usdc.transferFrom(payer, address(this), amount), "pull failed");
        if (fee > 0) require(usdc.transfer(feeRecipient, fee), "fee failed");

        // Approved for exactly this burn. depositForBurn consumes all of it, so
        // no allowance is left standing for the messenger afterwards.
        require(usdc.approve(address(messenger), bridgedAmount), "approve failed");
        messenger.depositForBurn(
            bridgedAmount,
            destinationDomain,
            mintRecipient,
            address(usdc),
            bytes32(0), // any address may relay the mint, including the user
            0,          // maxFee 0: standard transfer, no Circle fast-path fee
            STANDARD_FINALITY
        );

        emit Bridged(payer, mintRecipient, amount, fee, bridgedAmount);
    }

    /// @notice Convenience wrapper for the common case of an EOA destination.
    function bridgeTo(uint256 amount, address recipient) external returns (uint256) {
        require(recipient != address(0), "recipient");
        return _bridge(msg.sender, amount, bytes32(uint256(uint160(recipient))));
    }

    /// @notice Push any stranded USDC to the fee recipient.
    /// @dev Callable by anyone, and it is not an admin hatch: `feeRecipient` is
    /// immutable, so this can only ever move funds to the one address fixed at
    /// construction. It exists because `bridge` leaves nothing behind, so any
    /// balance here arrived by mistake, and without this it would be stuck
    /// forever. Adding an owner to recover it would be a strictly worse trade.
    function flush() external {
        uint256 bal = usdc.balanceOf(address(this));
        require(bal > 0, "nothing");
        require(usdc.transfer(feeRecipient, bal), "flush failed");
        emit Flushed(bal);
    }

    /// @notice What a given input would actually bridge, for display.
    /// @dev The UI must show this, not compute its own. A fee a user discovers
    /// after signing is indefensible whatever its size.
    function quote(uint256 amount) external view returns (uint256 fee, uint256 bridged) {
        fee = (amount * feeBps) / 10_000;
        bridged = amount - fee;
    }
}
