// Live smoke test of the freshly deployed MintdLaunchpad on Stable.
//
//   node scripts/smoke-stable-v2.js
//
// String-grepping the deployed bytecode for the guard is unreliable under
// viaIR, so this proves the fix behaviourally against the real contract:
//   1. a normal launch works and anchors the position at the correct price
//   2. a launch into a pre-initialized pool REVERTS with "pool pre-initialized"
//
// Costs one 1 USDT0 creation fee plus a few cents of gas. The poison test's
// revert is checked with eth_call, so it commits nothing.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const ENV = (() => {
  const o = {};
  for (const l of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    if (l.trim().startsWith("#")) continue;
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
})();

const RPC = "https://rpc.stable.xyz";
const PAD = "0xCe7b02b3f0e5665f1C23E018039e9b6836c6221b";
const NPM = "0x3BdC3437405f7D801b6036532713fc1F179136a6";
const USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

const PAD_ABI = [
  "function launch(string,string,string,uint256) payable returns (address)",
  "function launchWithSalt(string,string,string,uint256,bytes32) payable returns (address)",
  "function predictToken(address,bytes32,string,string,string) view returns (address)",
  "function launches(address) view returns (address token,address creator,address pool,address quote,uint256 positionId,uint64 createdAt,uint256 a,uint256 b)",
  "function tokenCount() view returns (uint256)",
  "event TokenLaunched(address indexed token,address indexed creator,address pool,uint256 positionId,string name,string symbol,string metadataURI)",
];
const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
  "function ownerOf(uint256) view returns (address)",
];

function sqrtRatioX96(num, den) {
  const x = (num << 96n) / den;
  if (x === 0n) return 0n;
  let z = (x + 1n) / 2n, y = x;
  while (z < y) { y = z; z = (x / z + z) / 2n; }
  return y << 48n;
}

(async () => {
  const rp = new ethers.JsonRpcProvider(RPC, 988, { batchMaxCount: 1, staticNetwork: true });
  let k = (ENV.DEPLOYER_KEY || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
  const w = new ethers.Wallet(k, rp);
  const pad = new ethers.Contract(PAD, PAD_ABI, w);

  console.log(`smoke test on ${PAD}`);
  console.log(`signer ${w.address}  balance ${ethers.formatEther(await rp.getBalance(w.address))} USDT0\n`);

  // ---- 1. happy path
  console.log("1. a normal launch");
  const tx = await pad.launch("MintdV2 Smoke", "SMOKE2", "ipfs://smoke", 0n, { value: ethers.parseEther("1"), gasLimit: 12_000_000 });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "TokenLaunched");
  const token = ev.args.token;
  const npm = new ethers.Contract(NPM, NPM_ABI, rp);
  const L = await pad.launches(token);
  const pos = await npm.positions(L.positionId);
  const tokenIs0 = BigInt(token) < BigInt(USDT0);
  // expected outer edge: MAX_TICK (887200) for token0, or -MAX_TICK for token1
  const outer = tokenIs0 ? Number(pos.tickUpper) : Number(pos.tickLower);
  const expectOuter = tokenIs0 ? 887200 : -887200;
  console.log(`   token ${token}`);
  console.log(`   position ${L.positionId}, ticks [${pos.tickLower}, ${pos.tickUpper}], NFT owner ${await npm.ownerOf(L.positionId)}`);
  console.log(`   outer edge ${outer}, expected ${expectOuter}  ${outer === expectOuter ? "CORRECT, not hijacked" : "WRONG"}`);
  const okHappy = (await npm.ownerOf(L.positionId)).toLowerCase() === PAD.toLowerCase() && outer === expectOuter;

  // ---- 2. the front-run must revert
  console.log("\n2. launching into a pre-initialized pool");
  const salt = ethers.id("smoke-poison-" + Date.now());
  const predicted = await pad.predictToken(w.address, salt, "Poison", "PSN", "ipfs://x");
  const t0 = BigInt(predicted) < BigInt(USDT0) ? predicted : USDT0;
  const t1 = BigInt(predicted) < BigInt(USDT0) ? USDT0 : predicted;
  const tokenIs0b = t0 === predicted;
  const EVIL = 3000n; // absurdly low vs the real 3e12
  const evilSqrt = tokenIs0b ? sqrtRatioX96(EVIL, 10n ** 30n) : sqrtRatioX96(10n ** 30n, EVIL);
  console.log(`   predicted token ${predicted}`);
  console.log(`   creating its pool at a poison price...`);
  const npmW = new ethers.Contract(NPM, NPM_ABI, w);
  await (await npmW.createAndInitializePoolIfNecessary(t0, t1, 10000, evilSqrt, { gasLimit: 8_000_000 })).wait();

  // eth_call the real launch into that poisoned pool; must revert.
  let reverted = false, reason = "";
  try {
    await pad.launchWithSalt.staticCall("Poison", "PSN", "ipfs://x", 0n, salt, { value: ethers.parseEther("1") });
  } catch (e) {
    reverted = true;
    reason = e.reason || (e.info?.error?.message) || e.shortMessage || "revert";
  }
  console.log(`   launch reverted: ${reverted}  reason: "${reason}"`);
  const okGuard = reverted && /pool pre-initialized/.test(reason);

  console.log("\n" + (okHappy && okGuard
    ? "PASS: normal launch is correct AND the front-run reverts on the live contract"
    : "FAIL: " + (okHappy ? "" : "happy path wrong; ") + (okGuard ? "" : "guard did not fire")));
  process.exit(okHappy && okGuard ? 0 : 1);
})().catch((e) => { console.error("\n" + (e.shortMessage || e.message) + "\n"); process.exit(1); });
