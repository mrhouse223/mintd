// Furnace, against real ERC-20s in ganache.
//   node scripts/compile.js && node scripts/test-furnace.js
//
// The properties that matter: the contract never holds tokens, it records what
// actually reached the dead address rather than what was asked for, and it has
// no admin surface of any kind.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));
const DEAD = "0x000000000000000000000000000000000000dEaD";

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }
// Explicit gasLimit means ethers skips estimateGas, so a reverting call is
// mined as a failed transaction instead of throwing. Check the receipt.
async function reverts(fn, n) {
  try {
    const tx = await fn();
    const r = await tx.wait();
    check(r.status === 0, r.status === 0 ? n : n + " (expected revert, got success)");
  } catch { check(true, n); }
}

async function main() {
  const provider = new ethers.BrowserProvider(ganache.provider({
    logging: { quiet: true }, wallet: { defaultBalance: 1_000_000 }, miner: { blockGasLimit: "0x1C9C380" },
  }));
  const [deployer, alice, bob] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const GS = { gasLimit: 3_000_000 };
  const dep = async (name, signer, ...a) => {
    const art = build(name);
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(...a);
    await c.waitForDeployment();
    return c;
  };

  const fur = await dep("Furnace", deployer);
  const furAddr = await fur.getAddress();
  const tok = await dep("MockUSDT0", deployer);
  const tokAddr = await tok.getAddress();

  check((await fur.DEAD()).toLowerCase() === DEAD.toLowerCase(), "burns to 0x…dEaD");
  check((await fur.tokenCount()) === 0n, "starts with no tokens recorded");

  // ------------------------------------------------------------- happy path
  await (await tok.connect(deployer).transfer(alice.address, 1_000_000n, GS)).wait();
  await (await tok.connect(alice).approve(furAddr, ethers.MaxUint256, GS)).wait();

  const deadBefore = await tok.balanceOf(DEAD);
  await (await fur.connect(alice).burn(tokAddr, 400_000n, GS)).wait();
  check((await tok.balanceOf(DEAD)) === deadBefore + 400_000n, "tokens land at the dead address");
  check((await fur.burnedOf(tokAddr)) === 400_000n, "burnedOf records the amount");
  check((await fur.burnCountOf(tokAddr)) === 1n, "burnCountOf increments");
  check((await fur.tokenCount()) === 1n, "token added to the list");

  // the whole point: no custody, ever
  check((await tok.balanceOf(furAddr)) === 0n, "furnace holds no balance after a burn");

  // ------------------------------------------------------------ accumulation
  await (await fur.connect(alice).burn(tokAddr, 100_000n, GS)).wait();
  check((await fur.burnedOf(tokAddr)) === 500_000n, "totals accumulate across burns");
  check((await fur.burnCountOf(tokAddr)) === 2n, "count accumulates");
  check((await fur.tokenCount()) === 1n, "same token is not listed twice");

  // a second burner, same token
  await (await tok.connect(deployer).transfer(bob.address, 50_000n, GS)).wait();
  await (await tok.connect(bob).approve(furAddr, ethers.MaxUint256, GS)).wait();
  await (await fur.connect(bob).burn(tokAddr, 50_000n, GS)).wait();
  check((await fur.burnedOf(tokAddr)) === 550_000n, "totals span different burners");

  // ------------------------------------------------- attribution is the point
  // balanceOf(DEAD) counts burns by anyone. burnedOf counts burns made HERE.
  // The frontend headline depends on these being different numbers.
  await (await tok.connect(deployer).transfer(DEAD, 9_000_000n, GS)).wait();
  const anyBurn = await tok.balanceOf(DEAD);
  check(anyBurn > (await fur.burnedOf(tokAddr)),
    "a burn made outside the furnace raises balanceOf(DEAD) but not burnedOf");
  check((await fur.burnedOf(tokAddr)) === 550_000n, "outside burns do not inflate the furnace total");

  // ------------------------------------------------------- fee-on-transfer
  const fee = await dep("MockFeeToken", deployer, E(1000));
  const feeAddr = await fee.getAddress();
  await (await fee.connect(deployer).approve(furAddr, ethers.MaxUint256, GS)).wait();
  await (await fur.connect(deployer).burn(feeAddr, E(100), GS)).wait();
  // 10% is taken in transit, so 90 arrives and 90 is what must be recorded
  check((await fee.balanceOf(DEAD)) === E(90), "fee token delivers 90 of 100 requested");
  check((await fur.burnedOf(feeAddr)) === E(90),
    "records what ARRIVED, not what was requested");
  check((await fur.tokenCount()) === 2n, "second token listed");

  // ----------------------------------------------------------- bad behaviour
  const liar = await dep("MockLiarToken", deployer);
  const liarAddr = await liar.getAddress();
  await (await liar.connect(deployer).approve(furAddr, ethers.MaxUint256, GS)).wait();
  await reverts(() => fur.connect(deployer).burn(liarAddr, E(1), GS),
    "a token returning false is rejected, not recorded as burned");
  check((await fur.burnedOf(liarAddr)) === 0n, "nothing recorded for the failed burn");

  await reverts(() => fur.connect(alice).burn(tokAddr, 0, GS), "zero amount reverts");

  // no approval
  const tok2 = await dep("MockUSDT0", deployer);
  const tok2Addr = await tok2.getAddress();
  await reverts(() => fur.connect(alice).burn(tok2Addr, 1n, GS),
    "burning without approval reverts");

  // more than the balance
  await reverts(() => fur.connect(bob).burn(tokAddr, 10n ** 30n, GS),
    "burning more than the balance reverts");

  // ------------------------------------------------------------------ paging
  const pg = await fur.page(0, 10);
  check(pg[0].length === 2, "page returns both tokens");
  check(pg[1][0] === 550_000n, "page returns the right totals");
  const empty = await fur.page(99, 10);
  check(empty[0].length === 0, "page past the end returns empty, does not revert");
  const one = await fur.page(1, 1);
  check(one[0].length === 1 && one[0][0].toLowerCase() === feeAddr.toLowerCase(),
    "page honours offset and limit");

  // -------------------------------------------------------- no admin surface
  const names = build("Furnace").abi.filter((f) => f.type === "function").map((f) => f.name);
  const admin = names.filter((n) => /owner|pause|rescue|sweep|withdraw|admin|upgrade|set[A-Z]/.test(n));
  check(admin.length === 0, `no admin functions in the ABI (found: ${admin.join(", ") || "none"})`);
  check(!names.includes("transferOwnership"), "no ownership to transfer");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
