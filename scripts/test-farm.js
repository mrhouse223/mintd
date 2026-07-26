// Integration tests: MintSwap V2 fork (real Uniswap V2 artifacts) + the
// StakingRewards farm, in an in-process ganache EVM.
//   node scripts/compile.js && node scripts/test-farm.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}`); }
}
const approx = (a, b, tolBps = 100n) => { const d = a > b ? a - b : b - a; return b === 0n ? a === 0n : d * 10_000n <= b * tolBps; };

async function main() {
  const gprov = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100000 } });
  const provider = new ethers.BrowserProvider(gprov);
  const [deployer, alice] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  const jump = async (secs) => { await gprov.request({ method: "evm_increaseTime", params: [secs] }); await gprov.request({ method: "evm_mine", params: [] }); };
  const GS = { gasLimit: 6_000_000 };

  // ---- tokens: USDT0 mock (6 dec, native-mirror) + WgUSDT stand-in (18 dec) + MINTD stand-in
  const usdt = await new ethers.ContractFactory(build("MockUSDT0").abi, build("MockUSDT0").bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const MT = build("MemeToken20");
  const wg = await new ethers.ContractFactory(MT.abi, MT.bytecode, deployer).deploy("Wrapped gUSDT", "WgUSDT", "", E(1_000_000), deployer.address);
  const mintd = await new ethers.ContractFactory(MT.abi, MT.bytecode, deployer).deploy("mintd.fun", "MINTD", "", E(1_000_000_000), deployer.address);
  await Promise.all([wg.waitForDeployment(), mintd.waitForDeployment()]);

  // ---- MintSwap: real Uniswap V2 factory + router fork
  const facArt = uni("@uniswap/v2-core/build/UniswapV2Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy(deployer.address);
  await factory.waitForDeployment();
  const rArt = uni("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const router = await new ethers.ContractFactory(rArt.abi, rArt.bytecode, deployer).deploy(
    await factory.getAddress(), await usdt.getAddress() // WETH slot unused; token-token only
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // ---- seed USDT0/WgUSDT pool 500/500 (mirrors deploy-farm.js)
  await (await usdt.connect(deployer).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  await (await wg.connect(deployer).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  const deadline = Math.floor(Date.now() / 1000) + 36000;
  await (await router.addLiquidity(
    await usdt.getAddress(), await wg.getAddress(), U(500), E(500), 0, 0, deployer.address, deadline, GS
  )).wait();
  const pairAddr = await factory.getPair(await usdt.getAddress(), await wg.getAddress());
  check(pairAddr !== ethers.ZeroAddress, "MintSwap pair created via fork router (init hash matches)");
  const pair = new ethers.Contract(pairAddr, MT.abi, provider); // ERC20 subset
  const lpBal = await pair.balanceOf(deployer.address);
  check(lpBal > 0n, `LP tokens minted (${ethers.formatEther(lpBal)})`);

  // ---- swap through the fork to prove routing works
  const r2 = new ethers.Contract(routerAddr, rArt.abi, alice);
  await (await usdt.connect(alice).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  await (await r2.swapExactTokensForTokens(U(10), 0, [await usdt.getAddress(), await wg.getAddress()], alice.address, deadline, GS)).wait();
  check((await wg.balanceOf(alice.address)) > 0n, "swaps route through MintSwap");

  // ---- farm: stake LP, stream 10M MINTD over 30 days
  const farm = await new ethers.ContractFactory(build("StakingRewards").abi, build("StakingRewards").bytecode, deployer)
    .deploy(await mintd.getAddress(), pairAddr);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();

  // underfunded notify must revert
  let reverted = false;
  try { await (await farm.notifyRewardAmount(E(10_000_000), GS)).wait(); } catch { reverted = true; }
  check(reverted, "cannot promise rewards the contract does not hold");

  await (await mintd.transfer(farmAddr, E(10_000_000))).wait();
  await (await farm.notifyRewardAmount(E(10_000_000), GS)).wait();
  check(approx(await farm.getRewardForDuration(), E(10_000_000), 10n), "10M MINTD scheduled over 30 days");

  await (await pair.connect(deployer).approve(farmAddr, ethers.MaxUint256, GS)).wait();
  const stakeAmt = (lpBal / 3n) * 3n; // divisible by 3 for clean ratios later
  await (await farm.connect(deployer).stake(stakeAmt, GS)).wait();
  check((await farm.balanceOf(deployer.address)) === stakeAmt, "LP staked");

  // 15 days pass: sole staker earns ~5M
  await jump(15 * 86400);
  const earned15 = await farm.earned(deployer.address);
  check(approx(earned15, E(5_000_000), 200n), `~5M earned at half period (${ethers.formatEther(earned15)})`);

  // claim pays MINTD
  const before = await mintd.balanceOf(deployer.address);
  await (await farm.getReward(GS)).wait();
  check((await mintd.balanceOf(deployer.address)) - before >= earned15, "claim pays MINTD");

  // second staker: deployer drops to 2/3, alice stakes 1/3 -> 2:1 split
  await (await farm.connect(deployer).withdraw(stakeAmt / 3n, GS)).wait();
  await (await pair.connect(deployer).transfer(alice.address, stakeAmt / 3n)).wait();
  await (await pair.connect(alice).approve(farmAddr, ethers.MaxUint256, GS)).wait();
  await (await farm.connect(alice).stake(stakeAmt / 3n, GS)).wait();
  await jump(6 * 86400);
  const eD = await farm.earned(deployer.address);
  const eA = await farm.earned(alice.address);
  check(approx(eD, eA * 2n, 300n), `rewards split by stake weight (${ethers.formatEther(eD)} vs ${ethers.formatEther(eA)})`);

  // exit returns LP + pays rewards
  await (await farm.connect(alice).exit(GS)).wait();
  check((await pair.balanceOf(alice.address)) === stakeAmt / 3n, "exit returns staked LP");
  check((await mintd.balanceOf(alice.address)) > 0n, "exit pays MINTD rewards");

  // stream stops at period end
  await jump(30 * 86400);
  const finalE = await farm.earned(deployer.address);
  await jump(86400);
  check((await farm.earned(deployer.address)) === finalE, "no rewards accrue after period ends");

  // ---- zap: enter the LP position with USDT0 only
  const zap = await new ethers.ContractFactory(build("ZapIn").abi, build("ZapIn").bytecode, deployer)
    .deploy(routerAddr, await usdt.getAddress());
  await zap.waitForDeployment();
  const zapAddr = await zap.getAddress();
  await (await usdt.connect(alice).approve(zapAddr, ethers.MaxUint256, GS)).wait();
  const lpBefore = await pair.balanceOf(alice.address);
  await (await new ethers.Contract(zapAddr, build("ZapIn").abi, alice).zapIn(pairAddr, U(20), 0, GS)).wait();
  const lpGain = (await pair.balanceOf(alice.address)) - lpBefore;
  check(lpGain > 0n, `zap mints LP from USDT0 only (${ethers.formatEther(lpGain)})`);
  const wgC = new ethers.Contract(await wg.getAddress(), MT.abi, provider);
  check((await usdt.balanceOf(zapAddr)) === 0n && (await wgC.balanceOf(zapAddr)) === 0n, "zap contract holds no funds after");
  // zapped LP is stakeable in the farm
  await (await pair.connect(alice).approve(farmAddr, ethers.MaxUint256, GS)).wait();
  await (await farm.connect(alice).stake(lpGain, GS)).wait();
  check((await farm.balanceOf(alice.address)) >= lpGain, "zapped LP stakes into the farm");

  // ---- safety rails
  reverted = false;
  try { await farm.connect(alice).notifyRewardAmount(E(1)); } catch { reverted = true; }
  check(reverted, "notifyRewardAmount is onlyOwner");
  reverted = false;
  try { await farm.connect(deployer).recoverERC20(pairAddr, 1n); } catch { reverted = true; }
  check(reverted, "owner cannot touch staked LP");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
