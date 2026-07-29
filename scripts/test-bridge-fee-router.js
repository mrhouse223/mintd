// Tests for BridgeFeeRouter.
//
//   node scripts/compile.js && node scripts/test-bridge-fee-router.js
//
// The test that justifies the contract's existence is "the fee is not taken when
// the burn reverts". Everything else here is about the fee being impossible to
// raise, redirect, or apply to a chain the router was not deployed for.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const U = (v) => ethers.parseUnits(String(v), 6); // USDC is 6-dec

let passed = 0, failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
async function reverts(fn, name) {
  try { const r = await (await fn()).wait(); check(r.status === 0, name, "expected revert, tx succeeded"); }
  catch { check(true, name); }
}
async function deployReverts(fn, name) {
  try { const c = await fn(); await c.waitForDeployment(); check(false, name, "expected revert"); }
  catch { check(true, name); }
}

const ARC_DOMAIN = 26, FEE_BPS = 100;

async function main() {
  const g = ganache.provider({
    logging: { quiet: true },
    wallet: { defaultBalance: 1000, mnemonic: "mintd bridge fee router deterministic test seed ok" },
    miner: { blockGasLimit: "0x1C9C380" },
  });
  const provider = new ethers.BrowserProvider(g);
  const [deployer, user, feeTo, other] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const USER = await user.getAddress(), FEETO = await feeTo.getAddress(), OTHER = await other.getAddress();

  // A boring 6-dec USDC stand-in, reusing the test token already in the repo.
  const tokArt = build("TestToken");
  const usdc = await new ethers.ContractFactory(tokArt.abi, tokArt.bytecode, deployer).deploy(
    "USD Coin", "USDC", 6, U(1_000_000), await deployer.getAddress(), U(1000), 3600);
  await usdc.waitForDeployment();
  const USDC = await usdc.getAddress();

  const mmArt = build("MockTokenMessenger");
  const mm = await new ethers.ContractFactory(mmArt.abi, mmArt.bytecode, deployer).deploy(USDC);
  await mm.waitForDeployment();
  const MM = await mm.getAddress();

  const rArt = build("BridgeFeeRouter");
  const RF = new ethers.ContractFactory(rArt.abi, rArt.bytecode, deployer);
  const router = await RF.deploy(USDC, MM, FEETO, FEE_BPS, ARC_DOMAIN);
  await router.waitForDeployment();
  const ROUTER = await router.getAddress();

  await (await usdc.connect(deployer).transfer(USER, U(10_000))).wait();
  await (await usdc.connect(user).approve(ROUTER, ethers.MaxUint256)).wait();

  console.log("\n=== the fee is fixed in bytecode, not policy ===");
  check(Number(await router.feeBps()) === FEE_BPS, "fee is the 100 bps it was deployed with");
  check(Number(await router.MAX_FEE_BPS()) === 100, "the hard ceiling is 1%");
  check(Number(await router.destinationDomain()) === ARC_DOMAIN, "destination domain is Arc, 26");
  check((await router.feeRecipient()) === FEETO, "fee recipient is fixed");
  await deployReverts(() => RF.deploy(USDC, MM, FEETO, 101, ARC_DOMAIN),
    "a fee above the ceiling cannot be deployed at all");
  await deployReverts(() => RF.deploy(USDC, MM, ethers.ZeroAddress, FEE_BPS, ARC_DOMAIN),
    "a zero fee recipient is rejected");
  await deployReverts(() => RF.deploy(USDC, OTHER, FEETO, FEE_BPS, ARC_DOMAIN),
    "an EOA as messenger is rejected, so a typo cannot burn nothing while charging");
  // No admin surface at all: the fee and its destination are unreachable.
  const fns = rArt.abi.filter((x) => x.type === "function").map((x) => x.name);
  check(!fns.some((n) => /^set|owner|admin|transferOwnership|upgrade/i.test(n)),
    "no setter, owner or upgrade path exists", `functions: ${fns.join(", ")}`);

  console.log("\n=== the split is exact and shown before signing ===");
  const q = await router.quote(U(1000));
  check(q.fee === U(10) && q.bridged === U(990), "quote(1000) is 10 fee and 990 bridged");

  const feeBefore = await usdc.balanceOf(FEETO);
  const userBefore = await usdc.balanceOf(USER);
  await (await router.connect(user).bridge(U(1000), ethers.zeroPadValue(USER, 32), { gasLimit: 500000 })).wait();
  check((await usdc.balanceOf(FEETO)) - feeBefore === U(10), "the fee recipient received exactly 1%");
  check(userBefore - (await usdc.balanceOf(USER)) === U(1000), "the user paid exactly the amount they named");
  const last = await mm.last();
  check(last.amount === U(990), "990 was burned, fee inclusive accounting");
  check(Number(last.destinationDomain) === ARC_DOMAIN, "burned toward Arc");
  check(last.mintRecipient === ethers.zeroPadValue(USER, 32), "mint recipient is the user");
  check(last.maxFee === 0n, "maxFee 0, so Circle takes no fast-path fee out of it");
  check(Number(last.minFinalityThreshold) === 2000, "standard finality, the free path");
  check(last.destinationCaller === ethers.ZeroHash,
    "destinationCaller is zero, so anyone can relay the mint and delivery does not depend on us");

  console.log("\n=== atomicity: the whole reason this is a contract ===");
  await (await mm.setShouldRevert(true)).wait();
  const feeBeforeFail = await usdc.balanceOf(FEETO);
  const userBeforeFail = await usdc.balanceOf(USER);
  await reverts(() => router.connect(user).bridge(U(500), ethers.zeroPadValue(USER, 32), { gasLimit: 500000 }),
    "a failing burn reverts the whole call");
  check((await usdc.balanceOf(FEETO)) === feeBeforeFail,
    "NO fee was taken when the burn failed, which a two-transaction flow could not promise");
  check((await usdc.balanceOf(USER)) === userBeforeFail, "the user lost nothing");
  await (await mm.setShouldRevert(false)).wait();

  console.log("\n=== inputs that must be refused ===");
  await reverts(() => router.connect(user).bridge(0, ethers.zeroPadValue(USER, 32), { gasLimit: 300000 }),
    "a zero amount is rejected");
  await reverts(() => router.connect(user).bridge(U(1000), ethers.ZeroHash, { gasLimit: 300000 }),
    "a zero mint recipient is rejected, because that burn would be unrecoverable on both chains");
  // 1 unit of 6-dec USDC: the 1% fee rounds to 0, so it bridges rather than
  // charging for nothing. The guard is against the reverse.
  const tiny = await router.quote(1n);
  check(tiny.fee === 0n && tiny.bridged === 1n, "dust rounds the fee down, never up");

  console.log("\n=== nothing is held at rest, and strays can only go one place ===");
  check((await usdc.balanceOf(ROUTER)) === 0n, "the router holds nothing after a bridge");
  await (await usdc.connect(deployer).transfer(ROUTER, U(7))).wait();
  const f0 = await usdc.balanceOf(FEETO);
  // Deliberately called by someone unrelated: flush is permissionless because
  // its destination is immutable, so it is not an admin hatch.
  await (await router.connect(other).flush({ gasLimit: 200000 })).wait();
  check((await usdc.balanceOf(FEETO)) - f0 === U(7), "flush moves strays to the fixed fee recipient");
  check((await usdc.balanceOf(ROUTER)) === 0n, "and leaves nothing behind");
  await reverts(() => router.connect(other).flush({ gasLimit: 200000 }), "flushing nothing reverts");

  console.log("\n=== bridgeTo convenience ===");
  await (await router.connect(user).bridgeTo(U(200), OTHER, { gasLimit: 500000 })).wait();
  const l2 = await mm.last();
  check(l2.mintRecipient === ethers.zeroPadValue(OTHER, 32), "bridgeTo pads an address correctly");
  check(l2.amount === U(198), "bridgeTo applies the same 1% fee");
  await reverts(() => router.connect(user).bridgeTo(U(10), ethers.ZeroAddress, { gasLimit: 300000 }),
    "bridgeTo rejects the zero address");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
