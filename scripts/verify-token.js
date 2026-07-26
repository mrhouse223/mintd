// Prepares verification data for a STANDALONE-launched MemeToken20 (one
// deployed by launch-v3-standalone.js, where the full supply was minted to a
// wallet rather than to the launchpad).
//
//   TOKEN=0x... node scripts/verify-token.js
//
// It auto-detects the mint recipient from the token's genesis Transfer event,
// so you don't have to remember which wallet deployed it. Writes the exact
// compiler input to build/standard-input-token.json and prints the ABI-encoded
// constructor args.
//
// On https://stablescan.xyz/verifyContract choose:
//   Compiler Type:    Solidity (Standard-Json-Input)
//   Compiler Version: v0.8.26+commit.8a97fa7a
//   License:          MIT
// upload the JSON file, set contract name to MemeToken20, paste the args.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const root = path.join(__dirname, "..");

async function main() {
  const tokAddr = process.env.TOKEN;
  if (!tokAddr) throw new Error("Set TOKEN=0x... (the token contract address)");

  // 1. exact compiler input (settings MUST match scripts/compile.js)
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
  const outPath = path.join(root, "build", "standard-input-token.json");
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));
  console.log(`wrote ${outPath}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const tok = new ethers.Contract(tokAddr, [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function metadataURI() view returns (string)",
    "function totalSupply() view returns (uint256)",
  ], provider);
  const [name, symbol, uri, supply] = await Promise.all([
    tok.name(), tok.symbol(), tok.metadataURI().catch(() => ""), tok.totalSupply(),
  ]);

  // 2. find the mint recipient: the genesis Transfer(0x0 -> recipient)
  let recipient = process.env.RECIPIENT || null;
  if (!recipient) {
    // binary search for the deployment block (first block where code exists),
    // then read the genesis Transfer from that exact block. ~25 RPC calls.
    const head = await provider.getBlockNumber();
    let lo = 0, hi = head;
    process.stdout.write("finding deployment block");
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      process.stdout.write(".");
      const code = await provider.getCode(tokAddr, mid).catch(() => "0x");
      if (code && code !== "0x") hi = mid; else lo = mid + 1;
    }
    console.log(` block ${lo}`);
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const zeroTopic = ethers.zeroPadValue("0x0000000000000000000000000000000000000000", 32);
    const logs = await provider.getLogs({
      address: tokAddr, topics: [transferTopic, zeroTopic],
      fromBlock: Math.max(0, lo - 2), toBlock: lo + 2,
    }).catch(() => []);
    if (logs.length) recipient = ethers.getAddress("0x" + logs[0].topics[2].slice(26));
  }
  if (!recipient) throw new Error("Could not find the mint recipient; pass RECIPIENT=0x... explicitly");

  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address"], [name, symbol, uri, supply, recipient]
  );

  console.log(`MemeToken20 ${tokAddr}  ($${symbol})`);
  console.log(`  name:            ${name}`);
  console.log(`  supply:          ${ethers.formatEther(supply)}`);
  console.log(`  metadataURI:     ${uri === "" ? "(empty)" : uri}`);
  console.log(`  mint recipient:  ${recipient}`);
  console.log(`\n  contract name:     MemeToken20`);
  console.log(`  compiler version:  v0.8.26+commit.8a97fa7a`);
  console.log(`  optimizer:         enabled, 200 runs, viaIR true, evmVersion paris`);
  console.log(`  constructor args:  ${enc.slice(2)}`);
  console.log(`\nUpload ${path.relative(process.cwd(), outPath)} at https://stablescan.xyz/verifyContract`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
