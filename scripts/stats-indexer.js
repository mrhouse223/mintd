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
// Hard ceiling from the RPC, which rejects anything wider with
// "maximum [from, to] blocks distance: 500". A larger value does not degrade
// performance, it fails every single getLogs call.
const SPAN = Number(process.env.STATS_SPAN || "500");

const CACHE = path.join(ROOT, "stats-cache.json");
const OUT = path.join(ROOT, "frontend", "stats.json");
const LOCK = path.join(ROOT, "stats-indexer.lock");

// Two passes must never write stats-cache.json at once.
//
// Overlap is the normal case here, not an edge: pm2 runs this as --watch on a
// 3 minute loop and publish-stats.sh invokes it separately. When two passes
// overlap they both read the same base totals, sweep, and the later write
// wins, so volume one pass already banked gets counted again. That is exactly
// how all-time volume reached $1.1m against a verified $732k.
function acquireLock() {
  try {
    const prev = Number(fs.readFileSync(LOCK, "utf8").trim());
    if (prev && prev !== process.pid) {
      try {
        process.kill(prev, 0); // signal 0 only tests for existence
        return false;
      } catch { /* stale lock from a killed run, safe to take */ }
    }
  } catch { /* no lock file at all */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK, "utf8").trim()) === process.pid) fs.unlinkSync(LOCK);
  } catch {}
}

const V3_SWAP = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V2_SWAP = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const v3If = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const v2If = new ethers.Interface(["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"]);

// Matches the DEPLOYED launchpad at 0x75FAdB24, which is older than
// contracts/InstantLaunchpad.sol: it has no `quote` field, so every launchpad
// pool is USDT0-paired. Getting this shape wrong is silent: a decode failure
// is caught per token below and the pool is simply skipped, so a bad ABI reads
// as "no pools" rather than as an error.
const PAD_ABI = [
  "function tokenCount() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function launches(address) view returns (address token, address creator, address pool, uint256 positionId, uint64 createdAt, uint256 feesQuote, uint256 feesToken)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const abs = (x) => (x < 0n ? -x : x);

// USDT0 leg of one swap log, or null when it will not parse. Shared so the
// all-time and 24h passes can never drift apart on how a trade is valued.
function usdtLeg(lg, meta) {
  try {
    if (meta.kind === "v3") {
      const a = v3If.parseLog(lg).args;
      return abs(meta.usdtIs0 ? a.amount0 : a.amount1);
    }
    const a = v2If.parseLog(lg).args;
    return meta.usdtIs0 ? (a.amount0In > 0n ? a.amount0In : a.amount0Out)
                        : (a.amount1In > 0n ? a.amount1In : a.amount1Out);
  } catch { return null; }
}
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

// Approximate block for a wall-clock timestamp.
//
// This replaces a getCode binary search, which cannot work here: Stable's RPC
// keeps no archive state and answers any historical eth_getCode with "failed
// to load state at height N". The old search caught that error and returned
// lo, which is 0, so every pool reported creation block 0 and every scan
// restarted from genesis. Launch timestamps come from the launchpad contract
// itself, so this needs no historical state at all.
function blockAtTime(ts, head, headTs, perBlock) {
  if (!ts || ts >= headTs) return head;
  return Math.max(0, head - Math.ceil((headTs - ts) / perBlock));
}

// Oldest block this node still serves. It prunes, and anything below the
// retained window answers "height N is not available, lowest height is M".
// Without probing for M a cold start spends its whole budget on windows that
// can never be served, and reports zero volume having asked thousands of
// times. Returns 0 when the node serves everything.
async function lowestAvailable(rp) {
  try {
    await rp.getLogs({ topics: [[V3_SWAP, V2_SWAP]], fromBlock: 1, toBlock: 2 });
    return 0;
  } catch (e) {
    const m = /lowest height is (\d+)/.exec(`${e.info?.error?.message || ""} ${e.shortMessage || ""} ${e.message || ""}`);
    return m ? Number(m[1]) : 0;
  }
}

// getLogs with a window that adapts to the node's two independent caps: a
// 500-block span limit and a 500-RESULT limit. A legal-width window over a
// busy stretch still fails the second one, so the span has to shrink and the
// same range be retried rather than skipped, or that stretch's volume is lost.
// A single block can hold more than 500 matching swaps, which no amount of
// range narrowing can fix. Splitting by topic halves the result set, and
// failing that, one query per pool address cannot exceed the cap for a single
// pool in a single block. Costly, but only for the rare block that needs it.
async function rescueBlock(rp, block, addrs) {
  const out = [];
  for (const topic of [V3_SWAP, V2_SWAP]) {
    try {
      out.push(...await rp.getLogs({ topics: [topic], fromBlock: block, toBlock: block }));
      continue;
    } catch { /* still over the cap, go per address */ }
    for (const a of addrs) {
      try {
        out.push(...await rp.getLogs({ address: a, topics: [topic], fromBlock: block, toBlock: block }));
      } catch { return null; }
    }
  }
  return out;
}

// Returns the ranges it could not read, so the caller can retry them and park
// the cursor precisely instead of throwing away a whole pass.
async function sweepLogs(rp, from, to, span, onLogs, addrs = []) {
  let cur = from, width = span;
  const failed = [];
  while (cur <= to) {
    const end = Math.min(to, cur + width - 1);
    let logs;
    try {
      logs = await rp.getLogs({ topics: [[V3_SWAP, V2_SWAP]], fromBlock: cur, toBlock: end });
    } catch (e) {
      const msg = `${e.info?.error?.message || ""} ${e.shortMessage || ""} ${e.message || ""}`;
      if (/more than \d+ results/i.test(msg)) {
        if (width > 1) { width = Math.max(1, Math.floor(width / 2)); continue; }
        // Down to one block and still over the cap. Without this escalation
        // the window can never succeed, the cursor parks in front of it
        // forever, and every later run rescans the same dead ground.
        const rescued = await rescueBlock(rp, cur, addrs);
        if (rescued) { onLogs(rescued); cur += 1; width = span; continue; }
        console.error(`  block ${cur} unreadable even per address`);
        failed.push([cur, cur]);
        cur += 1;
        width = span;
        continue;
      }
      if (/is not available|lowest height/i.test(msg)) {
        const m = /lowest height is (\d+)/.exec(msg);
        cur = m ? Number(m[1]) : end + 1; // jump to what the node still has
        continue;
      }
      // Logged, not swallowed: a silent count reads as a clean run while the
      // reported volume is quietly short by whatever those blocks held.
      console.error(`  window ${cur}-${end} failed: ${(msg).trim().slice(0, 110)}`);
      failed.push([cur, end]);
      cur = end + 1;
      continue;
    }
    onLogs(logs);
    // Creep back up so one busy stretch does not slow the whole sweep.
    if (logs.length < 200 && width < span) width = Math.min(span, width * 2);
    cur = end + 1;
  }
  return failed;
}

async function main() {
  const rp = new ethers.JsonRpcProvider(RPC_URL, 988, { batchMaxCount: 1, staticNetwork: true });
  const pad = new ethers.Contract(PAD, PAD_ABI, rp);

  async function pass() {
    const cache = readCache();
    const head = await retry(() => rp.getBlockNumber(), "getBlockNumber");

    // ---------------------------------------------------------- discover pools
    const pools = {}; // addr -> { kind, usdtIs0, token }
    const n = Number(await retry(() => pad.tokenCount(), "tokenCount"));
    let padPools = 0, padFailed = 0;
    for (let i = 0; i < n; i++) {
      try {
        const t = await pad.allTokens(i);
        const L = await pad.launches(t);
        if (L.pool && L.pool !== ethers.ZeroAddress) {
          pools[L.pool.toLowerCase()] = { kind: "v3", token: t, createdAt: Number(L.createdAt) };
          padPools++;
        }
      } catch { padFailed++; }
    }
    // Loud, because a wrong ABI silently yields zero pools and the only visible
    // symptom is a volume figure that is quietly far too low.
    console.log(`  launchpad: ${n} tokens, ${padPools} with pools, ${padFailed} unreadable`);
    if (n > 0 && padPools === 0) throw new Error("launchpad returned no pools, ABI is probably wrong");
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
    let fresh = 0;
    for (const [addr, meta] of Object.entries(pools)) {
      const c = cache.pools[addr];
      if (c && c.usdtIs0 !== undefined) { meta.usdtIs0 = c.usdtIs0; meta.allTime = c.allTime || "0"; continue; }
      try {
        const pc = new ethers.Contract(addr, ["function token0() view returns (address)", "function token1() view returns (address)"], rp);
        const t0 = await pc.token0();
        const t1 = await pc.token1();
        const is0 = t0.toLowerCase() === USDT0.toLowerCase();
        const is1 = t1.toLowerCase() === USDT0.toLowerCase();
        // Without this, a pool with no USDT0 side falls through as usdtIs0 =
        // false and its token amounts get summed as if they were dollars.
        if (!is0 && !is1) { console.log(`  skip ${addr}, no USDT0 side`); delete pools[addr]; continue; }
        meta.usdtIs0 = is0;
        meta.allTime = "0";
        fresh++;
      } catch { delete pools[addr]; }
    }
    console.log(`  ${Object.keys(pools).length} pools tracked (${fresh} new)`);

    // ------------------------------------------------------------ volume scan
    // Measured, not assumed. Stable runs ~0.70s blocks, so the old hardcoded
    // 86400 covered under 17 hours and the "24h" tile read about 30% low.
    const headBlk = await retry(() => rp.getBlock(head), "getBlock head");
    const sampleSpan = Math.min(100000, Math.max(1, head - 1));
    const oldBlk = await retry(() => rp.getBlock(head - sampleSpan), "getBlock older");
    const perBlock = (headBlk.timestamp - oldBlk.timestamp) / sampleSpan || 1;

    let DAY_BLOCKS = Number(process.env.DAY_BLOCKS || 0);
    if (!DAY_BLOCKS) DAY_BLOCKS = Math.round(86400 / perBlock);
    const dayFrom = Math.max(0, head - DAY_BLOCKS);
    console.log(`  block time ${perBlock.toFixed(3)}s, 24h = ${DAY_BLOCKS} blocks`);

    // Scan the chain once by topic rather than once per pool.
    //
    // The RPC caps getLogs at 500 blocks. Per-pool that is 117 pools x ~916
    // windows = over 100k requests, which is hours. One topic-filtered sweep
    // returns every pool's swaps in the same window, so the same coverage
    // costs ~916 requests. Logs are attributed locally by address.
    let allTime = 0n, vol24 = 0n, tx24 = 0, scanned = 0, windows = 0;
    const running = {};
    for (const [addr, meta] of Object.entries(pools)) running[addr] = BigInt(meta.allTime || "0");

    // The platform cannot have traded before its first launch, so that is the
    // floor for a cold scan. A day of margin covers pools created just ahead
    // of the first token, such as the MINTR pair.
    const launchTs = Object.values(pools).map((m) => m.createdAt).filter((t) => t > 0);
    const firstLaunch = launchTs.length
      ? blockAtTime(Math.min(...launchTs), head, headBlk.timestamp, perBlock)
      : head;
    const coldFrom = Math.max(0, firstLaunch - DAY_BLOCKS);

    // One sweep serves both figures. All-time only counts blocks past the
    // cursor so nothing is double counted, while 24h counts the whole window
    // regardless of the cursor: deriving it from newly scanned blocks alone
    // would report "volume since the last run" and read as minutes of trading.
    const cursor = Number(cache.lastBlock || 0);
    const lowest = await lowestAvailable(rp);
    const wanted = cursor > 0 ? Math.min(cursor + 1, dayFrom) : coldFrom;
    const from0 = Math.max(wanted, lowest);
    if (lowest > wanted) {
      // Distinguish the pre-launch safety margin from actual lost trading.
      // Reporting the margin as missing history overstates the problem and
      // would make a complete figure look incomplete.
      const realLost = Math.max(0, lowest - firstLaunch);
      console.log(`  node retains from ${lowest}, wanted ${wanted}`);
      console.log(realLost > 0
        ? `  ${(realLost * perBlock / 3600).toFixed(1)}h of trading history is pruned and unreachable`
        : `  only pre-launch margin trimmed, all trading history reachable`);
    }
    console.log(`  sweep ${from0} -> ${head} (~${Math.ceil((head - from0) / SPAN)} windows, cursor ${cursor || "cold"})`);

    let lastLog = from0;
    const onLogs = (logs) => {
      for (const lg of logs) {
        const meta = pools[lg.address.toLowerCase()];
        if (!meta) continue; // a swap on some other chain pool, not ours
        const usdt = usdtLeg(lg, meta);
        if (usdt === null) continue;
        if (lg.blockNumber > cursor) running[lg.address.toLowerCase()] += usdt;
        if (lg.blockNumber >= dayFrom) { vol24 += usdt; tx24++; }
        if (lg.blockNumber > lastLog) lastLog = lg.blockNumber;
      }
      windows++;
      if (windows % 250 === 0) console.log(`  ...${windows} windows, block ${lastLog}, vol so far $${ethers.formatUnits(Object.values(running).reduce((a, b) => a + b, 0n), 6)}`);
    };

    const addrs = Object.keys(pools);
    let failed = await sweepLogs(rp, from0, head, SPAN, onLogs, addrs);
    // Retry narrower before giving up. A failed window contributed nothing, so
    // rescanning it cannot double count.
    if (failed.length) {
      console.log(`  retrying ${failed.length} failed windows at reduced width`);
      const still = [];
      for (const [a, b] of failed) still.push(...await sweepLogs(rp, a, b, 1, onLogs, addrs));
      failed = still;
    }
    scanned = head - from0;

    for (const [addr, meta] of Object.entries(pools)) {
      meta.allTime = running[addr].toString();
      allTime += running[addr];
    }
    // Advance the cursor only on a complete pass, and persist nothing at all
    // otherwise.
    //
    // The totals above already include every block this pass read, including
    // blocks past a hole. Rewinding the cursor to the hole while keeping those
    // totals says "I have not counted these blocks" about blocks that ARE
    // counted, so the next run adds them a second time. That inflated all-time
    // volume from $731k to $970k in one pass. Either both move or neither does.
    const complete = failed.length === 0;
    if (complete) {
      cache.lastBlock = head;
    } else {
      console.error(`  ${failed.length} windows unreadable, cache not advanced: next run repeats cleanly from ${cursor || "cold"}`);
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

    // Only a complete pass is written. A partial one leaves the previous cache
    // intact so the next run repeats the range from a cursor that still
    // matches the totals sitting beside it.
    if (complete) fs.writeFileSync(CACHE, j({ pools, lastBlock: cache.lastBlock }));
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

if (!acquireLock()) {
  // Exit 0, not 1: this is the lock doing its job, and a non-zero status would
  // make pm2 treat a normal overlap as a crash and restart-loop.
  console.error("another indexer pass is already running, exiting");
  process.exit(0);
}
process.on("exit", releaseLock);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { releaseLock(); process.exit(0); });

main().catch((e) => { releaseLock(); console.error(e.shortMessage || e.message || e); process.exit(1); });
