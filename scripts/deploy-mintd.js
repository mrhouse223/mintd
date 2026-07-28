// Deploy the mintd stack on top of an already-deployed DEX layer.
//
//   node scripts/deploy-mintd.js --chain arc-testnet
//   node scripts/deploy-mintd.js --chain arc-testnet --execute
//
// Run scripts/deploy-dex.js first: the launchpad and the V3 locker need the
// position manager and router, and this reads them out of the same
// deployments/<chain>.json rather than taking them as arguments.
//
// Parameters mirror the live Stable launchpad exactly, read from chain on
// 2026-07-28, so an Arc deployment behaves the same as the one users already
// know rather than quietly diverging.
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
  "arc-testnet": {
    rpc: "https://rpc.testnet.arc.network", chainId: 5042002,
    gasToken: "0x3600000000000000000000000000000000000000",
    explorer: "https://testnet.arcscan.app", keyVar: "ARC_DEPLOYER_KEY",
  },
};

// Mirrors Stable, read live rather than guessed.
const PARAMS = {
  creationFee: ethers.parseEther("1"),        // 1 unit of the gas token per launch
  creatorShareBps: 9000n,                      // creators keep 90% of pool fees
  startPriceUsdt1e18: 3000000000000n,          // 0.000003
  startPriceMintr1e18: 3000000000000n,
  lockFee: ethers.parseEther("1"),
};

const EXECUTE = process.argv.includes("--execute");
const CHAIN = process.argv[process.argv.indexOf("--chain") + 1];
if (!CHAINS[CHAIN]) { console.error(`\n  usage: --chain <${Object.keys(CHAINS).join("|")}> [--execute]\n`); process.exit(1); }
const CFG = CHAINS[CHAIN];
const OUT = path.join(ROOT, "deployments", `${CHAIN}.json`);
const local = (n) => require(path.join(ROOT, "build", `${n}.json`));
function die(m) { console.error("\n  ABORT: " + m + "\n"); process.exit(1); }

(async () => {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(OUT, "utf8")); }
  catch { die(`no ${path.relative(ROOT, OUT)}. Run deploy-dex.js first.`); }
  const C = rec.contracts;
  for (const need of ["NonfungiblePositionManager", "SwapRouter02", "MintSwapRouter"])
    if (!C[need]) die(`${need} missing from the deployment record. Run deploy-dex.js first.`);

  const rp = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { batchMaxCount: 1, staticNetwork: true });
  let k = (process.env[CFG.keyVar] || ENV[CFG.keyVar] || "").trim();
  if (!k) die(`${CFG.keyVar} not set`);
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
  const signer = new ethers.Wallet(k, rp);

  const bal = await rp.getBalance(signer.address);
  console.log(`\nchain      ${CHAIN}   block ${await rp.getBlockNumber()}`);
  console.log(`deployer   ${signer.address}`);
  console.log(`balance    ${ethers.formatEther(bal)}`);
  console.log(`mode       ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

  // Fees and ownership go to the deployer on a testnet. On a real chain this
  // must be a Safe before anything holds value, which is the lesson from
  // rotating Stable's compromised deployer off eight live roles.
  const feeRecipient = signer.address;

  const deploy = async (name, artifact, args = []) => {
    if (C[name]) { console.log(`  ${name.padEnd(24)} already at ${C[name]}`); return C[name]; }
    if (!EXECUTE) { console.log(`  ${name.padEnd(24)} would deploy`); return "0x" + "0".repeat(40); }
    const a = local(artifact);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    C[name] = addr;
    fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
    console.log(`  ${name.padEnd(24)} ${addr}`);
    return addr;
  };

  const gas = CFG.gasToken;

  // MINTR first: the launchpad takes it as a constructor argument so tokens
  // can be paired against it as well as against the gas token.
  const mintr = await deploy("MINTR", "MINTR", [gas, feeRecipient]);

  const pad = await deploy("InstantLaunchpad", "InstantLaunchpad", [
    C.NonfungiblePositionManager, C.SwapRouter02, gas, feeRecipient,
    PARAMS.creationFee, PARAMS.creatorShareBps, PARAMS.startPriceUsdt1e18,
    mintr, PARAMS.startPriceMintr1e18,
  ]);

  await deploy("TokenLocker", "TokenLocker", [feeRecipient, PARAMS.lockFee]);
  await deploy("V3PositionLocker", "V3PositionLocker", [C.NonfungiblePositionManager]);
  await deploy("TokenMetaRegistry", "TokenMetaRegistry", [[pad]]);
  await deploy("Furnace", "Furnace", []);

  // BuybackBurner is deliberately absent: it takes the MINTD address, and MINTD
  // does not exist until it is launched through the pad. Deploy it after.

  if (!EXECUTE) { console.log("\ndry run only. re-run with --execute\n"); return; }

  console.log("\nsanity checks");
  const p = new ethers.Contract(C.InstantLaunchpad, [
    "function creationFee() view returns (uint256)",
    "function creatorShareBps() view returns (uint256)",
    "function usdt0() view returns (address)",
    "function mintr() view returns (address)",
    "function tokenCount() view returns (uint256)",
  ], rp);
  console.log(`  creationFee      ${ethers.formatEther(await p.creationFee())}`);
  console.log(`  creatorShareBps  ${await p.creatorShareBps()}`);
  console.log(`  quote asset      ${await p.usdt0()}  ${(await p.usdt0()).toLowerCase() === gas.toLowerCase() ? "= gas token, correct" : "MISMATCH"}`);
  console.log(`  mintr            ${await p.mintr()}`);
  console.log(`  tokenCount       ${await p.tokenCount()}`);
  const m = new ethers.Contract(C.MINTR, ["function price1e18() view returns (uint256)", "function owner() view returns (address)"], rp);
  console.log(`  MINTR price      ${ethers.formatEther(await m.price1e18())}  (0 until seeded)`);

  console.log(`\nrecorded in ${path.relative(ROOT, OUT)}`);
  console.log(`explorer: ${CFG.explorer}/address/${C.InstantLaunchpad}\n`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
