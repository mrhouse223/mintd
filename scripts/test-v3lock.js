// Tests V3PositionLocker against REAL Uniswap V3 contracts in ganache:
// lock a live position, generate fees by trading, prove the beneficiary can
// collect forever and that nobody can ever pull the liquidity back out.
//   node scripts/compile.js && node scripts/test-v3lock.js
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const build = (n) => require(path.join(__dirname, "..", "build", `${n}.json`));
const uni = (p) => require(p);
const E = (v) => ethers.parseEther(String(v));
const U = (v) => ethers.parseUnits(String(v), 6);

let passed = 0, failed = 0;
function check(c, n) { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}`); } }

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function safeTransferFrom(address,address,uint256,bytes)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

async function main() {
  const provider = new ethers.BrowserProvider(ganache.provider({
    logging: { quiet: true }, wallet: { defaultBalance: 1_000_000 }, miner: { blockGasLimit: "0x1C9C380" },
  }));
  const [deployer, creator, trader, other] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const GL = { gasLimit: 9_000_000 }, GS = { gasLimit: 2_000_000 };
  const depArt = async (art, signer, ...args) => {
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  // real Uniswap V3 stack + a mock USDT0 and a meme token
  const usdt = await depArt(build("MockUSDT0"), deployer);
  const usdtAddr = await usdt.getAddress();
  const factory = await depArt(uni("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"), deployer);
  const npm = await depArt(
    uni("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
    deployer, await factory.getAddress(), usdtAddr, deployer.address
  );
  const npmAddr = await npm.getAddress();
  const router = await depArt(
    uni("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
    deployer, ethers.ZeroAddress, await factory.getAddress(), npmAddr, usdtAddr
  );
  const routerAddr = await router.getAddress();

  const tok = await depArt(build("MemeToken20"), deployer, "USDT One", "USDT1", "", E(1_000_000_000), creator.address);
  const tokAddr = await tok.getAddress();

  // open a two-sided position owned by the creator
  const tokIs0 = BigInt(tokAddr) < BigInt(usdtAddr);
  const token0 = tokIs0 ? tokAddr : usdtAddr, token1 = tokIs0 ? usdtAddr : tokAddr;
  const FEE = 10000, SPACING = 200;
  // open the pool at $0.01 per token, decimal-adjusted (token 18 dec, USDT0 6 dec)
  const PRICE = 0.01;
  const p0in1 = tokIs0 ? PRICE * 1e-12 : (1 / PRICE) * 1e12;
  const sqrtBig = (x) => { if (x < 2n) return x; let z = x, y = x / 2n + 1n; while (y < z) { z = y; y = (x / y + y) / 2n; } return z; };
  const sqrtP = sqrtBig(BigInt(Math.floor(p0in1 * 1e24)) * (1n << 192n) / 10n ** 24n);
  const curTick = Math.floor(Math.log(p0in1) / Math.log(1.0001));
  const floorTo = (t) => Math.floor(t / SPACING) * SPACING;
  const tickLower = floorTo(curTick - SPACING * 300);
  const tickUpper = floorTo(curTick + SPACING * 300) + SPACING;
  const npmC = new ethers.Contract(npmAddr, NPM_ABI, creator);
  await (await npmC.createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtP, GL)).wait();
  await (await tok.connect(creator).approve(npmAddr, ethers.MaxUint256, GS)).wait();
  await (await usdt.connect(creator).approve(npmAddr, ethers.MaxUint256, GS)).wait();

  const mintRc = await (await npmC.mint({
    token0, token1, fee: FEE, tickLower, tickUpper,
    amount0Desired: tokIs0 ? E(1_000_000) : U(10_000),
    amount1Desired: tokIs0 ? U(10_000) : E(1_000_000),
    amount0Min: 0, amount1Min: 0, recipient: creator.address,
    deadline: Math.floor(Date.now() / 1000) + 900,
  }, GL)).wait();
  // tokenId from the NPM Transfer(0x0 -> creator)
  const xfer = mintRc.logs.filter((l) => l.address.toLowerCase() === npmAddr.toLowerCase() && l.topics.length === 4);
  const tokenId = BigInt(xfer[0].topics[3]);
  check((await npm.ownerOf(tokenId)) === creator.address, "creator owns the fresh position");

  // ---- lock it permanently
  const locker = await depArt(build("V3PositionLocker"), deployer, npmAddr);
  const lockerAddr = await locker.getAddress();
  await (await npmC["safeTransferFrom(address,address,uint256,bytes)"](creator.address, lockerAddr, tokenId, "0x", GL)).wait();
  check((await npm.ownerOf(tokenId)) === lockerAddr, "position now held by the locker");
  check((await locker.beneficiaryOf(tokenId)) === creator.address, "creator recorded as beneficiary");
  check(await locker.isLocked(tokenId), "position marked locked");
  check((await locker.lockedCount()) === 1n, "locked position indexed");

  // ---- trading generates fees
  await (await usdt.connect(trader).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  const routerT = new ethers.Contract(routerAddr, ROUTER_ABI, trader);
  for (let i = 0; i < 3; i++) {
    await (await routerT.exactInputSingle({
      tokenIn: usdtAddr, tokenOut: tokAddr, fee: FEE, recipient: trader.address,
      amountIn: U(500), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    }, GS)).wait();
  }
  await (await tok.connect(trader).approve(routerAddr, ethers.MaxUint256, GS)).wait();
  await (await routerT.exactInputSingle({
    tokenIn: tokAddr, tokenOut: usdtAddr, fee: FEE, recipient: trader.address,
    amountIn: E(100_000), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
  }, GS)).wait();

  // ---- collect: proceeds must land with the beneficiary, not the caller
  const beforeUsdt = await usdt.balanceOf(creator.address);
  const beforeTok = await tok.balanceOf(creator.address);
  const otherUsdtBefore = await usdt.balanceOf(other.address);
  await (await locker.connect(other).collect(tokenId, GL)).wait(); // a stranger triggers it
  const gainedUsdt = (await usdt.balanceOf(creator.address)) - beforeUsdt;
  const gainedTok = (await tok.balanceOf(creator.address)) - beforeTok;
  check(gainedUsdt > 0n || gainedTok > 0n, `beneficiary received fees (${ethers.formatUnits(gainedUsdt, 6)} USDT0, ${ethers.formatEther(gainedTok)} USDT1)`);
  // MockUSDT0 mirrors the native balance, so gas makes this dip; what matters
  // is that triggering a collect never pays the caller
  check((await usdt.balanceOf(other.address)) <= otherUsdtBefore, "caller of collect() gains nothing");

  // ---- liquidity is untouched and unreachable
  const pos = await npm.positions(tokenId);
  check(pos[7] > 0n, "liquidity still in the position after collecting");
  check((await npm.ownerOf(tokenId)) === lockerAddr, "locker still owns the position");

  let rev = false;
  try {
    await (await new ethers.Contract(npmAddr, NPM_ABI, creator).decreaseLiquidity({
      tokenId, liquidity: pos[7], amount0Min: 0, amount1Min: 0, deadline: Math.floor(Date.now() / 1000) + 900,
    }, GL)).wait();
  } catch { rev = true; }
  check(rev, "original owner can no longer pull liquidity");

  rev = false;
  try {
    await (await new ethers.Contract(npmAddr, NPM_ABI, deployer)["safeTransferFrom(address,address,uint256,bytes)"](lockerAddr, deployer.address, tokenId, "0x", GL)).wait();
  } catch { rev = true; }
  check(rev, "locker deployer cannot move the position out");

  // ---- the contract simply has no escape hatch
  const abi = build("V3PositionLocker").abi;
  const writes = abi.filter((x) => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map((x) => x.name);
  check(!writes.some((n) => /withdraw|unlock|rescue|sweep|decrease|burn|emergency/i.test(n)), `no unlock path exists (writes: ${writes.join(", ")})`);
  check(!abi.some((x) => x.type === "function" && x.name === "owner"), "contract has no owner at all");

  // ---- beneficiary rights can move, liquidity still cannot
  rev = false;
  try { await (await locker.connect(other).transferBeneficiary(tokenId, other.address, GS)).wait(); } catch { rev = true; }
  check(rev, "non-beneficiary cannot seize fee rights");
  await (await locker.connect(creator).transferBeneficiary(tokenId, other.address, GS)).wait();
  check((await locker.beneficiaryOf(tokenId)) === other.address, "beneficiary can hand over fee rights");

  // fees now flow to the new beneficiary
  await (await routerT.exactInputSingle({
    tokenIn: usdtAddr, tokenOut: tokAddr, fee: FEE, recipient: trader.address,
    amountIn: U(500), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
  }, GS)).wait();
  const nb = await usdt.balanceOf(other.address);
  await (await locker.connect(creator).collect(tokenId, GL)).wait();
  check((await usdt.balanceOf(other.address)) > nb, "fees follow the new beneficiary");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
