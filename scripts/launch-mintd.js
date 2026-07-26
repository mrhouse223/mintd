// Launches the $MINTD platform token on an already-deployed InstantLaunchpad.
//   PRIVATE_KEY=0x... LAUNCHPAD=0x... MINTD_DEV_BUY=10 node scripts/launch-mintd.js
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  const padAddr = process.env.LAUNCHPAD;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  if (!padAddr || !ethers.isAddress(padAddr)) throw new Error("Set LAUNCHPAD env var to the deployed launchpad address");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(pk, provider);
  const art = require(path.join(__dirname, "..", "build", "InstantLaunchpad.json"));
  const pad = new ethers.Contract(padAddr, art.abi, wallet);

  const n = await pad.tokenCount();
  if (n > 0n) throw new Error(`Launchpad already has ${n} token(s) — $MINTD should be token #0. Aborting.`);

  const creationFee = await pad.creationFee();
  const devBuy = ethers.parseEther(process.env.MINTD_DEV_BUY || "0");
  const bal = await provider.getBalance(wallet.address);
  console.log(`deployer: ${wallet.address} (${ethers.formatEther(bal)} USDT0)`);
  console.log(`cost: ${ethers.formatEther(creationFee + devBuy)} USDT0 + gas`);
  if (bal < creationFee + devBuy) throw new Error("Insufficient balance for creation fee + dev buy");

  const meta = JSON.stringify({
    image: process.env.MINTD_IMAGE || "https://mintd.fun/logo.png",
    description: "Every launch lands in a locked USDT0 pool. 90% of fees go back to the creator.",
    x: process.env.MINTD_X || "https://x.com/mintddotfun",
    telegram: process.env.MINTD_TELEGRAM || "https://t.me/mintddotfun",
    website: "https://mintd.fun",
  });

  console.log("Launching $MINTD…");
  const tx = await pad.launch("mintd.fun", "MINTD", meta, 0, { value: creationFee + devBuy });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  const mintd = await pad.allTokens(0);
  console.log(`\n$MINTD launched: ${mintd}`);
  console.log(`explorer: https://stablescan.xyz/address/${mintd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
