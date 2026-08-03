// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath, TickMath} from "../AgentVault.sol";

/// Test doubles for BuybackVault. The pool serves a real TWAP from a tick the
/// test sets, and the router prices off that SAME tick, so the vault's own
/// minimum-output maths is what is under test rather than a price the mock
/// invented. `discountBps` is the sandwich: the router pays under the TWAP and
/// the vault has to refuse it.

contract MockTwapPool {
    address public token0;
    address public token1;
    uint24 public fee;
    int24 public tick;
    uint16 public cardinality = 2;
    uint32 public newestObs = 1;   // freshness the vault now checks
    bool public obsInit = true;

    constructor(address a, address b, uint24 _fee) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = _fee;
    }
    function setTick(int24 t) external { tick = t; newestObs = uint32(block.timestamp); }
    function setCardinality(uint16 c) external { cardinality = c; }
    function setNewestObs(uint32 t) external { newestObs = t; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, tick, 0, cardinality, 0, 0, true);
    }
    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (newestObs, 0, 0, obsInit);
    }
    function increaseObservationCardinalityNext(uint16 n) external { cardinality = n; }

    /// Cumulatives grow linearly at `tick`, so any window averages to `tick`.
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory cum, uint160[] memory liq)
    {
        cum = new int56[](secondsAgos.length);
        liq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            // Later timestamps have larger cumulatives; secondsAgos[0] is oldest.
            cum[i] = int56(tick) * int56(uint56(1_000_000 - secondsAgos[i]));
        }
    }
}

contract MockV3Factory {
    mapping(bytes32 => address) private pools;
    function set(address a, address b, uint24 fee, address pool) external {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pools[keccak256(abi.encode(t0, t1, fee))] = pool;
    }
    function getPool(address a, address b, uint24 fee) external view returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return pools[keccak256(abi.encode(t0, t1, fee))];
    }
}

interface IERC20T {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract MockTwapRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    MockTwapPool public pool;
    uint256 public discountBps; // how far under the TWAP this router fills

    constructor(address _pool) { pool = MockTwapPool(_pool); }
    function setDiscount(uint256 bps) external { discountBps = bps; }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        require(IERC20T(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn), "pull");
        uint256 sp = uint256(TickMath.getSqrtRatioAtTick(pool.tick()));
        uint256 Q96 = 1 << 96;
        // Same two-step squaring the vault uses, so both agree at zero discount.
        out = p.tokenIn == pool.token0()
            ? FullMath.mulDiv(FullMath.mulDiv(p.amountIn, sp, Q96), sp, Q96)
            : FullMath.mulDiv(FullMath.mulDiv(p.amountIn, Q96, sp), Q96, sp);
        out = (out * (10000 - discountBps)) / 10000;
        // The real router's error string, so the vault's guard is tested against
        // the message a caller would actually see.
        require(out >= p.amountOutMinimum, "Too little received");
        require(IERC20T(p.tokenOut).transfer(p.recipient, out), "pay");
    }
}
