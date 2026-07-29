// Tests for TestToken.
//
//   node scripts/compile.js && node scripts/test-test-token.js
//
// The point of these is narrow: prove the token is BORING. AgentVault does
// `require(token.transfer(...))` and values itself from balanceOf, so a missing
// bool return or a transfer that moves less than it was asked to would surface
// as a vault failure and send someone debugging the wrong contract.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));

let passed = 0, failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
async function reverts(fn, name) {
  try { const r = await (await fn()).wait(); check(r.status === 0, name, "expected revert, tx succeeded"); }
  catch { check(true, name); }
}

async function main() {
  const g = ganache.provider({
    logging: { quiet: true },
    wallet: { defaultBalance: 1000, mnemonic: "mintd test token deterministic seed phrase goes here ok" },
    miner: { blockGasLimit: "0x1C9C380" },
  });
  const provider = new ethers.BrowserProvider(g);
  const warp = async (s) => { await g.request({ method: "evm_increaseTime", params: [s] }); await g.request({ method: "evm_mine", params: [] }); };
  const [deployer, alice, bob] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const ALICE = await alice.getAddress(), BOB = await bob.getAddress();
  const DEP = await deployer.getAddress();

  const art = build("TestToken");
  const COOLDOWN = 3600;
  // 6 decimals deliberately: the pair this ships with is 6/18, and a token that
  // is only ever tested at 18 hides exactly the conversion bug that has already
  // cost time on this project.
  const t = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(
    "Test USD", "tUSD", 6, ethers.parseUnits("1000000", 6), DEP,
    ethers.parseUnits("10000", 6), COOLDOWN);
  await t.waitForDeployment();
  const addr = await t.getAddress();

  console.log("\n=== shape ===");
  check((await t.name()) === "Test USD", "name is set");
  check((await t.symbol()) === "tUSD", "symbol is set");
  check(Number(await t.decimals()) === 6, "decimals reports 6, not a default 18");
  check((await t.totalSupply()) === ethers.parseUnits("1000000", 6), "initial supply minted");
  check((await t.balanceOf(DEP)) === ethers.parseUnits("1000000", 6), "initial supply went to the named holder");

  console.log("\n=== transfers return bool and move the exact amount ===");
  // staticCall so the RETURN VALUE is checked, not just that it did not revert.
  // A token returning nothing passes a "did it revert" test and still breaks
  // require(token.transfer(...)) inside the vault.
  check((await t.connect(deployer).transfer.staticCall(ALICE, 1n)) === true,
    "transfer returns true rather than nothing");
  check((await t.connect(deployer).approve.staticCall(ALICE, 1n)) === true, "approve returns true");

  const amt = ethers.parseUnits("1234.5", 6);
  const before = await t.balanceOf(ALICE);
  await (await t.connect(deployer).transfer(ALICE, amt, { gasLimit: 200000 })).wait();
  check((await t.balanceOf(ALICE)) - before === amt,
    "recipient receives exactly what was sent, no fee taken");

  await (await t.connect(alice).approve(BOB, ethers.MaxUint256, { gasLimit: 200000 })).wait();
  const b0 = await t.balanceOf(BOB);
  await (await t.connect(bob).transferFrom(ALICE, BOB, ethers.parseUnits("100", 6), { gasLimit: 200000 })).wait();
  check((await t.balanceOf(BOB)) - b0 === ethers.parseUnits("100", 6), "transferFrom moves the exact amount");
  check((await t.allowance(ALICE, BOB)) === ethers.MaxUint256,
    "an infinite allowance is not decremented, which is what routers expect");

  await (await t.connect(alice).approve(BOB, ethers.parseUnits("50", 6), { gasLimit: 200000 })).wait();
  await (await t.connect(bob).transferFrom(ALICE, BOB, ethers.parseUnits("20", 6), { gasLimit: 200000 })).wait();
  check((await t.allowance(ALICE, BOB)) === ethers.parseUnits("30", 6), "a finite allowance is decremented");
  await reverts(() => t.connect(bob).transferFrom(ALICE, BOB, ethers.parseUnits("31", 6), { gasLimit: 200000 }),
    "spending past the allowance reverts");
  await reverts(() => t.connect(bob).transfer(ALICE, ethers.parseUnits("999999999", 6), { gasLimit: 200000 }),
    "spending past the balance reverts");
  await reverts(() => t.connect(deployer).transfer(ethers.ZeroAddress, 1n, { gasLimit: 200000 }),
    "sending to the zero address reverts rather than burning silently");

  console.log("\n=== faucet ===");
  const fa = ethers.parseUnits("10000", 6);
  const a0 = await t.balanceOf(ALICE);
  await (await t.connect(alice).faucet({ gasLimit: 200000 })).wait();
  check((await t.balanceOf(ALICE)) - a0 === fa, "faucet mints the stated amount");
  check((await t.faucetReadyIn(ALICE)) > 0n, "the cooldown is reported as pending");
  await reverts(() => t.connect(alice).faucet({ gasLimit: 200000 }),
    "a second faucet inside the cooldown reverts rather than quietly minting nothing");

  // A different address is unaffected: the cooldown is per caller, so one
  // person looping cannot lock the faucet for everyone else.
  const b1 = await t.balanceOf(BOB);
  await (await t.connect(bob).faucet({ gasLimit: 200000 })).wait();
  check((await t.balanceOf(BOB)) - b1 === fa, "the cooldown is per address, not global");

  await warp(COOLDOWN + 10);
  check((await t.faucetReadyIn(ALICE)) === 0n, "cooldown reports ready once elapsed");
  const a1 = await t.balanceOf(ALICE);
  await (await t.connect(alice).faucet({ gasLimit: 200000 })).wait();
  check((await t.balanceOf(ALICE)) - a1 === fa, "faucet works again after the cooldown");

  console.log("\n=== an 18-decimal instance behaves identically ===");
  const t18 = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(
    "Test ETH", "tETH", 18, ethers.parseUnits("1000", 18), DEP,
    ethers.parseUnits("5", 18), COOLDOWN);
  await t18.waitForDeployment();
  check(Number(await t18.decimals()) === 18, "second token reports 18 decimals");
  const c0 = await t18.balanceOf(BOB);
  await (await t18.connect(bob).faucet({ gasLimit: 200000 })).wait();
  check((await t18.balanceOf(BOB)) - c0 === ethers.parseUnits("5", 18),
    "faucet amount respects that token's own decimals");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
