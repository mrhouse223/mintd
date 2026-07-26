// Tests ZapRouter: routes the swap through a DEEP pool but deposits into a
// SHALLOW MintSwap pool, proving the depositor doesn't eat price impact.
//   node scripts/compile.js && node scripts/test-zaprouter.js
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
  const MT = build("MemeToken20");
  const wg = await new ethers.ContractFactory(MT.abi, MT.bytecode, deployer).deploy("WgUSDT", "WgUSDT", "", E(100_000_000), deployer.address);
  await wg.waitForDeployment();
  const wgAddr = await wg.getAddress();

  // TWO separate V2 deployments: a "deep" DEX and our "shallow" MintSwap
  const facArt = uni("@uniswap/v2-core/build/UniswapV2Factory.json");
  const rArt = uni("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const mkDex = async () => {
    const f = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy(deployer.address);
    await f.waitForDeployment();
    const r = await new ethers.ContractFactory(rArt.abi, rArt.bytecode, deployer).deploy(await f.getAddress(), usdtAddr);
    await r.waitForDeployment();
    return { f, r, rAddr: await r.getAddress() };
  };
  const deep = await mkDex();     // deep external pool
  const mint = await mkDex();     // our shallow MintSwap
  const dl = Math.floor(Date.now() / 1000) + 3600;

  await (await usdt.approve(deep.rAddr, ethers.MaxUint256, GS)).wait();
  await (await wg.approve(deep.rAddr, ethers.MaxUint256, GS)).wait();
  await (await usdt.approve(mint.rAddr, ethers.MaxUint256, GS)).wait();
  await (await wg.approve(mint.rAddr, ethers.MaxUint256, GS)).wait();

  // deep pool: 500k / 500k (at peg, huge). MintSwap pool: 50 / 50 (shallow).
  await (await deep.r.addLiquidity(usdtAddr, wgAddr, U(500000), E(500000), 0, 0, deployer.address, dl, GS)).wait();
  await (await mint.r.addLiquidity(usdtAddr, wgAddr, U(50), E(50), 0, 0, deployer.address, dl, GS)).wait();
  const mintPairAddr = await mint.f.getPair(usdtAddr, wgAddr);
  const PAIR = ["function balanceOf(address) view returns (uint256)", "function token0() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function totalSupply() view returns (uint256)"];
  const mintPair = new ethers.Contract(mintPairAddr, PAIR, provider);

  // deploy the router-zap: deposits into MintSwap, swaps via the deep router
  const zap = await new ethers.ContractFactory(build("ZapRouter").abi, build("ZapRouter").bytecode, deployer)
    .deploy(mint.rAddr, usdtAddr);
  await zap.waitForDeployment();
  const zapAddr = await zap.getAddress();

  // alice zaps 400 USDT0. swap 200 via deep pool (~200 WgUSDT at peg), add 200/200.
  await (await usdt.connect(alice).approve(zapAddr, ethers.MaxUint256, GS)).wait();
  const usdtBefore = await usdt.balanceOf(alice.address);
  const zapC = new ethers.Contract(zapAddr, build("ZapRouter").abi, alice);
  await (await zapC.zapIn(wgAddr, U(400), deep.rAddr, U(200), E(199), 0, GS)).wait();

  const lp = await mintPair.balanceOf(alice.address);
  check(lp > 0n, `router-zap minted LP (${ethers.formatEther(lp)})`);

  // value check: alice's LP + any refunded tokens should be worth ~400, NOT ~332
  const [t0] = [await mintPair.token0()];
  const usdtIs0 = t0.toLowerCase() === usdtAddr.toLowerCase();
  const [rr0, rr1] = await mintPair.getReserves();
  const total = await mintPair.totalSupply();
  const share = Number(ethers.formatEther(lp)) / Number(ethers.formatEther(total));
  const poolUsdtVal = 2 * Number(ethers.formatUnits(usdtIs0 ? rr0 : rr1, 6));
  const lpVal = share * poolUsdtVal;
  const refundU = Number(ethers.formatUnits(await usdt.balanceOf(alice.address), 6)) - Number(ethers.formatUnits(usdtBefore - U(400), 6));
  const refundW = Number(ethers.formatEther(await wg.balanceOf(alice.address)));
  const totalVal = lpVal + refundU + refundW;
  check(totalVal > 390, `depositor keeps ~full value via deep routing (got ~$${totalVal.toFixed(2)} of 400, vs ~$332 with shallow zap)`);
  check((await usdt.balanceOf(zapAddr)) === 0n && (await wg.balanceOf(zapAddr)) === 0n, "router-zap holds no funds after");

  // minLiquidity guard: an absurd floor must revert (nothing lost)
  let reverted = false;
  try { await (await zapC.zapIn(wgAddr, U(10), deep.rAddr, U(5), 0, E(1_000_000), GS)).wait(); } catch { reverted = true; }
  check(reverted, "minLiquidity guard reverts a bad zap");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
