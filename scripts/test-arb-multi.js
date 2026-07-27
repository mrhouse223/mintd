// MintrArbMulti against the REAL MINTR contract and TWO real Uniswap V2 pools
// in ganache. Covers pool registration, per-pool quoting, best-pool selection,
// both contract-arb directions, cross-pool arb, profit routing and admin bounds.
//   node scripts/compile.js && node scripts/test-arb-multi.js
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
  const provider = new ethers.BrowserProvider(ganache.provider({
    logging: { quiet: true }, wallet: { defaultBalance: 1_000_000 }, miner: { blockGasLimit: "0x1C9C380" },
  }));
  const [deployer, feeRcpt, keeper, treasury] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 3_000_000 }, GL = { gasLimit: 9_000_000 };
  const dep = async (name, signer, ...a) => {
    const art = build(name);
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(...a);
    await c.waitForDeployment();
    return c;
  };
  const depArt = async (art, signer, ...a) => {
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(...a);
    await c.waitForDeployment();
    return c;
  };

  // ---------------------------------------------------------------- setup
  const usdt = await dep("MockUSDT0", deployer);
  const usdtAddr = await usdt.getAddress();
  const mintr = await dep("MINTR", deployer, usdtAddr, feeRcpt.address);
  const mintrAddr = await mintr.getAddress();
  await (await usdt.connect(deployer).approve(mintrAddr, ethers.MaxUint256, GS)).wait();
  await (await mintr.connect(deployer).seed(U(60_000), E(60_000), GS)).wait();
  check((await mintr.price1e18()) === E(1), "MINTR seeded at $1.00");

  // two independent V2 factories, standing in for MintSwap and Uniswap
  const facArt = uni("@uniswap/v2-core/build/UniswapV2Factory.json");
  const rArt = uni("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const facA = await depArt(facArt, deployer, deployer.address);
  const facB = await depArt(facArt, deployer, deployer.address);
  const routerA = await depArt(rArt, deployer, await facA.getAddress(), usdtAddr);
  const routerB = await depArt(rArt, deployer, await facB.getAddress(), usdtAddr);

  for (const r of [routerA, routerB]) {
    await (await usdt.connect(deployer).approve(await r.getAddress(), ethers.MaxUint256, GS)).wait();
    await (await mintr.connect(deployer).approve(await r.getAddress(), ethers.MaxUint256, GS)).wait();
  }
  const dl = Math.floor(Date.now() / 1000) + 3600;

  // Pool A rich:  11,000 USDT0 / 10,000 MINTR -> $1.10, a 10% premium.
  // Pool B cheap:  9,500 USDT0 / 10,000 MINTR -> $0.95, a 5% discount.
  // Sized against the 60,000 MINTR the seed minted to the deployer. Depth
  // matters: a trade big enough to move price eats its own spread.
  await (await routerA.addLiquidity(usdtAddr, mintrAddr, U(11_000), E(10_000), 0, 0, deployer.address, dl, GL)).wait();
  await (await routerB.addLiquidity(usdtAddr, mintrAddr, U(9_500), E(10_000), 0, 0, deployer.address, dl, GL)).wait();
  const pairA = await facA.getPair(usdtAddr, mintrAddr);
  const pairB = await facB.getPair(usdtAddr, mintrAddr);

  const arb = await dep("MintrArbMulti", deployer, usdtAddr, mintrAddr, treasury.address);
  const arbAddr = await arb.getAddress();

  // ---------------------------------------------------------------- pools
  await (await arb.connect(deployer).addPool(pairA, 30, GS)).wait();
  await (await arb.connect(deployer).addPool(pairB, 30, GS)).wait();
  check((await arb.poolCount()) === 2n, "two pools registered");

  let rejected = false;
  try { await (await arb.connect(deployer).addPool(pairA, 30, GS)).wait(); } catch { rejected = true; }
  check(rejected, "duplicate pool rejected");

  rejected = false;
  try { await (await arb.connect(deployer).addPool(usdtAddr, 30, GS)).wait(); } catch { rejected = true; }
  check(rejected, "non-pair address rejected");

  rejected = false;
  try { await (await arb.connect(keeper).addPool(pairB, 30, GS)).wait(); } catch { rejected = true; }
  check(rejected, "addPool is owner only");

  const [mA, cA] = await arb.prices(0);
  const [mB] = await arb.prices(1);
  check(mA > cA, `pool A at a premium (${ethers.formatEther(mA)} vs ${ethers.formatEther(cA)})`);
  check(mB < cA, `pool B at a discount (${ethers.formatEther(mB)})`);

  // ---------------------------------------------------------------- float
  await (await usdt.connect(deployer).approve(arbAddr, ethers.MaxUint256, GS)).wait();
  await (await arb.connect(deployer).fund(U(5_000), GS)).wait();
  check((await arb.available()) === U(5_000), "float funded");

  // ---------------------------------------------------- quoting per pool
  const [premA, qA] = await arb.quote(0, U(100));
  const [premB, qB] = await arb.quote(1, U(100));
  check(premA === true && qA > 0n, `pool A quotes the premium direction (${ethers.formatUnits(qA, 6)})`);
  check(premB === false && qB > 0n, `pool B quotes the discount direction (${ethers.formatUnits(qB, 6)})`);

  const [bestId, , bestProfit] = await arb.quoteBest(U(100));
  check(bestProfit >= qA && bestProfit >= qB, "quoteBest returns the better of the two");
  check(bestId === 0n || bestId === 1n, `quoteBest picked pool ${bestId}`);

  // --------------------------------------------- contract arb, premium side
  const tBefore = await usdt.balanceOf(treasury.address);
  const rc = await (await arb.connect(keeper).arb(0, U(100), GL)).wait();
  const profit1 = await arb.totalProfit();
  check(profit1 > 0n, `premium arb profitable (${ethers.formatUnits(profit1, 6)} USDT0)`);
  check((await usdt.balanceOf(treasury.address)) - tBefore === profit1, "100% of profit went to treasury (callerBps 0)");

  const ev = rc.logs.map((l) => { try { return arb.interface.parseLog(l); } catch { return null; } })
    .find((x) => x && x.name === "Arbed");
  check(ev && ev.args.premium === true, "Arbed event records the premium direction");
  check(ev && Number(ev.args.poolId) === 0, "Arbed event records the pool id");

  // -------------------------------------------- contract arb, discount side
  const before2 = await arb.totalProfit();
  await (await arb.connect(keeper).arb(1, U(100), GL)).wait();
  check((await arb.totalProfit()) > before2, "discount arb profitable on the other pool");
  check((await arb.totalRuns()) === 2n, "both runs counted");

  // ------------------------------------------------------- cross-pool arb
  // B is cheap and A is dear, so buy on B and sell on A without touching the
  // reserve at all.
  const cross = await arb.quoteCross(1, 0, U(100));
  check(cross > 0n, `cross-pool quote shows profit (${ethers.formatUnits(cross, 6)} USDT0)`);
  const [bId, sId, cBest] = await arb.quoteBestCross(U(100));
  check(Number(bId) === 1 && Number(sId) === 0, `quoteBestCross picks buy ${bId} -> sell ${sId}`);
  check(cBest > 0n, "quoteBestCross finds the profitable direction");

  const priceBefore = await mintr.price1e18();
  const runsBefore = await arb.totalRuns();
  const crossRc = await (await arb.connect(keeper).arbCross(1, 0, U(100), GL)).wait();
  check((await arb.totalRuns()) === runsBefore + 1n, "cross arb counted as a run");
  check((await mintr.price1e18()) === priceBefore, "cross arb never touches the reserve price");
  const cEv = crossRc.logs.map((l) => { try { return arb.interface.parseLog(l); } catch { return null; } })
    .find((x) => x && x.name === "CrossArbed");
  check(cEv && Number(cEv.args.buyPool) === 1 && Number(cEv.args.sellPool) === 0, "CrossArbed event records both pools");

  rejected = false;
  try { await (await arb.connect(keeper).arbCross(0, 0, U(100), GL)).wait(); } catch { rejected = true; }
  check(rejected, "cross arb rejects the same pool twice");

  // ------------------------------------------------------- safety rails
  // prices have converged by now, so a fresh unprofitable attempt must revert
  rejected = false;
  try { await (await arb.connect(keeper).arb(0, U(4_000), GL)).wait(); } catch { rejected = true; }
  check(rejected, "oversized/unprofitable arb reverts rather than losing money");

  rejected = false;
  try { await (await arb.connect(keeper).arb(0, U(999_999), GL)).wait(); } catch { rejected = true; }
  check(rejected, "cannot spend more than the float");

  await (await arb.connect(deployer).setParams(1000, U(0.01), true, GS)).wait();
  rejected = false;
  try { await (await arb.connect(keeper).arb(1, U(100), GL)).wait(); } catch { rejected = true; }
  check(rejected, "paused blocks arbing");
  await (await arb.connect(deployer).setParams(1000, U(0.01), false, GS)).wait();

  rejected = false;
  try { await (await arb.connect(deployer).setParams(6000, U(0.01), false, GS)).wait(); } catch { rejected = true; }
  check(rejected, "callerBps capped at 50%");

  rejected = false;
  try { await (await arb.connect(keeper).setParams(0, 0, false, GS)).wait(); } catch { rejected = true; }
  check(rejected, "setParams is owner only");

  // deactivating a pool takes it out of both quoting and execution
  await (await arb.connect(deployer).setPool(1, false, 30, GS)).wait();
  const [, qOff] = await arb.quote(1, U(100));
  check(qOff === 0n, "inactive pool quotes zero");
  rejected = false;
  try { await (await arb.connect(keeper).arb(1, U(100), GL)).wait(); } catch { rejected = true; }
  check(rejected, "inactive pool cannot be arbed");
  await (await arb.connect(deployer).setPool(1, true, 30, GS)).wait();

  // profitTo is movable here, unlike the first version
  await (await arb.connect(deployer).setProfitTo(feeRcpt.address, GS)).wait();
  check((await arb.profitTo()) === feeRcpt.address, "profitTo can be redirected without redeploying");
  rejected = false;
  try { await (await arb.connect(keeper).setProfitTo(keeper.address, GS)).wait(); } catch { rejected = true; }
  check(rejected, "setProfitTo is owner only");

  // sweep returns the float, and only to the owner
  rejected = false;
  try { await (await arb.connect(keeper).sweep(usdtAddr, U(1), GS)).wait(); } catch { rejected = true; }
  check(rejected, "sweep is owner only");
  const floatNow = await arb.available();
  await (await arb.connect(deployer).sweep(usdtAddr, floatNow, GS)).wait();
  check((await arb.available()) === 0n, "owner can recover the float");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
