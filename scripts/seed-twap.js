// Builds real observation history on a Uniswap V3 pool, for testnets only.
//
//   POOL=0x... KEY_VAR=ARC_DEPLOYER_KEY node scripts/seed-twap.js [swaps] [gapSec]
//
// WHY THIS EXISTS
// A pool created by a launchpad has one observation slot. `observe()` still
// answers, but with cardinality 1 it extrapolates from the current tick, so the
// "TWAP" it returns is byte-identical to spot. Anything deriving safety from
// that number, which for AgentVault means the minimum swap output, the tick
// band and the loss breaker, is reading a price an attacker can move inside a
// single block. The protection is not broken, it is unarmed.
//
// The buffer only grows when the pool actually trades, and a testnet pool has
// no organic flow, so waiting achieves nothing. This generates that flow.
//
// Swaps alternate direction so the price ends up roughly where it started and
// the history is a real average rather than a ramp.
//
// NOT for mainnet. There the fix is real trading volume, not synthetic wash
// swaps, and running this against a live pool would be paying fees to fake it.
require("dotenv").config();
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const POOL = process.env.POOL;
const KEY_VAR = process.env.KEY_VAR || "ARC_DEPLOYER_KEY";
const ROUTER = process.env.ROUTER || "0xDf982D7119dD6a5Ec266aE69f6D6537C90F3680a";
const SWAPS = Number(process.argv[2] || "8");
const GAP = Number(process.argv[3] || "60");

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160,int24 tick,uint16 obsIndex,uint16 card,uint16 cardNext,uint8,bool)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function increaseObservationCardinalityNext(uint16)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
const E20 = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${ts()}  ${m}`);

async function twapVsSpot(pool, window) {
  const s = await pool.slot0();
  try {
    const [cum] = await pool.observe([window, 0]);
    const t = Number((cum[1] - cum[0]) / BigInt(window));
    return { spot: Number(s.tick), twap: t, card: Number(s.card), next: Number(s.cardNext), ok: true };
  } catch (e) {
    // Once cardinality grows, observe() reverts with OLD until the buffer
    // actually spans the requested window. That is progress, not a failure.
    return { spot: Number(s.tick), twap: null, card: Number(s.card), next: Number(s.cardNext), ok: false };
  }
}

async function main() {
  if (!POOL) throw new Error("Set POOL");
  const rp = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const key = (process.env[KEY_VAR] || "").trim();
  if (!key) throw new Error(`${KEY_VAR} not set`);
  const w = new ethers.Wallet(key, rp);

  const pool = new ethers.Contract(POOL, POOL_ABI, w);
  const t0 = await pool.token0(), t1 = await pool.token1(), fee = await pool.fee();
  const c0 = new ethers.Contract(t0, E20, w), c1 = new ethers.Contract(t1, E20, w);
  const d0 = Number(await c0.decimals()), d1 = Number(await c1.decimals());

  let st = await twapVsSpot(pool, 300);
  log(`pool ${POOL}  cardinality ${st.card} -> next ${st.next}`);
  log(`spot ${st.spot}  twap ${st.twap}  ${st.twap === st.spot ? "IDENTICAL, unarmed" : "diverged"}`);

  if (st.next < 64) {
    await (await pool.increaseObservationCardinalityNext(64, { gasLimit: 500000 })).wait();
    log("requested cardinality 64");
  }

  const router = new ethers.Contract(ROUTER, ROUTER_ABI, w);
  for (const c of [c0, c1]) {
    if ((await c.allowance(w.address, ROUTER)) === 0n) {
      await (await c.approve(ROUTER, ethers.MaxUint256, { gasLimit: 200000 })).wait();
    }
  }

  // These must be large enough to MOVE THE TICK. UniswapV3Pool.swap only calls
  // observations.write when `state.tick != slot0Start.tick`, so a swap too
  // small to shift the tick by even one unit leaves the buffer untouched and
  // cardinality stuck at 1 forever. A first run here used 0.01 of token0 and
  // produced eight successful swaps, zero new observations and an unchanged
  // tick, which looks exactly like the swaps having failed.
  const amt0 = ethers.parseUnits(process.env.AMT0 || "1", d0);
  const amt1 = ethers.parseUnits(process.env.AMT1 || "325000", d1);

  let moved = 0;
  for (let i = 0; i < SWAPS; i++) {
    const fwd = i % 2 === 0;
    const before = Number((await pool.slot0()).tick);
    try {
      await (await router.exactInputSingle({
        tokenIn: fwd ? t0 : t1, tokenOut: fwd ? t1 : t0, fee,
        recipient: w.address, amountIn: fwd ? amt0 : amt1,
        amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      }, { gasLimit: 1_000_000 })).wait();
    } catch (e) {
      log(`swap ${i + 1} failed: ${(e.shortMessage || e.message).slice(0, 60)}`);
    }
    st = await twapVsSpot(pool, 300);
    if (st.spot !== before) moved++;
    log(`swap ${i + 1}/${SWAPS}  tick ${before}->${st.spot}${st.spot === before ? " (UNCHANGED, no observation written)" : ""}  cardinality ${st.card}  twap ${st.ok ? st.twap : "not yet spanning 300s"}`);
    if (i < SWAPS - 1) await sleep(GAP * 1000);
  }
  if (moved === 0) log("no swap moved the tick: raise AMT0/AMT1, nothing was recorded");

  st = await twapVsSpot(pool, 300);
  console.log("");
  log(`final cardinality ${st.card}, spot ${st.spot}, twap ${st.ok ? st.twap : "unavailable"}`);
  if (st.ok && st.twap !== st.spot) log("TWAP now diverges from spot: the vault's protections are armed");
  else if (st.ok) log("TWAP still equals spot; run more swaps with a wider gap");
}

main().catch((e) => { console.error(e); process.exit(1); });
