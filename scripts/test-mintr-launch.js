// Integration test for the MINTR-backed launch path on InstantLaunchpad,
// against REAL Uniswap V3 + the REAL MINTR reserve contract, in ganache.
// Verifies: a token can launch paired to MINTR, trade with MINTR, split fees
// in MINTR, and that MINTR's 1:1 backing is never touched by any of it.
//   node scripts/compile.js && node scripts/test-mintr-launch.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const ROUTER02_ABI = ["function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const NPM_EXTRA_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128 liquidity,uint256,uint256,uint128,uint128)",
];

async function main() {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1_000_000 }, miner: { blockGasLimit: "0x1C9C380" } }));
  const [deployer, feeRcpt, alice, bob] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const GL = { gasLimit: 9_000_000 }, GS = { gasLimit: 1_500_000 };

  // ---- USDT0 emulation + real Uniswap V3
  const usdt = await new ethers.ContractFactory(build("MockUSDT0").abi, build("MockUSDT0").bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();
  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(await factory.getAddress(), usdtAddr, deployer.address);
  await npm.waitForDeployment();
  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(ethers.ZeroAddress, await factory.getAddress(), await npm.getAddress(), usdtAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // ---- deploy + seed MINTR at price 1.0 (100 USDT0 reserve / 100 MINTR supply)
  const mintr = await new ethers.ContractFactory(build("MINTR").abi, build("MINTR").bytecode, deployer).deploy(usdtAddr, feeRcpt.address);
  await mintr.waitForDeployment();
  const mintrAddr = await mintr.getAddress();
  await (await usdt.connect(deployer).approve(mintrAddr, ethers.MaxUint256, GS)).wait();
  await (await mintr.connect(deployer).seed(U(100), E(100), GS)).wait();
  check((await mintr.price1e18()) === E(1), "MINTR seeded at $1.00 backing");

  // give alice and bob MINTR by buying it (adds USDT0 to reserve -> stays backed)
  for (const s of [alice, bob]) {
    await (await usdt.connect(s).approve(mintrAddr, ethers.MaxUint256, GS)).wait();
    await (await mintr.connect(s).buy(U(50), 0, GS)).wait();
  }
  check((await mintr.balanceOf(bob.address)) > E(40), "bob holds MINTR to trade with");

  // ---- deploy launchpad WITH MINTR enabled
  const padArt = build("InstantLaunchpad");
  const CREATION_FEE = E(1), CREATOR_BPS = 9000n;
  const START_USDT = 3_000_000_000_000n;   // USDT0-backed launches
  const START_MINTR = 3_000_000_000_000n;  // 3e12 = 0.000003 MINTR/token -> ~3000 MINTR mcap
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    await npm.getAddress(), routerAddr, usdtAddr, feeRcpt.address, CREATION_FEE, CREATOR_BPS, START_USDT,
    mintrAddr, START_MINTR
  );
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();
  check((await pad.mintr()) === mintrAddr, "launchpad has MINTR configured");

  const npmX = new ethers.Contract(await npm.getAddress(), NPM_EXTRA_ABI, provider);
  const routerX = (s) => new ethers.Contract(routerAddr, ROUTER02_ABI, s);
  const erc20 = (a, s) => new ethers.Contract(a, build("MemeToken20").abi, s || provider);

  const priceBeforeLaunch = await mintr.price1e18();

  // ---- launch MINTCAT backed by MINTR (no dev buy)
  await (await pad.connect(alice).launchBackedByMintr("MintCat", "MINTCAT", '{"image":"x"}', 0, 0, { value: CREATION_FEE, ...GL })).wait();
  const cat = await pad.allTokens(0);
  const lc = await pad.launches(cat);
  check(lc.quote === mintrAddr, "MINTCAT quote asset is MINTR (not USDT0)");
  check(lc.creator === alice.address, "creator recorded");
  check(lc.pool !== ethers.ZeroAddress, "MINTCAT/MINTR pool created");
  check((await npmX.ownerOf(lc.positionId)) === padAddr, "position NFT locked in launchpad");
  check((await erc20(cat).balanceOf(padAddr)) < E(1), "~full 1B supply in the pool");
  check((await mintr.price1e18()) === priceBeforeLaunch, "MINTR backing UNTOUCHED by launch");

  // ---- pool initialized near the configured MINTR start price
  const pool = new ethers.Contract(lc.pool, POOL_ABI, provider);
  const [sqrtP] = await pool.slot0();
  const catIs0 = BigInt(cat) < BigInt(mintrAddr);
  const Q192 = 2n ** 192n;
  const priceMintr = catIs0 ? (sqrtP * sqrtP * 10n ** 18n) / Q192 : (10n ** 18n * Q192) / (sqrtP * sqrtP);
  const dP = priceMintr > START_MINTR ? priceMintr - START_MINTR : START_MINTR - priceMintr;
  check(dP * 1000n <= START_MINTR, "pool initialized at ~ MINTR start price");

  // ---- bob buys MINTCAT with MINTR
  await (await mintr.connect(bob).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  await (await routerX(bob).exactInputSingle({ tokenIn: mintrAddr, tokenOut: cat, fee: 10000, recipient: bob.address, amountIn: E(10), amountOutMinimum: 0, sqrtPriceLimitX96: 0 }, GS)).wait();
  const bobCat = await erc20(cat).balanceOf(bob.address);
  // ~3000 MINTR mcap, 10 MINTR buy -> a few million tokens, NOT the whole supply
  check(bobCat > E(500_000) && bobCat < E(50_000_000), `bought MINTCAT with MINTR (${ethers.formatEther(bobCat)} MINTCAT)`);
  const [sqrtP2] = await pool.slot0();
  check(catIs0 ? sqrtP2 > sqrtP : sqrtP2 < sqrtP, "MINTCAT price rose after buy");

  // ---- bob sells half back for MINTR
  await (await erc20(cat, bob).approve(routerAddr, bobCat, GS)).wait();
  const bobMintrBefore = await mintr.balanceOf(bob.address);
  await (await routerX(bob).exactInputSingle({ tokenIn: cat, tokenOut: mintrAddr, fee: 10000, recipient: bob.address, amountIn: bobCat / 2n, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }, GS)).wait();
  check((await mintr.balanceOf(bob.address)) > bobMintrBefore, "sell returns MINTR to seller");

  // ---- claim fees: split 90/10 in MINTR + MINTCAT
  const aliceM0 = await mintr.balanceOf(alice.address);
  const platM0 = await mintr.balanceOf(feeRcpt.address);
  await (await pad.connect(bob).claimFees(cat, GS)).wait();
  const aliceGain = (await mintr.balanceOf(alice.address)) - aliceM0;
  const platGain = (await mintr.balanceOf(feeRcpt.address)) - platM0;
  check(aliceGain > 0n, `creator received MINTR fees (${ethers.formatEther(aliceGain)})`);
  const nine = platGain * 9n;
  const dd = aliceGain > nine ? aliceGain - nine : nine - aliceGain;
  check(dd <= 9n, "MINTR fees split exactly 90/10");
  check((await erc20(cat).balanceOf(alice.address)) > 0n, "token-side fees also paid to creator");

  // ---- backing STILL untouched after all trading + claims
  check((await mintr.price1e18()) === priceBeforeLaunch, "MINTR backing UNTOUCHED after trading + claim");

  // ---- launch with a MINTR dev buy (creator pre-approves MINTR)
  const devBuy = E(5);
  await (await mintr.connect(alice).approve(padAddr, devBuy, GS)).wait();
  await (await pad.connect(alice).launchBackedByMintr("MintDog", "MINTDOG", "", devBuy, 1, { value: CREATION_FEE, ...GL })).wait();
  const dog = await pad.allTokens(1);
  check((await erc20(dog).balanceOf(alice.address)) > 0n, "MINTR dev buy delivers tokens in the launch tx");

  // ---- guard: a launchpad without MINTR configured rejects MINTR launches
  const padOff = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    await npm.getAddress(), routerAddr, usdtAddr, feeRcpt.address, CREATION_FEE, CREATOR_BPS, START_USDT,
    ethers.ZeroAddress, 0
  );
  await padOff.waitForDeployment();
  let reverted = false;
  try { await (await padOff.connect(alice).launchBackedByMintr("X", "X", "", 0, 0, { value: CREATION_FEE, ...GL })).wait(); } catch { reverted = true; }
  check(reverted, "MINTR launch reverts when MINTR is disabled");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
