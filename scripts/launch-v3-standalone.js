// Standalone launch: deploys a fixed 1B-supply ERC-20 and puts the ENTIRE
// supply into a one-sided Uniswap V3 position (1% fee) against USDT0 at a
// chosen opening market cap. The position NFT is minted to the DEPLOYER wallet
// (not a locked contract), so you keep control and can move/manage it later.
//
//   NAME="Mint Cat" SYMBOL=MINTCAT START_MC=777 \
//   PRIVATE_KEY=0x... node scripts/launch-v3-standalone.js
//
// Env:
//   NAME       token name (required)
//   SYMBOL     token ticker (required)
//   START_MC   opening market cap in USDT0, default "777" (1B supply)
//   METADATA   optional metadata URI/JSON string (default empty)
//   FEE        fee tier, default "10000" (1%)
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.stable.xyz";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736"; // 6 dec
const NPM = process.env.POSITION_MANAGER || "0x3BdC3437405f7D801b6036532713fc1F179136a6";
const FEE = Number(process.env.FEE || "10000");
const SUPPLY = ethers.parseEther("1000000000"); // fixed 1B, 18 dec

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function factory() view returns (address)",
];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)"];

function sqrtBig(x) { if (x < 2n) return x; let z = x, y = x / 2n + 1n; while (y < z) { z = y; y = (x / y + y) / 2n; } return z; }
// sqrt(num/den) in Q96
function sqrtRatioX96(num, den) { return sqrtBig((num << 96n) / den) << 48n; }
function floorToSpacing(tick, spacing) { let s = Math.trunc(tick / spacing); if (tick < 0 && tick % spacing !== 0) s--; return s * spacing; }

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("Set PRIVATE_KEY");
  const NAME = process.env.NAME, SYMBOL = process.env.SYMBOL;
  if (!NAME || !SYMBOL) throw new Error("Set NAME and SYMBOL");
  const startMc = process.env.START_MC || "777";
  const meta = process.env.METADATA || "";

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== 988n && !process.env.ALLOW_ANY_CHAIN) throw new Error(`Expected chain 988, got ${net.chainId}`);
  const wallet = new ethers.NonceManager(new ethers.Wallet(pk, provider));
  const addr = await wallet.getAddress();
  console.log(`deployer: ${addr}`);
  console.log(`USDT0 balance: ${ethers.formatEther(await provider.getBalance(addr))} (need only gas)`);

  // opening price (USDT0 per token, 1e18-scaled) = MC / 1e9 supply
  const startPrice1e18 = ethers.parseEther(startMc) / 1_000_000_000n; // MC*1e18 / 1e9
  console.log(`opening: $${startMc} MC  ->  price ${ethers.formatUnits(startPrice1e18, 18)} USDT0/token`);

  // ---- deploy the fixed-supply token (all supply to the deployer)
  const MT = require(path.join(__dirname, "..", "build", "MemeToken20.json"));
  const token = await new ethers.ContractFactory(MT.abi, MT.bytecode, wallet).deploy(NAME, SYMBOL, meta, SUPPLY, addr);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log(`token deployed: ${tokenAddr}`);

  // ---- one-sided V3 position: all token, range above launch price
  const tokenIs0 = BigInt(tokenAddr) < BigInt(USDT0);
  const [t0, t1] = tokenIs0 ? [tokenAddr, USDT0] : [USDT0, tokenAddr];
  // USDT0 is 6-dec vs token 18-dec: denominator is 1e18 (price) * 1e12 (gap) = 1e30
  const sqrtPriceX96 = tokenIs0 ? sqrtRatioX96(startPrice1e18, 10n ** 30n) : sqrtRatioX96(10n ** 30n, startPrice1e18);

  const npm = new ethers.Contract(NPM, NPM_ABI, wallet);
  console.log(`creating/initializing V3 pool (fee ${FEE / 10000}%)…`);
  await (await npm.createAndInitializePoolIfNecessary(t0, t1, FEE, sqrtPriceX96, { gasLimit: 6_000_000 })).wait();

  const factory = new ethers.Contract(await npm.factory(), ["function getPool(address,address,uint24) view returns (address)"], provider);
  const pool = await factory.getPool(t0, t1, FEE);
  const [, tick] = await new ethers.Contract(pool, POOL_ABI, provider).slot0();
  const spacing = FEE === 10000 ? 200 : FEE === 3000 ? 60 : FEE === 500 ? 10 : 200;
  const MAXT = Math.floor(887272 / spacing) * spacing;
  const floorTick = floorToSpacing(Number(tick), spacing);
  const [tickLower, tickUpper] = tokenIs0 ? [floorTick + spacing, MAXT] : [-MAXT, floorTick];

  await (await token.approve(NPM, SUPPLY)).wait();
  console.log(`minting one-sided position (entire 1B supply) to ${addr}…`);
  const tx = await npm.mint({
    token0: t0, token1: t1, fee: FEE, tickLower, tickUpper,
    amount0Desired: tokenIs0 ? SUPPLY : 0n, amount1Desired: tokenIs0 ? 0n : SUPPLY,
    amount0Min: 0, amount1Min: 0, recipient: addr, deadline: Math.floor(Date.now() / 1000) + 1200,
  }, { gasLimit: 7_000_000 });
  const rc = await tx.wait();

  console.log(`\ndone.`);
  console.log(`  token:  ${tokenAddr}`);
  console.log(`  pool:   ${pool}`);
  console.log(`  LP NFT: held by deployer ${addr} (NOT locked)`);
  console.log(`  explorer: https://stablescan.xyz/address/${tokenAddr}`);
  console.log(`  dexscreener: https://dexscreener.com/stable/${pool}`);
  console.log(`  buy tx: ${rc.hash}`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
