// Seeds a tiny canonical Uniswap V3 MINTR/USDT0 pool on Stable so it charts
// under the "uniswap" label on Dexscreener (V3 is the onboarded factory there).
// Full-range position, fee tier 1%, initialized at price 1.0.
//   PRIVATE_KEY=0x... node scripts/add-mintr-v3.js
//
// Env: SEED_MINTR (default "5"), SEED_USDT0 (default "5"), FEE (default "10000")
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"; // 6 dec
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400"; // 18 dec
const NPM = process.env.POSITION_MANAGER || "0x3BdC3437405f7D801b6036532713fc1F179136a6";
const FEE = Number(process.env.FEE || "10000"); // 1% -> tick spacing 200

const ERC20 = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];
const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function factory() view returns (address)",
];

function sqrtBig(x) { if (x < 2n) return x; let z = x, y = x / 2n + 1n; while (y < z) { z = y; y = (x / y + y) / 2n; } return z; }
// sqrtPriceX96 = sqrt(amount1/amount0) * 2^96, with amounts in raw token units
function encodeSqrtPriceX96(amount1, amount0) { return sqrtBig((amount1 << 192n) / amount0); }

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();

  const mintrRaw = ethers.parseEther(process.env.SEED_MINTR || "5");   // 18 dec
  const usdtRaw = ethers.parseUnits(process.env.SEED_USDT0 || "5", 6);  // 6 dec

  const usdt = new ethers.Contract(USDT0, ERC20, wallet);
  const mintr = new ethers.Contract(MINTR, ERC20, wallet);
  const [uBal, mBal] = await Promise.all([usdt.balanceOf(addr), mintr.balanceOf(addr)]);
  console.log(`deployer ${addr}\n  USDT0 ${ethers.formatUnits(uBal, 6)}   MINTR ${ethers.formatEther(mBal)}`);
  if (uBal < usdtRaw) throw new Error("Not enough USDT0");
  if (mBal < mintrRaw) throw new Error("Not enough MINTR");

  // token ordering by address
  const mintrIs0 = BigInt(MINTR) < BigInt(USDT0);
  const [token0, token1] = mintrIs0 ? [MINTR, USDT0] : [USDT0, MINTR];
  const [amt0Raw, amt1Raw] = mintrIs0 ? [mintrRaw, usdtRaw] : [usdtRaw, mintrRaw];
  const sqrtPriceX96 = encodeSqrtPriceX96(amt1Raw, amt0Raw);

  // full range for tick spacing 200 (fee 1%)
  const SPACING = FEE === 10000 ? 200 : FEE === 3000 ? 60 : FEE === 500 ? 10 : 200;
  const MAXT = Math.floor(887272 / SPACING) * SPACING;

  const npm = new ethers.Contract(NPM, NPM_ABI, wallet);
  console.log(`creating/initializing V3 pool (fee ${FEE / 10000}%) at price 1.0…`);
  await (await npm.createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtPriceX96, { gasLimit: 6_000_000 })).wait();

  if ((await usdt.allowance(addr, NPM)) < usdtRaw) await (await usdt.approve(NPM, ethers.MaxUint256)).wait();
  if ((await mintr.allowance(addr, NPM)) < mintrRaw) await (await mintr.approve(NPM, ethers.MaxUint256)).wait();

  console.log(`minting full-range position ${ethers.formatEther(mintrRaw)} MINTR + ${ethers.formatUnits(usdtRaw, 6)} USDT0…`);
  await (await npm.mint({
    token0, token1, fee: FEE, tickLower: -MAXT, tickUpper: MAXT,
    amount0Desired: amt0Raw, amount1Desired: amt1Raw, amount0Min: 0, amount1Min: 0,
    recipient: addr, deadline: Math.floor(Date.now() / 1000) + 1200,
  }, { gasLimit: 6_000_000 })).wait();

  const factory = new ethers.Contract(await npm.factory(), ["function getPool(address,address,uint24) view returns (address)"], provider);
  const pool = await factory.getPool(token0, token1, FEE);
  console.log(`\nUniswap V3 MINTR/USDT0 pool: ${pool}`);
  console.log(`Dexscreener: https://dexscreener.com/stable/${pool}`);
  console.log(`(do a tiny swap through it to trigger Dexscreener indexing)`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
