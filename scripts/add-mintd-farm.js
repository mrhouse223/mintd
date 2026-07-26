// Seeds the MintSwap MINTD/USDT0 pool from MINTD ALREADY in your wallet, then
// deploys + funds a farm. Does NOT buy MINTD (buy it on the site's Swap tab
// first, so you control the amount and see the slippage). Safe to re-run.
//
//   PRIVATE_KEY=0x... POOL_MINTD=15000000 node scripts/add-mintd-farm.js
//
// Env:
//   POOL_MINTD      MINTD to pair into the pool (required, = what you bought)
//   SEED_USDT0      USDT0 for the pool's USDT0 side, default "50"
//   REWARDS_MINTD   MINTD streamed as farm rewards, default "5000000"
//   DURATION_DAYS   default "30"
//   ROUTER, FACTORY, MINTD  (defaults set)
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const ROUTER = process.env.ROUTER || "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const MINTD = process.env.MINTD || "0xE62C47074abb52A2bc87B62E47e3411A0020f020";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const V2R = ["function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)"];
const FAC = ["function getPair(address,address) view returns (address)"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// send + confirm + settle: one tx at a time, small pause so the Cosmos-EVM
// node advances its account nonce before the next tx.
async function send(txPromise, label) {
  const tx = await txPromise;
  await tx.wait();
  await sleep(1500);
  if (label) console.log(`  ${label} ✓`);
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  const poolMintdStr = process.env.POOL_MINTD;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  if (!poolMintdStr) throw new Error("Set POOL_MINTD (MINTD amount to pair, = what you bought on the site)");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  // NonceManager keeps nonces sequential (fixes 'invalid nonce' on this chain)
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();

  const seedUsdt = ethers.parseUnits(process.env.SEED_USDT0 || "50", 6);
  const poolMintd = ethers.parseEther(poolMintdStr);
  const rewards = ethers.parseEther(process.env.REWARDS_MINTD || "5000000");

  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const mintd = new ethers.Contract(MINTD, ERC20, wallet);
  const uBal = await usdt.balanceOf(addr);
  const mBal = await mintd.balanceOf(addr);
  console.log(`deployer: ${addr}`);
  console.log(`USDT0: ${ethers.formatUnits(uBal, 6)}  MINTD: ${ethers.formatEther(mBal)}`);
  if (uBal < seedUsdt) throw new Error("Not enough USDT0 for the pool seed");
  if (mBal < poolMintd + rewards) throw new Error(`Need ${ethers.formatEther(poolMintd + rewards)} MINTD (pool ${ethers.formatEther(poolMintd)} + rewards ${ethers.formatEther(rewards)})`);

  // if the pool already exists (a prior run seeded it), skip seeding
  const fac = new ethers.Contract(FACTORY, FAC, provider);
  let pairAddr = await fac.getPair(USDT0, MINTD);
  if (pairAddr === ethers.ZeroAddress) {
    console.log(`seeding pool: ${ethers.formatUnits(seedUsdt, 6)} USDT0 + ${ethers.formatEther(poolMintd)} MINTD…`);
    await send(usdt.approve(ROUTER, seedUsdt), "approve USDT0");
    await send(mintd.approve(ROUTER, poolMintd), "approve MINTD");
    const v2 = new ethers.Contract(ROUTER, V2R, wallet);
    await send(v2.addLiquidity(USDT0, MINTD, seedUsdt, poolMintd, (seedUsdt * 90n) / 100n, (poolMintd * 90n) / 100n, addr, Math.floor(Date.now() / 1000) + 1200), "add liquidity");
    pairAddr = await fac.getPair(USDT0, MINTD);
  } else {
    console.log(`pool already exists: ${pairAddr} (skipping seed)`);
  }
  console.log(`LP token: ${pairAddr}`);

  // deploy + fund the farm
  console.log(`deploying farm…`);
  const art = require(path.join(__dirname, "..", "build", "StakingRewards.json"));
  const farm = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(MINTD, pairAddr);
  await farm.waitForDeployment();
  await sleep(1500);
  const farmAddr = await farm.getAddress();
  const days = BigInt(process.env.DURATION_DAYS || "30");
  await send(farm.setRewardsDuration(days * 86400n), "set duration");
  await send(mintd.transfer(farmAddr, rewards), "fund rewards");
  await send(farm.notifyRewardAmount(rewards), "start stream");
  console.log(`farm: ${farmAddr} funded ${ethers.formatEther(rewards)} MINTD / ${days} days`);

  console.log(`\nadd to MINTSWAP.farms:`);
  console.log(JSON.stringify({ name: "USDT0 / MINTD", farm: farmAddr, lp: pairAddr, tokenB: MINTD, symB: "MINTD", decB: 18 }));
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
