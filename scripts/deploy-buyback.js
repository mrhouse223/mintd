// Deploys BuybackBurner and (optionally) points MINTR's platform fee at it.
//   PRIVATE_KEY=0x... MINTR=0x... node scripts/deploy-buyback.js
//
// After deploy, any USDT0 sent here (MINTR platform fees, launchpad fees, etc.)
// can be permissionlessly bought into MINTD and burned. To route MINTR fees
// here, this script calls MINTR.setFeeRecipient(buyback) if you own MINTR.
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const V3_ROUTER = "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a"; // canonical SwapRouter02
const MINTD = process.env.MINTD || "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
const FEE_TIER = Number(process.env.FEE_TIER || "10000");

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));

  const art = require(path.join(__dirname, "..", "build", "BuybackBurner.json"));
  const bb = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(USDT0, V3_ROUTER, MINTD, FEE_TIER);
  await bb.waitForDeployment();
  const bbAddr = await bb.getAddress();
  console.log(`BuybackBurner deployed: ${bbAddr}`);

  // route MINTR platform fees here (if MINTR given and you own it)
  const mintr = process.env.MINTR;
  if (mintr) {
    try {
      const m = new ethers.Contract(mintr, ["function setFeeRecipient(address)", "function owner() view returns (address)"], wallet);
      const owner = await m.owner();
      if (owner.toLowerCase() === (await wallet.getAddress()).toLowerCase()) {
        await (await m.setFeeRecipient(bbAddr)).wait();
        console.log(`MINTR platform fees now route to the burner`);
      } else {
        console.log(`(skipped MINTR wiring: you are not the MINTR owner)`);
      }
    } catch (e) { console.log(`(MINTR wiring failed: ${e.shortMessage || e.message})`); }
  }

  console.log(`\nset BUYBACK_ADDR to ${bbAddr} in the frontend`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
