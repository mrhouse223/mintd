// Integration tests for the MintSynth CDP engine.
//   node scripts/compile.js && node scripts/test-synth.js
//
// Covers: deposit/withdraw, minting limits, health factor, liquidation at a
// discount, liquidation caps (contract can never overpay), oracle staleness and
// deviation rejection, pause semantics (never blocks exit), and admin bounds.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100000 }, miner: { blockGasLimit: "0x1C9C380" } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, feeRcpt, alice, bob] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 5_000_000 };
  const warp = async (s) => { await gp.request({ method: "evm_increaseTime", params: [s] }); await gp.request({ method: "evm_mine", params: [] }); };
  const dep = async (name, signer, ...args) => {
    const a = build(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  // USDT0 mock (6-dec ERC-20 interface) + gold feed at $2,000, 8 decimals
  const usdt = await dep("MockUSDT0", deployer);
  const usdtAddr = await usdt.getAddress();
  const GOLD = 2000n * 10n ** 8n;
  const feed = await dep("MockAggregator", deployer, GOLD, 8);
  const feedAddr = await feed.getAddress();

  const eng = await dep("MintSynth", deployer, "Mintd Gold", "MGLD", usdtAddr, feedAddr, feeRcpt.address);
  const engAddr = await eng.getAddress();
  check((await eng.price()) === E(2000), "oracle price normalized to 1e18");

  const synth = new ethers.Contract(await eng.synth(), build("SynthToken").abi, provider);
  for (const s of [alice, bob]) {
    await (await usdt.connect(s).approve(engAddr, ethers.MaxUint256, GS)).wait();
  }

  // ---- deposit + mint
  await (await eng.connect(alice).deposit(U(30_000), GS)).wait();
  check((await eng.positions(alice.address)).collateral === E(30_000), "collateral credited 18-dec");
  // 30,000 collateral at 150% supports 20,000 of debt value = 10 MGLD at $2,000
  const maxM = await eng.maxMintable(alice.address);
  check(maxM > E(9.9) && maxM <= E(10), `maxMintable ~10 MGLD (${ethers.formatEther(maxM)})`);

  let rev = false;
  try { await (await eng.connect(alice).mint(E(11), GS)).wait(); } catch { rev = true; }
  check(rev, "minting past the min ratio reverts");

  const feeBefore = await usdt.balanceOf(feeRcpt.address);
  await (await eng.connect(alice).mint(E(9), GS)).wait();
  check((await synth.balanceOf(alice.address)) === E(9), "synth minted to user");
  check((await eng.totalDebt()) === E(9), "global debt tracked");
  // 0.5% fee on 9 * $2,000 = $18,000 -> $90 taken from collateral
  check((await usdt.balanceOf(feeRcpt.address)) - feeBefore === U(90), "mint fee paid to platform");
  const ratio = await eng.currentRatio(alice.address);
  check(ratio > 16000n && ratio < 17000n, `ratio ~166% after minting (${Number(ratio) / 100}%)`);

  // ---- withdrawal respects the min ratio
  rev = false;
  try { await (await eng.connect(alice).withdraw(U(10_000), GS)).wait(); } catch { rev = true; }
  check(rev, "withdrawal that breaks the min ratio reverts");
  await (await eng.connect(alice).withdraw(U(2_000), GS)).wait();
  check((await eng.positions(alice.address)).collateral === E(27_910), "safe withdrawal allowed");

  // ---- price moves up: position gets unhealthy
  check(!(await eng.isLiquidatable(alice.address)), "healthy position not liquidatable");
  await warp(2 * 3600); // a couple of hours pass, so this is ordinary drift
  await (await feed.setAnswer(2450n * 10n ** 8n, GS)).wait(); // gold rips +22.5%
  check((await eng.allowedDeviationBps()) > 2000n, "deviation allowance widens with elapsed time");
  const r2 = await eng.currentRatio(alice.address);
  check(r2 < 13000n, `ratio fell below liquidation threshold (${Number(r2) / 100}%)`);
  check(await eng.isLiquidatable(alice.address), "unhealthy position is liquidatable");

  // ---- bob mints his own synth, then liquidates alice
  await (await eng.connect(bob).deposit(U(50_000), GS)).wait();
  await (await eng.connect(bob).mint(E(5), GS)).wait();
  const bobUsdt0 = await usdt.balanceOf(bob.address);
  await (await eng.connect(bob).liquidate(alice.address, E(2), GS)).wait();
  const seized = (await usdt.balanceOf(bob.address)) - bobUsdt0;
  // 2 MGLD * $2,450 = $4,900 debt cleared, +10% bonus = $5,390 seized.
  // Rounds down to 6-dec, so allow a few units of dust (never rounds up).
  const dust = U(5_390) - seized;
  check(dust >= 0n && dust < 100n, `liquidator seized value + 10% bonus (${ethers.formatUnits(seized, 6)})`);
  check((await eng.positions(alice.address)).debt === E(7), "liquidated debt cleared from position");
  check((await synth.balanceOf(bob.address)) === E(3), "liquidator's synth burned");
  check((await eng.currentRatio(alice.address)) > r2, "liquidation improved the position ratio");

  rev = false;
  try { await (await eng.connect(bob).liquidate(bob.address, E(1), GS)).wait(); } catch { rev = true; }
  check(rev, "healthy position cannot be liquidated");

  // ---- solvency: contract never pays out more collateral than a position holds
  const before = await usdt.balanceOf(engAddr);
  check(before > 0n, "engine holds collateral");
  const posA = await eng.positions(alice.address);
  const posB = await eng.positions(bob.address);
  check(before * 10n ** 12n >= posA.collateral + posB.collateral - 10n ** 12n, "engine holds >= sum of positions");

  // ---- oracle staleness blocks minting but never exit
  const now = (await provider.getBlock("latest")).timestamp;
  await (await feed.setAnswerStale(2450n * 10n ** 8n, now - 8 * 3600, GS)).wait();
  rev = false;
  try { await (await eng.connect(bob).mint(E(1), GS)).wait(); } catch { rev = true; }
  check(rev, "stale oracle blocks minting");
  rev = false;
  try { await (await eng.connect(bob).liquidate(alice.address, E(1), GS)).wait(); } catch { rev = true; }
  check(rev, "stale oracle blocks liquidation (no phantom liquidations)");
  await (await eng.connect(bob).burn(E(1), GS)).wait();
  check((await eng.positions(bob.address)).debt === E(4), "repaying debt works while oracle is stale");

  // ---- deviation guard rejects an implausible jump
  await (await feed.setAnswer(2300n * 10n ** 8n, GS)).wait(); // fresh again
  await (await feed.setAnswer(9200n * 10n ** 8n, GS)).wait(); // +300% in one update
  rev = false;
  try { await eng.price(); } catch { rev = true; }
  check(rev, "deviation guard rejects a 4x price jump");
  await (await feed.setAnswer(2300n * 10n ** 8n, GS)).wait();
  check((await eng.price()) === E(2300), "normal price accepted again");

  // ---- pause stops new debt but never blocks exit
  await (await eng.connect(deployer).setMintPaused(true, GS)).wait();
  rev = false;
  try { await (await eng.connect(bob).mint(E(1), GS)).wait(); } catch { rev = true; }
  check(rev, "pause blocks new minting");
  await (await eng.connect(bob).burn(E(1), GS)).wait();
  await (await eng.connect(bob).withdraw(U(1_000), GS)).wait();
  check(true, "burn and withdraw still work while paused");
  await (await eng.connect(deployer).setMintPaused(false, GS)).wait();

  // ---- a liquidator who spent their synth cannot close past their balance
  // (bob burned 2 MGLD liquidating alice, so his debt now exceeds his holdings)
  const bobPos = await eng.positions(bob.address);
  check(bobPos.debt > (await synth.balanceOf(bob.address)), "liquidator's debt exceeds their remaining synth");
  rev = false;
  try { await (await eng.connect(bob).closePosition(GS)).wait(); } catch { rev = true; }
  check(rev, "cannot close a position without holding enough synth to repay");

  // ---- clean round trip: deposit, mint, close it all out
  const carol = await provider.getSigner(4);
  await (await usdt.connect(carol).approve(engAddr, ethers.MaxUint256, GS)).wait();
  const carolBefore = await usdt.balanceOf(carol.address);
  await (await eng.connect(carol).depositAndMint(U(20_000), E(5), GS)).wait();
  check((await synth.balanceOf(carol.address)) === E(5), "depositAndMint works in one tx");
  await (await eng.connect(carol).closePosition(GS)).wait();
  const pc = await eng.positions(carol.address);
  check(pc.debt === 0n && pc.collateral === 0n, "closePosition zeroes debt and collateral");
  const carolAfter = await usdt.balanceOf(carol.address);
  check(carolAfter < carolBefore && carolBefore - carolAfter < U(100), "round trip costs only the mint fee");

  // ---- admin bounds + no backdoor to user funds
  rev = false;
  try { await (await eng.connect(alice).setParams(15000, 13000, 1000, 50, GS)).wait(); } catch { rev = true; }
  check(rev, "setParams is onlyOwner");
  rev = false;
  try { await (await eng.connect(deployer).setParams(15000, 16000, 1000, 50, GS)).wait(); } catch { rev = true; }
  check(rev, "liquidation ratio must sit below min ratio");
  rev = false;
  try { await (await eng.connect(deployer).setParams(15000, 13000, 1000, 5000, GS)).wait(); } catch { rev = true; }
  check(rev, "mint fee is capped");
  const fns = build("MintSynth").abi.filter((x) => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map((x) => x.name);
  check(!fns.some((n) => /rescue|sweep|seize|drain|emergencyWithdraw/i.test(n)), "no admin path to user collateral");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
