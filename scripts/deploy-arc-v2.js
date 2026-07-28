// Deploy ArcLaunchpad (v2) on Arc, alongside the v1 launchpad rather than
// replacing it.
//
//   node scripts/deploy-arc-v2.js --chain arc-testnet
//   node scripts/deploy-arc-v2.js --chain arc-testnet --execute
//
// v1 stays live at deployments/<chain>.json -> contracts.InstantLaunchpad.
// Tokens launched on it keep v1 terms permanently (90/10, no dev buy cap), so
// it is never overwritten. v2 is recorded under contracts.ArcLaunchpad and the
// frontend is repointed separately, which is also the rollback: repoint back.
//
// See docs/plans/arc-launchpad-v2.md.
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

const PARAMS = {
  creationFee: ethers.parseEther("1"),   // 1 USDC per launch
  creatorShareBps: 8000n,                // creators keep 80% of pool fees
  buybackShareBps: 8000n,                // of the protocol 20%: 80% buyback, 20% ops
  startPriceUsdc1e18: 3000000000000n,    // 0.000003 -> $3,000 starting market cap
  startPriceMintr1e18: 3000000000000n,
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
  for (const need of ["NonfungiblePositionManager", "SwapRouter02", "MINTR"])
    if (!C[need]) die(`${need} missing from the deployment record.`);

  const rp = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { batchMaxCount: 1, staticNetwork: true });
  let k = (process.env[CFG.keyVar] || ENV[CFG.keyVar] || "").trim();
  if (!k) die(`${CFG.keyVar} not set`);
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
  const signer = new ethers.Wallet(k, rp);

  console.log(`\nchain      ${CHAIN}   block ${await rp.getBlockNumber()}`);
  console.log(`deployer   ${signer.address}`);
  console.log(`balance    ${ethers.formatEther(await rp.getBalance(signer.address))}`);
  console.log(`mode       ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

  // Until MINTD exists on Arc there is nothing for a buyback to buy, so the
  // buyback share is pointed at operations and 100% of protocol fees fund ops.
  // The docs must say this outright; the alternative is a fee table that
  // describes an intention rather than what the contract does. When MINTD and
  // ArcBuybackTWAP are deployed, setFeeRecipients repoints the 80%.
  const opsRecipient = signer.address;
  const buybackRecipient = opsRecipient;

  console.log("parameters");
  console.log(`  creationFee        ${ethers.formatEther(PARAMS.creationFee)} USDC`);
  console.log(`  creatorShareBps    ${PARAMS.creatorShareBps}  (creators keep 80%)`);
  console.log(`  buybackShareBps    ${PARAMS.buybackShareBps}  (80% of the protocol 20% -> 16% of pool fees)`);
  console.log(`  startPrice         ${ethers.formatEther(PARAMS.startPriceUsdc1e18)} -> $3,000 start mcap`);
  console.log(`  buybackRecipient   ${buybackRecipient}`);
  console.log(`  opsRecipient       ${opsRecipient}`);
  if (buybackRecipient === opsRecipient) {
    console.log(`  NOTE: buyback and ops are the same address, so 100% of protocol`);
    console.log(`        fees fund operations until MINTD launches on Arc.`);
  }
  console.log();

  if (C.ArcLaunchpad) {
    console.log(`  ArcLaunchpad already at ${C.ArcLaunchpad}`);
    console.log(`  delete that key from ${path.relative(ROOT, OUT)} to redeploy\n`);
  } else if (!EXECUTE) {
    console.log("  ArcLaunchpad             would deploy\n");
  } else {
    const a = local("ArcLaunchpad");
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(
      C.NonfungiblePositionManager, C.SwapRouter02, CFG.gasToken,
      buybackRecipient, opsRecipient,
      PARAMS.creationFee, PARAMS.creatorShareBps, PARAMS.buybackShareBps,
      PARAMS.startPriceUsdc1e18, C.MINTR, PARAMS.startPriceMintr1e18
    );
    await c.waitForDeployment();
    C.ArcLaunchpad = await c.getAddress();
    fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
    console.log(`  ArcLaunchpad             ${C.ArcLaunchpad}\n`);
  }

  if (!EXECUTE) { console.log("dry run only. re-run with --execute\n"); return; }

  // Read the config back off chain rather than trusting the constructor args.
  console.log("sanity checks, read from chain");
  const p = new ethers.Contract(C.ArcLaunchpad, [
    "function creationFee() view returns (uint256)",
    "function creatorShareBps() view returns (uint256)",
    "function buybackShareBps() view returns (uint256)",
    "function MAX_DEV_BUY_BPS() view returns (uint256)",
    "function MAX_DEV_BUY_TOKENS() view returns (uint256)",
    "function usdc() view returns (address)",
    "function mintr() view returns (address)",
    "function buybackRecipient() view returns (address)",
    "function opsRecipient() view returns (address)",
    "function owner() view returns (address)",
    "function tokenCount() view returns (uint256)",
    "function previewDevBuyCap(uint128,bool) pure returns (uint256)",
  ], rp);

  let bad = 0;
  const want = (label, got, expected) => {
    const ok = String(got).toLowerCase() === String(expected).toLowerCase();
    if (!ok) bad++;
    console.log(`  ${label.padEnd(20)} ${got}${ok ? "" : `   EXPECTED ${expected}`}`);
  };
  want("creationFee", await p.creationFee(), PARAMS.creationFee);
  want("creatorShareBps", await p.creatorShareBps(), PARAMS.creatorShareBps);
  want("buybackShareBps", await p.buybackShareBps(), PARAMS.buybackShareBps);
  want("MAX_DEV_BUY_BPS", await p.MAX_DEV_BUY_BPS(), 500n);
  want("MAX_DEV_BUY_TOKENS", await p.MAX_DEV_BUY_TOKENS(), ethers.parseEther("50000000"));
  want("quote asset", await p.usdc(), CFG.gasToken);
  want("mintr", await p.mintr(), C.MINTR);
  want("buybackRecipient", await p.buybackRecipient(), buybackRecipient);
  want("opsRecipient", await p.opsRecipient(), opsRecipient);
  want("owner", await p.owner(), signer.address);
  console.log(`  tokenCount           ${await p.tokenCount()}`);

  console.log(`\n  v1 launchpad still live at ${C.InstantLaunchpad}`);
  console.log(`  its tokens keep v1 terms; nothing was migrated`);
  if (bad) die(`${bad} sanity check(s) mismatched. Do NOT point the frontend at this.`);
  console.log(`\nrecorded in ${path.relative(ROOT, OUT)}`);
  console.log(`explorer: ${CFG.explorer}/address/${C.ArcLaunchpad}\n`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
