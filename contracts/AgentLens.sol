// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// AgentLens — read every agent vault in ONE call.
///
/// WHY THIS EXISTS
/// Rendering the Agent page from the chain took about fifteen sequential reads
/// per vault: owner, agent, pool, mode, position, both tokens with their symbol
/// and decimals, the pool's tick and fee, the NPM position, then the policy.
/// Arc accepts a burst and then rate limits it, so with a handful of vaults the
/// page produced a storm of failing requests, and retrying each one made it
/// worse rather than better: a thundering herd against a rate limiter.
///
/// A community creating vaults makes that strictly worse, and it is the exact
/// moment the page has to work. So the reads move on chain: one eth_call
/// returns everything the page draws, for as many vaults as it asks for.
///
/// Holds nothing, owns nothing, and every function is `view`. It cannot be used
/// to move a token, and a wrong answer here can only mis-draw a page, never
/// mis-execute a transaction: the vault re-derives every value-carrying number
/// itself when it acts.
/// ----------------------------------------------------------------------------

interface IAgentFactory {
    function vaultCount() external view returns (uint256);
    function allVaultsSlice(uint256 start, uint256 count) external view returns (address[] memory);
}

interface IAgentVault {
    function owner() external view returns (address);
    function agent() external view returns (address);
    function pool() external view returns (address);
    function npm() external view returns (address);
    function mode() external view returns (uint8);
    function positionId() external view returns (uint256);
    function valueCheckpoint() external view returns (uint256);
    function valueInToken0() external view returns (bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function valueNow() external view returns (uint256);
    function maxTickDrift() external view returns (int24);
    function maxSlippageBps() external view returns (uint256);
    function lossToleranceBps() external view returns (uint256);
    function reviewWindow() external view returns (uint256);
    function twapWindow() external view returns (uint32);
    function cooldown() external view returns (uint256);
    function proposal() external view returns (int24 lower, int24 upper, uint64 readyAt, bool approved, bool open, uint256 nonce);
}

interface ILensPool {
    function slot0() external view returns (uint160, int24 tick, uint16, uint16 card, uint16, uint8, bool);
    function fee() external view returns (uint24);
}

interface ILensNpm {
    function positions(uint256) external view returns (
        uint96, address, address, address, uint24, int24 tickLower, int24 tickUpper,
        uint128 liquidity, uint256, uint256, uint128, uint128);
}

interface ILensErc20 {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

contract AgentLens {
    struct TokenInfo {
        address addr;
        string symbol;
        uint8 decimals;
        bool decimalsOk;
    }

    struct VaultInfo {
        address vault;
        address owner;
        address agent;
        address pool;
        uint8 mode;
        uint256 positionId;
        uint256 checkpoint;
        bool valueInToken0;
        TokenInfo token0;
        TokenInfo token1;
        uint24 fee;
        int24 tick;
        uint16 observationCardinality;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 value;
        /// @dev False when `valueNow()` reverted, which happens legitimately on
        /// a pool that cannot yet produce a TWAP. The page must show that as a
        /// state, not as a zero, because a vault holding funds and reporting
        /// zero is the single most alarming thing it could display.
        bool valueOk;
        int24 maxTickDrift;
        uint256 maxSlippageBps;
        uint256 lossToleranceBps;
        uint256 reviewWindow;
        uint32 twapWindow;
        uint256 cooldown;
        bool proposalOpen;
        int24 proposalLower;
        int24 proposalUpper;
    }

    function vaultCount(address factory) external view returns (uint256) {
        return IAgentFactory(factory).vaultCount();
    }

    /// @notice Everything the Agent page draws, for a page of vaults.
    /// @dev Newest first. A community list only ever grows at the tail, and the
    /// vaults someone wants to see are the ones just created, not the first
    /// ever made.
    function vaults(address factory, uint256 start, uint256 count)
        external
        view
        returns (VaultInfo[] memory out, uint256 total)
    {
        total = IAgentFactory(factory).vaultCount();
        if (start >= total || count == 0) return (new VaultInfo[](0), total);
        uint256 n = total - start;
        if (n > count) n = count;
        out = new VaultInfo[](n);
        for (uint256 i = 0; i < n; i++) {
            // Newest first: index counts back from the end of the list.
            address[] memory one = IAgentFactory(factory).allVaultsSlice(total - 1 - start - i, 1);
            out[i] = _read(one[0]);
        }
    }

    function vaultsAt(address[] calldata addrs) external view returns (VaultInfo[] memory out) {
        out = new VaultInfo[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) out[i] = _read(addrs[i]);
    }

    function _read(address a) internal view returns (VaultInfo memory v) {
        IAgentVault vault = IAgentVault(a);
        v.vault = a;
        v.owner = vault.owner();
        v.agent = vault.agent();
        v.pool = vault.pool();
        v.mode = vault.mode();
        v.positionId = vault.positionId();
        v.checkpoint = vault.valueCheckpoint();
        v.valueInToken0 = vault.valueInToken0();
        v.token0 = _token(vault.token0());
        v.token1 = _token(vault.token1());

        (, int24 tick, , uint16 card, , , ) = ILensPool(v.pool).slot0();
        v.tick = tick;
        v.observationCardinality = card;
        v.fee = ILensPool(v.pool).fee();

        if (v.positionId != 0) {
            (, , , , , int24 lo, int24 hi, uint128 liq, , , , ) = ILensNpm(vault.npm()).positions(v.positionId);
            v.tickLower = lo;
            v.tickUpper = hi;
            v.liquidity = liq;
        }

        // Reverts when the pool has no TWAP yet. Caught so one unarmed pool
        // cannot blank the whole page for every other vault in the list.
        try vault.valueNow() returns (uint256 val) { v.value = val; v.valueOk = true; }
        catch { v.valueOk = false; }

        v.maxTickDrift = vault.maxTickDrift();
        v.maxSlippageBps = vault.maxSlippageBps();
        v.lossToleranceBps = vault.lossToleranceBps();
        v.reviewWindow = vault.reviewWindow();
        v.twapWindow = vault.twapWindow();
        v.cooldown = vault.cooldown();
        (int24 pl, int24 pu, , , bool open, ) = vault.proposal();
        v.proposalOpen = open;
        v.proposalLower = pl;
        v.proposalUpper = pu;
    }

    /// @dev Symbol and decimals are both wrapped. A token that does not
    /// implement them is not this contract's problem to solve, but it must not
    /// take the whole page down with it. `decimalsOk` is reported rather than
    /// defaulted: guessing 18 for a 6-decimal token is a 1,000,000x error on a
    /// financial figure, so the caller has to see that the read failed.
    function _token(address t) internal view returns (TokenInfo memory info) {
        info.addr = t;
        try ILensErc20(t).symbol() returns (string memory s) { info.symbol = s; } catch { info.symbol = "?"; }
        try ILensErc20(t).decimals() returns (uint8 d) { info.decimals = d; info.decimalsOk = true; }
        catch { info.decimalsOk = false; }
    }
}
