// Deploys the mintd.fun InstantLaunchpad (direct-to-Uniswap-V3) to Stable
// Mainnet (988), then launches the $MINTD platform token as token #0.
//
//   PRIVATE_KEY=0x... node scripts/deploy.js
//
// Optional env overrides:
//   RPC_URL            (default https://rpc.stable.xyz)
//   POSITION_MANAGER   (default canonical Uniswap v3 NPM on Stable)
//   SWAP_ROUTER        (default canonical SwapRouter02 on Stable)
//   FEE_RECIPIENT      platform fee destination (default deployer address)
//   CREATION_FEE       in USDT0, default "1"
//   CREATOR_SHARE_BPS  creator share of pool fees, default "9000" (90%)
//   START_PRICE        USDT0 per token at launch, default "0.000003"
//                      (1B supply -> 3,000 USDT0 opening valuation)
//   MINTR              MINTR reserve token, enables MINTR-backed launches
//                      (default set; pass "0x0" to disable MINTR launches)
//   START_PRICE_MINTR  MINTR per token for MINTR-backed launches, default
//                      "0.000003" (1B supply -> ~3,000 MINTR opening valuation)
//   LAUNCH_MINTD       set to "1" to also launch a $MINTD token from this pad
//                      (default off — $MINTD already exists on the old pad)
//   MINTD_DEV_BUY      USDT0 spent buying $MINTD in its launch tx, default "0"
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const NPM = process.env.POSITION_MANAGER || "0x3BdC3437405f7D801b6036532713fc1F179136a6";
const ROUTER = process.env.SWAP_ROUTER || "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"; // USDT0 ERC-20 (6 dec)
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400"; // MINTR reserve token (18 dec)

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  console.log(`chain id: ${net.chainId}`);
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}. Set ALLOW_ANY_CHAIN=1 to override.`);
  }

  const wallet = new ethers.Wallet(pk, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log(`deployer: ${wallet.address} (${ethers.formatEther(bal)} USDT0)`);

  // Sanity: confirm the USDT0 ERC-20 interface is live with 6 decimals.
  const usdt = new ethers.Contract(USDT0, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
  const [dec, sym] = await Promise.all([usdt.decimals(), usdt.symbol()]);
  console.log(`USDT0 ERC-20: ${USDT0} (${sym}, ${dec} decimals)`);
  if (dec !== 6n && Number(dec) !== 6) throw new Error("USDT0 decimals != 6 — wrong address?");

  const art = require(path.join(__dirname, "..", "build", "InstantLaunchpad.json"));
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);

  const mintrEnabled = MINTR && MINTR !== "0x0" && MINTR !== ethers.ZeroAddress;
  const args = [
    NPM,
    ROUTER,
    USDT0,
    process.env.FEE_RECIPIENT || wallet.address,
    ethers.parseEther(process.env.CREATION_FEE || "1"),
    BigInt(process.env.CREATOR_SHARE_BPS || "9000"),
    ethers.parseEther(process.env.START_PRICE || "0.000003"),
    mintrEnabled ? MINTR : ethers.ZeroAddress,
    mintrEnabled ? ethers.parseEther(process.env.START_PRICE_MINTR || "0.000003") : 0n,
  ];
  console.log(`MINTR-backed launches: ${mintrEnabled ? "ENABLED (" + MINTR + ")" : "disabled"}`);
  console.log("deploying with args:", args.map(String).join(", "));

  const pad = await factory.deploy(...args);
  console.log(`tx: ${pad.deploymentTransaction().hash}`);
  await pad.waitForDeployment();
  const addr = await pad.getAddress();
  console.log(`\nInstantLaunchpad deployed: ${addr}`);
  console.log(`explorer: https://stablescan.xyz/address/${addr}`);

  // $MINTD already exists on the original launchpad, so this upgraded pad does
  // NOT relaunch it by default. Set LAUNCH_MINTD=1 only if you truly want a new
  // MINTD token from this pad.
  if (process.env.LAUNCH_MINTD === "1") {
    const creationFee = await pad.creationFee(); // read from the contract — index-proof
    const devBuy = ethers.parseEther(process.env.MINTD_DEV_BUY || "0");
    const meta = JSON.stringify({
      image: process.env.MINTD_IMAGE || "https://mintd.fun/logo.png",
      description: "Every launch lands in a locked USDT0 pool. 90% of fees go back to the creator.",
      x: process.env.MINTD_X || "https://x.com/mintddotfun",
      telegram: process.env.MINTD_TELEGRAM || "https://t.me/mintddotfun",
      website: "https://mintd.fun",
    });
    console.log(`\nLaunching $MINTD platform token…`);
    const tx = await pad.launch("mintd.fun", "MINTD", meta, 0, { value: creationFee + devBuy });
    await tx.wait();
    const mintd = await pad.allTokens(0);
    console.log(`$MINTD launched: ${mintd}`);
    console.log(`explorer: https://stablescan.xyz/address/${mintd}`);
  }

  console.log(`\nOpen frontend/index.html, click the gear icon, and paste the launchpad address.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
