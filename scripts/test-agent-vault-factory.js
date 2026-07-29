// Tests for AgentVaultFactory against a real Uniswap V3 deployment in ganache.
//
//   node scripts/compile.js && node scripts/test-agent-vault-factory.js
//
// The factory's only job is to make "this vault is genuine" a checkable claim.
// So the tests that decide whether this ships are the ones proving a caller
// cannot influence `npm` or `router`, that a forged pool is rejected, and that
// a vault built here is exactly as hard to rob as a hand-deployed one. The
// hostile-keeper section from test-agent-vault.js is re-run against a
// factory-created vault for that last reason: provenance must change nothing.
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
// Deployments and factory calls that must fail, where the reason matters. A
// creation rejected for an incidental reason (out of gas, a typo'd address)
// would pass a bare "it reverted" assertion while leaving the actual guard
// untested, which is the failure mode this helper exists to prevent.
// Returns the revert reason of a call that is expected to fail, or null if it
// unexpectedly succeeded. Callers must use eth_call (staticCall, or provider
// .call for a deployment): a sent transaction with an explicit gasLimit skips
// the preflight, so ganache reports only "transaction execution reverted" and
// every reason assertion below would silently degrade to "it reverted somehow".
async function reasonOf(fn) {
  try { await fn(); return null; }
  catch (e) { return (e.shortMessage || e.reason || e.message || "").toString(); }
}
async function failsWith(fn, needle, name) {
  const reason = await reasonOf(fn);
  if (reason === null) { check(false, name, "expected revert, call succeeded"); return; }
  check(reason.toLowerCase().includes(needle.toLowerCase()), name,
    `expected "${needle}", got: ${reason.slice(0, 160)}`);
}

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function increaseObservationCardinalityNext(uint16)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
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
  // Same fixed mnemonic rationale as test-agent-vault.js: random accounts
  // change token0/token1 ordering and therefore every downstream amount.
  const g = ganache.provider({
    logging: { quiet: true },
    wallet: { defaultBalance: 100000, mnemonic: "mintd agent vault deterministic test seed phrase here ok" },
    miner: { blockGasLimit: "0x1C9C380" },
  });
  const provider = new ethers.BrowserProvider(g);
  const warp = async (secs) => { await g.request({ method: "evm_increaseTime", params: [secs] }); await g.request({ method: "evm_mine", params: [] }); };
  const [deployer, owner, keeper, mallory, other] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
  const OWNER = await owner.getAddress();
  const KEEPER = await keeper.getAddress();
  const MALLORY = await mallory.getAddress();
  const OTHER = await other.getAddress();

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
  const uniFactory = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await uniFactory.waitForDeployment();
  const uniFacAddr = await uniFactory.getAddress();
  const npmArt = uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
  const npmC = await new ethers.ContractFactory(npmArt.abi, npmArt.bytecode, deployer).deploy(
    uniFacAddr, aAddr, deployer.address);
  await npmC.waitForDeployment();
  const npmAddr = await npmC.getAddress();
  const r02Art = uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");
  const router = await new ethers.ContractFactory(r02Art.abi, r02Art.bytecode, deployer).deploy(
    ethers.ZeroAddress, uniFacAddr, npmAddr, aAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // 1:1 pool
  const npmD = new ethers.Contract(npmAddr, NPM_ABI, deployer);
  await (await npmD.createAndInitializePoolIfNecessary(aAddr, bAddr, FEE, sqrtRatioX96(1n, 1n), { gasLimit: 8_000_000 })).wait();
  const getPool = new ethers.Contract(uniFacAddr,
    ["function getPool(address,address,uint24) view returns (address)"], provider);
  const poolAddr = await getPool.getPool(aAddr, bAddr, FEE);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  await (await pool.connect(deployer).increaseObservationCardinalityNext(200)).wait();

  await (await A.connect(deployer).approve(npmAddr, ethers.MaxUint256)).wait();
  await (await B.connect(deployer).approve(npmAddr, ethers.MaxUint256)).wait();
  await (await npmD.mint([aAddr, bAddr, FEE, -60000, 60000, E(2_000_000), E(2_000_000), 0, 0,
    deployer.address, Math.floor(Date.now() / 1000) + 3600], { gasLimit: 12_000_000 })).wait();

  for (const [who, amt] of [[owner, E(200_000)], [mallory, E(3_000_000)], [other, E(50_000)]]) {
    await (await A.connect(deployer).transfer(await who.getAddress(), amt)).wait();
    await (await B.connect(deployer).transfer(await who.getAddress(), amt)).wait();
  }
  const topUp = async () => {
    await (await A.connect(deployer).transfer(OWNER, E(80_000))).wait();
    await (await B.connect(deployer).transfer(OWNER, E(80_000))).wait();
  };

  // ---- TWAP history
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

  const fArt = build("AgentVaultFactory");
  const vArt = build("AgentVault");
  const facCF = new ethers.ContractFactory(fArt.abi, fArt.bytecode, deployer);
  const deployFactory = async (npmA, routerA) => {
    const c = await facCF.deploy(npmA, routerA, { gasLimit: 20_000_000 });
    await c.waitForDeployment();
    return c;
  };
  // Deployment as eth_call, so a rejected constructor yields its reason rather
  // than an unwaited contract object that looks like success.
  const deployFactoryCall = async (npmA, routerA) =>
    provider.call(await facCF.getDeployTransaction(npmA, routerA));

  // ============================================================ construction
  console.log("\n=== factory construction ===");
  const factory = await deployFactory(npmAddr, routerAddr);
  await factory.waitForDeployment();
  const facAddr = await factory.getAddress();

  check((await factory.npm()) === npmAddr, "factory records the position manager");
  check((await factory.router()) === routerAddr, "factory records the router");

  const code = await provider.getCode(facAddr);
  const size = (code.length - 2) / 2;
  console.log(`      deployed factory runtime: ${size} bytes (EIP-170 limit 24576)`);
  check(size > 0 && size < 24576, "factory fits under the EIP-170 contract size limit",
    `${size} bytes; if this fails the fix is NOT minimal proxies, see the contract header`);

  await failsWith(() => deployFactoryCall(ethers.ZeroAddress, routerAddr), "zero", "zero position manager is rejected");
  await failsWith(() => deployFactoryCall(npmAddr, ethers.ZeroAddress), "zero", "zero router is rejected");
  await failsWith(() => deployFactoryCall(MALLORY, routerAddr), "not contract", "an EOA as position manager is rejected");
  await failsWith(() => deployFactoryCall(npmAddr, MALLORY), "not contract", "an EOA as router is rejected");

  // A contract that is not a position manager at all: no factory() to resolve
  // the canonical pool against, so every vault it produced would be unverifiable.
  const fakeArt = build("MockFakePool");
  const notAnNpm = await new ethers.ContractFactory(fakeArt.abi, fakeArt.bytecode, deployer).deploy(
    aAddr, bAddr, FEE, SPACING, 0);
  await notAnNpm.waitForDeployment();
  // Resolved before the callback: `await` inside a non-async arrow is a syntax
  // error, the same trap test-agent-vault.js documents for its signers.
  const notAnNpmAddr = await notAnNpm.getAddress();
  await failsWith(() => deployFactoryCall(notAnNpmAddr, routerAddr), "",
    "a contract with no factory() is rejected as the position manager");

  // ============================================================ creating one
  console.log("\n=== creating a vault ===");
  const createVault = async (signer, poolA, agentA, numA, gas = 9_000_000) => {
    const r = await (await factory.connect(signer).createVault(poolA, agentA, numA, { gasLimit: gas })).wait();
    const ev = r.logs
      .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .filter(Boolean).find((e) => e.name === "VaultCreated");
    return { addr: ev ? ev.args.vault : null, ev, receipt: r };
  };

  const { addr: vAddr, ev } = await createVault(owner, poolAddr, KEEPER, bAddr);
  const vault = new ethers.Contract(vAddr, vArt.abi, provider);

  check(vAddr && vAddr !== ethers.ZeroAddress, "createVault deploys a vault");
  check((await vault.owner()) === OWNER, "owner is the caller, not the factory and not the deployer");
  check((await vault.owner()) !== facAddr, "the factory does not own what it creates");
  check((await vault.npm()) === npmAddr, "the vault's position manager is the factory's, not a caller's");
  check((await vault.router()) === routerAddr, "the vault's router is the factory's, not a caller's");
  check((await vault.pool()) === poolAddr, "the vault points at the pool that was asked for");
  check((await vault.agent()) === KEEPER, "the agent is set as requested");
  check((await vault.valueInToken0()) === false, "numeraire token1 gives valueInToken0 = false");
  check(Number(await vault.mode()) === 1, "a fresh vault defaults to PROPOSE_ONLY, not autonomous");
  check(await factory.isVault(vAddr), "isVault is true for factory output");
  check(ev.args.owner === OWNER && ev.args.pool === poolAddr && ev.args.agent === KEEPER,
    "VaultCreated carries owner, pool and agent");

  // The strongest statement available that a caller cannot reach npm/router:
  // there is no parameter for either. Asserted against the ABI so that adding
  // one later fails this test rather than quietly widening the trust surface.
  const cv = fArt.abi.find((x) => x.type === "function" && x.name === "createVault");
  check(cv.inputs.length === 3 && cv.inputs.map((i) => i.name).join(",") === "pool,agent,numeraire",
    "createVault exposes no npm or router parameter at all",
    `signature is (${cv.inputs.map((i) => i.name).join(", ")})`);
  check(!fArt.abi.some((x) => x.type === "function" && /^set/i.test(x.name || "")),
    "the factory has no setters, so there is no admin path to repoint anything");
  check(!fArt.abi.some((x) => x.type === "function" && /owner|admin/i.test(x.name || "")),
    "the factory has no owner or admin role");

  // ================================================== what must be rejected
  console.log("\n=== parameters a caller must not be able to abuse ===");

  // A contract that mimics a real pool while serving a TWAP it chooses. Every
  // minimum output the vault enforces is derived from that TWAP, so accepting
  // this is a total drain rather than a degraded one.
  const forged = await new ethers.ContractFactory(fakeArt.abi, fakeArt.bytecode, deployer).deploy(
    aAddr, bAddr, FEE, SPACING, 0);
  await forged.waitForDeployment();
  const forgedAddr = await forged.getAddress();
  await failsWith(() => factory.connect(owner).createVault.staticCall(forgedAddr, KEEPER, bAddr),
    "pool not canonical", "a forged pool serving its own TWAP is rejected");

  // Real Uniswap pool, real code, wrong universe: built on a factory the
  // position manager does not use, so it is not the canonical pool for the pair.
  const rogueUniFac = await new ethers.ContractFactory(facArt.abi, facArt.bytecode, deployer).deploy();
  await rogueUniFac.waitForDeployment();
  await (await rogueUniFac.createPool(aAddr, bAddr, FEE, { gasLimit: 8_000_000 })).wait();
  const rogueAddr = await rogueUniFac.getPool(aAddr, bAddr, FEE);
  check(rogueAddr !== ethers.ZeroAddress && rogueAddr !== poolAddr, "built a real pool on an unrelated factory");
  await failsWith(() => factory.connect(owner).createVault.staticCall(rogueAddr, KEEPER, bAddr),
    "pool not canonical", "a real but non-canonical pool is rejected");

  await failsWith(() => factory.connect(owner).createVault.staticCall(poolAddr, KEEPER, MALLORY),
    "numeraire not in pool", "a numeraire outside the pool is rejected");
  await failsWith(() => factory.connect(owner).createVault.staticCall(ethers.ZeroAddress, KEEPER, bAddr),
    "", "a zero pool is rejected");

  // Every rejection above must also be a real rejection on a sent transaction,
  // not only under eth_call. Cheap to assert, and it catches the case where a
  // guard depends on state an eth_call happens to see differently.
  await reverts(() => factory.connect(owner).createVault(forgedAddr, KEEPER, bAddr, { gasLimit: 9_000_000 }),
    "the forged pool is rejected when actually sent, not just simulated");

  const beforeCount = await factory.vaultCount();
  check(beforeCount === 1n, "no rejected creation left a vault behind", `count is ${beforeCount}`);

  // ============================================== hostile pool, reentrancy
  console.log("\n=== a hostile pool cannot reenter the factory ===");
  // The factory ships without a reentrancy guard, on the reasoning that the
  // pre-canonical-check reads are all STATICCALL. That is a claim about
  // compiled code, so it gets tested rather than asserted: this mock tries to
  // call back into createVault from token0().
  const reenterCalldata = factory.interface.encodeFunctionData("createVault", [poolAddr, KEEPER, bAddr]);
  const trap = await new ethers.ContractFactory(fakeArt.abi, fakeArt.bytecode, deployer).deploy(
    aAddr, bAddr, FEE, SPACING, 0);
  await trap.waitForDeployment();
  await (await trap.setReentry(facAddr, reenterCalldata)).wait();
  const trapAddr = await trap.getAddress();
  await reverts(() => factory.connect(mallory).createVault(trapAddr, MALLORY, bAddr, { gasLimit: 9_000_000 }),
    "creation against a reentrant pool reverts");
  check((await factory.vaultCount()) === beforeCount,
    "the reentrant attempt created no vault", `count moved to ${await factory.vaultCount()}`);

  // Distinguishing STATICCALL from a plain rollback needs care. `reenterAttempts`
  // reads 0 either way, because the outer transaction reverts regardless, so
  // asserting on it would prove nothing at all. The reason strings do separate
  // the two cases: the forged pool and this trap differ only in that token0()
  // writes storage here. The forged pool reaches the canonical check and says
  // so. If this one also reached it, the reentrant call had been a normal CALL.
  // It does not reach it, so execution died earlier, inside token0() itself,
  // which is only possible under STATICCALL.
  const forgedReason = await reasonOf(() => factory.connect(mallory).createVault.staticCall(forgedAddr, MALLORY, bAddr));
  const trapReason = await reasonOf(() => factory.connect(mallory).createVault.staticCall(trapAddr, MALLORY, bAddr));
  check(forgedReason !== null && /pool not canonical/i.test(forgedReason),
    "the inert forged pool gets as far as the canonical check", `got: ${forgedReason}`);
  check(trapReason !== null && !/pool not canonical/i.test(trapReason),
    "the reentrant pool never reaches it, so token0() itself failed: the read was a STATICCALL",
    `got: ${trapReason}`);

  // ==================================================== provenance
  console.log("\n=== isVault means provenance, not shape ===");
  const handmade = await new ethers.ContractFactory(vArt.abi, vArt.bytecode, deployer).deploy(
    OWNER, poolAddr, npmAddr, routerAddr, KEEPER, bAddr, { gasLimit: 12_000_000 });
  await handmade.waitForDeployment();
  const handAddr = await handmade.getAddress();
  check(!(await factory.isVault(handAddr)),
    "a byte-identical hand-deployed vault reads false, because it was not built here");
  check(!(await factory.isVault(MALLORY)), "a random address reads false");
  check(!(await factory.isVault(facAddr)), "the factory is not itself a vault");

  // ==================================================== registry
  console.log("\n=== registry and pagination ===");
  const { addr: v2Addr } = await createVault(owner, poolAddr, KEEPER, aAddr);
  const { addr: v3Addr } = await createVault(other, poolAddr, KEEPER, bAddr);

  check((await factory.vaultCount()) === 3n, "global count tracks every vault");
  check((await factory.vaultCountOf(OWNER)) === 2n, "per-owner count is right for the owner");
  check((await factory.vaultCountOf(OTHER)) === 1n, "per-owner count is right for a second owner");
  check((await factory.vaultCountOf(MALLORY)) === 0n, "an address with no vaults reads zero");

  const mine = await factory.vaultsOf(OWNER);
  check(mine.length === 2 && mine[0] === vAddr && mine[1] === v2Addr, "vaultsOf returns an owner's vaults in creation order");
  const theirs = await factory.vaultsOf(OTHER);
  check(theirs.length === 1 && theirs[0] === v3Addr, "owners are isolated from each other");
  check((await new ethers.Contract(v2Addr, vArt.abi, provider).valueInToken0()) === true,
    "the second vault took its own numeraire, not the first one's");

  const p0 = await factory.vaultsOfSlice(OWNER, 0, 1);
  check(p0.length === 1 && p0[0] === vAddr, "a slice returns the requested page");
  const p1 = await factory.vaultsOfSlice(OWNER, 1, 5);
  check(p1.length === 1 && p1[0] === v2Addr, "a slice past the end is truncated, not reverted");
  const p2 = await factory.vaultsOfSlice(OWNER, 2, 5);
  check(p2.length === 0, "starting exactly at the end returns empty");
  const p3 = await factory.vaultsOfSlice(OWNER, 99, 5);
  check(p3.length === 0, "starting far past the end returns empty rather than reverting");
  const p4 = await factory.vaultsOfSlice(OWNER, 0, 0);
  check(p4.length === 0, "a zero-length page returns empty");
  const p5 = await factory.vaultsOfSlice(MALLORY, 0, 10);
  check(p5.length === 0, "paging an empty list is safe");
  const all = await factory.allVaultsSlice(0, 100);
  check(all.length === 3, "allVaultsSlice pages the global list");
  const allEnd = await factory.allVaultsSlice(2, 100);
  check(allEnd.length === 1 && allEnd[0] === v3Addr, "the global list is in creation order");

  // Anyone can append to the global list. The frontend must never scan it, and
  // this test documents why by making the griefing concrete.
  await createVault(mallory, poolAddr, MALLORY, bAddr);
  check((await factory.vaultCount()) === 4n, "a stranger can append to the global list");
  check((await factory.vaultCountOf(OWNER)) === 2n, "but cannot touch another owner's list");

  // ==================================================== end to end
  console.log("\n=== a factory-built vault works end to end ===");
  await topUp();
  await (await A.connect(owner).approve(vAddr, ethers.MaxUint256)).wait();
  await (await B.connect(owner).approve(vAddr, ethers.MaxUint256)).wait();
  await (await vault.connect(owner).deposit(E(50_000), E(50_000), { gasLimit: 3_000_000 })).wait();
  const deposited = await vault.valueNow();
  check(deposited > 0n, "deposit into a factory-built vault registers value");
  check((await vault.valueCheckpoint()) > 0n, "the loss breaker is armed on deposit");

  const t = Number((await pool.slot0()).tick);
  const lo = alignDown(t - 1800), hi = alignDown(t + 1800);
  await (await vault.connect(keeper).propose(lo, hi, { gasLimit: 800_000 })).wait();
  await reverts(() => vault.connect(keeper).execute({ gasLimit: 6_000_000 }),
    "PROPOSE_ONLY still holds on a factory-built vault");
  await (await vault.connect(owner).approve(await vault.proposalNonce(), { gasLimit: 500_000 })).wait();
  await (await vault.connect(keeper).execute({ gasLimit: 12_000_000 })).wait();
  check((await vault.positionId()) > 0n, "an approved proposal opens a position");

  await reverts(() => vault.connect(mallory).withdrawAll({ gasLimit: 3_000_000 }),
    "a stranger cannot withdraw from someone else's factory vault");

  const pA = await A.balanceOf(OWNER), pB = await B.balanceOf(OWNER);
  await (await vault.connect(owner).withdrawAll({ gasLimit: 12_000_000 })).wait();
  const gotA = (await A.balanceOf(OWNER)) - pA, gotB = (await B.balanceOf(OWNER)) - pB;
  check(gotA > 0n && gotB > 0n, "the owner recovers both tokens");
  check((await A.balanceOf(vAddr)) === 0n && (await B.balanceOf(vAddr)) === 0n, "the vault retains nothing");
  const cycleLost = Number(ethers.formatEther(deposited)) - (Number(ethers.formatEther(gotA)) + Number(ethers.formatEther(gotB)));
  check(cycleLost / Number(ethers.formatEther(deposited)) < 0.02, "a full cycle costs under 2%", `lost ${cycleLost}`);

  // The withdrawal path must not need the factory. This is the entire rollback
  // plan for an immutable contract with no admin: if the factory is wrong,
  // owners still get their money out of vaults it already made.
  check((await factory.isVault(vAddr)), "the vault is still registered after being emptied");

  // ==================================================== hostile keeper
  console.log("\n=== HOSTILE KEEPER against a FACTORY-BUILT vault ===");
  // Ported from test-agent-vault.js. Provenance must change nothing about how
  // hard the vault is to rob, so the same attack is run against a vault this
  // factory produced, with the attacker holding the agent role outright.
  const { addr: hvAddr } = await createVault(owner, poolAddr, MALLORY, bAddr);
  const hv = new ethers.Contract(hvAddr, vArt.abi, provider);
  await (await hv.connect(owner).setMode(3, { gasLimit: 500_000 })).wait();          // AUTONOMOUS
  await (await hv.connect(owner).setPolicy(2000, 100, 500, 300, 300, 0, { gasLimit: 500_000 })).wait();
  await (await A.connect(owner).approve(hvAddr, ethers.MaxUint256)).wait();
  await (await B.connect(owner).approve(hvAddr, ethers.MaxUint256)).wait();
  await topUp();
  await (await hv.connect(owner).deposit(E(50_000), E(50_000), { gasLimit: 3_000_000 })).wait();

  const startValue = await hv.valueNow();
  console.log(`      vault holds ${ethers.formatEther(startValue)}; attacker holds ~3,000,000 of each`);
  await (await A.connect(mallory).approve(routerAddr, ethers.MaxUint256)).wait();
  await (await B.connect(mallory).approve(routerAddr, ethers.MaxUint256)).wait();

  let attempts = 0, reverted = 0, executed = 0;
  for (let round = 0; round < 6; round++) {
    const dir = round % 2 === 0;
    try {
      await (await rx(mallory).exactInputSingle({ tokenIn: dir ? aAddr : bAddr, tokenOut: dir ? bAddr : aAddr,
        fee: FEE, recipient: MALLORY, amountIn: E(400_000), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
        { gasLimit: 6_000_000 })).wait();
    } catch {}
    const cur = Number((await pool.slot0()).tick);
    for (const [l, u] of [[alignDown(cur - 600), alignDown(cur + 600)], [alignDown(cur - 1800), alignDown(cur + 1800)]]) {
      attempts++;
      try {
        await (await hv.connect(mallory).propose(l, u, { gasLimit: 800_000 })).wait();
        const r = await (await hv.connect(mallory).execute({ gasLimit: 12_000_000 })).wait();
        if (r.status === 0) reverted++; else executed++;
      } catch { reverted++; }
    }
    try {
      await (await rx(mallory).exactInputSingle({ tokenIn: dir ? bAddr : aAddr, tokenOut: dir ? aAddr : bAddr,
        fee: FEE, recipient: MALLORY, amountIn: E(400_000), amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
        { gasLimit: 6_000_000 })).wait();
    } catch {}
    await warp(400);
  }

  const endValue = await hv.valueNow();
  const startNum = Number(ethers.formatEther(startValue));
  const dropPct = (startNum - Number(ethers.formatEther(endValue))) / startNum * 100;
  console.log(`      ${attempts} attack attempts: ${executed} executed, ${reverted} reverted`);
  console.log(`      vault value ${ethers.formatEther(startValue)} -> ${ethers.formatEther(endValue)}  (${dropPct.toFixed(2)}%)`);
  check(dropPct < 6, "a hostile keeper cannot drain a factory-built vault beyond tolerance",
    `value fell ${dropPct.toFixed(2)}%, tolerance is 5% plus fees`);

  const qA = await A.balanceOf(OWNER), qB = await B.balanceOf(OWNER);
  await (await hv.connect(owner).withdrawAll({ gasLimit: 12_000_000 })).wait();
  const recovered = Number(ethers.formatEther((await A.balanceOf(OWNER)) - qA))
                  + Number(ethers.formatEther((await B.balanceOf(OWNER)) - qB));
  console.log(`      owner recovered ${recovered.toFixed(0)} of ${startNum.toFixed(0)} (${(recovered / startNum * 100).toFixed(1)}%)`);
  check(recovered / startNum > 0.94, "the owner recovers over 94% after a hostile keeper had free rein",
    `recovered ${(recovered / startNum * 100).toFixed(1)}%`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
