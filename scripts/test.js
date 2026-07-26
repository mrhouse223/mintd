// Unit tests for StableLaunchpad, run against an in-process ganache EVM.
//   node scripts/compile.js && node scripts/test.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const E = (v) => ethers.parseEther(String(v));

let passed = 0,
  failed = 0;
function check(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}
function approxEq(a, b, tolBps = 1n) {
  const diff = a > b ? a - b : b - a;
  return diff * 10_000n <= (a > b ? a : b) * tolBps;
}

async function main() {
  const provider = new ethers.BrowserProvider(
    ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 100000 } })
  );
  const [deployer, feeRcpt, alice, bob] = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i))
  );

  // deploy mock router + launchpad
  const MockRouter = build("MockRouter");
  const router = await new ethers.ContractFactory(MockRouter.abi, MockRouter.bytecode, deployer).deploy();
  await router.waitForDeployment();

  const LP = build("StableLaunchpad");
  const CREATION_FEE = E(1);
  const TRADE_FEE_BPS = 100n; // 1%
  const GRAD_FEE = E(200);
  const V_USDT = E(4000);
  const V_TOKEN = E(1_073_000_000);
  const CURVE_SUPPLY = E(800_000_000);
  const LP_SUPPLY = E(200_000_000);

  const pad = await new ethers.ContractFactory(LP.abi, LP.bytecode, deployer).deploy(
    await router.getAddress(), await feeRcpt.getAddress(), CREATION_FEE, TRADE_FEE_BPS, GRAD_FEE, V_USDT, V_TOKEN
  );
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();
  const padAlice = pad.connect(alice);
  const padBob = pad.connect(bob);
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

  // ---- create token (no dev buy)
  const createRc = await (await padAlice.createToken("Doge on Stable", "SDOGE", "ipfs://meta1", 0, { value: CREATION_FEE })).wait();
  const tokenAddr = await pad.allTokens(0);
  const token = new ethers.Contract(tokenAddr, build("MemeToken").abi, provider);
  check((await pad.tokenCount()) === 1n, "token created & listed");
  check((await token.balanceOf(padAddr)) === E(1_000_000_000), "full supply held by launchpad");
  const createFeeDiff =
    (await provider.getBalance(feeRcpt.address, createRc.blockNumber)) -
    (await provider.getBalance(feeRcpt.address, createRc.blockNumber - 1));
  check(createFeeDiff === CREATION_FEE, "creation fee paid");

  // ---- create with dev buy
  await (await padBob.createToken("Pepe", "SPEPE", "ipfs://meta2", 1, { value: CREATION_FEE + E(100) })).wait();
  const token2 = new ethers.Contract(await pad.allTokens(1), build("MemeToken").abi, provider);
  check((await token2.balanceOf(bob.address)) > 0n, "dev buy delivered tokens");

  // ---- quote + buy
  const buyVal = E(500);
  const quoted = await pad.quoteBuy(tokenAddr, buyVal);
  const buyRc = await (await padAlice.buy(tokenAddr, quoted, deadline(), { value: buyVal })).wait();
  const aliceBal = await token.balanceOf(alice.address);
  check(aliceBal === quoted, "buy delivers quoted amount");
  // block-tagged balance diff isolates exactly this tx's fee transfer
  const feeDiff =
    (await provider.getBalance(feeRcpt.address, buyRc.blockNumber)) -
    (await provider.getBalance(feeRcpt.address, buyRc.blockNumber - 1));
  check(feeDiff === (buyVal * TRADE_FEE_BPS) / 10_000n, "1% buy fee paid");
  // expected curve math: out = vT*in/(vU+in)
  const inNet = buyVal - (buyVal * TRADE_FEE_BPS) / 10_000n;
  check(quoted === (V_TOKEN * inNet) / (V_USDT + inNet), "curve math matches constant product");

  const p1 = await pad.getPrice(tokenAddr);
  check(p1 > (V_USDT * E(1)) / V_TOKEN, "price increased after buy");

  // ---- slippage guard
  let reverted = false;
  try {
    await padAlice.buy(tokenAddr, quoted * 10n, deadline(), { value: E(1) });
  } catch { reverted = true; }
  check(reverted, "buy slippage guard reverts");

  // ---- sell
  const fullExit = await pad.quoteSell(tokenAddr, aliceBal);
  check(fullExit < buyVal, "roundtrip loses fees (no free money)");
  const sellAmt = aliceBal / 2n;
  const sellQuote = await pad.quoteSell(tokenAddr, sellAmt);
  await (await token.connect(alice).approve(padAddr, sellAmt)).wait();
  const rc = await (await padAlice.sell(tokenAddr, sellAmt, sellQuote, deadline())).wait();
  const gas = rc.gasUsed * rc.gasPrice;
  const sellDiff =
    (await provider.getBalance(alice.address, rc.blockNumber)) -
    (await provider.getBalance(alice.address, rc.blockNumber - 1));
  check(sellDiff + gas === sellQuote, "sell pays quoted USDT0");

  // ---- contract solvency: balance covers realUsdt
  const curve = await pad.curves(tokenAddr);
  check((await provider.getBalance(padAddr)) >= curve.realUsdt, "contract balance >= realUsdt");

  // ---- buy out the whole curve, check refund + auto graduation
  feeBefore = await provider.getBalance(feeRcpt.address);
  const bigVal = E(20000); // more than needed; expect refund
  const bobBefore = await provider.getBalance(bob.address);
  const rc2 = await (await padBob.buy(tokenAddr, 0, deadline(), { value: bigVal })).wait();
  const gas2 = rc2.gasUsed * rc2.gasPrice;
  const spent = bobBefore - (await provider.getBalance(bob.address)) - gas2;
  check(spent < bigVal, "final buy refunds excess value");

  const curveAfter = await pad.curves(tokenAddr);
  check(curveAfter.soldOut === true, "curve sold out");
  check(curveAfter.graduated === true, "auto-graduated");
  check(curveAfter.tokensSold === CURVE_SUPPLY, "exactly CURVE_SUPPLY sold");
  check((await token.balanceOf(await router.getAddress())) === LP_SUPPLY, "LP_SUPPLY sent to router");
  check((await router.lastTo()) === "0x000000000000000000000000000000000000dEaD", "LP tokens burned (dead address)");
  const lpUsdt = await router.lastEthAmount();
  // raised should be ~ k/(vT-sold) - vU = 4292e9/273e6 - 4000 ≈ 11721.6
  check(approxEq(lpUsdt + GRAD_FEE, E("11721.611721611721611722"), 5n), "raised USDT0 matches curve math");
  check((await pad.curves(tokenAddr)).realUsdt === 0n, "curve reserve zeroed after graduation");

  // ---- trading frozen after graduation
  reverted = false;
  try { await padAlice.buy(tokenAddr, 0, deadline(), { value: E(1) }); } catch { reverted = true; }
  check(reverted, "buys blocked after graduation");
  reverted = false;
  try { await padAlice.sell(tokenAddr, 1n, 0, deadline()); } catch { reverted = true; }
  check(reverted, "sells blocked after graduation");

  // ---- graduation failure + retry path (token2)
  await (await router.setShouldRevert(true)).wait();
  // buy out token2's curve
  await (await padAlice.buy(await pad.allTokens(1), 0, deadline(), { value: E(20000) })).wait();
  let c2 = await pad.curves(await pad.allTokens(1));
  check(c2.soldOut === true && c2.graduated === false, "graduation failure leaves curve sold-out, not graduated");
  await (await router.setShouldRevert(false)).wait();
  await (await padBob.graduate(await pad.allTokens(1))).wait();
  c2 = await pad.curves(await pad.allTokens(1));
  check(c2.graduated === true, "manual graduate() retry succeeds");

  // ---- admin guards
  reverted = false;
  try { await padAlice.setFees(0, 100, 0); } catch { reverted = true; }
  check(reverted, "setFees is onlyOwner");
  reverted = false;
  try { await pad.setFees(0, 600, 0); } catch { reverted = true; }
  check(reverted, "trade fee capped at 5%");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
