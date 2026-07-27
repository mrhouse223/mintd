// Protocol stats indexer.
//
// Walks every pool the platform has ever created, sums all-time and 24h volume,
// values total TVL, and writes frontend/stats.json for the site to read.
//
//   node scripts/stats-indexer.js            # one pass, then exit
//   node scripts/stats-indexer.js --watch    # keep updating (use under pm2)
//
// Scanning is INCREMENTAL. Block progress and running totals live in
// stats-cache.json, so the expensive full history scan happens once and every
// later pass only reads new blocks.
//
// TVL METHODOLOGY, deliberately conservative so the number survives scrutiny:
//   + both sides of every launchpad V3 pool, at market
//   + both sides of every MintSwap V2 pool, at market
//   + USDT0 backing the MINTR reserve
//   + USDT0 collateral locked in the MGLD engine
//   - farms are NOT added: staked LP is the same liquidity as the pool it came
//     from, so counting both would roughly double the figure
//   - the locker is NOT added: locked supply is not deposited capital, and is
//     reported as its own metric
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}
const ENV = loadEnv();

const RPC_URL = process.env.RPC_URL || ENV.RPC_URL || "https://rpc.stable.xyz";
const PAD = process.env.PAD || "0x75FAdB240006313294A5B502CA9268cB03Fa9AC0";
const USDT0 = process.env.USDT0 || "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const MINTR = process.env.MINTR || "0x8817D05f2560189F3697028f639Dbb4C68688400";
const MINTD = process.env.MINTD || "0xE62C47074abb52A2bc87B62E47e3411A0020f020";
const SYNTH = process.env.SYNTH || "0x09Eb7D9B18e56270F8898C4f3Ac3F2dc99F3b213";
const BURNER = process.env.BURNER || "0x7F007fbc6061806888A39A79763808aF5B94F4f4";
const FACTORY = process.env.FACTORY || "0x65E12569E20E8706A4a60fCAB13e9069B78F9f8E";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const WATCH = process.argv.includes("--watch");
const POLL_MS = Number(process.env.STATS_POLL_MS || ENV.STATS_POLL_MS || "180000");
const SPAN = Number(process.env.STATS_SPAN || "5000");

const CACHE = path.join(ROOT, "stats-cache.json");
const OUT = path.join(ROOT, "frontend", "stats.json");

const V3_SWAP = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V2_SWAP = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const v3If = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const v2If = new ethers.Interface(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"]);

const PAD_ABI = [
  "function allTokensLength() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function launches(address) view returns (address,address,uint256,uint256,uint256,bool,bool)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const abs = (x) => (x < 0n ? -x : x);
const j = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function retry(fn, label, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * Math.pow(3, i)));
    }
  }
  throw new Error(`${label}: ${last.shortMessage || last.message}`);
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return { pools: {}, lastBlock: 0 }; }
}

// Block a contract first had code, by binary search on getCode. Without this a
// first run walks millions of empty blocks before reaching any swap, which on a
// 1s-block chain is hours of pointless requests.
async function creationBlock(rp, addr, head) {
  let lo = 0, hi = head;
  try {
    if ((await rp.getCode(addr, 0)) !== "0x") return 0;
  } catch {}
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let code = "0x";
    try { code = await rp.getCode(addr, mid); } catch { return lo; }
    if (code === "0x") lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  const rp = new ethers.JsonRpcProvider(RPC_URL, 988, { batchMaxCount: 1, staticNetwork: true });
  const pad = new ethers.Contract(PAD, PAD_ABI, rp);

  async function pass() {
    const cache = readCache();
    const head = await retry(() => rp.getBlockNumber(), "getBlockNumber");

    // ---------------------------------------------------------- discover pools
    const pools = {}; // addr -> { kind, usdtIs0, token }
    const n = Number(await retry(() => pad.allTokensLength(), "allTokensLength"));
    for (let i = 0; i < n; i++) {
      try {
        const t = await pad.allTokens(i);
        const L = await pad.launches(t);
        const pool = L[1];
        if (pool && pool !== ethers.ZeroAddress) {
          pools[pool.toLowerCase()] = { kind: "v3", token: t };
        }
      } catch { /* skip a token that will not read */ }
    }
    // MintSwap V2 pairs for the protocol's own tokens, plus any extras
    const fac = new ethers.Contract(FACTORY, ["function getPair(address,address) view returns (address)"], rp);
    for (const t of [MINTR, MINTD, process.env.MGLD || "0x872a3C280B846759187c9E57F62d1Ed8407b135C"]) {
      try {
        const p = await fac.getPair(USDT0, t);
        if (p && p !== ethers.ZeroAddress) pools[p.toLowerCase()] = { kind: "v2", token: t };
      } catch {}
    }
    for (const p of (process.env.EXTRA_POOLS || ENV.EXTRA_POOLS ||
      "0x5e89ECD99A02BD709C71cDF62518490E07Fb567b").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!pools[p.toLowerCase()]) pools[p.toLowerCase()] = { kind: "v2", token: MINTR };
    }

    // which side is USDT0, cached because it never changes
    for (const [addr, meta] of Object.entries(pools)) {
      const c = cache.pools[addr];
      if (c && c.usdtIs0 !== undefined) { meta.usdtIs0 = c.usdtIs0; meta.from = c.from || 0; meta.allTime = c.allTime || "0"; continue; }
      try {
        const t0 = await new ethers.Contract(addr, ["function token0() view returns (address)"], rp).token0();
        meta.usdtIs0 = t0.toLowerCase() === USDT0.toLowerCase();
        // start at the block the pool was created, never at zero
        meta.from = await creationBlock(rp, addr, head);
        meta.allTime = "0";
        console.log(`  new pool ${addr} from block ${meta.from}`);
      } catch { delete pools[addr]; }
    }

    // ------------------------------------------------------------ volume scan
    const DAY_BLOCKS = Number(process.env.DAY_BLOCKS || "86400"); // ~1s blocks
    const dayFrom = Math.max(0, head - DAY_BLOCKS);
    let allTime = 0n, vol24 = 0n, tx24 = 0, scanned = 0;

    for (const [addr, meta] of Object.entries(pools)) {
      let running = BigInt(meta.allTime || "0");
      let from = meta.from || 0;
      const topic = meta.kind === "v3" ? V3_SWAP : V2_SWAP;

      while (from <= head) {
        const to = Math.min(head, from + SPAN);
        let logs = [];
        try {
          logs = await retry(() => rp.getLogs({ address: addr, topics: [topic], fromBlock: from, toBlock: to }), "getLogs");
        } catch (e) {
          console.error(`  ${addr} ${from}-${to}: ${e.message}`);
          break; // leave `from` where it is so the next pass retries this window
        }
        for (const lg of logs) {
          let usdt = 0n;
          try {
            if (meta.kind === "v3") {
              const a = v3If.parseLog(lg).args;
              usdt = abs(meta.usdtIs0 ? a.amount0 : a.amount1);
            } else {
              const a = v2If.parseLog(lg).args;
              usdt = meta.usdtIs0 ? (a.amount0In > 0n ? a.amount0In : a.amount0Out)
                                  : (a.amount1In > 0n ? a.amount1In : a.amount1Out);
            }
          } catch { continue; }
          running += usdt;
          if (lg.blockNumber >= dayFrom) { vol24 += usdt; tx24++; }
        }
        scanned += to - from;
        from = to + 1;
      }
      meta.from = from;
      meta.allTime = running.toString();
      allTime += running;
    }

    // ---------------------------------------------------------------- TVL
    const usdtC = new ethers.Contract(USDT0, ERC20, rp);
    let poolTvl = 0n;
    for (const addr of Object.keys(pools)) {
      // Value both sides by doubling the USDT0 leg. For a balanced AMM position
      // that is exact, and it avoids pricing the paired token off its own pool,
      // which is circular and inflates thin markets.
      try { poolTvl += (await usdtC.balanceOf(addr)) * 2n; } catch {}
    }
    let reserve = 0n, collateral = 0n;
    try { reserve = await new ethers.Contract(MINTR, ["function reserve() view returns (uint256)"], rp).reserve(); } catch {}
    try { collateral = await new ethers.Contract(SYNTH, ["function totalCollateral() view returns (uint256)"], rp).totalCollateral(); } catch {}
    // totalCollateral is 18-dec in the engine, normalise to 6-dec USDT0 units
    const collateral6 = collateral / 1_000_000_000_000n;

    const tvl = poolTvl + reserve + collateral6;

    // ------------------------------------------------------- MINTR + burned
    let mintrTvl = reserve;
    let burned = 0n, mintdSupply = 0n;
    try {
      const md = new ethers.Contract(MINTD, ERC20, rp);
      burned = await md.balanceOf(DEAD);
      mintdSupply = await md.totalSupply();
    } catch {}

    const out = {
      updated: Math.floor(Date.now() / 1000),
      block: head,
      tvl: ethers.formatUnits(tvl, 6),
      tvlBreakdown: {
        pools: ethers.formatUnits(poolTvl, 6),
        mintrReserve: ethers.formatUnits(reserve, 6),
        mgldCollateral: ethers.formatUnits(collateral6, 6),
      },
      volumeAllTime: ethers.formatUnits(allTime, 6),
      volume24h: ethers.formatUnits(vol24, 6),
      trades24h: tx24,
      mintrTvl: ethers.formatUnits(mintrTvl, 6),
      mintdBurned: ethers.formatEther(burned),
      mintdBurnedPct: mintdSupply > 0n
        ? (Number(ethers.formatEther(burned)) / Number(ethers.formatEther(mintdSupply)) * 100).toFixed(2)
        : "0",
      pools: Object.keys(pools).length,
    };

    fs.writeFileSync(CACHE, j({ pools, lastBlock: head }));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

    console.log(`[${new Date().toISOString()}] block ${head}  scanned ${scanned} blocks across ${Object.keys(pools).length} pools`);
    console.log(`  TVL          $${Number(out.tvl).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`    pools      $${Number(out.tvlBreakdown.pools).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`    MINTR      $${Number(out.tvlBreakdown.mintrReserve).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`    MGLD       $${Number(out.tvlBreakdown.mgldCollateral).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`  vol all time $${Number(out.volumeAllTime).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`  vol 24h      $${Number(out.volume24h).toLocaleString(undefined, { maximumFractionDigits: 0 })}  (${tx24} trades)`);
    console.log(`  burned       ${Number(out.mintdBurned).toLocaleString(undefined, { maximumFractionDigits: 0 })} MINTD (${out.mintdBurnedPct}%)`);
    console.log(`  -> ${OUT}`);
  }

  if (WATCH) {
    for (;;) {
      try { await pass(); } catch (e) { console.error("pass failed:", e.shortMessage || e.message); }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } else {
    await pass();
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
