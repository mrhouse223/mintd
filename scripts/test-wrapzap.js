// Tests WrapZap: zero-slippage entry into USDT0/WgUSDT LP via 1:1 wrapping,
// even against a SHALLOW pool. Proves the depositor keeps full value.
//   node scripts/compile.js && node scripts/test-wrapzap.js
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
  const gprov = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1_000_000 } });
  const provider = new ethers.BrowserProvider(gprov);
  const [deployer, alice] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 8_000_000 };

  const usdt = await new ethers.ContractFactory(build("MockUSDT0").abi, build("MockUSDT0").bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  // WgUSDT = WETH9-style 1:1 wrapper of native USDT0
  const wg = await new ethers.ContractFactory(build("WETH9").abi, build("WETH9").bytecode, deployer).deploy();
  await wg.waitForDeployment();
  const wgAddr = await wg.getAddress();

  const facArt = uni("@uniswap/v2-core/build/UniswapV2Factory.json");
  const rArt = uni("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const fac = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy(deployer.address);
  await fac.waitForDeployment();
  const router = await new ethers.ContractFactory(rArt.abi, rArt.bytecode, deployer).deploy(await fac.getAddress(), usdtAddr);
  await router.waitForDeployment();
  const rAddr = await router.getAddress();

  // seed a SHALLOW pool: 50 USDT0 / 50 WgUSDT
  await (await wg.deposit({ value: E(50) })).wait(); // wrap 50 native -> 50 WgUSDT
  await (await usdt.approve(rAddr, ethers.MaxUint256, GS)).wait();
  await (await wg.approve(rAddr, ethers.MaxUint256, GS)).wait();
  const dl = Math.floor(Date.now() / 1000) + 3600;
  await (await router.addLiquidity(usdtAddr, wgAddr, U(50), E(50), 0, 0, deployer.address, dl, GS)).wait();
  const pairAddr = await fac.getPair(usdtAddr, wgAddr);
  const PAIR = ["function balanceOf(address) view returns (uint256)", "function token0() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function totalSupply() view returns (uint256)"];
  const pair = new ethers.Contract(pairAddr, PAIR, provider);

  const zap = await new ethers.ContractFactory(build("WrapZap").abi, build("WrapZap").bytecode, deployer)
    .deploy(rAddr, usdtAddr, wgAddr);
  await zap.waitForDeployment();
  const zapAddr = await zap.getAddress();

  // alice zaps 400 USDT0 into the SHALLOW 50/50 pool. split 200/200 (pool at peg).
  const zapC = new ethers.Contract(zapAddr, build("WrapZap").abi, alice);
  const nativeBefore = await provider.getBalance(alice.address);
  const rc = await (await zapC.zapIn(U(200), 0, { value: E(400), ...GS })).wait();
  const gas = rc.gasUsed * rc.gasPrice;

  const lp = await pair.balanceOf(alice.address);
  check(lp > 0n, `wrap-zap minted LP (${ethers.formatEther(lp)})`);

  // value: alice's LP share of the pool should be ~$400 (zero slippage)
  const [t0] = [await pair.token0()];
  const usdtIs0 = t0.toLowerCase() === usdtAddr.toLowerCase();
  const [r0, r1] = await pair.getReserves();
  const total = await pair.totalSupply();
  const share = Number(ethers.formatEther(lp)) / Number(ethers.formatEther(total));
  const poolVal = 2 * Number(ethers.formatUnits(usdtIs0 ? r0 : r1, 6));
  const lpVal = share * poolVal;
  check(lpVal > 398, `depositor keeps full value, zero slippage (LP worth ~$${lpVal.toFixed(2)} of 400)`);
  check((await usdt.balanceOf(zapAddr)) === 0n && (await wg.balanceOf(zapAddr)) === 0n, "wrap-zap holds no funds after");

  // minLiquidity guard
  let reverted = false;
  try { await (await zapC.zapIn(U(5), E(1_000_000), { value: E(10), ...GS })).wait(); } catch { reverted = true; }
  check(reverted, "minLiquidity guard reverts a bad zap");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
