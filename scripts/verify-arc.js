// Verify the mintd contracts on the Arc testnet explorer (Blockscout).
//
//   node scripts/verify-arc.js            # show status only
//   node scripts/verify-arc.js --submit   # submit unverified ones
//
// Uses standard-json-input, not flattened source. The flattened form has no
// field for viaIR, and every contract in this repo is built with it, so a
// flattened submission fails with no useful reason given.
//
// Constructor arguments are read from the deployment record and the chain
// rather than retyped, since a wrong argument fails verification in a way that
// looks identical to a wrong compiler setting.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const REC = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "arc-testnet.json"), "utf8"));
const C = REC.contracts;
const EXPLORER = "https://testnet.arcscan.app";
const COMPILER = "v0.8.26+commit.8a97fa7a";
const SUBMIT = process.argv.includes("--submit");

// Settings must match scripts/compile.js exactly or the bytecode will not
// reproduce. viaIR is the one people forget.
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  evmVersion: "paris",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
};

const enc = (types, vals) => new ethers.AbiCoder().encode(types, vals).slice(2);

// Only our own contracts. The Uniswap and WETH deployments come from npm
// artifacts built with a different compiler and would each need their own
// settings; they are listed at the end as knowingly unverified.
const TARGETS = [
  // The fixed launchpad now live as the primary Arc pad. Owner-first
  // constructor, 13 args, matching scripts/deploy-arc-mintd.js exactly.
  { name: "MintdLaunchpad", file: "MintdLaunchpad.sol", addr: C.MintdLaunchpad,
    args: enc(
      ["address", "address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
      [REC.deployer, C.NonfungiblePositionManager, C.SwapRouter02, REC.gasToken.address,
       REC.deployer, REC.deployer,
       ethers.parseEther("1"), 8000n, 8000n, 500n, 3000000000000n, C.MINTR, 3000000000000n]) },
  { name: "MintdMetaRegistry", file: "TokenMetaRegistry.sol", addr: C.MintdMetaRegistry,
    args: enc(["address[]"], [[C.ArcLaunchpad, C.MintdLaunchpad].filter(Boolean)]) },
  { name: "ArcLaunchpad", file: "ArcLaunchpad.sol", addr: C.ArcLaunchpad,
    args: enc(
      ["address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
      [C.NonfungiblePositionManager, C.SwapRouter02, REC.gasToken.address,
       REC.deployer, REC.deployer,
       ethers.parseEther("1"), 8000n, 8000n, 3000000000000n, C.MINTR, 3000000000000n]) },
  { name: "Furnace", file: "Furnace.sol", addr: C.Furnace, args: "" },
  { name: "TokenMetaRegistry", file: "TokenMetaRegistry.sol", addr: C.TokenMetaRegistry,
    args: enc(["address[]"], [[C.InstantLaunchpad]]) },
  { name: "V3PositionLocker", file: "V3PositionLocker.sol", addr: C.V3PositionLocker,
    args: enc(["address"], [C.NonfungiblePositionManager]) },
  { name: "TokenLocker", file: "TokenLocker.sol", addr: C.TokenLocker,
    args: enc(["address", "uint256"], [REC.deployer, ethers.parseEther("1")]) },
  { name: "MINTR", file: "MINTR.sol", addr: C.MINTR,
    args: enc(["address", "address"], [REC.gasToken.address, REC.deployer]) },
  { name: "InstantLaunchpad", file: "InstantLaunchpad.sol", addr: C.InstantLaunchpad,
    args: enc(
      ["address", "address", "address", "address", "uint256", "uint256", "uint256", "address", "uint256"],
      [C.NonfungiblePositionManager, C.SwapRouter02, REC.gasToken.address, REC.deployer,
       ethers.parseEther("1"), 9000n, 3000000000000n, C.MINTR, 3000000000000n]) },
];

const UNVERIFIABLE_HERE = ["WETH9", "MintSwapFactory", "MintSwapRouter", "UniswapV3Factory",
  "NFTDescriptor", "PositionDescriptor", "NonfungiblePositionManager", "SwapRouter02", "QuoterV2"];

async function status(addr) {
  try {
    const r = await fetch(`${EXPLORER}/api/v2/smart-contracts/${addr}`);
    if (!r.ok) return "unknown";
    const j = await r.json();
    return j.is_verified ? "verified" : "unverified";
  } catch { return "unreachable"; }
}

async function submit(t) {
  const src = fs.readFileSync(path.join(ROOT, "contracts", t.file), "utf8");
  const input = { language: "Solidity", sources: { [t.file]: { content: src } }, settings: SETTINGS };

  const fd = new FormData();
  fd.append("compiler_version", COMPILER);
  fd.append("license_type", "mit");
  fd.append("autodetect_constructor_args", "false");
  fd.append("constructor_args", t.args ? "0x" + t.args : "");
  fd.append("files[0]", new Blob([JSON.stringify(input)], { type: "application/json" }), `${t.name}.json`);

  const r = await fetch(`${EXPLORER}/api/v2/smart-contracts/${t.addr}/verification/via/standard-input`, {
    method: "POST", body: fd,
  });
  const text = await r.text();
  return { ok: r.ok, code: r.status, body: text.slice(0, 200) };
}

(async () => {
  console.log(`explorer ${EXPLORER}`);
  console.log(`compiler ${COMPILER}, optimizer 200, viaIR true, evmVersion paris\n`);

  for (const t of TARGETS) {
    if (!t.addr) { console.log(`  ${t.name.padEnd(19)} not deployed`); continue; }
    const before = await status(t.addr);
    if (before === "verified") { console.log(`  ${t.name.padEnd(19)} already verified`); continue; }
    if (!SUBMIT) { console.log(`  ${t.name.padEnd(19)} ${before}  ->  would submit`); continue; }

    process.stdout.write(`  ${t.name.padEnd(19)} submitting... `);
    const res = await submit(t);
    if (!res.ok) { console.log(`HTTP ${res.code}  ${res.body}`); continue; }
    // the verifier is asynchronous; poll briefly for the result
    let final = "pending";
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      final = await status(t.addr);
      if (final === "verified") break;
    }
    console.log(final === "verified" ? "VERIFIED" : `still ${final}  (${res.body})`);
  }

  console.log("\nnot attempted here (built from npm artifacts with other compilers):");
  for (const n of UNVERIFIABLE_HERE) if (C[n]) console.log(`  ${n.padEnd(28)} ${C[n]}`);
  console.log(`\nexplorer: ${EXPLORER}/address/${C.InstantLaunchpad}`);
})().catch((e) => { console.error("\n" + (e.message || e) + "\n"); process.exit(1); });
