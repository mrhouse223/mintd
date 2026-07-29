// End-to-end agent flow on Arc, run as a STRANGER.
//
//   node scripts/test-arc-agent-e2e.js
//
// Everything here is done from a freshly generated key that has never touched
// this repo, funded with a little gas and nothing else. That is the point: the
// community flow must not depend on being the deployer, holding a pre-approved
// token, or having anything whitelisted. If this passes, a stranger with a
// wallet can do the same.
//
// Exercises exactly what the Agent tab calls: faucet, createVault, deposit
// one-sided, setPolicy, setMode, propose, execute, withdrawAll.
require("dotenv").config();
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const j = require(path.join(__dirname, "..", "deployments", "arc-testnet.json"));
const vaultArt = require(path.join(__dirname, "..", "build", "AgentVault.json"));

const FACTORY_ABI = [
  "function createVault(address,address,address) returns (address)",
  "function vaultsOf(address) view returns (address[])",
];
const TOKEN_ABI = [
  "function faucet()", "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160,int24 tick,uint16 obsIndex,uint16 card,uint16 cardNext,uint8,bool)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
];

let passed = 0, failed = 0;
const check = (c, n, d) => { if (c) { passed++; console.log(`  ok  ${n}`); } else { failed++; console.log(`FAIL  ${n}${d ? "\n        " + d : ""}`); } };
async function mustRevert(fn, name) {
  try { await fn(); check(false, name, "expected a revert"); }
  catch { check(true, name); }
}
const alignDown = (t, s) => Math.floor(t / s) * s;
const alignUp = (t, s) => Math.ceil(t / s) * s;

async function main() {
  const rp = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const funder = new ethers.Wallet((process.env.ARC_DEPLOYER_KEY || "").trim(), rp);
  const t = {
    pool: j.contracts.AgentTestPool,
    tETH: j.contracts.TestTokenETH,
    tUSD: j.contracts.TestTokenUSD,
    factory: j.contracts.AgentVaultFactory,
  };
  for (const [k, v] of Object.entries(t)) if (!v) throw new Error(`missing ${k} in deployments file`);

  // A key that has never existed before this run.
  const stranger = ethers.Wallet.createRandom().connect(rp);
  console.log(`\nstranger ${stranger.address}  (fresh key, no history)`);
  await (await funder.sendTransaction({ to: stranger.address, value: ethers.parseEther("1.6"), gasLimit: 30000 })).wait();
  console.log(`funded with ${ethers.formatEther(await rp.getBalance(stranger.address))} gas, and nothing else`);

  const pool = new ethers.Contract(t.pool, POOL_ABI, rp);
  const spacing = Number(await pool.tickSpacing());
  const fee = Number(await pool.fee());

  console.log("\n=== the pool is ready for a default vault ===");
  // A vault ships with twapWindow 1800. If the pool cannot answer observe over
  // that window, deposit reverts and a tester with default settings is simply
  // stuck, which is indistinguishable from the product being broken.
  let twap1800 = null, spot = Number((await pool.slot0()).tick);
  try {
    const [cum] = await pool.observe([1800, 0]);
    twap1800 = Number((cum[1] - cum[0]) / 1800n);
  } catch {}
  check(twap1800 !== null, "observe() spans the default 1800s window",
    "seed more history with seed-twap.js before inviting anyone");

  // Cardinality, NOT a spot/TWAP divergence, is what proves the buffer is real.
  // An earlier version of this asserted twap !== spot, which was right when the
  // failure mode was cardinality 1 and observe() extrapolating from the current
  // tick. With a real buffer and a price sitting in a three-tick band the two
  // legitimately coincide, and that assertion would fail a healthy pool.
  const card = Number((await pool.slot0()).card);
  check(card > 1, "the pool has a real observation buffer, not a single slot",
    `observationCardinality ${card}`);
  console.log(`      cardinality ${card}, spot ${spot}, 1800s twap ${twap1800}` +
    (twap1800 === spot ? "  (equal, because the price has been stable)" : ""));

  console.log("\n=== a stranger can get tokens and make a vault ===");
  const usd = new ethers.Contract(t.tUSD, TOKEN_ABI, stranger);
  const eth = new ethers.Contract(t.tETH, TOKEN_ABI, stranger);
  await (await usd.faucet({ gasLimit: 300000 })).wait();
  await (await eth.faucet({ gasLimit: 300000 })).wait();
  const usdDec = Number(await usd.decimals()), ethDec = Number(await eth.decimals());
  const usdBal = await usd.balanceOf(stranger.address);
  check(usdBal > 0n, "faucet funded the stranger with tUSD", `got ${ethers.formatUnits(usdBal, usdDec)}`);
  check((await eth.balanceOf(stranger.address)) > 0n, "faucet funded the stranger with tETH");

  const f = new ethers.Contract(t.factory, FACTORY_ABI, stranger);
  // The stranger names ITSELF as the agent, so this one script can drive the
  // whole loop. A real tester leaves the mintd keeper prefilled.
  await (await f.createVault(t.pool, stranger.address, t.tUSD, { gasLimit: 6_000_000 })).wait();
  const mine = await f.vaultsOf(stranger.address);
  check(mine.length === 1, "the vault is registered under the stranger, not the deployer");
  const vAddr = mine[0];
  const v = new ethers.Contract(vAddr, vaultArt.abi, stranger);
  check((await v.owner()) === stranger.address, "the stranger owns their vault");
  console.log(`      vault ${vAddr}`);

  console.log("\n=== deposit one-sided, with stock settings ===");
  const dep = usdBal / 2n;
  await (await usd.approve(vAddr, ethers.MaxUint256, { gasLimit: 200000 })).wait();
  await mustRevert(() => v.deposit(0, 0, { gasLimit: 500000 }).then((x) => x.wait()),
    "an empty deposit is rejected rather than silently doing nothing");
  // Which slot tUSD occupies is decided by address ordering, not by which token
  // matters to us: here token0 is tETH. Assuming tUSD was amount0 made deposit
  // try to pull tETH, which was never approved, and it reverted with no reason.
  // Resolved from the vault rather than assumed.
  const vt0 = await v.token0();
  const usdIsToken0 = vt0.toLowerCase() === t.tUSD.toLowerCase();
  const [amt0, amt1] = usdIsToken0 ? [dep, 0n] : [0n, dep];
  // Explicit gasLimit: AgentVault documents deposit as under-reported by
  // estimateGas, which is CLAUDE.md gotcha 8.
  await (await v.deposit(amt0, amt1, { gasLimit: 1_500_000 })).wait();
  const val = await v.valueNow();
  check(val > 0n, "a one-sided tUSD deposit is accepted and valued",
    `value ${ethers.formatUnits(val, usdDec)} tUSD`);
  check((await v.valueCheckpoint()) > 0n, "the loss breaker armed itself on deposit");
  console.log(`      vault value ${ethers.formatUnits(val, usdDec)} tUSD from a one-sided deposit`);

  console.log("\n=== settings are the owner's, and bounded by the contract ===");
  await mustRevert(() => v.setPolicy(2000, 600, 500, 300, 300, 0, { gasLimit: 500000 }).then((x) => x.wait()),
    "slippage above the 500bps ceiling is rejected on chain");
  await mustRevert(() => v.setPolicy(2000, 100, 500, 60, 1800, 0, { gasLimit: 500000 }).then((x) => x.wait()),
    "a review window under 300s is rejected on chain");
  await (await v.setPolicy(2000, 100, 500, 300, 1800, 0, { gasLimit: 500000 })).wait();
  check(Number(await v.maxSlippageBps()) === 100, "a legal policy is accepted");
  // 100bps against this pool's 30bps fee leaves real room, which is the whole
  // reason the test pool is a 0.30% tier rather than the 1% MINTD one.
  check(100 > fee / 100, "the stock slippage clears this pool's fee tier",
    `slippage 100bps vs fee ${fee / 100}bps`);

  await (await v.setMode(3, { gasLimit: 500000 })).wait();
  check(Number(await v.mode()) === 3, "the owner can go autonomous");

  console.log("\n=== the agent rebalances ===");
  const [cum] = await pool.observe([Number(await v.twapWindow()), 0]);
  const tw = Number((cum[1] - cum[0]) / BigInt(await v.twapWindow()));
  const drift = Number(await v.maxTickDrift());
  const half = Math.min(30 * spacing, drift);
  const lower = alignUp(tw - half, spacing), upper = alignDown(tw + half, spacing);
  await (await v.propose(lower, upper, { gasLimit: 800000 })).wait();
  const before = await v.valueNow();
  await (await v.execute({ gasLimit: 3_000_000 })).wait();
  const after = await v.valueNow();
  check((await v.positionId()) > 0n, "a position was opened", `range ${lower}..${upper}`);
  const costPct = (Number(before - after) / Number(before)) * 100;
  console.log(`      value ${ethers.formatUnits(before, usdDec)} -> ${ethers.formatUnits(after, usdDec)} tUSD  (${costPct.toFixed(4)}%)`);
  check(costPct < 1, "the rebalance cost less than 1% on a deep pool",
    `cost ${costPct.toFixed(4)}%`);

  console.log("\n=== the owner can always get out ===");
  const beforeUsd = await usd.balanceOf(stranger.address);
  const beforeEth = await eth.balanceOf(stranger.address);
  await (await v.withdrawAll({ gasLimit: 3_000_000 })).wait();
  const gotUsd = (await usd.balanceOf(stranger.address)) - beforeUsd;
  const gotEth = (await eth.balanceOf(stranger.address)) - beforeEth;
  check(gotUsd > 0n || gotEth > 0n, "funds returned to the owner's wallet");
  const back = Number(ethers.formatUnits(gotUsd, usdDec)) + Number(ethers.formatUnits(gotEth, ethDec)) * 2000;
  const started = Number(ethers.formatUnits(before, usdDec));
  console.log(`      recovered ~${back.toFixed(4)} of ${started.toFixed(4)} tUSD  (${(back / started * 100).toFixed(2)}%)`);
  check(back / started > 0.98, "the stranger recovered over 98% of what the vault held",
    `recovered ${(back / started * 100).toFixed(2)}%`);
  check((await usd.balanceOf(vAddr)) === 0n && (await eth.balanceOf(vAddr)) === 0n,
    "the vault retains nothing after withdrawAll");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
