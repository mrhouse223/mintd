// Launches MINTCAT on the upgraded launchpad, paired against MINTR (opt-in
// MINTR-backed launch). Creation fee is paid in native USDT0. An optional dev
// buy is funded by MINTR you already hold (approved to the pad first).
//
//   PAD=0x<new launchpad> PRIVATE_KEY=0x... node scripts/launch-mintcat.js
//
// Env:
//   PAD             the upgraded InstantLaunchpad address (required)
//   DEV_BUY_MINTR   MINTR to spend on a launch-time dev buy, default "0"
//   MINTCAT_IMAGE   logo URL for the token metadata
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  const PAD = process.env.PAD;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  if (!PAD) throw new Error("Set PAD to the upgraded launchpad address");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();

  const art = require(path.join(__dirname, "..", "build", "InstantLaunchpad.json"));
  const pad = new ethers.Contract(PAD, art.abi, wallet);

  // safety: confirm this pad actually has MINTR enabled before spending the fee
  const padMintr = await pad.mintr();
  if (padMintr.toLowerCase() !== MINTR.toLowerCase()) {
    throw new Error(`This launchpad's MINTR is ${padMintr} (expected ${MINTR}). Is MINTR enabled on this pad?`);
  }

  const creationFee = await pad.creationFee();
  const devBuy = ethers.parseEther(process.env.DEV_BUY_MINTR || "0");

  const meta = JSON.stringify({
    image: process.env.MINTCAT_IMAGE || "https://mintd.fun/mintcat.png",
    description: "The first MINTR-backed launch on mintd.fun. Paired against MINTR, the token that only goes up.",
    x: "https://x.com/mintddotfun",
    telegram: "https://t.me/mintddotfun",
    website: "https://mintd.fun",
  });

  if (devBuy > 0n) {
    console.log(`approving ${ethers.formatEther(devBuy)} MINTR for the dev buy...`);
    const mintr = new ethers.Contract(MINTR, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], wallet);
    const bal = await mintr.balanceOf(addr);
    if (bal < devBuy) throw new Error(`Not enough MINTR (have ${ethers.formatEther(bal)}). Buy MINTR first on the site.`);
    await (await mintr.approve(PAD, devBuy)).wait();
  }

  console.log(`launching MINTCAT (backed by MINTR), fee ${ethers.formatEther(creationFee)} USDT0${devBuy > 0n ? `, dev buy ${ethers.formatEther(devBuy)} MINTR` : ""}...`);
  const tx = await pad.launchBackedByMintr("MintCat", "MINTCAT", meta, devBuy, 0, { value: creationFee });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const n = await pad.tokenCount();
  const token = await pad.allTokens(n - 1n);
  const l = await pad.launches(token);
  console.log(`\nMINTCAT launched: ${token}`);
  console.log(`  pool (MINTCAT/MINTR): ${l.pool}`);
  console.log(`  explorer: https://stablescan.xyz/address/${token}`);
  console.log(`  dexscreener: https://dexscreener.com/stable/${l.pool}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
