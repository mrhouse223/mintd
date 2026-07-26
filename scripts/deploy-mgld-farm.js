// Deploys a MINTD-rewards farm for the existing MintSwap MGLD/USDT0 pool and
// funds it for a fixed window. Sizes the reward in USD, converting to MINTD at
// the live Uniswap price so you can just say "$300 of rewards".
//
//   REWARDS_USD=300 PRIVATE_KEY=0x... node scripts/deploy-mgld-farm.js
//
// Optional env:
//   REWARDS_MINTD   exact MINTD amount, overrides REWARDS_USD
//   DURATION_DAYS   default "30"
//   DRY_RUN=1       price it and stop
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MGLD = process.env.MGLD || "0x872a3C280B846759187c9E57F62d1Ed8407b135C";
const MINTD = process.env.MINTD || "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const QUOTER = process.env.QUOTER || "0xb070179E7032CdA868b53e6C1742F80c9e940d1A";
const DURATION_DAYS = Number(process.env.DURATION_DAYS || "30");

const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`deployer: ${wallet.address}`);

  // the MGLD/USDT0 LP that stakers will deposit
  const fac = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const lp = await fac.getPair(USDT0, MGLD);
  if (lp === ethers.ZeroAddress) throw new Error("MGLD/USDT0 pool not found on MintSwap, seed it first");
  console.log(`LP token: ${lp}`);

  // size the reward: $X of MINTD at the live 1% pool price
  let rewards;
  if (process.env.REWARDS_MINTD) {
    rewards = ethers.parseEther(process.env.REWARDS_MINTD);
    console.log(`rewards:  ${ethers.formatEther(rewards)} MINTD (explicit)`);
  } else {
    const usd = process.env.REWARDS_USD || "300";
    const q = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
    const [out] = await q.quoteExactInputSingle.staticCall({
      tokenIn: USDT0, tokenOut: MINTD, amountIn: ethers.parseUnits(usd, 6), fee: 10000, sqrtPriceLimitX96: 0,
    });
    rewards = out;
    const per = Number(usd) / Number(ethers.formatEther(out));
    console.log(`MINTD price: $${per.toFixed(8)}`);
    console.log(`rewards:  ${ethers.formatEther(rewards)} MINTD (~$${usd})`);
  }
  console.log(`duration: ${DURATION_DAYS} days`);

  const mintd = new ethers.Contract(MINTD, ERC20, wallet);
  const bal = await mintd.balanceOf(wallet.address);
  console.log(`your MINTD: ${ethers.formatEther(bal)}`);
  if (bal < rewards) throw new Error(`Not enough MINTD (need ${ethers.formatEther(rewards)})`);

  if (process.env.DRY_RUN === "1") { console.log("\nDRY_RUN set, stopping here."); return; }

  // StakingRewards(rewardToken, stakingToken)
  const art = require(path.join(__dirname, "..", "build", "StakingRewards.json"));
  console.log("\ndeploying farm…");
  const farm = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(MINTD, lp);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  console.log(`farm: ${farmAddr}`);

  console.log("funding the farm…");
  await (await mintd.transfer(farmAddr, rewards)).wait();

  // set the stream length if the contract exposes it, then start it
  try {
    if (farm.setRewardsDuration) {
      await (await farm.setRewardsDuration(DURATION_DAYS * 86400)).wait();
      console.log(`duration set to ${DURATION_DAYS} days`);
    }
  } catch { console.log("(duration is fixed in this farm contract, using its default)"); }
  await (await farm.notifyRewardAmount(rewards)).wait();

  const rate = await farm.rewardRate();
  const perDay = Number(ethers.formatEther(rate)) * 86400;
  console.log(`\nfarm live: ${farmAddr}`);
  console.log(`explorer:  https://stablescan.xyz/address/${farmAddr}`);
  console.log(`streaming: ${perDay.toLocaleString(undefined, { maximumFractionDigits: 0 })} MINTD per day`);
  console.log(`\nAdd to MINTSWAP.farms in frontend/index.html:`);
  console.log(`  { name: "MGLD / USDT0", farm: "${farmAddr}", lp: "${lp}", tokenB: "${MGLD}", symB: "MGLD", decB: 18 },`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
