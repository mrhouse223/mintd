// Deploy MintdLaunchpad (the fully fixed launchpad) to Arc testnet, replacing
// ArcLaunchpad which carries the dead-prevrandao brick vector.
//
//   node scripts/deploy-arc-mintd.js            dry run
//   node scripts/deploy-arc-mintd.js --execute  for real
//
// Same contract now live on Stable, proven there against a real front-run.
// Arc parameters: 80/20 creator split, the protocol's 20% split 80/20 into
// buyback and ops (so 80/16/4 of every pool fee), 5% dev buy cap, USDC quote.
// Until a MINTD exists on Arc there is nothing for a buyback to buy, so both
// protocol recipients are the deployer and 100% of protocol fees fund ops.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ENV = (() => {
  const o = {};
  try {
    for (const l of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      if (l.trim().startsWith("#")) continue;
      const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return o;
})();

const RPC = "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const OUT = path.join(ROOT, "deployments", "arc-testnet.json");
const local = (n) => require(path.join(ROOT, "build", `${n}.json`));
function die(m) { console.error("\n  ABORT: " + m + "\n"); process.exit(1); }

const PARAMS = {
  creationFee: ethers.parseEther("1"),   // 1 USDC
  creatorShareBps: 8000n,                // 80% creator
  buybackShareBps: 8000n,                // 80% of the protocol 20% -> 16% of pool fees
  devBuyCapBps: 500n,                    // 5% dev buy cap
  startPriceUsdc1e18: 3000000000000n,    // 0.000003 -> $3,000 start mcap
  startPriceMintr1e18: 3000000000000n,
};

const EXECUTE = process.argv.includes("--execute");

(async () => {
  const rec = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const C = rec.contracts;
  for (const need of ["NonfungiblePositionManager", "SwapRouter02", "MINTR"])
    if (!C[need]) die(`${need} missing from the deployment record`);

  const rp = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { batchMaxCount: 1, staticNetwork: true });
  let k = (ENV.ARC_DEPLOYER_KEY || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die("ARC_DEPLOYER_KEY not set");
  const signer = new ethers.Wallet(k, rp);
  const USDC = rec.gasToken.address;

  console.log(`\nchain      arc-testnet   block ${await rp.getBlockNumber()}`);
  console.log(`deployer   ${signer.address}`);
  console.log(`balance    ${ethers.formatEther(await rp.getBalance(signer.address))} USDC`);
  console.log(`mode       ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

  // On Arc testnet there is no Safe, so the deployer is owner. Both protocol
  // recipients are the deployer until a buyback token exists.
  const owner = signer.address, buyback = signer.address, ops = signer.address;

  console.log("parameters");
  console.log(`  owner              ${owner}`);
  console.log(`  creatorShareBps    ${PARAMS.creatorShareBps}  (80%)`);
  console.log(`  buybackShareBps    ${PARAMS.buybackShareBps}  (80% of the protocol 20% -> 16% of pool fees)`);
  console.log(`  devBuyCapBps       ${PARAMS.devBuyCapBps}  (5% cap)`);
  console.log(`  quote              ${USDC} (USDC)`);
  console.log(`  buyback/ops        both ${ops} until a MINTD exists on Arc\n`);

  if (C.MintdLaunchpad) {
    console.log(`  MintdLaunchpad already at ${C.MintdLaunchpad}`);
    console.log(`  delete that key from ${path.relative(ROOT, OUT)} to redeploy\n`);
    return;
  }
  if (!EXECUTE) { console.log("dry run only. re-run with --execute\n"); return; }

  const a = local("MintdLaunchpad");
  const pad = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(
    owner, C.NonfungiblePositionManager, C.SwapRouter02, USDC, buyback, ops,
    PARAMS.creationFee, PARAMS.creatorShareBps, PARAMS.buybackShareBps, PARAMS.devBuyCapBps,
    PARAMS.startPriceUsdc1e18, C.MINTR, PARAMS.startPriceMintr1e18
  );
  await pad.waitForDeployment();
  C.MintdLaunchpad = await pad.getAddress();
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log(`  MintdLaunchpad     ${C.MintdLaunchpad}`);

  // New registry listing both the old and new Arc pads, since the existing
  // registry is constructor-locked to the earlier pads.
  const r = local("TokenMetaRegistry");
  const reg = await new ethers.ContractFactory(r.abi, r.bytecode, signer).deploy(
    [C.ArcLaunchpad, C.MintdLaunchpad].filter(Boolean));
  await reg.waitForDeployment();
  C.MintdMetaRegistry = await reg.getAddress();
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log(`  MintdMetaRegistry  ${C.MintdMetaRegistry}`);

  console.log("\nsanity checks, read from chain");
  const p = new ethers.Contract(C.MintdLaunchpad, [
    "function owner() view returns (address)",
    "function creatorShareBps() view returns (uint256)",
    "function buybackShareBps() view returns (uint256)",
    "function devBuyCapBps() view returns (uint256)",
    "function MAX_DEV_BUY_BPS() view returns (uint256)",
    "function quoteToken() view returns (address)",
    "function usdt0() view returns (address)",
    "function mintr() view returns (address)",
    "function nativeToErc20() view returns (uint256)",
    "function tokenCount() view returns (uint256)",
  ], rp);
  let bad = 0;
  const want = (l, got, exp) => { const ok = String(got).toLowerCase() === String(exp).toLowerCase(); if (!ok) bad++; console.log(`  ${l.padEnd(18)}${got}${ok ? "" : `   EXPECTED ${exp}`}`); };
  want("owner", await p.owner(), owner);
  want("creatorShareBps", await p.creatorShareBps(), 8000n);
  want("buybackShareBps", await p.buybackShareBps(), 8000n);
  want("devBuyCapBps", await p.devBuyCapBps(), 500n);
  want("quoteToken", await p.quoteToken(), USDC);
  want("usdt0 alias", await p.usdt0(), USDC);
  want("mintr", await p.mintr(), C.MINTR);
  want("nativeToErc20", await p.nativeToErc20(), 10n ** 12n);
  console.log(`  ${"tokenCount".padEnd(18)}${await p.tokenCount()}`);
  if (bad) die(`${bad} sanity check(s) mismatched`);

  console.log(`\nrecorded in ${path.relative(ROOT, OUT)}`);
  console.log(`explorer: https://testnet.arcscan.app/address/${C.MintdLaunchpad}\n`);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
