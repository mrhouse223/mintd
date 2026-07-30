// ARX token tests. Real ganache, real deployment, no mocks.
//
//   node scripts/compile.js && node scripts/test-arx-token.js
//
// Every state-changing call passes an explicit gasLimit. CLAUDE.md records why:
// eth_estimateGas reports the NET cost when a call clears storage and earns a
// refund, while the EVM charges the GROSS, so an estimated transaction runs out
// of gas and reverts with no reason string. Transfers that zero a balance do
// exactly that, so this suite would flake without it.
const ganache = require("ganache");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ART = path.join(__dirname, "..", "build", "ArxToken.json");
const GAS = { gasLimit: 300000 };
const SUPPLY = 100_000_000n * 10n ** 18n;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? "  " + extra : "")); }
}
function eq(name, got, want) { ok(name, got === want, `got ${got}, want ${want}`); }
// Awaits the RECEIPT, not just the send. With an explicit gasLimit ethers skips
// estimateGas, which is the only client-side thing that would have caught the
// revert, so the transaction is accepted and only fails when mined. Awaiting
// fn() alone therefore reported four genuinely reverting calls as "did not
// revert". The explicit gasLimit is still required (see the header), so the
// assertion has to move rather than the gas.
// Call sites use staticCall so the revert REASON comes back. A mined revert
// surfaces only as "transaction execution reverted", which would let a require
// that fires for the wrong reason pass as if it were the right one.
async function reverts(name, fn, why) {
  try {
    const r = await fn();
    if (r && typeof r.wait === "function") await r.wait();
    failed++; console.log("  FAIL " + name + "  (did not revert)");
  } catch (e) {
    const m = (e.shortMessage || e.message || "").toLowerCase();
    ok(name, !why || m.includes(why), `reverted with "${m.slice(0, 70)}"`);
  }
}

(async () => {
  if (!fs.existsSync(ART)) { console.log("build/ArxToken.json missing. Run node scripts/compile.js"); process.exit(1); }
  const art = JSON.parse(fs.readFileSync(ART, "utf8"));

  const server = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 1000 } });
  await server.listen(8547);
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8547", 1337, { staticNetwork: true });
  const [dep, alice, bob] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const [depA, aliceA, bobA] = await Promise.all([dep, alice, bob].map((s) => s.getAddress()));

  console.log("\nARX token");
  const f = new ethers.ContractFactory(art.abi, art.bytecode, dep);
  const t = await (await f.deploy(SUPPLY, { gasLimit: 3_000_000 })).waitForDeployment();
  const addr = await t.getAddress();

  console.log("\n supply and metadata");
  eq("name", await t.name(), "ArcSwap");
  eq("symbol", await t.symbol(), "ARX");
  eq("decimals", Number(await t.decimals()), 18);
  eq("totalSupply is 100M", (await t.totalSupply()).toString(), SUPPLY.toString());
  eq("deployer holds all of it", (await t.balanceOf(depA)).toString(), SUPPLY.toString());

  console.log("\n the 80/20 split this token exists for");
  const keep = SUPPLY * 20n / 100n;
  const toLp = SUPPLY - keep;
  await (await t.transfer(aliceA, toLp, GAS)).wait();   // alice stands in for the LP position
  eq("80% moved to liquidity", (await t.balanceOf(aliceA)).toString(), toLp.toString());
  eq("20% held back", (await t.balanceOf(depA)).toString(), keep.toString());
  eq("supply unchanged by the split", (await t.totalSupply()).toString(), SUPPLY.toString());

  console.log("\n there is no way to create or destroy supply");
  ok("no mint function", !art.abi.some((x) => x.name === "mint"));
  ok("no burn function", !art.abi.some((x) => /^burn/i.test(x.name || "")));
  ok("no owner", !art.abi.some((x) => x.name === "owner"));
  ok("no pause", !art.abi.some((x) => /pause/i.test(x.name || "")));
  ok("no blacklist", !art.abi.some((x) => /blacklist|blocklist|denylist/i.test(x.name || "")));
  ok("no setter of any kind", !art.abi.some((x) => /^set[A-Z]/.test(x.name || "")));

  console.log("\n transfers");
  await (await t.connect(alice).transfer(bobA, 1000n, GAS)).wait();
  eq("recipient credited", (await t.balanceOf(bobA)).toString(), "1000");
  await reverts("cannot overspend", () => t.connect(bob).transfer.staticCall(aliceA, 2000n), "balance");
  await reverts("cannot send to the zero address", () => t.connect(bob).transfer.staticCall(ethers.ZeroAddress, 1n), "bad recipient");
  await reverts("cannot send to the token itself", () => t.connect(bob).transfer.staticCall(addr, 1n), "bad recipient");

  console.log("\n a transfer that zeroes a balance still fits in gas");
  // The case the estimator gets wrong: clearing a slot earns a refund, so an
  // estimated limit is below what the EVM actually charges.
  await (await t.connect(bob).transfer(aliceA, 1000n, GAS)).wait();
  eq("balance fully drained", (await t.balanceOf(bobA)).toString(), "0");

  console.log("\n allowances");
  await (await t.connect(alice).approve(bobA, 500n, GAS)).wait();
  eq("allowance recorded", (await t.allowance(aliceA, bobA)).toString(), "500");
  await (await t.connect(bob).transferFrom(aliceA, bobA, 200n, GAS)).wait();
  eq("allowance decremented", (await t.allowance(aliceA, bobA)).toString(), "300");
  await reverts("cannot exceed the allowance", () => t.connect(bob).transferFrom.staticCall(aliceA, bobA, 400n), "allowance");

  console.log("\n infinite allowance is not decremented");
  // Routers and the position manager rely on this; decrementing would also cost
  // every caller a storage write forever.
  await (await t.connect(alice).approve(bobA, ethers.MaxUint256, GAS)).wait();
  await (await t.connect(bob).transferFrom(aliceA, bobA, 1n, GAS)).wait();
  eq("still infinite", (await t.allowance(aliceA, bobA)).toString(), ethers.MaxUint256.toString());

  console.log("\n no fee on transfer, which the V3 position depends on");
  const before = await t.balanceOf(bobA);
  await (await t.connect(alice).transfer(bobA, 12345n, GAS)).wait();
  eq("received exactly what was sent", ((await t.balanceOf(bobA)) - before).toString(), "12345");

  console.log("\n supply is conserved across every account");
  const total = (await t.balanceOf(depA)) + (await t.balanceOf(aliceA)) + (await t.balanceOf(bobA));
  eq("balances sum to totalSupply", total.toString(), SUPPLY.toString());

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
