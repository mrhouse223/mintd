// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// FeeClaimAll — batch trigger for launchpad fee claims.
///
/// The launchpad's `claimFees(token)` is already permissionless, and it always
/// pays the same two places: the token's creator and the launchpad's
/// feeRecipient. This contract only calls it in a loop. It therefore:
///
///   - holds no funds, ever
///   - has no owner, no admin, no withdraw
///   - cannot redirect a single unit of anyone's fees
///
/// Anyone may call any function here. The only thing a caller can accomplish is
/// paying gas to move other people's fees to the destinations the launchpad
/// already hardcodes.
///
/// One token failing must not strand the rest, so every claim is wrapped in
/// try/catch and the batch reports counts instead of reverting.
/// ----------------------------------------------------------------------------

interface ILaunchpadFees {
    function claimFees(address token) external;
    function tokenCount() external view returns (uint256);
    function allTokens(uint256 index) external view returns (address);
    function feeRecipient() external view returns (address);
    // launches() is deliberately NOT declared here. Stable's deployed bytecode
    // returns 7 fields; the newer repo source returns 8. A typed call would
    // decode against exactly one of them and revert on the other. See
    // _creatorOf, which reads only the two leading words both shapes share.
}

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
}

contract FeeClaimAll {
    struct Pending {
        address token;
        address creator;
        uint256 creatorQuote;
        uint256 creatorToken;
        uint256 protocolQuote;
        uint256 protocolToken;
        bool ok; // false if claimFees reverted for this token
    }

    event BatchClaimed(address indexed launchpad, address indexed caller, uint256 claimed, uint256 failed);

    // ------------------------------------------------------------------ claim

    /// @notice Claim fees for an explicit list of tokens.
    /// @dev Pass only tokens that `preview` showed as non-zero. Claiming a
    /// token with no accrued fees still pays for a `collect` call and returns
    /// nothing.
    function claimAll(address launchpad, address[] calldata tokens)
        public
        returns (uint256 claimed, uint256 failed)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            try ILaunchpadFees(launchpad).claimFees(tokens[i]) {
                claimed++;
            } catch {
                failed++;
            }
        }
        emit BatchClaimed(launchpad, msg.sender, claimed, failed);
    }

    /// @notice Claim fees for `count` tokens starting at index `start` of the
    /// launchpad's own token list. Bounded so a 120-token launchpad does not
    /// have to fit in one block's gas.
    function claimRange(address launchpad, uint256 start, uint256 count)
        external
        returns (uint256 claimed, uint256 failed)
    {
        address[] memory tokens = _slice(launchpad, start, count);
        for (uint256 i = 0; i < tokens.length; i++) {
            try ILaunchpadFees(launchpad).claimFees(tokens[i]) {
                claimed++;
            } catch {
                failed++;
            }
        }
        emit BatchClaimed(launchpad, msg.sender, claimed, failed);
    }

    // ---------------------------------------------------------------- preview

    /// @notice Pending fees per token, split into the creator's share and the
    /// protocol's share.
    ///
    /// NOT a view function, and it must not be sent as a transaction. There is
    /// no way to read accrued Uniswap V3 fees without calling `collect`, which
    /// mutates, so this actually performs the claim and measures the balance
    /// deltas it produced. Call it with `eth_call` (ethers: `.staticCall()`)
    /// and nothing is committed.
    ///
    /// If a token's creator is also the feeRecipient, that address receives
    /// both shares and both fields are populated; do not add them across
    /// tokens without deduplicating by address.
    function preview(address launchpad, address[] memory tokens, address quoteToken)
        public
        returns (Pending[] memory out)
    {
        address protocol = ILaunchpadFees(launchpad).feeRecipient();
        out = new Pending[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            address creator = _creatorOf(launchpad, t);

            out[i].token = t;
            out[i].creator = creator;

            uint256 cq = IERC20Bal(quoteToken).balanceOf(creator);
            uint256 pq = IERC20Bal(quoteToken).balanceOf(protocol);
            uint256 ct = IERC20Bal(t).balanceOf(creator);
            uint256 pt = IERC20Bal(t).balanceOf(protocol);

            try ILaunchpadFees(launchpad).claimFees(t) {
                out[i].ok = true;
                out[i].creatorQuote = IERC20Bal(quoteToken).balanceOf(creator) - cq;
                out[i].protocolQuote = IERC20Bal(quoteToken).balanceOf(protocol) - pq;
                out[i].creatorToken = IERC20Bal(t).balanceOf(creator) - ct;
                out[i].protocolToken = IERC20Bal(t).balanceOf(protocol) - pt;
            } catch {
                out[i].ok = false;
            }
        }
    }

    /// @notice `preview` over a slice of the launchpad's own token list.
    function previewRange(address launchpad, uint256 start, uint256 count, address quoteToken)
        external
        returns (Pending[] memory)
    {
        return preview(launchpad, _slice(launchpad, start, count), quoteToken);
    }

    /// @notice Total pending quote-asset fees owed to one address across a
    /// slice, counting both its creator positions and, if it is the
    /// feeRecipient, the protocol share. Convenience for a dashboard header.
    function pendingFor(address launchpad, address who, uint256 start, uint256 count, address quoteToken)
        external
        returns (uint256 quoteTotal, uint256 tokensWithFees)
    {
        Pending[] memory p = preview(launchpad, _slice(launchpad, start, count), quoteToken);
        bool isProtocol = ILaunchpadFees(launchpad).feeRecipient() == who;
        for (uint256 i = 0; i < p.length; i++) {
            // Counted once, never summed. When `who` is both the token's
            // creator and the feeRecipient, the two balance snapshots inside
            // preview() track the SAME address, so each leg already reports the
            // full collected amount. Adding them reported double.
            uint256 owed;
            if (p[i].creator == who) owed = p[i].creatorQuote;
            else if (isProtocol) owed = p[i].protocolQuote;
            if (owed > 0) {
                quoteTotal += owed;
                tokensWithFees++;
            }
        }
    }

    // ------------------------------------------------------------------- util

    /// @dev Reads `launches(token).creator` without committing to the struct's
    /// length. Both the deployed Stable launchpad (7 fields) and the newer
    /// source (8 fields) lead with `address token, address creator`, and
    /// abi.decode reads only the words it is asked for, so decoding the first
    /// two is valid against either. Returns the zero address if the call fails
    /// or is too short, which `preview` reports as a zero creator rather than
    /// reverting the whole batch.
    function _creatorOf(address launchpad, address token) internal view returns (address creator) {
        (bool ok, bytes memory data) =
            launchpad.staticcall(abi.encodeWithSignature("launches(address)", token));
        if (!ok || data.length < 64) return address(0);
        (, creator) = abi.decode(data, (address, address));
    }

    function _slice(address launchpad, uint256 start, uint256 count)
        internal
        view
        returns (address[] memory tokens)
    {
        uint256 total = ILaunchpadFees(launchpad).tokenCount();
        if (start >= total) return new address[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        tokens = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            tokens[i - start] = ILaunchpadFees(launchpad).allTokens(i);
        }
    }
}
