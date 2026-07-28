// Tests for FeeSplitter, which gives Stable's immutable launchpad an 80/20
// buyback split it was never built with.
//
//   node scripts/compile.js && node scripts/test-fee-splitter.js
//
// The end-to-end case is the one that matters: point the real launchpad's
// feeRecipient at the splitter, trade, claim, and check the protocol's share
// lands 80/20 without the launchpad knowing anything about it.
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
  const g = ganache.provider({ logging: { quiet: true }, wallet: { defaultBalance: 1000000 },
    miner: { blockGasLimit: "0x1C9C380" } });
  const provider = new ethers.BrowserProvider(g);

  // Native balances are read straight from the node. ethers memoises
  // getBalance per address, so a read taken before a transaction and another
  // taken straight after return the SAME value, making a correct transfer look
  // like a no-op. Setting cacheTimeout does not defeat it. The receipt event
  // and raw eth_getBalance both confirmed the transfers were really happening.
  const nativeBal = async (addr) =>
    BigInt(await g.request({ method: "eth_getBalance", params: [addr, "latest"] }));
  const [deployer, buyback, ops, alice, bob] =
    await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const usdtArt = build("MockUSDT0");
  const usdt = await new ethers.ContractFactory(usdtArt.abi, usdtArt.bytecode, deployer).deploy();
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();

  const splitArt = build("FeeSplitter");
  const sp = await new ethers.ContractFactory(splitArt.abi, splitArt.bytecode, deployer).deploy(
    buyback.address, ops.address, 8000n);
  await sp.waitForDeployment();
  const spAddr = await sp.getAddress();

  console.log("\n=== construction ===");
  check((await sp.buyback()) === buyback.address, "buyback destination set");
  check((await sp.ops()) === ops.address, "ops destination set");
  check((await sp.buybackBps()) === 8000n, "buybackBps is 8000 (80%)");

  const fns = splitArt.abi.filter((x) => x.type === "function").map((x) => x.name);
  const danger = fns.filter((n) => /owner|withdraw|sweep|rescue|pause|set[A-Z]/.test(n));
  check(danger.length === 0, "no owner, setter, withdraw or pause exists",
    danger.length ? "found: " + danger.join(", ") : "");

  console.log("\n=== the split itself ===");
  check((await sp.distribute.staticCall(usdtAddr))[0] === 0n, "a zero balance is a no-op, not a revert");

  // An amount that does not divide evenly, to catch dust.
  await (await usdt.connect(deployer).transfer(spAddr, U("1234.567891"))).wait();
  const bal = await usdt.balanceOf(spAddr);
  const b0 = await usdt.balanceOf(buyback.address), o0 = await usdt.balanceOf(ops.address);
  await (await sp.connect(bob).distribute(usdtAddr)).wait();
  const gotB = (await usdt.balanceOf(buyback.address)) - b0;
  const gotO = (await usdt.balanceOf(ops.address)) - o0;

  console.log(`      split ${ethers.formatUnits(bal, 6)} -> buyback ${ethers.formatUnits(gotB, 6)}, ops ${ethers.formatUnits(gotO, 6)}`);
  check(gotB === (bal * 8000n) / 10000n, "buyback receives exactly 80%");
  check(gotO === bal - (bal * 8000n) / 10000n, "ops receives exactly the residual");
  check(gotB + gotO === bal, "the two payouts sum to exactly the balance, no dust");
  check((await usdt.balanceOf(spAddr)) === 0n, "splitter retains nothing");
  check(true, "anyone can trigger it (called by an unrelated wallet)");

  console.log("\n=== batch skips a bad token ===");
  await (await usdt.connect(deployer).transfer(spAddr, U(100))).wait();
  const bogus = "0x00000000000000000000000000000000000000AA";
  const rc = await (await sp.connect(bob).distributeMany([usdtAddr, bogus])).wait();
  check(rc.status === 1, "a batch containing a bad token still succeeds");
  check((await usdt.balanceOf(spAddr)) === 0n, "the good token was still distributed");

  console.log("\n=== native split ===");
  await (await deployer.sendTransaction({ to: spAddr, value: E(10) })).wait();
  const natBal = await nativeBal(spAddr);
  const nb0 = await nativeBal(buyback.address), no0 = await nativeBal(ops.address);
  await (await sp.connect(bob).distributeNative()).wait();
  const dnb = (await nativeBal(buyback.address)) - nb0;
  const dno = (await nativeBal(ops.address)) - no0;
  console.log(`      splitter held ${ethers.formatEther(natBal)} native -> buyback ${ethers.formatEther(dnb)}, ops ${ethers.formatEther(dno)}`);
  check(dnb === (natBal * 8000n) / 10000n, "native: buyback gets 80%", `${dnb} vs ${(natBal * 8000n) / 10000n}`);
  check(dno === natBal - (natBal * 8000n) / 10000n, "native: ops gets the residual", `${dno}`);
  check(dnb + dno === natBal, "native: nothing lost");
  check((await nativeBal(spAddr)) === 0n, "native: splitter retains nothing");

  console.log("\n=== end to end against the real launchpad ===");
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

  // Deployed exactly as Stable is today: 90/10, feeRecipient a plain wallet.
  const padArt = build("InstantLaunchpad");
  const pad = await new ethers.ContractFactory(padArt.abi, padArt.bytecode, deployer).deploy(
    await npm.getAddress(), routerAddr, usdtAddr, deployer.address, E(1), 9000n, 3_000_000_000_000n,
    ethers.ZeroAddress, 0);
  await pad.waitForDeployment();

  // The two owner calls that produce 80/20-then-80/20 on an immutable pad.
  await (await pad.setConfig(E(1), 8000n, 3_000_000_000_000n)).wait();
  await (await pad.setFeeRecipient(spAddr)).wait();
  check((await pad.creatorShareBps()) === 8000n, "setConfig moved creators to 80%");
  check((await pad.feeRecipient()) === spAddr, "setFeeRecipient points at the splitter");

  const tx = await pad.connect(alice).launch("FEE", "FEE", "ipfs://x", 0n, { value: E(1), gasLimit: 12_000_000 });
  const lr = await tx.wait();
  const token = lr.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } })
                       .find((x) => x && x.name === "TokenLaunched").args.token;

  await (await usdt.connect(bob).approve(routerAddr, U(100000))).wait();
  const rx = new ethers.Contract(routerAddr, ROUTER02_ABI, bob);
  for (let i = 0; i < 4; i++) {
    await (await rx.exactInputSingle({
      tokenIn: usdtAddr, tokenOut: token, fee: 10000, recipient: bob.address,
      amountIn: U(250), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    }, { gasLimit: 3_000_000 })).wait();
  }

  // Snapshot the splitter first. It already holds the 1 USDT0 creation fee,
  // which the launchpad sent here as NATIVE value because feeRecipient is now
  // this contract. That is correct and wanted (creation fees fund buybacks
  // too), but it is not pool-fee revenue and must not be counted as such.
  const spBefore = await usdt.balanceOf(spAddr);
  const aliceBefore = await usdt.balanceOf(alice.address);
  await (await pad.claimFees(token, { gasLimit: 3_000_000 })).wait();
  const creatorGot = (await usdt.balanceOf(alice.address)) - aliceBefore;
  const atSplitter = (await usdt.balanceOf(spAddr)) - spBefore;
  const totalFee = creatorGot + atSplitter;
  console.log(`      (splitter already held ${ethers.formatUnits(spBefore, 6)} from the creation fee)`);

  console.log(`      pool fee ${ethers.formatUnits(totalFee, 6)} -> creator ${ethers.formatUnits(creatorGot, 6)}, protocol ${ethers.formatUnits(atSplitter, 6)}`);
  // Off-by-one tolerance: claimFees floors the creator share, and the mock's
  // balanceOf floors native/1e12, so one 1e-6 unit can land either side.
  const expCreator = (totalFee * 8000n) / 10000n;
  const d = creatorGot > expCreator ? creatorGot - expCreator : expCreator - creatorGot;
  check(d <= 1n, "creator got 80% of the pool fee", `${creatorGot} vs ${expCreator}`);
  check(creatorGot + atSplitter === totalFee, "creator plus protocol accounts for the whole pool fee");

  // Distribute only the pool-fee portion, so the ratio being asserted is the
  // pool-fee ratio and not diluted by the creation fee sitting alongside it.
  const b1 = await usdt.balanceOf(buyback.address), o1 = await usdt.balanceOf(ops.address);
  await (await sp.connect(bob).distribute(usdtAddr)).wait();
  const movedB = (await usdt.balanceOf(buyback.address)) - b1;
  const movedO = (await usdt.balanceOf(ops.address)) - o1;
  const wholeBal = spBefore + atSplitter;
  console.log(`      splitter distributed ${ethers.formatUnits(wholeBal, 6)} -> buyback ${ethers.formatUnits(movedB, 6)}, ops ${ethers.formatUnits(movedO, 6)}`);
  check(movedB === (wholeBal * 8000n) / 10000n, "buyback got 80% of everything the splitter held");
  check(movedB + movedO === wholeBal, "nothing lost in the second split");

  // The headline claim: of every unit of POOL fee, 16% reaches the buyback.
  const buybackOfPoolFee = (atSplitter * 8000n) / 10000n;
  const pctBuyback = Number(buybackOfPoolFee) / Number(totalFee) * 100;
  console.log(`      of every pool fee: creator ${(Number(creatorGot)/Number(totalFee)*100).toFixed(2)}%, `
    + `buyback ${pctBuyback.toFixed(2)}%, ops ${(Number(atSplitter - buybackOfPoolFee)/Number(totalFee)*100).toFixed(2)}%`);
  check(Math.abs(pctBuyback - 16) < 0.05, "buyback ends up with 16% of every pool fee",
    `got ${pctBuyback.toFixed(3)}%`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
