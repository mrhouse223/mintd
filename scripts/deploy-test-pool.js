// Deploys the tUSD/tETH test pair and a deep Uniswap V3 pool for agent testing.
//
//   node scripts/deploy-test-pool.js            # arc-testnet
//   node scripts/deploy-test-pool.js --dry      # ganache-free dry run, no sends
//
// WHY A DEDICATED PAIR
// Arc MINTD is fixed supply with no mint function, and USDC arrives only from
// Circle's rate-limited faucet, so the existing pool holds about 24 USDC. A
// single 5 USDC vault rebalancing one-sided would swap roughly 2.5 against 24
// and revert on slippage. Depth has to be a number we choose, so both sides of
// this pair are freely mintable and worthless.
//
// FEE TIER IS A DECISION
// 0.30%, not the 1% the MINTD pool uses. AgentVault's stock maxSlippageBps of
// 100 is exactly consumed by a 1% fee before any price impact, so every
// rebalance there reverted with "Too little received" until it was raised. At
// 0.30% the shipped defaults work, and a tester who changes nothing gets a
// vault that functions.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const KEY_VAR = process.env.KEY_VAR || "ARC_DEPLOYER_KEY";
const FILE = path.join(__dirname, "..", "deployments", "arc-testnet.json");
const DRY = process.argv.includes("--dry");

const FEE = 3000, SPACING = 60;
// 1 tETH = 2000 tUSD. Arbitrary but legible, and far from 1:1 so a decimals
// mistake shows up as an absurd number rather than a plausible one.
const PRICE_TUSD_PER_TETH = 2000n;
// Wide enough that the price cannot leave it during testing, tight enough that
// the liquidity is actually concentrated near spot rather than smeared to zero.
const HALF_WIDTH_TICKS = 10000;

const SEED_TUSD = "5000000";   // 5M tUSD
const SEED_TETH = "2500";      // 2500 tETH, matching the price above

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) payable returns (uint256,uint128,uint256,uint256)",
];
const FAC_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160,int24 tick,uint16,uint16 card,uint16 cardNext,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function increaseObservationCardinalityNext(uint16)",
];

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
const die = (m) => { console.error("ERROR: " + m); process.exit(1); };

/// sqrt(ratio) << 96, integer only. Floating point loses precision at the
/// magnitudes Q96 works in, and an initialised pool cannot be re-priced.
function sqrtPriceX96(amount1, amount0) {
  const num = (amount1 << 192n) / amount0;
  if (num === 0n) return 0n;
  let z = (num + 1n) / 2n, y = num;
  while (z < y) { y = z; z = (num / z + z) / 2n; }
  return y;
}
const alignDown = (t) => Math.floor(t / SPACING) * SPACING;

async function main() {
  const rp = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const NPM = j.contracts.NonfungiblePositionManager;
  const FACTORY = j.contracts.UniswapV3Factory;
  const key = (process.env[KEY_VAR] || "").trim();
  if (!key) die(`${KEY_VAR} not set`);
  const w = new ethers.Wallet(key, rp);

  log(`deployer ${w.address}`);
  log(`gas      ${ethers.formatEther(await rp.getBalance(w.address))}`);
  if (DRY) { log("--dry: stopping before any send"); return; }

  const art = require(path.join(__dirname, "..", "build", "TestToken.json"));
  const CF = new ethers.ContractFactory(art.abi, art.bytecode, w);

  // Faucet amounts: enough to fund a meaningful vault in one click, small
  // relative to pool depth so no single tester can move the price much.
  const tUSD = await CF.deploy("mintd Test USD", "tUSD", 6,
    ethers.parseUnits(SEED_TUSD, 6), w.address, ethers.parseUnits("10000", 6), 3600, { gasLimit: 2_000_000 });
  await tUSD.waitForDeployment();
  const tETH = await CF.deploy("mintd Test ETH", "tETH", 18,
    ethers.parseUnits(SEED_TETH, 18), w.address, ethers.parseUnits("5", 18), 3600, { gasLimit: 2_000_000 });
  await tETH.waitForDeployment();
  const aUSD = await tUSD.getAddress(), aETH = await tETH.getAddress();
  log(`tUSD ${aUSD}`);
  log(`tETH ${aETH}`);

  // Uniswap orders by address, so which of the two is token0 is a coin flip and
  // the initial price has to be expressed in that order or the pool opens at
  // the reciprocal.
  const flip = BigInt(aUSD) > BigInt(aETH);
  const token0 = flip ? aETH : aUSD;
  const token1 = flip ? aUSD : aETH;
  const d0 = flip ? 18 : 6, d1 = flip ? 6 : 18;
  // price = token1 per token0, in raw units.
  const one0 = 10n ** BigInt(d0);
  const raw1 = flip
    ? PRICE_TUSD_PER_TETH * 10n ** 6n      // 1 tETH -> 2000 tUSD
    : (10n ** 18n) / PRICE_TUSD_PER_TETH;  // 1 tUSD -> 1/2000 tETH
  const sp = sqrtPriceX96(raw1, one0);
  log(`token0 ${token0} (${d0}dec)   token1 ${token1} (${d1}dec)`);

  const npm = new ethers.Contract(NPM, NPM_ABI, w);
  await (await npm.createAndInitializePoolIfNecessary(token0, token1, FEE, sp, { gasLimit: 8_000_000 })).wait();
  const poolAddr = await new ethers.Contract(FACTORY, FAC_ABI, rp).getPool(token0, token1, FEE);
  if (!poolAddr || poolAddr === ethers.ZeroAddress) die("pool was not created");
  const pool = new ethers.Contract(poolAddr, POOL_ABI, w);
  const tick = Number((await pool.slot0()).tick);
  log(`pool ${poolAddr}  tick ${tick}`);

  // Asked for before any liquidity so the buffer starts filling with the very
  // first swap. Without it observe() extrapolates from spot and the "TWAP" the
  // vault derives every protection from is just the current price.
  await (await pool.increaseObservationCardinalityNext(128, { gasLimit: 3_000_000 })).wait();

  for (const [c, a] of [[tUSD, aUSD], [tETH, aETH]]) {
    await (await c.approve(NPM, ethers.MaxUint256, { gasLimit: 200_000 })).wait();
  }

  const lower = alignDown(tick - HALF_WIDTH_TICKS), upper = alignDown(tick + HALF_WIDTH_TICKS);
  const amt0 = flip ? ethers.parseUnits(SEED_TETH, 18) : ethers.parseUnits(SEED_TUSD, 6);
  const amt1 = flip ? ethers.parseUnits(SEED_TUSD, 6) : ethers.parseUnits(SEED_TETH, 18);
  await (await npm.mint([
    token0, token1, FEE, lower, upper, amt0, amt1, 0, 0, w.address,
    Math.floor(Date.now() / 1000) + 1800,
  ], { gasLimit: 12_000_000 })).wait();

  const liq = await pool.liquidity();
  log(`seeded range ${lower}..${upper}, in-range liquidity ${liq}`);
  if (liq === 0n) die("pool has no in-range liquidity, the mint did not land where the price is");

  j.contracts.TestTokenUSD = aUSD;
  j.contracts.TestTokenETH = aETH;
  j.contracts.AgentTestPool = poolAddr;
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + "\n");
  log("recorded in deployments/arc-testnet.json");

  console.log("");
  log("NEXT: the pool has one observation, so its TWAP still equals spot.");
  log(`  POOL=${poolAddr} AMT0=2000 AMT1=1 node scripts/seed-twap.js 6 45`);
  log("  then confirm the TWAP tick has diverged from spot before inviting anyone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
