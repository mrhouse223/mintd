// Tests BuybackBurner: collected USDT0 is swapped for MINTD via a real
// Uniswap V3 pool and sent to the dead address; counters track it; no admin.
//   node scripts/compile.js && node scripts/test-buyback.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);
const DEAD = "0x000000000000000000000000000000000000dEaD";

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }
function sqrtBig(x) { if (x < 2n) return x; let z = x, y = x / 2n + 1n; while (y < z) { z = y; y = (x / y + y) / 2n; } return z; }

async function main() {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 5_000_000 }, miner: { blockGasLimit: "0x1C9C380" } }));
  const [deployer, anyone] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 9_000_000 };

  const usdt = await new ethers.ContractFactory(build("MockUSDT0").abi, build("MockUSDT0").bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  const MT = build("MemeToken20");
  const mintd = await new ethers.ContractFactory(MT.abi, MT.bytecode, deployer).deploy("mintd.fun", "MINTD", "", E(1_000_000_000), deployer.address);
  await mintd.waitForDeployment();
  const mintdAddr = await mintd.getAddress();

  // real Uniswap V3 with a deep MINTD/USDT0 pool
  const v3fac = await new ethers.ContractFactory(...(a => [a.abi, a.bytecode])(uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json")), deployer).deploy();
  await v3fac.waitForDeployment();
  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(await v3fac.getAddress(), usdtAddr, deployer.address);
  await npm.waitForDeployment();
  const rArt = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(rArt.abi, rArt.bytecode, deployer).deploy(ethers.ZeroAddress, await v3fac.getAddress(), await npm.getAddress(), usdtAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const tokenIs0 = BigInt(mintdAddr) < BigInt(usdtAddr);
  const price = 3_300_000_000_000n;
  const sqrtRatio = (num, den) => sqrtBig((num << 96n) / den) << 48n;
  const sqrtP = tokenIs0 ? sqrtRatio(price, 10n ** 30n) : sqrtRatio(10n ** 30n, price);
  const [t0, t1] = tokenIs0 ? [mintdAddr, usdtAddr] : [usdtAddr, mintdAddr];
  await (await npm.createAndInitializePoolIfNecessary(t0, t1, 10000, sqrtP, GS)).wait();
  await (await mintd.approve(await npm.getAddress(), ethers.MaxUint256, GS)).wait();
  await (await usdt.approve(await npm.getAddress(), ethers.MaxUint256, GS)).wait();
  const MAXT = 887200;
  await (await npm.mint({ token0: t0, token1: t1, fee: 10000, tickLower: -MAXT, tickUpper: MAXT,
    amount0Desired: tokenIs0 ? E(900_000_000) : U(3000), amount1Desired: tokenIs0 ? U(3000) : E(900_000_000),
    amount0Min: 0, amount1Min: 0, recipient: deployer.address, deadline: Math.floor(Date.now() / 1e3) + 3600 }, GS)).wait();

  // deploy the burner
  const bb = await new ethers.ContractFactory(build("BuybackBurner").abi, build("BuybackBurner").bytecode, deployer).deploy(usdtAddr, routerAddr, mintdAddr, 10000);
  await bb.waitForDeployment();
  const bbAddr = await bb.getAddress();

  // simulate fees accumulating: send 100 USDT0 to the burner
  await (await usdt.transfer(bbAddr, U(100), GS)).wait();
  check((await bb.pending()) === U(100), "collects USDT0 fees (pending = 100)");

  const deadBefore = await mintd.balanceOf(DEAD);
  // anyone (not owner) can trigger the burn
  await (await bb.connect(anyone).buybackBurn(0, 0, GS)).wait();
  const burned = (await mintd.balanceOf(DEAD)) - deadBefore;
  check(burned > 0n, `MINTD bought and sent to dead (${ethers.formatEther(burned)} burned)`);
  check((await bb.totalMintdBurned()) === burned, "totalMintdBurned tracked");
  check((await bb.totalUsdtSpent()) === U(100), "totalUsdtSpent tracked");
  check((await bb.pending()) === 0n, "USDT0 fully spent");
  check((await usdt.balanceOf(bbAddr)) === 0n && (await mintd.balanceOf(bbAddr)) === 0n, "burner holds nothing after");

  // nothing to burn reverts
  let reverted = false;
  try { await (await bb.buybackBurn(0, 0, GS)).wait(); } catch { reverted = true; }
  check(reverted, "reverts when there is nothing to burn");

  // no admin surface exists
  check(typeof bb.withdraw === "undefined" && typeof bb.owner === "undefined", "no owner / no withdraw (fully trustless)");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
