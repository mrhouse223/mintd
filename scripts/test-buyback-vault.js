// Integration tests for BuybackVault and its factory.
//   node scripts/compile.js && node scripts/test-buyback-vault.js
//
// The hostile-keeper section is the point of this file. Everything else is
// bookkeeping; that section is what has to hold if the server is taken.
//
// Explicit gasLimit on every state-changing call, per CLAUDE.md gotcha 8.
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const say = (...a) => fs.writeSync(1, a.join(" ") + "\n");
const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
const check = (c, n) => { if (c) { passed++; say(`  ok  ${n}`); } else { failed++; say(`FAIL  ${n}`); } };

async function reverts(fn, label, want) {
  try { await fn(); failed++; say(`FAIL  ${label} (did not revert)`); }
  catch (e) {
    const m = e.shortMessage || e.message || "";
    if (want && !m.includes(want)) { failed++; say(`FAIL  ${label} (wrong reason: ${m.slice(0, 90)})`); }
    else { passed++; say(`  ok  ${label}`); }
  }
}

async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100000 }, miner: { blockGasLimit: "0x1C9C380" } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, ownerS, keeper, attacker] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 6_000_000 };
  const warp = async (s) => { await gp.request({ method: "evm_increaseTime", params: [s] }); await gp.request({ method: "evm_mine", params: [] }); };
  const dep = async (name, signer, ...args) => {
    const a = build(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  const usdt = await dep("MockUSDT0", deployer);
  const tok = await dep("TestToken", deployer, "Coin", "COIN", 18, E(1_000_000_000), deployer.address, 0, 0);
  const usdtA = await usdt.getAddress(), tokA = await tok.getAddress();

  // A pool double that serves a real TWAP and a real swap, so the vault's own
  // maths is what is under test rather than a live Uniswap deployment.
  const pool = await dep("MockTwapPool", deployer, usdtA, tokA, 10000);
  const poolA = await pool.getAddress();
  const fac = await dep("MockV3Factory", deployer);
  await (await fac.set(usdtA, tokA, 10000, poolA, GS)).wait();
  const router = await dep("MockTwapRouter", deployer, poolA);
  const routerA = await router.getAddress(), facA = await fac.getAddress();
  await (await tok.transfer(routerA, E(500_000_000), GS)).wait(); // router pays out from stock

  // Target: 1 COIN costs 0.001 USDT0, so 1 USDT0 buys 1000 COIN.
  // A tick is a ratio of RAW amounts, and which way up depends on address
  // ordering, so it is derived here rather than hardcoded.
  const quoteIs0 = BigInt(usdtA) < BigInt(tokA);
  const rawPerQuote = 1000 * 1e18 / 1e6;              // COIN raw per USDT0 raw
  const ratio = quoteIs0 ? rawPerQuote : 1 / rawPerQuote; // token1 per token0
  const TICK = Math.round(Math.log(ratio) / Math.log(1.0001));
  await (await pool.setTick(TICK, GS)).wait();

  say("\n-- factory");
  const f = await dep("BuybackVaultFactory", deployer, usdtA, routerA, facA);
  const fA = await f.getAddress();
  await (await f.connect(ownerS).create(tokA, poolA, GS)).wait();
  const vAddr = await f.vaults(0);
  const v = new ethers.Contract(vAddr, build("BuybackVault").abi, provider);
  check(await f.isVault(vAddr), "factory records its own deployment");
  check(!(await f.isVault(attacker.address)), "isVault is false for anything it did not deploy");
  check((await v.owner()) === ownerS.address, "vault owner is the caller, not the factory");
  // 1% pool fee tier: the router's output is net of the fee while the TWAP is
  // not, so a flat 1% tolerance would revert on every real pool.
  check((await v.maxSlippageBps()) === 200n, "default tolerance clears the pool fee (fee 1% + 1%)");
  check((await f.byOwner(ownerS.address)).length === 1, "vault indexed by owner");

  say("\n-- a non-canonical pool is refused at construction");
  const fakePool = await dep("MockTwapPool", deployer, usdtA, tokA, 10000);
  // Address resolved BEFORE the callback: `await` inside a non-async arrow is a
  // syntax error, which CLAUDE.md records as having cost time here before.
  const fakeA = await fakePool.getAddress();
  await reverts(() => f.connect(ownerS).create.staticCall(tokA, fakeA),
    "a pool the canonical factory does not know is rejected", "not canonical");

  say("\n-- deposit and withdraw");
  await (await usdt.connect(ownerS).approve(vAddr, ethers.MaxUint256, GS)).wait();
  await (await v.connect(ownerS).deposit(U(1000), GS)).wait();
  check((await v.balances())[0] === U(1000), "deposit credited");
  // Asserted on the event, not on the owner's balance delta. MockUSDT0 mirrors
  // the NATIVE balance, and the owner pays gas for their own withdrawal, so a
  // balance comparison is short by the gas and reads as a contract bug.
  const wrc = await (await v.connect(ownerS).withdraw(usdtA, U(400), GS)).wait();
  const wev = wrc.logs.map((l) => { try { return v.interface.parseLog(l); } catch { return null; } })
                      .find((x) => x && x.name === "Withdrawn");
  check(wev && wev.args.amount === U(400), "partial withdraw pays the owner exactly 400");
  check(wev && wev.args.asset.toLowerCase() === usdtA.toLowerCase(), "and reports which asset moved");
  check((await v.balances())[0] === U(600), "and leaves the rest");

  say("\n-- HOSTILE KEEPER");
  await (await v.connect(ownerS).setAgent(keeper.address, GS)).wait();
  await reverts(() => v.connect(keeper).withdraw.staticCall(usdtA, U(600)), "keeper cannot withdraw", "not owner");
  await reverts(() => v.connect(keeper).withdrawAll.staticCall(), "keeper cannot withdrawAll", "not owner");
  await reverts(() => v.connect(keeper).setAgent.staticCall(attacker.address), "keeper cannot reassign the agent", "not owner");
  await reverts(() => v.connect(keeper).setParams.staticCall(2500, 1000, 300, 0), "keeper cannot loosen the bounds", "not owner");
  await reverts(() => v.connect(attacker).execute.staticCall(), "a stranger cannot execute", "not agent");
  check(v.interface.getFunction("execute").inputs.length === 0,
    "execute takes NO arguments, so no caller can supply a price, size or recipient");

  say("\n-- execution is bounded");
  await (await v.connect(keeper).execute(GS)).wait();
  const [q1, t1] = await v.balances();
  check(q1 === U(570), "spends exactly the 5% slice, not the balance");
  check(t1 > 0n, "and the bought token stays in the vault");
  await reverts(() => v.connect(keeper).execute.staticCall(), "cooldown blocks a second execution", "cooldown");
  await warp(700);
  await (await pool.setTick(TICK, GS)).wait();   // a live pool records observations; keep it fresh
  await (await v.connect(keeper).execute(GS)).wait();
  check((await v.balances())[0] === U(541.5), "next slice is 5% of the NEW balance");

  say("\n-- the price floor comes from the TWAP, not the caller");
  const minOut = await v.previewMinOut(U(100));
  // 100 USDT0 at 0.001 per COIN = 100,000 COIN, less the 2% default tolerance
  // (1% pool fee + 1%), so ~98,000.
  check(minOut > E(97_900) && minOut <= E(98_000), `minOut tracks the TWAP (${ethers.formatEther(minOut)})`);
  // Push the executable price away from the TWAP and the swap must fail rather
  // than fill: this is the sandwich the keeper cannot perform.
  await (await router.setDiscount(2000, GS)).wait(); // router pays 20% under
  await warp(700);
  await (await pool.setTick(TICK, GS)).wait();
  await reverts(() => v.connect(keeper).execute.staticCall(), "a 20% adverse fill reverts instead of executing", "Too little received");
  await (await router.setDiscount(0, GS)).wait();

  say("\n-- owner keeps control throughout");
  await (await v.connect(ownerS).setAgent(ethers.ZeroAddress, GS)).wait();
  await reverts(() => v.connect(keeper).execute.staticCall(), "revoked keeper cannot execute", "not agent");
  const oq = await usdt.balanceOf(ownerS.address), ot = await tok.balanceOf(ownerS.address);
  await (await v.connect(ownerS).withdrawAll(GS)).wait();
  check((await usdt.balanceOf(ownerS.address)) > oq, "owner withdraws USDT0 with no agent set");
  check((await tok.balanceOf(ownerS.address)) > ot, "and the bought token too");
  const [q2, t2] = await v.balances();
  check(q2 === 0n && t2 === 0n, "vault is empty afterwards");

  say("\n-- withdrawAll skips a zero leg instead of reverting");
  await (await v.connect(ownerS).deposit(U(10), GS)).wait();
  await (await v.connect(ownerS).withdrawAll(GS)).wait(); // token side is zero
  check((await v.balances())[0] === 0n, "an empty token leg does not brick the exit");

  say("\n-- STALE ORACLE (the attack the review found)");
  // observe() does not revert when a pool has no recent history: it extrapolates
  // from the CURRENT tick, so the average equals spot and minOut is derived from
  // whatever price an attacker last pushed it to. Freshness has to be checked
  // on the observation, because a degenerate TWAP still yields a healthy minOut.
  await (await v.connect(ownerS).setAgent(keeper.address, GS)).wait(); // revoked earlier in this file
  await (await v.connect(ownerS).deposit(U(500), GS)).wait();          // emptied earlier; the
  // balance check runs before the oracle read, so an empty vault would revert
  // for the wrong reason and prove nothing about the oracle.
  await (await pool.setNewestObs(1, GS)).wait();          // newest observation is ancient
  await reverts(() => v.previewMinOut(U(100)), "a pool with no recent observation is refused", "stale oracle");
  await warp(700);
  await reverts(() => v.connect(keeper).execute.staticCall(), "and execute() refuses too, rather than buying at spot", "stale oracle");
  await (await pool.setCardinality(1, GS)).wait();
  await (await pool.setNewestObs(Math.floor(Date.now() / 1000) + 3600, GS)).wait();
  await reverts(() => v.previewMinOut(U(100)), "a single-slot oracle is refused as unarmed", "oracle unarmed");
  await (await pool.setCardinality(64, GS)).wait();
  await (await pool.setTick(TICK, GS)).wait();            // restamps freshness
  check((await v.previewMinOut(U(100))) > 0n, "a fresh, armed oracle works again");

  say("\n-- owner bounds are enforced");
  await reverts(() => v.connect(ownerS).setParams.staticCall(2501, 100, 1800, 600), "slice cap enforced", "slice");
  await reverts(() => v.connect(ownerS).setParams.staticCall(500, 1001, 1800, 600), "slippage cap enforced", "slippage");
  await reverts(() => v.connect(ownerS).setParams.staticCall(500, 100, 299, 600), "twap window floor enforced", "twap window");
  // cooldown 0 would make the slice cap meaningless: a keeper could call
  // execute() back to back in one block and convert the whole balance.
  await reverts(() => v.connect(ownerS).setParams.staticCall(500, 100, 1800, 0), "cooldown cannot be zero", "cooldown");
  await reverts(() => v.connect(ownerS).setParams.staticCall(500, 100, 1800, 59), "cooldown floor enforced", "cooldown");
  await (await v.connect(ownerS).setParams(1000, 300, 600, 60, GS)).wait();
  check((await v.sliceBps()) === 1000n, "owner can retune inside the bounds");

  say("\n-- 6-dec quote against an 18-dec token");
  await (await v.connect(ownerS).deposit(U(1000), GS)).wait();
  await (await v.connect(ownerS).setAgent(keeper.address, GS)).wait();
  await warp(700);
  await (await pool.setTick(TICK, GS)).wait();
  const [qBefore, tBefore] = await v.balances();
  await (await v.connect(keeper).execute(GS)).wait();
  const [qAfter, tAfter] = await v.balances();
  const spent = qBefore - qAfter, gained = tAfter - tBefore;
  // Derived from the balance actually present rather than assumed, so adding a
  // deposit earlier in the file cannot silently move this expectation.
  // 1 USDT0 buys 1000 COIN, so 6-dec in should give 18-dec out at 1000x.
  const expect = (spent * (10n ** 18n) * 1000n) / (10n ** 6n);
  const drift = Number(gained * 10000n / expect) / 100;
  check(drift > 99.5 && drift <= 100, `${ethers.formatUnits(spent, 6)} USDT0 buys ${ethers.formatEther(gained)} COIN, ${drift}% of expected, no 1e12 error`);

  say(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
