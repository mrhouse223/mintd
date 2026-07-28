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
