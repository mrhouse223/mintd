// Integration tests for MintdLaunchpad, the replacement for the immutable and
// front-runnable InstantLaunchpad on Stable.
//
//   node scripts/compile.js && node scripts/test-mintd-launchpad.js
//
// Runs the whole suite TWICE: once configured as Stable will be deployed
// (90/10, one treasury, dev cap disabled) and once with a 5% cap, because the
// cap is a constructor parameter and both settings ship from this source.
//
// The load-bearing test is the front-run: the exact attack that takes 100% of
// supply from the deployed Stable launchpad must revert here.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);
const NATIVE_PER_QUOTE = 10n ** 12n;

let passed = 0, failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
// Explicit gasLimit skips estimateGas, so a reverting tx MINES as failed
// instead of throwing. Inspect the receipt.
async function reverts(fn, name) {
  try { const r = await (await fn()).wait(); check(r.status === 0, name, "expected revert, tx succeeded"); }
  catch { check(true, name); }
}

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
const START_PRICE = 3_000_000_000_000n;

function sqrtRatioX96(num, den) {
  const x = (num << 96n) / den;
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n, y = x;
  while (z < y) { y = z; z = (x / z + z) / 2n; }
  return y << 48n;
}

async function suite({ label, creatorBps, buybackBps, devCapBps, sameTreasury }) {
  console.log(`\n############ ${label} ############`);
  const g = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000000 },
    miner: { blockGasLimit: "0x1C9C380" } });
  const provider = new ethers.BrowserProvider(g);
  const nativeBal = async (a) => BigInt(await g.request({ method: "eth_getBalance", params: [a, "latest"] }));
  const [deployer, treasury, ops, alice, bob, mallory] =
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));

  const qArt = build("MockUSDT0");
  const quote = await new ethers.ContractFactory(qArt.abi, qArt.bytecode, deployer).deploy();
  await quote.waitForDeployment();
  const quoteAddr = await quote.getAddress();

  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();
  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    await factory.getAddress(), quoteAddr, deployer.address);
  await npm.waitForDeployment();
  const npmAddr = await npm.getAddress();
  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, await factory.getAddress(), npmAddr, quoteAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const bbRecipient = sameTreasury ? treasury.address : treasury.address;
  const opsRecipient = sameTreasury ? treasury.address : ops.address;

  const padArt = build("MintdLaunchpad");
  // Owner is now the first constructor arg. Deploy with `deployer` as owner so
  // the existing admin tests, which act as `deployer`, keep working.
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    deployer.address, npmAddr, routerAddr, quoteAddr, bbRecipient, opsRecipient,
    E(1), creatorBps, buybackBps, devCapBps, START_PRICE, ethers.ZeroAddress, 0);
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();

  const erc20 = (a, s) => new ethers.Contract(a, build("MemeToken20").abi, s || provider);
  const npmX = new ethers.Contract(npmAddr, NPM_ABI, provider);

  console.log("\n=== config reads back ===");
  check((await pad.owner()) === deployer.address, "owner is the constructor arg, not necessarily msg.sender");
  check((await pad.creatorShareBps()) === creatorBps, `creatorShareBps is ${creatorBps}`);
  check((await pad.devBuyCapBps()) === devCapBps, `devBuyCapBps is ${devCapBps}`);
  check((await pad.usdt0()) === quoteAddr, "usdt0() alias returns the quote asset");
  check((await pad.quoteToken()) === quoteAddr, "quoteToken() returns the quote asset");
  check((await pad.startPriceUsdt1e18()) === START_PRICE, "startPriceUsdt1e18() alias works");
  check((await pad.nativeToErc20()) === NATIVE_PER_QUOTE, "decimal gap derived as 1e12 from a 6-dec quote");

  async function launch(signer, sym, devQuote = 0n, minOut = 0n) {
    const value = E(1) + devQuote * NATIVE_PER_QUOTE;
    const rc = await (await pad.connect(signer).launch(sym, sym, "ipfs://x", minOut,
      { value, gasLimit: 12_000_000 })).wait();
    const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } })
                      .find((x) => x && x.name === "TokenLaunched");
    return { token: ev.args.token, positionId: ev.args.positionId };
  }

  console.log("\n=== a plain launch ===");
  const a = await launch(alice, "PLAIN");
  check((await npmX.ownerOf(a.positionId)) === padAddr, "position NFT owned by the launchpad");
  check((await pad.launchLiquidity(a.token)) > 0n, "liquidity recorded");
  const dangerous = padArt.abi.filter((x) => x.type === "function").map((x) => x.name)
    .filter((n) => /withdraw|decreaseLiquidity|rescue|sweep|emergency/i.test(n));
  check(dangerous.length === 0, "no function can remove liquidity", dangerous.join(", "));

  console.log("\n=== THE FIX: launch-price front-running ===");
  // Mallory predicts the token address and pre-creates its pool at a price a
  // billion times lower, exactly as the attack on the deployed Stable pad.
  const SALT = ethers.id("attack");
  const predicted = await pad.predictToken(bob.address, SALT, "VICTIM", "VICTIM", "ipfs://x");
  const tokenIs0 = BigInt(predicted) < BigInt(quoteAddr);
  const [t0, t1] = tokenIs0 ? [predicted, quoteAddr] : [quoteAddr, predicted];
  const EVIL = START_PRICE / 1_000_000_000n;
  const evilSqrt = tokenIs0 ? sqrtRatioX96(EVIL, 10n ** 30n) : sqrtRatioX96(10n ** 30n, EVIL);
  await (await new ethers.Contract(npmAddr, NPM_ABI, mallory)
    .createAndInitializePoolIfNecessary(t0, t1, 10000, evilSqrt, { gasLimit: 8_000_000 })).wait();
  console.log(`      mallory pre-initialized the pool for ${predicted}`);

  await reverts(
    () => pad.connect(bob).launchWithSalt("VICTIM", "VICTIM", "ipfs://x", 0n, SALT,
      { value: E(1), gasLimit: 12_000_000 }),
    "launching into a pre-initialized pool REVERTS");

  // And the fix must not be a brick: another salt has to work.
  const escaped = await (await pad.connect(bob).launchWithSalt("VICTIM", "VICTIM", "ipfs://x", 0n,
    ethers.id("clean-salt"), { value: E(1), gasLimit: 12_000_000 })).wait();
  check(escaped.status === 1, "a different salt steps over the poisoned address");
  const plainAfter = await launch(bob, "AFTER");
  check(!!plainAfter.token, "the default launch path still works after an attempt");

  // NOTE ON THE AUTO-SALT: it mixes in blockhash(block.number-1), because
  // prevrandao is zero on both Stable and Arc (verified directly against both
  // RPCs) and gave the salt no entropy, which reintroduced the permanent-brick
  // vector on the default path. The property that fixes it, that the parent
  // hash differs every block so a retry lands on a new address, cannot be
  // exercised here: ganache returns an identical block hash and a zero parent
  // hash across mines, so this harness cannot model per-block entropy at all.
  // It is verified on the real chains, not in this file. The escape hatch is
  // covered above ("a different salt steps over the poisoned address").

  console.log("\n=== dev buy cap ===");
  if (devCapBps === 10000n) {
    check((await pad.previewDevBuyCap(await pad.launchLiquidity(a.token), true)) === 0n,
      "cap disabled: previewDevBuyCap returns 0");
    const big = await launch(alice, "BIGBUY", U(2000));
    const got = await erc20(big.token).balanceOf(alice.address);
    check(got > E(50_000_000), "cap disabled: a large dev buy is allowed",
      `got ${ethers.formatEther(got)}`);
  } else {
    const cap = await pad.maxDevBuyQuote(a.token);
    console.log(`      maxDevBuyQuote = ${ethers.formatUnits(cap, 6)}`);
    check(cap > U(150) && cap < U(170), "cap lands near the predicted 159.47",
      `got ${ethers.formatUnits(cap, 6)}`);
    const atCap = await launch(bob, "ATCAP", cap);
    const gotAt = await erc20(atCap.token).balanceOf(bob.address);
    check(gotAt <= (SUPPLY_BPS(devCapBps)), "spending the cap stays within the cap");
    await reverts(() => pad.connect(bob).launch("OVER", "OVER", "ipfs://x", 0n,
      { value: E(1) + U(400) * NATIVE_PER_QUOTE, gasLimit: 12_000_000 }),
      "a dev buy far over the cap reverts");
  }

  console.log("\n=== fee split ===");
  const f = await launch(alice, "FEES");
  await (await quote.connect(bob).approve(routerAddr, U(50000))).wait();
  const rx = new ethers.Contract(routerAddr, ROUTER_ABI, bob);
  for (let i = 0; i < 4; i++) {
    await (await rx.exactInputSingle({ tokenIn: quoteAddr, tokenOut: f.token, fee: 10000,
      recipient: bob.address, amountIn: U(250), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
      { gasLimit: 3_000_000 })).wait();
  }
  const before = {
    c: await quote.balanceOf(alice.address),
    t: await quote.balanceOf(treasury.address),
    o: await quote.balanceOf(ops.address),
  };
  await (await pad.claimFees(f.token, { gasLimit: 3_000_000 })).wait();
  const dc = (await quote.balanceOf(alice.address)) - before.c;
  const dt = (await quote.balanceOf(treasury.address)) - before.t;
  const doo = (await quote.balanceOf(ops.address)) - before.o;
  const total = dc + dt + doo;
  console.log(`      creator ${ethers.formatUnits(dc, 6)}  treasury ${ethers.formatUnits(dt, 6)}  ops ${ethers.formatUnits(doo, 6)}`);
  check(total > 0n, "fees actually accrued");
  check(dc === (total * creatorBps) / 10000n, `creator gets exactly ${Number(creatorBps) / 100}%`,
    `${dc} vs ${(total * creatorBps) / 10000n}`);
  check(dc + dt + doo === total, "the payouts sum to exactly what was collected");
  if (sameTreasury) {
    check(doo === 0n, "with one treasury, nothing leaks to a second address");
    check(dt === total - dc, "the treasury receives the whole protocol share");
  }

  console.log("\n=== admin bounds ===");
  await reverts(() => pad.connect(deployer).setConfig(0, 4000n, buybackBps, START_PRICE, { gasLimit: 500000 }),
    "creator share below the 50% floor is rejected");
  await reverts(() => pad.connect(alice).setFeeRecipients(alice.address, alice.address, { gasLimit: 500000 }),
    "non-owner cannot move fee recipients");
  await (await pad.connect(deployer).transferOwnership(treasury.address)).wait();
  check((await pad.owner()) === treasury.address, "ownership transfers");
  await reverts(() => pad.connect(deployer).setConfig(0, creatorBps, buybackBps, START_PRICE, { gasLimit: 500000 }),
    "the old owner loses control after transfer");
}
const SUPPLY_BPS = (bps) => (1000000000n * 10n ** 18n * bps) / 10000n;

async function main() {
  await suite({ label: "as Stable will deploy: 90/10, one treasury, no dev cap",
    creatorBps: 9000n, buybackBps: 0n, devCapBps: 10000n, sameTreasury: true });
  await suite({ label: "with a 5% dev cap and a split treasury",
    creatorBps: 8000n, buybackBps: 8000n, devCapBps: 500n, sameTreasury: false });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
