# Explorer verification bundles

One standard-JSON-input per deployed contract, with its ABI-encoded
constructor arguments. Use the standard-input form on the explorer, not the
flattened-source form: the flattened form usually has no field for `viaIR`,
and every contract in this repo is built with it, so verification silently
fails without it.

Settings come from `scripts/compile.js` and must stay in step with it.

## V3PositionLocker  0x55233aef2ecEE21a73a4655d9527D44eF13ba0d2

| Field | Value |
|---|---|
| Contract name | `V3PositionLocker` |
| Compiler | `v0.8.26+commit.8a97fa7a` |
| Optimization | enabled, 200 runs |
| EVM version | `paris` |
| Via IR | **yes** |
| License | MIT |
| Constructor arg | `_positionManager` = `0x3BdC3437405f7D801b6036532713fc1F179136a6` |

Deployed runtime is 2373 bytes and matches this source under these settings,
allowing for the metadata hash and the immutable `positionManager`.

## Not verifiable from this repo

`InstantLaunchpad` at `0x75FAdB240006313294A5B502CA9268cB03Fa9AC0` does NOT
match `contracts/InstantLaunchpad.sol`: 10463 bytes deployed against 12638
compiled. The repo source is a later revision. Its `launches()` returns eight
fields including `quote`, the deployed one returns seven without it, which is
the same mismatch that stopped `stats-indexer.js` from ever producing a figure.
Verifying it needs the revision that was actually deployed.

## Arc testnet — verified 2026-07-28

All six mintd contracts are verified on `testnet.arcscan.app`, submitted by
`scripts/verify-arc.js` using standard-json-input.

| contract | address |
|---|---|
| InstantLaunchpad | `0xd6fdA9A0Fd4b4ee724ab0c0B958a712E5bb37E96` |
| MINTR | `0x3e1184203B9c1760654CbEFCd111ce1185Ae57be` |
| TokenLocker | `0xAcc8EA03ea4722F23aE0b40Ac707e3fAAa8F6a6A` |
| V3PositionLocker | `0x8530b966C12E2d2493f712be9d5Cf39f364DD3B7` |
| TokenMetaRegistry | `0x09c419226e83A91323FDC170144526D8C4a39B75` |
| Furnace | `0x17E5C63ab0Ff682e5C1Cb2e391870d1a57104C5F` |

The explorer is Blockscout v11.2.3 with the Rust verifier microservice, so
submission is scriptable. Use standard-json-input, never flattened source: the
flattened form has no field for `viaIR`, which every contract here needs, and
it fails without saying why.

Constructor arguments are derived from `deployments/arc-testnet.json` rather
than retyped. A wrong argument fails verification in a way that looks exactly
like a wrong compiler setting, which is an expensive hour to spend.

### Still unverified on Arc

The DEX layer is deployed from npm artifacts built with their own compilers
(Uniswap V3 uses solc 0.7.6), so each needs its own settings and is not
covered by this script: WETH9, MintSwapFactory, MintSwapRouter,
UniswapV3Factory, NFTDescriptor, PositionDescriptor,
NonfungiblePositionManager, SwapRouter02, QuoterV2.

These are unmodified canonical Uniswap deployments. Verifying them is worth
doing, but nobody should take that on trust: the bytecode can be checked
against the npm artifacts directly.
