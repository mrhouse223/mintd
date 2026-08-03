// Compiles contracts with solc-js and writes artifacts to build/.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const sources = {};
for (const rel of [
  "contracts/StableLaunchpad.sol",
  "contracts/InstantLaunchpad.sol",
  "contracts/StakingRewards.sol",
  "contracts/ZapIn.sol",
  "contracts/ZapRouter.sol",
  "contracts/ZapV3.sol",
  "contracts/WrapZap.sol",
  "contracts/MINTR.sol",
  "contracts/BuybackBurner.sol",
  "contracts/TokenLocker.sol",
  "contracts/TokenMetaRegistry.sol",
  "contracts/MintSynth.sol",
  "contracts/V3PositionLocker.sol",
  "contracts/MintrArb.sol",
  "contracts/MintrArbMulti.sol",
  "contracts/test/MockPads.sol",
  "contracts/test/MockAggregator.sol",
  "contracts/test/WETH9.sol",
  "contracts/FarmRewards.sol",
  "contracts/test/MockRouter.sol",
  "contracts/test/MockUSDT0.sol",
  "contracts/Furnace.sol",
  "contracts/test/MockFeeToken.sol",
  "contracts/test/MockFakePool.sol",
  "contracts/test/TestToken.sol",
  "contracts/test/MockTokenMessenger.sol",
  // ArcLaunchpad redeclares MemeToken20 verbatim from InstantLaunchpad, and
  // artifacts are keyed by contract NAME, so build/MemeToken20.json is written
  // twice and the last one wins. The two are NOT interchangeable even though
  // the source is identical: solc appends a metadata hash derived from the
  // source file, so the creation code differs in its tail and therefore so
  // does its keccak. That silently broke CREATE2 address prediction once, and
  // which copy survives depends on the order of this list.
  // The ABI and runtime behaviour are the same, so it is safe for tests that
  // only need to call a token. Anything needing the creation-code hash must
  // use ArcLaunchpad.predictToken instead of deriving it from the artifact.
  "contracts/ArcLaunchpad.sol",
  "contracts/FeeClaimAll.sol",
  "contracts/FeeSplitter.sol",
  // Third declaration of MemeToken20, after InstantLaunchpad and ArcLaunchpad.
  // Same caveat: identical source, different metadata hash, so the artifact is
  // whichever compiled last. Use predictToken() for CREATE2 addresses.
  "contracts/MintdLaunchpad.sol",
  "contracts/AgentVault.sol",
  "contracts/AgentVaultFactory.sol",
  "contracts/AgentLens.sol",
  "contracts/BridgeFeeRouter.sol",
  "contracts/ArcSwapLaunchpad.sol",
  "contracts/WraxToken.sol",
  "contracts/BondMarket.sol",
  "contracts/BuybackVault.sol",
  "contracts/BuybackVaultFactory.sol",
  "contracts/test/MockTwap.sol",
  "contracts/test/ReentrantBuyer.sol",
]) {
  sources[rel] = { content: fs.readFileSync(path.join(root, rel), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const e of out.errors || []) console.warn(e.formattedMessage);

fs.mkdirSync(path.join(root, "build"), { recursive: true });
for (const file of Object.keys(out.contracts)) {
  for (const name of Object.keys(out.contracts[file])) {
    const c = out.contracts[file][name];
    fs.writeFileSync(
      path.join(root, "build", `${name}.json`),
      JSON.stringify({ contractName: name, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log(`compiled ${name} (${c.evm.bytecode.object.length / 2} bytes)`);
  }
}
