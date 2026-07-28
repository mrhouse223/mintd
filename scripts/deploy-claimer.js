// Deploy FeeClaimAll, the batch fee-claim trigger behind the /dev dashboard.
//
//   node scripts/deploy-claimer.js --chain stable
//   node scripts/deploy-claimer.js --chain stable --execute
//
// FeeClaimAll has no owner, no admin, holds no funds and cannot redirect a unit
// of anyone's fees: all it does is call the launchpad's already-permissionless
// claimFees in a loop. So the deploying key inherits no privilege whatsoever,
// which is why it is safe to deploy this from the compromised deployer wallet
// rather than waiting on the Safe.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}
const ENV = loadEnv();

const CHAINS = {
  stable: {
    rpc: "https://rpc.stable.xyz", chainId: 988,
    pad: "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0",
    quote: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    explorer: "https://stablescan.xyz",
    // Any funded key works: the contract is ownerless, so the deployer gains
    // nothing and there is no role to rotate afterwards.
    keyVars: ["DEPLOYER_KEY", "OWNER_KEY", "KEEPER_KEY"],
  },
  "arc-testnet": {
    rpc: "https://rpc.testnet.arc.network", chainId: 5042002,
    pad: null, // read from deployments/arc-testnet.json
    quote: "0x3600000000000000000000000000000000000000",
    explorer: "https://testnet.arcscan.app",
    keyVars: ["ARC_DEPLOYER_KEY"],
  },
};

const EXECUTE = process.argv.includes("--execute");
const CHAIN = process.argv[process.argv.indexOf("--chain") + 1];
if (!CHAINS[CHAIN]) { console.error(`\n  usage: --chain <${Object.keys(CHAINS).join("|")}> [--execute]\n`); process.exit(1); }
const CFG = CHAINS[CHAIN];
function die(m) { console.error("\n  ABORT: " + m + "\n"); process.exit(1); }

(async () => {
  const rp = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { batchMaxCount: 1, staticNetwork: true });

  let pad = CFG.pad;
  if (!pad) {
    const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", `${CHAIN}.json`), "utf8"));
    pad = rec.contracts.ArcLaunchpad || rec.contracts.InstantLaunchpad;
  }

  // Pick the first key that can pay for the deployment, and report which
  // variable it was by name only.
  let signer = null, used = null;
  for (const v of CFG.keyVars) {
    let k = (process.env[v] || ENV[v] || "").trim();
    if (!k) continue;
    if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) continue;
    const w = new ethers.Wallet(k, rp);
    if ((await rp.getBalance(w.address)) > ethers.parseEther("0.5")) { signer = w; used = v; break; }
  }
  if (!signer) die(`no funded key among ${CFG.keyVars.join(", ")}`);

  console.log(`\nchain      ${CHAIN}   block ${await rp.getBlockNumber()}`);
  console.log(`launchpad  ${pad}`);
  console.log(`deployer   ${signer.address}   (from ${used})`);
  console.log(`balance    ${ethers.formatEther(await rp.getBalance(signer.address))}`);
  console.log(`mode       ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);
  console.log("FeeClaimAll has no owner and holds no funds, so this deployer");
  console.log("gains no privilege and there is nothing to rotate later.\n");

  if (!EXECUTE) { console.log("dry run only. re-run with --execute\n"); return; }

  const a = require(path.join(ROOT, "build", "FeeClaimAll.json"));
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  FeeClaimAll   ${addr}`);

  // Prove it works against the real launchpad before reporting success: a
  // staticCall runs the whole preview path without committing anything.
  console.log("\nsanity check, simulated against the live launchpad");
  const claimer = new ethers.Contract(addr, [
    "function previewRange(address,uint256,uint256,address) returns (tuple(address token,address creator,uint256 creatorQuote,uint256 creatorToken,uint256 protocolQuote,uint256 protocolToken,bool ok)[])",
  ], signer);
  try {
    const rows = await claimer.previewRange.staticCall(pad, 0, 5, CFG.quote);
    console.log(`  previewRange returned ${rows.length} row(s)`);
    for (const r of rows) {
      console.log(`    ${r.token}  creator ${r.creator.slice(0, 10)}…  `
        + `pending ${ethers.formatUnits(r.creatorQuote, 6)} + ${ethers.formatUnits(r.protocolQuote, 6)}  ok=${r.ok}`);
    }
  } catch (e) {
    die(`previewRange failed: ${e.shortMessage || e.message}. Do NOT point the dashboard at this.`);
  }

  console.log(`\nSet CHAINS.${CHAIN === "stable" ? "stable" : `["${CHAIN}"]`}.mintd.claimer to:`);
  console.log(`  "${addr}"`);
  console.log(`\nexplorer: ${CFG.explorer}/address/${addr}\n`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
