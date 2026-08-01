// Integration tests for BondMarket.
//   node scripts/compile.js && node scripts/test-bonds.js
//
// Covers: escrow-first custody, the fee split, linear and stepped vesting,
// dust-freeness (claim every block vs claim once must agree to the wei),
// the wallet cap, allowlist gating through the launchpad, reclaim limited to
// unsold, reentrancy, fee-on-transfer measurement, and admin bounds.
//
// Every state-changing call passes an explicit gasLimit. CLAUDE.md gotcha 8:
// eth_estimateGas returns the NET figure when a call clears storage and gets a
// refund, while the EVM charges the GROSS, so the transaction runs out of gas
// and reverts with no reason string.
const fs = require("fs");
const path = require("path");
// fs.writeSync, not console.log: stdout to a FILE is block-buffered, so a run
// that stalls shows a log frozen several sections behind where it actually is,
// and the last line printed points at innocent code.
const say = (...a) => fs.writeSync(1, a.join(" ") + "\n");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);
const DAY = 86400;

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; say(`  ok  ${n}`); } else { failed++; say(`FAIL  ${n}`); } }

// Revert assertions go through staticCall so eth_call returns the reason
// string. Sending the transaction instead only fails when it is mined, and an
// explicit gasLimit skips estimation, so the send itself resolves and the
// assertion passes on a call that actually reverted.
async function reverts(fn, label, want) {
  try { await fn(); failed++; say(`FAIL  ${label} (did not revert)`); }
  catch (e) {
    const m = e.shortMessage || e.message || "";
    if (want && !m.includes(want)) { failed++; say(`FAIL  ${label} (wrong reason: ${m.slice(0, 80)})`); }
    else { passed++; say(`  ok  ${label}`); }
  }
}

async function main() {
  const gp = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100000 }, miner: { blockGasLimit: "0x1C9C380" } });
  const provider = new ethers.BrowserProvider(gp);
  const [deployer, safe, dev, alice, bob] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 6_000_000 };
  const warp = async (s) => { await gp.request({ method: "evm_increaseTime", params: [s] }); await gp.request({ method: "evm_mine", params: [] }); };
  const dep = async (name, signer, ...args) => {
    const a = build(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  const usdt = await dep("MockUSDT0", deployer);
  const usdtAddr = await usdt.getAddress();
  const tok = await dep("TestToken", deployer, "Mentos", "MENTOS", 18, E(1_000_000_000), deployer.address, 0, 0);
  const tokAddr = await tok.getAddress();

  // 1% fee to the Safe, no creation fee, no pads registered (allowlist by hand)
  const bm = await dep("BondMarket", deployer, usdtAddr, safe.address, 100, 0, []);
  const bmAddr = await bm.getAddress();

  say("\n-- allowlist");
  check(!(await bm.isAllowed(tokAddr)), "unlisted token is rejected by isAllowed");
  await reverts(() => bm.connect(dev).create.staticCall(tokAddr, E(1), 50, 0, 7 * DAY, 30 * DAY, 0, 0),
    "create reverts for an unlisted token", "token not allowed");
  await (await bm.setAllowed(tokAddr, true, GS)).wait();
  check(await bm.isAllowed(tokAddr), "listed token passes isAllowed");
  await reverts(() => bm.connect(dev).setAllowed.staticCall(tokAddr, false), "only owner may list", "not owner");

  say("\n-- create escrows first");
  // The worked example: 20M tokens, 1000 USDT0, so 50 quote units per 1e18.
  await (await tok.transfer(dev.address, E(100_000_000), GS)).wait();
  await (await tok.connect(dev).approve(bmAddr, ethers.MaxUint256, GS)).wait();
  await (await bm.connect(dev).create(tokAddr, E(20_000_000), 50, 0, 7 * DAY, 30 * DAY, 0, 0, GS)).wait();
  check((await tok.balanceOf(bmAddr)) === E(20_000_000), "escrow sits in the contract before any buyer pays");
  check((await bm.bondCount()) === 1n, "bond recorded");
  check((await bm.heldOf(tokAddr)) === E(20_000_000), "heldOf tracks the escrow");

  say("\n-- buy, fee split, pricing");
  // MockUSDT0 mirrors each account's native balance, so the signers are already
  // funded; only the approval is needed.
  for (const s of [alice, bob]) {
    await (await usdt.connect(s).approve(bmAddr, ethers.MaxUint256, GS)).wait();
  }
  const devBefore = await usdt.balanceOf(dev.address);
  const safeBefore = await usdt.balanceOf(safe.address);
  await (await bm.connect(alice).buy(0, U(1000), 0, GS)).wait();
  const pos = await bm.positions(0, alice.address);
  check(pos.total === E(20_000_000), "1000 USDT0 buys exactly 20,000,000 tokens (6-dec vs 18-dec)");
  check((await usdt.balanceOf(safe.address)) - safeBefore === U(10), "1% fee lands at the Safe");
  check((await usdt.balanceOf(dev.address)) - devBefore === U(990), "dev nets 990, fee came out of the raise");
  check((await usdt.balanceOf(bmAddr)) === 0n, "contract never holds USDT0");

  say("\n-- vesting is linear and dust-free");
  check((await bm.claimable(0, alice.address)) === 0n, "nothing vested at t=0");
  await warp(15 * DAY);
  const half = await bm.claimable(0, alice.address);
  check(half > E(9_900_000) && half <= E(10_000_000), `~half vested at 15d (${ethers.formatEther(half)})`);
  await (await bm.connect(alice).claim(0, GS)).wait();

  // Claim repeatedly across the rest of the term. The cumulative formula must
  // make this pay exactly the same total as a single claim at the end.
  for (let i = 0; i < 15; i++) { await warp(DAY); await (await bm.connect(alice).claim(0, GS)).wait(); }
  await warp(30 * DAY);
  if ((await bm.claimable(0, alice.address)) > 0n) await (await bm.connect(alice).claim(0, GS)).wait();
  check((await tok.balanceOf(alice.address)) === E(20_000_000), "claiming every day pays the full 20,000,000, no dust lost");
  check((await bm.claimable(0, alice.address)) === 0n, "nothing left claimable once fully vested");
  await reverts(() => bm.connect(alice).claim.staticCall(0), "claiming again reverts", "not vested");

  say("\n-- a single claim at the end pays the identical total");
  await (await bm.connect(dev).create(tokAddr, E(20_000_000), 50, 0, 7 * DAY, 30 * DAY, 0, 0, GS)).wait();
  await (await bm.connect(bob).buy(1, U(1000), 0, GS)).wait();
  await warp(31 * DAY);
  await (await bm.connect(bob).claim(1, GS)).wait();
  check((await tok.balanceOf(bob.address)) === E(20_000_000), "one claim at the end pays the same 20,000,000 to the wei");

  say("\n-- stepped vesting (every 10 minutes)");
  await (await bm.connect(dev).create(tokAddr, E(1_000_000), 50, 0, DAY, 3600, 600, 0, GS)).wait();
  await (await bm.connect(alice).buy(2, U(50), 0, GS)).wait();
  await warp(300); // half a step in
  check((await bm.claimable(2, alice.address)) === 0n, "stepped mode releases nothing before the first tick");
  await warp(360); // now past 600s
  const step1 = await bm.claimable(2, alice.address);
  check(step1 === E(1_000_000) / 6n, `first 10-minute tick releases exactly one sixth (${ethers.formatEther(step1)})`);
  await warp(3600);
  check((await bm.claimable(2, alice.address)) === E(1_000_000), "stepped mode reaches the full amount");

  say("\n-- wallet cap counts lifetime purchases");
  await (await bm.connect(dev).create(tokAddr, E(10_000_000), 50, 0, 90 * DAY, 30 * DAY, 0, E(2_000_000), GS)).wait();
  await (await bm.connect(alice).buy(3, U(100), 0, GS)).wait(); // 2,000,000 exactly at the cap
  await reverts(() => bm.connect(alice).buy.staticCall(3, U(1), 0), "cap blocks a second buy", "wallet cap");
  // 90-day window on purpose: the point of the next assertion is that the cap
  // survives a claim, so the sale must still be open once the vest has run.
  await warp(31 * DAY);
  await (await bm.connect(alice).claim(3, GS)).wait();
  await reverts(() => bm.connect(alice).buy.staticCall(3, U(1), 0),
    "cap still blocks after claiming, so it cannot be reset by emptying the position", "wallet cap");

  say("\n-- oversell and slippage");
  await reverts(() => bm.connect(bob).buy.staticCall(3, U(10_000), 0), "cannot buy more than is escrowed", "sold out");
  await reverts(() => bm.connect(bob).buy.staticCall(3, U(10), E(999_999_999)), "minTokens is enforced", "slippage");

  say("\n-- reclaim only ever returns the unsold remainder");
  await warp(90 * DAY); // close the 90-day window before reclaiming
  const sold = (await bm.bonds(3)).sold;
  const escrowed = (await bm.bonds(3)).escrowed;
  await reverts(() => bm.connect(alice).reclaim.staticCall(3), "only the creator may reclaim", "not creator");
  const devTokBefore = await tok.balanceOf(dev.address);
  await (await bm.connect(dev).reclaim(3, GS)).wait();
  check((await tok.balanceOf(dev.address)) - devTokBefore === escrowed - sold, "reclaim returns exactly escrowed minus sold");
  await reverts(() => bm.connect(dev).reclaim.staticCall(3), "reclaim cannot be repeated", "done");

  say("\n-- creator cannot touch sold tokens");
  await (await bm.connect(dev).create(tokAddr, E(1_000_000), 50, 0, 100, 30 * DAY, 0, 0, GS)).wait();
  await (await bm.connect(bob).buy(4, U(50), 0, GS)).wait(); // buys the whole escrow
  await reverts(() => bm.connect(dev).reclaim.staticCall(4), "cannot reclaim while the sale is open", "sale open");
  await warp(200);
  await reverts(() => bm.connect(dev).reclaim.staticCall(4), "nothing unsold to reclaim once fully sold", "nothing unsold");
  await warp(31 * DAY);
  await (await bm.connect(bob).claim(4, GS)).wait();
  check((await bm.claimable(4, bob.address)) === 0n, "buyer still received the full sold amount");

  say("\n-- sale window");
  await (await bm.connect(dev).create(tokAddr, E(1_000_000), 50, 1000, 1000, 30 * DAY, 0, 0, GS)).wait();
  await reverts(() => bm.connect(bob).buy.staticCall(5, U(1), 0), "cannot buy before the window opens", "not open");
  await warp(2500);
  await reverts(() => bm.connect(bob).buy.staticCall(5, U(1), 0), "cannot buy after the window closes", "closed");

  say("\n-- fee-on-transfer token escrows its true delta");
  const fee = await dep("MockFeeToken", deployer, E(1_000_000)); // takes a fixed 10% cut
  const feeAddr = await fee.getAddress();
  await (await bm.setAllowed(feeAddr, true, GS)).wait();
  await (await fee.transfer(dev.address, E(100_000), GS)).wait();
  await (await fee.connect(dev).approve(bmAddr, ethers.MaxUint256, GS)).wait();
  const heldBefore = await fee.balanceOf(bmAddr);
  await (await bm.connect(dev).create(feeAddr, E(10_000), 50, 0, DAY, DAY, 0, 0, GS)).wait();
  const bondFee = await bm.bonds(6);
  const actually = (await fee.balanceOf(bmAddr)) - heldBefore;
  check(bondFee.escrowed === actually, `escrowed records what arrived (${ethers.formatEther(bondFee.escrowed)}), not what was asked for`);
  check(bondFee.escrowed < E(10_000), "and that is less than the stated amount");

  say("\n-- admin bounds");
  await reverts(() => bm.setParams.staticCall(301, 0, safe.address), "fee cannot exceed the 3% cap", "fee too high");
  await reverts(() => bm.setParams.staticCall(100, 0, ethers.ZeroAddress), "fee recipient cannot be zero", "zero");
  await (await bm.setParams(100, 0, safe.address, GS)).wait();
  check((await bm.feeBps()) === 100n, "fee stays at 1%");
  await reverts(() => bm.connect(dev).setPaused.staticCall(true), "only owner may pause", "not owner");

  say("\n-- pause blocks new money, never a claim");
  await (await bm.connect(dev).create(tokAddr, E(1_000_000), 50, 0, DAY, 30 * DAY, 0, 0, GS)).wait();
  await (await bm.connect(bob).buy(7, U(10), 0, GS)).wait();
  await (await bm.setPaused(true, GS)).wait();
  await reverts(() => bm.connect(bob).buy.staticCall(7, U(1), 0), "paused blocks buying", "paused");
  await reverts(() => bm.connect(dev).create.staticCall(tokAddr, E(1), 50, 0, DAY, DAY, 0, 0), "paused blocks creating", "paused");
  await warp(31 * DAY);
  const owed = await bm.claimable(7, bob.address);
  check(owed > 0n, "a paused market still shows what is owed");
  await (await bm.connect(bob).claim(7, GS)).wait();
  check((await bm.claimable(7, bob.address)) === 0n, "and still lets the buyer claim it");
  await (await bm.setPaused(false, GS)).wait();

  say("\n-- reentrancy");
  const eater = await dep("ReentrantBuyer", deployer, bmAddr);
  const eaterAddr = await eater.getAddress();
  await (await bm.setAllowed(eaterAddr, true, GS)).wait();
  await (await usdt.transfer(eaterAddr, U(1000), GS)).wait();
  await (await eater.approveAll(usdtAddr, GS)).wait();
  await (await eater.openBond(DAY, GS)).wait();
  await (await eater.buyIn(U(25), GS)).wait();
  await warp(2 * DAY);
  await (await eater.arm(GS)).wait();
  await reverts(() => eater.claimNow.staticCall(), "a token re-entering claim is rejected", "reentrancy");

  say("\n-- buying twice on one bond conserves tokens exactly");
  // The settle-and-restart branch is the most intricate code in the contract and
  // the only place p.claimed is reset, so it gets an odd amount, an irregular
  // claim offset, and a to-the-wei conservation check rather than a smoke test.
  await (await bm.connect(dev).create(tokAddr, E(20_000_000), 50, 0, 90 * DAY, 30 * DAY, 0, 0, GS)).wait();
  const RB = Number(await bm.bondCount()) - 1;
  const aliceBefore = await tok.balanceOf(alice.address);
  await (await bm.connect(alice).buy(RB, U(137), 0, GS)).wait();
  await warp(3 * DAY + 777);
  await (await bm.connect(alice).claim(RB, GS)).wait();
  await (await bm.connect(alice).buy(RB, U(213), 0, GS)).wait(); // settles, restarts
  const pr = await bm.positions(RB, alice.address);
  const wantTotal = (U(137) + U(213)) * (10n ** 18n) / 50n;
  check(pr.bought === wantTotal, "bought accumulates across both purchases");
  await warp(31 * DAY);
  await (await bm.connect(alice).claim(RB, GS)).wait();
  const got = (await tok.balanceOf(alice.address)) - aliceBefore;
  check(got === wantTotal, `two purchases pay exactly what was bought, to the wei (${ethers.formatEther(got)})`);
  check((await bm.claimable(RB, alice.address)) === 0n, "nothing left owed after the combined schedule runs out");

  say("\n-- the fee is the bond's own, not whatever it is changed to later");
  // 5M escrowed because U(100) at price 50 buys 2,000,000 tokens.
  await (await bm.connect(dev).create(tokAddr, E(5_000_000), 50, 0, 90 * DAY, DAY, 0, 0, GS)).wait();
  const FBid = Number(await bm.bondCount()) - 1;
  await (await bm.setParams(300, 0, safe.address, GS)).wait(); // owner triples it
  const sBefore = await usdt.balanceOf(safe.address);
  await (await bm.connect(bob).buy(FBid, U(100), 0, GS)).wait();
  check((await usdt.balanceOf(safe.address)) - sBefore === U(1),
    "a bond opened at 1% still charges 1% after the owner raises the rate");
  await (await bm.setParams(100, 0, safe.address, GS)).wait();

  say("\n-- launchpad coins are allowed without being listed, on BOTH pad shapes");
  // The reason isAllowed uses a low-level staticcall: the two pads return
  // different launches() structs, so no single interface decodes both. Only the
  // first word is read, and `token` is the first member either way. Nothing
  // exercised that path before, so a pad-derived allowlist that silently never
  // matched would have shipped looking fine.
  const padOld = await dep("MockPadOld", deployer);
  const padNew = await dep("MockPadNew", deployer);
  const bm2 = await dep("BondMarket", deployer, usdtAddr, safe.address, 100, 0,
    [await padNew.getAddress(), await padOld.getAddress()]);
  const onOld = await dep("TestToken", deployer, "Old", "OLD", 18, E(1000), deployer.address, 0, 0);
  const onNew = await dep("TestToken", deployer, "New", "NEW", 18, E(1000), deployer.address, 0, 0);
  const stray = await dep("TestToken", deployer, "Stray", "STRAY", 18, E(1000), deployer.address, 0, 0);
  await (await padOld.set(await onOld.getAddress(), dev.address, GS)).wait();
  await (await padNew.set(await onNew.getAddress(), dev.address, GS)).wait();
  check(await bm2.isAllowed(await onOld.getAddress()), "a coin from the 7-field pad is allowed with no listing");
  check(await bm2.isAllowed(await onNew.getAddress()), "a coin from the 8-field pad is allowed with no listing");
  check(!(await bm2.isAllowed(await stray.getAddress())), "a coin from neither pad is still rejected");
  check(!(await bm2.isAllowed(ethers.ZeroAddress)), "the zero address is rejected despite matching a zero struct");
  // and it really escrows through that path, not just reports true
  await (await onNew.approve(await bm2.getAddress(), ethers.MaxUint256, GS)).wait();
  await (await bm2.create(await onNew.getAddress(), E(100), 50, 0, DAY, DAY, 0, 0, GS)).wait();
  check((await bm2.bondCount()) === 1n, "and a bond can actually be created on a pad-derived token");

  say(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
