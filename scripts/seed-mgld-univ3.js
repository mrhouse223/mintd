// Opens a small MGLD/USDT0 pool on canonical Uniswap V3 (Stable mainnet) at the
// live oracle price, so Dexscreener indexes it and a buybot has Swap events to
// watch. Uses a CONCENTRATED range, so a small amount of capital provides far
// more usable depth than a full-range position would.
//
//   SYNTH=0x... USDT0_AMOUNT=50 PRIVATE_KEY=0x... node scripts/seed-mgld-univ3.js
//
// Optional env:
//   FEE_TIER      500 | 3000 | 10000   (default 3000 = 0.3%)
//   RANGE_PCT     half-width of the range in percent (default 25)
//   DRY_RUN=1     print the plan and exit
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const NPM_ADDR = process.env.POSITION_MANAGER || "0x3BdC3437405f7D801b6036532713fc1F179136a6";
const FEE_TIER = Number(process.env.FEE_TIER || "10000"); // 1%, matching launchpad tokens
const RANGE_PCT = Number(process.env.RANGE_PCT || "25");
const SPACING = { 500: 10, 3000: 60, 10000: 200 };

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function factory() view returns (address)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const SYNTH_ABI = ["function synth() view returns (address)", "function price() view returns (uint256)"];

function sqrtBig(x) {
  if (x < 2n) return x;
  let z = x, y = x / 2n + 1n;
  while (y < z) { z = y; y = (x / y + y) / 2n; }
  return z;
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY env var");
  const engineAddr = process.env.SYNTH;
  if (!engineAddr) throw new Error("Set SYNTH=0x... (the MintSynth engine address)");
  const spacing = SPACING[FEE_TIER];
  if (!spacing) throw new Error(`FEE_TIER must be one of ${Object.keys(SPACING).join(", ")}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) {
    throw new Error(`Expected Stable Mainnet (988), got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, provider);
  const eng = new ethers.Contract(engineAddr, SYNTH_ABI, provider);
  const mgldAddr = await eng.synth();
  const price1e18 = await eng.price();
  const P = Number(ethers.formatEther(price1e18)); // USD per MGLD
  if (!(P > 0)) throw new Error("Oracle price unavailable, aborting");

  const mgldIs0 = BigInt(mgldAddr) < BigInt(USDT0);
  const token0 = mgldIs0 ? mgldAddr : USDT0;
  const token1 = mgldIs0 ? USDT0 : mgldAddr;

  // price of token0 denominated in token1, decimal-adjusted (MGLD 18, USDT0 6)
  const p0in1 = mgldIs0 ? P * 1e-12 : (1 / P) * 1e12;
  // sqrtPriceX96 = sqrt(p0in1) * 2^96, done in BigInt for precision
  const SCALE = 10n ** 24n;
  const scaled = BigInt(Math.floor(p0in1 * 1e24));
  const sqrtPriceX96 = (sqrtBig(scaled * (1n << 192n) / SCALE));

  const curTick = Math.floor(Math.log(p0in1) / Math.log(1.0001));
  const span = Math.round(Math.log(1 + RANGE_PCT / 100) / Math.log(1.0001));
  const floorTo = (t) => Math.floor(t / spacing) * spacing;
  const tickLower = floorTo(curTick - span);
  const tickUpper = floorTo(curTick + span) + spacing;

  // supply both sides; the position manager takes what the range requires
  const usdtAmount = ethers.parseUnits(process.env.USDT0_AMOUNT || "50", 6);
  const mgldAmount = (ethers.parseUnits(process.env.USDT0_AMOUNT || "50", 18) * 10n ** 18n) / price1e18;
  const amount0Desired = mgldIs0 ? mgldAmount : usdtAmount;
  const amount1Desired = mgldIs0 ? usdtAmount : mgldAmount;

  const mgld = new ethers.Contract(mgldAddr, ERC20, wallet);
  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const [mgldBal, usdtBal] = await Promise.all([
    mgld.balanceOf(wallet.address), usdt.balanceOf(wallet.address),
  ]);

  console.log(`deployer:  ${wallet.address}`);
  console.log(`$MGLD:     ${mgldAddr}`);
  console.log(`gold:      $${P.toFixed(2)}\n`);
  console.log(`uniswap v3 pool:`);
  console.log(`  fee tier:  ${FEE_TIER / 10000}%`);
  console.log(`  range:     +/-${RANGE_PCT}%  ($${(P * (1 - RANGE_PCT / 100)).toFixed(0)} to $${(P * (1 + RANGE_PCT / 100)).toFixed(0)} gold)`);
  console.log(`  ticks:     ${tickLower} to ${tickUpper}`);
  console.log(`  USDT0 in:  up to ${ethers.formatUnits(usdtAmount, 6)}`);
  console.log(`  MGLD in:   up to ${ethers.formatEther(mgldAmount)}\n`);
  console.log(`your balances:`);
  console.log(`  USDT0: ${ethers.formatUnits(usdtBal, 6)}`);
  console.log(`  MGLD:  ${ethers.formatEther(mgldBal)}`);
  if (usdtBal < usdtAmount) throw new Error("Not enough USDT0");
  if (mgldBal < mgldAmount) throw new Error(`Not enough MGLD, mint at least ${ethers.formatEther(mgldAmount)} first`);

  if (process.env.DRY_RUN === "1") { console.log("\nDRY_RUN set, stopping here."); return; }

  const npm = new ethers.Contract(NPM_ADDR, NPM_ABI, wallet);
  console.log("\ncreating / initializing the pool…");
  await (await npm.createAndInitializePoolIfNecessary(token0, token1, FEE_TIER, sqrtPriceX96)).wait();

  for (const [c, amt, label] of [[usdt, usdtAmount, "USDT0"], [mgld, mgldAmount, "MGLD"]]) {
    if ((await c.allowance(wallet.address, NPM_ADDR)) < amt) {
      console.log(`approving ${label}…`);
      await (await c.approve(NPM_ADDR, ethers.MaxUint256)).wait();
    }
  }

  console.log("minting the position…");
  const tx = await npm.mint({
    token0, token1, fee: FEE_TIER, tickLower, tickUpper,
    amount0Desired, amount1Desired, amount0Min: 0, amount1Min: 0,
    recipient: wallet.address, deadline: Math.floor(Date.now() / 1000) + 900,
  });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const factory = new ethers.Contract(await npm.factory(), FACTORY_ABI, provider);
  const pool = await factory.getPool(token0, token1, FEE_TIER);
  console.log(`\npool live:   ${pool}`);
  console.log(`explorer:    https://stablescan.xyz/address/${pool}`);
  console.log(`dexscreener: https://dexscreener.com/stable/${pool}`);
  console.log(`\nPoint the buybot at this pool address to post MGLD buy alerts.`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
