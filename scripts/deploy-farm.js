// Seeds the USDT0/WgUSDT pool on MintSwap and deploys + funds the MINTD farm.
//
//   PRIVATE_KEY=0x... ROUTER=0x... FACTORY=0x... node scripts/deploy-farm.js
//
// Optional env:
//   TOKEN_B        (default WgUSDT 0x817997Ca8394E26CCE3dE3A076a4889b27DbF9dE)
//   AMOUNT_A       USDT0 side, default "500"
//   AMOUNT_B       token B side, default "500"
//   MINTD          (default 0xE62C47074abb52A2bc87B62E47e3411A0020f020)
//   REWARDS        MINTD streamed, default "10000000" (10M)
//   DURATION_DAYS  default "30"
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const WGUSDT = process.env.TOKEN_B || "0x817997Ca8394E26CCE3dE3A076a4889b27DbF9dE";
const MINTD = process.env.MINTD || "0xE62C47074abb52A2bc87B62E47e3411A0020f020";

const ERC20 = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function deposit() payable",
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  const routerAddr = process.env.ROUTER, facAddr = process.env.FACTORY;
  if (!pk || !routerAddr || !facAddr) throw new Error("Set PRIVATE_KEY, ROUTER, FACTORY env vars");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.Wallet(pk, provider);

  const a = new ethers.Contract(USDT0, ERC20, wallet);
  const b = new ethers.Contract(WGUSDT, ERC20, wallet);
  const [decA, decB, symB] = await Promise.all([a.decimals(), b.decimals(), b.symbol()]);
  const amtA = ethers.parseUnits(process.env.AMOUNT_A || "500", decA);
  const amtB = ethers.parseUnits(process.env.AMOUNT_B || "500", decB);
  console.log(`pair: USDT0/${symB} seeding ${process.env.AMOUNT_A || "500"} / ${process.env.AMOUNT_B || "500"}`);

  // balance checks; try wrapping native for token B if it is WETH9-like
  if ((await a.balanceOf(wallet.address)) < amtA) throw new Error("Not enough USDT0");
  if ((await b.balanceOf(wallet.address)) < amtB) {
    console.log(`insufficient ${symB}; attempting to wrap native USDT0 via deposit()…`);
    try {
      const scale = 10n ** (18n - BigInt(decB));
      await (await b.deposit({ value: amtB * scale })).wait();
      console.log("wrapped OK");
    } catch {
      throw new Error(`Could not wrap. Acquire ${symB} first (e.g. on dyorswap), then re-run.`);
    }
    if ((await b.balanceOf(wallet.address)) < amtB) throw new Error(`Still not enough ${symB}`);
  }

  // approve + add liquidity (creates the pair)
  const rArt = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const router = new ethers.Contract(routerAddr, rArt.abi, wallet);
  await (await a.approve(routerAddr, amtA)).wait();
  await (await b.approve(routerAddr, amtB)).wait();
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  await (await router.addLiquidity(USDT0, WGUSDT, amtA, amtB, (amtA * 98n) / 100n, (amtB * 98n) / 100n, wallet.address, deadline)).wait();

  const facArt = require("@uniswap/v2-core/build/UniswapV2Factory.json");
  const factory = new ethers.Contract(facAddr, facArt.abi, provider);
  const pairAddr = await factory.getPair(USDT0, WGUSDT);
  console.log(`pool seeded, LP token (pair): ${pairAddr}`);

  // deploy + fund the farm
  const art = require(path.join(__dirname, "..", "build", "StakingRewards.json"));
  const farm = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(MINTD, pairAddr);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  console.log(`farm deployed: ${farmAddr}`);

  const days = BigInt(process.env.DURATION_DAYS || "30");
  const rewards = ethers.parseEther(process.env.REWARDS || "10000000");
  await (await farm.setRewardsDuration(days * 86400n)).wait();
  const mintd = new ethers.Contract(MINTD, ERC20, wallet);
  if ((await mintd.balanceOf(wallet.address)) < rewards) throw new Error("Not enough MINTD for rewards");
  await (await mintd.transfer(farmAddr, rewards)).wait();
  await (await farm.notifyRewardAmount(rewards)).wait();
  console.log(`farm funded: ${ethers.formatEther(rewards)} MINTD over ${days} days`);

  console.log(`\n== frontend config ==`);
  console.log(`MINTSWAP.router  = ${routerAddr}`);
  console.log(`MINTSWAP.factory = ${facAddr}`);
  console.log(`add to MINTSWAP.farms:`);
  console.log(JSON.stringify({
    name: `USDT0 / ${symB}`, farm: farmAddr, lp: pairAddr,
    tokenB: WGUSDT, symB, decB: Number(decB),
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
