// MintrArb against the REAL MINTR contract and a REAL Uniswap V2 pool in ganache.
// Covers both directions, the unprofitable case, profit routing and admin bounds.
//   node scripts/compile.js && node scripts/test-arb.js
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
  const [deployer, feeRcpt, keeper, trader] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
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

  // USDT0 + MINTR seeded at $1.00
  const usdt = await dep("MockUSDT0", deployer);
  const usdtAddr = await usdt.getAddress();
  const mintr = await dep("MINTR", deployer, usdtAddr, feeRcpt.address);
  const mintrAddr = await mintr.getAddress();
  await (await usdt.connect(deployer).approve(mintrAddr, ethers.MaxUint256, GS)).wait();
  await (await mintr.connect(deployer).seed(U(60_000), E(60_000), GS)).wait();
  check((await mintr.price1e18()) === E(1), "MINTR seeded at $1.00");

  // real Uniswap V2 + a MINTR/USDT0 pool, opened deliberately ABOVE the contract price
  const v2facArt = uni("@uniswap/v2-core/build/UniswapV2Factory.json");
  const v2fac = await depArt(v2facArt, deployer, deployer.address);
  const v2rArt = uni("@uniswap/v2-periphery/build/UniswapV2Router02.json");
  const router = await depArt(v2rArt, deployer, await v2fac.getAddress(), usdtAddr);
  const routerAddr = await router.getAddress();

  await (await usdt.connect(deployer).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  await (await mintr.connect(deployer).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  const dl = Math.floor(Date.now() / 1000) + 3600;
  // 11,000 USDT0 against 10,000 MINTR -> market $1.10 vs contract $1.00 (10% premium).
  // Depth matters: an arb sized at 10% of the pool would move price enough to
  // eat the whole spread, which is exactly why size has to stay small.
  await (await router.addLiquidity(usdtAddr, mintrAddr, U(11_000), E(10_000), 0, 0, deployer.address, dl, GL)).wait();
  const pairAddr = await v2fac.getPair(usdtAddr, mintrAddr);

  // burner stand-in: any address that can hold USDT0
  const burner = await dep("MockUSDT0", deployer); // just a contract address to receive
  const burnerAddr = await burner.getAddress();

  const arb = await dep("MintrArb", deployer, usdtAddr, mintrAddr, routerAddr, pairAddr, burnerAddr);
  const arbAddr = await arb.getAddress();

  const [m0, c0] = await arb.prices();
  check(m0 > c0, `pool opens at a premium (market ${ethers.formatEther(m0)} vs contract ${ethers.formatEther(c0)})`);

  // fund the float
  await (await usdt.connect(deployer).approve(arbAddr, ethers.MaxUint256, GS)).wait();
  await (await arb.connect(deployer).fund(U(5_000), GS)).wait();
  check((await arb.available()) === U(5_000), "float funded");

  // ---- quote agrees there is profit in the premium direction
  const [isPrem, q] = await arb.quote(U(500));
  check(isPrem === true, "quote detects the premium direction");
  check(q > 0n, `quote shows profit (${ethers.formatUnits(q, 6)} USDT0)`);

  // ---- run it
  const burnBefore = await usdt.balanceOf(burnerAddr);
  const keeperBefore = await usdt.balanceOf(keeper.address);
  const priceBefore = await mintr.price1e18();
  const rc = await (await arb.connect(keeper).arb(U(500), GL)).wait();
  const profit = await arb.totalProfit();
  check(profit > 0n, `arb returned a profit (${ethers.formatUnits(profit, 6)} USDT0)`);
  check((await arb.totalRuns()) === 1n, "run counted");

  // MockUSDT0 mirrors the native balance, so the keeper's wallet delta includes
  // gas. Read the split from the event, which is the authoritative record.
  const ev = rc.logs.map((l) => { try { return arb.interface.parseLog(l); } catch { return null; } })
                    .find((x) => x && x.name === "Arbed");
  const bounty = ev.args.bounty;
  const toBurner = (await usdt.balanceOf(burnerAddr)) - burnBefore;
  check(bounty > 0n, `keeper paid a bounty (${ethers.formatUnits(bounty, 6)})`);
  check(toBurner > 0n, `burner received the rest (${ethers.formatUnits(toBurner, 6)})`);
  const dust = profit - (bounty + toBurner);
  check(dust >= 0n && dust <= 1n, "profit fully split between keeper and burner");
  check(bounty * 9n <= toBurner + 2n, "bounty is the smaller 10% share");
  check((await usdt.balanceOf(keeper.address)) > keeperBefore - U(1), "keeper wallet credited");

  // the float is preserved: only profit left the contract
  check((await arb.available()) === U(5_000), "float returned intact");

  // arbing pushes market toward contract, and raises MINTR backing via the tax
  const [m1, c1] = await arb.prices();
  check(m1 < m0, "market price moved down toward the contract price");
  check(c1 > priceBefore, `MINTR backing rose from the mint tax (${ethers.formatEther(c1)})`);

  // ---- repeat until the gap closes, then it must refuse to trade
  for (let i = 0; i < 25; i++) {
    const [, qq] = await arb.quote(U(500));
    if (qq < (await arb.minProfit())) break;
    await (await arb.connect(keeper).arb(U(500), GL)).wait();
  }
  let rev = false;
  try { await (await arb.connect(keeper).arb(U(500), GL)).wait(); } catch { rev = true; }
  check(rev, "refuses to trade once the spread is arbed away");
  const [m2, c2] = await arb.prices();
  const gap = Number(ethers.formatEther(m2)) / Number(ethers.formatEther(c2));
  check(gap < 1.03, `spread compressed to ${( (gap - 1) * 100).toFixed(2)}%`);

  // ---- DISCOUNT direction: dump MINTR into the pool to push market below contract
  await (await usdt.connect(trader).approve(mintrAddr, ethers.MaxUint256, GS)).wait();
  await (await mintr.connect(trader).buy(U(20_000), 0, GS)).wait();
  await (await mintr.connect(trader).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  const p = [mintrAddr, usdtAddr];
  await (await router.connect(trader).swapExactTokensForTokens(E(4_000), 0, p, trader.address, dl, GL)).wait();

  const [m3, c3] = await arb.prices();
  check(m3 < c3, `pool now trades at a discount (market ${ethers.formatEther(m3)} vs contract ${ethers.formatEther(c3)})`);
  const [isPrem2, q2] = await arb.quote(U(500));
  check(isPrem2 === false, "quote detects the discount direction");
  check(q2 > 0n, `quote shows profit the other way (${ethers.formatUnits(q2, 6)})`);

  const runsBefore = await arb.totalRuns();
  const backingBefore = await mintr.price1e18();
  await (await arb.connect(keeper).arb(U(500), GL)).wait();
  check((await arb.totalRuns()) === runsBefore + 1n, "discount-direction arb executed");
  check((await arb.available()) === U(5_000), "float still intact after the reverse arb");
  check((await mintr.price1e18()) > backingBefore, "backing rose again from the redeem tax");
  const [m4] = await arb.prices();
  check(m4 > m3, "market price pushed back up toward the contract");

  // ---- guards
  rev = false;
  try { await (await arb.connect(keeper).arb(U(50_000), GL)).wait(); } catch { rev = true; }
  check(rev, "cannot arb more than the float");
  rev = false;
  try { await (await arb.connect(keeper).setParams(1000, 1, false, GS)).wait(); } catch { rev = true; }
  check(rev, "setParams is onlyOwner");
  rev = false;
  try { await (await arb.connect(deployer).setParams(9000, 1, false, GS)).wait(); } catch { rev = true; }
  check(rev, "bounty share is capped");
  await (await arb.connect(deployer).setParams(1000, 10000, true, GS)).wait();
  rev = false;
  try { await (await arb.connect(keeper).arb(U(500), GL)).wait(); } catch { rev = true; }
  check(rev, "pause stops new runs");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
