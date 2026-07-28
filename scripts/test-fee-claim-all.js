// Tests for FeeClaimAll, the batch fee-claim trigger.
//
//   node scripts/compile.js && node scripts/test-fee-claim-all.js
//
// The property that matters: this contract can only move other people's fees
// to the destinations the launchpad already hardcodes. It must never end up
// holding anything, and one bad token must not strand a batch.
//
// Deliberately tested against InstantLaunchpad (the repo source, 8-field
// launches()) even though it targets Stable's deployed bytecode (7 fields).
// _creatorOf decodes only the two leading words, so passing here is evidence
// the shape-agnostic decode works.
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

const ROUTER02_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

async function main() {
  const provider = new ethers.BrowserProvider(
    ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000000 },
      miner: { blockGasLimit: "0x1C9C380" } })
  );
  const [deployer, feeRcpt, alice, bob, carol] =
    await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const usdtArt = build("MockUSDT0");
  const usdt = await new ethers.ContractFactory(usdtArt.abi, usdtArt.bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();

  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();

  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npm = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    await factory.getAddress(), usdtAddr, deployer.address);
  await npm.waitForDeployment();

  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, await factory.getAddress(), await npm.getAddress(), usdtAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const padArt = build("InstantLaunchpad");
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    await npm.getAddress(), routerAddr, usdtAddr, feeRcpt.address, E(1), 9000n, 3_000_000_000_000n,
    ethers.ZeroAddress, 0);
  await pad.waitForDeployment();
  const padAddr = await pad.getAddress();

  const claimArt = build("FeeClaimAll");
  const claimer = await new ethers.ContractFactory(claimArt.abi, claimArt.bytecode, deployer).deploy();
  await claimer.waitForDeployment();
  const claimerAddr = await claimer.getAddress();

  const erc20 = (a, s) => new ethers.Contract(a, build("MemeToken20").abi, s || provider);
  const routerX = (s) => new ethers.Contract(routerAddr, ROUTER02_ABI, s);

  // ---- launch three tokens from two different creators
  const creators = [alice, alice, bob];
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const tx = await pad.connect(creators[i]).launch(`T${i}`, `T${i}`, "ipfs://x", 0n,
      { value: E(1), gasLimit: 12_000_000 });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } })
                      .find((x) => x && x.name === "TokenLaunched");
    tokens.push(ev.args.token);
  }
  console.log("\n=== setup ===");
  check(tokens.length === 3, "three tokens launched by two creators");

  // ---- generate fees on the first two only, leaving the third with none
  await (await usdt.connect(carol).approve(routerAddr, U(100000))).wait();
  for (const t of tokens.slice(0, 2)) {
    for (let i = 0; i < 3; i++) {
      await (await routerX(carol).exactInputSingle({
        tokenIn: usdtAddr, tokenOut: t, fee: 10000, recipient: carol.address,
        amountIn: U(300), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      }, { gasLimit: 3_000_000 })).wait();
    }
  }

  console.log("\n=== preview reads pending fees without committing ===");
  const supplyBefore = await usdt.balanceOf(feeRcpt.address);
  const pv = await claimer.previewRange.staticCall(padAddr, 0, 10, usdtAddr);
  check(pv.length === 3, "preview returns a row per launched token");
  const withFees = pv.filter((r) => r.creatorQuote > 0n || r.protocolQuote > 0n);
  check(withFees.length === 2, "exactly the two traded tokens show pending fees",
    `got ${withFees.length}`);
  check(pv[2].creatorQuote === 0n, "the untraded token shows zero pending");
  check((await usdt.balanceOf(feeRcpt.address)) === supplyBefore,
    "staticCall preview did NOT actually move funds");
  check(pv[0].creator === alice.address && pv[2].creator === bob.address,
    "creator decoded correctly despite the 8-field launches() shape");
  check(pv.every((r) => r.ok), "every preview row reports ok");

  console.log("\n=== claim actually pays out, to the right places ===");
  const beforeC = await usdt.balanceOf(alice.address);
  const beforeP = await usdt.balanceOf(feeRcpt.address);
  const expC = pv[0].creatorQuote + pv[1].creatorQuote;
  const expP = pv[0].protocolQuote + pv[1].protocolQuote;

  const tx = await claimer.connect(carol).claimRange(padAddr, 0, 10, { gasLimit: 25_000_000 });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return claimer.interface.parseLog(l); } catch { return null; } })
                    .find((x) => x && x.name === "BatchClaimed");
  check(ev && ev.args.claimed === 3n, "all three claims succeeded", ev ? `claimed=${ev.args.claimed}` : "no event");
  check(ev && ev.args.failed === 0n, "no claim failed");

  const gotC = (await usdt.balanceOf(alice.address)) - beforeC;
  const gotP = (await usdt.balanceOf(feeRcpt.address)) - beforeP;
  check(gotC === expC, "creator received exactly what preview predicted", `${gotC} vs ${expC}`);
  check(gotP === expP, "feeRecipient received exactly what preview predicted", `${gotP} vs ${expP}`);
  check(gotC > 0n && gotP > 0n, "the amounts were non-trivial");

  console.log("\n=== the claimer keeps nothing ===");
  check((await usdt.balanceOf(claimerAddr)) === 0n, "FeeClaimAll holds no quote asset");
  for (const t of tokens) {
    if ((await erc20(t).balanceOf(claimerAddr)) !== 0n) {
      check(false, "FeeClaimAll holds no launched token", `holds ${t}`);
    }
  }
  check(true, "FeeClaimAll holds none of the launched tokens");
  check((await provider.getBalance(claimerAddr)) === 0n, "FeeClaimAll holds no native balance");

  const fns = claimArt.abi.filter((x) => x.type === "function").map((x) => x.name);
  const danger = fns.filter((n) => /withdraw|sweep|rescue|owner|transferOwnership|setF/i.test(n));
  check(danger.length === 0, "no owner, withdraw, or rescue function exists",
    danger.length ? "found: " + danger.join(", ") : "");

  console.log("\n=== a claimed token has nothing left ===");
  const pv2 = await claimer.previewRange.staticCall(padAddr, 0, 10, usdtAddr);
  check(pv2.every((r) => r.creatorQuote === 0n && r.protocolQuote === 0n),
    "re-preview right after claiming shows zero pending");

  console.log("\n=== one bad token must not strand the batch ===");
  const bogus = "0x00000000000000000000000000000000000000AA";
  const tx2 = await claimer.connect(carol).claimAll(padAddr, [tokens[0], bogus, tokens[1]],
    { gasLimit: 25_000_000 });
  const rc2 = await tx2.wait();
  const ev2 = rc2.logs.map((l) => { try { return claimer.interface.parseLog(l); } catch { return null; } })
                      .find((x) => x && x.name === "BatchClaimed");
  check(rc2.status === 1, "a batch containing an unknown token still succeeds");
  check(ev2 && ev2.args.claimed === 2n && ev2.args.failed === 1n,
    "the bad token is counted as failed, the good ones still claim",
    ev2 ? `claimed=${ev2.args.claimed} failed=${ev2.args.failed}` : "no event");

  console.log("\n=== range clamping ===");
  const pvEmpty = await claimer.previewRange.staticCall(padAddr, 99, 10, usdtAddr);
  check(pvEmpty.length === 0, "a start index past the end returns empty, not a revert");
  const pvClamp = await claimer.previewRange.staticCall(padAddr, 2, 50, usdtAddr);
  check(pvClamp.length === 1, "a count running past the end is clamped");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
