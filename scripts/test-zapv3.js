// Tests ZapV3: routes the swap through a real Uniswap V3 pool (deep) but
// deposits into a shallow MintSwap V2 pool. Proves the depositor keeps value.
//   node scripts/compile.js && node scripts/test-zapv3.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

async function main() {
  const gprov = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 5_000_000 }, miner: { blockGasLimit: "0x1C9C380" } });
  const provider = new ethers.BrowserProvider(gprov);
  const [deployer, alice] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 9_000_000 };

  const usdt = await new ethers.ContractFactory(build("MockUSDT0").abi, build("MockUSDT0").bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  const MT = build("MemeToken20");
  const tok = await new ethers.ContractFactory(MT.abi, MT.bytecode, deployer).deploy("MintdTest", "MINTD", "", E(1_000_000_000), deployer.address);
  await tok.waitForDeployment();
  const tokAddr = await tok.getAddress();

  // ---- real Uniswap V3 stack (the deep swap venue)
  const v3fac = await new ethers.ContractFactory(...ab(uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json")), deployer).deploy();
  await v3fac.waitForDeployment();
  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(await v3fac.getAddress(), usdtAddr, deployer.address);
  await npm.waitForDeployment();
  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const v3router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(ethers.ZeroAddress, await v3fac.getAddress(), await npm.getAddress(), usdtAddr);
  await v3router.waitForDeployment();
  const v3rAddr = await v3router.getAddress();

  // seed a DEEP V3 pool token/USDT0 at ~0.0000033 (1% tier)
  const tokenIs0 = BigInt(tokAddr) < BigInt(usdtAddr);
  const price = 3_300_000_000_000n; // 3.3e12 -> USDT0 per token 1e18-scaled
  // same formula as InstantLaunchpad._sqrtRatioX96(num, den) = sqrt((num<<96)/den)<<48
  const sqrtRatio = (num, den) => sqrtBig((num << 96n) / den) << 48n;
  const sqrtP = tokenIs0 ? sqrtRatio(price, 10n ** 30n) : sqrtRatio(10n ** 30n, price);
  const [t0, t1] = tokenIs0 ? [tokAddr, usdtAddr] : [usdtAddr, tokAddr];
  await (await npm.createAndInitializePoolIfNecessary(t0, t1, 10000, sqrtP, GS)).wait();
  await (await tok.approve(await npm.getAddress(), ethers.MaxUint256, GS)).wait();
  await (await usdt.approve(await npm.getAddress(), ethers.MaxUint256, GS)).wait();
  // wide full-range mint with lots of both sides -> deep pool
  const MAXT = 887200;
  await (await npm.mint({ token0: t0, token1: t1, fee: 10000, tickLower: -MAXT, tickUpper: MAXT,
    amount0Desired: tokenIs0 ? E(900_000_000) : U(3000), amount1Desired: tokenIs0 ? U(3000) : E(900_000_000),
    amount0Min: 0, amount1Min: 0, recipient: deployer.address, deadline: Math.floor(Date.now()/1e3)+3600 }, GS)).wait();

  // ---- MintSwap V2 fork, seed SHALLOW pool
  const facArt = uni("@uniswap/v2-core/build/UniswapV2Factory.json");
  const rArt = uni("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const v2fac = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy(deployer.address);
  await v2fac.waitForDeployment();
  const v2router = await new ethers.ContractFactory(rArt.abi, rArt.bytecode, deployer).deploy(await v2fac.getAddress(), usdtAddr);
  await v2router.waitForDeployment();
  const v2rAddr = await v2router.getAddress();
  await (await usdt.approve(v2rAddr, ethers.MaxUint256, GS)).wait();
  await (await tok.approve(v2rAddr, ethers.MaxUint256, GS)).wait();
  // shallow: 50 USDT0 + ~15M token (matching price)
  await (await v2router.addLiquidity(usdtAddr, tokAddr, U(50), E(15_000_000), 0, 0, deployer.address, Math.floor(Date.now()/1e3)+3600, GS)).wait();
  const pairAddr = await v2fac.getPair(usdtAddr, tokAddr);
  const PAIR = ["function balanceOf(address) view returns (uint256)", "function token0() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function totalSupply() view returns (uint256)"];
  const pair = new ethers.Contract(pairAddr, PAIR, provider);

  // ---- deploy ZapV3 + zap 400 USDT0
  const zap = await new ethers.ContractFactory(build("ZapV3").abi, build("ZapV3").bytecode, deployer).deploy(v2rAddr, v3rAddr, usdtAddr);
  await zap.waitForDeployment();
  const zapAddr = await zap.getAddress();
  await (await usdt.connect(alice).approve(zapAddr, ethers.MaxUint256, GS)).wait();
  const zapC = new ethers.Contract(zapAddr, build("ZapV3").abi, alice);
  // swap 200 of 400 through deep V3, deposit rest
  await (await zapC.zapIn(tokAddr, U(400), U(200), 10000, 0, 0, GS)).wait();

  const lp = await pair.balanceOf(alice.address);
  check(lp > 0n, `ZapV3 minted LP via deep V3 routing (${ethers.formatEther(lp)})`);

  // value retained ~ full (not the ~$332 a shallow same-pool zap would give)
  const [tt0] = [await pair.token0()];
  const uIs0 = tt0.toLowerCase() === usdtAddr.toLowerCase();
  const [r0, r1] = await pair.getReserves();
  const total = await pair.totalSupply();
  const share = Number(ethers.formatEther(lp)) / Number(ethers.formatEther(total));
  const poolVal = 2 * Number(ethers.formatUnits(uIs0 ? r0 : r1, 6));
  const refundU = Number(ethers.formatUnits(await usdt.balanceOf(alice.address), 6)) - (5_000_000 - 400);
  const refundT = Number(ethers.formatEther(await tok.balanceOf(alice.address)));
  const totalVal = share * poolVal + Math.max(0, refundU) + refundT * (Number(price) / 1e18);
  check(totalVal > 385, `depositor keeps ~full value ($${totalVal.toFixed(2)} of 400 via deep routing, vs ~$332 shallow)`);
  check((await usdt.balanceOf(zapAddr)) === 0n && (await tok.balanceOf(zapAddr)) === 0n, "ZapV3 holds no funds after");

  let reverted = false;
  try { await (await zapC.zapIn(tokAddr, U(10), U(5), 10000, 0, E(1_000_000_000), GS)).wait(); } catch { reverted = true; }
  check(reverted, "minLiquidity guard reverts a bad zap");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
function ab(a) { return [a.abi, a.bytecode]; }
function sqrtBig(x) { if (x < 2n) return x; let z = x, y = x / 2n + 1n; while (y < z) { z = y; y = (x / y + y) / 2n; } return z; }

main().catch((e) => { console.error(e); process.exit(1); });
