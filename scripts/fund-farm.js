// Funds an existing StakingRewards farm with MINTD and starts/refreshes the
// reward stream over the farm's configured duration (default 30 days).
//
//   PRIVATE_KEY=0x... FARM=0x... AMOUNT=5000000 node scripts/fund-farm.js
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const MINTD = process.env.MINTD || "0xE62C47074abb52A2bc87B62E47e3411A0020f020";

async function main() {
  const pk = process.env.PRIVATE_KEY, farmAddr = process.env.FARM;
  if (!pk || !farmAddr) throw new Error("Set PRIVATE_KEY and FARM env vars");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(pk, provider);
  const amount = ethers.parseEther(process.env.AMOUNT || "5000000");

  const mintd = new ethers.Contract(MINTD, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address, uint256) returns (bool)",
  ], wallet);
  const bal = await mintd.balanceOf(wallet.address);
  console.log(`wallet MINTD: ${ethers.formatEther(bal)}`);
  if (bal < amount) throw new Error(`Not enough MINTD (need ${ethers.formatEther(amount)})`);

  const art = require(path.join(__dirname, "..", "build", "StakingRewards.json"));
  const farm = new ethers.Contract(farmAddr, art.abi, wallet);
  if ((await farm.owner()).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Wallet is not the farm owner");

  console.log(`sending ${ethers.formatEther(amount)} MINTD to farm…`);
  await (await mintd.transfer(farmAddr, amount)).wait();
  console.log("starting reward stream…");
  await (await farm.notifyRewardAmount(amount)).wait();
  const rate = await farm.rewardRate();
  const finish = await farm.periodFinish();
  console.log(`\nstream live: ${ethers.formatEther(rate * 86400n)} MINTD/day`);
  console.log(`ends: ${new Date(Number(finish) * 1000).toISOString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
