// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// A contract that looks exactly like a real Uniswap V3 pool to anything that
/// only reads token0/token1/fee/tickSpacing, while serving a TWAP its deployer
/// chooses. This is the shape of the attack the vault's canonical-pool check
/// exists to stop: the vault would derive every minimum swap output from this
/// forged `observe()` and then trade in the real pool at whatever price the
/// attacker had arranged.
///
/// It exists only so `test-agent-vault-factory.js` can prove the rejection is
/// real rather than assumed, and can prove the same for the hostile-pool
/// reentrancy path that the factory declines to guard against.
contract MockFakePool {
    address private _token0;
    address private _token1;
    uint24 public fee;
    int24 public tickSpacing;
    int24 public fakeTick;

    address public reenterTarget;
    bytes public reenterCalldata;
    uint256 public reenterAttempts;

    constructor(address t0, address t1, uint24 _fee, int24 _spacing, int24 _tick) {
        _token0 = t0;
        _token1 = t1;
        fee = _fee;
        tickSpacing = _spacing;
        fakeTick = _tick;
    }

    function setReentry(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterCalldata = data;
    }

    /// @dev Deliberately NOT `view`, while `AgentVault`'s interface declares it
    /// `view`. That mismatch is the whole test: solc compiles the vault's call
    /// into a STATICCALL, so the moment this function touches storage the EVM
    /// reverts it. A hostile pool cannot reenter the factory through the reads
    /// that happen before the canonical check, and this proves it at the EVM
    /// level rather than by reading the interface and assuming.
    function token0() external returns (address) {
        if (reenterTarget != address(0)) {
            reenterAttempts++; // reverts under STATICCALL, which is the point
            (bool ok, ) = reenterTarget.call(reenterCalldata);
            ok;
        }
        return _token0;
    }

    function token1() external view returns (address) {
        return _token1;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1) << 96, fakeTick, 0, 0, 0, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory liq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        liq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = int56(fakeTick) * int56(uint56(block.timestamp - secondsAgos[i]));
        }
    }

    function increaseObservationCardinalityNext(uint16) external {}
}
