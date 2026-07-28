// Tests for AgentVault against a real Uniswap V3 deployment in ganache.
//
//   node scripts/compile.js && node scripts/test-agent-vault.js
//
// The hostile-keeper section is the one that decides whether this ships. Every
// other test can pass while the vault is drainable, because theft goes through
// the swap path rather than the transfer path.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));

let passed = 0, failed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
async function reverts(fn, name) {
  try { const r = await (await fn()).wait(); check(r.status === 0, name, "expected revert, tx succeeded"); }
  catch { check(true, name); }
}

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function increaseObservationCardinalityNext(uint16)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function token0() view returns (address)", "function token1() view returns (address)",
];
const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) payable returns (uint256,uint128,uint256,uint256)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
const FEE = 3000, SPACING = 60;

function sqrtRatioX96(num, den) {
  const x = (num << 96n) / den;
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n, y = x;
  while (z < y) { y = z; z = (x / z + z) / 2n; }
  return y << 48n;
}
const alignDown = (t) => Math.floor(t / SPACING) * SPACING;

async function main() {
  // Fixed mnemonic: ganache randomises accounts per run, which changes the
  // token0/token1 ordering and therefore every downstream amount. A test whose
  // outcome moves between runs cannot be trusted when it passes.
  const g = ganache.provider({
    logging: { quiet: true },
    wallet: { defaultBalance: 100000, mnemonic: "mintd agent vault deterministic test seed phrase here ok" },
    miner: { blockGasLimit: "0x1C9C380" },
  });
  const provider = new ethers.BrowserProvider(g);
  const warp = async (secs) => { await g.request({ method: "evm_increaseTime", params: [secs] }); await g.request({ method: "evm_mine", params: [] }); };
  const [deployer, owner, keeper, mallory] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  // Resolved once: an `await` inside a non-async arrow is a syntax error, and
  // these are used inside reverts(() => ...) callbacks throughout.
  const OWNER = await owner.getAddress();
  const KEEPER = await keeper.getAddress();
  const MALLORY = await mallory.getAddress();

  // ---- two plain 18-dec tokens
  const tArt = build("MemeToken20");
  const mk = async (n, to) => {
    const c = await new ethers.ContractFactory(tArt.abi, tArt.bytecode, deployer).deploy(n, n, "", E(100_000_000), to);
    await c.waitForDeployment(); return c;
  };
  let A = await mk("AAA", deployer.address);
  let B = await mk("BBB", deployer.address);
  let aAddr = await A.getAddress(), bAddr = await B.getAddress();
  if (BigInt(aAddr) > BigInt(bAddr)) { [A, B] = [B, A]; [aAddr, bAddr] = [bAddr, aAddr]; }

  // ---- real Uniswap V3
  const facArt = uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const factory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await factory.waitForDeployment();
  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npmC = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    await factory.getAddress(), aAddr, deployer.address);
  await npmC.waitForDeployment();
  const npmAddr = await npmC.getAddress();
  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, await factory.getAddress(), npmAddr, aAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // 1:1 pool
  const npmD = new ethers.Contract(npmAddr, NPM_ABI, deployer);
  await (await npmD.createAndInitializePoolIfNecessary(aAddr, bAddr, FEE, sqrtRatioX96(1n, 1n), { gasLimit: 8_000_000 })).wait();
  const poolAddr = await new ethers.Contract(await factory.getAddress(),
    ["function getPool(address,address,uint24) view returns (address)"], provider).getPool(aAddr, bAddr, FEE);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  await (await pool.connect(deployer).increaseObservationCardinalityNext(200)).wait();

  // deep liquidity so the market is real and the attacker can actually move it
  await (await A.connect(deployer).approve(npmAddr, ethers.MaxUint256)).wait();
  await (await B.connect(deployer).approve(npmAddr, ethers.MaxUint256)).wait();
  await (await npmD.mint([aAddr, bAddr, FEE, -60000, 60000, E(2_000_000), E(2_000_000), 0, 0,
    deployer.address, Math.floor(Date.now() / 1000) + 3600], { gasLimit: 12_000_000 })).wait();

  // fund the players
  for (const [who, amt] of [[owner, E(200_000)], [mallory, E(3_000_000)], [keeper, E(1000)]]) {
    await (await A.connect(deployer).transfer(await who.getAddress(), amt)).wait();
    await (await B.connect(deployer).transfer(await who.getAddress(), amt)).wait();
  }

  // A withdrawal returns whatever ratio the position held, not what went in, so
  // the owner's two balances drift apart across sections. Top up before each
  // deposit rather than letting one section's leftovers decide the next one.
  const topUp = async () => {
    await (await A.connect(deployer).transfer(OWNER, E(80_000))).wait();
    await (await B.connect(deployer).transfer(OWNER, E(80_000))).wait();
  };

  // ---- build TWAP history: swaps spread over time
  const rx = (s) => new ethers.Contract(routerAddr, ROUTER_ABI, s);
  await (await A.connect(deployer).approve(routerAddr, ethers.MaxUint256)).wait();
  await (await B.connect(deployer).approve(routerAddr, ethers.MaxUint256)).wait();
  for (let i = 0; i < 8; i++) {
    await warp(600);
    await (await rx(deployer).exactInputSingle({ tokenIn: i % 2 ? aAddr : bAddr, tokenOut: i % 2 ? bAddr : aAddr,
      fee: FEE, recipient: deployer.address, amountIn: E(100), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
      { gasLimit: 3_000_000 })).wait();
  }
  await warp(600);

  // ---- vault
  const vArt = build("AgentVault");
  const vault = await new ethers.ContractFactory(vArt.abi, vArt.bytecode, deployer).deploy(
    OWNER, poolAddr, npmAddr, routerAddr, KEEPER);
  await vault.waitForDeployment();
  const vAddr = await vault.getAddress();

  console.log("\n=== setup ===");
  check((await vault.owner()) === OWNER, "owner is immutable and set");
  check((await vault.pool()) === poolAddr, "pool is immutable and set");
  check(Number(await vault.mode()) === 1, "defaults to PROPOSE_ONLY, not autonomous");
  const twapOk = await vault.valueNow().then(() => true).catch(() => false);
  check(twapOk, "a TWAP is available after seeding observations");

  await (await A.connect(owner).approve(vAddr, ethers.MaxUint256)).wait();
  await (await B.connect(owner).approve(vAddr, ethers.MaxUint256)).wait();
  await (await vault.connect(owner).deposit(E(50_000), E(50_000))).wait();
  const deposited = await vault.valueNow();
  console.log(`      deposited, vault value ${ethers.formatEther(deposited)} (in token1 terms)`);
  check(deposited > 0n, "deposit registers value");

  const t = Number((await pool.slot0()).tick);
  // Inside the default maxTickDrift of 2000. A wider range is rejected by the
  // contract, which is the point of the band, not a test artefact.
  const lo = alignDown(t - 1800), hi = alignDown(t + 1800);

  console.log("\n=== the agent has no authority of its own ===");
  await reverts(() => vault.connect(keeper).withdrawAll({ gasLimit: 2_000_000 }), "agent cannot withdraw");
  await reverts(() => vault.connect(keeper).setMode(3, { gasLimit: 500_000 }), "agent cannot change mode");
  await reverts(() => vault.connect(keeper).setPolicy(2000, 500, 2000, 0, 300, 0, { gasLimit: 500_000 }),
    "agent cannot loosen policy");
  await reverts(() => vault.connect(keeper).setAgent(MALLORY, { gasLimit: 500_000 }),
    "agent cannot hand itself to someone else");
  await reverts(() => vault.connect(mallory).propose(lo, hi, { gasLimit: 500_000 }),
    "a stranger cannot propose");

  console.log("\n=== human in the loop ===");
  await (await vault.connect(keeper).propose(lo, hi)).wait();
  await reverts(() => vault.connect(keeper).execute({ gasLimit: 6_000_000 }),
    "PROPOSE_ONLY: agent cannot execute without approval");
  await (await vault.connect(owner).approve()).wait();
  await (await vault.connect(keeper).execute({ gasLimit: 12_000_000 })).wait();
  check((await vault.positionId()) > 0n, "approved proposal executes and opens a position");

  await (await vault.connect(owner).setMode(0)).wait(); // PAUSED
  await reverts(() => vault.connect(keeper).propose(lo, hi, { gasLimit: 500_000 }),
    "PAUSED: agent cannot even propose");

  await (await vault.connect(owner).setMode(2)).wait(); // TIMELOCKED
  await warp(3700);
  await (await vault.connect(keeper).propose(lo, hi)).wait();
  await reverts(() => vault.connect(keeper).execute({ gasLimit: 6_000_000 }),
    "TIMELOCKED: agent cannot execute inside the review window");
  await (await vault.connect(owner).veto()).wait();
  await reverts(() => vault.connect(keeper).execute({ gasLimit: 6_000_000 }),
    "a vetoed proposal cannot be executed");

  console.log("\n=== the range is bounded by the contract, not the agent ===");
  await (await vault.connect(owner).setMode(3)).wait(); // AUTONOMOUS
  const far = alignDown(t + 60000);
  await reverts(() => vault.connect(keeper).propose(alignDown(t + 50000), far, { gasLimit: 500_000 }),
    "a range far outside the TWAP band is rejected");
  await reverts(() => vault.connect(keeper).propose(hi, lo, { gasLimit: 500_000 }), "an inverted range is rejected");
  await reverts(() => vault.connect(keeper).propose(lo + 1, hi, { gasLimit: 500_000 }), "an unaligned tick is rejected");

  console.log("\n=== owner can always get out, with no agent cooperation ===");
  await (await vault.connect(owner).revokeAgent()).wait();
  check((await vault.agent()) === ethers.ZeroAddress, "agent revoked in one transaction");
  await reverts(() => vault.connect(keeper).propose(lo, hi, { gasLimit: 500_000 }), "revoked agent can do nothing");
  const oA = await A.balanceOf(OWNER), oB = await B.balanceOf(OWNER);
  await (await vault.connect(owner).withdrawAll({ gasLimit: 12_000_000 })).wait();
  const gotA = (await A.balanceOf(OWNER)) - oA;
  const gotB = (await B.balanceOf(OWNER)) - oB;
  console.log(`      withdrew ${ethers.formatEther(gotA)} A + ${ethers.formatEther(gotB)} B`);
  check(gotA > 0n && gotB > 0n, "owner recovers both tokens");
  check((await A.balanceOf(vAddr)) === 0n && (await B.balanceOf(vAddr)) === 0n, "vault retains nothing");
  const lost = Number(ethers.formatEther(deposited)) - (Number(ethers.formatEther(gotA)) + Number(ethers.formatEther(gotB)));
  console.log(`      round trip cost ${lost.toFixed(2)} of ${ethers.formatEther(deposited)} (${(lost / Number(ethers.formatEther(deposited)) * 100).toFixed(2)}%)`);
  check(lost / Number(ethers.formatEther(deposited)) < 0.02, "a full cycle costs under 2%", `lost ${lost}`);

  // ================================================================
  console.log("\n=== HOSTILE KEEPER: full authority, funded, unlimited calls ===");
  // Fresh vault, everything handed to the attacker: agent role, AUTONOMOUS
  // mode, no cooldown, and a bankroll three times the vault to move the market.
  const v2 = await new ethers.ContractFactory(vArt.abi, vArt.bytecode, deployer).deploy(
    OWNER, poolAddr, npmAddr, routerAddr, MALLORY);
  await v2.waitForDeployment();
  const v2Addr = await v2.getAddress();
  await (await v2.connect(owner).setMode(3)).wait();
  await (await v2.connect(owner).setPolicy(2000, 100, 500, 0, 300, 0)).wait();
  await (await A.connect(owner).approve(v2Addr, ethers.MaxUint256)).wait();
  await (await B.connect(owner).approve(v2Addr, ethers.MaxUint256)).wait();
  await topUp();
  await (await v2.connect(owner).deposit(E(50_000), E(50_000))).wait();

  const startValue = await v2.valueNow();
  console.log(`      vault holds ${ethers.formatEther(startValue)}; attacker holds ~3,000,000 of each`);

  await (await A.connect(mallory).approve(routerAddr, ethers.MaxUint256)).wait();
  await (await B.connect(mallory).approve(routerAddr, ethers.MaxUint256)).wait();

  let attempts = 0, reverted = 0, executed = 0;
  for (let round = 0; round < 6; round++) {
    // Shove spot far away from the TWAP, which is what a sandwicher does.
    const dir = round % 2 === 0;
    try {
      await (await rx(mallory).exactInputSingle({ tokenIn: dir ? aAddr : bAddr, tokenOut: dir ? bAddr : aAddr,
        fee: FEE, recipient: MALLORY, amountIn: E(400_000), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
        { gasLimit: 6_000_000 })).wait();
    } catch {}

    // Now try to make the vault trade at that manipulated price.
    const cur = Number((await pool.slot0()).tick);
    // Both ranges are legal proposals, so the attack gets as far as actually
    // executing a swap rather than being stopped at the proposal gate.
    for (const [l, u] of [[alignDown(cur - 600), alignDown(cur + 600)], [alignDown(cur - 1800), alignDown(cur + 1800)]]) {
      attempts++;
      try {
        await (await v2.connect(mallory).propose(l, u, { gasLimit: 800_000 })).wait();
        const r = await (await v2.connect(mallory).execute({ gasLimit: 12_000_000 })).wait();
        if (r.status === 0) reverted++; else executed++;
      } catch { reverted++; }
    }
    // Push the price back, completing the sandwich.
    try {
      await (await rx(mallory).exactInputSingle({ tokenIn: dir ? bAddr : aAddr, tokenOut: dir ? aAddr : bAddr,
        fee: FEE, recipient: MALLORY, amountIn: E(400_000), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
        { gasLimit: 6_000_000 })).wait();
    } catch {}
    await warp(400);
  }

  const endValue = await v2.valueNow();
  const dropPct = (Number(ethers.formatEther(startValue)) - Number(ethers.formatEther(endValue)))
    / Number(ethers.formatEther(startValue)) * 100;
  console.log(`      ${attempts} attack attempts: ${executed} executed, ${reverted} reverted`);
  console.log(`      vault value ${ethers.formatEther(startValue)} -> ${ethers.formatEther(endValue)}  (${dropPct.toFixed(2)}%)`);

  check(dropPct < 6, "hostile keeper cannot drain the vault beyond tolerance",
    `value fell ${dropPct.toFixed(2)}%, tolerance is 5% plus fees`);

  // And the owner still gets everything back, from a hostile agent's vault.
  const pA = await A.balanceOf(OWNER), pB = await B.balanceOf(OWNER);
  await (await v2.connect(owner).withdrawAll({ gasLimit: 12_000_000 })).wait();
  const rA = (await A.balanceOf(OWNER)) - pA;
  const rB = (await B.balanceOf(OWNER)) - pB;
  const recovered = Number(ethers.formatEther(rA)) + Number(ethers.formatEther(rB));
  const startNum = Number(ethers.formatEther(startValue));
  console.log(`      owner recovered ${recovered.toFixed(0)} of ${startNum.toFixed(0)} (${(recovered / startNum * 100).toFixed(1)}%)`);
  check(recovered / startNum > 0.94, "owner recovers over 94% after a hostile keeper had free rein",
    `recovered ${(recovered / startNum * 100).toFixed(1)}%`);
  check((await A.balanceOf(MALLORY)) < E(3_100_000)
     || (await B.balanceOf(MALLORY)) < E(3_100_000),
    "attacker did not walk away with the vault's principal");

  // ================================================================
  console.log("\n=== SLOW GRIND: no manipulation, just rebalance forever ===");
  // Every attack above died at the TWAP-derived minimum output, so the loss
  // breaker was never reached. That leaves the patient attack the plan warned
  // about: rebalance repeatedly at honest prices and bleed the vault through
  // pool fees, each action individually modest. A per-action cap alone only
  // sets the schedule for this. The cumulative breaker is what bounds it.
  const v3 = await new ethers.ContractFactory(vArt.abi, vArt.bytecode, deployer).deploy(
    OWNER, poolAddr, npmAddr, routerAddr, MALLORY);
  await v3.waitForDeployment();
  const v3Addr = await v3.getAddress();
  await (await v3.connect(owner).setMode(3)).wait();
  // Tight tolerance so the breaker is reachable inside a test run.
  await (await v3.connect(owner).setPolicy(2000, 100, 100, 0, 300, 0)).wait();
  await (await A.connect(owner).approve(v3Addr, ethers.MaxUint256)).wait();
  await (await B.connect(owner).approve(v3Addr, ethers.MaxUint256)).wait();
  await topUp();
  await (await v3.connect(owner).deposit(E(20_000), E(20_000))).wait();

  const grindStart = await v3.valueNow();
  let grinds = 0, halted = false;
  for (let i = 0; i < 25 && !halted; i++) {
    const cur = Number((await pool.slot0()).tick);
    // Alternate the range so each rebalance forces a real swap, which is where
    // the fee is paid.
    const off = i % 2 === 0 ? 900 : 1500;
    try {
      await (await v3.connect(mallory).propose(alignDown(cur - off), alignDown(cur + off), { gasLimit: 800_000 })).wait();
      const r = await (await v3.connect(mallory).execute({ gasLimit: 12_000_000 })).wait();
      if (r.status === 0) halted = true; else grinds++;
    } catch { halted = true; }
    await warp(60);
  }
  const grindEnd = await v3.valueNow();
  const grindDrop = (Number(ethers.formatEther(grindStart)) - Number(ethers.formatEther(grindEnd)))
    / Number(ethers.formatEther(grindStart)) * 100;
  console.log(`      ${grinds} rebalances executed before ${halted ? "the breaker halted it" : "the loop ended"}`);
  console.log(`      value ${ethers.formatEther(grindStart)} -> ${ethers.formatEther(grindEnd)}  (${grindDrop.toFixed(3)}%)`);
  check(grindDrop < 3, "a grinding agent cannot bleed the vault beyond tolerance",
    `value fell ${grindDrop.toFixed(3)}%`);

  const gA = await A.balanceOf(OWNER), gB = await B.balanceOf(OWNER);
  await (await v3.connect(owner).withdrawAll({ gasLimit: 12_000_000 })).wait();
  const backA = (await A.balanceOf(OWNER)) - gA, backB = (await B.balanceOf(OWNER)) - gB;
  const back = Number(ethers.formatEther(backA)) + Number(ethers.formatEther(backB));
  const grindStartNum = Number(ethers.formatEther(grindStart));
  console.log(`      owner recovered ${back.toFixed(0)} of ${grindStartNum.toFixed(0)} (${(back / grindStartNum * 100).toFixed(1)}%)`);
  check(back / grindStartNum > 0.96, "owner still recovers over 96% after the grind",
    `recovered ${(back / grindStartNum * 100).toFixed(1)}%`);

  // ================================================================
  console.log("\n=== the loss breaker actually fires ===");
  // Neither attack above reached the breaker: the manipulated ones died at the
  // minimum-output check, and grinding cost too little to trip it. That leaves
  // the breaker unproven, which is not something to ship. Set the tolerance to
  // zero so any loss at all must halt the agent, and confirm it does.
  const v4 = await new ethers.ContractFactory(vArt.abi, vArt.bytecode, deployer).deploy(
    OWNER, poolAddr, npmAddr, routerAddr, MALLORY);
  await v4.waitForDeployment();
  const v4Addr = await v4.getAddress();
  await (await v4.connect(owner).setMode(3)).wait();
  await (await v4.connect(owner).setPolicy(2000, 100, 0, 0, 300, 0)).wait(); // zero tolerance
  await (await A.connect(owner).approve(v4Addr, ethers.MaxUint256)).wait();
  await (await B.connect(owner).approve(v4Addr, ethers.MaxUint256)).wait();
  await topUp();
  await (await v4.connect(owner).deposit(E(20_000), E(20_000))).wait();
  check((await v4.valueCheckpoint()) > 0n, "a checkpoint is armed on deposit");

  let tripped = false, ran = 0, lastReason = "";
  for (let i = 0; i < 6 && !tripped; i++) {
    const cur = Number((await pool.slot0()).tick);
    const off = i % 2 === 0 ? 900 : 1500;
    await (await v4.connect(mallory).propose(alignDown(cur - off), alignDown(cur + off), { gasLimit: 800_000 })).wait();
    // Simulated first, because a reverted wait() does not carry the revert
    // string and "it reverted" is not the same claim as "the breaker fired".
    try {
      await v4.connect(mallory).execute.staticCall();
      await (await v4.connect(mallory).execute({ gasLimit: 12_000_000 })).wait();
      ran++;
    } catch (e) {
      lastReason = e.reason || e.shortMessage || String(e).slice(0, 80);
      tripped = /loss breaker/.test(lastReason);
      break;
    }
    await warp(60);
  }
  console.log(`      ${ran} rebalance(s), then reverted with: "${lastReason}"`);
  check(tripped, "with zero tolerance, the loss breaker halts the agent",
    "the breaker never fired, so the mechanism is not proven to work");

  // And an owner can deliberately re-arm it, which must be manual: an automatic
  // reset would let a slow drain continue indefinitely.
  await (await v4.connect(owner).resetCheckpoint()).wait();
  check((await v4.valueCheckpoint()) > 0n, "owner can re-arm the checkpoint after a halt");
  await reverts(() => v4.connect(mallory).resetCheckpoint({ gasLimit: 500_000 }),
    "the agent cannot re-arm the checkpoint itself");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
