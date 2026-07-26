// Seeds the MGLD/USDT0 pool on MintSwap (our own V2 fork) at the live oracle
// price, so the pool opens exactly on peg instead of handing free money to the
// first arbitrageur.
//
//   SYNTH=0x... USDT0_AMOUNT=100 PRIVATE_KEY=0x... node scripts/seed-mgld-pool.js
//
// Optional env:
//   ROUTER        MintSwap V2 router (default set below)
//   FACTORY       MintSwap V2 factory (default set below)
//   DRY_RUN=1     print the plan and exit without sending transactions
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const ROUTER = process.env.ROUTER || "0xb9274bEdaDcf31136F54A9501232e642a35C6Eb7";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
];
const ROUTER_ABI = [
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
const SYNTH_ABI = [
  "function synth() view returns (address)",
  "function price() view returns (uint256)",
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const synthEngine = process.env.SYNTH;
  if (!synthEngine) throw new Error("Set SYNTH=0x... (the MintSynth engine address)");
  const usdtAmountStr = process.env.USDT0_AMOUNT || "100";

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  const eng = new ethers.Contract(synthEngine, SYNTH_ABI, provider);
  const mgldAddr = await eng.synth();
  const price = await eng.price(); // 1e18-scaled USD per MGLD
  const priceNum = Number(ethers.formatEther(price));
  if (!(priceNum > 0)) throw new Error("Oracle price unavailable, aborting");

  // pool opens at the oracle price: MGLD side = USDT0 side / gold price
  const usdtAmount = ethers.parseUnits(usdtAmountStr, 6);
  const mgldAmount = (ethers.parseUnits(usdtAmountStr, 18) * 10n ** 18n) / price;

  const mgld = new ethers.Contract(mgldAddr, ERC20, wallet);
  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const [mgldBal, usdtBal] = await Promise.all([
    mgld.balanceOf(wallet.address), usdt.balanceOf(wallet.address),
  ]);

  console.log(`deployer:   ${wallet.address}`);
  console.log(`engine:     ${synthEngine}`);
  console.log(`$MGLD:      ${mgldAddr}`);
  console.log(`gold price: $${priceNum.toFixed(2)}\n`);
  console.log(`seeding the pool at the oracle price:`);
  console.log(`  USDT0 in:  ${ethers.formatUnits(usdtAmount, 6)}`);
  console.log(`  MGLD in:   ${ethers.formatEther(mgldAmount)}`);
  console.log(`  opens at:  $${priceNum.toFixed(2)} per MGLD`);
  console.log(`  depth:     ~$${(Number(usdtAmountStr) * 2).toFixed(2)} total\n`);
  console.log(`your balances:`);
  console.log(`  USDT0: ${ethers.formatUnits(usdtBal, 6)}`);
  console.log(`  MGLD:  ${ethers.formatEther(mgldBal)}`);

  if (usdtBal < usdtAmount) throw new Error("Not enough USDT0 in the wallet");
  if (mgldBal < mgldAmount) {
    throw new Error(
      `Not enough MGLD. Mint at least ${ethers.formatEther(mgldAmount)} first ` +
      `(open a position on the Gold tab at a safe ratio, ideally 250%+).`
    );
  }

  const fac = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const existing = await fac.getPair(USDT0, mgldAddr);
  if (existing !== ethers.ZeroAddress) {
    console.log(`\nNOTE: pair already exists at ${existing}. Liquidity will be added at`);
    console.log(`the pool's current ratio, not the oracle price.`);
  }

  if (process.env.DRY_RUN === "1") { console.log("\nDRY_RUN set, stopping here."); return; }

  if ((await usdt.allowance(wallet.address, ROUTER)) < usdtAmount) {
    console.log("\napproving USDT0…");
    await (await usdt.approve(ROUTER, ethers.MaxUint256)).wait();
  }
  if ((await mgld.allowance(wallet.address, ROUTER)) < mgldAmount) {
    console.log("approving MGLD…");
    await (await mgld.approve(ROUTER, ethers.MaxUint256)).wait();
  }

  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 900;
  console.log("adding liquidity…");
  const tx = await router.addLiquidity(
    USDT0, mgldAddr, usdtAmount, mgldAmount,
    (usdtAmount * 95n) / 100n, (mgldAmount * 95n) / 100n,
    wallet.address, deadline
  );
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const pair = await fac.getPair(USDT0, mgldAddr);
  console.log(`\npool live: ${pair}`);
  console.log(`explorer:  https://stablescan.xyz/address/${pair}`);
  console.log(`\nAdd this pair to MINTSWAP.feePools in frontend/index.html so it shows`);
  console.log(`on the Earn tab with the zap, then redeploy the site.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
