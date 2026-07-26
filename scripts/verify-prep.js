// Prepares everything needed to verify contracts on stablescan.xyz:
//   1. build/standard-input.json — exact compiler input (upload this)
//   2. ABI-encoded constructor arguments for the launchpad and a token
//
//   LAUNCHPAD=0x... TOKEN=0x... node scripts/verify-prep.js
//
// On stablescan.xyz/verifyContract choose:
//   Compiler Type: Solidity (Standard-Json-Input)
//   Compiler Version: v0.8.26+commit.8a97fa7a
//   License: MIT
// then upload build/standard-input.json and paste the constructor args
// printed below (without the 0x prefix if the form complains).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const root = path.join(__dirname, "..");

async function main() {
  // 1. standard JSON input (settings must match scripts/compile.js exactly)
  const input = {
    language: "Solidity",
    sources: {
      "contracts/InstantLaunchpad.sol": {
        content: fs.readFileSync(path.join(root, "contracts", "InstantLaunchpad.sol"), "utf8"),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  const outPath = path.join(root, "build", "standard-input.json");
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));
  console.log(`wrote ${outPath}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // 2. launchpad constructor args (reads current config; matches deploy-time
  //    values as long as setConfig/setFeeRecipient haven't been called)
  const padAddr = process.env.LAUNCHPAD;
  if (padAddr) {
    const pad = new ethers.Contract(padAddr, [
      "function positionManager() view returns (address)",
      "function swapRouter() view returns (address)",
      "function usdt0() view returns (address)",
      "function feeRecipient() view returns (address)",
      "function creationFee() view returns (uint256)",
      "function creatorShareBps() view returns (uint256)",
      "function startPriceUsdt1e18() view returns (uint256)",
    ], provider);
    const vals = await Promise.all([
      pad.positionManager(), pad.swapRouter(), pad.usdt0(), pad.feeRecipient(),
      pad.creationFee(), pad.creatorShareBps(), pad.startPriceUsdt1e18(),
    ]);
    const enc = coder.encode(
      ["address", "address", "address", "address", "uint256", "uint256", "uint256"], vals
    );
    console.log(`InstantLaunchpad ${padAddr}`);
    console.log(`  contract name: InstantLaunchpad`);
    console.log(`  constructor args: ${enc.slice(2)}\n`);
    if (process.env.FEE_RECIPIENT_CHANGED) {
      console.log("  NOTE: if you changed feeRecipient/fees since deploy, use the ORIGINAL values.\n");
    }
  }

  // 3. token constructor args (name, symbol, metadataURI, supply, launchpad)
  const tokAddr = process.env.TOKEN;
  if (tokAddr) {
    if (!padAddr) throw new Error("TOKEN also requires LAUNCHPAD (it is the mint recipient)");
    const tok = new ethers.Contract(tokAddr, [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function metadataURI() view returns (string)",
      "function totalSupply() view returns (uint256)",
    ], provider);
    const [name, symbol, uri, supply] = await Promise.all([
      tok.name(), tok.symbol(), tok.metadataURI(), tok.totalSupply(),
    ]);
    const enc = coder.encode(
      ["string", "string", "string", "uint256", "address"], [name, symbol, uri, supply, padAddr]
    );
    console.log(`MemeToken20 ${tokAddr} ($${symbol})`);
    console.log(`  contract name: MemeToken20`);
    console.log(`  constructor args: ${enc.slice(2)}\n`);
  }

  if (!padAddr && !tokAddr) {
    console.log("Set LAUNCHPAD=0x... and/or TOKEN=0x... to print constructor args.");
  }
  console.log("Verify at: https://stablescan.xyz/verifyContract");
  console.log("Once one MemeToken20 is verified, every future launched token");
  console.log("auto-displays as verified (identical-bytecode match).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
