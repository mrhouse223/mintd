// Integration tests for InstantLaunchpad against REAL Uniswap V3 contracts
// (v3-core factory, NonfungiblePositionManager, SwapRouter02) deployed into
// an in-process ganache EVM, paired with a MockUSDT0 that emulates Stable's
// dual native/ERC-20 USDT0 (18-dec native mirror, 6-dec ERC-20).
//   node scripts/compile.js && node scripts/test-instant.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));      // 18-dec native amounts
const U = (v) => ethers.parseUnits(String(v), 6);   // 6-dec USDT0 ERC-20 amounts

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

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
];
const ROUTER02_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
const NPM_EXTRA_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128 tokensOwed0, uint128 tokensOwed1)",
];

async function main() {
  const provider = new ethers.BrowserProvider(
    ganache.provider({
      logging: { quiet: true },
      wallet: { defaultBalance: 1000000 },
      miner: { blockGasLimit: "0x1C9C380" }, // 30M
    })
  );
  const [deployer, feeRcpt, alice, bob] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));

  // ---- deploy dual-interface USDT0 emulation + real Uniswap V3 stack
  const usdtArt = build("MockUSDT0");
  const usdt = await new ethers.ContractFactory(usdtArt.abi, usdtArt.bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();

  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();

  const npmArt = uni(
    "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"
  );
  // WETH9 slot points at USDT0 here; on Stable mainnet it points at a revert
  // stub. Neither matters: no native-wrapping path is ever used.
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    await factory.getAddress(), usdtAddr, deployer.address
  );
  await npm.waitForDeployment();

  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, await factory.getAddress(), await npm.getAddress(), usdtAddr
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // ---- deploy launchpad
  const padArt = build("InstantLaunchpad");
  const CREATION_FEE = E(1);
  const CREATOR_BPS = 9000n; // mintd.fun: creators keep 90%
  const START_PRICE = 3_000_000_000_000n; // 3e12 = 0.000003 USDT0/token -> 3,000 USDT0 mcap
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    await npm.getAddress(), routerAddr, usdtAddr, feeRcpt.address, CREATION_FEE, CREATOR_BPS, START_PRICE,
    ethers.ZeroAddress, 0 // MINTR launches disabled in this suite
  );
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();

  const npmX = new ethers.Contract(await npm.getAddress(), NPM_EXTRA_ABI, provider);
  const routerX = (s) => new ethers.Contract(routerAddr, ROUTER02_ABI, s);
  const erc20 = (a, s) => new ethers.Contract(a, build("MemeToken20").abi, s || provider);

  // NOTE: explicit gasLimit on all heavy txs — ganache's gas estimator
  // unreliably lowballs multi-contract transactions.
  const GL = { gasLimit: 9_000_000 };
  const GS = { gasLimit: 1_000_000 };

  // ---- launch (no dev buy)
  const rcL = await (await pad.connect(alice).launch("Tether Lion", "LION", '{"image":"x"}', 0, { value: CREATION_FEE, ...GL })).wait();
  const tok1 = await pad.allTokens(0);
  const l1 = await pad.launches(tok1);
  check((await pad.tokenCount()) === 1n, "launch stored");
  check(l1.creator === alice.address, "creator recorded");
  check(l1.pool !== ethers.ZeroAddress, "pool created");
  check((await npmX.ownerOf(l1.positionId)) === padAddr, "position NFT owned by launchpad (locked)");
  const dust = await erc20(tok1).balanceOf(padAddr);
  check(dust < E(1), "≈ full 1B supply in the pool (only rounding dust held)");
  const feeDiff =
    (await provider.getBalance(feeRcpt.address, rcL.blockNumber)) -
    (await provider.getBalance(feeRcpt.address, rcL.blockNumber - 1));
  check(feeDiff === CREATION_FEE, "creation fee paid to platform");

  // ---- initial price ≈ configured start price (18/6 decimal gap accounted)
  const pool1 = new ethers.Contract(l1.pool, POOL_ABI, provider);
  const [sqrtP] = await pool1.slot0();
  const tokenIs0 = BigInt(tok1) < BigInt(usdtAddr);
  const Q192 = 2n ** 192n;
  // 1e18-scaled USDT0/token from sqrtPriceX96, at full precision
  const priceUsdt = tokenIs0
    ? (sqrtP * sqrtP * 10n ** 30n) / Q192
    : (10n ** 30n * Q192) / (sqrtP * sqrtP);
  const diffP = priceUsdt > START_PRICE ? priceUsdt - START_PRICE : START_PRICE - priceUsdt;
  check(diffP * 1000n <= START_PRICE, "pool initialized at ≈ start price (0.1% tol)");

  // ---- buy through SwapRouter02 using the USDT0 ERC-20 interface (6 dec)
  const buyIn = U(100); // 100 USDT0
  await (await usdt.connect(bob).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  await (await routerX(bob).exactInputSingle(
    { tokenIn: usdtAddr, tokenOut: tok1, fee: 10000, recipient: bob.address, amountIn: buyIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
    GS
  )).wait();
  const bobBal = await erc20(tok1).balanceOf(bob.address);
  // 100 USDT0 at ~0.000003 → ~33.3M tokens (minus 1% fee, tick-gap premium)
  check(bobBal > E(25_000_000) && bobBal < E(34_000_000), `buy works via Uniswap (got ${ethers.formatEther(bobBal)} tokens)`);

  // ---- price moved up after buy
  const [sqrtP2] = await pool1.slot0();
  check(tokenIs0 ? sqrtP2 > sqrtP : sqrtP2 < sqrtP, "price increased after buy");

  // ---- sell through SwapRouter02: token -> USDT0 straight to the seller
  const sellAmt = bobBal / 2n;
  await (await erc20(tok1, bob).approve(routerAddr, sellAmt, GS)).wait();
  const bobUsdtBefore = await usdt.balanceOf(bob.address);
  await (await routerX(bob).exactInputSingle(
    { tokenIn: tok1, tokenOut: usdtAddr, fee: 10000, recipient: bob.address, amountIn: sellAmt, amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
    GS
  )).wait();
  const sellGain = (await usdt.balanceOf(bob.address)) - bobUsdtBefore;
  check(sellGain > U(30), `sell returns USDT0 (got ${ethers.formatUnits(sellGain, 6)})`);

  // ---- fee claim: 90% creator / 10% platform, paid via USDT0 ERC-20
  const aliceU0 = await usdt.balanceOf(alice.address);
  const platU0 = await usdt.balanceOf(feeRcpt.address);
  await (await pad.connect(bob).claimFees(tok1, GS)).wait(); // anyone can trigger
  const aliceGain = (await usdt.balanceOf(alice.address)) - aliceU0;
  const platGain = (await usdt.balanceOf(feeRcpt.address)) - platU0;
  check(aliceGain > 0n, `creator received USDT0 fees (${ethers.formatUnits(aliceGain, 6)})`);
  // creator/platform = 90/10 → aliceGain ≈ 9x platGain (rounding tolerance)
  const nine = platGain * 9n;
  const dd = aliceGain > nine ? aliceGain - nine : nine - aliceGain;
  check(dd <= 9n, "fees split exactly 90/10");
  const tokenFeesCreator = await erc20(tok1).balanceOf(alice.address);
  const tokenFeesPlat = await erc20(tok1).balanceOf(feeRcpt.address);
  check(tokenFeesCreator > 0n && tokenFeesPlat > 0n, "token-side fees also split");
  const l1after = await pad.launches(tok1);
  check(l1after.creatorFeesClaimedQuote === aliceGain, "cumulative creator fees tracked");

  // ---- liquidity still locked after claims
  const posAfter = await npmX.positions(l1.positionId);
  check(posAfter.liquidity > 0n, "liquidity untouched by fee claim");
  check((await npmX.ownerOf(l1.positionId)) === padAddr, "position still owned by launchpad");

  // ---- launch with dev buy (native value in, ERC-20 swap out)
  await (await pad.connect(bob).launch("Peg", "PEG", "", 1, { value: CREATION_FEE + E(50), ...GL })).wait();
  const tok2 = await pad.allTokens(1);
  check((await erc20(tok2).balanceOf(bob.address)) > 0n, "dev buy delivers tokens in launch tx");

  // ---- both token orderings work (token < or > USDT0 address)
  await (await usdt.connect(alice).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  let seen0 = tokenIs0, seen1 = !tokenIs0;
  for (let i = 2; (!seen0 || !seen1) && i < 12; i++) {
    await (await pad.connect(alice).launch(`T${i}`, `T${i}`, "", 0, { value: CREATION_FEE, ...GL })).wait();
    const t = await pad.allTokens(i);
    const is0 = BigInt(t) < BigInt(usdtAddr);
    // verify tradeable in both orderings
    await (await routerX(alice).exactInputSingle(
      { tokenIn: usdtAddr, tokenOut: t, fee: 10000, recipient: alice.address, amountIn: U(5), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
      GS
    )).wait();
    if (is0) seen0 = true;
    else seen1 = true;
  }
  check(seen0 && seen1, "both token orderings launch and trade correctly");

  // ---- admin guards
  let reverted = false;
  try { await pad.connect(alice).setConfig(0, 9000, START_PRICE); } catch { reverted = true; }
  check(reverted, "setConfig is onlyOwner");
  reverted = false;
  try { await pad.connect(deployer).setConfig(0, 4000, START_PRICE); } catch { reverted = true; }
  check(reverted, "creator share cannot go below 50%");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
