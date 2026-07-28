// Integration tests for ArcLaunchpad against REAL Uniswap V3 contracts in an
// in-process ganache EVM, with a MockUSDT0 standing in for Arc's dual-decimal
// USDC (18-dec native mirror, 6-dec ERC-20). Same arrangement as USDT0 on
// Stable, so the mock is reused unchanged.
//
//   node scripts/compile.js && node scripts/test-arc-launchpad.js
//
// What this suite is really guarding: the 5% dev buy cap must bind on tokens
// received, and the 70/24/6 fee split must sum to exactly what was collected.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);
const NATIVE_PER_USDC = 10n ** 12n; // 18-dec native -> 6-dec ERC-20

let passed = 0, failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
// Explicit gasLimit skips estimateGas, so a reverting tx MINES as failed
// instead of throwing. Inspect the receipt, do not just catch.
async function reverts(fn, name) {
  try {
    const tx = await fn();
    const r = await tx.wait();
    check(r.status === 0, name, "expected revert, transaction succeeded");
  } catch { check(true, name); }
}

const NPM_EXTRA_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256, uint256, uint128 tokensOwed0, uint128 tokensOwed1)",
];
const ROUTER02_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

const CREATION_FEE = E(1);
const CREATOR_BPS = 8000n;   // 80% creator
const BUYBACK_BPS = 8000n;   // of the protocol 20%: 80% buyback, 20% ops
const START_PRICE = 3_000_000_000_000n; // 0.000003 USDC/token -> $3,000 start mcap
const MAX_DEV_TOKENS = E(50_000_000);   // 5% of 1B

async function main() {
  const provider = new ethers.BrowserProvider(
    ganache.provider({
      logging: { quiet: true },
      wallet: { defaultBalance: 1000000 },
      miner: { blockGasLimit: "0x1C9C380" },
    })
  );
  const [deployer, buyback, ops, alice, bob] =
    await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  // ---- USDC emulation + real Uniswap V3 stack
  const usdtArt = build("MockUSDT0");
  const usdc = await new ethers.ContractFactory(usdtArt.abi, usdtArt.bytecode, deployer).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();

  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();

  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    await factory.getAddress(), usdcAddr, deployer.address
  );
  await npm.waitForDeployment();

  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, await factory.getAddress(), await npm.getAddress(), usdcAddr
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // ---- launchpad
  const padArt = build("ArcLaunchpad");
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    await npm.getAddress(), routerAddr, usdcAddr,
    buyback.address, ops.address,
    CREATION_FEE, CREATOR_BPS, BUYBACK_BPS, START_PRICE,
    ethers.ZeroAddress, 0 // MINTR launches disabled in this suite
  );
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();

  const npmX = new ethers.Contract(await npm.getAddress(), NPM_EXTRA_ABI, provider);
  const erc20 = (a, s) => new ethers.Contract(a, build("MemeToken20").abi, s || provider);
  const routerX = (s) => new ethers.Contract(routerAddr, ROUTER02_ABI, s);

  console.log("\n=== config ===");
  check((await pad.creatorShareBps()) === 8000n, "creatorShareBps is 8000 (80/20)");
  check((await pad.buybackShareBps()) === 8000n, "buybackShareBps is 8000 (80/20 of the protocol 20%)");
  check((await pad.MAX_DEV_BUY_BPS()) === 500n, "MAX_DEV_BUY_BPS is 500 (5%)");
  check((await pad.MAX_DEV_BUY_TOKENS()) === MAX_DEV_TOKENS, "MAX_DEV_BUY_TOKENS is 50,000,000");
  check((await pad.buybackRecipient()) === buyback.address, "buybackRecipient set");
  check((await pad.opsRecipient()) === ops.address, "opsRecipient set");

  // helper: launch and return the token address
  async function launch(signer, sym, devUsdc, minOut = 0n) {
    const value = CREATION_FEE + devUsdc * NATIVE_PER_USDC;
    const tx = await pad.connect(signer).launch(sym, sym, "ipfs://x", minOut, { value, gasLimit: 12_000_000 });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } })
                      .find((x) => x && x.name === "TokenLaunched");
    return { token: ev.args.token, positionId: ev.args.positionId, rc };
  }

  console.log("\n=== launch without a dev buy ===");
  const a = await launch(alice, "NOBUY", 0n);
  check((await erc20(a.token).balanceOf(alice.address)) === 0n, "creator holds nothing when dev buy is zero");
  check((await npmX.ownerOf(a.positionId)) === padAddr, "position NFT is owned by the launchpad");
  const pos = await npmX.positions(a.positionId);
  check(pos.liquidity > 0n, "position has liquidity");
  check((await pad.launchLiquidity(a.token)) === pos.liquidity, "launchLiquidity matches the NPM position");

  console.log("\n=== the 5% cap, priced in USDC ===");
  const cap = await pad.maxDevBuyQuote(a.token);
  console.log(`      maxDevBuyQuote = ${ethers.formatUnits(cap, 6)} USDC`);
  check(cap > U(150) && cap < U(170), "cap lands near the predicted 159.47 USDC", `got ${ethers.formatUnits(cap, 6)}`);

  // Spend exactly the advertised cap: must succeed and land at, but not over, 5%.
  const b = await launch(bob, "ATCAP", cap / 1n);
  const bBal = await erc20(b.token).balanceOf(bob.address);
  console.log(`      spending the cap bought ${ethers.formatEther(bBal)} tokens`);
  check(bBal <= MAX_DEV_TOKENS, "spending exactly the cap stays within 5%");
  check(bBal > (MAX_DEV_TOKENS * 99n) / 100n, "spending exactly the cap gets within 1% of 5%",
    `got ${ethers.formatEther(bBal)}`);

  // Just under: fine. Well over: must revert.
  const c = await launch(alice, "UNDER", U(50));
  const cBal = await erc20(c.token).balanceOf(alice.address);
  check(cBal < MAX_DEV_TOKENS, "a small dev buy is well under the cap");

  await reverts(
    () => pad.connect(bob).launch("OVER", "OVER", "ipfs://x", 0n,
      { value: CREATION_FEE + U(400) * NATIVE_PER_USDC, gasLimit: 12_000_000 }),
    "a dev buy far above the cap reverts"
  );
  await reverts(
    () => pad.connect(bob).launch("OVER2", "OVER2", "ipfs://x", 0n,
      { value: CREATION_FEE + (cap + U(20)) * NATIVE_PER_USDC, gasLimit: 12_000_000 }),
    "a dev buy modestly above the cap reverts"
  );

  console.log("\n=== both pool orientations ===");
  // Token addresses come from CREATE, so orientation is not directly
  // controllable. Launch until both have been observed rather than assuming.
  const seen = { true: 0, false: 0 };
  for (let i = 0; i < 14 && (seen.true === 0 || seen.false === 0); i++) {
    const r = await launch(alice, `ORI${i}`, 0n);
    const tokenIs0 = BigInt(r.token) < BigInt(usdcAddr);
    seen[String(tokenIs0)]++;
    const q = await pad.maxDevBuyQuote(r.token);
    if (!(q > U(140) && q < U(190))) {
      check(false, `orientation token0=${tokenIs0}: cap in range`, `got ${ethers.formatUnits(q, 6)} USDC`);
    }
  }
  check(seen.true > 0 && seen.false > 0, "both pool orientations were exercised",
    `token0 seen ${seen.true}x, token1 seen ${seen.false}x`);

  // Prove the cap actually binds in whichever orientation, by overspending.
  await reverts(
    () => pad.connect(alice).launch("ORIX", "ORIX", "ipfs://x", 0n,
      { value: CREATION_FEE + U(500) * NATIVE_PER_USDC, gasLimit: 12_000_000 }),
    "cap binds regardless of orientation"
  );

  console.log("\n=== fee split: 80 creator / 16 buyback / 4 ops, of every pool fee ===");
  // Generate fees by trading against a fresh pool.
  const f = await launch(alice, "FEES", 0n);
  await (await usdc.connect(bob).approve(routerAddr, U(5000))).wait();
  for (let i = 0; i < 4; i++) {
    await (await routerX(bob).exactInputSingle({
      tokenIn: usdcAddr, tokenOut: f.token, fee: 10000, recipient: bob.address,
      amountIn: U(200), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    }, { gasLimit: 3_000_000 })).wait();
  }
  const tk = erc20(f.token, bob);
  await (await tk.approve(routerAddr, ethers.MaxUint256)).wait();
  await (await routerX(bob).exactInputSingle({
    tokenIn: f.token, tokenOut: usdcAddr, fee: 10000, recipient: bob.address,
    amountIn: await tk.balanceOf(bob.address), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
  }, { gasLimit: 3_000_000 })).wait();

  const before = {
    cq: await usdc.balanceOf(alice.address), bq: await usdc.balanceOf(buyback.address),
    oq: await usdc.balanceOf(ops.address),
    ct: await erc20(f.token).balanceOf(alice.address),
    bt: await erc20(f.token).balanceOf(buyback.address),
    ot: await erc20(f.token).balanceOf(ops.address),
  };
  await (await pad.claimFees(f.token, { gasLimit: 3_000_000 })).wait();
  const dcq = (await usdc.balanceOf(alice.address)) - before.cq;
  const dbq = (await usdc.balanceOf(buyback.address)) - before.bq;
  const doq = (await usdc.balanceOf(ops.address)) - before.oq;
  const dct = (await erc20(f.token).balanceOf(alice.address)) - before.ct;
  const dbt = (await erc20(f.token).balanceOf(buyback.address)) - before.bt;
  const dot = (await erc20(f.token).balanceOf(ops.address)) - before.ot;

  const totQ = dcq + dbq + doq, totT = dct + dbt + dot;
  console.log(`      quote fees: creator ${ethers.formatUnits(dcq,6)}  buyback ${ethers.formatUnits(dbq,6)}  ops ${ethers.formatUnits(doq,6)}`);
  check(totQ > 0n, "the pool actually accrued quote fees");
  check(totT > 0n, "the pool actually accrued token fees");

  // Exactness matters more than the ratio: nothing may be created or lost.
  const expCq = (totQ * CREATOR_BPS) / 10000n;
  const expBq = ((totQ - expCq) * BUYBACK_BPS) / 10000n;
  check(dcq === expCq, "creator gets exactly 80% of quote fees", `${dcq} vs ${expCq}`);
  check(dbq === expBq, "buyback gets exactly 80% of the protocol remainder", `${dbq} vs ${expBq}`);
  check(doq === totQ - expCq - expBq, "ops gets exactly the residual, no dust lost");
  const expCt = (totT * CREATOR_BPS) / 10000n;
  const expBt = ((totT - expCt) * BUYBACK_BPS) / 10000n;
  check(dct === expCt, "creator gets exactly 80% of token fees");
  check(dbt === expBt, "buyback gets exactly 80% of protocol token fees");
  check(dot === totT - expCt - expBt, "ops token residual is exact");

  console.log("\n=== immutability of liquidity ===");
  const fnNames = padArt.abi.filter((x) => x.type === "function").map((x) => x.name);
  const dangerous = fnNames.filter((n) =>
    /withdraw|decreaseLiquidity|burn|transferFrom|safeTransfer|rescue|sweep|emergency/i.test(n));
  check(dangerous.length === 0, "no function can remove liquidity or move the NFT",
    dangerous.length ? "found: " + dangerous.join(", ") : "");
  check((await npmX.ownerOf(f.positionId)) === padAddr, "NFT still owned by the launchpad after fee claims");

  console.log("\n=== admin bounds ===");
  await reverts(() => pad.connect(deployer).setConfig(0, 4000n, 8000n, START_PRICE, { gasLimit: 500000 }),
    "creator share below the 50% floor is rejected");
  await reverts(() => pad.connect(deployer).setConfig(0, 7000n, 12000n, START_PRICE, { gasLimit: 500000 }),
    "buyback share above 100% is rejected");
  await reverts(() => pad.connect(alice).setFeeRecipients(alice.address, alice.address, { gasLimit: 500000 }),
    "non-owner cannot move the fee recipients");
  await reverts(() => pad.connect(deployer).setFeeRecipients(ethers.ZeroAddress, ops.address, { gasLimit: 500000 }),
    "zero fee recipient is rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
