// Tests MINTR: proves the contract price (backing/supply) is monotonic
// non-decreasing across any sequence of buys/sells, MINTR stays fully backed,
// and the platform fee is taken. node scripts/compile.js && node scripts/test-mintr.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

async function main() {
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1_000_000 } }));
  const [deployer, feeRcpt, alice, bob] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));

  const usdt = await new ethers.ContractFactory(build("MockUSDT0").abi, build("MockUSDT0").bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();
  const mintr = await new ethers.ContractFactory(build("MINTR").abi, build("MINTR").bytecode, deployer).deploy(usdtAddr, feeRcpt.address);
  await mintr.waitForDeployment();
  const mAddr = await mintr.getAddress();
  const GS = { gasLimit: 2_000_000 };

  // seed 100 USDT0 / 100 MINTR -> price 1.0
  await (await usdt.approve(mAddr, ethers.MaxUint256, GS)).wait();
  await (await mintr.seed(U(100), E(100), GS)).wait();
  check((await mintr.price1e18()) === E(1), "seed sets price to 1.0");
  check((await usdt.balanceOf(mAddr)) === (await mintr.reserve()), "reserve == contract USDT0 balance");

  // approvals
  for (const s of [alice, bob]) await (await usdt.connect(s).approve(mAddr, ethers.MaxUint256, GS)).wait();

  // random sequence of buys and sells; price must never decrease
  let prevPrice = await mintr.price1e18();
  let minPriceOk = true, backingOk = true, feeCollected = 0n;
  const rng = (() => { let x = 42; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  for (let i = 0; i < 40; i++) {
    const who = i % 2 === 0 ? alice : bob;
    const doBuy = rng() < 0.6 || (await mintr.balanceOf(who.address)) === 0n;
    const feeBefore = await usdt.balanceOf(feeRcpt.address);
    if (doBuy) {
      const amt = U((5 + Math.floor(rng() * 200)));
      await (await mintr.connect(who).buy(amt, 0, GS)).wait();
    } else {
      const bal = await mintr.balanceOf(who.address);
      const sellAmt = bal / BigInt(1 + Math.floor(rng() * 3));
      if (sellAmt > 0n) await (await mintr.connect(who).sell(sellAmt, 0, GS)).wait();
    }
    feeCollected += (await usdt.balanceOf(feeRcpt.address)) - feeBefore;
    const p = await mintr.price1e18();
    if (p < prevPrice) minPriceOk = false;
    prevPrice = p;
    if ((await usdt.balanceOf(mAddr)) !== (await mintr.reserve())) backingOk = false;
  }
  check(minPriceOk, `price never decreased across 40 trades (final ${ethers.formatEther(prevPrice)})`);
  check(backingOk, "MINTR stays fully backed (balance == reserve) throughout");
  check(prevPrice > E(1), "price rose above the 1.0 seed from trading volume");
  check(feeCollected > 0n, `platform collected fees (${ethers.formatUnits(feeCollected, 6)} USDT0)`);

  // quotes match execution
  const q = await mintr.quoteBuy(U(50));
  const before = await mintr.balanceOf(alice.address);
  await (await mintr.connect(alice).buy(U(50), 0, GS)).wait();
  check((await mintr.balanceOf(alice.address)) - before === q, "quoteBuy matches minted amount");
  const mBal = await mintr.balanceOf(alice.address);
  const qs = await mintr.quoteSell(mBal / 2n);
  const uBefore = await usdt.balanceOf(alice.address);
  await (await mintr.connect(alice).sell(mBal / 2n, 0, GS)).wait();
  check((await usdt.balanceOf(alice.address)) - uBefore === qs, "quoteSell matches USDT0 received");

  // a full exit: everyone sells everything -> reserve still solvent, price up
  for (const s of [alice, bob]) {
    const bal = await mintr.balanceOf(s.address);
    if (bal > 0n) await (await mintr.connect(s).sell(bal, 0, GS)).wait();
  }
  check((await mintr.price1e18()) >= prevPrice, "price still up after full public exit");
  check((await usdt.balanceOf(mAddr)) === (await mintr.reserve()), "still fully backed after exit");

  // guards
  let reverted = false;
  try { await mintr.connect(alice).setFees(75, 25, 10); } catch { reverted = true; }
  check(reverted, "setFees is onlyOwner");
  reverted = false;
  try { await mintr.connect(deployer).setFees(0, 25, 10); } catch { reverted = true; }
  check(reverted, "cannot remove the backing fee (would break monotonicity)");
  reverted = false;
  try { await mintr.connect(deployer).seed(U(1), E(1)); } catch { reverted = true; }
  check(reverted, "cannot re-seed");
  check(typeof mintr.withdraw === "undefined", "no reserve-withdraw function exists");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
