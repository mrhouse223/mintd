// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./MintdLaunchpad.sol";

/// ----------------------------------------------------------------------------
/// ArcSwapLaunchpad — the arcswap.vip launchpad on Arc mainnet.
///
/// WHY THIS IS A SUBCLASS AND NOT A COPY
/// The only difference from `MintdLaunchpad` is the name an explorer shows, and
/// there are two obvious ways to get that which are both worse:
///
///   - Renaming `MintdLaunchpad` itself is wrong, because that same source is
///     what mintd.fun runs on Stable. The contract behind mintd.fun would end up
///     labelled ArcSwap.
///   - Copying the file is worse still. It would be the FOURTH declaration of
///     `MemeToken20` in this repo, and CLAUDE.md documents what that does:
///     artifacts are keyed by contract NAME, so `build/MemeToken20.json` is
///     overwritten by whichever file compiled last, the metadata hash differs
///     between identical sources, and that silently broke CREATE2 address
///     prediction once already. It would also be 700 lines free to diverge.
///
/// Inheriting adds no logic and no state. Every rule, bound and fee path is the
/// reviewed code in the parent, unchanged, so this needs no separate audit of
/// its behaviour: there is none to audit. `predictToken` still hashes the one
/// `MemeToken20` in the parent file, so launch addresses stay correct.
///
/// TOKEN BRANDING IS NOT IN HERE
/// $ARCS is a launchpad token like any other: its name and symbol are set when it
/// is launched, not compiled in. Making it the platform token is a frontend
/// config change once its address exists, not a contract change. Nothing about
/// burning or buyback is hardcoded anywhere in this path; the protocol share
/// goes to whatever addresses are configured, and the field named "buyback" is
/// only a label on a transfer.
/// ----------------------------------------------------------------------------
contract ArcSwapLaunchpad is MintdLaunchpad {
    constructor(
        address _owner,
        address _positionManager,
        address _swapRouter,
        address _quoteToken,
        address _buybackRecipient,
        address _opsRecipient,
        uint256 _creationFee,
        uint256 _creatorShareBps,
        uint256 _buybackShareBps,
        uint256 _devBuyCapBps,
        uint256 _startPriceQuote1e18,
        address _mintr,
        uint256 _startPriceMintr1e18
    )
        MintdLaunchpad(
            _owner,
            _positionManager,
            _swapRouter,
            _quoteToken,
            _buybackRecipient,
            _opsRecipient,
            _creationFee,
            _creatorShareBps,
            _buybackShareBps,
            _devBuyCapBps,
            _startPriceQuote1e18,
            _mintr,
            _startPriceMintr1e18
        )
    {}
}
